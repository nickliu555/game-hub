'use strict';

// Pure-logic unit tests for Liar's Dice — bid legality (Perudo 1s rules),
// wild counting, BS / Spot On outcomes, knockouts, the next opener and the
// CPU player. No server, no network.
//   node scripts/test-liarsdice-engine.js   (or: npm run test:liarsdice)

const assert = require('assert');
const path = require('path');

const G = require(path.join('..', 'server', 'liarsdice', 'game'));
const { chooseAction } = require(path.join('..', 'server', 'liarsdice', 'bot'));
const { Game, PHASES, minQtyFor, countFace } = G;

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push({ name, err: e }); }
}

/** A started game in BIDDING with fixed dice. Seat i = 'p' + i; `opener` is a seat index. */
function table(dice, opts) {
  const o = opts || {};
  const g = new Game(o.seed || 11);
  g.manualTimers = true;
  dice.forEach((_d, i) => g.addPlayer({ playerId: 'p' + i, name: 'P' + i, socketId: 's' + i }));
  if (o.startDice) g.setStartDice(o.startDice);
  g.start();
  const order = g.seatOrder();
  order.forEach((p, i) => { p.dice = dice[i].slice(); p.diceCount = dice[i].length; });
  g.openerId = order[o.opener || 0].id;
  g.tick(); // roll → bidding
  assert.strictEqual(g.phase, PHASES.BIDDING);
  // Each bid locks the next turn behind the host's pop-up; open it straight away so rules can be stepped through.
  const act = g.act.bind(g);
  g.act = (a) => { const res = act(a); if (res.ok && g.turnLocked) g.tick(); return res; };
  return g;
}

// ─────────────────────────── Bid legality ───────────────────────────

test('opening bid: any quantity of any face, 1s included', () => {
  for (let f = 1; f <= 6; f++) assert.strictEqual(minQtyFor(null, f, 10), 1);
});

test('raise: more dice, or same count of a higher face', () => {
  const prev = { qty: 4, face: 3 };
  assert.strictEqual(minQtyFor(prev, 2, 20), 5);
  assert.strictEqual(minQtyFor(prev, 3, 20), 5);
  assert.strictEqual(minQtyFor(prev, 4, 20), 4);
  assert.strictEqual(minQtyFor(prev, 6, 20), 4);
});

test('switching to 1s needs half, rounded up', () => {
  assert.strictEqual(minQtyFor({ qty: 5, face: 4 }, 1, 20), 3);
  assert.strictEqual(minQtyFor({ qty: 6, face: 4 }, 1, 20), 3);
  assert.strictEqual(minQtyFor({ qty: 1, face: 6 }, 1, 20), 1);
});

test('raising 1s needs more 1s; switching off needs double plus one', () => {
  assert.strictEqual(minQtyFor({ qty: 3, face: 1 }, 1, 20), 4);
  assert.strictEqual(minQtyFor({ qty: 3, face: 1 }, 2, 20), 7);
  assert.strictEqual(minQtyFor({ qty: 3, face: 1 }, 6, 20), 7);
});

test('nothing above the dice on the table', () => {
  assert.strictEqual(minQtyFor({ qty: 10, face: 6 }, 6, 10), null);
  assert.strictEqual(minQtyFor({ qty: 10, face: 5 }, 6, 10), 10);
  assert.strictEqual(minQtyFor({ qty: 5, face: 1 }, 3, 10), null);
});

test('1s are wild for every face but themselves', () => {
  assert.strictEqual(countFace([1, 1, 3, 3, 5], 3), 4);
  assert.strictEqual(countFace([1, 1, 3, 3, 5], 1), 2);
  assert.strictEqual(countFace([2, 2, 2], 6), 0);
});

