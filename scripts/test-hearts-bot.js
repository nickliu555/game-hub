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
const endgame = require(path.join('..', 'server', 'hearts', 'endgame'));

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

    const card = bot.choosePlay(g.botView(p.id), difficulty, g.rng);

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

// ──────────────────── Skill: the J♦ bonus ────────────────────

/** A one-off decision with a hand-built table, for pinning specific mistakes. */
function decide(view, level) {
  return bot.choosePlay(Object.assign({
    heartsBroken: true, trickNumber: 6, seen: [], taken: [[], [], [], []],
    voids: [{}, {}, {}, {}], seatIndex: 0,
  }, view), level, deck.makeRng(1));
}

test('hard keeps Q♦/K♦/A♦ — they are what captures the −10 J♦', () => {
  const rng = deck.makeRng(99);
  // Three obvious throwaways sit alongside the diamond honours.
  const hand = ['AD', 'KD', 'QD', '4D', 'AS', 'KS', 'AH', '9C', '8C', '7C', '6C', '5C', '4C'];
  const out = bot.choosePass(hand, 'hard', rng);
  for (const c of ['AD', 'KD', 'QD']) {
    assert.ok(out.indexOf(c) < 0, 'hard passed away a Jack-catcher: ' + c);
  }
});

test('hard never discards a Jack-catcher while the J♦ is still out', () => {
  // Void in clubs, so anything goes. A♦ must survive; A♥ is the right dump.
  const card = decide({
    hand: ['AD', 'KD', 'AH', '2S'],
    legal: ['AD', 'KD', 'AH', '2S'],
    trick: ['9C'],
    taken: [[], ['2H'], [], []], // somebody has points, so no moon is on
  }, 'hard');
  assert.strictEqual(card, 'AH', 'hard should dump the A♥, not a Jack-catcher (got ' + card + ')');
});

test('hard does not duck with the J♦ under a bigger diamond', () => {
  const card = decide({
    hand: ['JD', '4D', '3D'],
    legal: ['JD', '4D', '3D'],
    trick: ['AD', '7D'],
  }, 'hard');
  assert.strictEqual(card, '4D', 'the J♦ must not be gifted to the A♦ (got ' + card + ')');
});

test('hard cashes the J♦ on a diamond trick it is certain to win', () => {
  const card = decide({
    hand: ['JD', '3D'],
    legal: ['JD', '3D'],
    trick: ['5D', '2D', '8D'], // last seat, no points on the table
  }, 'hard');
  assert.strictEqual(card, 'JD', 'last in with the Jack winning: take the −10 (got ' + card + ')');
});

test('hard leads the J♦ once no diamond left out can beat it', () => {
  const seen = ['AD', 'KD', 'QD', '2D', '3D', '4D', '5D'];
  const card = decide({
    hand: ['JD', '2C', '2S'],
    legal: ['JD', '2C', '2S'],
    trick: [],
    seen: seen.concat(['QS']), // Queen already gone, so nothing can be dropped on it
    taken: [seen.concat(['QS']), [], [], []],
    seatIndex: 1,
  }, 'hard');
  assert.strictEqual(card, 'JD', 'a boss J♦ on lead is a free −10 (got ' + card + ')');
});

test('hard grabs a J♦ sitting in the trick', () => {
  const card = decide({
    hand: ['AD', '2D', '2S'],
    legal: ['AD', '2D'],
    trick: ['3D', 'JD'],
  }, 'hard');
  assert.strictEqual(card, 'AD', 'the A♦ is there to win the bonus (got ' + card + ')');
});

test('hard will not lead a J♦ anything out there can still beat', () => {
  const card = decide({
    hand: ['JD', '4C', '3S'],
    legal: ['JD', '4C', '3S'],
    trick: [],
    seen: [], // A♦/K♦/Q♦ are all still out
  }, 'hard');
  assert.notStrictEqual(card, 'JD', 'leading a beatable J♦ gifts the −10 away');
});

