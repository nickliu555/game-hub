'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Hearts — CPU decision logic. Pure functions over an explicit view of the
// table, so scripts/test-hearts-bot.js can self-play thousands of hands
// headlessly. The state machine (./game.js) owns the think-time timers.
//
// Every function MUST return a card from the `legal` array it was handed —
// the bot can never be the reason an illegal card hits the table.
// ─────────────────────────────────────────────────────────────────────────

const {
  QUEEN_OF_SPADES,
  JACK_OF_DIAMONDS,
  suitOf,
  rankValue,
  isHeart,
  pointsOf,
  trickWinnerIndex,
} = require('./deck');

const DIFFICULTIES = ['easy', 'normal', 'hard'];

// How long a CPU "thinks" before acting, so the table reads as a real turn
// instead of cards teleporting out. Passing takes longer — it's 3 decisions.
const BOT_SETTINGS = Object.freeze({
  easy: Object.freeze({ playMs: 1500, passMs: 2600 }),
  normal: Object.freeze({ playMs: 1000, passMs: 2000 }),
  hard: Object.freeze({ playMs: 750, passMs: 1600 }),
});

function normalizeDifficulty(level) {
  return DIFFICULTIES.indexOf(level) >= 0 ? level : 'normal';
}

function pick(list, rng) {
  return list[Math.floor((rng ? rng() : Math.random()) * list.length) % list.length];
}

function bySuit(cards, suit) {
  return cards.filter((c) => suitOf(c) === suit);
}

function lowest(cards) {
  return cards.reduce((a, b) => (rankValue(b) < rankValue(a) ? b : a));
}

function highest(cards) {
  return cards.reduce((a, b) => (rankValue(b) > rankValue(a) ? b : a));
}

// ─────────────────────────── Passing ───────────────────────────

/**
 * Choose 3 cards to pass away.
 * @param {string[]} hand 13 cards
 * @param {'easy'|'normal'|'hard'} difficulty
 * @param {() => number} rng
 * @returns {string[]} exactly 3 cards from `hand`
 */
