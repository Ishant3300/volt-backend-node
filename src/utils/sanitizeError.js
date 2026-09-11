/**
 * Turns a caught error into a client-safe message.
 *
 * Deliberate business-logic throws in this codebase (e.g. `throw new
 * Error('Insufficient balance')`) are meant to reach the client verbatim —
 * that's the actual UX (a master trying to delete a user with open
 * positions needs to see why, not "Server error"). But a caught error can
 * just as easily be a raw Mongo/Mongoose error, a TypeError from a bug, or
 * a network error — those can leak DB/collection/field names or file paths
 * and were never meant for an HTTP response body.
 *
 * Heuristic: recognize the shape of "internal" errors (known driver/runtime
 * error names, or message patterns those errors produce) and redact only
 * those, logging the real one server-side. Anything else — which in
 * practice means a plain `Error` with a human-written message, exactly the
 * deliberate-throw case — passes through unchanged.
 */
const INTERNAL_ERROR_NAMES = new Set([
  'MongoServerError',
  'MongoError',
  'MongoNetworkError',
  'MongoParseError',
  'MongoServerSelectionError',
  'MongoWriteConcernError',
  'CastError',
  'ValidationError',
  'VersionError',
  'StrictModeError',
  'TypeError',
  'ReferenceError',
  'SyntaxError',
  'RangeError',
]);

const INTERNAL_MESSAGE_PATTERN =
  /E11000|duplicate key|Cast to [A-Za-z]+ failed|ObjectId|Mongo|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|is not a function|Cannot read propert(?:y|ies)|Cannot set propert(?:y|ies)|undefined is not|null is not/i;

function sanitizeErrorMessage(error) {
  const name = error?.name || '';
  const message = String(error?.message || '');

  const looksInternal = INTERNAL_ERROR_NAMES.has(name) || INTERNAL_MESSAGE_PATTERN.test(message);

  if (looksInternal) {
    console.error('[sanitizeError] Internal error redacted from response:', error);
    return 'Something went wrong. Please try again.';
  }

  return message;
}

module.exports = { sanitizeErrorMessage };