test('hard cashes a certain J♦ even in the middle of shooting the moon', () => {
  const seen = ['AD', 'KD', 'QD'];
  const card = decide({
    hand: ['JD', 'AS', 'AC'], // every card is a winner, so the moon run is on
    legal: ['JD', 'AS', 'AC'],
    trick: [],
    seen,
    taken: [seen, [], [], []], // nobody else has taken a point
    seatIndex: 0,
  }, 'hard');
  assert.strictEqual(card, 'JD', 'the −10 outranks the moon run (got ' + card + ')');
});

// ──────────────────── Skill: leading for a void ────────────────────

test('hard spends a lead on its singleton to buy the void it needs', () => {
  const card = decide({
    hand: ['QS', '6S', '5S', '4S', '3S', '2S', '7C', '6C', '5C', '4C', '3C', 'KH', '8D'],
    legal: ['QS', '6S', '5S', '4S', '3S', '2S', '7C', '6C', '5C', '4C', '3C', 'KH', '8D'],
    trick: [],
  }, 'hard');
  assert.strictEqual(card, '8D',
    'the lone diamond is the void that buries the Queen later (got ' + card + ')');
});

test('hard leads spades to flush the Queen when nothing of hers can catch us', () => {
  const card = decide({
    hand: ['9S', '4S', '8C', '7C', '6C', '5H'],
    legal: ['9S', '4S', '8C', '7C', '6C', '5H'],
    trick: [],
  }, 'hard');
  assert.strictEqual(card, '4S',
    'no Q♠/K♠/A♠ of our own: spades are the free lead (got ' + card + ')');
});

test('hard stops leading spades once it is the A♠ waiting to be caught', () => {
  const card = decide({
    hand: ['AS', '4S', '8C', '7C', '6C'],
    legal: ['AS', '4S', '8C', '7C', '6C'],
    trick: [],
  }, 'hard');
  assert.ok(deck.suitOf(card) !== 'S',
    'every spade round burns a guard in front of our A♠ (got ' + card + ')');
});

// ──────────────────── Skill: shedding danger ────────────────────

test('hard sheds a master card into a trick that costs nothing', () => {
  const seen = ['2C', '3C', '4C', '5C', '6C', '7C', '8C'];
  const card = decide({
    hand: ['AC', '9C', '2S'],
    legal: ['AC', '9C'],
    trick: ['JC', 'QC', 'KC'], // last seat, zero points, A♣ has to go some time
    seen: seen.concat(['JC', 'QC', 'KC']),
    taken: [seen, [], [], []],
    seatIndex: 1,
  }, 'hard');
  assert.strictEqual(card, 'AC', 'a free trick is the cheapest place to burn the A♣ (got ' + card + ')');
});

test('hard ducks rather than taking a trick with points in it', () => {
  const card = decide({
    hand: ['AC', '2C'],
    legal: ['AC', '2C'],
    trick: ['9C', 'QS', 'AH'],
  }, 'hard');
  assert.strictEqual(card, '2C', 'never win a trick holding the Queen (got ' + card + ')');
});

test('hard unloads the Q♠ the moment the trick is already beyond her', () => {
  const card = decide({
    hand: ['QS', '4S', '3S'],
    legal: ['QS', '4S', '3S'],
    trick: ['AS'], // the ace is down, so she cannot win this one
  }, 'hard');
  assert.strictEqual(card, 'QS', 'the Queen goes at the first safe chance (got ' + card + ')');
});

test('hard burns the A♠ on a free spade trick instead of nursing it', () => {
  const card = decide({
    hand: ['AS', '2S', '2C'],
    legal: ['AS', '2S'],
    trick: ['5S', '9S', 'JS'], // last seat, nothing to lose, Q♠ still out there
  }, 'hard');
  assert.strictEqual(card, 'AS', 'the A♠ is only ever a Queen-catcher (got ' + card + ')');
});

