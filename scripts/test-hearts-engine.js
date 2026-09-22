'use strict';

// Pure-logic unit tests for Hearts — deck, legal plays, passing and scoring.
// No server, no network.
//   node scripts/test-hearts-engine.js   (or: npm run test:hearts)

const assert = require('assert');
const path = require('path');

const deck = require(path.join('..', 'server', 'hearts', 'deck'));
const { Game, PHASES, PASS_DIRECTIONS, SEATS } = require(path.join('..', 'server', 'hearts', 'game'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push({ name, err: e }); }
}

const ids = ['pN', 'pE', 'pS', 'pW'];

function lobbyGame(seed) {
  const g = new Game(seed == null ? 1234 : seed);
  ids.forEach((id, i) => {
    const r = g.addPlayer({ playerId: id, name: 'P' + i, socketId: 's' + i });
    assert.ok(r.ok, 'addPlayer ' + id + ': ' + JSON.stringify(r));
  });
  return g;
}

/** Force a specific deal, bypassing the shuffle, and jump straight to trick 1. */
function dealt(hands, opts) {
  const g = lobbyGame();
  g.phase = PHASES.DEAL;
  g.handIndex = (opts && opts.handIndex) || 0;
  g.seatOrder().forEach((p, i) => {
    p.hand = deck.sortHand(hands[i]);
    p.taken = [];
    p.handPoints = 0;
    p.pass = [];
    p.received = [];
    p.passed = false;
  });
  g.trickNumber = 0;
  g.heartsBroken = !!(opts && opts.heartsBroken);
  g._enterTrick();
  if (opts && opts.trickNumber) g.trickNumber = opts.trickNumber;
  if (opts && opts.turn != null) g.turnIndex = opts.turn;
  g._clearTimers();
  return g;
}

function rest(exclude) {
  return deck.buildDeck().filter((c) => exclude.indexOf(c) < 0);
}

// ─────────────────────────── Deck ───────────────────────────

test('deck: 52 unique cards, 13 of each suit', () => {
  const d = deck.buildDeck();
  assert.strictEqual(d.length, 52);
  assert.strictEqual(new Set(d).size, 52);
  for (const s of deck.SUITS) assert.strictEqual(d.filter((c) => deck.suitOf(c) === s).length, 13);
});

test('deck: point values — hearts 1, Q♠ 13, J♦ −10, rest 0', () => {
  assert.strictEqual(deck.pointsOf('2H'), 1);
  assert.strictEqual(deck.pointsOf('AH'), 1);
  assert.strictEqual(deck.pointsOf('QS'), 13);
  assert.strictEqual(deck.pointsOf('JD'), -10);
  assert.strictEqual(deck.pointsOf('QH'), 1);
  assert.strictEqual(deck.pointsOf('AS'), 0);
  assert.strictEqual(deck.pointsOf('2C'), 0);
  const hearts = deck.buildDeck().filter(deck.isHeart);
  assert.strictEqual(hearts.reduce((s, c) => s + deck.pointsOf(c), 0) + deck.pointsOf('QS'), 26);
});

test('deck: rank values ascend 2..A with 10 < J', () => {
  assert.strictEqual(deck.rankValue('2C'), 2);
  assert.strictEqual(deck.rankValue('10C'), 10);
  assert.strictEqual(deck.rankValue('JC'), 11);
  assert.strictEqual(deck.rankValue('AC'), 14);
  assert.ok(deck.rankValue('JC') > deck.rankValue('10C'));
});

test('deck: deal gives 4 sorted hands of 13 using every card once', () => {
  const hands = deck.deal(deck.makeRng(7));
  assert.strictEqual(hands.length, 4);
  const all = [];
  for (const h of hands) {
    assert.strictEqual(h.length, 13);
    assert.deepStrictEqual(h, deck.sortHand(h));
    all.push.apply(all, h);
  }
  assert.strictEqual(new Set(all).size, 52);
});

test('deck: trickWinnerIndex ignores off-suit cards however high', () => {
  assert.strictEqual(deck.trickWinnerIndex(['2C', 'AH', 'AS', '3C']), 3);
  assert.strictEqual(deck.trickWinnerIndex(['KD', 'AD', '2D', 'AS']), 1);
  assert.strictEqual(deck.trickWinnerIndex(['AS', '2S', '3S', '4S']), 0);
});

// ─────────────────────── Legal plays ───────────────────────

