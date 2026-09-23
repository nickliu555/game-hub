'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Hearts — endgame search.
//
// Once only a few cards remain, the hand is small enough to actually solve
// rather than guess at. We still cannot see the other three hands, so this is
// determinized search: sample a deal of the unseen cards that is consistent
// with everything the table has shown (voids, cards already played, and the
// three cards we passed), solve THAT deal exactly, and average over samples.
//
// Each seat is assumed to minimise its own points, which is what a Hearts
// player is actually doing — not to gang up on us.
// ─────────────────────────────────────────────────────────────────────────

const {
  SUITS,
  RANKS,
  JACK_OF_DIAMONDS,
  suitOf,
  isHeart,
  pointsOf,
  trickWinnerIndex,
  legalPlays,
} = require('./deck');

const SEAT_COUNT = 4;
// Cards-in-hand at which the tree is small enough to search exhaustively.
const MAX_CARDS = 4;
const DEAL_RETRIES = 40;

// The tree grows steeply with the last card, so buy accuracy where it is cheap
// and settle for fewer deals where it is not. Measured: 24 samples at 4 cards
// is only 0.03 better than 8 and costs three times the search.
function samplesFor(cards) {
  return cards >= 4 ? 8 : 24;
}

// An unconstrained 4-card position can reach ~330k leaves per sample, which is
// over a second of blocked event loop for every other game in the hub. Cap the
// work instead: a position we cannot afford falls back to the heuristic, which
// is what used to play it anyway.
const NODE_BUDGET = 20000;
const ABORT = {};
let nodes = 0;
// The fewest points the seat on turn could possibly take over the rest of the
// hand: zero, or −10 while the J♦ is still live. A move that reaches it cannot
// be improved on, so the remaining branches are dead.
let floorValue = 0;

const FULL_DECK = [];
for (const suit of SUITS) for (const rank of RANKS) FULL_DECK.push(rank + suit);

/**
 * Exact maxⁿ over a fully known deal. Returns the points each seat takes over
 * the remainder of the hand. Hands are mutated and restored as we go.
 */
function search(hands, trickCards, leadSeat, heartsBroken) {
  if (++nodes > NODE_BUDGET) throw ABORT;
  const turn = (leadSeat + trickCards.length) % SEAT_COUNT;
  if (hands[turn].length === 0) return [0, 0, 0, 0];

  const legal = legalPlays({
    hand: hands[turn],
    trick: trickCards,
    heartsBroken,
    isFirstTrick: false,
  });

  let best = null;
  for (let i = 0; i < legal.length; i++) {
    const card = legal[i];
    const at = hands[turn].indexOf(card);
    hands[turn].splice(at, 1);
    trickCards.push(card);

    let result;
    if (trickCards.length === SEAT_COUNT) {
      const winner = (leadSeat + trickWinnerIndex(trickCards)) % SEAT_COUNT;
      let pot = 0;
      for (let k = 0; k < trickCards.length; k++) pot += pointsOf(trickCards[k]);
      const rest = trickCards.splice(0, SEAT_COUNT);
      result = search(hands, trickCards, winner, heartsBroken || isHeart(card)).slice();
      result[winner] += pot;
      for (let k = 0; k < rest.length; k++) trickCards.push(rest[k]);
    } else {
      result = search(hands, trickCards, leadSeat, heartsBroken || isHeart(card));
    }

    trickCards.pop();
    hands[turn].splice(at, 0, card);

    if (best === null || result[turn] < best[turn]) best = result.slice();
    if (best[turn] <= floorValue) break;
  }
  return best || [0, 0, 0, 0];
}

/** Deal `unknown` among the opponents, respecting capacities and shown voids. */
function sampleDeal(unknown, caps, voids, pins, rng) {
  const hands = [[], [], [], []];
  const room = caps.slice();

  for (const card of pins.keys()) {
    const seat = pins.get(card);
    if (room[seat] <= 0) return null;
    hands[seat].push(card);
    room[seat]--;
  }

  const rest = [];
  for (const c of unknown) if (!pins.has(c)) rest.push(c);
  // Most-constrained first, so the awkward suits are placed while there is
  // still somewhere to put them.
  const options = (card) => {
    const suit = suitOf(card);
    const out = [];
    for (let i = 0; i < SEAT_COUNT; i++) {
      if (room[i] <= 0) continue;
      if (voids[i] && voids[i][suit]) continue;
      out.push(i);
    }
    return out;
  };
  rest.sort((a, b) => options(a).length - options(b).length || rng() - 0.5);

  for (const card of rest) {
    const opts = options(card);
    if (!opts.length) return null;
    // Weight by remaining room so the deal stays roughly uniform.
    let total = 0;
    for (const s of opts) total += room[s];
    let roll = rng() * total;
    let chosen = opts[opts.length - 1];
    for (const s of opts) {
      roll -= room[s];
      if (roll <= 0) { chosen = s; break; }
    }
    hands[chosen].push(card);
    room[chosen]--;
  }
  return hands;
}

