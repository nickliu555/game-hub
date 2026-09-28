'use strict';

// Pure-logic unit tests for Hold'em Poker — evaluator, betting rules, pots,
// showdown and eliminations. No server, no network.
//   node scripts/test-holdempoker-engine.js   (or: npm run test:holdempoker)

const assert = require('assert');
const path = require('path');

const { bestHand, CATEGORY } = require(path.join('..', 'server', 'holdempoker', 'evaluator'));
const { chooseAction, chenScore } = require(path.join('..', 'server', 'holdempoker', 'bot'));
const G = require(path.join('..', 'server', 'holdempoker', 'game'));
const { Game, PHASES, blindsForLevel, START_STACK } = G;

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push({ name, err: e }); }
}

// ─────────────────────────── Harness ───────────────────────────

/**
 * A table with the given stacks, dealt and in BETTING. Seat i = 'p' + i.
 * @param {number[]} stacks
 * @param {{button?:number, holes?:string[][], board?:string[], handNumber?:number, handsPerLevel?:number, seed?:number}} [opts]
 */
function table(stacks, opts) {
  const o = opts || {};
  const g = new Game(o.seed || 7);
  g.manualTimers = true;
  stacks.forEach((_s, i) => g.addPlayer({ playerId: 'p' + i, name: 'P' + i, socketId: 's' + i }));
  if (o.handsPerLevel) g.handsPerLevel = o.handsPerLevel;
  const order = g.seatOrder();
  order.forEach((p, i) => { p.stack = stacks[i]; });
  g.handNumber = o.handNumber ? o.handNumber - 1 : 0;
  g.level = Math.floor(Math.max(0, g.handNumber - 1) / g.handsPerLevel);
  // _startHand moves the button one seat on, so point it at the seat before.
  const b = o.button || 0;
  g.buttonId = order[(b - 1 + order.length) % order.length].id;
  g._startHand();
  if (o.holes) order.forEach((p, i) => { if (o.holes[i]) p.hole = o.holes[i].slice(); });
  if (o.board) {
    const bd = o.board;
    // Popped from the end: burn, flop ×3, burn, turn, burn, river.
    g.deck = [bd[4], 'XX', bd[3], 'XX', bd[2], bd[1], bd[0], 'XX'];
  }
  assert.strictEqual(g.phase, PHASES.DEAL);
  g.tick();
  return g;
}

function id(i) { return 'p' + i; }
function P(g, i) { return g.players.get(id(i)); }

function act(g, i, type, amount) {
  const r = g.act({ playerId: id(i), type, amount });
  assert.ok(r.ok, 'P' + i + ' ' + type + (amount != null ? ' ' + amount : '') + ' failed: ' + JSON.stringify(r) + ' (turn=' + g.turnId + ')');
  return r;
}

/** Fire timers until the hand has resolved (HAND_END or FINAL). */
function toHandEnd(g) {
  let guard = 0;
  while (g.phase !== PHASES.HAND_END && g.phase !== PHASES.FINAL) {
    assert.ok(g.tick(), 'stalled in ' + g.phase + ' with turn ' + g.turnId);
    if (++guard > 50) throw new Error('runaway timers');
  }
}

/** Fire the street-pause timer so the next street is dealt. */
function nextStreet(g) {
  assert.ok(g.tick(), 'expected a street timer');
  assert.strictEqual(g.phase, PHASES.BETTING);
}

/** A closed round waits a beat before the showdown/runout; fire it. */
function afterPause(g) {
  assert.strictEqual(g.phase, PHASES.BETTING, 'still pausing on the closed round');
  assert.strictEqual(g.turnId, null);
  assert.ok(g.tick(), 'expected the pause timer');
}

function stacksTotal(g) {
  let n = 0;
  for (const p of g.players.values()) n += p.stack;
  return n;
}

// ─────────────────────────── Evaluator ───────────────────────────

test('evaluator: every category is named and ranked', () => {
  const cases = [
    [['AS', 'KS', 'QS', 'JS', '10S', '2D', '3C'], CATEGORY.STRAIGHT_FLUSH, 'Royal Flush'],
    [['9H', '8H', '7H', '6H', '5H', 'AD', 'AC'], CATEGORY.STRAIGHT_FLUSH, 'Straight Flush, Nine High'],
    [['7C', '7D', '7H', '7S', 'KD', '2C', '3D'], CATEGORY.QUADS, 'Four of a Kind, Sevens'],
    [['KC', 'KD', 'KH', '7S', '7D', '2C', '3D'], CATEGORY.FULL_HOUSE, 'Full House, Kings over Sevens'],
    [['AD', '9D', '6D', '4D', '2D', 'KS', 'QC'], CATEGORY.FLUSH, 'Flush, Ace High'],
    [['9C', '8D', '7H', '6S', '5D', '2C', '2D'], CATEGORY.STRAIGHT, 'Straight, Nine High'],
    [['QC', 'QD', 'QH', '7S', '4D', '2C', '9H'], CATEGORY.TRIPS, 'Three of a Kind, Queens'],
    [['KC', 'KD', '7H', '7S', '4D', '2C', '9H'], CATEGORY.TWO_PAIR, 'Two Pair, Kings and Sevens'],
    [['KC', 'KD', '8H', '7S', '4D', '2C', '9H'], CATEGORY.PAIR, 'Pair of Kings'],
    [['AC', 'JD', '8H', '7S', '4D', '2C', '9H'], CATEGORY.HIGH_CARD, 'Ace High'],
  ];
  let prev = Infinity;
  cases.forEach(([cards, cat, name]) => {
    const h = bestHand(cards);
    assert.strictEqual(h.category, cat, name + ' category');
    assert.strictEqual(h.name, name);
    assert.strictEqual(h.cards.length, 5);
    assert.ok(h.score < prev, name + ' must rank below the hand before it');
    prev = h.score;
  });
});