test('legal: first trick must be led with 2♣', () => {
  const hand = ['2C', '5C', 'AH', 'QS'];
  assert.deepStrictEqual(
    deck.legalPlays({ hand, trick: [], heartsBroken: false, isFirstTrick: true }),
    ['2C']
  );
});

test('legal: points ARE allowed on the first trick (house rule)', () => {
  const hand = ['QS', 'AH', '3H'];
  // Following a club lead while void: everything is fair game, including Q♠.
  const legal = deck.legalPlays({ hand, trick: ['2C'], heartsBroken: false, isFirstTrick: true });
  assert.deepStrictEqual(legal.slice().sort(), hand.slice().sort());
});

test('legal: must follow the led suit when able', () => {
  const hand = ['3C', 'KC', 'AH', 'QS'];
  assert.deepStrictEqual(
    deck.legalPlays({ hand, trick: ['2C'], heartsBroken: false, isFirstTrick: false }).sort(),
    ['3C', 'KC']
  );
});

test('legal: void in the led suit frees the whole hand', () => {
  const hand = ['AH', 'QS', '2D'];
  assert.deepStrictEqual(
    deck.legalPlays({ hand, trick: ['2C'], heartsBroken: false, isFirstTrick: false }).sort(),
    hand.slice().sort()
  );
});

test('legal: cannot LEAD hearts before they are broken', () => {
  const hand = ['3C', 'AH', '2H'];
  assert.deepStrictEqual(
    deck.legalPlays({ hand, trick: [], heartsBroken: false, isFirstTrick: false }),
    ['3C']
  );
  assert.deepStrictEqual(
    deck.legalPlays({ hand, trick: [], heartsBroken: true, isFirstTrick: false }).sort(),
    hand.slice().sort()
  );
});

test('legal: an all-hearts hand may lead hearts even unbroken', () => {
  const hand = ['2H', '5H', 'AH'];
  assert.deepStrictEqual(
    deck.legalPlays({ hand, trick: [], heartsBroken: false, isFirstTrick: false }).sort(),
    hand.slice().sort()
  );
});

test('legal: Q♠ may be led freely once it is not the first trick', () => {
  const hand = ['QS', '4D'];
  const legal = deck.legalPlays({ hand, trick: [], heartsBroken: false, isFirstTrick: false });
  assert.ok(legal.indexOf('QS') >= 0);
});

// ─────────────────── Turn order & breaking ───────────────────

test('game: the 2♣ holder leads trick 1', () => {
  const g = dealt([
    ['3C', '4C', '5C', '6C', '7C', '8C', '9C', '10C', 'JC', 'QC', 'KC', 'AC', '2D'],
    ['2C'].concat(rest(['3C', '4C', '5C', '6C', '7C', '8C', '9C', '10C', 'JC', 'QC', 'KC', 'AC', '2D']).slice(0, 12)),
    [], [],
  ].map((h, i) => (i < 2 ? h : [])));
  assert.strictEqual(g.currentPlayer().id, 'pE');
  assert.deepStrictEqual(g.legalFor('pE'), ['2C']);
});

test('game: only a heart breaks hearts — Q♠ does not', () => {
  const g = dealt([
    ['2C', '3D'], ['3C', '4D'], ['4C', '5D'], ['5C', '6D'],
  ]);
  g.playCard({ playerId: 'pN', card: '2C' });
  g.playCard({ playerId: 'pE', card: '3C' });
  g.playCard({ playerId: 'pS', card: '4C' });
  g.playCard({ playerId: 'pW', card: '5C' });
  assert.strictEqual(g.heartsBroken, false);

  // pE is void in clubs, so the Queen is a legal discard here.
  const g2 = dealt([['2C', '3D'], ['QS', '4D'], ['4C', '5D'], ['5C', '6D']]);
  g2.playCard({ playerId: 'pN', card: '2C' });
  const r = g2.playCard({ playerId: 'pE', card: 'QS' });
  assert.ok(r.ok, 'discarding the Queen while void should be legal');
  assert.strictEqual(r.brokeHearts, false);
  assert.strictEqual(g2.heartsBroken, false, 'the Queen must not break hearts');
});

