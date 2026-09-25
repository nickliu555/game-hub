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
  SUITS,
  RANKS,
  QUEEN_OF_SPADES,
  JACK_OF_DIAMONDS,
  suitOf,
  rankValue,
  isHeart,
  pointsOf,
  trickWinnerIndex,
} = require('./deck');
const endgame = require('./endgame');

const QUEEN_VALUE = rankValue(QUEEN_OF_SPADES);
const JACK_VALUE = rankValue(JACK_OF_DIAMONDS);
// 8♥ and up — too high to duck with, so leading one is handing the trick away.
const HIGH_HEART_VALUE = 8;
const SEAT_COUNT = 4;

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

// ────────────────────── Reading the table ──────────────────────

/**
 * Everything the public record implies, from the point of view of one seat.
 * Nothing in here is hidden information: captured tricks are shown to the whole
 * table and a player who fails to follow suit has announced the void out loud.
 * Every hard-level decision keys off this rather than off its own hand alone.
 */
function readTable(view) {
  const mine = new Set(view.hand || []);
  const seen = new Set(view.seen || []);

  // What the other three seats can still be holding, by suit.
  const outstanding = { C: [], D: [], H: [], S: [] };
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const card = rank + suit;
      if (!mine.has(card) && !seen.has(card)) outstanding[suit].push(card);
    }
  }

  const voids = Array.isArray(view.voids) ? view.voids : [];
  const seat = typeof view.seatIndex === 'number' ? view.seatIndex : -1;

  // The 3 cards we passed are the only ones whose owner we know rather than
  // infer. They stay known until they hit the table.
  const knownSeat = new Map();
  if (typeof view.passedTo === 'number' && view.passedTo >= 0) {
    for (const c of view.passedCards || []) {
      if (!seen.has(c) && !mine.has(c)) knownSeat.set(c, view.passedTo);
    }
  }

  // Who has already acted this trick, in seat order from whoever led.
  const acted = new Set();
  const played = Array.isArray(view.trick) ? view.trick.length : 0;
  if (typeof view.trickLeadSeat === 'number' && view.trickLeadSeat >= 0) {
    for (let k = 0; k < played; k++) acted.add((view.trickLeadSeat + k) % SEAT_COUNT);
  }

  const higherOut = (card) => {
    const v = rankValue(card);
    let n = 0;
    for (const c of outstanding[suitOf(card)]) if (rankValue(c) > v) n++;
    return n;
  };

  return {
    outstanding,
    higherOut,
    /** Which seat holds this card, when we know for certain. -1 when we don't. */
    holderOf(card) {
      const at = knownSeat.get(card);
      return at === undefined ? -1 : at;
    },
    /**
     * Higher cards that can still land on THIS trick. Differs from higherOut
     * only for a card we passed to a seat that has already played — it is still
     * live for the rest of the hand, but it cannot beat us here.
     */
    higherOutToCome(card) {
      const v = rankValue(card);
      let n = 0;
      for (const c of outstanding[suitOf(card)]) {
        if (rankValue(c) <= v) continue;
        const at = knownSeat.get(c);
        if (at !== undefined && acted.has(at)) continue;
        n++;
      }
      return n;
    },
    /** How many are below it — zero means the card cannot possibly win a trick. */
    lowerOut(card) {
      const v = rankValue(card);
      let n = 0;
      for (const c of outstanding[suitOf(card)]) if (rankValue(c) < v) n++;
      return n;
    },
    /** How many opponents have already shown out of `suit`. */
    voidCount(suit) {
      let n = 0;
      for (let i = 0; i < voids.length; i++) if (i !== seat && voids[i] && voids[i][suit]) n++;
      return n;
    },
    /**
     * Seats still to act this trick that could still follow `suit`. Nothing but
     * the led suit can win a trick, so a zero here means the trick is already
     * decided — whoever is winning it now keeps it.
     */
    liveBehind(suit) {
      let n = 0;
      for (let i = 0; i < SEAT_COUNT; i++) {
        if (i === seat || acted.has(i)) continue;
        if (voids[i] && voids[i][suit]) continue;
        n++;
      }
      return n;
    },
    jackLoose: !mine.has(JACK_OF_DIAMONDS) && !seen.has(JACK_OF_DIAMONDS),
    holdJack: mine.has(JACK_OF_DIAMONDS),
    queenLoose: !mine.has(QUEEN_OF_SPADES) && !seen.has(QUEEN_OF_SPADES),
    // Q♦/K♦/A♦ — the cards that win the trick the J♦ falls in.
    catchers: Array.from(mine).filter((c) => suitOf(c) === 'D' && rankValue(c) > JACK_VALUE).length,
    moonThreat: moonThreat(view),
    moonRun: moonRun(view, higherOut),
  };
}

