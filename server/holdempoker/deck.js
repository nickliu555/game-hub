'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Hold'em Poker — pure card helpers. Same card ids as Hearts: rank
// ('2'..'10','J','Q','K','A') + suit letter ('C','D','H','S'), e.g. '10H'.
// The id doubles as the asset filename the clients load.
// ─────────────────────────────────────────────────────────────────────────

const SUITS = ['C', 'D', 'H', 'S'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT_SYMBOL = { C: '♣', D: '♦', H: '♥', S: '♠' };

const RANK_VALUE = RANKS.reduce((acc, r, i) => { acc[r] = i + 2; return acc; }, {});

function suitOf(card) { return card.slice(-1); }
function rankOf(card) { return card.slice(0, -1); }
function rankValue(card) { return RANK_VALUE[rankOf(card)] || 0; }
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

module.exports = {
  SUITS,
  RANKS,
  SUIT_SYMBOL,
  RANK_VALUE,
  suitOf,
  rankOf,
  rankValue,
  labelOf,
  buildDeck,
  makeRng,
  shuffle,
};
