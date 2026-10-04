'use strict';

// Pure-logic unit tests for Spades — deck, legal plays, teams, bidding,
// scoring and the end of the game, plus CPU self-play. No server, no network.
//   node scripts/test-spades-engine.js   (or: npm run test:spades)

const assert = require('assert');
const path = require('path');

const deck = require(path.join('..', 'server', 'spades', 'deck'));
const { Game, PHASES, SEATS } = require(path.join('..', 'server', 'spades', 'game'));
const bot = require(path.join('..', 'server', 'spades', 'bot'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push({ name, err: e }); }
}

function lobbyGame(seed) {
  const g = new Game(seed == null ? 1234 : seed);
  ['a', 'b', 'c', 'd'].forEach((id, i) => {
    const r = g.addPlayer({ playerId: id, name: 'P' + i, socketId: 's' + i });
    assert.ok(r.ok, 'addPlayer ' + id + ': ' + JSON.stringify(r));
  });
  return g;
}

/** Skip the deal timer and go straight to bidding. */
function toBidding(g) {
  g.start();
  g._enterBid();
  return g;
}

function bidAll(g, bids) {
  for (let i = 0; i < 4; i++) {
    const p = g.currentBidder();
    const b = bids[g.seatOrder().indexOf(p)];
    g.reveal(p.id);
    const r = g.submitBid({ playerId: p.id, bid: b });
    assert.ok(r.ok, 'bid: ' + JSON.stringify(r));
  }
}

// ─────────────────── Deck & rules ───────────────────

test('deal gives four sorted 13-card hands with no duplicates', () => {
  const hands = deck.deal(deck.makeRng(7));
  assert.strictEqual(hands.length, 4);
  const all = new Set();
  hands.forEach((h) => { assert.strictEqual(h.length, 13); h.forEach((c) => all.add(c)); });
  assert.strictEqual(all.size, 52);
  assert.deepStrictEqual(hands[0], deck.sortHand(hands[0]));
});

test('cannot lead a spade until broken, unless all spades', () => {
  const hand = ['2S', '3H', 'AS'];
  assert.deepStrictEqual(deck.legalPlays({ hand, trick: [], spadesBroken: false }), ['3H']);
  assert.deepStrictEqual(deck.legalPlays({ hand, trick: [], spadesBroken: true }), hand);
  assert.deepStrictEqual(deck.legalPlays({ hand: ['2S', 'AS'], trick: [], spadesBroken: false }), ['2S', 'AS']);
});

test('must follow suit; void may trump or discard', () => {
  assert.deepStrictEqual(deck.legalPlays({ hand: ['2H', '5H', 'AS'], trick: ['KH'], spadesBroken: false }), ['2H', '5H']);
  assert.deepStrictEqual(deck.legalPlays({ hand: ['2C', 'AS'], trick: ['KH'], spadesBroken: false }), ['2C', 'AS']);
});

test('highest spade wins, else highest of the led suit', () => {
  assert.strictEqual(deck.trickWinnerIndex(['5H', 'KH', 'AC', '3H']), 1);
  assert.strictEqual(deck.trickWinnerIndex(['5H', 'KH', '2S', 'AH']), 2);
  assert.strictEqual(deck.trickWinnerIndex(['5H', '3S', '2S', 'AH']), 1);
  assert.strictEqual(deck.trickWinnerIndex(['5D', 'AC', 'KH', '2D']), 0);
});

// ─────────────────── Scoring ───────────────────

const P = (bid, tricks, extra) => Object.assign({ bid, nil: false, blind: false, tricks }, extra || {});
const NIL = (tricks, blind) => ({ bid: 0, nil: true, blind: !!blind, tricks });

test('made contract scores 10 per trick bid plus a point per bag', () => {
  const r = deck.scoreTeam({ players: [P(3, 4), P(2, 2)], bags: 0 });
  assert.strictEqual(r.contract, 5);
  assert.strictEqual(r.made, true);
  assert.strictEqual(r.delta, 51);
  assert.strictEqual(r.bags, 1);
});

test('set contract loses 10 per trick bid', () => {
  const r = deck.scoreTeam({ players: [P(4, 2), P(3, 3)], bags: 4 });
  assert.strictEqual(r.made, false);
  assert.strictEqual(r.delta, -70);
  assert.strictEqual(r.bags, 4);
});

test('reaching 10 bags costs 100 and rolls the bag count over', () => {
  const r = deck.scoreTeam({ players: [P(3, 6), P(2, 2)], bags: 8 });
  assert.strictEqual(r.bagsThisHand, 3);
  assert.strictEqual(r.bagPenalty, -100);
  assert.strictEqual(r.bags, 1);
  assert.strictEqual(r.delta, 53 - 100);
});