test('evaluator: the wheel is a five-high straight, below a six-high', () => {
  const wheel = bestHand(['AC', '2D', '3H', '4S', '5D', 'KC', 'QD']);
  assert.strictEqual(wheel.category, CATEGORY.STRAIGHT);
  assert.strictEqual(wheel.name, 'Straight, Five High');
  const six = bestHand(['6C', '2D', '3H', '4S', '5D', 'KC', 'QD']);
  assert.ok(six.score > wheel.score);
  const steel = bestHand(['AH', '2H', '3H', '4H', '5H', 'KC', 'QD']);
  assert.strictEqual(steel.name, 'Straight Flush, Five High');
});

test('evaluator: kickers break ties, identical best-fives split', () => {
  const board = ['KC', 'KD', '8H', '7S', '4D'];
  const aceKicker = bestHand(['AC', '2S'].concat(board));
  const queenKicker = bestHand(['QC', '2H'].concat(board));
  assert.ok(aceKicker.score > queenKicker.score);
  // Board plays: both hole pairs are lower than the board's best five.
  const royal = ['AS', 'KS', 'QS', 'JS', '10S'];
  assert.strictEqual(bestHand(['2C', '3D'].concat(royal)).score, bestHand(['4C', '5D'].concat(royal)).score);
  // Two pair: the fifth card decides.
  const tp = ['KC', 'KD', '7H', '7S', '2D'];
  assert.ok(bestHand(['AC', '3C'].concat(tp)).score > bestHand(['QC', '3H'].concat(tp)).score);
  // Flushes compare every card.
  const f1 = bestHand(['AD', 'JD', '9D', '6D', '3D', '2C', '4H']);
  const f2 = bestHand(['AD', 'JD', '9D', '6D', '2D', '3C', '4H']);
  assert.ok(f1.score > f2.score);
});

test('evaluator: six and seven cards pick the best five', () => {
  const h = bestHand(['2C', '3C', '4C', '5C', '9D', '6C']);
  assert.strictEqual(h.name, 'Straight Flush, Six High');
  assert.deepStrictEqual(h.cards.slice().sort(), ['2C', '3C', '4C', '5C', '6C'].sort());
});

// ─────────────────────────── Blinds ───────────────────────────

test('blinds: PokerStars ladder, then doubling', () => {
  assert.deepStrictEqual(blindsForLevel(0), { sb: 10, bb: 20 });
  assert.deepStrictEqual(blindsForLevel(1), { sb: 15, bb: 30 });
  assert.deepStrictEqual(blindsForLevel(3), { sb: 50, bb: 100 });
  assert.deepStrictEqual(blindsForLevel(18), { sb: 5000, bb: 10000 });
  assert.deepStrictEqual(blindsForLevel(19), { sb: 10000, bb: 20000 });
});

test('blinds: level rises every N hands and applies at the next hand', () => {
  const g = new Game(3);
  g.manualTimers = true;
  ['A', 'B', 'C'].forEach((n) => g.addPlayer({ playerId: n, name: n, socketId: n }));
  assert.ok(g.setHandsPerLevel(3).ok);
  assert.ok(!g.setHandsPerLevel(4).ok, '4 is not an option');
  g.start();
  const seen = [];
  for (let h = 1; h <= 7; h++) {
    assert.strictEqual(g.handNumber, h);
    seen.push(g.bb + (g.getTablePublic().levelUp ? '!' : ''));
    // Fold round to the big blind to end the hand fast.
    g.tick();
    while (g.phase === PHASES.BETTING) {
      const p = g.players.get(g.turnId);
      const toCall = g.currentBet - p.bet;
      g.act({ playerId: p.id, type: toCall > 0 ? 'fold' : 'check' });
      if (g.phase === PHASES.BETTING && !g.turnId) g.tick();
    }
    toHandEnd(g);
    g.tick();
  }
  assert.deepStrictEqual(seen, ['20', '20', '20', '30!', '30', '30', '50!']);
});

test('blinds: a level-up hand holds the deal so nobody acts under the Blinds up! banner', () => {
  const g = new Game(3);
  g.manualTimers = true;
  ['A', 'B', 'C'].forEach((n) => g.addPlayer({ playerId: n, name: n, socketId: n }));
  g.setHandsPerLevel(2);
  g.start();
  for (let h = 1; h <= 3; h++) {
    const hold = g.phaseEndsAt - Date.now();
    if (h === 3) {
      assert.ok(g.getTablePublic().levelUp, 'hand 3 opens a new level');
      assert.ok(hold > G.DEAL_DURATION_MS && hold <= G.LEVEL_UP_DEAL_MS, 'the deal is held for the banner');
    } else {
      assert.ok(hold <= G.DEAL_DURATION_MS, 'a normal deal is not held');
    }
    assert.strictEqual(g.phase, PHASES.DEAL);
    assert.strictEqual(g.act({ playerId: 'A', type: 'fold' }).reason, 'not-betting', 'no action before the deal is released');
    assert.strictEqual(g.pendingBots(), null, 'no CPU is armed during the deal');
    g.tick();
    while (g.phase === PHASES.BETTING) {
      const p = g.players.get(g.turnId);
      g.act({ playerId: p.id, type: g.currentBet - p.bet > 0 ? 'fold' : 'check' });
      if (g.phase === PHASES.BETTING && !g.turnId) g.tick();
    }
    toHandEnd(g);
    g.tick();
  }
});

test('blinds: handsToNextLevel counts the current hand', () => {
  const g = table([1500, 1500, 1500], { handNumber: 4, handsPerLevel: 5 });
  const t = g.getTablePublic();
  assert.strictEqual(t.handsToNextLevel, 2);
  assert.strictEqual(t.nextBigBlind, 30);
});

// ─────────────────────────── Positions ───────────────────────────

test('heads-up: the button posts the small blind and acts first preflop, last after', () => {
  const g = table([1500, 1500], { button: 0 });
  assert.strictEqual(g.buttonId, id(0));
  assert.strictEqual(g.sbId, id(0));
  assert.strictEqual(g.bbId, id(1));
  assert.strictEqual(P(g, 0).bet, 10);
  assert.strictEqual(P(g, 1).bet, 20);
  assert.strictEqual(g.turnId, id(0));
  act(g, 0, 'call');
  assert.strictEqual(g.turnId, id(1), 'big blind gets the option');
  act(g, 1, 'check');
  nextStreet(g);
  assert.strictEqual(g.board.length, 3);
  assert.strictEqual(g.turnId, id(1), 'big blind acts first after the flop');
});

