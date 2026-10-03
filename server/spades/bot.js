'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Spades — CPU players.
//
// Bidding counts likely tricks the way a club player would (top cards, long
// trumps, short side suits it can ruff in). Play is a set of rules a decent
// partner follows: win the tricks the team still needs, throw the cheapest
// card on a trick it can't win (high cards are worth keeping for later), duck
// once the contract is safe, shed high cards only when the 10-bag penalty is
// close, protect a nil partner, and try to bust an opponent's nil.
//
// Every decision is made from `game.botView()` — the CPU's own cards plus
// the public record of the hand. It never sees another hand.
// ─────────────────────────────────────────────────────────────────────────

const { SUITS, suitOf, rankValue, isSpade, trickWinnerIndex } = require('./deck');

// Team bags (banked + this hand's overtricks) at which a CPU starts shedding
// high cards so it can't be forced into the 10-bag penalty.
const BAG_DANGER = 7;

const BOT_SETTINGS = Object.freeze({
  hard: Object.freeze({ playMs: 750, bidMs: 1300 }),
});

function bySuit(hand) {
  const out = { C: [], D: [], H: [], S: [] };
  for (const c of hand) out[suitOf(c)].push(c);
  for (const s of SUITS) out[s].sort((a, b) => rankValue(a) - rankValue(b));
  return out;
}

function lowest(cards) {
  return cards.reduce((best, c) => (best === null || rankValue(c) < rankValue(best) ? c : best), null);
}
function highest(cards) {
  return cards.reduce((best, c) => (best === null || rankValue(c) > rankValue(best) ? c : best), null);
}

/** Expected tricks from a hand, before any thought about the partner. */
function estimateTricks(hand) {
  const s = bySuit(hand);
  const spades = s.S;
  let tricks = 0;

  const has = (suit, rank) => s[suit].some((c) => c.slice(0, -1) === rank);

  // Trumps: top honours, then length beyond three.
  if (has('S', 'A')) tricks += 1;
  if (has('S', 'K')) tricks += spades.length >= 2 ? 1 : 0.4;
  if (has('S', 'Q')) tricks += spades.length >= 3 ? 0.8 : 0.2;
  if (has('S', 'J')) tricks += spades.length >= 4 ? 0.5 : 0;
  tricks += Math.max(0, spades.length - 3) * 0.9;

  // Side suits: honours that are likely to cash before someone ruffs them.
  let ruffs = 0;
  for (const suit of ['C', 'D', 'H']) {
    const len = s[suit].length;
    if (has(suit, 'A')) tricks += len <= 5 ? 1 : 0.6;
    if (has(suit, 'K')) tricks += len >= 2 && len <= 4 ? 0.8 : (len >= 2 ? 0.4 : 0.1);
    if (has(suit, 'Q')) tricks += len >= 3 && len <= 4 ? 0.3 : 0;
    if (len === 0) ruffs += 1;
    else if (len === 1) ruffs += 0.5;
  }
  // A short suit only scores if there are trumps left over to ruff with.
  const spareTrumps = Math.max(0, spades.length - 2);
  tricks += Math.min(ruffs, spareTrumps) * 0.8;
  return tricks;
}

/** Could this hand survive a nil? */
function nilWorthy(hand) {
  const s = bySuit(hand);
  if (s.S.length > 3) return false;
  if (s.S.some((c) => rankValue(c) >= 11)) return false;     // J♠ or better
  for (const suit of ['C', 'D', 'H']) {
    const cards = s[suit];
    if (!cards.length) continue;
    const top = rankValue(cards[cards.length - 1]);
    // A lone high card can't be ducked under anything.
    if (top >= 13 && cards.length <= 3) return false;
    if (top === 14) return false;
  }
  return estimateTricks(hand) < 1.2;
}

/**
 * @returns {{ bid:number, blind?:boolean }}
 */
