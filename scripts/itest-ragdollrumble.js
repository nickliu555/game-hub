'use strict';
// Headless end-to-end smoke test for Ragdoll Rumble: lobby gating, 8-seat
// capacity, seat reordering, CPU bots, config clamps, controller-relay gating
// (stick + jump/action + press counters), round meta rebroadcast, knock-outs,
// round results, reconnect snapshots, the locked roster, play-again, reset and
// the Hub "leave" reset. Not a unit test — a socket-flow probe against a
// running server (RR_URL to point it somewhere other than :3000).
const { io } = require('socket.io-client');
const URL = (process.env.RR_URL || 'http://localhost:3000') + '/ragdollrumble';
const SEAT_COLORS = ['#FF4D4D', '#3DA5FF', '#3DDC84', '#FFD23F', '#B266FF', '#FF8A3D', '#2EE6D6', '#FF6FB5'];

function mk(opts) { return io(URL, Object.assign({ transports: ['websocket'], forceNew: true }, opts)); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (sock, ev, payload) => new Promise((r) => sock.emit(ev, payload, r));
const connect = (s) => new Promise((r) => s.on('connect', r));
let failures = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name); if (!cond) failures++; }
function section(t) { console.log('\n' + t); }

async function main() {
  const host = mk();
  await connect(host);
  // Start from a clean slate whatever a previous run left behind.
  await ask(host, 'host:auth', {});
  await ask(host, 'host:reset', {});
  const auth = await ask(host, 'host:auth', {});
  check('host:auth ok (LOBBY)', auth && auth.ok && auth.phase === 'LOBBY');
  check('auth exposes config bounds', auth && auth.minRoundsToWin === 1 && auth.maxRoundsToWin === 7 &&
    Array.isArray(auth.botDifficulties) && auth.botDifficulties.length === 3 &&
    Array.isArray(auth.stageSets) && auth.stageSets.indexOf('mixed') >= 0);

  const hostLobbies = [];
  host.on('state:lobby', (l) => hostLobbies.push(l));
  const last = () => hostLobbies[hostLobbies.length - 1];

  // ---------------------------------------------------------------- lobby
  section('Lobby & capacity');
  const early = await ask(host, 'host:start', {});
  check('start blocked with 0 players', early && !early.ok);

  const players = [];
  const names = ['Alice', 'Bob', 'Cara', 'Dan', 'Eve', 'Finn'];
  for (let i = 0; i < 6; i++) {
    const s = mk();
    await connect(s);
    const j = await ask(s, 'player:join', { playerId: 'p' + (i + 1), name: names[i] });
    if (i < 2) check(names[i] + ' joins ok', j && j.ok);
    players.push(s);
    if (i === 0) { await wait(60); check('1 player cannot start yet', last() && last().total === 1 && last().canStart === false); }
  }
  const [p1, p2, p3] = players;
  await wait(80);
  check('capacity is 6 and all 6 seated', last() && last().capacity === 6 && last().total === 6);

  const dupe = mk();
  await connect(dupe);
  const jd = await ask(dupe, 'player:join', { playerId: 'p99', name: 'alice' });
  check('7th player rejected (full) before name check', jd && !jd.ok && (jd.reason === 'game-full' || jd.reason === 'name-taken'));
  const st = await ask(dupe, 'query:status', {});
  check('query:status reports total/capacity', st && st.total === 6 && st.capacity === 6);
  dupe.close();
  const botFull = await ask(host, 'host:addBot', {});
  check('addBot rejected when full', botFull && !botFull.ok);

  const longName = mk();
  await connect(longName);
  // Free a seat to check name sanitising/limits.
  await ask(host, 'host:kick', { playerId: 'p6' });
  players[5].close();
  const jl = await ask(longName, 'player:join', { playerId: 'p6', name: 'W'.repeat(40) + '<b>' });
  check('long names are cut to 20 chars and stripped', jl && jl.ok && jl.player.name === 'W'.repeat(20));
  players[5] = longName;

  // ------------------------------------------------------------- ordering
  section('Seat order → colors');
  await wait(60);
  let roster = last().players;
  check('seats are 0..5 in order', roster.every((p, i) => p.seat === i));
  check('6 distinct seat colors', roster.every((p, i) => p.color === SEAT_COLORS[i]) && new Set(roster.map((p) => p.color)).size === 6);
  const ro = await ask(host, 'host:reorder', { playerId: 'p4', beforeId: 'p2' });
  check('host:reorder ok', ro && ro.ok);
  await wait(60);
  roster = last().players;
  check('reorder renumbers seats', roster.slice(0, 4).map((p) => p.id).join(',') === 'p1,p4,p2,p3');
  check('reorder reassigns colors', roster[1].id === 'p4' && roster[1].color === SEAT_COLORS[1]);
  await ask(host, 'host:reorder', { playerId: 'p4', beforeId: 'p5' });
  await wait(60);
  check('reorder back works', last().players.slice(0, 5).map((p) => p.id).join(',') === 'p1,p2,p3,p4,p5');

  // Make room for a CPU so bot handling is covered too.
  const kick = await ask(host, 'host:kick', { playerId: 'p5' });
  check('host:kick ok in the lobby', kick && kick.ok);
  await wait(60);
  check('kicked player removed', last().total === 5);
  const bot = await ask(host, 'host:addBot', {});
  check('addBot ok when there is room', bot && bot.ok);
  await wait(60);
  check('bot joined with a color', last().players.some((p) => p.isBot && p.color));

  // --------------------------------------------------------------- config
  section('Config clamps');
  const rw = await ask(host, 'host:setRoundsToWin', { roundsToWin: 2 });
  check('setRoundsToWin ok', rw && rw.ok && rw.roundsToWin === 2);
  const rwHigh = await ask(host, 'host:setRoundsToWin', { roundsToWin: 99 });
  check('roundsToWin clamped to max', rwHigh && rwHigh.roundsToWin === 7);
  await ask(host, 'host:setRoundsToWin', { roundsToWin: 2 });
  const rl = await ask(host, 'host:setRoundLength', { roundLengthSec: 5 });
  check('roundLength clamped to min', rl && rl.roundLengthSec === 60);
  const rl2 = await ask(host, 'host:setRoundLength', { roundLengthSec: 120 });
  check('setRoundLength ok', rl2 && rl2.roundLengthSec === 120);
  const it = await ask(host, 'host:setItems', { on: false });
  check('setItems off', it && it.ok && it.items === false);
  await ask(host, 'host:setItems', { on: true });
  const ss = await ask(host, 'host:setStageSet', { set: 'classic' });
  check('setStageSet classic', ss && ss.ok && ss.stageSet === 'classic');
  const ssBad = await ask(host, 'host:setStageSet', { set: 'moon' });
  check('bad stage set rejected', ssBad && !ssBad.ok);
  await ask(host, 'host:setStageSet', { set: 'mixed' });
  const bd = await ask(host, 'host:setBotDifficulty', { level: 'hard' });
  check('setBotDifficulty ok', bd && bd.ok && bd.botDifficulty === 'hard');
  const bdBad = await ask(host, 'host:setBotDifficulty', { level: 'nightmare' });
  check('bad difficulty rejected', bdBad && !bdBad.ok);
  check('players cannot change config', !(await ask(p1, 'host:setItems', { on: false })).ok);

  // ------------------------------------------------------------ reactions
  section('Reactions (downtime only)');
  const hostReactions = [];
  host.on('host:reaction', (d) => hostReactions.push(d));
  const rLobby = await ask(p2, 'player:reaction', { index: 2 });
  await wait(40);
  check('lobby reaction ok + relayed to the host', rLobby && rLobby.ok && hostReactions.some((d) => d.id === 'p2' && d.index === 2));
  const rAgain = await ask(p2, 'player:reaction', { index: 0 });
  check('second reaction inside the cooldown is refused', rAgain && !rAgain.ok && rAgain.reason === 'cooldown' && rAgain.retryInMs > 0);
  const rBad = await ask(p1, 'player:reaction', { index: 6 });
  check('out-of-range reaction refused', rBad && !rBad.ok && rBad.reason === 'bad-index');
  const muteEvs = [];
  p1.on('state:reactionsMuted', (d) => muteEvs.push(d));
  const mute = await ask(host, 'host:setReactionsMuted', { muted: true });
  await wait(40);
  check('host can mute reactions (phones told)', mute && mute.ok && mute.reactionsMuted === true && muteEvs.some((d) => d.muted === true));
  const rMuted = await ask(p1, 'player:reaction', { index: 1 });
  check('reactions refused while muted', rMuted && !rMuted.ok && rMuted.reason === 'muted');
  await ask(host, 'host:setReactionsMuted', { muted: false });

  // ---------------------------------------------------------------- match
  section('Match flow');
  const pev = [];
  ['m:start', 'm:roundStart', 'm:countdown', 'm:play', 'm:clock', 'm:hud',
   'm:eliminated', 'm:pause', 'm:resume', 'm:resumeCount', 'm:roundEnd', 'm:end']
    .forEach((e) => p1.on(e, (d) => pev.push([e, d])));
  const got = (e, fn) => pev.some((x) => x[0] === e && (!fn || fn(x[1])));
  const inRelay = [];
  host.on('in', (d) => inRelay.push(d));

  const start = await ask(host, 'host:start', {});
  check('host:start ok with 6 fighters', start && start.ok && Array.isArray(start.roster) && start.roster.length === 6);
  check('start echoes config', start.roundsToWin === 2 && start.roundLengthSec === 120 && start.items === true && start.stageSet === 'mixed');
  await wait(60);
  check('player got m:start', got('m:start'));

  check('reorder rejected outside LOBBY', !(await ask(host, 'host:reorder', { playerId: 'p2', beforeId: 'p1' })).ok);
  const kickLate = await ask(host, 'host:kick', { playerId: 'p3' });
  check('kicking is lobby-only (roster locked)', kickLate && !kickLate.ok && kickLate.reason === 'not-lobby');

  const lateJoin = mk();
  await connect(lateJoin);
  const jLate = await ask(lateJoin, 'player:join', { playerId: 'late', name: 'Late' });
  check('no joining mid-game', jLate && !jLate.ok);
  lateJoin.close();

  // Input before the round is live must NOT be relayed.
  p1.emit('in', { x: 1, y: 0, b: 3, jp: 1, ap: 1 });
  await wait(40);
  check('input dropped before live', inRelay.length === 0);

  host.emit('host:roundStart', { round: 1, seed: 1234, stage: 'volcano', durationSec: 120 });
  await wait(40);
  check('player got m:roundStart with stage + hud', got('m:roundStart', (d) => d && d.round === 1 && d.stage === 'volcano' && d.hud && d.hud.p1 && d.hud.p1.dmg === 0));
  host.emit('host:countdown', { n: 3, note: 'Round 1 · Volcano' });
  host.emit('host:play', {});
  await wait(40);
  check('player got m:countdown', got('m:countdown', (d) => d && d.n === 3 && d.note === 'Round 1 · Volcano'));
  check('player got m:play', got('m:play'));
  const rLive = await ask(p1, 'player:reaction', { index: 1 });
  check('no reactions mid-round', rLive && !rLive.ok && rLive.reason === 'phase-closed');

  p1.emit('in', { x: -1, y: 0.5, b: 2, jp: 3, ap: 7 });
  await wait(40);
  check('stick + buttons relayed once live', inRelay.some((d) => d && d.id === 'p1' && d.x === -1 && d.y === 0.5 && d.b === 2 && d.jp === 3 && d.ap === 7));
  p1.emit('in', { x: 9, y: -9, b: 255, jp: 300, ap: -1 });
  await wait(40);
  check('relay clamps stick and masks buttons/counters', inRelay.some((d) => d && d.x === 1 && d.y === -1 && d.b === 3 && d.jp === (300 & 255) && d.ap === 255));
  let n = inRelay.length;
  p1.emit('in', { x: 'left', y: 0 });
  p1.emit('in', null);
  await wait(40);
  check('junk input dropped', inRelay.length === n);

  // Pause gating + resume countdown.
  host.emit('host:pause', {});
  await wait(40);
  check('player got m:pause', got('m:pause'));
  n = inRelay.length;
  p1.emit('in', { x: 0.5, y: 0, b: 0, jp: 3, ap: 7 });
  await wait(40);
  check('input dropped while paused', inRelay.length === n);
  host.emit('host:resumeCount', { n: 3 });
  host.emit('host:resume', { live: true });
  await wait(40);
  check('player got the resume 3-2-1', got('m:resumeCount', (d) => d && d.n === 3));
  check('player got m:resume (live)', got('m:resume', (d) => d && d.live === true));

  // HUD + clock + sudden death.
  host.emit('host:hud', { id: 'p1', dmg: 87.6, item: 'bat', glove: true });
  host.emit('host:hud', { id: 'p2', dmg: 5000, item: '<script>', glove: 0 });
  host.emit('host:clock', { ms: 0, suddenDeath: true });
  await wait(40);
  check('player got m:hud', got('m:hud', (d) => d && d.id === 'p1' && d.dmg === 88 && d.item === 'bat' && d.glove === true));
  check('hud is sanitised', got('m:hud', (d) => d && d.id === 'p2' && d.dmg === 999 && d.item === '' && d.glove === false));
  check('player got m:clock with suddenDeath', got('m:clock', (d) => d && d.ms === 0 && d.suddenDeath === true));

  // A dropped phone stays in the fight and on the roster.
  section('Locked roster');
  const drops = [];
  host.on('player:dropped', (d) => drops.push(d));
  p3.close();
  await wait(80);
  check('host told the phone dropped', drops.some((d) => d.id === 'p3'));
  const authMid = await ask(host, 'host:auth', {});
  check('dropped player is still on the roster', authMid.match.roster.some((r) => r.id === 'p3' && r.connected === false) && authMid.match.roster.length === 6);
  check('dropped player is still in the round', authMid.match.alive.p3 === true);
  const p3b = mk();
  await connect(p3b);
  const rejoined = [];
  host.on('player:rejoined', (d) => rejoined.push(d));
  const rec3 = await ask(p3b, 'player:reconnect', { playerId: 'p3' });
  await wait(40);
  check('dropped player rejoins mid-round', rec3 && rec3.ok && rec3.phase === 'PLAYING' && rec3.match.alive.p3 === true);
  check('host told the player rejoined', rejoined.some((d) => d.id === 'p3'));

  // KO gates input.
  host.emit('host:eliminated', { id: 'p1', by: 'p2' });
  await wait(40);
  check('player got m:eliminated', got('m:eliminated', (d) => d && d.id === 'p1' && d.by === 'p2'));
  n = inRelay.length;
  p1.emit('in', { x: 1, y: 0, b: 2, jp: 4, ap: 8 });
  await wait(40);
  check('knocked-out player input dropped', inRelay.length === n);

  section('Reconnect snapshots');
  const p1b = mk();
  await connect(p1b);
  const rec = await ask(p1b, 'player:reconnect', { playerId: 'p1' });
  check('reconnect returns PLAYING + meta', rec && rec.ok && rec.phase === 'PLAYING' && rec.match);
  check('snapshot shows knocked out', rec.match.alive && rec.match.alive.p1 === false);
  check('snapshot carries hud', rec.match.hud && rec.match.hud.p1 && rec.match.hud.p1.dmg === 88 && rec.match.hud.p1.item === 'bat');
  check('snapshot carries roster, round + stage', Array.isArray(rec.match.roster) && rec.match.round === 1 && rec.match.stage === 'volcano');
  check('snapshot carries config', rec.match.roundsToWin === 2 && rec.match.items === true);
  const host2 = mk();
  await connect(host2);
  const auth2 = await ask(host2, 'host:auth', {});
  check('host refresh returns PLAYING + match (round + stage)', auth2 && auth2.ok && auth2.phase === 'PLAYING' && auth2.match && auth2.match.round === 1 && auth2.match.stage === 'volcano');

  section('Round & match end');
  host.emit('host:roundEnd', { round: 1, winnerId: 'p2', gamePoints: { p2: 1, ghost: 4 } });
  await wait(40);
  check('player got m:roundEnd', got('m:roundEnd', (d) => d && d.winnerId === 'p2' && d.gamePoints.p2 === 1 && d.roundsToWin === 2));
  check('unknown ids ignored in game points', !got('m:roundEnd', (d) => d && d.gamePoints.ghost));
  const rRound = await ask(p1, 'player:reaction', { index: 3 });
  await wait(40);
  check('reactions open on the round result', rRound && rRound.ok && hostReactions.some((d) => d.id === 'p1' && d.index === 3));
  const recRo = await ask(p1b, 'player:reconnect', { playerId: 'p1' });
  check('a reconnecting phone learns it is between rounds', recRo && recRo.match && recRo.match.roundOver === true);
  host.emit('host:roundStart', { round: 2, seed: 99, stage: 'ship', durationSec: 120 });
  await wait(40);
  check('a new round puts everyone back in at 0%', got('m:roundStart', (d) => d && d.round === 2 && d.hud.p1.dmg === 0));
  const authR2 = await ask(host2, 'host:auth', {});
  check('knocked-out player is back in for the next round', authR2.match.alive.p1 === true);
  const rNext = await ask(p2, 'player:reaction', { index: 0 });
  check('reactions close again when the next round starts', rNext && !rNext.ok && rNext.reason === 'phase-closed');

  host.emit('host:matchEnd', { winnerIds: ['p2'], gamePoints: { p2: 2 } });
  await wait(40);
  check('player got m:end', got('m:end', (d) => d && d.winnerIds.indexOf('p2') >= 0 && d.gamePoints.p2 === 2));
  const authFinal = await ask(host2, 'host:auth', {});
  check('host sees FINAL phase', authFinal && authFinal.phase === 'FINAL');
  const rFinal = await ask(p3b, 'player:reaction', { index: 5 });
  await wait(40);
  check('reactions open on the final results', rFinal && rFinal.ok && hostReactions.some((d) => d.id === 'p3' && d.index === 5));

  section('Play again');
  check('players cannot trigger a rematch', !(await ask(p1, 'host:rematch', {})).ok);
  const startsBefore = pev.filter((x) => x[0] === 'm:start').length;
  const re = await ask(host, 'host:rematch', {});
  await wait(60);
  check('rematch ok with the same roster', re && re.ok && re.roster.map((r) => r.id).join() === start.roster.map((r) => r.id).join());
  check('rematch keeps the config', re && re.roundsToWin === 2 && re.roundLengthSec === 120 && re.items === true);
  check('player got a fresh m:start', pev.filter((x) => x[0] === 'm:start').length > startsBefore);
  const authRe = await ask(host2, 'host:auth', {});
  check('rematch is PLAYING with scores cleared', authRe && authRe.phase === 'PLAYING' &&
    Object.keys(authRe.match.gamePoints).every((k) => authRe.match.gamePoints[k] === 0));

  section('Reset');
  const resets = [];
  p1.on('state:reset', () => resets.push(1));
  await ask(host, 'host:reset', {});
  await wait(60);
  check('players got state:reset', resets.length > 0);
  const authAfter = await ask(host, 'host:auth', {});
  check('back in an empty LOBBY', authAfter && authAfter.phase === 'LOBBY' && authAfter.lobby.total === 0);
  check('config survives a mid-game reset', authAfter.lobby.roundsToWin === 2 && authAfter.lobby.roundLengthSec === 120);

  section('Hub = reset + host away');
  const pj = mk();
  await connect(pj);
  await ask(pj, 'player:join', { playerId: 'hubTest', name: 'Hubby' });
  const pjEvents = [];
  pj.on('state:reset', () => pjEvents.push('reset'));
  pj.on('state:hostPresence', (d) => pjEvents.push('presence:' + d.present));
  await ask(host, 'host:setReactionsMuted', { muted: true });
  const leave = await ask(host, 'host:leave', {});
  await wait(60);
  check('host:leave ok', leave && leave.ok);
  check('phones reset, then told the host is gone', pjEvents.join(',') === 'reset,presence:false');
  const stLeft = await ask(pj, 'query:status', {});
  check('host reported absent after leaving', stLeft && stLeft.hostPresent === false && stLeft.total === 0);
  const jAway = await ask(pj, 'player:join', { playerId: 'hubTest2', name: 'Hubby' });
  check('no joining while the host is away', jAway && !jAway.ok && jAway.reason === 'host-absent');
  const authBack = await ask(host, 'host:auth', {});
  check('host returns to defaults (items on, 3 rounds, 1:30, mixed, unmuted)',
    authBack.lobby.items === true && authBack.lobby.roundsToWin === 3 && authBack.lobby.roundLengthSec === 90 &&
    authBack.lobby.stageSet === 'mixed' && authBack.reactionsMuted === false);

  [host, host2, p1b, p3b, pj].concat(players).forEach((s) => s.close());
  console.log('\n' + (failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