test('ring: blinds left of the button, UTG opens, button closes postflop', () => {
  const g = table([1500, 1500, 1500, 1500], { button: 1 });
  assert.strictEqual(g.sbId, id(2));
  assert.strictEqual(g.bbId, id(3));
  assert.strictEqual(g.turnId, id(0), 'UTG is left of the big blind');
  act(g, 0, 'call'); act(g, 1, 'call'); act(g, 2, 'call');
  assert.strictEqual(g.turnId, id(3));
  act(g, 3, 'check');
  nextStreet(g);
  assert.strictEqual(g.turnId, id(2), 'first live seat left of the button acts first');
});

test('button moves one live seat per hand and skips the busted', () => {
  const g = table([1500, 1500, 1500, 1500], { button: 0 });
  P(g, 1).busted = true;
  g._startHand();
  assert.strictEqual(g.buttonId, id(2), 'seat 1 is out, so the button jumps to seat 2');
  assert.strictEqual(P(g, 1).inHand, false);
  assert.strictEqual(P(g, 1).hole.length, 0, 'the busted seat is not dealt in');
});

test('every live seat gets two unique cards', () => {
  const g = table([1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500]);
  const all = [];
  for (const p of g.players.values()) { assert.strictEqual(p.hole.length, 2); all.push.apply(all, p.hole); }
  assert.strictEqual(new Set(all).size, 16);
});

// ─────────────────────────── Betting rules ───────────────────────────

test('fold is refused when checking is free; check refused facing a bet', () => {
  const g = table([1500, 1500], { button: 0 });
  act(g, 0, 'call');
  const r = g.act({ playerId: id(1), type: 'fold' });
  assert.strictEqual(r.reason, 'can-check');
  act(g, 1, 'raise', 60);
  const c = g.act({ playerId: id(0), type: 'check' });
  assert.strictEqual(c.reason, 'must-call');
  assert.strictEqual(g.act({ playerId: id(1), type: 'check' }).reason, 'not-your-turn');
});

test('a raise must at least double the current bet', () => {
  const g = table([1500, 1500, 1500], { button: 0 });
  // UTG = button (3-handed). Min open is to 40 (double the 20 big blind).
  assert.strictEqual(g.act({ playerId: id(0), type: 'raise', amount: 39 }).reason, 'too-little');
  act(g, 0, 'raise', 60);
  const priv = g.getPrivate(id(1));
  assert.strictEqual(priv.minRaiseTo, 120, 'facing 60, the minimum raise is to 120');
  assert.strictEqual(g.act({ playerId: id(1), type: 'raise', amount: 119 }).reason, 'too-little');
  act(g, 1, 'raise', 200);
  assert.strictEqual(g.getPrivate(id(2)).minRaiseTo, 400);
  assert.strictEqual(g.act({ playerId: id(2), type: 'raise', amount: 1501 }).reason, 'too-much');
});

test('big blind 30, raise to 75: the next minimum raise is to 150', () => {
  const g = table([1500, 1500, 1500], { button: 0, handNumber: 5, handsPerLevel: 3 });
  assert.strictEqual(g.bb, 30);
  assert.strictEqual(g.getPrivate(id(0)).minRaiseTo, 60);
  act(g, 0, 'raise', 75);
  assert.strictEqual(g.getPrivate(id(1)).minRaiseTo, 150);
  assert.strictEqual(g.act({ playerId: id(1), type: 'raise', amount: 120 }).reason, 'too-little');
  assert.strictEqual(g.botView(id(1)).minRaiseTo, 150, 'CPUs see the same minimum');
});

test('an opening bet after the flop is at least the big blind, then raises double it', () => {
  const g = table([1500, 1500], { button: 0 });
  act(g, 0, 'call'); act(g, 1, 'check');
  nextStreet(g);
  const opener = g.players.get(g.turnId);
  assert.strictEqual(g.getPrivate(opener.id).minRaiseTo, 20);
  g.act({ playerId: opener.id, type: 'raise', amount: 60 });
  assert.strictEqual(g.getPrivate(g.turnId).minRaiseTo, 120);
});

test('a short all-in raise does not reopen the betting for those who already acted', () => {
  // Button p0 is UTG 3-handed; p1 SB has 140 total; p2 BB.
  const g = table([1000, 140, 1000], { button: 0 });
  act(g, 0, 'raise', 100);                      // full raise (at least double 20)
  act(g, 1, 'raise', 140);                      // all-in, short of 200: not a full raise
  assert.ok(P(g, 1).allIn);
  const bb = g.getPrivate(id(2));
  assert.strictEqual(bb.canRaise, true, 'the big blind has not acted yet, so it may raise');
  assert.strictEqual(bb.minRaiseTo, 280, 'and must still double the 140');
  act(g, 2, 'call');
  const opener = g.getPrivate(id(0));
  assert.strictEqual(opener.yourTurn, true);
  assert.strictEqual(opener.toCall, 40);
  assert.strictEqual(opener.canRaise, false, 'the opener may only call or fold');
  assert.strictEqual(g.act({ playerId: id(0), type: 'raise', amount: 400 }).reason, 'cannot-raise');
  act(g, 0, 'call');
  assert.strictEqual(g.turnId, null, 'betting closed');
});

test('a full re-raise reopens the betting', () => {
  const g = table([1000, 1000, 1000], { button: 0 });
  act(g, 0, 'raise', 100);
  act(g, 1, 'raise', 300);  // full: +200
  act(g, 2, 'fold');
  assert.strictEqual(g.getPrivate(id(0)).canRaise, true);
});

test('big blind option: everyone limps, BB may raise', () => {
  const g = table([1500, 1500, 1500], { button: 0 });
  act(g, 0, 'call'); act(g, 1, 'call');
  const bb = g.getPrivate(id(2));
  assert.ok(bb.yourTurn && bb.canCheck && bb.canRaise);
});

