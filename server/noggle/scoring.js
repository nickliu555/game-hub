'use strict';

/**
 * Boggle scoring — official length → points curve. Word length is measured
 * in LETTERS, where the "Qu" tile counts as two letters (e.g. "squid" is a
 * five-letter word scoring 2 points despite using only four tiles).
 *
 *   3-4 letters : 1 point
 *   5 letters   : 2 points
 *   6 letters   : 3 points
 *   7 letters   : 5 points
 *   8+ letters  : 11 points
 *
 * Words shorter than the board's minimum length never reach scoring (they're
 * rejected earlier), but pointsForWord defensively returns 0 for len < 3.
 *
 * @param {number} letterLen number of letters in the word (Qu = 2)
 * @returns {number}
 */
function pointsForWord(letterLen) {
  if (letterLen < 3) return 0;
  if (letterLen <= 4) return 1;
  if (letterLen === 5) return 2;
  if (letterLen === 6) return 3;
  if (letterLen === 7) return 5;
  return 11;
}

module.exports = { pointsForWord };
