'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Hearts — pure card/deck/rules helpers. No I/O, no state; everything here is
// a plain function so scripts/test-hearts-engine.js can exercise it headlessly.
//
// A card is a short string: rank ('2'..'10','J','Q','K','A') + suit letter
// ('C','D','H','S'). e.g. '2C', '10H', 'QS', 'JD'. That id doubles as the
// asset filename the clients load.
// ─────────────────────────────────────────────────────────────────────────

const SUITS = ['C', 'D', 'H', 'S'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const SUIT_SYMBOL = { C: '♣', D: '♦', H: '♥', S: '♠' };
const SUIT_NAME = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' };

const QUEEN_OF_SPADES = 'QS';
const JACK_OF_DIAMONDS = 'JD';
const TWO_OF_CLUBS = '2C';

// Hearts + the Queen always total 26; the Jack is a separate bonus.
const HEARTS_TOTAL = 26;
const QUEEN_POINTS = 13;
const JACK_POINTS = -10;

const RANK_VALUE = RANKS.reduce((acc, r, i) => { acc[r] = i + 2; return acc; }, {});

function suitOf(card) { return card.slice(-1); }
function rankOf(card) { return card.slice(0, -1); }
function rankValue(card) { return RANK_VALUE[rankOf(card)] || 0; }

function isHeart(card) { return suitOf(card) === 'H'; }

/** Hearts = 1 each, Q♠ = 13, J♦ = −10, everything else 0. */
function pointsOf(card) {
  if (card === QUEEN_OF_SPADES) return QUEEN_POINTS;
  if (card === JACK_OF_DIAMONDS) return JACK_POINTS;
  return isHeart(card) ? 1 : 0;
}

function isPointCard(card) {
  return isHeart(card) || card === QUEEN_OF_SPADES || card === JACK_OF_DIAMONDS;
}

/** Human-readable label for screen readers / server logs, e.g. "Q♠". */
function labelOf(card) { return rankOf(card) + SUIT_SYMBOL[suitOf(card)]; }

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(rank + suit);
  return deck;
}

/** Mulberry32 — small, seedable, good enough for shuffling and bot jitter. */
function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy. */
function shuffle(cards, rng) {
  const out = cards.slice();
  const random = rng || Math.random;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** Deal a shuffled deck into 4 hands of 13, each already sorted for display. */
function deal(rng) {
  const deck = shuffle(buildDeck(), rng);
  const hands = [[], [], [], []];
  for (let i = 0; i < deck.length; i++) hands[i % 4].push(deck[i]);
  return hands.map(sortHand);
}

// Display order: suits grouped C, D, S, H (so the two black suits don't sit
// next to each other and hearts — the danger suit — sit at the end), each
// ascending. Matching order on the phone and in the host's fan avoids mis-taps.
const SUIT_ORDER = { C: 0, D: 1, S: 2, H: 3 };

function sortHand(cards) {
  return cards.slice().sort((a, b) => {
    const s = SUIT_ORDER[suitOf(a)] - SUIT_ORDER[suitOf(b)];
    return s !== 0 ? s : rankValue(a) - rankValue(b);
  });
}

function hasSuit(hand, suit) {
  for (let i = 0; i < hand.length; i++) if (suitOf(hand[i]) === suit) return true;
  return false;
}

/**
 * Every card `hand` may legally play right now.
 *
 * House rules (see AGENTS.md / the game's help overlay):
 *  • the first trick of a hand must be led with 2♣;
 *  • follow the led suit whenever you hold it;
 *  • you may not *lead* hearts until hearts are broken, unless hearts are all
 *    you hold;
 *  • point cards ARE allowed on the first trick (deliberate house variation).
 *
 * @param {object} opts
 * @param {string[]} opts.hand        cards still held
 * @param {string[]} opts.trick       cards already played to this trick, in play order
 * @param {boolean}  opts.heartsBroken
 * @param {boolean}  opts.isFirstTrick  first trick of the hand
 */
function legalPlays({ hand, trick, heartsBroken, isFirstTrick }) {
  if (!hand || hand.length === 0) return [];
  const leading = !trick || trick.length === 0;

  if (leading) {
    if (isFirstTrick) return hand.indexOf(TWO_OF_CLUBS) >= 0 ? [TWO_OF_CLUBS] : [];
    if (heartsBroken) return hand.slice();
    const nonHearts = hand.filter((c) => !isHeart(c));
    return nonHearts.length ? nonHearts : hand.slice();
  }

  const leadSuit = suitOf(trick[0]);
  const following = hand.filter((c) => suitOf(c) === leadSuit);
  return following.length ? following : hand.slice();
}

/** Index into `trick` of the highest card of the led suit. */
function trickWinnerIndex(trick) {
  const leadSuit = suitOf(trick[0]);
  let best = 0;
  for (let i = 1; i < trick.length; i++) {
    if (suitOf(trick[i]) === leadSuit && rankValue(trick[i]) > rankValue(trick[best])) best = i;
  }
  return best;
}

function trickPoints(trick) {
  let total = 0;
  for (let i = 0; i < trick.length; i++) total += pointsOf(trick[i]);
  return total;
}

module.exports = {
  SUITS,
  RANKS,
  SUIT_SYMBOL,
  SUIT_NAME,
  QUEEN_OF_SPADES,
  JACK_OF_DIAMONDS,
  TWO_OF_CLUBS,
  HEARTS_TOTAL,
  QUEEN_POINTS,
  JACK_POINTS,
  suitOf,
  rankOf,
  rankValue,
  isHeart,
  isPointCard,
  pointsOf,
  labelOf,
  buildDeck,
  makeRng,
  shuffle,
  deal,
  sortHand,
  hasSuit,
  legalPlays,
  trickWinnerIndex,
  trickPoints,
};