test('no raising once every opponent is all-in', () => {
  const g = table([1500, 300], { button: 0 });
  act(g, 0, 'raise', 1000);
  act(g, 1, 'call');     // all-in for 300
  afterPause(g);
  assert.strictEqual(g.phase, PHASES.RUNOUT);
});

test('a short big blind still makes the others call the full blind', () => {
  const g = table([1500, 1500, 15], { button: 0 });
  assert.ok(P(g, 2).allIn);
  assert.strictEqual(g.currentBet, 20);
  assert.strictEqual(g.getPrivate(id(0)).toCall, 20);
});

// ─────────────────────────── Pots ───────────────────────────

test('all-in caller only wins what they matched; the rest of the bet comes back', () => {
  // Button p0 has 2000; p1 BB has only 300.
  const g = table([2000, 300], {
    button: 0,
    holes: [['7C', '2D'], ['AH', 'AD']],
    board: ['3S', '8D', '9H', 'JS', '4C'],
  });
  act(g, 0, 'raise', 1000);
  act(g, 1, 'call');
  assert.strictEqual(P(g, 0).stack, 1700, '700 uncalled goes straight back');
  toHandEnd(g);
  assert.strictEqual(g.result.pots.length, 1);
  assert.strictEqual(g.result.pots[0].amount, 600);
  assert.strictEqual(P(g, 1).stack, 600, 'the short stack can win at most 2 × 300');
  assert.strictEqual(P(g, 0).stack, 1700);
  assert.deepStrictEqual(g.result.uncalled, [{ playerId: id(0), name: 'P0', amount: 700 }]);
  assert.strictEqual(stacksTotal(g), 2300);
});

test('three-way all-in: main pot, side pot, and the covering stack refunded', () => {
  // Seats: A=p0 200, B=p1 500, C=p2 1000. Button C → A small blind, B big blind, C opens.
  const g = table([200, 500, 1000], {
    button: 2,
    holes: [['AH', 'AD'], ['2H', '2D'], ['KH', 'KD']],
    board: ['3C', '8D', '9H', 'JS', '4D'],
  });
  assert.strictEqual(g.turnId, id(2));
  act(g, 2, 'raise', 1000);
  act(g, 0, 'call');
  act(g, 1, 'call');
  toHandEnd(g);
  const pots = g.result.pots;
  assert.strictEqual(pots.length, 2);
  assert.strictEqual(pots[0].amount, 600);
  assert.deepStrictEqual(pots[0].eligible.slice().sort(), [id(0), id(1), id(2)]);
  assert.strictEqual(pots[1].amount, 600);
  assert.deepStrictEqual(pots[1].eligible.slice().sort(), [id(1), id(2)]);
  assert.strictEqual(pots[0].winners[0].playerId, id(0), 'aces take the main pot');
  assert.strictEqual(pots[1].winners[0].playerId, id(2), 'kings take the side pot the aces are not in');
  assert.strictEqual(P(g, 0).stack, 600);
  assert.strictEqual(P(g, 1).stack, 0);
  assert.strictEqual(P(g, 2).stack, 1100);
  assert.strictEqual(g.result.uncalled[0].amount, 500);
  assert.strictEqual(stacksTotal(g), 1700);
});

test('side pots are paid one at a time: the hand-end hold grows by a step per extra pot', () => {
  const g = table([200, 500, 1000], {
    button: 2,
    holes: [['AH', 'AD'], ['2H', '2D'], ['KH', 'KD']],
    board: ['3C', '8D', '9H', 'JS', '4D'],
  });
  act(g, 2, 'raise', 1000);
  act(g, 0, 'call');
  act(g, 1, 'call');
  toHandEnd(g);
  const r = g.getHandEndPublic().result;
  assert.strictEqual(r.pots.length, 2);
  assert.strictEqual(r.awardMs, G.POT_AWARD_MS);
  assert.ok(Math.abs(r.awardFrom - (Date.now() + G.AWARD_LEAD_MS)) < 200, 'the first pot is paid after a short lead');
  const hold = g.phaseEndsAt - Date.now();
  const expected = G.SHOWDOWN_MS + G.POT_AWARD_MS + G.BUST_EXTRA_MS;
  assert.ok(Math.abs(hold - expected) < 200, 'hold ' + hold + ' ≈ ' + expected);
  const ko = r.knockoutAt - Date.now();
  assert.ok(Math.abs(ko - (G.SHOWDOWN_MS + G.POT_AWARD_MS)) < 200, 'the knockout plays once the showdown pause is over');

  const single = table([1500, 1500], {
    button: 0,
    holes: [['AH', 'AD'], ['2H', '2D']],
    board: ['3C', '8D', '9H', 'JS', '4D'],
  });
  act(single, 0, 'raise', 1500);
  act(single, 1, 'call');
  toHandEnd(single);
  assert.strictEqual(single.result.pots.length, 1);
  assert.strictEqual(single.result.awardFrom, undefined, 'a single pot pays all at once');
});

test('folded chips stay in the pot but the folder cannot win', () => {
  const g = table([1500, 1500, 1500], {
    button: 0,
    holes: [['AH', 'AD'], ['2H', '7D'], ['KH', 'KD']],
    board: ['3C', '8D', '9H', 'JS', '4D'],
  });
  act(g, 0, 'raise', 100);
  act(g, 1, 'call');
  act(g, 2, 'raise', 300);
  act(g, 0, 'call');
  act(g, 1, 'fold');           // 100 dead
  nextStreet(g);
  for (let s = 0; s < 3; s++) {
    act(g, 2, 'check'); act(g, 0, 'check');
    if (s < 2) nextStreet(g);
  }
  afterPause(g);
  assert.strictEqual(g.phase, PHASES.HAND_END);
  assert.strictEqual(g.result.pots.length, 1);
  assert.strictEqual(g.result.pots[0].amount, 700);
  assert.ok(g.result.pots[0].eligible.indexOf(id(1)) < 0);
  assert.strictEqual(P(g, 0).stack, 1500 - 300 + 700);
  assert.strictEqual(stacksTotal(g), 4500);
});