test('game: J♦ does not break hearts and can be discarded freely', () => {
  const g = dealt([['2C', '3D'], ['JD', '4H'], ['4C', '5D'], ['5C', '6D']]);
  g.playCard({ playerId: 'pN', card: '2C' });
  const r = g.playCard({ playerId: 'pE', card: 'JD' });
  assert.ok(r.ok);
  assert.strictEqual(r.brokeHearts, false);
  assert.strictEqual(g.heartsBroken, false);
});

test('game: playing a heart breaks hearts', () => {
  const g = dealt([['2C', '3D'], ['3H', '4H'], ['4C', '5D'], ['5C', '6D']]);
  g.playCard({ playerId: 'pN', card: '2C' });
  const r = g.playCard({ playerId: 'pE', card: '3H' });
  assert.ok(r.ok);
  assert.strictEqual(r.brokeHearts, true);
  assert.strictEqual(g.heartsBroken, true);
});

test('game: illegal and out-of-turn plays are rejected and change nothing', () => {
  const g = dealt([['2C', 'AH'], ['3C', 'KC'], ['4C', '5D'], ['5C', '6D']]);
  assert.deepStrictEqual(g.playCard({ playerId: 'pE', card: '3C' }), { ok: false, reason: 'not-your-turn' });
  g.playCard({ playerId: 'pN', card: '2C' });
  assert.deepStrictEqual(g.playCard({ playerId: 'pE', card: '2H' }), { ok: false, reason: 'not-in-hand' });
  assert.strictEqual(g.trick.length, 1);
  assert.strictEqual(g.players.get('pE').hand.length, 2);
});

test('game: must-follow is enforced by playCard, not just advertised', () => {
  const g = dealt([['2C', 'AH'], ['3C', 'AS'], ['4C', '5D'], ['5C', '6D']]);
  g.playCard({ playerId: 'pN', card: '2C' });
  assert.deepStrictEqual(g.playCard({ playerId: 'pE', card: 'AS' }), { ok: false, reason: 'illegal-card' });
  assert.ok(g.playCard({ playerId: 'pE', card: '3C' }).ok);
});

test('game: the trick winner takes the cards and leads the next trick', () => {
  const g = dealt([['2C', '3D'], ['AC', '4D'], ['4C', '5D'], ['5C', '6D']]);
  g.playCard({ playerId: 'pN', card: '2C' });
  g.playCard({ playerId: 'pE', card: 'AC' });
  g.playCard({ playerId: 'pS', card: '4C' });
  g.playCard({ playerId: 'pW', card: '5C' });
  assert.strictEqual(g.phase, PHASES.TRICK_END);
  assert.strictEqual(g.lastTrick.winnerId, 'pE');
  assert.strictEqual(g.players.get('pE').taken.length, 4);
  assert.strictEqual(g.seatOrder()[g.turnIndex].id, 'pE');
});

// ───────────────────────── Passing ─────────────────────────

test('pass: rotation is left, right, across, hold and repeats', () => {
  const g = lobbyGame();
  const seen = [];
  for (let i = 0; i < 8; i++) { g.handIndex = i; seen.push(g.passDirection()); }
  assert.deepStrictEqual(seen, PASS_DIRECTIONS.concat(PASS_DIRECTIONS));
});

test('pass: cards land on the correct seat for every direction', () => {
  const cases = { left: 1, right: 3, across: 2 };
  for (const dir of Object.keys(cases)) {
    const g = lobbyGame();
    g.handIndex = PASS_DIRECTIONS.indexOf(dir);
    g.phase = PHASES.DEAL;
    const hands = deck.deal(deck.makeRng(99));
    g.seatOrder().forEach((p, i) => {
      p.hand = hands[i]; p.taken = []; p.pass = []; p.received = []; p.passed = false; p.handPoints = 0;
    });
    g._enterPass();
    const order = g.seatOrder();
    const sent = order.map((p) => p.hand.slice(0, 3));
    order.forEach((p, i) => assert.ok(g.submitPass({ playerId: p.id, cards: sent[i] }).ok));
    assert.strictEqual(g.phase, PHASES.EXCHANGE, dir + ': exchange should fire once all four pass');
    order.forEach((p, i) => {
      const from = (i - cases[dir] + 4) % 4;
      assert.deepStrictEqual(p.received.slice().sort(), sent[from].slice().sort(), dir + ' receipt');
      for (const c of sent[from]) assert.ok(p.hand.indexOf(c) >= 0, dir + ': received card is in hand');
      for (const c of sent[i]) assert.ok(p.hand.indexOf(c) < 0, dir + ': passed card left the hand');
      assert.strictEqual(p.hand.length, 13);
    });
    g._clearTimers();
  }
});