test('nil made / failed, and nil tricks count as bags not toward the contract', () => {
  const made = deck.scoreTeam({ players: [NIL(0), P(4, 5)], bags: 0 });
  assert.strictEqual(made.delta, 100 + 41);
  const failed = deck.scoreTeam({ players: [NIL(2), P(4, 3)], bags: 0 });
  // Partner took 3 of 4 → set (−40); nil fails (−100); nil's 2 tricks are bags (+2).
  assert.strictEqual(failed.made, false);
  assert.strictEqual(failed.delta, -40 - 100 + 2);
  assert.strictEqual(failed.bags, 2);
});

test('blind nil is worth 200 either way', () => {
  assert.strictEqual(deck.scoreTeam({ players: [NIL(0, true), P(3, 3)], bags: 0 }).delta, 230);
  assert.strictEqual(deck.scoreTeam({ players: [NIL(1, true), P(3, 3)], bags: 0 }).delta, -200 + 30 + 1);
});

test('double nil has a zero contract', () => {
  const r = deck.scoreTeam({ players: [NIL(0), NIL(0)], bags: 0 });
  assert.strictEqual(r.contract, 0);
  assert.strictEqual(r.delta, 200);
});

// ─────────────────── Teams ───────────────────

test('newcomers alternate teams; capped at 2 per team', () => {
  const g = lobbyGame();
  assert.deepStrictEqual(g.seatOrder().map((p) => p.team), ['red', 'blue', 'red', 'blue']);
  assert.deepStrictEqual(g.seatOrder().map((p) => g.seatOf(p.id)), SEATS);
  assert.strictEqual(g.addPlayer({ playerId: 'e', name: 'Extra' }).reason, 'game-full');
  assert.ok(g.canStart());
});

test('cannot start unless exactly 2 v 2', () => {
  const g = new Game(1);
  g.addPlayer({ playerId: 'a', name: 'A' });
  g.addPlayer({ playerId: 'b', name: 'B' });
  g.addPlayer({ playerId: 'c', name: 'C' });
  assert.ok(!g.canStart());
  g.assignTeam('b', 'red');           // red is full → swaps
  assert.strictEqual(g.teamCount('red'), 2);
  assert.strictEqual(g.start().ok, false);
});

test('dropping onto a full team swaps the two players', () => {
  const g = lobbyGame();
  const r = g.assignTeam('a', 'blue', 'd');
  assert.ok(r.ok);
  assert.strictEqual(r.swappedWith, 'd');
  assert.strictEqual(g.players.get('a').team, 'blue');
  assert.strictEqual(g.players.get('d').team, 'red');
  assert.strictEqual(g.seatOf('a'), 'W');
  assert.strictEqual(g.seatOf('d'), 'N');
  assert.strictEqual(g.teamCount('red'), 2);
  assert.strictEqual(g.teamCount('blue'), 2);
});

test('reorder within a team swaps N and S', () => {
  const g = lobbyGame();
  g.assignTeam('c', 'red', 'a');
  assert.strictEqual(g.seatOf('c'), 'N');
  assert.strictEqual(g.seatOf('a'), 'S');
});

test('addBot honours the requested team and rejects a full one', () => {
  const g = new Game(2);
  g.addPlayer({ playerId: 'a', name: 'A' });
  assert.strictEqual(g.addBot('blue').player.team, 'blue');
  assert.strictEqual(g.addBot('blue').player.team, 'blue');
  assert.strictEqual(g.addBot('blue').reason, 'team-full');
  assert.strictEqual(g.addBot().player.team, 'red');
});

test('kicking is lobby-only', () => {
  const g = lobbyGame();
  g.start();
  assert.strictEqual(g.removePlayer('a'), null);
  assert.strictEqual(g.players.size, 4);
});

// ─────────────────── Bidding ───────────────────

test('left of the dealer bids first; bids go clockwise', () => {
  const g = toBidding(lobbyGame());
  const order = g.seatOrder();
  const first = (g.dealerIndex() + 1) % 4;
  assert.strictEqual(g.currentBidder(), order[first]);
  const wrong = order[(first + 1) % 4];
  g.reveal(wrong.id);
  assert.strictEqual(g.submitBid({ playerId: wrong.id, bid: 3 }).reason, 'not-your-turn');
});