test('split pot: the odd chip goes to the first winner left of the button', () => {
  // Hand 6 → level 2 blinds 15/30. Button p0, SB p1, BB p2.
  const g = table([1500, 1500, 1500], {
    button: 0,
    handNumber: 6,
    holes: [['2C', '3D'], ['4C', '5D'], ['6C', '7D']],
    board: ['AS', 'KS', 'QS', 'JS', '10S'],
  });
  assert.strictEqual(g.bb, 30);
  act(g, 0, 'call');     // 30
  act(g, 1, 'fold');     // 15 dead
  act(g, 2, 'check');
  for (let s = 0; s < 3; s++) {
    nextStreet(g);
    act(g, 2, 'check'); act(g, 0, 'check');
  }
  afterPause(g);
  assert.strictEqual(g.phase, PHASES.HAND_END);
  const pot = g.result.pots[0];
  assert.strictEqual(pot.amount, 75);
  assert.strictEqual(pot.winners.length, 2);
  const byId = {};
  pot.winners.forEach((w) => { byId[w.playerId] = w.amount; });
  assert.strictEqual(byId[id(2)], 38, 'seat left of the button (after the folded SB) gets the odd chip');
  assert.strictEqual(byId[id(0)], 37);
  assert.strictEqual(pot.handName, 'Royal Flush');
});

test('uncontested: last player standing wins without showing', () => {
  const g = table([1500, 1500, 1500], { button: 0 });
  act(g, 0, 'raise', 100);
  act(g, 1, 'fold');
  act(g, 2, 'fold');
  assert.strictEqual(g.phase, PHASES.HAND_END);
  assert.strictEqual(g.result.type, 'fold');
  assert.strictEqual(P(g, 0).stack, 1500 + 10 + 20);
  assert.strictEqual(g.result.uncalled[0].amount, 80, 'the unmatched part of the raise returns');
  assert.strictEqual(g.result.shown.length, 0);
  assert.strictEqual(g.getTablePublic().seats[0].cards, null);
  // …but may choose to.
  assert.strictEqual(g.showCards(id(1)).reason, 'cannot-show');
  assert.ok(g.showCards(id(0)).ok);
  assert.deepStrictEqual(g.getHandEndPublic().seats[0].cards, P(g, 0).hole);
  assert.strictEqual(g.showCards(id(0)).reason, 'already-shown');
});

// ─────────────────────────── Showdown ───────────────────────────

test('showdown: river aggressor shows first; a beaten caller mucks', () => {
  const g = table([1500, 1500], {
    button: 0,
    holes: [['AH', 'AD'], ['2H', '7C']],
    board: ['3C', '8D', '9H', 'JS', '4D'],
  });
  act(g, 0, 'call'); act(g, 1, 'check');
  for (let s = 0; s < 2; s++) { nextStreet(g); act(g, 1, 'check'); act(g, 0, 'check'); }
  nextStreet(g);
  act(g, 1, 'check');
  act(g, 0, 'raise', 40);   // button bets the river
  act(g, 1, 'call');
  // The final call sits a beat (bets swept, nothing revealed yet) before the showdown.
  assert.strictEqual(g.result, null);
  assert.deepStrictEqual(g.getTablePublic().lastCollect.bets, { [id(0)]: 40, [id(1)]: 40 });
  assert.ok(g.getTablePublic().seats.every((s) => s.cards === null), 'no cards flip during the pause');
  afterPause(g);
  assert.strictEqual(g.phase, PHASES.HAND_END);
  assert.deepStrictEqual(g.result.shown.map((s) => s.playerId), [id(0)]);
  assert.deepStrictEqual(g.result.mucked, [id(1)]);
  const pub = JSON.stringify(g.getHandEndPublic());
  assert.ok(pub.indexOf('"7C"') < 0 && pub.indexOf('"2H"') < 0, 'mucked cards never leave the server');
});

test('showdown: with no river bet the first seat left of the button shows; the winner always shows', () => {
  const g = table([1500, 1500, 1500], {
    button: 0,
    holes: [['2H', '7C'], ['KH', 'KD'], ['AH', 'AD']],
    board: ['3C', '8D', '9H', 'JS', '4D'],
  });
  act(g, 0, 'call'); act(g, 1, 'call'); act(g, 2, 'check');
  for (let s = 0; s < 3; s++) {
    nextStreet(g);
    act(g, 1, 'check'); act(g, 2, 'check'); act(g, 0, 'check');
  }
  afterPause(g);
  // P1 (left of button) shows first, P2 beats it and shows, P0 is beaten → mucks.
  assert.deepStrictEqual(g.result.shown.map((s) => s.playerId), [id(1), id(2)]);
  assert.deepStrictEqual(g.result.mucked, [id(0)]);
  assert.strictEqual(g.result.pots[0].winners[0].playerId, id(2));
  assert.strictEqual(g.result.pots[0].handName, 'Pair of Aces');
});

test('all-in runout: every live hand is flipped before the board is dealt', () => {
  const g = table([1500, 1500, 1500], { button: 0 });
  act(g, 0, 'raise', 1500);
  act(g, 1, 'call');
  act(g, 2, 'fold');
  assert.ok(g.getTablePublic().seats.every((s) => s.cards === null), 'hands stay down through the pause');
  afterPause(g);
  assert.strictEqual(g.phase, PHASES.RUNOUT);
  const seats = g.getTablePublic().seats;
  assert.ok(seats[0].cards && seats[1].cards, 'both all-in hands are face up');
  assert.strictEqual(seats[2].cards, null, 'the folded hand stays hidden');
  assert.strictEqual(g.board.length, 0);
  g.tick(); assert.strictEqual(g.board.length, 3);
  g.tick(); assert.strictEqual(g.board.length, 4);
  g.tick(); assert.strictEqual(g.board.length, 5);
  g.tick();
  assert.strictEqual(g.phase, PHASES.HAND_END);
  assert.strictEqual(g.result.shown.length, 2);
});

// ─────────────────────────── Pre-actions ───────────────────────────

