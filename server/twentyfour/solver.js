'use strict';

// Exact rational arithmetic for the "24" game so we never have to compare
// floats to 24. Numerators/denominators fit comfortably in safe integer
// range for any sane sequence of combinations on the puzzle inputs.

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = b; b = a % b; a = t; }
  return a || 1;
}

function makeRational(n, d) {
  if (d === 0) return null; // division by zero
  if (d < 0) { n = -n; d = -d; } // keep sign on numerator
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

function rFromInt(x) { return { n: x, d: 1 }; }
function rEq(a, b) { return a.n === b.n && a.d === b.d; }

function rAdd(a, b) { return makeRational(a.n * b.d + b.n * a.d, a.d * b.d); }
function rSub(a, b) { return makeRational(a.n * b.d - b.n * a.d, a.d * b.d); }
function rMul(a, b) { return makeRational(a.n * b.n, a.d * b.d); }
function rDiv(a, b) {
  if (b.n === 0) return null;
  return makeRational(a.n * b.d, a.d * b.n);
}

const OPS = {
  '+': rAdd,
  '-': rSub,
  '*': rMul,
  '/': rDiv,
};

/**
 * Replay a sequence of combine steps against the starting tile values.
 *
 *   numbers : [a, b, c, d]                   (integers, the four cards)
 *   steps   : [ { aId, op, bId }, ... ]      aId/bId are slot indices 0..3
 *
 * Combine model: tile `aId` is consumed and tile `bId` is replaced with the
 * result of (a OP b). Player builds the expression left-to-right one combine
 * at a time. At most 3 combines are possible (4 tiles → 1 tile).
 *
 * Returns:
 *   { ok: true,  reached24: boolean, finalValue: { n, d } }
 *   { ok: false, reason: 'bad-step' | 'div-by-zero' | 'too-many-steps' | 'not-finished' }
 *
 * "Each number used exactly once" is implicit: starting with 4 tiles, the
 * only way to end with one tile is to consume each of the other three via
 * combines that referenced it. We additionally enforce that aId !== bId
 * and that both tiles still exist.
 */
function replay(numbers, steps) {
  if (!Array.isArray(numbers) || numbers.length !== 4) {
    return { ok: false, reason: 'bad-puzzle' };
  }
  if (!Array.isArray(steps)) {
    return { ok: false, reason: 'bad-step' };
  }
  if (steps.length > 3) {
    return { ok: false, reason: 'too-many-steps' };
  }
  const tiles = new Map();
  for (let i = 0; i < 4; i++) {
    if (!Number.isFinite(numbers[i])) return { ok: false, reason: 'bad-puzzle' };
    tiles.set(i, rFromInt(numbers[i]));
  }
  for (const step of steps) {
    if (!step || typeof step !== 'object') return { ok: false, reason: 'bad-step' };
    const { aId, op, bId } = step;
    if (!Number.isInteger(aId) || !Number.isInteger(bId)) return { ok: false, reason: 'bad-step' };
    if (aId === bId) return { ok: false, reason: 'bad-step' };
    if (!tiles.has(aId) || !tiles.has(bId)) return { ok: false, reason: 'bad-step' };
    const fn = OPS[op];
    if (!fn) return { ok: false, reason: 'bad-step' };
    const result = fn(tiles.get(aId), tiles.get(bId));
    if (result === null) return { ok: false, reason: 'div-by-zero' };
    tiles.delete(aId);
    tiles.set(bId, result);
  }
  if (tiles.size !== 1) {
    return { ok: false, reason: 'not-finished' };
  }
  const finalValue = tiles.values().next().value;
  return {
    ok: true,
    reached24: rEq(finalValue, { n: 24, d: 1 }),
    finalValue,
  };
}

/**
 * Brute-force solver. Returns true if the 4 numbers admit ANY solution that
 * evaluates to exactly 24 using each number exactly once with +, -, *, /
 * and parentheses. Used by tests / sanity checks — NOT in the hot path.
 *
 * Implementation: combine any two tiles via any operator, recurse on the
 * resulting (N-1)-tile multiset. With only 4 starting tiles this is very
 * cheap (≤ 7,776 root-combinations explored in the worst case).
 */
function hasSolution(numbers) {
  if (!Array.isArray(numbers) || numbers.length !== 4) return false;
  const tiles = numbers.map(rFromInt);
  return _solve(tiles);
}

function _solve(tiles) {
  if (tiles.length === 1) {
    return rEq(tiles[0], { n: 24, d: 1 });
  }
  for (let i = 0; i < tiles.length; i++) {
    for (let j = 0; j < tiles.length; j++) {
      if (i === j) continue;
      const a = tiles[i];
      const b = tiles[j];
      const rest = tiles.filter((_, k) => k !== i && k !== j);
      for (const op of ['+', '-', '*', '/']) {
        const r = OPS[op](a, b);
        if (r === null) continue;
        if (_solve(rest.concat([r]))) return true;
      }
    }
  }
  return false;
}

module.exports = {
  replay,
  hasSolution,
  // exported for tests
  rFromInt,
  rEq,
  rAdd,
  rSub,
  rMul,
  rDiv,
  makeRational,
};