function chooseBid(view, _level, rng) {
  const random = rng || Math.random;
  const partner = view.seats[(view.seatIndex + 2) % 4];
  const behind = view.score.theirs - view.score.mine;

  // A desperate team can roll the dice on a Blind Nil if the partner is strong.
  if (behind >= 200 && partner.bid !== null && !partner.nil && partner.bid >= 4 && random() < 0.5) {
    return { bid: 0, blind: true };
  }

  if (!(partner.bid !== null && partner.nil) && nilWorthy(view.hand)) return { bid: 0 };

  let bid = Math.round(estimateTricks(view.hand));
  // Near 10 bags, shade the bid up rather than risk the penalty.
  if (view.score.bags >= 7) bid = Math.round(estimateTricks(view.hand) + 0.4);
  // Behind a nil partner, the team needs everything it can get.
  if (partner.bid !== null && partner.nil) bid = Math.max(bid, Math.round(estimateTricks(view.hand) + 0.3));
  bid = Math.max(1, Math.min(13, bid));
  if (partner.bid !== null && !partner.nil && partner.bid + bid > 13) bid = Math.max(1, 13 - partner.bid);
  return { bid };
}

// ─────────────────── Play ───────────────────

/** Would `card` take over the trick as it stands? */
function beats(card, trick) {
  if (!trick.length) return true;
  return trickWinnerIndex(trick.concat([card])) === trick.length;
}

/** Highest card still unplayed in `suit` that is not in `hand`. */
function topOutstanding(suit, hand, played) {
  const gone = new Set(played.concat(hand));
  for (let r = 14; r >= 2; r--) {
    const rank = r <= 10 ? String(r) : { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r];
    const card = rank + suit;
    if (!gone.has(card)) return card;
  }
  return null;
}

/** Is `card` the best card left in its suit? */
function isBoss(card, hand, played) {
  const top = topOutstanding(suitOf(card), hand, played);
  return !top || rankValue(card) > rankValue(top);
}

function choosePlay(view, _level, _rng) {
  const legal = view.legal;
  if (!legal || !legal.length) return null;
  if (legal.length === 1) return legal[0];

  const me = view.seats[view.seatIndex];
  const partnerIdx = (view.seatIndex + 2) % 4;
  const partner = view.seats[partnerIdx];
  const trick = view.trick;
  const position = trick.length;                // 0 = leading, 3 = last to play
  const seatAt = (i) => (view.trickLeadSeat + i) % 4;
  const winnerSeat = position ? seatAt(trickWinnerIndex(trick)) : -1;
  const partnerWinning = winnerSeat === partnerIdx;

  const winners = legal.filter((c) => beats(c, trick));
  const losers = legal.filter((c) => !beats(c, trick));

  // ── I bid nil: never win a trick if there is any way round it. ──
  if (me.nil && me.tricks === 0) {
    if (position === 0) {
      // Lead the lowest card of the suit where it is least likely to win.
      const nonSpades = legal.filter((c) => !isSpade(c));
      return lowest(nonSpades.length ? nonSpades : legal);
    }
    if (losers.length) {
      // Shed the most dangerous card that still ducks — a discard first, so
      // high cards in long side suits go while it is safe.
      const offSuit = losers.filter((c) => suitOf(c) !== suitOf(trick[0]) && !isSpade(c));
      if (offSuit.length) return highest(offSuit);
      return highest(losers);
    }
    return lowest(legal);
  }

  const teamBid = (me.nil ? 0 : (me.bid || 0)) + (partner.nil ? 0 : (partner.bid || 0));
  const teamTricks = (me.nil ? 0 : me.tricks) + (partner.nil ? 0 : partner.tricks);
  const need = teamBid - teamTricks;
  const covering = partner.nil && partner.tricks === 0;

  // Opponents' nils still alive — busting one is worth more than any bag.
  const oppNilSeats = [0, 1, 2, 3].filter((i) => view.seats[i].team !== me.team
    && view.seats[i].nil && view.seats[i].tricks === 0);

  if (position === 0) return chooseLead(view, { need, covering, oppNilSeats });

  // Partner nil: overtake whatever is winning if partner is, or still might be.
  if (covering) {
    const partnerPlayed = trick.some((_, i) => seatAt(i) === partnerIdx);
    if (partnerWinning && winners.length) return lowest(winners);
    if (!partnerPlayed && winners.length) return highest(winners);
  }

  // Opponent nil is currently winning: duck under it so it sticks.
  if (oppNilSeats.indexOf(winnerSeat) >= 0 && losers.length) return highest(losers);

  // Partner already has it — don't waste a card (and keep the bags down).
  if (partnerWinning && !covering) {
    const lastToPlay = position === 3;
    const partnerCard = trick[trick.findIndex((_, i) => seatAt(i) === partnerIdx)];
    const safe = lastToPlay || isBoss(partnerCard, view.hand, view.played) || isSpade(partnerCard);
    if (safe && losers.length) return lowest(losers);
  }

  if (need > 0 && winners.length) {
    if (position === 3) return lowest(winners);
    // Not last: win with a card that can't be topped, else the cheapest winner.
    const boss = winners.filter((c) => isBoss(c, view.hand, view.played) && !isSpade(c));
    if (boss.length) return lowest(boss);
    const sameSuit = winners.filter((c) => !isSpade(c));
    if (sameSuit.length) return highest(sameSuit);
    return lowest(winners);
  }

  // Can't take this trick: throw the cheapest card and keep the high ones for
  // tricks it can win later. When void, discard a side card, not a trump.
  if (!winners.length) return cheapestDiscard(legal);

  // Could win but doesn't need to (contract already made). Duck — and only
  // when the team is closing in on the 10-bag penalty, shed the highest card
  // that still loses so it can't be forced to win a bag later.
  const overtricks = Math.max(0, teamTricks - teamBid);
  const bagDanger = need <= 0 && view.score.bags + overtricks >= BAG_DANGER;
  if (losers.length) return bagDanger ? highest(losers) : cheapestDiscard(losers);
  return lowest(winners);
}

