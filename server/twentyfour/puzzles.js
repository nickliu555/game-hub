'use strict';

const path = require('path');
const fs = require('fs');

// Load the curated puzzle list. The JSON is a top-level array of 4-number
// arrays, ordered by ascending difficulty. We partition the array by index
// into thirds: easy / medium / hard. Border puzzles go to whichever pool
// they happen to land in — small jitter at the boundaries is harmless.
const RAW = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'puzzles.json'), 'utf8')
);

// Canonical solution strings, indexed by puzzle id (same index as RAW). Used
// for the Race-mode reveal when a problem times out with no winner. Lives in
// the public assets folder (also served to clients); we read it directly so
// the server has an authoritative copy.
const SOLUTIONS = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'twentyfour', 'data', 'solutions.json'),
    'utf8'
  )
);

function solutionFor(id) {
  if (!Number.isInteger(id) || id < 0 || id >= SOLUTIONS.length) return null;
  return SOLUTIONS[id] || null;
}

function partition(list) {
  const n = list.length;
  // Floor-based thirds so any remainder accumulates in `hard` (the last
  // pool). Examples: n=10 → 3 / 3 / 4. n=11 → 3 / 3 / 5. n=1362 → 454/454/454.
  const a = Math.floor(n / 3);
  const easy = [];
  const medium = [];
  const hard = [];
  for (let i = 0; i < n; i++) {
    const puzzle = { id: i, numbers: list[i].slice() };
    if (i < a) easy.push(puzzle);
    else if (i < a * 2) medium.push(puzzle);
    else hard.push(puzzle);
  }
  return { easy, medium, hard };
}

const POOLS = partition(RAW);

function fisherYates(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build a freshly-shuffled queue for the requested difficulty.
 *   'easy' | 'medium' | 'hard'  → that pool only
 *   'any' (or anything else)    → merged pool of all three
 * Returns an array of { id, numbers } objects. Each player gets their own
 * independent queue, so no two players need to be on the same puzzle index.
 */
function buildQueue(difficulty) {
  if (difficulty === 'easy' || difficulty === 'medium' || difficulty === 'hard') {
    return fisherYates(POOLS[difficulty]);
  }
  return fisherYates([].concat(POOLS.easy, POOLS.medium, POOLS.hard));
}

function counts() {
  return {
    easy: POOLS.easy.length,
    medium: POOLS.medium.length,
    hard: POOLS.hard.length,
    total: RAW.length,
  };
}

module.exports = { buildQueue, counts, solutionFor };
