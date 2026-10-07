'use strict';
// Headless end-to-end smoke test for Nong: lobby, seats, CPU paddles, targets,
// capacity, input relay, points/lives sync, reconnect,
// roster locking, match end and reset.
const { io } = require('socket.io-client');
const URL = process.env.NONG_URL || 'http://localhost:3000/nong';

function mk() { return io(URL, { transports: ['websocket'], forceNew: true }); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload || {}, r));
const connected = (s) => new Promise((r) => (s.connected ? r() : s.on('connect', r)));
let failures = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name); if (!cond) failures++; }

async function joinAs(id, name) {
  const s = mk();
  await connected(s);
  const res = await call(s, 'player:join', { playerId: id, name });
  const evs = [];
  s.onAny((ev, d) => evs.push([ev, d]));
  return { s, id, res, evs };
}

async function main() {
  const host = mk();
  await connected(host);
  let auth = await call(host, 'host:auth');
  if (auth && auth.phase !== 'LOBBY') {
    await call(host, 'host:reset');
    auth = await call(host, 'host:auth');
  }
  if (auth && auth.lobby && auth.lobby.total) {
    await call(host, 'host:reset');
    auth = await call(host, 'host:auth');
  }
  check('host:auth ok in LOBBY', auth && auth.ok && auth.phase === 'LOBBY');
  check('capacity is 4', auth && auth.lobby && auth.lobby.capacity === 4);

  const lobbies = [];
  host.on('state:lobby', (l) => lobbies.push(l));
  const last = () => lobbies[lobbies.length - 1];
  const hostIns = [];
  host.on('in', (d) => hostIns.push(d));

  // ---- Joins + seats ----
  const a = await joinAs('pa', 'Alice');
  const b = await joinAs('pb', 'Bob');
  await wait(80);
  check('two players join', a.res.ok && b.res.ok && last().total === 2);
  check('seats follow join order', last().players[0].id === 'pa' && last().players[0].seat === 0 && last().players[1].seat === 1);
  check('2 players → points mode, startable', last().mode === 'points' && last().canStart === true);
  const dup = await joinAs('pdup', 'alice');
  check('duplicate name rejected', !dup.res.ok && dup.res.reason === 'name-taken');
  dup.s.close();

  // ---- Targets ----
  check('points target accepted', (await call(host, 'host:setTarget', { mode: 'points', value: 7 })).ok);
  check('bad target rejected', !(await call(host, 'host:setTarget', { mode: 'points', value: 9 })).ok);
  check('lives target accepted', (await call(host, 'host:setTarget', { mode: 'lives', value: 5 })).ok);
  check('bad mode rejected', !(await call(host, 'host:setTarget', { mode: 'time', value: 5 })).ok);
  const notHost = await call(a.s, 'host:setTarget', { mode: 'lives', value: 1 });
  check('players cannot change the target', notHost && !notHost.ok);
  await wait(60);
  check('lobby reflects targets', last().pointsToWin === 7 && last().lives === 5);

  // ---- CPU + capacity ----
  check('add CPU ok', (await call(host, 'host:addBot')).ok);
  await wait(60);
  check('3 paddles → lives mode', last().total === 3 && last().mode === 'lives' && last().players[2].isBot);
  const c = await joinAs('pc', 'Cara');
  await wait(60);
  check('4th paddle joins', c.res.ok && last().total === 4);
  const d = await joinAs('pd', 'Dan');
  check('5th join is rejected: game full', !d.res.ok && d.res.reason === 'game-full');
  d.s.close();
  const bot2 = await call(host, 'host:addBot');
  check('no CPU past 4', !bot2.ok && bot2.reason === 'game-full');
  check('kick the CPU in the lobby', (await call(host, 'host:kick', { playerId: 'bot-1' })).ok);
  await wait(60);
  check('kick frees the seat and reseats', last().total === 3 && last().players.map((p) => p.seat).join() === '0,1,2');

  // ---- Drag to reorder seats ----
  const order = () => last().players.map((p) => p.id).join();
  check('reorder: move Cara to the top', (await call(host, 'host:reorder', { playerId: 'pc', beforeId: 'pa' })).ok);
  await wait(60);
  check('Cara now holds seat 0', order() === 'pc,pa,pb' && last().players[0].seat === 0 && last().players[0].color === '#FF4D8D');
  check('reorder: move Cara to the end', (await call(host, 'host:reorder', { playerId: 'pc', beforeId: null })).ok);
  await wait(60);
  check('Cara back at the end', order() === 'pa,pb,pc');
  check('reorder rejects an unknown player', !(await call(host, 'host:reorder', { playerId: 'nope' })).ok);
  check('players cannot reorder', !(await call(a.s, 'host:reorder', { playerId: 'pa', beforeId: null })).ok);
  check('order unchanged by rejected moves', order() === 'pa,pb,pc');

  check('3 paddles → canStart', last().canStart === true);

  // ---- Reactions are not part of Nong ----
  const hostEmotes = [];
  host.on('emote', (d) => hostEmotes.push(d));
  a.s.emit('emote', { e: '🔥' });
  await wait(80);
  check('no reactions are relayed', hostEmotes.length === 0);

  // ---- Start (3 players, lives) ----
  const start = await call(host, 'host:start');
  await wait(80);
  check('start ok', start && start.ok);
  const mStart = a.evs.find((x) => x[0] === 'm:start');
  check('players get m:start', !!mStart);
  const meta = mStart && mStart[1];
  check('lives mode with 5 lives each', meta && meta.mode === 'lives' && meta.target === 5 &&
    meta.roster.every((r) => meta.scores[r.id] === 5));
  check('roster carries seat colours + slider axes', meta && meta.roster.length === 3 &&
    meta.roster[0].axis === 'h' && meta.roster[1].axis === 'v' && meta.roster[2].axis === 'v' &&
    meta.roster.map((r) => r.angle).join() === '0,60,120' &&
    meta.roster.every((r) => /^#[0-9A-F]{6}$/i.test(r.color)));

  const late = await joinAs('plate', 'Late');
  check('mid-match join rejected', !late.res.ok && late.res.reason === 'round-in-progress');
  late.s.close();
  const kickMid = await call(host, 'host:kick', { playerId: 'pc' });
  check('kicking is lobby-only', kickMid && !kickMid.ok);
  check('no target change mid-match', !(await call(host, 'host:setTarget', { mode: 'lives', value: 1 })).ok);
  check('no reordering mid-match', !(await call(host, 'host:reorder', { playerId: 'pc', beforeId: 'pa' })).ok);

  // ---- Input relay ----
  a.s.emit('in', { p: 250 });
  a.s.emit('in', { p: 1500 });
  a.s.emit('in', { p: 'x' });
  await wait(80);
  check('valid input relayed to the host', hostIns.some((x) => x.id === 'pa' && x.p === 250));
  check('out-of-range input dropped', !hostIns.some((x) => x.p === 1500 || x.p === 'x'));

  // ---- Countdown / play / sync ----
  host.emit('host:countdown', { n: 3, note: 'GET READY' });
  host.emit('host:play', {});
  host.emit('host:sync', { scores: { pa: 5, pb: 5, pc: 5 }, out: [], live: true, paused: false });
  await wait(80);
  check('players get countdown + play', b.evs.some((x) => x[0] === 'm:countdown' && x[1].n === 3) && b.evs.some((x) => x[0] === 'm:play'));
  check('players get the heartbeat', b.evs.some((x) => x[0] === 'm:sync' && x[1].live === true));

  // ---- A dropped phone stays in the game ----
  c.s.close();
  await wait(100);
  host.emit('host:point', { concededId: 'pb', scorerId: null, eliminatedId: null, scores: { pa: 5, pb: 4, pc: 5 }, out: [] });
  await wait(80);
  const pt = a.evs.filter((x) => x[0] === 'm:point').pop();
  check('players get the point with updated lives', pt && pt[1].scores.pb === 4 && pt[1].concededId === 'pb');
  const reAuth = await call(host, 'host:auth');
  check('dropped player still on the roster', reAuth.match.roster.length === 3 && reAuth.match.roster.some((r) => r.id === 'pc' && r.connected === false));
  check('their lives are untouched', reAuth.match.scores.pc === 5);
  const c2 = mk();
  await connected(c2);
  const rec = await call(c2, 'player:reconnect', { playerId: 'pc' });
  check('reconnect mid-match returns the full snapshot', rec && rec.ok && rec.phase === 'PLAYING' &&
    rec.match && rec.match.scores.pb === 4 && rec.match.mode === 'lives');

  // ---- Scores are sanitised ----
  host.emit('host:point', { concededId: 'pb', eliminatedId: 'pb', scores: { pa: 99, pb: -3, zz: 4 }, out: ['pb', 'zz', 'pb'] });
  await wait(80);
  const pt2 = a.evs.filter((x) => x[0] === 'm:point').pop();
  check('scores clamped to the target', pt2 && pt2[1].scores.pa === 5 && pt2[1].scores.pb === 0 && pt2[1].scores.zz === undefined);
  check('out list keeps only roster ids, once', pt2 && pt2[1].out.join() === 'pb' && pt2[1].eliminatedId === 'pb');

  // ---- Pause gates input ----
  host.emit('host:pause', {});
  await wait(40);
  const before = hostIns.length;
  a.s.emit('in', { p: 700 });
  await wait(60);
  check('input ignored while paused', hostIns.length === before);
  host.emit('host:resume', { live: true });
  await wait(40);
  check('players get pause + resume', b.evs.some((x) => x[0] === 'm:pause') && b.evs.some((x) => x[0] === 'm:resume'));

  // ---- End ----
  host.emit('host:matchEnd', { winnerId: 'pa', scores: { pa: 2, pb: 0, pc: 0 }, out: ['pb', 'pc'] });
  await wait(80);
  const end = a.evs.find((x) => x[0] === 'm:end');
  check('players get m:end with the winner', end && end[1].winnerId === 'pa');
  check('placings: winner, then last out first', end && end[1].placings.join() === 'pa,pc,pb');
  const fin = await call(host, 'host:auth');
  check('phase is FINAL', fin.phase === 'FINAL' && fin.match.winnerId === 'pa');

  await call(host, 'host:reset');
  await wait(80);
  check('reset returns to an empty lobby', last().phase === 'LOBBY' && last().total === 0);
  check('reset after a match keeps the targets', last().lives === 5 && last().pointsToWin === 7);
  check('players are told to rejoin', a.evs.some((x) => x[0] === 'state:reset'));

  // ---- 2-player duel: points mode, vertical sliders ----
  const x = await joinAs('px', 'Xena');
  await call(host, 'host:addBot');
  const st2 = await call(host, 'host:start');
  check('1 human + CPU can start', st2 && st2.ok);
  check('2P duel is points mode to 7', st2.match.mode === 'points' && st2.match.target === 7 &&
    st2.match.scores.px === 0 && st2.match.roster.every((r) => r.axis === 'v'));
  await call(host, 'host:reset');
  await wait(60);
  // A lobby reset returns targets to defaults.
  await call(host, 'host:reset');
  await wait(60);
  check('lobby reset restores default targets', last().pointsToWin === 5 && last().lives === 3);

  // ---- CPU-only games are allowed ----
  await call(host, 'host:addBot');
  await wait(60);
  check('a single CPU cannot start', last().canStart === false);
  await call(host, 'host:addBot');
  await call(host, 'host:addBot');
  await wait(60);
  check('CPUs alone can start', last().canStart === true && last().players.every((p) => p.isBot));
  const st3 = await call(host, 'host:start');
  check('CPU-only match starts in lives mode', st3 && st3.ok && st3.match.mode === 'lives' && st3.match.roster.length === 3);
  await call(host, 'host:reset');
  await wait(60);

  [a, b, x].forEach((p) => p.s.close());
  c2.close();
  host.close();
  console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