test('act() enforces turn order and the raise rules', () => {
  const g = table([[2, 2, 3], [4, 4, 4], [6, 1, 5]]);
  assert.strictEqual(g.turnId, 'p0');
  assert.strictEqual(g.act({ playerId: 'p1', type: 'bid', qty: 2, face: 4 }).reason, 'not-your-turn');
  assert.strictEqual(g.act({ playerId: 'p0', type: 'bs' }).reason, 'no-bid');
  assert.strictEqual(g.act({ playerId: 'p0', type: 'bid', qty: 10, face: 2 }).reason, 'too-high');
  assert.ok(g.act({ playerId: 'p0', type: 'bid', qty: 3, face: 4 }).ok);
  assert.strictEqual(g.turnId, 'p1');
  const low = g.act({ playerId: 'p1', type: 'bid', qty: 3, face: 2 });
  assert.strictEqual(low.reason, 'too-low');
  assert.strictEqual(low.min, 4);
  assert.ok(g.act({ playerId: 'p1', type: 'bid', qty: 2, face: 1 }).ok);
  assert.strictEqual(g.act({ playerId: 'p2', type: 'bid', qty: 4, face: 6 }).reason, 'too-low');
  assert.ok(g.act({ playerId: 'p2', type: 'bid', qty: 5, face: 6 }).ok);
});

test('opening on 1s is allowed; moving off it needs double plus one', () => {
  const g = table([[1, 1, 3], [4, 4, 4], [6, 1, 5]]);
  assert.ok(g.act({ playerId: 'p0', type: 'bid', qty: 2, face: 1 }).ok);
  const low = g.act({ playerId: 'p1', type: 'bid', qty: 4, face: 4 });
  assert.strictEqual(low.reason, 'too-low');
  assert.strictEqual(low.min, 5);
  assert.ok(g.act({ playerId: 'p1', type: 'bid', qty: 3, face: 1 }).ok);
});

test("after a bid the next turn stays locked until the bid's pop-up is gone", () => {
  const g = new Game(5);
  g.manualTimers = true;
  ['a', 'b'].forEach((id) => g.addPlayer({ playerId: id, name: id, socketId: 's' + id }));
  g.start();
  g.openerId = 'a';
  g.tick();
  assert.ok(g.act({ playerId: 'a', type: 'bid', qty: 1, face: 3 }).ok);
  assert.strictEqual(g.turnId, 'b');
  assert.ok(g.turnLocked && g.turnOpensAt > Date.now());
  assert.strictEqual(g.act({ playerId: 'b', type: 'bs' }).reason, 'not-yet');
  assert.strictEqual(g.act({ playerId: 'b', type: 'bid', qty: 2, face: 3 }).reason, 'not-yet');
  const locked = g.getPrivate('b');
  assert.ok(locked.upNext && !locked.yourTurn && locked.legal === null && !locked.canCall);
  assert.strictEqual(g.pendingBots(), null);
  g.tick();
  assert.ok(!g.turnLocked && g.getPrivate('b').yourTurn);
  assert.ok(g.act({ playerId: 'b', type: 'bs' }).ok);
});

test('a seat keeps its last call until the action returns to it', () => {
  const g = table([[2, 2], [3, 3], [4, 4]]);
  g.act({ playerId: 'p0', type: 'bid', qty: 1, face: 2 });
  g.act({ playerId: 'p1', type: 'bid', qty: 2, face: 2 });
  assert.deepStrictEqual(g.players.get('p0').lastAction, { type: 'bid', qty: 1, face: 2 });
  g.act({ playerId: 'p2', type: 'bid', qty: 3, face: 2 });
  assert.strictEqual(g.turnId, 'p0');
  assert.strictEqual(g.players.get('p0').lastAction, null);
  assert.deepStrictEqual(g.players.get('p1').lastAction, { type: 'bid', qty: 2, face: 2 });
});

// ─────────────────────────── Challenges ───────────────────────────

test('BS on a true bid: the caller loses a die and opens next', () => {
  const g = table([[3, 3, 1], [3, 5, 6], [2, 2, 2]]);
  g.act({ playerId: 'p0', type: 'bid', qty: 4, face: 3 });   // 3,3,1,3 = 4 → true
  g.act({ playerId: 'p1', type: 'bs' });
  assert.strictEqual(g.phase, PHASES.REVEAL);
  const r = g.reveal;
  assert.strictEqual(r.count, 4);
  assert.strictEqual(r.correct, false);
  assert.strictEqual(r.loserId, 'p1');
  assert.deepStrictEqual(r.order, ['p1', 'p2', 'p0']);
  assert.ok(r.startAt < r.verdictAt && r.verdictAt < r.endAt);
  g.tick();
  assert.strictEqual(g.phase, PHASES.ROLL);
  assert.strictEqual(g.players.get('p1').diceCount, 2);
  assert.strictEqual(g.players.get('p1').dice.length, 2);
  assert.strictEqual(g.openerId, 'p1');
  assert.strictEqual(g.round, 2);
});

