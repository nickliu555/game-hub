'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Liar's Dice — CPU player. Reads its own dice, treats every other die as an
// unknown (1/6 for 1s, 1/3 for any other face thanks to wild 1s), and weighs
// how likely the standing bid is against the raises open to it. A little
// noise and the odd bluff keep it from being a pushover — or predictable.
// Only ever returns an action the view says is legal.
// ─────────────────────────────────────────────────────────────────────────

const { countFace } = require('./game');

// Counted from when the turn opens — i.e. after the previous bid's pop-up has gone.
const BOT_SETTINGS = { thinkMs: 1300, jitterMs: 1200, callExtraMs: 900 };

function thinkDelay(choice, _view, rng) {
  let ms = BOT_SETTINGS.thinkMs + Math.floor(rng() * BOT_SETTINGS.jitterMs);
  if (choice.type !== 'bid') ms += BOT_SETTINGS.callExtraMs;
  return ms;
}

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}
function binomExact(n, p, k) {
  if (k < 0 || k > n) return 0;
  return choose(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
}
/** P(X ≥ k) for X ~ Binomial(n, p). */
function binomAtLeast(n, p, k) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let s = 0;
  for (let i = k; i <= n; i++) s += binomExact(n, p, i);
  return Math.min(1, s);
}

function faceOdds(face) { return face === 1 ? 1 / 6 : 1 / 3; }

/** How likely `qty` × `face` is to be on the table, given this bot's own dice. */
function probBid(view, qty, face) {
  const unknown = Math.max(0, view.totalDice - view.dice.length);
  return binomAtLeast(unknown, faceOdds(face), qty - countFace(view.dice, face));
}

function probExact(view, qty, face) {
  const unknown = Math.max(0, view.totalDice - view.dice.length);
  return binomExact(unknown, faceOdds(face), qty - countFace(view.dice, face));
}

/**
 * Decide one action for the CPU on turn.
 * @param {ReturnType<import('./game').Game['botView']>} view
 * @param {() => number} rng
 * @returns {{ type:'bid', qty:number, face:number } | { type:'bs' } | { type:'spot' }}
 */
function chooseAction(view, rng) {
  const random = rng || Math.random;
  const b = view.currentBid;

  if (!b) {
    // Opening: lead with the face it holds most of, as many as still looks likely.
    let face = 2;
    let best = -1;
    for (let f = 2; f <= 6; f++) {
      const v = countFace(view.dice, f) + random() * 0.9;
      if (v > best) { best = v; face = f; }
    }
    const want = 0.78 + (random() - 0.5) * 0.16;
    let qty = 1;
    for (let q = 1; q <= view.totalDice; q++) if (probBid(view, q, face) >= want) qty = q;
    return { type: 'bid', qty, face };
  }

  const cands = [];
  for (let f = 1; f <= 6; f++) {
    const min = view.legal[f];
    if (min == null) continue;
    for (let q = min; q <= Math.min(view.totalDice, min + 1); q++) {
      const p = probBid(view, q, f);
      const held = countFace(view.dice, f);
      // Bids on faces it actually holds feel safer; a little noise keeps it human.
      let score = p + held * 0.03 + (random() - 0.5) * 0.14 - (q - min) * 0.06;
      // Bidding 1s is a strong statement — only when it holds some.
      if (f === 1) score -= held ? 0.02 : 0.08;
      cands.push({ qty: q, face: f, p, score });
    }
  }

  const pTrue = probBid(view, b.qty, b.face);
  const pExact = probExact(view, b.qty, b.face);
  // Spot On pays out a die, so it's worth a shot when the count looks dead on.
  const down = view.diceCount < view.startDice;
  if (pExact > (down ? 0.34 : 0.4) && pExact > 1 - pTrue - 0.05 && random() < 0.6) return { type: 'spot' };
  const doubt = 0.3 + (random() - 0.5) * 0.12;
  if (pTrue < doubt) return { type: 'bs' };
  if (!cands.length) return pExact > 1 - pTrue ? { type: 'spot' } : { type: 'bs' };

  // A bluff now and then: a face it doesn't hold, at the cheapest legal step.
  const bluffable = cands.filter((c) => countFace(view.dice, c.face) === 0 && c.qty === view.legal[c.face] && c.p > 0.25);
  if (bluffable.length && random() < 0.12) return { type: 'bid', qty: bluffable[0].qty, face: bluffable[0].face };

  const safe = cands.filter((c) => c.p >= 0.5);
  const pool = safe.length ? safe : cands;
  pool.sort((x, y) => y.score - x.score);
  const pick = pool[0];
  // Every raise looks worse than calling the standing bid a lie.
  if (pick.p < 0.3 && 1 - pTrue > pick.p) return { type: 'bs' };
  return { type: 'bid', qty: pick.qty, face: pick.face };
}

module.exports = {
  BOT_SETTINGS,
  thinkDelay,
  chooseAction,
  probBid,
  probExact,
  binomAtLeast,
};
