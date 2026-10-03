'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Spades — pure card/deck/rules helpers. No I/O, no state; everything here is
// a plain function so scripts/test-spades-engine.js can exercise it headlessly.
//
// A card is a short string: rank ('2'..'10','J','Q','K','A') + suit letter
// ('C','D','H','S'). e.g. '2C', '10H', 'AS'. That id doubles as the asset
// filename the clients load (the card art is shared with Hearts).
// ─────────────────────────────────────────────────────────────────────────

const SUITS = ['C', 'D', 'H', 'S'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const TRUMP = 'S';

const SUIT_SYMBOL = { C: '♣', D: '♦', H: '♥', S: '♠' };

const RANK_VALUE = RANKS.reduce((acc, r, i) => { acc[r] = i + 2; return acc; }, {});

function suitOf(card) { return card.slice(-1); }
function rankOf(card) { return card.slice(0, -1); }
function rankValue(card) { return RANK_VALUE[rankOf(card)] || 0; }
function isSpade(card) { return suitOf(card) === TRUMP; }

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

// Display order alternates colour (♦ ♣ ♥ ♠) and parks the trump suit on the
// right, so spades always sit in the same place on the phone.
const SUIT_ORDER = { D: 0, C: 1, H: 2, S: 3 };

function sortHand(cards) {
  return cards.slice().sort((a, b) => {
    const s = SUIT_ORDER[suitOf(a)] - SUIT_ORDER[suitOf(b)];
    return s !== 0 ? s : rankValue(a) - rankValue(b);
  });
}

/**
 * Every card `hand` may legally play right now.
 *  • follow the led suit whenever you hold it, otherwise play anything
 *    (including a spade, which breaks spades);
 *  • you may not *lead* a spade until spades are broken, unless spades are
 *    all you hold.
 */
function legalPlays({ hand, trick, spadesBroken }) {
  if (!hand || hand.length === 0) return [];
  const leading = !trick || trick.length === 0;
  if (leading) {
    if (spadesBroken) return hand.slice();
    const nonSpades = hand.filter((c) => !isSpade(c));
    return nonSpades.length ? nonSpades : hand.slice();
  }
  const leadSuit = suitOf(trick[0]);
  const following = hand.filter((c) => suitOf(c) === leadSuit);
  return following.length ? following : hand.slice();
}

/** Index into `trick` of the winning card: the highest spade, else the highest of the led suit. */
function trickWinnerIndex(trick) {
  let best = 0;
  for (let i = 1; i < trick.length; i++) {
    const c = trick[i];
    const b = trick[best];
    // A discard (neither the best card's suit nor a trump) never takes over.
    if (isSpade(c) && !isSpade(b)) best = i;
    else if (suitOf(c) === suitOf(b) && rankValue(c) > rankValue(b)) best = i;
  }
  return best;
}

/**
 * Score one team's hand.
 *
 * @param {object} t
 * @param {{bid:number, nil:boolean, blind:boolean, tricks:number}[]} t.players
 * @param {number} t.bags   bags carried in from earlier hands
 * @returns {{contract:number, won:number, made:boolean, contractPoints:number,
 *   overtricks:number, nilPoints:number, bagsThisHand:number, bagPenalty:number,
 *   bags:number, delta:number, nils:{nil:boolean,blind:boolean,made:boolean,points:number}[]}}
 *
 * Rules:
 *  • the contract is the sum of the non-nil bids; tricks taken by a nil
 *    bidder never count toward it;
 *  • made → +10 per trick bid, +1 per overtrick; set → −10 per trick bid;
 *  • nil +100 / −100, blind nil +200 / −200, scored for that player alone;
 *  • tricks a nil bidder takes are bags for the team, like overtricks;
 *  • every 10 accumulated bags cost 100 points.
 */
function scoreTeam({ players, bags }) {
  let contract = 0;
  let won = 0;
  let nilTricks = 0;
  let nilPoints = 0;
  const nils = [];
  for (const p of players) {
    if (p.nil) {
      const value = p.blind ? 200 : 100;
      const made = p.tricks === 0;
      nilPoints += made ? value : -value;
      nilTricks += p.tricks;
      nils.push({ nil: true, blind: !!p.blind, made, points: made ? value : -value });
    } else {
      contract += p.bid;
      won += p.tricks;
      nils.push({ nil: false, blind: false, made: false, points: 0 });
    }
  }
  const made = won >= contract;
  const overtricks = made ? won - contract : 0;
  const contractPoints = made ? contract * 10 + overtricks : -contract * 10;
  const bagsThisHand = overtricks + nilTricks;
  let running = (bags || 0) + bagsThisHand;
  let bagPenalty = 0;
  while (running >= 10) { running -= 10; bagPenalty -= 100; }
  // Nil-bidder tricks are bags too, so they score the +1 an overtrick would.
  const delta = contractPoints + nilTricks + nilPoints + bagPenalty;
  return {
    contract,
    won,
    made,
    contractPoints,
    overtricks,
    nilTricks,
    nilPoints,
    bagsThisHand,
    bagPenalty,
    bags: running,
    delta,
    nils,
  };
}

module.exports = {
  SUITS,
  RANKS,
  TRUMP,
  SUIT_SYMBOL,
  suitOf,
  rankOf,
  rankValue,
  isSpade,
  labelOf,
  buildDeck,
  makeRng,
  shuffle,
  deal,
  sortHand,
  legalPlays,
  trickWinnerIndex,
  scoreTeam,
};