test('pre-actions: check/fold checks when free, folds facing a bet; call-any calls', () => {
  const g = table([1500, 1500, 1500], { button: 0 });
  // Turn: p0. Queue p1 check/fold and p2 call-any.
  assert.ok(g.setPreAction(id(1), 'checkFold').ok);
  assert.ok(g.setPreAction(id(2), 'callAny').ok);
  assert.strictEqual(g.setPreAction(id(0), 'callAny').reason, 'your-turn');
  assert.strictEqual(g.setPreAction(id(1), 'bogus').reason, 'bad-pre-action');
  act(g, 0, 'raise', 200);
  assert.strictEqual(g.turnId, id(1));
  assert.ok(g.tick(), 'the pre-action timer is armed');
  assert.ok(P(g, 1).folded, 'check/fold folds to a raise');
  assert.strictEqual(g.turnId, id(2));
  g.tick();
  assert.strictEqual(P(g, 2).committed, 200, 'call-any calls the raise');
  assert.strictEqual(P(g, 2).preAction, null, 'a pre-action fires once');
});

test('pre-actions: cleared at the end of each street', () => {
  const g = table([1500, 1500, 1500], { button: 0 });
  act(g, 0, 'call');
  g.setPreAction(id(2), 'checkFold');
  act(g, 1, 'call');
  g.tick(); // BB check/folds → checks
  assert.strictEqual(P(g, 2).folded, false);
  nextStreet(g);
  g.setPreAction(id(0), 'callAny');
  act(g, 1, 'check');
  act(g, 2, 'check');
  g.tick(); // p0 call-any → checks
  nextStreet(g);
  assert.strictEqual(P(g, 0).preAction, null);
});

test('a human on turn with no pre-action: nothing is armed, the table waits', () => {
  const g = table([1500, 1500], { button: 0 });
  g.markDisconnected('s0');
  assert.strictEqual(g.turnId, id(0));
  assert.strictEqual(g.tick(), false, 'no timer will ever act for them');
  assert.strictEqual(g.getTablePublic().waitingOn, 'P0');
});

// ─────────────────────────── Eliminations ───────────────────────────

test('eliminations: simultaneous busts rank by starting stack; last stack standing wins', () => {
  const g = table([1000, 300, 200], {
    button: 0,
    holes: [['AH', 'AD'], ['2H', '7C'], ['3H', '8C']],
    board: ['KC', 'QD', '9H', 'JS', '4D'],
  });
  act(g, 0, 'raise', 1000);
  act(g, 1, 'call');
  act(g, 2, 'call');
  toHandEnd(g);
  assert.ok(g.result.gameOver);
  assert.strictEqual(P(g, 1).place, 2, '300 start beats 200 start');
  assert.strictEqual(P(g, 2).place, 3);
  assert.strictEqual(P(g, 0).place, 1);
  assert.deepStrictEqual(g.result.busted.map((b) => b.place), [2, 3]);
  g.tick();
  assert.strictEqual(g.phase, PHASES.FINAL);
  const fin = g.getFinalPublic();
  assert.strictEqual(fin.winnerId, id(0));
  assert.deepStrictEqual(fin.standings.map((s) => s.place), [1, 2, 3]);
});

test('eliminations: equal starting stacks share the place', () => {
  const g = table([1000, 200, 200, 1000], {
    button: 0,
    holes: [['AH', 'AD'], ['2H', '7C'], ['3H', '8C'], ['4S', '9S']],
    board: ['KC', 'QD', '9H', 'JS', '4D'],
  });
  // Button p0, SB p1, BB p2, UTG p3.
  act(g, 3, 'fold');
  act(g, 0, 'raise', 1000);
  act(g, 1, 'call');
  act(g, 2, 'call');
  toHandEnd(g);
  assert.strictEqual(P(g, 1).place, 3);
  assert.strictEqual(P(g, 2).place, 3);
  assert.ok(!g.result.gameOver);
});

// ─────────────────────────── Secrecy & privacy ───────────────────────────

test('public snapshots never carry an unshown hole card', () => {
  const g = table([1500, 1500, 1500, 1500]);
  const pub = JSON.stringify(g.getTablePublic());
  for (const p of g.players.values()) {
    for (const c of p.hole) assert.ok(pub.indexOf('"' + c + '"') < 0, 'leaked ' + c);
  }
  const mine = g.getPrivate(id(0));
  assert.deepStrictEqual(mine.hole, P(g, 0).hole);
});

// ─────────────────────────── CPU ───────────────────────────

test('bot: Chen scores the classic anchors', () => {
  assert.strictEqual(chenScore(['AS', 'AD']), 20);
  assert.strictEqual(chenScore(['AS', 'KS']), 12);
  assert.strictEqual(chenScore(['2S', '2D']), 5);
  assert.strictEqual(chenScore(['7C', '2D']), -1);
});

test('bot: never returns fold when checking is free', () => {
  const view = {
    hole: ['7C', '2D'], board: [], street: 'preflop', stack: 1480, bet: 20, toCall: 0, callAmount: 0,
    currentBet: 20, canCheck: true, canRaise: true, minRaiseTo: 40, maxRaiseTo: 1500, pot: 40, bigBlind: 20, opponents: 2,
  };
  for (let i = 0; i < 50; i++) assert.notStrictEqual(chooseAction(view, Math.random).type, 'fold');
});

// ─────────────────────────── Stats ───────────────────────────