test('pass: every card is still in play after an exchange', () => {
  const g = lobbyGame();
  g.phase = PHASES.DEAL;
  const hands = deck.deal(deck.makeRng(3));
  g.seatOrder().forEach((p, i) => {
    p.hand = hands[i]; p.taken = []; p.pass = []; p.received = []; p.passed = false; p.handPoints = 0;
  });
  g._enterPass();
  g.seatOrder().forEach((p) => g.submitPass({ playerId: p.id, cards: p.hand.slice(2, 5) }));
  const all = [];
  for (const p of g.players.values()) all.push.apply(all, p.hand);
  assert.strictEqual(new Set(all).size, 52);
  g._clearTimers();
});

test('pass: rejects wrong counts, duplicates, foreign cards and double-passing', () => {
  const g = lobbyGame();
  g.phase = PHASES.DEAL;
  const hands = deck.deal(deck.makeRng(11));
  g.seatOrder().forEach((p, i) => {
    p.hand = hands[i]; p.taken = []; p.pass = []; p.received = []; p.passed = false; p.handPoints = 0;
  });
  g._enterPass();
  const me = g.seatOrder()[0];
  const other = g.seatOrder()[1];
  assert.strictEqual(g.submitPass({ playerId: me.id, cards: me.hand.slice(0, 2) }).reason, 'need-three');
  assert.strictEqual(g.submitPass({ playerId: me.id, cards: [me.hand[0], me.hand[0], me.hand[1]] }).reason, 'duplicate-card');
  assert.strictEqual(g.submitPass({ playerId: me.id, cards: [me.hand[0], me.hand[1], other.hand[0]] }).reason, 'not-in-hand');
  assert.ok(g.submitPass({ playerId: me.id, cards: me.hand.slice(0, 3) }).ok);
  assert.strictEqual(g.submitPass({ playerId: me.id, cards: me.hand.slice(3, 6) }).reason, 'already-passed');
  g._clearTimers();
});

test('pass: a hold hand skips the pass phase entirely', () => {
  const g = lobbyGame();
  g.handIndex = 3;
  assert.strictEqual(g.passDirection(), 'hold');
  g._enterDeal();
  g._timers.deal = null;
  // Run the deal transition by hand rather than waiting on the timer.
  if (g.passDirection() === 'hold') g._enterTrick(); else g._enterPass();
  assert.strictEqual(g.phase, PHASES.TRICK);
  g._clearTimers();
});

// ───────────────────────── Scoring ─────────────────────────

/** Hand out `taken` piles directly and run the scorer. */
function scoreWith(taken) {
  const g = lobbyGame();
  g.seatOrder().forEach((p, i) => { p.taken = taken[i].slice(); });
  const rows = g._scoreHand();
  g._clearTimers();
  return { g, rows, byId: Object.fromEntries(rows.map((r) => [r.playerId, r])) };
}

test('score: hearts and Q♠ always total 26 across the table', () => {
  const hearts = deck.buildDeck().filter(deck.isHeart);
  const { rows } = scoreWith([
    hearts.slice(0, 5).concat(['QS']),
    hearts.slice(5, 9),
    hearts.slice(9, 12),
    hearts.slice(12),
  ]);
  const jackless = rows.reduce((s, r) => s + r.delta, 0);
  assert.strictEqual(jackless, 26);
  assert.strictEqual(rows.find((r) => r.queen).delta, 18);
});

test('score: J♦ subtracts 10 from whoever captured it', () => {
  const { byId } = scoreWith([['JD'], ['2H', '3H'], [], ['QS']]);
  assert.strictEqual(byId.pN.delta, -10);
  assert.strictEqual(byId.pE.delta, 2);
  assert.strictEqual(byId.pS.delta, 0);
  assert.strictEqual(byId.pW.delta, 13);
});

test('score: shooting the moon gives everyone else 26 and the shooter 0', () => {
  const hearts = deck.buildDeck().filter(deck.isHeart);
  const { byId, g } = scoreWith([hearts.concat(['QS']), [], [], []]);
  assert.strictEqual(g.moonShooterId, 'pN');
  assert.strictEqual(byId.pN.delta, 0);
  assert.strictEqual(byId.pN.shotMoon, true);
  assert.strictEqual(byId.pE.delta, 26);
  assert.strictEqual(byId.pS.delta, 26);
  assert.strictEqual(byId.pW.delta, 26);
});

