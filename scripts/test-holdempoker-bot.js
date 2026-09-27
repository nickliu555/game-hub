'use strict';

// Self-play harness for Hold'em Poker — no server, no network. Plays many
// seeded tournaments with CPUs (and with a random-action fuzzer that hammers
// side pots and short all-ins), asserting that every action is legal, chips
// are conserved every hand, and every tournament ends with one winner.
//   node scripts/test-holdempoker-bot.js   (or: npm run test:holdempoker-bot)

const assert = require('assert');
const path = require('path');

const { Game, PHASES, START_STACK } = require(path.join('..', 'server', 'holdempoker', 'game'));
const { chooseAction } = require(path.join('..', 'server', 'holdempoker', 'bot'));
const { makeRng } = require(path.join('..', 'server', 'holdempoker', 'deck'));

function randomAction(view, rng) {
  const opts = [];
  if (view.canCheck) opts.push({ type: 'check' });
  else { opts.push({ type: 'fold' }); opts.push({ type: 'call' }); }
  if (view.canRaise) {
    const span = view.maxRaiseTo - view.minRaiseTo;
    opts.push({ type: 'raise', amount: view.minRaiseTo });
    opts.push({ type: 'raise', amount: view.maxRaiseTo });
    opts.push({ type: 'raise', amount: view.minRaiseTo + Math.floor(rng() * (span + 1)) });
  }
  return opts[Math.floor(rng() * opts.length)];
}

function play(seed, seats, decide) {
  const g = new Game(seed);
  g.manualTimers = true;
  for (let i = 0; i < seats; i++) g.addBot();
  g.setHandsPerLevel([2, 3, 5, 7][seed % 4]);
  g.start();
  const rng = makeRng(seed * 7 + 1);
  const total = START_STACK * seats;
  let lastHand = 0;
  let steps = 0;
  while (g.phase !== PHASES.FINAL) {
    if (++steps > 400000) throw new Error('seed ' + seed + ': tournament never ended');
    if (g.phase === PHASES.BETTING && g.turnId) {
      const view = g.botView(g.turnId);
      const choice = decide(view, rng);
      const r = g.act(Object.assign({ playerId: g.turnId }, choice));
      assert.ok(r.ok, 'seed ' + seed + ' hand ' + g.handNumber + ': illegal ' + JSON.stringify(choice) + ' → ' + JSON.stringify(r));
    } else {
      assert.ok(g.tick(), 'seed ' + seed + ': stalled in ' + g.phase);
    }
    if (g.phase === PHASES.HAND_END && g.handNumber !== lastHand) {
      lastHand = g.handNumber;
      let sum = 0;
      for (const p of g.players.values()) sum += p.stack;
      assert.strictEqual(sum, total, 'seed ' + seed + ': chips leaked at hand ' + g.handNumber);
      const potSum = g.result.pots.reduce((a, pot) => a + pot.amount, 0);
      const wonSum = g.result.pots.reduce((a, pot) => a + pot.winners.reduce((b, w) => b + w.amount, 0), 0);
      assert.strictEqual(potSum, wonSum, 'seed ' + seed + ': a pot was not fully paid out');
      for (const p of g.players.values()) assert.ok(p.stack >= 0);
    }
  }
  const fin = g.getFinalPublic();
  assert.strictEqual(fin.standings[0].stack, total);
  const places = fin.standings.map((s) => s.place);
  assert.strictEqual(places[0], 1);
  for (let i = 1; i < places.length; i++) assert.ok(places[i] >= places[i - 1]);
  return g.handNumber;
}

let hands = 0;
let tournaments = 0;
const t0 = Date.now();
for (let seed = 1; seed <= 40; seed++) {
  hands += play(seed, 2 + (seed % 7), chooseAction);
  tournaments++;
}
for (let seed = 1000; seed < 1300; seed++) {
  hands += play(seed, 2 + (seed % 7), randomAction);
  tournaments++;
}
console.log('✓ holdempoker bots: ' + tournaments + ' tournaments, ' + hands + ' hands, all legal and conserved (' +
  ((Date.now() - t0) / 1000).toFixed(1) + 's)');
