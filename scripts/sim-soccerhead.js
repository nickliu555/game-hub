'use strict';
// Persistent Soccer Head player bots for manual/visual host testing.
// Connects N players, joins the lobby, and sends periodic inputs so the host
// pitch shows movement/kicks. Ctrl-C to stop.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000/soccerhead';
const names = ['Alice', 'Bob', 'Cara', 'Dan'];
const count = Math.min(Number(process.argv[2] || 2), 4);

for (let i = 0; i < count; i++) {
  const pid = 'bot' + i;
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.on('connect', () => {
    s.emit('player:join', { playerId: pid, name: names[i] }, (res) => {
      console.log('join', names[i], res && res.ok ? ('ok -> ' + res.player.team) : ('FAIL ' + (res && res.reason)));
    });
  });
  let playing = false;
  s.on('m:play', () => { playing = true; });
  s.on('m:goal', () => { playing = false; });
  s.on('m:countdown', () => { playing = false; });
  s.on('m:end', () => { playing = false; });
  // Random-ish inputs to animate the pitch.
  let held = null;
  setInterval(() => {
    if (!playing) return;
    if (held !== null) { s.emit('in', { c: held, d: 0 }); held = null; }
    const r = Math.random();
    if (r < 0.4) { held = Math.random() < 0.5 ? 0 : 1; s.emit('in', { c: held, d: 1 }); }
    else if (r < 0.6) { s.emit('in', { c: 2, d: 1 }); setTimeout(() => s.emit('in', { c: 2, d: 0 }), 120); }
    else if (r < 0.85) { s.emit('in', { c: 3, d: 1 }); }
    else { s.emit('dash', { dir: Math.random() < 0.5 ? -1 : 1 }); }
  }, 350 + i * 40);
}
console.log('running', count, 'bots — Ctrl-C to stop');