/** The least useful card: the lowest side-suit card, keeping spades as trumps. */
function cheapestDiscard(cards) {
  const side = cards.filter((c) => !isSpade(c));
  return lowest(side.length ? side : cards);
}

function chooseLead(view, { need, covering, oppNilSeats }) {
  const legal = view.legal;
  const hand = view.hand;
  const played = view.played;

  // Busting a nil: lead low and make them follow.
  if (oppNilSeats.length) {
    const nonSpades = legal.filter((c) => !isSpade(c));
    return lowest(nonSpades.length ? nonSpades : legal);
  }

  // Covering a nil partner: lead winners so partner can drop low cards under them.
  if (covering) {
    const bosses = legal.filter((c) => isBoss(c, hand, played));
    if (bosses.length) return highest(bosses);
    return highest(legal);
  }

  if (need > 0) {
    // Cash a sure side-suit winner first.
    const sideBosses = legal.filter((c) => !isSpade(c) && isBoss(c, hand, played));
    if (sideBosses.length) return highest(sideBosses);
    // With trump control, draw the opponents' spades.
    const spades = legal.filter(isSpade);
    if (spades.length && spades.some((c) => isBoss(c, hand, played)) && spades.length >= 3) {
      return highest(spades);
    }
  }

  // Otherwise lead low from the longest side suit to give little away.
  const groups = {};
  for (const c of legal) (groups[suitOf(c)] = groups[suitOf(c)] || []).push(c);
  let bestSuit = null;
  for (const suit of Object.keys(groups)) {
    if (suit === 'S' && Object.keys(groups).length > 1) continue;
    if (!bestSuit || groups[suit].length > groups[bestSuit].length) bestSuit = suit;
  }
  return lowest(groups[bestSuit]);
}

module.exports = {
  BOT_SETTINGS,
  estimateTricks,
  nilWorthy,
  chooseBid,
  choosePlay,
};
