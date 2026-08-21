# apex-backend-node

Node/Express/MongoDB/Redis/BullMQ backend for the Apex trading platform.
Serves both the mobile (Flutter) app and the web portal (`apex-web-portal`).
Runs live on a self-managed AWS EC2 instance at `https://apexlive-api.mynpe.in`.

## Repo / branch rules

- **Production branch is `main`.** Deploys happen by the dev pulling `main`
  on the AWS server and restarting the process — there is no CI/CD here yet.
- Only push to `main` when explicitly asked. Commit locally first; push is a
  separate, explicit step.
- Never force-push, never rewrite history on `main`.
- If you ever see a branch that isn't `main` with unmerged work sitting
  around, don't assume it's dead — check `git log` before touching it.

## Working with the web portal repo

- `apex-web-portal` is a **separate repo** with its own git history. Never
  edit files in that repo from here, and never treat backend changes as a
  substitute for a web-side fix.
- **This backend is read-only when doing work for the web portal.** If a web
  bug traces back to something only the backend can supply, report the gap
  and ask before changing backend code — don't fix it as a side effect of a
  web task, even if it's clearly the "root cause." (This was explicitly
  corrected once already — see project memory.)
- The backend is shared by both mobile and web — a change here affects both
  clients. Before changing shared logic (brokerage calc, P&L calc, margin
  rules), check both `masterUserController.js`/`priceQueueService.js`-style
  trade paths AND anything mobile might rely on that isn't visible from this
  repo (mobile source isn't available here — treat its behavior as observed
  fact from real exports/screenshots, not something to infer from this code
  alone).

## Verification before commit

1. `node -c <file>` on every edited file (syntax check).
2. `npm test` (`jest --runInBand`) — full suite. As of this writing the
   baseline has 2 pre-existing, unrelated failures
   (`tests/settlement.unit.test.js`, `tests/intradaySquareOffWallet.unit.test.js`
   may drift — always compare against a fresh baseline run, don't assume
   these two are still the only ones). A change should never introduce a
   *new* failure beyond whatever the current baseline is.
3. Only commit after tests pass. Only push after the user explicitly says so.

## Known architecture patterns (read before changing money-moving code)

- **Average-cost P&L, not FIFO.** Position P&L is computed by walking
  completed trades in order and maintaining running buy/sell qty+value
  totals that reset whenever net position crosses/lands on zero (a "flat
  reset"). A partial close decrements only the closed side's own totals by
  the qty matched; a same-trade flip splits the excess onto the new side at
  its own price. This exact pattern was duplicated (and had to be
  independently fixed) in `tradeController.js`, `priceQueueService.js`,
  `orderExecutionService.js`, `tradeReportController.js`, and
  `settlementService.js`. If you touch P&L math in one, check whether the
  same bug class exists in the others.
- **Hierarchy cascades** (P&L sharing, brokerage sharing, credit/debit
  authorization) must walk the *actual* tier-by-tier chain between a user
  and the caller, never a single blended rate applied to the whole subtree,
  and never assume the caller can act on a non-direct descendant unless
  that's an explicitly confirmed design decision (wallet operations are
  direct-child-only by design; equity/credit transfers were fixed to match).
- **Trade-write fencing**: real trade/settlement mutations go through
  `tradeWriteFenceService.js`'s lease system so settlement can't commit
  mid-write. Don't bypass it when adding a new money-moving code path.
- **Carry-forward markers** (`trade_type: 'carry_forward'`) are excluded by
  default from the general trades list (`GET /api/master/trades`) but are
  required input for correctly seeding average-cost state across a
  settlement boundary — `GET /api/trade/positions` includes them
  unconditionally; `GET /api/master/trades` does not and has no opt-in flag.

## Testing conventions

- Model-heavy unit tests mock every collaborator the code under test
  queries (`KiteInstrument`, `BrokerageSettings`, `ScriptQuantity`, etc.) via
  a `queryChain()` helper simulating `.select().session().lean()` chains —
  see `tests/priceQueueFill.unit.test.js` for the reference pattern. A test
  that doesn't mock all of a function's DB collaborators will hang/timeout
  against a real (unavailable) Mongo connection rather than fail cleanly.
