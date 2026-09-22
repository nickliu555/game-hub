'use strict';
// Temp mirror-match A/B: current bot.js vs the snapshot in .bot-baseline.js.
const path = require('path');
const assert = require('assert');
const { Game, PHASES } = require(path.join('..', 'server', 'hearts', 'game'));
const NEW = require(path.join('..', 'server', 'hearts', 'bot.js'));
const OLD = require(path.join('..', 'server', 'hearts', '.bot-baseline.js'));

function headToHead(evenBot, oddBot, hands, base) {
  const botOf = (i) => (i % 2 === 0 ? evenBot : oddBot);
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
        g.submitPass({ playerId: p.id, cards: botOf(i).choosePass(p.hand, 'hard', g.rng) });
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
      const card = botOf(i).choosePlay(g.botView(p.id), 'hard', g.rng);
      assert.ok(g.legalFor(p.id).indexOf(card) >= 0, 'illegal card ' + card);
      assert.ok(g.playCard({ playerId: p.id, card }).ok);
    }
    players.forEach((p, i) => { if (i % 2 === 0) even += p.lastDelta; else odd += p.lastDelta; });
    g._clearTimers();
  }
  return { even, odd };
}

const HANDS = Number(process.env.HANDS || 4000);
const BASE = Number(process.env.BASE || 50000);
// Mirror match: the SAME deals with each side at the even seats.
const a = headToHead(NEW, OLD, HANDS, BASE);
const b = headToHead(OLD, NEW, HANDS, BASE);
const seats = HANDS * 2 * 2;
const newTotal = a.even + b.odd;
const oldTotal = a.odd + b.even;
console.log('NEW per hand/seat', (newTotal / seats).toFixed(3),
  ' OLD', (oldTotal / seats).toFixed(3),
  ' delta (negative = better)', ((newTotal - oldTotal) / seats).toFixed(3));
