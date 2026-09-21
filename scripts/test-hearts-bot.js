'use strict';

// Headless self-play tests for the Hearts CPUs. Plays thousands of seeded
// hands with no server and no network, asserting that a bot can never be the
// reason an illegal card hits the table, that hands always complete, that
// points reconcile, and that the difficulty ladder actually means something.
//
//   node scripts/test-hearts-bot.js   (or: npm run test:hearts-bot)

const assert = require('assert');
const path = require('path');

const deck = require(path.join('..', 'server', 'hearts', 'deck'));
const { Game, PHASES } = require(path.join('..', 'server', 'hearts', 'game'));
const bot = require(path.join('..', 'server', 'hearts', 'bot'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push({ name, err: e }); }
}

const IDS = ['b0', 'b1', 'b2', 'b3'];

/**
 * Play one complete hand with four CPUs of the given difficulty, driving the
 * phases directly so no timers are involved.
 * @returns {{ rows: object[], tricks: number, cardsSeen: string[] }}
 */
function playHand(difficulty, seed, handIndex) {
  const g = new Game(seed);
  IDS.forEach((id, i) => {
    const r = g.addBot();
    assert.ok(r.ok, 'addBot ' + i);
  });
  g.setBotDifficulty(difficulty);
  const players = g.seatOrder();
  g.handIndex = handIndex || 0;
  g._enterDeal();
  g._clearTimers();

  // Everyone starts with 13 cards and the whole deck is in play.
  const dealt = [];
  for (const p of players) {
    assert.strictEqual(p.hand.length, 13, 'deal size');
    dealt.push.apply(dealt, p.hand);
  }
  assert.strictEqual(new Set(dealt).size, 52, 'deal conserves the deck');

  if (g.passDirection() !== 'hold') {
    g._enterPass();
    for (const p of players) {
      const cards = bot.choosePass(p.hand, difficulty, g.rng);
      assert.strictEqual(cards.length, 3, 'pass returns exactly 3');
      assert.strictEqual(new Set(cards).size, 3, 'pass has no duplicates');
      for (const c of cards) assert.ok(p.hand.indexOf(c) >= 0, 'passed a card it did not hold');
      assert.ok(g.submitPass({ playerId: p.id, cards }).ok, 'pass accepted');
    }
    assert.strictEqual(g.phase, PHASES.EXCHANGE);
    g._clearTimers();
    g._enterTrick();
  } else {
    g._enterTrick();
  }
  g._clearTimers();

  const played = [];
  let guard = 0;
  while (g.phase !== PHASES.HAND_END && guard++ < 300) {
    if (g.phase === PHASES.TRICK_END) {
      assert.strictEqual(g.trick.length, 4, 'a completed trick holds 4 cards');
      if (g.trickNumber >= 13) g._enterHandEnd(); else g._enterTrick();
      g._clearTimers();
      continue;
    }
    const p = g.currentPlayer();
    const legal = g.legalFor(p.id);
    assert.ok(legal.length > 0, 'a player always has a legal move');

    const card = bot.choosePlay({
      hand: p.hand,
      legal,
      trick: g.trick.map((t) => t.card),
      heartsBroken: g.heartsBroken,
      trickNumber: g.trickNumber,
      seen: g.seenCards(),
    }, difficulty, g.rng);

    // The invariant that matters most.
    assert.ok(legal.indexOf(card) >= 0,
      difficulty + '/seed ' + seed + ': bot chose ' + card + ' which is not legal (' + legal.join(',') + ')');

    const res = g.playCard({ playerId: p.id, card });
    assert.ok(res.ok, 'server accepted the bot card: ' + JSON.stringify(res));
    played.push(card);
  }

  assert.strictEqual(g.phase, PHASES.HAND_END, 'hand finished');
  assert.strictEqual(g.trickNumber, 13, 'exactly 13 tricks');
  assert.strictEqual(played.length, 52, 'every card was played once');
  assert.strictEqual(new Set(played).size, 52, 'no card played twice');
  for (const p of players) assert.strictEqual(p.hand.length, 0, 'hands are empty');

  const rows = g.lastHand.rows;
  g._clearTimers();
  return { rows, game: g };
}

// ──────────────────────── Settings ────────────────────────

test('settings: every difficulty has a think-time and the ladder is ordered', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    const s = bot.BOT_SETTINGS[level];
    assert.ok(s && s.playMs > 0 && s.passMs > 0, level + ' has think-times');
    assert.ok(s.passMs > s.playMs, level + ': passing takes longer than playing');
  }
  assert.ok(bot.BOT_SETTINGS.easy.playMs > bot.BOT_SETTINGS.hard.playMs,
    'harder CPUs act more decisively');
});

test('settings: an unknown difficulty falls back to normal', () => {
  assert.strictEqual(bot.normalizeDifficulty('impossible'), 'normal');
  assert.strictEqual(bot.normalizeDifficulty(undefined), 'normal');
  assert.strictEqual(bot.normalizeDifficulty('hard'), 'hard');
});

// ──────────────────── Legality under self-play ────────────────────