test('score: the moon needs the Queen as well as all 13 hearts', () => {
  const hearts = deck.buildDeck().filter(deck.isHeart);
  const { byId, g } = scoreWith([hearts.slice(), ['QS'], [], []]);
  assert.strictEqual(g.moonShooterId, null);
  assert.strictEqual(byId.pN.delta, 13);
  assert.strictEqual(byId.pE.delta, 13);
});

test('score: J♦ is independent of the moon — shooter holding it ends at −10', () => {
  const hearts = deck.buildDeck().filter(deck.isHeart);
  const { byId } = scoreWith([hearts.concat(['QS', 'JD']), [], [], []]);
  assert.strictEqual(byId.pN.delta, -10);
  assert.strictEqual(byId.pE.delta, 26);
});

test('score: J♦ is independent of the moon — another player nets 16', () => {
  const hearts = deck.buildDeck().filter(deck.isHeart);
  const { byId } = scoreWith([hearts.concat(['QS']), ['JD'], [], []]);
  assert.strictEqual(byId.pN.delta, 0);
  assert.strictEqual(byId.pE.delta, 16);
  assert.strictEqual(byId.pS.delta, 26);
});

test('score: a scoreless hand leaves every total untouched', () => {
  const { rows } = scoreWith([['2C'], ['3C'], ['4C'], ['5C']]);
  assert.deepStrictEqual(rows.map((r) => r.delta), [0, 0, 0, 0]);
});

// ──────────────────────── Game end ────────────────────────

test('end: game ends when someone reaches the target and lowest wins', () => {
  const g = lobbyGame();
  g.targetScore = 50;
  const [a, b, c, d] = g.seatOrder();
  a.total = 51; b.total = 20; c.total = 33; d.total = 44;
  g.phase = PHASES.HAND_END;
  g.lastHand = { handNumber: 4, rows: [], gameOver: true };
  g.nextHand();
  assert.strictEqual(g.phase, PHASES.FINAL);
  assert.deepStrictEqual(g.winnerIds, [b.id]);
  const final = g.getFinalPublic();
  assert.deepStrictEqual(final.standings.map((s) => s.total), [20, 33, 44, 51]);
  assert.deepStrictEqual(final.standings.map((s) => s.rank), [1, 2, 3, 4]);
  g._clearTimers();
});

test('end: a tie at the lowest score is a shared win', () => {
  const g = lobbyGame();
  g.targetScore = 50;
  const [a, b, c, d] = g.seatOrder();
  a.total = 60; b.total = 12; c.total = 12; d.total = 40;
  g.phase = PHASES.HAND_END;
  g.lastHand = { handNumber: 5, rows: [], gameOver: true };
  g.nextHand();
  assert.strictEqual(g.winnerIds.length, 2);
  assert.deepStrictEqual(g.winnerIds.slice().sort(), [b.id, c.id].sort());
  const final = g.getFinalPublic();
  assert.deepStrictEqual(final.standings.map((s) => s.rank), [1, 1, 3, 4]);
  g._clearTimers();
});

test('end: a negative total still wins and the game continues below target', () => {
  const g = lobbyGame();
  g.targetScore = 50;
  g.seatOrder().forEach((p, i) => { p.total = [49, 10, -5, 30][i]; });
  g.phase = PHASES.HAND_END;
  g.lastHand = { handNumber: 3, rows: [], gameOver: false };
  g.nextHand();
  assert.strictEqual(g.phase, PHASES.DEAL, 'nobody hit the target yet');
  assert.strictEqual(g.handIndex, 1);
  g._clearTimers();
});

// ──────────────────────── Lobby ────────────────────────

test('lobby: start requires exactly four players', () => {
  const g = new Game(1);
  for (let i = 0; i < 3; i++) {
    g.addPlayer({ playerId: 'p' + i, name: 'P' + i, socketId: 's' + i });
    assert.strictEqual(g.canStart(), false, i + 1 + ' players must not be enough');
  }
  g.addPlayer({ playerId: 'p3', name: 'P3', socketId: 's3' });
  assert.strictEqual(g.canStart(), true);
  const fifth = g.addPlayer({ playerId: 'p4', name: 'P4', socketId: 's4' });
  assert.strictEqual(fifth.reason, 'game-full');
  g._clearTimers();
});