test('hard will not put the K♠/A♠ on a spade lead that can still be caught', () => {
  const card = decide({
    hand: ['AS', 'KS', '3S'],
    legal: ['AS', 'KS', '3S'],
    trick: ['5S', '9S'],         // a fourth player is still to come
    taken: [[], ['2H'], [], []], // somebody has points, so no moon is on
  }, 'hard');
  assert.strictEqual(card, '3S',
    'a winning K♠/A♠ is where the Queen gets dropped (got ' + card + ')');
});

test('hard refuses a spade trick the Queen is already sitting in', () => {
  const card = decide({
    hand: ['AS', 'KS', '3S'],
    legal: ['AS', 'KS', '3S'],
    trick: ['5S', 'QS', '9S'],   // last seat, but she is on the table
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.strictEqual(card, '3S', 'winning here eats the Queen (got ' + card + ')');
});

test('hard will not lead the A♠ while the Queen is still out there', () => {
  const card = decide({
    hand: ['AS', '7C', '6C', '5C'],
    legal: ['AS', '7C', '6C', '5C'],
    trick: [],
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.notStrictEqual(card, 'AS', 'leading the A♠ invites the Queen straight onto it');
});

// ──────────────── Skill: a trick we cannot avoid winning ────────────────

test('hard spends its biggest card on a trick it is already stuck winning', () => {
  const card = decide({
    hand: ['AC', 'KC', '9C'],
    legal: ['AC', 'KC', '9C'],
    trick: ['2C', '3C', '7H'],   // last seat, nothing ducks under the 3♣
    taken: [[], ['2H'], [], []], // the points are split, so no moon is on
  }, 'hard');
  assert.strictEqual(card, 'AC',
    'the trick is ours whatever we play — shed the A♣ (got ' + card + ')');
});

test('hard still refuses to add its own Queen to a trick it is stuck winning', () => {
  const card = decide({
    hand: ['QS', 'KS', 'AS'],
    legal: ['QS', 'KS', 'AS'],
    trick: ['5S', '6S', '7H'],   // last seat, and nothing here ducks the 6♠
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.strictEqual(card, 'AS', 'dumping our own Queen into it costs 13 (got ' + card + ')');
});

test('hard takes a trick it cannot duck as cheaply as it can when others follow', () => {
  const card = decide({
    hand: ['AC', 'KC', '9C'],
    legal: ['AC', 'KC', '9C'],
    trick: ['2C', '3C'],         // two still to play — a big card can be beaten
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.strictEqual(card, '9C', 'with players behind us the cheap card is right');
});

test('hard spends its biggest diamond on the trick that hands it the J♦', () => {
  const card = decide({
    hand: ['AD', 'QD', '2D'],
    legal: ['AD', 'QD', '2D'],
    trick: ['5D', 'JD', '3D'],   // last seat, the −10 is already on the table
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.strictEqual(card, 'AD',
    'the J♦ is ours either way — take it with the card we want gone (got ' + card + ')');
});

test('hard breaks a moon with its biggest card when it is last to act', () => {
  const card = decide({
    hand: ['AC', 'KC', '2C'],
    legal: ['AC', 'KC', '2C'],
    trick: ['5C', '6C', '7H'],   // last seat, a heart in the pot
    taken: [[], ['2H', '3H', '4H', '5H', '6H'], [], []], // seat 1 is shooting
  }, 'hard');
  assert.strictEqual(card, 'AC',
    'we are taking these points on purpose — shed the A♣ doing it (got ' + card + ')');
});

// ──────────── Skill: covering a loose J♦ on a diamond trick ────────────

test('hard covers a diamond trick the J♦ could still steal', () => {
  const card = decide({
    hand: ['KD', 'QD', '3D'],
    legal: ['KD', 'QD', '3D'],
    trick: ['4D', '9D'],         // nothing above the Jack yet, one seat behind us
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.strictEqual(card, 'QD',
    'the cheapest catcher stops a free J♦ drop (got ' + card + ')');
});

test('hard does not burn a catcher once the J♦ is already covered', () => {
  const card = decide({
    hand: ['AD', '3D', '2D'],
    legal: ['AD', '3D', '2D'],
    trick: ['4D', 'KD'],         // the K♦ already tops the Jack
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.strictEqual(card, '3D', 'somebody else is holding the cover (got ' + card + ')');
});

test('hard does not cover when it is holding the J♦ itself', () => {
  const card = decide({
    hand: ['JD', 'KD', '3D'],
    legal: ['JD', 'KD', '3D'],
    trick: ['4D', '9D'],
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.strictEqual(card, '3D', 'there is no loose Jack to catch (got ' + card + ')');
});

test('hard does not cover when nobody is left to drop the J♦', () => {
  const card = decide({
    hand: ['KD', 'QD', '3D'],
    legal: ['KD', 'QD', '3D'],
    trick: ['4D', '9D', '2D'],   // last seat — the Jack can no longer be played
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.strictEqual(card, '3D', 'nothing to protect against (got ' + card + ')');
});

test('hard does not cover with two opponents still behind it', () => {
  const card = decide({
    hand: ['KD', 'QD', '3D'],
    legal: ['KD', 'QD', '3D'],
    trick: ['9D'],               // two seats left — either can play over the Q♦
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.strictEqual(card, '3D', 'the catcher would just be topped (got ' + card + ')');
});

// ──────── Skill: a table that has shown out is as good as being last ────────

// Seats 2 and 3 have played, we are seat 0, and seat 1 is the only one left.
const sealedTable = { trickLeadSeat: 2, voids: [{}, { C: true, D: true }, {}, {}] };

test('hard cashes the J♦ once the only seat left cannot follow diamonds', () => {
  const card = decide(Object.assign({
    hand: ['JD', '2D'],
    legal: ['JD', '2D'],
    trick: ['5D', '9D'],         // bigger diamonds are still out, but not behind us
    taken: [[], ['2H'], [], []],
  }, sealedTable), 'hard');
  assert.strictEqual(card, 'JD', 'the −10 was there for the taking (got ' + card + ')');
});

test('hard still ducks when the seat behind it can follow', () => {
  const card = decide({
    hand: ['JD', '2D'],
    legal: ['JD', '2D'],
    trick: ['5D', '9D'],
    trickLeadSeat: 2,            // seat 1 is live — Q♦/K♦/A♦ could still land
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.strictEqual(card, '2D', 'handed the J♦ to a live seat (got ' + card + ')');
});

test('hard spends its master on a sealed trick that costs nothing', () => {
  const card = decide(Object.assign({
    hand: ['AC', 'KC', '3C'],
    legal: ['AC', 'KC', '3C'],
    trick: ['5C', '9C'],
    taken: [[], ['2H'], [], []],
  }, sealedTable), 'hard');
  assert.strictEqual(card, 'AC', 'a free trick is the cheapest place for it (got ' + card + ')');
});

// ──────────────────── Skill: the endgame search ────────────────────

/** A consistent endgame view: everything not held and not outstanding is spent. */
function endgameView(hand, outstanding, extra) {
  const seen = [];
  for (const s of deck.SUITS) {
    for (const r of deck.RANKS) {
      const c = r + s;
      if (hand.indexOf(c) < 0 && outstanding.indexOf(c) < 0) seen.push(c);
    }
  }
  return Object.assign({
    seatIndex: 0, trickLeadSeat: 0, hand: hand.slice(), legal: hand.slice(),
    trick: [], seen, heartsBroken: true, trickNumber: 12,
    voids: [{}, {}, {}, {}], passedTo: -1, passedCards: [],
  }, extra);
}

test('endgame search avoids the lead that feeds itself the Q♠', () => {
  // Leading A♠ drags the Queen out onto our own trick; the club lead leaves
  // the spade to be discarded harmlessly on somebody else's club.
  const view = endgameView(['AS', '2C'], ['QS', '3C', '4C', '5C', '6C', '7C']);
  const card = endgame.solve(view, deck.makeRng(7));
  assert.strictEqual(card, '2C', 'the ace eats the Queen (got ' + card + ')');
});

test('endgame search declines a position too big to search', () => {
  const hand = ['AS', 'KS', '2C', '3C', '4C', '5C'];
  const out = [];
  for (const s of deck.SUITS) {
    for (const r of deck.RANKS) {
      const c = r + s;
      if (hand.indexOf(c) < 0 && out.length < 18) out.push(c);
    }
  }
  assert.strictEqual(endgame.solve(endgameView(hand, out), deck.makeRng(3)), null,
    'searched a position it cannot afford');
});

test('endgame search refuses an inconsistent table rather than guessing', () => {
  // Hand sizes that cannot be squared with the cards still unaccounted for.
  const view = endgameView(['AS', '2C'], ['QS', '3C']);
  assert.strictEqual(endgame.solve(view, deck.makeRng(5)), null, 'accepted an impossible table');
});

test('hard will not lead a suit the rest of the table has shown out of', () => {
  const card = decide({
    hand: ['2C', '9H'],
    legal: ['2C', '9H'],
    trick: [],
    voids: [{}, { C: true }, { C: true }, { C: true }],
    seatIndex: 0,
  }, 'hard');
  assert.strictEqual(card, '9H', 'leading into three discards is a gift (got ' + card + ')');
});

// ──────────────────── Skill: moon defence ────────────────────

test('hard breaks up a moon run instead of ducking politely', () => {
  const hearts = ['2H', '3H', '4H', '5H', '6H', '7H'];
  const card = decide({
    hand: ['AC', '2C'],
    legal: ['AC', '2C'],
    trick: ['9C', '8C', '4H'], // last seat, one heart on the table
    seen: hearts.concat(['9C', '8C']),
    taken: [[], hearts, [], []], // seat 1 has swallowed every point so far
    seatIndex: 0,
  }, 'hard');
  assert.strictEqual(card, 'AC', 'take the heart and end the run (got ' + card + ')');
});

// ──────────────────── Skill: moon offence ────────────────────

test('a CPU running the table hangs on to the points instead of dumping them', () => {
  const card = decide({
    hand: ['QS', 'AH', 'AD'],
    legal: ['QS', 'AH', 'AD'], // void in clubs, so anything can go
    trick: ['9C'],
    seen: ['AS', 'KS'], // nothing left out there beats a card in this hand
  }, 'hard');
  assert.strictEqual(card, 'AD', 'the moon needs the Queen and the hearts (got ' + card + ')');
});

test('once somebody else has points the same hand dumps the Queen as usual', () => {
  const card = decide({
    hand: ['QS', 'AH', 'AD'],
    legal: ['QS', 'AH', 'AD'],
    trick: ['9C'],
    seen: ['AS', 'KS', '2H'],
    taken: [[], ['2H'], [], []], // the run is already dead
  }, 'hard');
  assert.strictEqual(card, 'QS', 'no moon on: the Queen goes (got ' + card + ')');
});

// ──────────────── Skill: never lead the points onto our own trick ────────────────

for (const level of ['normal', 'hard']) {
  test(level + ' never leads the Q♠ with a safe card in hand', () => {
    const card = decide({
      hand: ['QS', '3S', '7C', '6C', '5C', '4D'],
      legal: ['QS', '3S', '7C', '6C', '5C', '4D'],
      trick: [],
      taken: [[], ['2H'], [], []], // no moon on
    }, level);
    assert.notStrictEqual(card, 'QS', 'leading the Queen is 13 points onto our own trick');
  });

  test(level + ' never leads a high heart with a safe card in hand', () => {
    const card = decide({
      hand: ['AH', 'KH', 'QH', 'JH', '8H', '7C', '6C', '5C', '4D'],
      legal: ['AH', 'KH', 'QH', 'JH', '8H', '7C', '6C', '5C', '4D'],
      trick: [],
      taken: [[], ['2H'], [], []],
    }, level);
    assert.ok(!deck.isHeart(card),
      'a heart nothing ducks under wins its own trick and eats the discards (got ' + card + ')');
  });
}

test('hard leads the Q♠ when every spade still out beats her', () => {
  const card = decide({
    // Five cards keeps this out of the exact endgame search, which has its own
    // tests — this is about the lead heuristics.
    hand: ['QS', '8C', '7C', '6C', '5C'],
    legal: ['QS', '8C', '7C', '6C', '5C'],
    trick: [],
    // Every spade below her is gone, so whoever follows has to take her.
    seen: ['2S', '3S', '4S', '5S', '6S', '7S', '8S', '9S', '10S', 'JS'],
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.strictEqual(card, 'QS', 'the K♠/A♠ are forced to eat her (got ' + card + ')');
});

test('hard will not lead the Q♠ once nobody is left to follow spades', () => {
  const card = decide({
    hand: ['QS', '8C', '7C', '6C', '5C'],
    legal: ['QS', '8C', '7C', '6C', '5C'],
    trick: [],
    seen: ['2S', '3S', '4S', '5S', '6S', '7S', '8S', '9S', '10S', 'JS'],
    voids: [{}, { S: true }, { S: true }, { S: true }], // she would win her own trick
    taken: [[], ['2H'], [], []],
  }, 'hard');
  assert.notStrictEqual(card, 'QS', 'a table void in spades hands her straight back to us');
});

test('a CPU shooting the moon still leads its high hearts', () => {
  const card = decide({
    hand: ['AH', 'KH', 'AD'],
    legal: ['AH', 'KH', 'AD'],
    trick: [],
    seen: ['QH', 'JH', 'KD', 'QD'], // nothing left beats this hand
  }, 'hard');
  assert.ok(deck.isHeart(card), 'the run needs the hearts taken, not ducked (got ' + card + ')');
});

// ──────────────────── Difficulty actually matters ────────────────────

/**
 * Sit two of each level at the table (N/S vs E/W) and total what each pair
 * pays over `hands` seeded deals.
 * @returns {{ even: number, odd: number }}
 */
function headToHead(evenLevel, oddLevel, hands, base) {
  const levelOf = (i) => (i % 2 === 0 ? evenLevel : oddLevel);
  let even = 0;
  let odd = 0;
  for (let seed = 1; seed <= hands; seed++) {
    const g = new Game(base + seed);
    for (let i = 0; i < 4; i++) g.addBot();
    const players = g.seatOrder();
    g.handIndex = seed % 4;
    g._enterDeal();
    g._clearTimers();

    if (g.passDirection() !== 'hold') {
      g._enterPass();
      players.forEach((p, i) => {
        g.submitPass({ playerId: p.id, cards: bot.choosePass(p.hand, levelOf(i), g.rng) });
      });
      g._clearTimers();
    }
    g._enterTrick();
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
      const card = bot.choosePlay(g.botView(p.id), levelOf(i), g.rng);
      assert.ok(legal.indexOf(card) >= 0, 'head-to-head: illegal card ' + card);
      assert.ok(g.playCard({ playerId: p.id, card }).ok);
    }
    players.forEach((p, i) => {
      if (i % 2 === 0) even += p.lastDelta; else odd += p.lastDelta;
    });
    g._clearTimers();
  }
  return { even, odd };
}

test('a head-to-head table: 2 hard CPUs beat 2 easy CPUs over 300 hands', () => {
  const { even, odd } = headToHead('hard', 'easy', 300, 6000);
  assert.ok(even < odd,
    'hard seats should finish with fewer points (hard ' + even + ' vs easy ' + odd + ')');
});

test('a head-to-head table: 2 hard CPUs beat 2 normal CPUs over 400 hands', () => {
  const { even, odd } = headToHead('hard', 'normal', 400, 12000);
  assert.ok(even < odd,
    'hard seats should finish with fewer points (hard ' + even + ' vs normal ' + odd + ')');
});

test('a head-to-head table: 2 normal CPUs beat 2 easy CPUs over 300 hands', () => {
  const { even, odd } = headToHead('normal', 'easy', 300, 18000);
  assert.ok(even < odd,
    'normal seats should finish with fewer points (normal ' + even + ' vs easy ' + odd + ')');
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
