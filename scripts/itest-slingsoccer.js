'use strict';
// Headless end-to-end smoke test for Sling Soccer: lobby, teams (up to 3/side,
// >=1 each), goal target, start, turn rebroadcast, per-turn aim gating, goal /
// match-end rebroadcast, and reconnect meta. A flow probe, not a unit test.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000/slingsoccer';

function mk(opts) { return io(URL, Object.assign({ transports: ['websocket'], forceNew: true }, opts)); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond) { console.log((cond ? '  \u2713 ' : '  \u2717 FAIL ') + name); if (!cond) failures++; }

async function main() {
  const host = mk();
  await new Promise((r) => host.on('connect', r));
  const auth = await new Promise((r) => host.emit('host:auth', {}, r));
  check('host:auth ok', auth && auth.ok && auth.phase === 'LOBBY');

  const hostLobbies = [];
  host.on('state:lobby', (l) => hostLobbies.push(l));

  const p1 = mk(); await new Promise((r) => p1.on('connect', r));
  const j1 = await new Promise((r) => p1.emit('player:join', { playerId: 'p1', name: 'Alice' }, r));
  check('p1 join ok', j1 && j1.ok);
  const p2 = mk(); await new Promise((r) => p2.on('connect', r));
  const j2 = await new Promise((r) => p2.emit('player:join', { playerId: 'p2', name: 'Bob' }, r));
  check('p2 join ok, opposite team', j2 && j2.ok && j1.player.team !== j2.player.team);
  await wait(80);
  let lob = hostLobbies[hostLobbies.length - 1];
  check('1 each -> canStart true', lob && lob.total === 2 && lob.canStart === true);

  // Force both onto RED -> blue empty -> cannot start.
  await new Promise((r) => host.emit('host:assign', { playerId: 'p2', team: 'red' }, r));
  await wait(60);
  lob = hostLobbies[hostLobbies.length - 1];
  check('empty blue -> canStart false', lob && lob.canStart === false && lob.teams.red.length === 2);
  // Put p2 back on blue.
  await new Promise((r) => host.emit('host:assign', { playerId: 'p2', team: 'blue' }, r));
  await wait(40);

  // Fill up to 3/side (6 total), then 7th blocked.
  const extra = [];
  for (const [id, name] of [['p3', 'Cara'], ['p4', 'Dan'], ['p5', 'Eve'], ['p6', 'Finn']]) {
    const s = mk(); await new Promise((r) => s.on('connect', r));
    const j = await new Promise((r) => s.emit('player:join', { playerId: id, name }, r));
    check(id + ' join ok', j && j.ok);
    extra.push(s);
  }
  await wait(80);
  lob = hostLobbies[hostLobbies.length - 1];
  check('6 players, 3 per side', lob && lob.total === 6 && lob.teams.red.length === 3 && lob.teams.blue.length === 3);
  const p7 = mk(); await new Promise((r) => p7.on('connect', r));
  const j7 = await new Promise((r) => p7.emit('player:join', { playerId: 'p7', name: 'Gus' }, r));
  check('7th blocked (game-full)', j7 && !j7.ok && j7.reason === 'game-full');
  p7.close();
  // Trim back to a clean 1v1 (p1 red, p2 blue) for the turn tests.
  for (const [id] of [['p3'], ['p4'], ['p5'], ['p6']]) {
    await new Promise((r) => host.emit('host:kick', { playerId: id }, r));
  }
  extra.forEach((s) => s.close());
  await wait(80);

  // Goal target.
  await new Promise((r) => host.emit('host:setGoalTarget', { goalTarget: 2 }, r));
  await wait(40);
  lob = hostLobbies[hostLobbies.length - 1];
  check('goal target set to 2', lob && lob.goalTarget === 2);

  // Start.
  const pEvents = { p1: [], p2: [] };
  ['m:start', 'm:turn', 'm:goal', 'm:end'].forEach((e) => {
    p1.on(e, (d) => pEvents.p1.push([e, d]));
    p2.on(e, (d) => pEvents.p2.push([e, d]));
  });
  const hostAim = [];
  ['aim:select', 'aim:move', 'aim:shoot', 'aim:cancel'].forEach((e) => host.on(e, (d) => hostAim.push([e, d])));

  const start = await new Promise((r) => host.emit('host:start', {}, r));
  check('host:start ok, roster of 2', start && start.ok && start.roster.length === 2 && start.goalTarget === 2);
  await wait(60);
  check('players got m:start', pEvents.p1.some((e) => e[0] === 'm:start') && pEvents.p2.some((e) => e[0] === 'm:start'));

  // Host announces it's p1's turn.
  host.emit('host:turn', { team: 'red', playerId: 'p1', playerName: 'Alice', red: 0, blue: 0 });
  await wait(50);
  check('players got m:turn (currentPlayerId=p1)', pEvents.p1.some((e) => e[0] === 'm:turn' && e[1].playerId === 'p1'));

  // Aim gating: p1 (current) is relayed; p2 (not current) is ignored.
  p1.emit('aim:select', { token: 2 });
  p1.emit('aim:shoot', { dx: -0.5, dy: 0.2 });
  p2.emit('aim:shoot', { dx: 0.9, dy: 0 });
  await wait(60);
  check('p1 aim:select relayed to host', hostAim.some((e) => e[0] === 'aim:select' && e[1].id === 'p1' && e[1].token === 2));
  check('p1 aim:shoot relayed to host', hostAim.some((e) => e[0] === 'aim:shoot' && e[1].id === 'p1'));
  check('p2 (not current) aim NOT relayed', !hostAim.some((e) => e[1] && e[1].id === 'p2'));

  // Goal + match end rebroadcast.
  host.emit('host:goal', { team: 'red', red: 1, blue: 0 });
  await wait(40);
  check('players got m:goal', pEvents.p1.some((e) => e[0] === 'm:goal' && e[1].red === 1));

  // Reconnect p1 mid-match -> gets match meta.
  const rec = await new Promise((r) => p1.emit('player:reconnect', { playerId: 'p1' }, r));
  check('reconnect returns PLAYING + match meta', rec && rec.ok && rec.phase === 'PLAYING' && rec.match && rec.match.goalTarget === 2);

  host.emit('host:matchEnd', { winner: 'red', red: 2, blue: 0 });
  await wait(40);
  check('players got m:end', pEvents.p1.some((e) => e[0] === 'm:end' && e[1].winner === 'red'));

  // Reset returns everyone to the lobby.
  await new Promise((r) => host.emit('host:reset', {}, r));
  await wait(40);

  [host, p1, p2].forEach((s) => s.close());
  console.log('\n' + (failures ? (failures + ' FAILURE(S)') : 'ALL PASSED'));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
