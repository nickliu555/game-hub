'use strict';

/**
 * Boggle letter generation — authentic "dice shake".
 *
 * A Boggle board is not random letters: it's produced by shaking a tray of
 * cubic dice, each cube having a FIXED set of six letter faces. The dice are
 * shuffled into the tray (which die lands in which cell) and each die settles
 * on one random face. This gives a play-able distribution every time (plenty
 * of vowels, common consonants, rare letters clustered on a few cubes).
 *
 * Face notation: a face of 'Q' represents the classic "Qu" cube face — Q is
 * almost always followed by U in English, so Boggle prints "Qu" on the cube.
 * generateBoard() converts a landed 'Q' into the two-letter tile 'QU', which
 * counts as two letters for word length + scoring.
 *
 * Dice sets:
 *  - 4x4: standard modern Boggle (16 cubes, post-1987 distribution).
 *  - 5x5: Big Boggle / Boggle Master (25 cubes).
 *  - 6x6: Super Big Boggle (36 cubes).
 * Faces follow the standard published Boggle-style frequency distributions.
 */

// 4x4 — standard modern Boggle, 16 dice.
const DICE_4 = [
  'AAEEGN', 'ABBJOO', 'ACHOPS', 'AFFKPS',
  'AOOTTW', 'CIMOTU', 'DEILRX', 'DELRVY',
  'DISTTY', 'EEGHNW', 'EEINSU', 'EHRTVW',
  'EIOSST', 'ELRTTY', 'HIMNQU', 'HLNNRZ',
];

// 5x5 — Big Boggle, 25 dice.
const DICE_5 = [
  'AAAFRS', 'AAEEEE', 'AAFIRS', 'ADENNN', 'AEEEEM',
  'AEEGMU', 'AEGMNN', 'AFIRSY', 'BJKQXZ', 'CCNSTW',
  'CEIILT', 'CEILPT', 'CEIPST', 'DDLNOR', 'DHHLOR',
  'DHHNOT', 'DHLNOR', 'EIIITT', 'EMOTTT', 'ENSSSU',
  'FIPRSY', 'GORRVW', 'HIPRRY', 'NOOTUW', 'OOOTTU',
];

// 6x6 — Super Big Boggle, 36 dice.
const DICE_6 = [
  'AAAFRS', 'AAEEEE', 'AAEEOO', 'AAFIRS', 'ABDEIO', 'ADENNN',
  'AEEEEM', 'AEEGMU', 'AEGMNN', 'AEILMN', 'AEINOU', 'AFIRSY',
  'BBJKXZ', 'CCENST', 'CDDLNN', 'CEIITT', 'CEIPST', 'CFGNUY',
  'DDHNOT', 'DHHLOR', 'DHHNOW', 'DHLNOR', 'EIIITT', 'EILPST',
  'EMOTTT', 'ENSSSU', 'FIPRSY', 'GORRVW', 'HIPRRY', 'IPRRRY',
  'NOOTUW', 'OOOTTU', 'AEHTVW', 'EEINSU', 'EEGHNW', 'DEILRX',
];

const DICE = { 4: DICE_4, 5: DICE_5, 6: DICE_6 };

// Minimum word length per board size. Standard Boggle allows 3-letter words
// on the 4x4 board; Big Boggle (5x5) and Super Big Boggle (6x6) disallow
// three-letter words (they're too easy to find on the larger grid).
const MIN_WORD_LEN = { 4: 3, 5: 4, 6: 4 };

// Default round length per board size (seconds): 2 min for 4x4, 3 min for the
// larger boards. Host can override within [MIN, MAX].
const DEFAULT_TIME_SEC = { 4: 120, 5: 180, 6: 180 };
const MIN_TIME_SEC = 60;
const MAX_TIME_SEC = 600;

const VALID_SIZES = [4, 5, 6];

function fisherYates(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Shake the tray: shuffle which die lands in which cell, then roll each die
 * to one random face. Returns a `size x size` 2D array of tile strings
 * (single letters, or the two-letter 'QU' tile).
 *
 * @param {number} size 4 | 5 | 6
 * @returns {string[][]}
 */
function generateBoard(size) {
  const dice = DICE[size];
  if (!dice) throw new Error(`unknown board size: ${size}`);
  const shuffled = fisherYates(dice.slice());
  const flat = shuffled.map((die) => {
    const face = die[Math.floor(Math.random() * die.length)];
    return face === 'Q' ? 'QU' : face;
  });
  const grid = [];
  for (let r = 0; r < size; r++) {
    grid.push(flat.slice(r * size, (r + 1) * size));
  }
  return grid;
}

module.exports = {
  DICE,
  VALID_SIZES,
  MIN_WORD_LEN,
  DEFAULT_TIME_SEC,
  MIN_TIME_SEC,
  MAX_TIME_SEC,
  generateBoard,
};