test('BS on a bluff: the bidder loses a die', () => {
  const g = table([[3, 4], [5, 6], [2, 2]]);
  g.act({ playerId: 'p0', type: 'bid', qty: 3, face: 3 });   // only one 3, no 1s
  g.act({ playerId: 'p1', type: 'bs' });
  assert.strictEqual(g.reveal.correct, true);
  assert.strictEqual(g.reveal.loserId, 'p0');
  assert.strictEqual(g.players.get('p1').stats.bsRight, 1);
  assert.strictEqual(g.players.get('p0').stats.caught, 1);
  g.tick();
  assert.strictEqual(g.players.get('p0').diceCount, 1);
  assert.strictEqual(g.openerId, 'p0');
});

test('Spot On exactly right wins a die back, capped at the starting count', () => {
  const g = table([[3, 3], [3, 6], [2, 2]], { startDice: 3 });
  g.act({ playerId: 'p0', type: 'bid', qty: 3, face: 3 });
  g.act({ playerId: 'p1', type: 'spot' });
  assert.strictEqual(g.reveal.correct, true);
  assert.strictEqual(g.reveal.gainerId, 'p1');
  assert.strictEqual(g.reveal.loserId, null);
  g.tick();
  assert.strictEqual(g.players.get('p1').diceCount, 3);
  assert.strictEqual(g.openerId, 'p1');

  const h = table([[3, 3, 3], [3, 6, 6], [2, 2, 2]], { startDice: 3 });
  h.act({ playerId: 'p0', type: 'bid', qty: 4, face: 3 });
  h.act({ playerId: 'p1', type: 'spot' });
  assert.strictEqual(h.reveal.correct, true);
  assert.strictEqual(h.reveal.capped, true);
  h.tick();
  assert.strictEqual(h.players.get('p1').diceCount, 3);
});

test('Spot On over or under loses the caller a die', () => {
  const over = table([[3, 3], [3, 6], [2, 2]]);
  over.act({ playerId: 'p0', type: 'bid', qty: 2, face: 3 });   // actually 3
  over.act({ playerId: 'p1', type: 'spot' });
  assert.strictEqual(over.reveal.correct, false);
  assert.strictEqual(over.reveal.loserId, 'p1');
  const under = table([[3, 3], [3, 6], [2, 2]]);
  under.act({ playerId: 'p0', type: 'bid', qty: 4, face: 3 });
  under.act({ playerId: 'p1', type: 'spot' });
  assert.strictEqual(under.reveal.correct, false);
  assert.strictEqual(under.reveal.loserId, 'p1');
});

test('losing your last die knocks you out; the next seat opens', () => {
  const g = table([[5], [2, 2], [6, 6]]);
  g.act({ playerId: 'p0', type: 'bid', qty: 3, face: 5 });
  g.act({ playerId: 'p1', type: 'bs' });
  assert.deepStrictEqual(g.reveal.knockedOut, ['p0']);
  assert.strictEqual(g.reveal.gameOver, false);
  g.tick();
  const p0 = g.players.get('p0');
  assert.ok(p0.busted && p0.place === 3 && p0.outRound === 1);
  assert.strictEqual(g.openerId, 'p1');
  assert.ok(g.players.has('p0'), 'the knocked-out player stays on the roster');
  // Turn order skips the busted seat.
  g.tick();
  g.act({ playerId: 'p1', type: 'bid', qty: 1, face: 2 });
  assert.strictEqual(g.turnId, 'p2');
  g.act({ playerId: 'p2', type: 'bid', qty: 1, face: 3 });
  assert.strictEqual(g.turnId, 'p1');
});