for (const level of ['easy', 'normal', 'hard']) {
  test(level + ': 150 seeded hands are all legal, complete and conserve the deck', () => {
    for (let seed = 1; seed <= 150; seed++) playHand(level, seed * 31, seed % 4);
  });
}

test('all pass directions are exercised, including the hold hand', () => {
  for (let handIndex = 0; handIndex < 4; handIndex++) {
    for (let seed = 1; seed <= 15; seed++) playHand('normal', 500 + seed, handIndex);
  }
});

// ──────────────────── Scoring reconciliation ────────────────────

test('points reconcile every hand: 26, or a moon, with J♦ worth exactly −10', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const { rows } = playHand('hard', 900 + seed, seed % 4);
    const jackRow = rows.find((r) => r.jack);
    assert.ok(jackRow, 'seed ' + seed + ': somebody must capture the J♦');
    assert.strictEqual(rows.filter((r) => r.jack).length, 1, 'only one J♦');
    assert.strictEqual(rows.filter((r) => r.queen).length, 1, 'only one Q♠');

    const moon = rows.find((r) => r.shotMoon);
    const base = rows.reduce((s, r) => s + r.delta, 0) + 10; // undo the J♦
    if (moon) {
      assert.strictEqual(base, 78, 'seed ' + seed + ': a moon costs the other three 26 each');
      assert.strictEqual(rows.filter((r) => r.shotMoon).length, 1);
    } else {
      assert.strictEqual(base, 26, 'seed ' + seed + ': hearts + Q♠ always total 26');
      const heartsTaken = rows.reduce((s, r) => s + r.hearts, 0);
      assert.strictEqual(heartsTaken, 13, 'seed ' + seed + ': all 13 hearts are accounted for');
    }
  }
});

test('the J♦ is never passed away by a thinking CPU', () => {
  for (const level of ['normal', 'hard']) {
    let handled = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rng = deck.makeRng(seed * 7 + 1);
      const hands = deck.deal(rng);
      for (const hand of hands) {
        if (hand.indexOf(deck.JACK_OF_DIAMONDS) < 0) continue;
        handled++;
        const out = bot.choosePass(hand, level, rng);
        assert.ok(out.indexOf(deck.JACK_OF_DIAMONDS) < 0,
          level + ': passed away the −10 bonus card');
      }
    }
    assert.ok(handled > 300, 'sampled enough J♦ hands (' + handled + ')');
  }
});

test('a thinking CPU sheds the Q♠ unless it is well guarded', () => {
  const rng = deck.makeRng(4242);
  // Q♠ with only one low guard is a liability — it should go.
  const risky = ['QS', '2S', 'AH', 'KH', 'QH', '9C', '8C', '7C', '6D', '5D', '4D', '3D', '2D'];
  const out = bot.choosePass(risky, 'hard', rng);
  assert.ok(out.indexOf('QS') >= 0, 'an unguarded Queen should be passed');
  assert.strictEqual(out.length, 3);
  for (const c of out) assert.ok(risky.indexOf(c) >= 0);
});

// ──────────────────── Difficulty actually matters ────────────────────

test('a head-to-head table: 2 hard CPUs beat 2 easy CPUs over 300 hands', () => {
  let hardTotal = 0;
  let easyTotal = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const g = new Game(6000 + seed);
    for (let i = 0; i < 4; i++) g.addBot();
    const players = g.seatOrder();
    // Seats N and S play hard; E and W play easy.
    const levelOf = (i) => (i % 2 === 0 ? 'hard' : 'easy');
    g.handIndex = seed % 4;
    g._enterDeal();
    g._clearTimers();

    if (g.passDirection() !== 'hold') {
      g._enterPass();
      players.forEach((p, i) => {
        g.submitPass({ playerId: p.id, cards: bot.choosePass(p.hand, levelOf(i), g.rng) });
      });
      g._clearTimers();
      g._enterTrick();
    } else {
      g._enterTrick();
    }
    g._clearTimers();

    let guard = 0;
    while (g.phase !== PHASES.HAND_END && guard++ < 300) {
      if (g.phase === PHASES.TRICK_END) {
        if (g.trickNumber >= 13) g._enterHandEnd(); else g._enterTrick();
        g._clearTimers();
        continue;
      }
      const p = g.currentPlayer();
      const i = players.indexOf(p);
      const legal = g.legalFor(p.id);
      const card = bot.choosePlay({
        hand: p.hand, legal,
        trick: g.trick.map((t) => t.card),
        heartsBroken: g.heartsBroken,
        trickNumber: g.trickNumber,
        seen: g.seenCards(),
      }, levelOf(i), g.rng);
      assert.ok(legal.indexOf(card) >= 0, 'head-to-head: illegal card ' + card);
      assert.ok(g.playCard({ playerId: p.id, card }).ok);
    }
    players.forEach((p, i) => {
      if (i % 2 === 0) hardTotal += p.lastDelta; else easyTotal += p.lastDelta;
    });
    g._clearTimers();
  }
  assert.ok(hardTotal < easyTotal,
    'hard seats should finish with fewer points (hard ' + hardTotal + ' vs easy ' + easyTotal + ')');
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
console.log('✓ hearts CPUs: ' + passed + ' tests passed');
