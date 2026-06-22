# Plan: Permanent Trade History (Settlement Ledger)

## Problem Statement

History is currently a *side effect* of mutating the live `Trade` collection during
settlement, not a durable artifact. This causes data loss:

1. History is found by fragile `remarks` string matching (e.g. `"Settlement: week reset"`).
   Any variant (`"week reset (flat position)"`) silently disappears from bills.
2. A position's original cost basis is overwritten with the settlement price every week —
   the true entry price is lost after the first settlement.
3. The open->close lifecycle is never stored as one self-contained record. It is scattered
   across disconnected soft-deleted rows tied only by instrument + timestamp proximity.
4. Settlement deletes + recreates in the live table with no backup. A failed recreate
   (e.g. missing `master_id`) permanently loses the position.

**Root cause:** there is no separate, immutable, append-only record of what each position
looked like over its full life at the moment of settlement.

## Goal

Never lose trade history. Every settlement must produce a complete, self-contained,
immutable snapshot of every position (open AND flat) for the settled period, so PDFs/bills
are always reconstructable even if the live `Trade` table is later mutated or corrupted.

## Solution Overview

Introduce an immutable, append-only Settlement Ledger collection (`SettlementHistory`).
At each settlement, BEFORE any deletion, write one ledger document per user-per-instrument
capturing the entire lifecycle. The ledger is never updated or deleted.

### Design principles
- Capture-before-mutate: snapshots are written and confirmed before deletion touches anything.
- Self-contained: each document embeds the full fill list + all derived figures.
- Append-only: documents are never modified or deleted. No soft-delete.
- Abort-on-failure: if snapshot writing fails, settlement aborts before deleting anything.

## Step 1 — New model `SettlementHistory` (DONE in this task)
File: `src/models/SettlementHistory.js`. Immutable per user-per-instrument snapshot with
full embedded fills, opening summary, close/settlement figures, P&L, brokerage, carry-forward.

## Step 2 — Settlement writes the ledger (capture-before-mutate)
File: `src/services/settlementService.js`. New Phase 3.5 after positions are collected and
the close-price map is built, but BEFORE any deletion. Builds + bulk-inserts snapshots for
every position being reset this run. Aborts the whole settlement if the insert fails.

## Step 3 — Authoritative read endpoint (additive, low-risk)
File: `src/controllers/tradeReportController.js` + `src/routes/tradeRoutes.js`.
Add `GET /api/trade/settlement-history` returning immutable ledger snapshots for a
user + period. The existing PDF report flow is left working as-is (already hardened to
include soft-deleted carry-forwards via `deleted_at > fromDate`); migrating it to source
from the ledger is a verified follow-up once the ledger is populated.

## Step 4 — Backfill existing soft-deleted history (best effort)
File: `scripts/backfill_settlement_history.js`. Reconstruct ledger docs from existing
soft-deleted settlement trades grouped by settlement timestamp. Idempotent. Recovers
chitra11's prior weeks.

## Step 5 — Verification
- Load-check model, service, controller.
- Backfill, then query ledger for chitra11 and confirm snapshots match known-good figures.
- Confirm a second settlement never alters/removes prior ledger documents.

## Rollout
- Deploy backend; ledger captures from the next settlement.
- Run backfill once for historical recovery.
- No Flutter change required.