function choosePass(hand, difficulty, rng) {
  const level = normalizeDifficulty(difficulty);
  const pool = hand.slice();

  if (level === 'easy') {
    const out = [];
    while (out.length < 3 && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    return out;
  }

  // Score every card by how much we want it GONE.
  const spades = bySuit(pool, 'S');
  const spadeGuards = spades.filter((c) => rankValue(c) < rankValue(QUEEN_OF_SPADES)).length;
  const suitCounts = { C: 0, D: 0, H: 0, S: 0 };
  for (const c of pool) suitCounts[suitOf(c)]++;

  const want = (card) => {
    const suit = suitOf(card);
    const value = rankValue(card);
    let score = value; // high cards are dangerous

    if (card === QUEEN_OF_SPADES) {
      // Keep the Queen only if enough low spades protect her from being forced out.
      score += spadeGuards >= 3 ? 8 : 60;
    } else if (suit === 'S' && value > rankValue(QUEEN_OF_SPADES)) {
      score += 30; // A♠/K♠ get eaten by the Queen
    } else if (suit === 'S') {
      score -= 18; // low spades are the Queen guards — hold them
    }

    if (card === JACK_OF_DIAMONDS) score -= 70; // the −10 bonus, never give it away
    else if (isHeart(card)) score += value >= 11 ? 22 : 4;

    if (level === 'hard') {
      // Voiding a short side suit lets us dump danger later.
      if (suit !== 'S' && suitCounts[suit] <= 2) score += 14;
      // A lone low diamond is worth keeping to chase the Jack.
      if (suit === 'D' && value <= 8) score -= 6;
    }
    return score;
  };

  return pool
    .slice()
    .sort((a, b) => want(b) - want(a) || rankValue(b) - rankValue(a))
    .slice(0, 3);
}

// ─────────────────────────── Playing ───────────────────────────

/**
 * Choose a card to play.
 *
 * @param {object} view
 * @param {string[]} view.hand          cards still held
 * @param {string[]} view.legal         legal subset of `hand` (authoritative)
 * @param {string[]} view.trick         cards already on the table this trick
 * @param {boolean}  view.heartsBroken
 * @param {number}   view.trickNumber   1-based
 * @param {string[]} view.seen          every card played this hand (incl. current trick)
 * @param {'easy'|'normal'|'hard'} difficulty
 * @param {() => number} rng
 */
function choosePlay(view, difficulty, rng) {
  const legal = view.legal;
  if (!legal || legal.length === 0) return null;
  if (legal.length === 1) return legal[0];

  const level = normalizeDifficulty(difficulty);
  if (level === 'easy') return pick(legal, rng);

  const trick = view.trick || [];
  const hard = level === 'hard';
  return trick.length === 0
    ? chooseLead(view, legal, hard, rng)
    : chooseFollow(view, legal, hard, rng);
}

function chooseLead(view, legal, hard, rng) {
  const seen = new Set(view.seen || []);
  const queenGone = seen.has(QUEEN_OF_SPADES);
  const jackGone = seen.has(JACK_OF_DIAMONDS);
  const hand = view.hand || legal;

  // Flushing out the Queen is the single strongest lead in the game.
  if (hard && !queenGone) {
    const lowSpades = bySuit(legal, 'S').filter((c) => rankValue(c) < rankValue(QUEEN_OF_SPADES));
    const mySpades = bySuit(hand, 'S').length;
    if (lowSpades.length && mySpades >= 4 && view.trickNumber >= 2) return highest(lowSpades);
  }

  const score = (card) => {
    const suit = suitOf(card);
    const value = rankValue(card);
    let s = value * 2; // lead low

    if (suit === 'S' && !queenGone && value > rankValue(QUEEN_OF_SPADES)) s += 40;
    if (card === QUEEN_OF_SPADES) s += 45;
    if (isHeart(card)) s += 14;
    // Leading a suit we're long in is safer — more outs later.
    if (hard) {
      const len = bySuit(hand, suit).length;
      s -= Math.min(len, 5) * 2;
      // Chasing the Jack: lead low diamonds while it's still out there.
      if (suit === 'D' && !jackGone && value < rankValue(JACK_OF_DIAMONDS)) s -= 8;
    }
    return s;
  };

  const ranked = legal.slice().sort((a, b) => score(a) - score(b));
  // A little jitter between near-equal leads so two CPUs don't play identically.
  const best = score(ranked[0]);
  const ties = ranked.filter((c) => score(c) <= best + 1);
  return ties.length > 1 ? pick(ties, rng) : ranked[0];
}

function chooseFollow(view, legal, hard, rng) {
  const trick = view.trick;
  const leadSuit = suitOf(trick[0]);
  const following = suitOf(legal[0]) === leadSuit && legal.every((c) => suitOf(c) === leadSuit);
  const isLast = trick.length === 3;
  const winnerValue = rankValue(trick[trickWinnerIndex(trick)]);
  const pot = trick.reduce((sum, c) => sum + pointsOf(c), 0);
  const jackInTrick = trick.indexOf(JACK_OF_DIAMONDS) >= 0;

  if (following) {
    const under = legal.filter((c) => rankValue(c) < winnerValue);
    const over = legal.filter((c) => rankValue(c) >= winnerValue);

    // Taking the trick is GOOD when the Jack is in it and nothing else stings.
    const wantTrick = jackInTrick && pot < 0 && over.length > 0;
    if (wantTrick) return isLast ? lowest(over) : highest(over);

    // On the last seat a guaranteed-safe duck is free.
    if (under.length) return highest(under);
    if (hard && isLast && pot <= 0 && over.length) return lowest(over);
    return lowest(legal); // forced to take it — take it as cheaply as possible
  }

  // Void in the led suit: this is the moment to unload danger.
  const queen = legal.indexOf(QUEEN_OF_SPADES);
  if (queen >= 0) return QUEEN_OF_SPADES;
  const bigSpades = bySuit(legal, 'S').filter((c) => rankValue(c) > rankValue(QUEEN_OF_SPADES));
  if (bigSpades.length) return highest(bigSpades);

  const discardScore = (card) => {
    const value = rankValue(card);
    let s = -value; // dump high
    if (isHeart(card)) s -= 10;
    if (card === JACK_OF_DIAMONDS) s += 100; // never throw the bonus away
    if (hard && suitOf(card) === 'D' && value < rankValue(JACK_OF_DIAMONDS)) s += 6;
    return s;
  };
  const ranked = legal.slice().sort((a, b) => discardScore(a) - discardScore(b));
  const best = discardScore(ranked[0]);
  const ties = ranked.filter((c) => discardScore(c) <= best + 0.5);
  return ties.length > 1 ? pick(ties, rng) : ranked[0];
}

module.exports = {
  DIFFICULTIES,
  BOT_SETTINGS,
  normalizeDifficulty,
  choosePass,
  choosePlay,
};