/**
 * The best card to play right now, or null when the position is too big to
 * search or the view is missing what the search needs.
 *
 * @param {object} view   see Game#botView
 * @param {() => number} rng
 */
function solve(view, rng) {
  const legal = view.legal || [];
  if (legal.length < 2) return null;

  const hand = view.hand || [];
  if (hand.length > MAX_CARDS) return null;

  const seat = view.seatIndex;
  const leadSeat = view.trickLeadSeat;
  if (typeof seat !== 'number' || typeof leadSeat !== 'number' || leadSeat < 0) return null;

  const trickCards = (view.trick || []).slice();
  const seen = new Set(view.seen || []);
  const mineSet = new Set(hand);

  const unknown = [];
  for (const c of FULL_DECK) if (!seen.has(c) && !mineSet.has(c)) unknown.push(c);

  // A seat that has already played this trick is one card lighter than we are.
  const acted = new Set();
  for (let k = 0; k < trickCards.length; k++) acted.add((leadSeat + k) % SEAT_COUNT);
  const caps = [0, 0, 0, 0];
  let capTotal = 0;
  for (let i = 0; i < SEAT_COUNT; i++) {
    if (i === seat) continue;
    caps[i] = acted.has(i) ? hand.length - 1 : hand.length;
    capTotal += caps[i];
  }
  if (capTotal !== unknown.length) return null;

  const pins = new Map();
  if (typeof view.passedTo === 'number' && view.passedTo >= 0 && view.passedTo !== seat) {
    for (const c of view.passedCards || []) {
      if (!seen.has(c) && !mineSet.has(c)) pins.set(c, view.passedTo);
    }
  }

  const voids = Array.isArray(view.voids) ? view.voids : [{}, {}, {}, {}];
  const totals = new Map();
  const counts = new Map();
  const samples = samplesFor(hand.length);
  const trickBase = trickCards;
  let sampled = 0;

  nodes = 0;
  floorValue = seen.has(JACK_OF_DIAMONDS) ? 0 : -10;
  for (let s = 0; s < samples; s++) {
    let hands = null;
    for (let attempt = 0; attempt < DEAL_RETRIES && !hands; attempt++) {
      hands = sampleDeal(unknown, caps, voids, pins, rng);
    }
    if (!hands) continue;
    hands[seat] = hand.slice();

    // Banked only once the whole sample survives, so an abort cannot leave a
    // half-scored deal skewing the averages.
    const local = new Map();
    let aborted = false;
    try {
      for (const card of legal) {
        const at = hands[seat].indexOf(card);
        if (at < 0) continue;
        hands[seat].splice(at, 1);
        const tc = trickBase.slice();
        tc.push(card);
        const hb = view.heartsBroken || isHeart(card);

        let mine;
        if (tc.length === SEAT_COUNT) {
          const winner = (leadSeat + trickWinnerIndex(tc)) % SEAT_COUNT;
          let pot = 0;
          for (let k = 0; k < tc.length; k++) pot += pointsOf(tc[k]);
          mine = search(hands, [], winner, hb)[seat] + (winner === seat ? pot : 0);
        } else {
          mine = search(hands, tc, leadSeat, hb)[seat];
        }

        hands[seat].splice(at, 0, card);
        local.set(card, mine);
      }
    } catch (e) {
      if (e !== ABORT) throw e;
      aborted = true;
    }
    if (aborted) break;

    for (const card of local.keys()) {
      totals.set(card, (totals.get(card) || 0) + local.get(card));
      counts.set(card, (counts.get(card) || 0) + 1);
    }
    sampled++;
  }

  if (!sampled) return null;

  let bestCard = null;
  let bestScore = Infinity;
  for (const card of legal) {
    const n = counts.get(card) || 0;
    if (!n) continue;
    const avg = totals.get(card) / n;
    if (avg < bestScore - 1e-9) { bestScore = avg; bestCard = card; }
  }
  return bestCard;
}

module.exports = { solve, MAX_CARDS, samplesFor };