test('stats: decisions, VPIP/PFR, wins and showdowns are tallied (blinds never count)', () => {
  const g = new Game(8);
  g.manualTimers = true;
  ['A', 'B', 'C'].forEach((n) => g.addPlayer({ playerId: n, name: n, socketId: n }));
  g.start();
  g.tick();
  // Preflop: the first actor min-raises, everyone else calls; then check it down.
  const raiser = g.turnId;
  let guard = 0;
  while (g.phase !== PHASES.HAND_END) {
    if (++guard > 60) throw new Error('hand never ended');
    if (g.phase !== PHASES.BETTING || !g.turnId) { g.tick(); continue; }
    const p = g.players.get(g.turnId);
    const toCall = g.currentBet - p.bet;
    if (g.street === 'preflop' && p.id === raiser && !p.stats.raises) {
      assert.ok(g.act({ playerId: p.id, type: 'raise', amount: g._raiseLimits(p).min }).ok);
    } else {
      assert.ok(g.act({ playerId: p.id, type: toCall > 0 ? 'call' : 'check' }).ok);
    }
  }
  const st = {};
  g.getHandEndPublic().stats.forEach((r) => { st[r.playerId] = r; });
  const winners = g.result.winners;
  ['A', 'B', 'C'].forEach((id) => {
    const r = st[id];
    const raw = g.players.get(id).stats;
    assert.strictEqual(r.hands, 1);
    assert.strictEqual(r.vpip, 100, id + ' put chips in voluntarily');
    assert.strictEqual(r.pfr, id === raiser ? 100 : 0);
    assert.strictEqual(raw.raises, id === raiser ? 1 : 0);
    assert.strictEqual(raw.folds, 0);
    assert.strictEqual(r.showdowns, 1);
    assert.strictEqual(r.handsWon, winners.indexOf(id) >= 0 ? 1 : 0);
    assert.strictEqual(r.showdownsWon, r.handsWon);
    assert.ok(r.foldPct + r.checkPct + r.callPct + r.raisePct >= 98, 'action mix covers every decision');
  });
  const paid = winners.reduce((a, id) => a + st[id].biggestPot, 0);
  assert.strictEqual(paid, 120, 'the winners record their share of the 3 × 40 pot');
});

test('stats: a fold-around counts folds, no VPIP, and an uncontested win (no showdown)', () => {
  const g = new Game(4);
  g.manualTimers = true;
  ['A', 'B', 'C'].forEach((n) => g.addPlayer({ playerId: n, name: n, socketId: n }));
  g.start();
  g.tick();
  while (g.phase === PHASES.BETTING) g.act({ playerId: g.turnId, type: 'fold' });
  const bb = g.bbId;
  const st = {};
  g.getHandEndPublic().stats.forEach((r) => { st[r.playerId] = r; });
  Object.keys(st).forEach((id) => {
    assert.strictEqual(st[id].vpip, 0, 'posting a blind is not VPIP');
    assert.strictEqual(st[id].showdowns, 0);
    assert.strictEqual(st[id].foldPct, id === bb ? null : 100);
  });
  assert.strictEqual(st[bb].handsWon, 1);
  assert.strictEqual(st[bb].wonPct, 100);
  assert.strictEqual(st[bb].biggestPot, 20, 'the uncalled part of the big blind came back first');
});

test('stats reset when a new tournament starts', () => {
  const g = new Game(4);
  g.manualTimers = true;
  ['A', 'B'].forEach((n) => g.addPlayer({ playerId: n, name: n, socketId: n }));
  g.start();
  g.tick();
  g.act({ playerId: g.turnId, type: 'fold' });
  assert.ok(g.getHandEndPublic().stats.some((r) => r.handsWon === 1));
  g._resetGameState();
  g.start();
  g.getTablePublic().stats.forEach((r) => {
    assert.strictEqual(r.hands, 1);
    assert.strictEqual(r.handsWon, 0);
    assert.strictEqual(r.foldPct, null);
  });
});

// ─────────────────────────── Full tournament ───────────────────────────

test('CPU bluffs: junk checked to heads-up bets some of the time, but gives up to a big bet', () => {
  const junk = {
    hole: ['7C', '2D'], board: ['KH', 'QS', '9S'], street: 'flop', stack: 1400, bet: 0, toCall: 0, callAmount: 0,
    currentBet: 0, canCheck: true, canRaise: true, minRaiseTo: 20, maxRaiseTo: 1400, pot: 200,
    smallBlind: 10, bigBlind: 20, opponents: 1,
  };
  let bets = 0;
  for (let i = 0; i < 400; i++) {
    const a = chooseAction(junk, Math.random);
    assert.ok(a.type === 'check' || a.type === 'raise', 'never folds when it can check');
    if (a.type === 'raise') bets++;
  }
  assert.ok(bets > 400 * 0.15 && bets < 400 * 0.6, 'bluffs a fair share of the time, not always (' + bets + '/400)');

  const facingShove = Object.assign({}, junk, {
    canCheck: false, toCall: 900, callAmount: 900, currentBet: 900, canRaise: true, minRaiseTo: 1400, pot: 1100,
  });
  let folds = 0;
  for (let i = 0; i < 400; i++) if (chooseAction(facingShove, Math.random).type === 'fold') folds++;
  assert.ok(folds > 400 * 0.8, 'junk mostly folds to an overbet (' + folds + '/400)');
});

test('CPU think time: a beat for checks/folds, longer before raising or a big call', () => {
  const { thinkDelay, BOT_SETTINGS: S } = require(path.join('..', 'server', 'holdempoker', 'bot'));
  const view = { stack: 1000, callAmount: 0 };
  for (let i = 0; i < 50; i++) {
    const quick = thinkDelay({ type: 'check' }, view, Math.random);
    assert.ok(quick >= S.thinkMs && quick < S.thinkMs + S.jitterMs, 'check waits ' + quick + 'ms');
    assert.ok(thinkDelay({ type: 'raise', amount: 60 }, view, Math.random) >= S.thinkMs + S.aggressiveExtraMs);
  }
  const small = thinkDelay({ type: 'call' }, { stack: 1000, callAmount: 50 }, () => 0);
  const big = thinkDelay({ type: 'call' }, { stack: 1000, callAmount: 600 }, () => 0);
  assert.strictEqual(small, S.thinkMs);
  assert.strictEqual(big, S.thinkMs + S.bigCallExtraMs);
});

// ─────────────────────────── Full tournament ───────────────────────────