test('lobby: CPUs fill seats and are flagged in the snapshot', () => {
  const g = new Game(2);
  g.addPlayer({ playerId: 'human', name: 'Nick', socketId: 's' });
  assert.ok(g.addBot().ok);
  assert.ok(g.addBot().ok);
  assert.ok(g.addBot().ok);
  assert.strictEqual(g.addBot().reason, 'game-full');
  const lobby = g.getLobbyPublic();
  assert.strictEqual(lobby.canStart, true);
  assert.deepStrictEqual(lobby.players.map((p) => p.seat), SEATS);
  assert.deepStrictEqual(lobby.players.map((p) => p.isBot), [false, true, true, true]);
  assert.deepStrictEqual(lobby.players.map((p) => p.name), ['Nick', 'CPU', 'CPU 2', 'CPU 3']);
  g._clearTimers();
});

test('lobby: a bot seat cannot be hijacked by a phone', () => {
  const g = new Game(3);
  g.addBot();
  assert.strictEqual(g.reconnectPlayer({ playerId: 'bot-1', socketId: 'x' }).reason, 'unknown-player');
  g._clearTimers();
});

test('lobby: drag-reorder rewrites the seat assignment', () => {
  const g = lobbyGame();
  assert.deepStrictEqual(g.seatOrder().map((p) => p.id), ids);
  assert.ok(g.reorderPlayer('pW', 'pN').ok);
  assert.deepStrictEqual(g.seatOrder().map((p) => p.id), ['pW', 'pN', 'pE', 'pS']);
  assert.strictEqual(g.seatOf('pW'), 'N');
  assert.ok(g.reorderPlayer('pW', null).ok);
  assert.deepStrictEqual(g.seatOrder().map((p) => p.id), ['pN', 'pE', 'pS', 'pW']);
  g._clearTimers();
});

test('lobby: target score only accepts 50 / 75 / 100 / 125 / 150', () => {
  const g = lobbyGame();
  assert.strictEqual(g.targetScore, 100);
  assert.ok(g.setTargetScore(100).ok);
  assert.strictEqual(g.targetScore, 100);
  assert.strictEqual(g.setTargetScore(63).reason, 'bad-target');
  assert.strictEqual(g.setTargetScore(200).reason, 'bad-target');
  assert.strictEqual(g.setTargetScore('75').ok, true);
  assert.strictEqual(g.targetScore, 75);
  assert.ok(g.setTargetScore(125).ok);
  assert.strictEqual(g.targetScore, 125);
  assert.ok(g.setTargetScore(150).ok);
  assert.strictEqual(g.targetScore, 150);
  g._clearTimers();
});

test('lobby: config is locked once the game starts', () => {
  const g = lobbyGame();
  assert.ok(g.start().ok);
  assert.strictEqual(g.setTargetScore(100).reason, 'not-lobby');
  assert.strictEqual(g.addBot().reason, 'not-lobby');
  assert.strictEqual(g.reorderPlayer('pN', 'pE').reason, 'not-lobby');
  assert.strictEqual(g.removePlayer('pN'), null, 'kicking is lobby-only');
  assert.strictEqual(g.players.size, 4);
  g._clearTimers();
});

// ─────────────── Roster lock / disconnection ───────────────

test('roster: a disconnect never skips the turn or shrinks the table', () => {
  const g = dealt([['2C', '3D'], ['3C', 'QS'], ['4C', '5D'], ['5C', '6D']]);
  g.playCard({ playerId: 'pN', card: '2C' });
  const dropped = g.markDisconnected('s1'); // pE
  assert.strictEqual(dropped.id, 'pE');
  assert.strictEqual(g.currentPlayer().id, 'pE', 'the table waits for them');
  assert.strictEqual(g.players.size, 4);
  const table = g.getTablePublic();
  assert.strictEqual(table.waitingOn, dropped.name);
  assert.strictEqual(table.seats.length, 4);
  // Coming back changes nothing but the flag.
  assert.ok(g.reconnectPlayer({ playerId: 'pE', socketId: 's1b' }).ok);
  assert.strictEqual(g.currentPlayer().id, 'pE');
  assert.strictEqual(g.getTablePublic().waitingOn, null);
});

// ───────────── Privacy of the public snapshots ─────────────

