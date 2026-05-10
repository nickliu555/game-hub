'use strict';

/**
 * Kahoot-style scoring.
 * - Wrong / no answer => 0
 * - Correct => round(1000 * (1 - 0.5 * responseMs / timeLimitMs))
 *   Max 1000 (instant), min 500 (last millisecond).
 * - responseMs is clamped to [0, timeLimitMs].
 */
function calculatePoints(isCorrect, responseMs, timeLimitMs) {
  if (!isCorrect) return 0;
  if (typeof responseMs !== 'number' || !isFinite(responseMs)) return 0;
  if (typeof timeLimitMs !== 'number' || timeLimitMs <= 0) return 0;
  const clamped = Math.max(0, Math.min(responseMs, timeLimitMs));
  const pts = 1000 * (1 - 0.5 * (clamped / timeLimitMs));
  return Math.round(pts);
}

module.exports = { calculatePoints };
