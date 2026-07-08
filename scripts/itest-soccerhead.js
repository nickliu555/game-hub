'use strict';
// Headless end-to-end smoke test for Soccer Head: lobby, teams, start, relay,
// match meta rebroadcast, sudden-death path. Not a unit test — a flow probe.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000/soccerhead';

function mk(opts) { return io(URL, Object.assign({ transports: ['websocket'], forceNew: true }, opts)); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name); if (!cond) failures++; }

async function main() {
  const host = mk();
  await new Promise((r) => host.on('connect', r));
  const auth = await new Promise((r) => host.emit('host:auth', {}, r));
  check('host:auth ok', auth && auth.ok && auth.phase === 'LOBBY');

  // Two players join.
  const hostLobbies = [];
  host.on('state:lobby', (l) => hostLobbies.push(l));
  const p1 = mk();
  await new Promise((r) => p1.on('connect', r));
  const j1 = await new Promise((r) => p1.emit('player:join', { playerId: 'p1', name: 'Alice' }, r));
  check('p1 join ok, auto team', j1 && j1.ok && (j1.player.team === 'red' || j1.player.team === 'blue'));
  const p2 = mk();
  await new Promise((r) => p2.on('connect', r));
  const j2 = await new Promise((r) => p2.emit('player:join', { playerId: 'p2', name: 'Bob' }, r));
  check('p2 join ok', j2 && j2.ok);
  await wait(80);
  const lob = hostLobbies[hostLobbies.length - 1];
  check('lobby balanced 1v1 -> canStart', lob && lob.total === 2 && lob.canStart === true);
  check('auto-assigned opposite teams', j1.player.team !== j2.player.team);

  // Third join should be blocked (1v1 full).
  const p3 = mk();
  await new Promise((r) => p3.on('connect', r));
  const j3 = await new Promise((r) => p3.emit('player:join', { playerId: 'p3', name: 'Cara' }, r));
  check('3rd join blocked (game-full)', j3 && !j3.ok && j3.reason === 'game-full');
  p3.close();

  // Move both to the same team -> cannot start.
  await new Promise((r) => host.emit('host:assign', { playerId: 'p2', team: j1.player.team }, r));
  await wait(60);
  const lob2 = hostLobbies[hostLobbies.length - 1];
  check('unbalanced -> canStart false', lob2 && lob2.canStart === false);
  // Put back.
  await new Promise((r) => host.emit('host:assign', { playerId: 'p2', team: j1.player.team === 'red' ? 'blue' : 'red' }, r));
  await wait(60);

  // Player receives m:start; host input relay works.
  const p1Events = [];
  ['m:start', 'm:countdown', 'm:play', 'm:goal', 'm:clock', 'm:sudden', 'm:end'].forEach((e) => p1.on(e, (d) => p1Events.push([e, d])));
  const relayed = [];
  host.on('in', (d) => relayed.push(d));
  host.on('dash', (d) => relayed.push(['dash', d]));

  const start = await new Promise((r) => host.emit('host:start', {}, r));
  check('host:start ok with roster', start && start.ok && Array.isArray(start.roster) && start.roster.length === 2);
  await wait(60);
  check('player got m:start', p1Events.some((e) => e[0] === 'm:start'));

  // Player input relayed to host with id.
  p1.emit('in', { c: 1, d: 1 });
  p1.emit('dash', { dir: 1 });
  await wait(60);
  check('input relayed to host with id', relayed.some((d) => d && d.id === 'p1' && d.c === 1));
  check('dash relayed to host', relayed.some((d) => Array.isArray(d) && d[0] === 'dash' && d[1].id === 'p1'));

  // Simulate host match meta pushes.
  host.emit('host:countdown', { n: 3 });
  host.emit('host:play', {});
  host.emit('host:goal', { team: 'red', red: 1, blue: 0 });
  host.emit('host:clock', { ms: 0, sudden: true });
  await wait(80);
  check('player got m:play', p1Events.some((e) => e[0] === 'm:play'));
  check('player got m:goal with score', p1Events.some((e) => e[0] === 'm:goal' && e[1] && e[1].red === 1));

  // Reconnect mid-match returns match meta.
  const p1b = mk();
  await new Promise((r) => p1b.on('connect', r));
  const rec = await new Promise((r) => p1b.emit('player:reconnect', { playerId: 'p1' }, r));
  check('reconnect returns PLAYING + match meta', rec && rec.ok && rec.phase === 'PLAYING' && rec.match && rec.match.redScore === 1);

  host.emit('host:matchEnd', { winner: 'red', red: 2, blue: 1 });
  await wait(60);
  check('player got m:end winner', p1Events.some((e) => e[0] === 'm:end' && e[1] && e[1].winner === 'red'));

  // Reset returns to lobby.
  await new Promise((r) => host.emit('host:reset', {}, r));
  await wait(60);

  [host, p1, p2, p1b].forEach((s) => s.close());
  console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
