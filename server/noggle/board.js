'use strict';

/**
 * Board geometry + traced-path validation for Boggle.
 *
 * The board is a `size x size` 2D array of tile strings — single uppercase
 * letters, or the two-letter tile 'QU'. Players build a word by tracing a
 * path of cells; each step must move to one of the 8 neighbours (horizontal,
 * vertical, or diagonal) of the previous cell, and no cell may be reused
 * within a single word.
 *
 * A "path" is an array of { r, c } cells. validatePath re-derives the word
 * from the path server-side (never trusting a client-sent word), so a player
 * can only ever score words that are actually spellable on the board.
 */

/** Two cells are adjacent if they differ by at most 1 in each axis and aren't identical. */
function isAdjacent(a, b) {
  const dr = Math.abs(a.r - b.r);
  const dc = Math.abs(a.c - b.c);
  return dr <= 1 && dc <= 1 && (dr !== 0 || dc !== 0);
}

/**
 * Validate a traced path against the board and derive the word it spells.
 *
 * Checks, in order: non-empty path, every cell in bounds, no repeated cell,
 * consecutive cells adjacent. On success returns the derived word (uppercase,
 * with 'QU' expanded) and its letter length (Qu = 2 letters).
 *
 * @param {string[][]} board
 * @param {{r:number,c:number}[]} path
 * @returns {{ ok: true, word: string, letterLen: number } | { ok: false, reason: string }}
 */
function validatePath(board, path) {
  if (!Array.isArray(path) || path.length === 0) {
    return { ok: false, reason: 'empty-path' };
  }
  const size = board.length;
  const seen = new Set();
  let word = '';
  for (let i = 0; i < path.length; i++) {
    const cell = path[i];
    if (
      !cell ||
      !Number.isInteger(cell.r) ||
      !Number.isInteger(cell.c) ||
      cell.r < 0 || cell.r >= size ||
      cell.c < 0 || cell.c >= size
    ) {
      return { ok: false, reason: 'out-of-bounds' };
    }
    const key = `${cell.r},${cell.c}`;
    if (seen.has(key)) return { ok: false, reason: 'cell-reused' };
    seen.add(key);
    if (i > 0 && !isAdjacent(path[i - 1], cell)) {
      return { ok: false, reason: 'not-adjacent' };
    }
    word += board[cell.r][cell.c];
  }
  return { ok: true, word: word.toUpperCase(), letterLen: word.length };
}

module.exports = { isAdjacent, validatePath };
