'use strict';
// Headless end-to-end socket test for Snek: lobby + solo/multi mode
// detection, config snapping, CPU bots, start/rematch, input-relay gating
// (live / paused / decided / dead), reactions (downtime-only, mute, cooldown),
// round meta rebroadcast, reconnection snapshots, locked roster, solo best.
// Not a unit test — a socket-flow probe against a running server.
// Usage: PORT=3000 node scripts/itest-snek.js
const { io } = require('socket.io-client');
const URL = 'http://localhost:' + (process.env.PORT || 3000) + '/snek';

function mk() { return io(URL, { transports: ['websocket'], forceNew: true }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data || {}, r));
const connected = (s) => new Promise((r) => (s.connected ? r() : s.on('connect', r)));
let failures = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name); if (!cond) failures++; }

async function main() {
  const host = mk();
  await connected(host);
  const auth = await emit(host, 'host:auth');
  check('host:auth ok', auth && auth.ok);
  await emit(host, 'host:reset');
  const lobbies = [];
  host.on('state:lobby', (l) => lobbies.push(l));
  const relayed = [];
  host.on('in', (d) => relayed.push(d));
  const reactions = [];
  host.on('host:reaction', (d) => reactions.push(d));
  const last = () => lobbies[lobbies.length - 1];

  console.log('\nLobby + config');
  check('start blocked with 0 players', !(await emit(host, 'host:start')).ok);
  check('round length snaps to 15s steps (50 → 45)', (await emit(host, 'host:setRoundLength', { roundLengthSec: 50 })).roundLengthSec === 45);
  check('round length clamps to 2:00', (await emit(host, 'host:setRoundLength', { roundLengthSec: 1000 })).roundLengthSec === 120);
  check('round length clamps to 0:30', (await emit(host, 'host:setRoundLength', { roundLengthSec: 5 })).roundLengthSec === 30);
  await emit(host, 'host:setRoundLength', { roundLengthSec: 60 });
  check('rounds to win clamps 1–7', (await emit(host, 'host:setRoundsToWin', { roundsToWin: 99 })).roundsToWin === 7);
  await emit(host, 'host:setRoundsToWin', { roundsToWin: 2 });

  const p1 = mk(); await connected(p1);
  const j1 = await emit(p1, 'player:join', { playerId: 'sp-p1', name: 'Alice' });
  check('p1 join ok', j1 && j1.ok);
  await wait(50);
  check('1 human, no CPU → solo mode, can start', last().mode === 'solo' && last().canStart === true);
  check('lobby carries seat colours', last().players[0].color === '#4ADE80');
  const dupe = mk(); await connected(dupe);
  check('duplicate name rejected', (await emit(dupe, 'player:join', { playerId: 'sp-x', name: 'alice' })).reason === 'name-taken');
  dupe.close();

  console.log('\nReactions in the lobby');
  check('lobby reaction ok', (await emit(p1, 'player:reaction', { index: 2 })).ok === true);
  await wait(40);
  check('host received the reaction', reactions.some((r) => r.index === 2));
  check('cooldown enforced', (await emit(p1, 'player:reaction', { index: 1 })).reason === 'cooldown');
  check('bad index rejected', (await emit(p1, 'player:reaction', { index: 9 })).reason === 'bad-index');

  console.log('\nSolo game');
  const pev = [];
  ['m:start', 'm:roundStart', 'm:countdown', 'm:play', 'm:clock', 'm:eliminated', 'm:decided', 'm:roundOver', 'm:end', 'm:pause', 'm:resume'].forEach((e) => p1.on(e, (d) => pev.push([e, d])));
  const st = await emit(host, 'host:start');
  check('solo start ok, mode solo', st.ok && st.mode === 'solo' && st.roster.length === 1);
  await wait(50);
  check('player got m:start with mode solo', pev.some((e) => e[0] === 'm:start' && e[1].mode === 'solo'));
  const late = mk(); await connected(late);
  check('joining mid-game rejected', (await emit(late, 'player:join', { playerId: 'sp-late', name: 'Late' })).reason === 'round-in-progress');
  late.close();
  check('kick rejected once the game started', (await emit(host, 'host:kick', { playerId: 'sp-p1' })).ok === false);

  p1.emit('in', { dir: 3 }); await wait(40);
  check('input dropped before live', !relayed.length);
  host.emit('host:roundStart', { round: 1, mapIndex: 2, durationSec: 90 });
  host.emit('host:countdown', { n: 3 });
  host.emit('host:play');
  await wait(60);
  check('player got roundStart/countdown/play', ['m:roundStart', 'm:countdown', 'm:play'].every((n) => pev.some((e) => e[0] === n)));
  p1.emit('in', { dir: 0 }); await wait(40);
  check('input relayed once live', relayed.some((d) => d.id === 'sp-p1' && d.dir === 0));
  p1.emit('in', { dir: 7 }); await wait(40);
  check('invalid direction dropped', !relayed.some((d) => d.dir === 7));
  check('reaction during play rejected (phase-closed)', (await emit(p1, 'player:reaction', { index: 0 })).reason === 'phase-closed');

  host.emit('host:pause'); await wait(40);
  relayed.length = 0;
  p1.emit('in', { dir: 2 }); await wait(40);
  check('input dropped while paused', !relayed.length);
  host.emit('host:resume', { live: true }); await wait(40);
  host.emit('host:clock', { ms: 4000, lengths: { 'sp-p1': 7 } }); await wait(40);
  check('clock + lengths rebroadcast', pev.some((e) => e[0] === 'm:clock' && e[1].lengths['sp-p1'] === 7));

  host.emit('host:eliminated', { id: 'sp-p1', length: 9 });
  host.emit('host:decided'); await wait(60);
  check('player got m:eliminated with length', pev.some((e) => e[0] === 'm:eliminated' && e[1].id === 'sp-p1' && e[1].length === 9));
  check('player got m:decided', pev.some((e) => e[0] === 'm:decided'));
  relayed.length = 0;
  p1.emit('in', { dir: 1 }); await wait(40);
  check('input dropped after decided / death', !relayed.length);

  // Reconnect mid-phase returns a snapshot.
  const p1b = mk(); await connected(p1b);
  const rc = await emit(p1b, 'player:reconnect', { playerId: 'sp-p1' });
  check('reconnect snapshot (PLAYING, dead, mode solo)', rc.ok && rc.phase === 'PLAYING' && rc.match.mode === 'solo' && rc.match.alive['sp-p1'] === false);
  p1b.close();

  const end = await emit(host, 'host:matchEnd', { soloScore: 6, soloLength: 9 });
  check('solo matchEnd → first best is a new best', end.ok && end.solo.score === 6 && end.solo.newBest === true && end.soloBest.score === 6 && end.soloBest.name === 'Alice');
  await wait(40);
  check('player got m:end with solo result', pev.some((e) => e[0] === 'm:end' && e[1].solo && e[1].solo.score === 6));
  await wait(3000);
  check('reaction allowed on the final screen', (await emit(p1, 'player:reaction', { index: 3 })).ok === true);

  console.log('\nRematch + solo best');
  const rm = await emit(host, 'host:rematch');
  check('rematch restarts with the same roster', rm.ok && rm.roster.length === 1 && rm.roster[0].id === 'sp-p1');
  host.emit('host:roundStart', { round: 1, mapIndex: 0, durationSec: 90 });
  await wait(40);
  const end2 = await emit(host, 'host:matchEnd', { soloScore: 3, soloLength: 6 });
  check('lower score is not a new best; best kept', end2.solo.newBest === false && end2.soloBest.score === 6);
  const rm2 = await emit(host, 'host:rematch');
  check('Play again keeps the session best', rm2.ok && rm2.soloBest && rm2.soloBest.score === 6);
  host.emit('host:roundStart', { round: 1, mapIndex: 0, durationSec: 90 });
  await wait(40);
  await emit(host, 'host:matchEnd', { soloScore: 2, soloLength: 5 });

  console.log('\nMultiplayer');
  await emit(host, 'host:reset');
  await wait(60);
  const a = mk(); const b = mk(); await connected(a); await connected(b);
  check('A joins', (await emit(a, 'player:join', { playerId: 'sp-a', name: 'Ana' })).ok);
  check('B joins', (await emit(b, 'player:join', { playerId: 'sp-b', name: 'Ben' })).ok);
  check('add CPU ok', (await emit(host, 'host:addBot')).ok);
  await wait(50);
  check('2 humans + CPU → multi', last().mode === 'multi' && last().total === 3);
  check('solo best is cleared on going back to the lobby', last().soloBest === null);
  check('reorder ok', (await emit(host, 'host:reorder', { playerId: 'sp-b', beforeId: 'sp-a' })).ok);
  await wait(40);
  check('reorder changes seat + colour', last().players[0].id === 'sp-b' && last().players[0].color === '#4ADE80');
  check('power-ups default On', last().powerups === true);
  const po = await emit(host, 'host:setPowerups', { on: false });
  await wait(40);
  check('power-ups toggle Off', po.ok && po.powerups === false && last().powerups === false);
  await emit(host, 'host:setPowerups', { on: true });
  await wait(40);
  // 1 human + CPU is also multi.
  const solo1 = mk(); await connected(solo1);
  const aev = [];
  ['m:start', 'm:roundOver', 'm:end', 'm:eliminated'].forEach((e) => a.on(e, (d) => aev.push([e, d])));
  const ms = await emit(host, 'host:start');
  check('multi start ok', ms.ok && ms.mode === 'multi' && ms.roster.length === 3);
  check('start carries the power-ups setting', ms.powerups === true);
  check('power-ups locked once started', (await emit(host, 'host:setPowerups', { on: false })).ok === false);
  host.emit('host:roundStart', { round: 1, mapIndex: 1, durationSec: 90 });
  host.emit('host:play');
  await wait(50);
  const pw = [];
  a.on('m:power', (d) => pw.push(d));
  host.emit('host:power', { id: 'sp-a', power: 'phantom', sec: 6 });
  host.emit('host:power', { id: 'sp-a', power: 'rocket', sec: 6 });
  await wait(60);
  check('power-up relayed to phones', pw.length === 1 && pw[0].id === 'sp-a' && pw[0].power === 'phantom' && pw[0].sec === 6);
  const rcp = await emit(b, 'player:reconnect', { playerId: 'sp-b' });
  check('reconnect snapshot lists active power-ups', rcp.match.powers['sp-a'] && rcp.match.powers['sp-a'].power === 'phantom' && rcp.match.powers['sp-a'].sec > 5);
  host.emit('host:power', { id: 'sp-a', power: 'phantom', sec: 0 });
  await wait(40);
  const rcp2 = await emit(b, 'player:reconnect', { playerId: 'sp-b' });
  check('ended power-up drops out of the snapshot', !rcp2.match.powers['sp-a']);
  check('reaction during a live round rejected', (await emit(a, 'player:reaction', { index: 0 })).reason === 'phase-closed');

  // A drops mid-round: still on the roster, still alive, host notified.
  const dropped = new Promise((r) => host.once('player:dropped', r));
  a.close();
  await dropped;
  await wait(40);
  const hostSnap = await emit(host, 'host:auth');
  check('dropped player stays on the roster + alive', hostSnap.match.roster.some((r) => r.id === 'sp-a' && r.connected === false) && hostSnap.match.alive['sp-a'] === true);
  const a2 = mk(); await connected(a2);
  const rejoined = new Promise((r) => host.once('player:rejoined', r));
  const ra = await emit(a2, 'player:reconnect', { playerId: 'sp-a' });
  check('A reconnects mid-round with a live snapshot', ra.ok && ra.phase === 'PLAYING' && ra.match.live === true && ra.match.stage === 'play');
  await rejoined;
  check('host told A rejoined', true);

  host.emit('host:eliminated', { id: 'bot-1', length: 12 });
  host.emit('host:eliminated', { id: 'sp-a', length: 5 });
  host.emit('host:decided');
  host.emit('host:roundOver', { round: 1, winnerId: 'sp-b', draw: false, reason: 'last', lengths: { 'sp-a': 5, 'sp-b': 14, 'bot-1': 12 }, gamePoints: { 'sp-b': 1 }, alive: { 'sp-a': false, 'sp-b': true, 'bot-1': false } });
  await wait(60);
  check('reaction allowed on round results', (await emit(a2, 'player:reaction', { index: 4 })).ok === true);
  const rr = await emit(b, 'player:reconnect', { playerId: 'sp-b' });
  check('reconnect during results returns stage + last round', rr.match.stage === 'roundover' && rr.match.lastRound.winnerId === 'sp-b' && rr.match.gamePoints['sp-b'] === 1);

  // Mute silences reactions everywhere.
  await emit(host, 'host:setReactionsMuted', { muted: true });
  await wait(3100);
  check('muted reactions rejected', (await emit(b, 'player:reaction', { index: 0 })).reason === 'muted');
  await emit(host, 'host:setReactionsMuted', { muted: false });

  host.emit('host:roundStart', { round: 2, mapIndex: 3, durationSec: 90 });
  await wait(50);
  const r2 = await emit(b, 'player:reconnect', { playerId: 'sp-b' });
  check('new round revives everyone', r2.match.alive['sp-a'] === true && r2.match.alive['bot-1'] === true && r2.match.round === 2);
  check('reaction closed again in the next round', (await emit(b, 'player:reaction', { index: 0 })).reason === 'phase-closed');

  const me = await emit(host, 'host:matchEnd', { winnerIds: ['sp-b'], gamePoints: { 'sp-b': 2 }, awards: [{ emoji: '📏', title: 'Longest Snake', names: 'Ben', color: '#4ADE80', value: 'length 14' }] });
  check('multi matchEnd ok', me.ok && me.winnerIds[0] === 'sp-b' && me.gamePoints['sp-b'] === 2 && !me.solo);
  const hf = await emit(host, 'host:auth');
  check('host refresh at FINAL gets winners + awards', hf.phase === 'FINAL' && hf.match.awards.length === 1 && hf.match.winnerIds[0] === 'sp-b');

  console.log('\nCPU solo');
  await emit(host, 'host:reset');
  await wait(50);
  check('add a lone CPU', (await emit(host, 'host:addBot')).ok);
  await wait(50);
  check('a lone CPU → solo mode', last().mode === 'solo' && last().canStart === true);
  const cs = await emit(host, 'host:start');
  check('CPU solo starts in solo mode', cs.ok && cs.mode === 'solo' && cs.roster[0].isBot);
  host.emit('host:roundStart', { round: 1, mapIndex: 0, durationSec: 90 });
  await wait(40);
  const ce = await emit(host, 'host:matchEnd', { soloScore: 99, soloLength: 99 });
  check('a CPU run never sets the session best', ce.ok && ce.solo.newBest === false && ce.soloBest === null);

  // Host leaving clears the solo best.
  await emit(host, 'host:leave');
  const h2 = mk(); await connected(h2);
  const a3 = await emit(h2, 'host:auth');
  check('host leave resets + clears the solo best', a3.phase === 'LOBBY' && a3.lobby.soloBest === null && a3.lobby.total === 0);

  [host, h2, p1, a2, b, solo1].forEach((s) => s.close());
  console.log(failures ? ('\n' + failures + ' FAILED') : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