test('the hand stays face down (withheld) until revealed', () => {
  const g = toBidding(lobbyGame());
  const p = g.currentBidder();
  assert.deepStrictEqual(g.getPrivateHand(p.id).hand, []);
  assert.strictEqual(g.getPrivateHand(p.id).canBlindNil, true);
  assert.strictEqual(g.submitBid({ playerId: p.id, bid: 3 }).reason, 'not-looked');
  g.reveal(p.id);
  assert.strictEqual(g.getPrivateHand(p.id).hand.length, 13);
  assert.strictEqual(g.getPrivateHand(p.id).canBlindNil, false);
  assert.strictEqual(g.submitBid({ playerId: p.id, blind: true }).reason, 'already-looked');
});

test('blind nil only while face down', () => {
  const g = toBidding(lobbyGame());
  const p = g.currentBidder();
  const r = g.submitBid({ playerId: p.id, blind: true });
  assert.ok(r.ok);
  assert.ok(p.nil && p.blind && p.revealed);
});

test('bid validation', () => {
  const g = toBidding(lobbyGame());
  const p = g.currentBidder();
  g.reveal(p.id);
  assert.strictEqual(g.submitBid({ playerId: p.id, bid: 14 }).reason, 'bad-bid');
  assert.strictEqual(g.submitBid({ playerId: p.id, bid: -1 }).reason, 'bad-bid');
  assert.strictEqual(g.submitBid({ playerId: p.id, bid: 2.5 }).reason, 'bad-bid');
  assert.ok(g.submitBid({ playerId: p.id, bid: 0 }).nil);
});

test('fourth bid starts the first trick, led by the dealer\'s left', () => {
  const g = toBidding(lobbyGame());
  bidAll(g, [3, 3, 3, 3]);
  assert.strictEqual(g.phase, PHASES.TRICK);
  assert.strictEqual(g.turnIndex, (g.dealerIndex() + 1) % 4);
  g._clearTimers();
});

test('dealer rotates clockwise each hand', () => {
  const g = lobbyGame();
  g.start();
  const d0 = g.dealerIndex();
  g.handIndex += 1;
  assert.strictEqual(g.dealerIndex(), (d0 + 1) % 4);
  g._clearTimers();
});

// ─────────────────── Ending ───────────────────

test('game ends at the target; exact tie plays on; −200 loses', () => {
  const g = lobbyGame();
  g.targetScore = 300;
  g.teams = { red: { score: 310, bags: 0 }, blue: { score: 250, bags: 0 } };
  assert.deepStrictEqual(g._decideWinner(), { team: 'red', reason: 'target' });
  g.teams = { red: { score: 310, bags: 0 }, blue: { score: 310, bags: 0 } };
  assert.strictEqual(g._decideWinner(), null);
  g.teams = { red: { score: -210, bags: 0 }, blue: { score: 40, bags: 0 } };
  assert.deepStrictEqual(g._decideWinner(), { team: 'blue', reason: 'floor' });
  g.teams = { red: { score: 320, bags: 0 }, blue: { score: 350, bags: 0 } };
  assert.strictEqual(g._decideWinner().team, 'blue');
});

// ─────────────────── CPU covering a nil partner ───────────────────

/** A minimal bot view: me at seat 0 (Red), partner at seat 2. */
function coverView({ hand, trick, played, partnerVoids, oppNil }) {
  const seat = (team, extra) => Object.assign({ bid: 3, nil: false, blind: false, tricks: 0, team, voids: {} }, extra);
  return {
    seatIndex: 0,
    hand,
    legal: trick && trick.length
      ? deck.legalPlays({ hand, trick, spadesBroken: false })
      : deck.legalPlays({ hand, trick: [], spadesBroken: false }),
    trick: trick || [],
    trickLeadSeat: trick && trick.length ? 4 - trick.length : 0,
    spadesBroken: false,
    trickNumber: 2,
    played: played || [],
    seats: [
      seat('red', { bid: 4 }),
      seat('blue', oppNil ? { bid: 0, nil: true } : {}),
      seat('red', { bid: 0, nil: true, voids: partnerVoids || {} }),
      seat('blue'),
    ],
    score: { mine: 0, theirs: 0, bags: 0 },
    targetScore: 500,
  };
}

test('covering a nil partner never leads low — even when an opponent is also nil', () => {
  const card = bot.choosePlay(coverView({ hand: ['2H', 'KH', '3D', 'QD'], oppNil: true }), 'hard', Math.random);
  assert.strictEqual(card, 'KH', 'expected the cover with the fewest higher cards out, got ' + card);
});

