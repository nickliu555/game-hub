'use strict';
// Sim players for manual Sling Soccer host testing. Each bot joins as a real
// player socket and, when the host says it's their turn (m:turn), picks a random
// token and flicks it after a short delay — so you can watch the full turn /
// round-robin / goal loop on the host screen without extra phones.
//
//   node scripts/sim-slingsoccer.js [count]     (default 2)
//
// Open the host at /slingsoccer/host first, then run this; drag the sims onto
// teams in the lobby and hit Kick off.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000/slingsoccer';
const count = Math.max(1, Math.min(6, Number(process.argv[2]) || 2));

function makeBot(i) {
  const playerId = 'sim-' + i + '-' + Math.random().toString(36).slice(2, 7);
  const name = 'Sim' + i;
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  let myTeam = 'red';

  socket.on('connect', () => {
    socket.emit('player:join', { playerId, name }, (res) => {
      if (res && res.ok) { myTeam = res.player.team; console.log(name, 'joined on', myTeam); }
      else console.log(name, 'join failed:', res && res.reason);
    });
  });

  socket.on('m:turn', (d) => {
    if (!d || d.playerId !== playerId) return;
    // My turn — pick a token and flick after a beat.
    const token = (Math.random() * 5) | 0;
    setTimeout(() => socket.emit('aim:select', { token }), 250);
    // Aim toward the opponent's goal-ish direction with noise. Pull vector is
    // OPPOSITE the launch; red attacks +x (launch right => pull left).
    const attackRight = myTeam === 'red';
    const power = 0.6 + Math.random() * 0.4;
    const ang = (attackRight ? 0 : Math.PI) + (Math.random() * 0.9 - 0.45);
    const lx = Math.cos(ang), ly = Math.sin(ang);
    const dx = -lx * power, dy = -ly * power;
    let t = 500;
    // A few move updates so the host preview animates, then shoot.
    for (let k = 1; k <= 5; k++) {
      const p = power * (k / 5);
      setTimeout(() => socket.emit('aim:move', { dx: -lx * p, dy: -ly * p }), t); t += 120;
    }
    setTimeout(() => socket.emit('aim:shoot', { dx, dy }), t + 200);
  });

  socket.on('m:end', () => console.log(name, 'match ended'));
  socket.on('player:rejected', (p) => console.log(name, 'rejected:', p && p.reason));
  return socket;
}

const bots = [];
for (let i = 1; i <= count; i++) bots.push(makeBot(i));
console.log('Spawned ' + count + ' Sling Soccer sim player(s). Ctrl-C to stop.');
process.on('SIGINT', () => { bots.forEach((b) => b.close()); process.exit(0); });
