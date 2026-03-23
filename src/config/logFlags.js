/**
 * Logging flags — toggle verbose logs for noisy subsystems.
 * Set to `false` to silence them in production.
 */
module.exports = {
  LOG_LIVE_TICKS: false,       // "📈 Received X tick(s)", per-token LTP lines, broadcast count
  LOG_PRICE_QUEUE: false,      // "📤 [PriceQueue] Published", "🔄 Processing", "ℹ️ No matching orders"
  LOG_MARGIN_CALC: false,      // "💰 [Margin]" lines in marginService
};