test('covering a nil partner leads a sure winner when it has one', () => {
  const card = bot.choosePlay(coverView({ hand: ['2H', 'AD', '3D'] }), 'hard', Math.random);
  assert.strictEqual(card, 'AD');
});

test('covering a nil partner may lead low only into a suit partner is void in', () => {
  const card = bot.choosePlay(coverView({ hand: ['2C', 'KH', '3D'], partnerVoids: { C: true } }), 'hard', Math.random);
  assert.strictEqual(card, '2C');
});

test('covering partner who is still to play: overtake with the highest card', () => {
  // Seat 3 led 9H; partner (seat 2) plays after us.
  const v = coverView({ hand: ['3H', 'JH', 'AH'], trick: ['9H'] });
  v.trickLeadSeat = 3;
  assert.strictEqual(bot.choosePlay(v, 'hard', Math.random), 'AH');
});

// ─────────────────── Self-play ───────────────────

/** Drive a full game with CPUs in every seat, synchronously. */
function selfPlay(seed, target) {
  const g = new Game(seed);
  for (let i = 0; i < 4; i++) g.addBot();
  g.targetScore = target || 300;
  g.start();
  let hands = 0;
  for (let guard = 0; guard < 20000 && g.phase !== PHASES.FINAL; guard++) {
    if (g.phase === PHASES.DEAL) { g._enterBid(); continue; }
    if (g.phase === PHASES.BID) {
      const b = g.currentBidder();
      const c = bot.chooseBid(g.botView(b.id), 'hard', g.rng);
      const r = g.submitBid({ playerId: b.id, bid: c.bid, blind: !!c.blind });
      assert.ok(r.ok, 'bot bid rejected: ' + JSON.stringify(r) + ' ' + JSON.stringify(c));
      continue;
    }
    if (g.phase === PHASES.TRICK) {
      const p = g.currentPlayer();
      const card = bot.choosePlay(g.botView(p.id), 'hard', g.rng);
      const r = g.playCard({ playerId: p.id, card });
      assert.ok(r.ok, 'bot play rejected: ' + JSON.stringify(r) + ' ' + card);
      continue;
    }
    if (g.phase === PHASES.TRICK_END) {
      if (g.trickNumber >= 13) g._enterHandEnd(); else g._enterTrick();
      continue;
    }
    if (g.phase === PHASES.HAND_END) {
      hands++;
      const totalTricks = g.seatOrder().reduce((n, p) => n + p.tricks, 0);
      assert.strictEqual(totalTricks, 13);
      g.nextHand();
      continue;
    }
  }
  g._clearTimers();
  return { g, hands };
}

test('CPU self-play always finishes with legal moves', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { g } = selfPlay(seed);
    assert.strictEqual(g.phase, PHASES.FINAL, 'seed ' + seed + ' never finished');
    const f = g.getFinalPublic();
    assert.ok(f.winnerTeam === 'red' || f.winnerTeam === 'blue');
    assert.strictEqual(f.winnerIds.length, 2);
  }
});

test('CPU bids are sensible on average', () => {
  let made = 0;
  let total = 0;
  for (let seed = 100; seed < 160; seed++) {
    const g = new Game(seed);
    for (let i = 0; i < 4; i++) g.addBot();
    g.start(); g._enterBid();
    while (g.phase === PHASES.BID) {
      const b = g.currentBidder();
      const c = bot.chooseBid(g.botView(b.id), 'hard', g.rng);
      g.submitBid({ playerId: b.id, bid: c.bid, blind: !!c.blind });
    }
    while (g.phase !== PHASES.HAND_END) {
      if (g.phase === PHASES.TRICK) {
        const p = g.currentPlayer();
        g.playCard({ playerId: p.id, card: bot.choosePlay(g.botView(p.id), 'hard', g.rng) });
      } else if (g.phase === PHASES.TRICK_END) {
        if (g.trickNumber >= 13) g._enterHandEnd(); else g._enterTrick();
      }
    }
    for (const t of ['red', 'blue']) { total++; if (g.lastHand.teams[t].made) made++; }
    g._clearTimers();
  }
  const rate = made / total;
  console.log('  (CPU contracts made: ' + Math.round(rate * 100) + '%)');
  assert.ok(rate > 0.5, 'CPU teams make too few contracts: ' + rate);
});

// ─────────────────── Report ───────────────────

if (failures.length) {
  for (const f of failures) console.log('✗ ' + f.name + '\n    ' + (f.err && f.err.stack || f.err));
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(1);
}
console.log(passed + ' passed');
process.exit(0);