test('a whole CPU tournament plays to a single winner with every chip accounted for', () => {
  const { chooseAction: choose } = require(path.join('..', 'server', 'holdempoker', 'bot'));
  const g = new Game(99);
  g.manualTimers = true;
  for (let i = 0; i < 6; i++) g.addBot();
  g.setHandsPerLevel(3);
  g.start();
  const total = START_STACK * 6;
  let steps = 0;
  while (g.phase !== PHASES.FINAL) {
    if (++steps > 200000) throw new Error('tournament never ended');
    if (g.phase === PHASES.BETTING && g.turnId) {
      const view = g.botView(g.turnId);
      const choice = choose(view, g.rng);
      if (choice.type === 'raise') {
        const a = choice.amount;
        assert.ok(a === view.minRaiseTo || a === view.maxRaiseTo || a % view.smallBlind === 0,
          'CPU raise to ' + a + ' is not something a player could dial in (step ' + view.smallBlind + ')');
      }
      const r = g.act(Object.assign({ playerId: g.turnId }, choice));
      assert.ok(r.ok, 'bot made an illegal move: ' + JSON.stringify(r));
    } else {
      assert.ok(g.tick(), 'stalled in ' + g.phase);
    }
    if (g.phase === PHASES.HAND_END && g.lastEvent.type === 'handEnd') {
      assert.strictEqual(stacksTotal(g), total, 'chips conserved at hand ' + g.handNumber);
    }
  }
  const fin = g.getFinalPublic();
  assert.strictEqual(fin.standings[0].stack, total);
  assert.deepStrictEqual(fin.standings.map((s) => s.place), [1, 2, 3, 4, 5, 6]);
});

test('chip audit: every hand of many random tournaments pays out exactly right', () => {
  const { chooseAction: choose } = require(path.join('..', 'server', 'holdempoker', 'bot'));
  let hands = 0;
  let sidePotHands = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const g = new Game(seed * 7919);
    g.manualTimers = true;
    const seats = 2 + (seed % 7);
    for (let i = 0; i < seats; i++) g.addBot();
    g.setHandsPerLevel(2);
    g.start();
    const total = START_STACK * seats;
    let r = seed;
    const rand = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
    let audited = 0;
    let steps = 0;
    while (g.phase !== PHASES.FINAL) {
      if (++steps > 300000) throw new Error('seed ' + seed + ' never ended');
      if (g.phase === PHASES.BETTING && g.turnId) {
        const v = g.botView(g.turnId);
        let choice = choose(v, g.rng);
        // Half the time a random legal move instead, to reach odd all-in / side-pot shapes.
        if (rand() < 0.5) {
          const x = rand();
          if (v.canRaise && x < 0.35) choice = { type: 'raise', amount: x < 0.15 ? v.maxRaiseTo : v.minRaiseTo + Math.floor(rand() * (v.maxRaiseTo - v.minRaiseTo + 1)) };
          else if (v.canCheck) choice = { type: 'check' };
          else choice = { type: x < 0.6 ? 'call' : 'fold' };
        }
        const res = g.act(Object.assign({ playerId: g.turnId }, choice));
        assert.ok(res.ok, 'illegal move ' + JSON.stringify(choice) + ': ' + JSON.stringify(res));
        continue;
      }
      assert.ok(g.tick(), 'stalled in ' + g.phase);
      if (g.phase !== PHASES.HAND_END || audited === g.handNumber) continue;
      audited = g.handNumber;
      hands++;
      const res = g.result;
      const tag = 'seed ' + seed + ' hand ' + g.handNumber + ': ';
      const inHand = g.seatOrder().filter((p) => p.inHand);
      assert.strictEqual(stacksTotal(g), total, tag + 'chips conserved');
      const committed = inHand.reduce((a, p) => a + p.committed, 0);
      const potSum = res.pots.reduce((a, p) => a + p.amount, 0);
      assert.strictEqual(potSum, committed, tag + 'the pots hold exactly what was put in (uncalled chips excluded)');
      if (res.pots.length > 1) sidePotHands++;
      const won = {};
      res.pots.forEach((pot, i) => {
        const paid = pot.winners.reduce((a, w) => a + w.amount, 0);
        assert.strictEqual(paid, pot.amount, tag + 'pot ' + i + ' is paid out in full');
        pot.winners.forEach((w) => { won[w.playerId] = (won[w.playerId] || 0) + w.amount; });
        if (res.type === 'showdown') {
          const score = (id) => { const p = g.players.get(id); return bestHand(p.hole.concat(g.board)).score; };
          const best = Math.max.apply(null, pot.eligible.map(score));
          pot.winners.forEach((w) => {
            assert.ok(pot.eligible.indexOf(w.playerId) >= 0, tag + 'pot ' + i + ' winner was eligible');
            assert.strictEqual(score(w.playerId), best, tag + 'pot ' + i + ' went to the best eligible hand');
          });
          const shares = pot.winners.map((w) => w.amount);
          assert.ok(Math.max.apply(null, shares) - Math.min.apply(null, shares) <= 1, tag + 'a split differs by at most the odd chip');
        }
      });
      inHand.forEach((p) => {
        const w = won[p.id] || 0;
        assert.strictEqual(p.stack, p.startStack - p.committed + w, tag + p.name + ': stack = start − put in + won');
        // Nobody wins more from an opponent than they themselves put in.
        const cap = inHand.reduce((a, q) => a + Math.min(p.committed, q.committed), 0);
        assert.ok(w <= cap, tag + p.name + ' won ' + w + ' but could win at most ' + cap);
        if (p.folded) assert.strictEqual(w, 0, tag + 'a folded player wins nothing');
        const back = res.uncalled.filter((u) => u.playerId === p.id).reduce((a, u) => a + u.amount, 0);
        assert.strictEqual(g.getPrivate(p.id).collected, w ? w + back : 0, tag + p.name + ': collected = won + returned bet');
      });
    }
  }
  assert.ok(hands > 200, 'audited ' + hands + ' hands');
  assert.ok(sidePotHands > 10, 'side pots came up ' + sidePotHands + ' times');
});

// ─────────────────────────── Report ───────────────────────────

if (failures.length) {
  failures.forEach((f) => { console.log('✗ ' + f.name + '\n    ' + (f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 3).join('\n    ') : f.err)); });
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(1);
}
console.log('✓ holdempoker engine: ' + passed + ' tests passed');