/**
 * Every point taken so far is ours and the rest of the hand is ours to win, so
 * stop ducking and run the table: a moon is 26 to each of the other three,
 * which dwarfs the couple of points ducking would have saved.
 */
function moonRun(view, higherOut) {
  const taken = view.taken;
  const seat = view.seatIndex;
  const hand = view.hand || [];
  if (!Array.isArray(taken) || typeof seat !== 'number' || !hand.length) return false;
  for (let i = 0; i < taken.length; i++) {
    if (i === seat) continue;
    for (const c of taken[i]) if (isHeart(c) || c === QUEEN_OF_SPADES) return false;
  }
  let risky = 0;
  for (const c of hand) if (higherOut(c) > 0) risky++;
  // Three quarters of what is left has to be unbeatable, and never more than a
  // couple of loose ends — any weaker than that and the run dies on somebody
  // else's ace, leaving us holding the points we went out of our way to collect.
  return risky <= 2 && risky * 4 <= hand.length;
}

/**
 * One opponent has swallowed every point card played so far and is far enough
 * along that letting the run finish would cost us the full 26. Conceding a
 * heart or two to break it is the cheapest insurance in the game.
 */
function moonThreat(view) {
  const taken = view.taken;
  const seat = view.seatIndex;
  if (!Array.isArray(taken) || typeof seat !== 'number') return false;
  let hot = -1;
  let hotCount = 0;
  for (let i = 0; i < taken.length; i++) {
    let points = 0;
    for (const c of taken[i]) if (isHeart(c) || c === QUEEN_OF_SPADES) points++;
    if (points === 0) continue;
    if (hot >= 0) return false; // the points are already split — nobody is shooting
    hot = i;
    hotCount = points;
  }
  return hot >= 0 && hot !== seat && hotCount >= 5;
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
  const hard = level === 'hard';
  const spades = bySuit(pool, 'S');
  const spadeGuards = spades.filter((c) => rankValue(c) < QUEEN_VALUE).length;
  const suitCounts = { C: 0, D: 0, H: 0, S: 0 };
  for (const c of pool) suitCounts[suitOf(c)]++;
  const catchers = bySuit(pool, 'D').filter((c) => rankValue(c) > JACK_VALUE).length;
  const holdJack = pool.indexOf(JACK_OF_DIAMONDS) >= 0;

  const want = (card) => {
    const suit = suitOf(card);
    const value = rankValue(card);
    let score = value; // high cards are dangerous

    if (card === QUEEN_OF_SPADES) {
      // Keep the Queen only if enough low spades protect her from being forced out.
      score += spadeGuards >= 3 ? 8 : 60;
    } else if (suit === 'S' && value > QUEEN_VALUE) {
      score += 30; // A♠/K♠ get eaten by the Queen
    } else if (suit === 'S') {
      score -= 18; // low spades are the Queen guards — hold them
    }

    if (card === JACK_OF_DIAMONDS) score -= 70; // the −10 bonus, never give it away
    else if (isHeart(card)) score += value >= 11 ? 22 : 4;

    if (hard) {
      if (suit === 'D' && value > JACK_VALUE) {
        // Q♦/K♦/A♦ are the only high cards in the deck that earn something:
        // they win the trick the J♦ falls in. Shipping one across is a gift.
        score -= 42;
      } else if (suit !== 'S' && suitCounts[suit] <= 2
                 && !(suit === 'D' && (catchers > 0 || holdJack))) {
        // Voiding a short side suit lets us dump danger later — but going void
        // in diamonds takes us out of the hunt for the bonus.
        score += 14;
      }
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
 * @param {object} view                 see Game#botView
 * @param {string[]} view.hand          cards still held
 * @param {string[]} view.legal         legal subset of `hand` (authoritative)
 * @param {string[]} view.trick         cards already on the table this trick
 * @param {boolean}  view.heartsBroken
 * @param {number}   view.trickNumber   1-based
 * @param {string[]} view.seen          every card played this hand (incl. current trick)
 * @param {number}   [view.seatIndex]   our index into the seat-ordered arrays below
 * @param {string[][]} [view.taken]     cards each seat has captured this hand
 * @param {object[]} [view.voids]       per seat, `{ [suit]: true }` where they showed out
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
  const mem = readTable(view);
  // Few enough cards left to search it properly. Moon hands are excluded: the
  // search scores each seat's own points and has no notion of shooting.
  if (hard && !mem.moonRun && !mem.moonThreat) {
    const solved = endgame.solve(view, rng);
    if (solved) return solved;
  }
  const hand = view.hand || legal;
  const mySpades = bySuit(hand, 'S');
  // No Queen of our own and nothing above her to be caught by her: spades
  // cannot hurt us, so we are free to keep leading them until she falls.
  const safeBehindQueen = mem.queenLoose && !mySpades.some((c) => rankValue(c) > QUEEN_VALUE);
  // What we need a void for: the Queen, what she eats, and the hearts that are
  // too high to duck with. No burden, no reason to spend tempo chasing one.
  const burden = (hand.indexOf(QUEEN_OF_SPADES) >= 0 ? 2 : 0)
    + (mem.queenLoose ? mySpades.filter((c) => rankValue(c) > QUEEN_VALUE).length : 0)
    + bySuit(hand, 'H').filter((c) => rankValue(c) >= HIGH_HEART_VALUE).length;

  if (hard) {
    // Nothing on the table is worth more than the −10, and a J♦ that no
    // outstanding diamond can beat is a certain win — so this outranks even a
    // moon run, which wants to take the trick anyway. The one exception is a
    // table with no diamonds left at all: then it is three free discards on us.
    if (legal.indexOf(JACK_OF_DIAMONDS) >= 0
        && mem.higherOut(JACK_OF_DIAMONDS) === 0
        && mem.outstanding.D.length > 0) {
      return JACK_OF_DIAMONDS;
    }
    if (mem.moonRun) return highest(legal);
    // Somebody is running the whole hand: winning one heart trick ends it, and
    // a heart nothing can overtake wins for certain.
    if (mem.moonThreat) {
      const bossHearts = legal.filter((c) => isHeart(c) && mem.higherOut(c) === 0);
      if (bossHearts.length) return lowest(bossHearts);
    }
    // Flushing the Queen out is the strongest lead in the game — but only from
    // a hand that will not be left holding A♠/K♠ when it fails.
    if (mem.queenLoose && view.trickNumber >= 2) {
      const guards = bySuit(legal, 'S').filter((c) => rankValue(c) < QUEEN_VALUE);
      if (guards.length && mySpades.length >= 4 && safeBehindQueen) return highest(guards);
    }
  }

  // Leading the Queen or a high heart puts the points on the table ourselves,
  // and the card is too big to duck with — more often than not we win our own
  // trick and pocket them. The one read that makes it right: every card left
  // in the suit beats ours and somebody behind still has to follow, so the
  // trick is guaranteed to land on them.
  const dumpsOnSomebodyElse = (card) => {
    const suit = suitOf(card);
    return mem.outstanding[suit].length > 0
      && mem.lowerOut(card) === 0
      && mem.liveBehind(suit) > 0;
  };
  const recklessLead = (card) => {
    if (card !== QUEEN_OF_SPADES && !(isHeart(card) && rankValue(card) >= HIGH_HEART_VALUE)) return false;
    return !dumpsOnSomebodyElse(card);
  };
  // Shooting the moon already returned above, so anything left here is a hand
  // that only loses by leading these. A suit nobody behind can follow is no
  // alternative either — that trick is ours plus three free discards — so when
  // those are all we have left, hand the whole set back to the scorer.
  const safeLeads = legal.filter((c) => !recklessLead(c) && mem.liveBehind(suitOf(c)) > 0);
  const pool = safeLeads.length ? safeLeads : legal;

  const score = (card) => {
    const suit = suitOf(card);
    const value = rankValue(card);
    let s = value * 2; // lead low

    // Leading the A♠/K♠ into a loose Queen is asking for her: whoever holds
    // her plays her under us and we win 13. Only ever a last resort.
    if (suit === 'S' && mem.queenLoose && value > QUEEN_VALUE) s += 90;
    // Forced onto somebody else, the Queen is 13 points gone for certain and a
    // high heart is a free exit. Any other time they are ours to keep.
    const forcedOnThem = dumpsOnSomebodyElse(card);
    if (card === QUEEN_OF_SPADES) s += forcedOnThem ? -70 : 45;
    if (isHeart(card)) s += forcedOnThem ? 0 : 14;
    if (!hard) return s;

    // Early on, shortening a side suit buys the void we need to dump the Queen
    // or a fistful of hearts into. Later, length is what keeps a lead safe.
    const len = bySuit(hand, suit).length;
    if (suit !== 'S' && view.trickNumber <= 5) s += (len - 1) * 3;
    else s -= Math.min(len, 5) * 2;

    // The suit we are nearly out of is the one worth spending a lead on: once
    // we are void, every round of it becomes a free slot to bury the Queen or a
    // high heart in. Not in diamonds while the J♦ bonus is still in play.
    if (suit !== 'S' && burden > 0 && len <= 2 && view.trickNumber <= 8
        && !(suit === 'D' && (mem.holdJack || (mem.jackLoose && mem.catchers > 0)))) {
      s -= (len === 1 ? 34 : 17) + Math.min(burden, 3) * 5;
    }

    // Safe behind the Queen: she can never land on us in spades, and every
    // round drags her out of a hand that would otherwise drop her on us. Hold
    // A♠/K♠ instead and it's the reverse — each round burns one of our guards.
    if (suit === 'S' && mem.queenLoose && value < QUEEN_VALUE) s += safeBehindQueen ? -32 : 16;

    // A J♦ somebody can still beat is a −10 handed to whoever beats it. Sit on
    // it until the bigger diamonds are gone and the lead above cashes it.
    if (card === JACK_OF_DIAMONDS && mem.higherOut(card) > 0) s += 55;

    // Leading a suit the table has run out of just buys us three discards,
    // straight into our own trick.
    const out = mem.outstanding[suit].length;
    if (out === 0) s += 60;
    else if (out <= 2) s += 14;
    s += mem.voidCount(suit) * 16;

    // A card nothing can beat takes the trick, and the table pays us in hearts.
    if (out > 0 && mem.higherOut(card) === 0) s += 20;

    // A lead nobody can duck under cannot win the trick. That is a free exit,
    // and by the last few tricks winning one usually means winning the rest.
    if (out > 0 && mem.lowerOut(card) === 0) s -= view.trickNumber >= 8 ? 30 : 12;

    // Nearly three quarters of the Queens we eat are dumped on us by somebody
    // who ran out of the suit, so while she is loose every trick we might win
    // is a trick she can land in.
    if (mem.queenLoose && suit !== 'S' && mem.lowerOut(card) > 0) {
      s += mem.higherOut(card) === 0 ? 24 : 8;
    }

    if (suit === 'D' && value < JACK_VALUE) {
      if (mem.jackLoose && mem.catchers > 0) s -= 18;      // drag the bonus out
      else if (mem.jackLoose) s += 12;                     // no catcher: it's a gift
      else if (mem.holdJack && mem.higherOut(JACK_OF_DIAMONDS) > 0) s -= 14; // clear the way
    }
    return s;
  };

  const ranked = pool.slice().sort((a, b) => score(a) - score(b));
  // A little jitter between near-equal leads so two CPUs don't play identically.
  const best = score(ranked[0]);
  const ties = ranked.filter((c) => score(c) <= best + 1);
  return ties.length > 1 ? pick(ties, rng) : ranked[0];
}

function chooseFollow(view, legal, hard, rng) {
  const mem = readTable(view);
  if (hard && !mem.moonRun && !mem.moonThreat) {
    const solved = endgame.solve(view, rng);
    if (solved) return solved;
  }
  const trick = view.trick;
  const leadSuit = suitOf(trick[0]);
  const following = legal.every((c) => suitOf(c) === leadSuit);
  const isLast = trick.length === 3;
  const winnerValue = rankValue(trick[trickWinnerIndex(trick)]);
  const pot = trick.reduce((sum, c) => sum + pointsOf(c), 0);
  const jackInTrick = trick.indexOf(JACK_OF_DIAMONDS) >= 0;
  const queenInTrick = trick.indexOf(QUEEN_OF_SPADES) >= 0;
  // Being last is only a proxy for what we actually care about: that nobody
  // left to act can take the trick off us. A seat void in the led suit cannot
  // win it, so a table that has shown out counts as last just the same.
  const sealed = isLast || (hard && mem.liveBehind(leadSuit) === 0);

  if (following) {
    const under = legal.filter((c) => rankValue(c) < winnerValue);
    const over = legal.filter((c) => rankValue(c) >= winnerValue);
    if (hard && mem.moonRun) return highest(legal);
    // Our highest safe duck is sometimes the J♦ — handing somebody else the
    // −10 rather than spending a card we do not care about.
    const spare = (list) => {
      const rest = list.filter((c) => c !== JACK_OF_DIAMONDS);
      return rest.length ? rest : list;
    };
    // Last to act and already taking the trick: every winner costs us the same,
    // so spend the biggest — but never our own Queen, which would be +13 to us.
    const dump = (list) => {
      const safe = list.filter((c) => c !== QUEEN_OF_SPADES);
      return highest(safe.length ? safe : list);
    };

    // The Queen is a bomb. Hand her over the instant it can be done without
    // winning the trick — every extra turn she spends in our hand is a turn she
    // can be squeezed out onto us. Dropping her on a maybe costs more than it
    // saves, so this only fires when the trick is already beyond her.
    if (hard && legal.indexOf(QUEEN_OF_SPADES) >= 0 && QUEEN_VALUE < winnerValue) {
      return QUEEN_OF_SPADES;
    }

    // Taking the trick is GOOD when the Jack is in it and nothing else stings.
    if (jackInTrick && pot < 0 && over.length) return sealed ? dump(over) : highest(over);

    // Holding the Jack into a diamond trick we are going to win: cash it. Only
    // once it is certain — either nobody left can take it, or no bigger diamond
    // is still live.
    if (hard && legal.indexOf(JACK_OF_DIAMONDS) >= 0 && !queenInTrick
        && JACK_VALUE > winnerValue
        && (sealed || mem.higherOutToCome(JACK_OF_DIAMONDS) === 0)) {
      return JACK_OF_DIAMONDS;
    }

    // Nothing has topped the Jack in this diamond trick yet, so the last seat
    // can drop it and pocket the −10. Cover it with our cheapest catcher. Only
    // worth it with a single opponent left: with two behind us they simply play
    // over the top and the catcher is gone for nothing (measured +0.31 vs −0.25).
    if (hard && leadSuit === 'D' && trick.length === 2 && !queenInTrick
        && mem.jackLoose && winnerValue <= JACK_VALUE) {
      const catchers = legal.filter((c) => rankValue(c) > JACK_VALUE);
      if (catchers.length) return lowest(catchers);
    }

    // Break a moon run by taking the points ourselves while it is still cheap.
    if (hard && mem.moonThreat && sealed && pot > 0 && !queenInTrick && over.length) {
      return dump(over);
    }

    // Last in, nothing on the table to lose, and holding a card of this suit
    // nobody can beat. That master is a trick we will be forced to win sooner or
    // later; a trick that costs zero is the cheapest place it will ever go, and
    // spending it now keeps the low cards that duck us out of trouble at the end.
    if (hard && sealed && pot === 0) {
      const boss = highest(legal);
      // A♠/K♠ count too: they are not masters of the suit, but they are what
      // the Queen gets fed to, and a free trick is the only safe place to spend them.
      const mustGo = mem.higherOut(boss) === 0
        || (leadSuit === 'S' && mem.queenLoose && rankValue(boss) > QUEEN_VALUE);
      if (rankValue(boss) > winnerValue && mustGo
          && boss !== QUEEN_OF_SPADES && boss !== JACK_OF_DIAMONDS) {
        return boss;
      }
    }

    // Ducking as high as we safely can sheds our dangerous cards for free.
    if (under.length) return highest(spare(under));

    // Forced over the top: take it as cheaply as possible — and never with our
    // own Queen when we are the one who would end up eating her.
    let forced = spare(legal);
    if (hard && forced.length > 1 && (isLast || mem.higherOut(QUEEN_OF_SPADES) === 0)) {
      const safer = forced.filter((c) => c !== QUEEN_OF_SPADES);
      if (safer.length) forced = safer;
    }
    // Last to act with nothing that ducks: the trick is already ours whatever
    // we play, and every card left of this suit costs the same, so spend the
    // biggest one rather than nurse it into a trick we lose later.
    if (hard && sealed) return highest(forced);
    return lowest(forced);
  }

  // Void in the led suit: this is the moment to unload danger.
  // Unless we are running the table — then every point card has to come to us,
  // so the Queen and the hearts stay put and the cheapest junk goes instead.
  if (hard && mem.moonRun) {
    const junk = legal.filter((c) => pointsOf(c) === 0);
    return lowest(junk.length ? junk : legal);
  }
  if (legal.indexOf(QUEEN_OF_SPADES) >= 0) return QUEEN_OF_SPADES;
  const bigSpades = bySuit(legal, 'S').filter((c) => rankValue(c) > QUEEN_VALUE);
  // Once the Queen is gone, A♠/K♠ are ordinary cards — don't waste a discard.
  if (bigSpades.length && (!hard || mem.queenLoose)) return highest(bigSpades);

  const discardScore = (card) => {
    const value = rankValue(card);
    const suit = suitOf(card);
    let s = -value; // dump high
    if (isHeart(card)) s -= 10;
    if (card === JACK_OF_DIAMONDS) s += 100; // never throw the bonus away
    if (!hard) {
      if (suit === 'D' && value < JACK_VALUE) s += 6;
      return s;
    }
    // The Jack is still out there: Q♦/K♦/A♦ are what capture it, not junk.
    if (suit === 'D' && mem.jackLoose && value > JACK_VALUE) s += 45;
    // A card nothing can beat is a trick we will be forced to win later.
    if (mem.higherOut(card) === 0) s -= 22;
    // Low spades are the guards that let us duck a spade lead.
    if (suit === 'S' && mem.queenLoose && value < QUEEN_VALUE) s += 14;
    // Feeding a moon run is worse than sitting on a high card.
    if (isHeart(card) && mem.moonThreat) s += 26;
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