test('the last player with dice wins', () => {
  const g = table([[4], [2]]);
  g.act({ playerId: 'p0', type: 'bid', qty: 2, face: 4 });
  g.act({ playerId: 'p1', type: 'bs' });
  assert.strictEqual(g.reveal.gameOver, true);
  g.tick();
  assert.strictEqual(g.phase, PHASES.FINAL);
  assert.strictEqual(g.winnerId, 'p1');
  const fin = g.getFinalPublic();
  assert.deepStrictEqual(fin.standings.map((s) => [s.playerId, s.place]), [['p1', 1], ['p0', 2]]);
});

// ─────────────────────────── Secrecy ───────────────────────────

test('no die is public outside a reveal', () => {
  const g = table([[3, 3], [4, 5]]);
  const pub = g.getTablePublic();
  assert.strictEqual(pub.reveal, null);
  assert.ok(pub.seats.every((s) => !('dice' in s)));
  assert.deepStrictEqual(g.getPrivate('p0').dice, [3, 3]);
  g.act({ playerId: 'p0', type: 'bid', qty: 1, face: 3 });
  g.act({ playerId: 'p1', type: 'bs' });
  assert.deepStrictEqual(g.getTablePublic().reveal.dice, { p0: [3, 3], p1: [4, 5] });
});

test('a dropped player is never skipped', () => {
  const g = table([[3, 3], [4, 5]]);
  g.markDisconnected('s0');
  assert.strictEqual(g.turnId, 'p0');
  assert.strictEqual(g.getTablePublic().waitingOn, 'P0');
  assert.strictEqual(g.tick(), false, 'no timer acts for them');
});

// ─────────────────────────── CPU ───────────────────────────

test('the CPU only ever picks a legal move', () => {
  let rngSeed = 3;
  const rng = () => { rngSeed = (rngSeed * 16807) % 2147483647; return rngSeed / 2147483647; };
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + (trial % 7);
    const g = new Game(1000 + trial);
    g.manualTimers = true;
    for (let i = 0; i < n; i++) g.addBot();
    g.setStartDice(3 + (trial % 4));
    g.start();
    let guard = 0;
    while (g.phase !== PHASES.FINAL && guard++ < 2000) {
      if (g.phase !== PHASES.BIDDING || g.turnLocked) { g.tick(); continue; }
      const view = g.botView(g.turnId);
      const choice = chooseAction(view, rng);
      const res = g.act(Object.assign({ playerId: g.turnId }, choice));
      assert.ok(res.ok, 'illegal CPU move ' + JSON.stringify(choice) + ' on ' + JSON.stringify(view.currentBid) + ': ' + res.reason);
    }
    assert.strictEqual(g.phase, PHASES.FINAL, 'a CPU-only game finishes');
    const places = g.seatOrder().map((p) => p.place).sort((a, b) => a - b);
    assert.deepStrictEqual(places, Array.from({ length: n }, (_x, i) => i + 1));
  }
});

test('the CPU opens on a face it holds and calls an absurd bid', () => {
  const rng = () => 0.5;
  const open = chooseAction({ dice: [5, 5, 5, 2, 3], diceCount: 5, startDice: 5, totalDice: 10, players: 2, currentBid: null, legal: { 1: null, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 }, bids: [] }, rng);
  assert.strictEqual(open.type, 'bid');
  assert.strictEqual(open.face, 5);
  assert.ok(open.qty >= 3);
  const call = chooseAction({ dice: [2, 3, 4, 6, 6], diceCount: 5, startDice: 5, totalDice: 10, players: 2, currentBid: { qty: 8, face: 5, playerId: 'x' }, legal: { 1: 4, 2: 9, 3: 9, 4: 9, 5: 9, 6: 8 }, bids: [] }, rng);
  assert.strictEqual(call.type, 'bs');
});

// ─────────────────────────── Report ───────────────────────────
if (failures.length) {
  failures.forEach((f) => console.log('✗ ' + f.name + '\n    ' + (f.err && f.err.stack || f.err)));
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(1);
}
console.log('✓ liarsdice engine: ' + passed + ' tests passed');
