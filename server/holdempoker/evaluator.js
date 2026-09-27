'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Hold'em Poker — hand evaluator. Picks the best 5 of 5–7 cards and returns a
// single comparable number (higher wins, equal = split), a display name and
// the five cards that make the hand (for highlighting at showdown).
// ─────────────────────────────────────────────────────────────────────────

const { suitOf, rankValue } = require('./deck');

const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

const CATEGORY_NAME = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

const RANK_WORD = {
  2: ['Two', 'Twos'], 3: ['Three', 'Threes'], 4: ['Four', 'Fours'], 5: ['Five', 'Fives'],
  6: ['Six', 'Sixes'], 7: ['Seven', 'Sevens'], 8: ['Eight', 'Eights'], 9: ['Nine', 'Nines'],
  10: ['Ten', 'Tens'], 11: ['Jack', 'Jacks'], 12: ['Queen', 'Queens'], 13: ['King', 'Kings'],
  14: ['Ace', 'Aces'],
};
function one(v) { return RANK_WORD[v][0]; }
function many(v) { return RANK_WORD[v][1]; }

/** Pack [category, t1..t5] into one number; every tiebreak value is ≤ 14. */
function pack(parts) {
  let s = 0;
  for (let i = 0; i < 6; i++) s = s * 15 + (parts[i] || 0);
  return s;
}

/** Score exactly five cards. */
function evaluate5(cards) {
  const vals = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));

  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const groups = Object.keys(counts)
    .map((k) => ({ v: Number(k), n: counts[k] }))
    .sort((a, b) => b.n - a.n || b.v - a.v);

  let straightHigh = 0;
  if (groups.length === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals[0] === 14 && vals[1] === 5) straightHigh = 5; // the wheel, A-2-3-4-5
  }

  let parts;
  if (straightHigh && flush) parts = [CATEGORY.STRAIGHT_FLUSH, straightHigh];
  else if (groups[0].n === 4) parts = [CATEGORY.QUADS, groups[0].v, groups[1].v];
  else if (groups[0].n === 3 && groups[1].n === 2) parts = [CATEGORY.FULL_HOUSE, groups[0].v, groups[1].v];
  else if (flush) parts = [CATEGORY.FLUSH].concat(vals);
  else if (straightHigh) parts = [CATEGORY.STRAIGHT, straightHigh];
  else if (groups[0].n === 3) parts = [CATEGORY.TRIPS, groups[0].v, groups[1].v, groups[2].v];
  else if (groups[0].n === 2 && groups[1].n === 2) parts = [CATEGORY.TWO_PAIR, groups[0].v, groups[1].v, groups[2].v];
  else if (groups[0].n === 2) parts = [CATEGORY.PAIR, groups[0].v, groups[1].v, groups[2].v, groups[3].v];
  else parts = [CATEGORY.HIGH_CARD].concat(vals);

  return { score: pack(parts), parts };
}

function nameOf(parts) {
  const c = parts[0];
  switch (c) {
    case CATEGORY.STRAIGHT_FLUSH: return parts[1] === 14 ? 'Royal Flush' : 'Straight Flush, ' + one(parts[1]) + ' High';
    case CATEGORY.QUADS: return 'Four of a Kind, ' + many(parts[1]);
    case CATEGORY.FULL_HOUSE: return 'Full House, ' + many(parts[1]) + ' over ' + many(parts[2]);
    case CATEGORY.FLUSH: return 'Flush, ' + one(parts[1]) + ' High';
    case CATEGORY.STRAIGHT: return 'Straight, ' + one(parts[1]) + ' High';
    case CATEGORY.TRIPS: return 'Three of a Kind, ' + many(parts[1]);
    case CATEGORY.TWO_PAIR: return 'Two Pair, ' + many(parts[1]) + ' and ' + many(parts[2]);
    case CATEGORY.PAIR: return 'Pair of ' + many(parts[1]);
    default: return one(parts[1]) + ' High';
  }
}

/**
 * Best five-card hand out of 5–7 cards.
 * @returns {{ score:number, category:number, categoryName:string, name:string, cards:string[] }}
 */
function bestHand(cards) {
  const n = cards.length;
  if (n < 5) throw new Error('bestHand needs at least 5 cards');
  let best = null;
  let bestCards = null;
  // Every 5-card subset: at most C(7,5) = 21.
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const r = evaluate5(five);
            if (!best || r.score > best.score) { best = r; bestCards = five; }
          }
        }
      }
    }
  }
  return {
    score: best.score,
    category: best.parts[0],
    categoryName: CATEGORY_NAME[best.parts[0]],
    name: nameOf(best.parts),
    cards: bestCards,
  };
}

module.exports = {
  CATEGORY,
  CATEGORY_NAME,
  evaluate5,
  bestHand,
};