test('privacy: no public snapshot ever contains an unplayed card', () => {
  const g = lobbyGame();
  g.start();
  g._clearTimers();
  const hands = new Map();
  for (const p of g.players.values()) hands.set(p.id, p.hand.slice());

  const snapshots = {
    lobby: g.getLobbyPublic(),
    deal: g.getDealPublic(),
    table: g.getTablePublic(),
    handEnd: g.getHandEndPublic(),
    final: g.getFinalPublic(),
  };
  for (const [name, snap] of Object.entries(snapshots)) {
    const json = JSON.stringify(snap);
    for (const [pid, hand] of hands) {
      for (const card of hand) {
        // Card ids are short and could appear by accident inside a longer
        // token, so match them as whole JSON string values.
        assert.ok(json.indexOf('"' + card + '"') < 0,
          name + ' snapshot leaked ' + card + ' from ' + pid);
      }
    }
  }
});

test('privacy: the private hand carries legal moves only on your turn', () => {
  const g = dealt([['2C', 'AH'], ['3C', 'KC'], ['4C', '5D'], ['5C', '6D']]);
  const mine = g.getPrivateHand('pN');
  assert.deepStrictEqual(mine.legal, ['2C']);
  assert.strictEqual(mine.yourTurn, true);
  assert.ok(/2♣/.test(mine.reason));
  const theirs = g.getPrivateHand('pE');
  assert.deepStrictEqual(theirs.legal, []);
  assert.strictEqual(theirs.yourTurn, false);
  assert.strictEqual(theirs.hand.length, 2);
});

test('privacy: the follow-suit hint names the led suit', () => {
  const g = dealt([['2C', '3D'], ['3C', 'AH'], ['4C', '5D'], ['5C', '6D']]);
  g.playCard({ playerId: 'pN', card: '2C' });
  const priv = g.getPrivateHand('pE');
  assert.deepStrictEqual(priv.legal, ['3C']);
  assert.strictEqual(priv.reason, 'You must follow ♣.');
});

// ──────────────────── Full-hand integrity ────────────────────

test('integrity: 200 seeded hands each run 13 tricks and conserve all 52 cards', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const g = new Game(seed);
    ids.forEach((id, i) => g.addPlayer({ playerId: id, name: 'P' + i, socketId: 's' + i }));
    g.start();
    g._clearTimers();
    if (g.passDirection() !== 'hold') {
      g._enterPass();
      for (const p of g.seatOrder()) g.submitPass({ playerId: p.id, cards: p.hand.slice(0, 3) });
      g._clearTimers();
      g._enterTrick();
    } else {
      g._enterTrick();
    }
    let guard = 0;
    while (g.phase !== PHASES.HAND_END && guard++ < 200) {
      if (g.phase === PHASES.TRICK_END) {
        if (g.trickNumber >= 13) g._enterHandEnd(); else g._enterTrick();
        g._clearTimers();
        continue;
      }
      const p = g.currentPlayer();
      const legal = g.legalFor(p.id);
      assert.ok(legal.length > 0, 'seed ' + seed + ': someone had no legal play');
      for (const c of legal) assert.ok(p.hand.indexOf(c) >= 0, 'legal card must be held');
      assert.ok(g.playCard({ playerId: p.id, card: legal[0] }).ok);
    }
    assert.strictEqual(g.phase, PHASES.HAND_END, 'seed ' + seed + ': hand did not finish');
    assert.strictEqual(g.trickNumber, 13);
    const taken = [];
    for (const p of g.players.values()) {
      assert.strictEqual(p.hand.length, 0, 'seed ' + seed + ': cards left over');
      taken.push.apply(taken, p.taken);
    }
    assert.strictEqual(new Set(taken).size, 52, 'seed ' + seed + ': cards lost or duplicated');
    const sum = g.lastHand.rows.reduce((s, r) => s + r.delta, 0);
    assert.ok(sum === 26 || sum === 16 || sum === 26 * 3 || sum === 26 * 3 - 10,
      'seed ' + seed + ': unexpected hand total ' + sum);
    g._clearTimers();
  }
});

// ──────────────────────── Report ────────────────────────

if (failures.length) {
  console.log('\n' + failures.length + ' FAILED, ' + passed + ' passed\n');
  for (const f of failures) {
    console.log('  ✗ ' + f.name);
    console.log('    ' + (f.err && f.err.message ? f.err.message : f.err));
  }
  process.exit(1);
}
console.log('✓ hearts engine: ' + passed + ' tests passed');
