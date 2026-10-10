'use strict';
// Headless end-to-end smoke test for Blob Ball: lobby, sides, CPU, target,
// capacity, swap, input relay, reactions (phase-gated + cooldown + mute),
// serve/point/sync relay, reconnect, roster locking, match end and reset.
const { io } = require('socket.io-client');
const URL = process.env.BLOBBALL_URL || 'http://localhost:3000/blobball';

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
  if (auth && (auth.phase !== 'LOBBY' || (auth.lobby && auth.lobby.total))) {
    await call(host, 'host:reset');
    await call(host, 'host:reset');
    auth = await call(host, 'host:auth');
  }
  check('host:auth ok in LOBBY', auth && auth.ok && auth.phase === 'LOBBY');
  check('capacity is 2, default first to 10', auth.lobby.capacity === 2 && auth.lobby.pointsToWin === 10 &&
    auth.lobby.pointOptions.join() === '5,7,10,12,15');

  const lobbies = [];
  host.on('state:lobby', (l) => lobbies.push(l));
  const last = () => lobbies[lobbies.length - 1];
  const hostIns = [];
  host.on('in', (d) => hostIns.push(d));
  const hostReacts = [];
  host.on('host:reaction', (d) => hostReacts.push(d));

  // ---- Joins + sides ----
  const a = await joinAs('pa', 'Alice');
  await wait(60);
  check('one player cannot start', a.res.ok && last().total === 1 && last().canStart === false);
  check('swap needs two players', !(await call(host, 'host:swap')).ok);
  const dup = await joinAs('pdup', 'alice');
  check('duplicate name rejected', !dup.res.ok && dup.res.reason === 'name-taken');
  dup.s.close();
  const longName = 'W'.repeat(40);
  const b = await joinAs('pb', longName);
  await wait(60);
  check('names are capped at 20 characters', b.res.ok && b.res.player.name.length === 20);
  check('first joiner plays left, second right', last().players[0].id === 'pa' && last().players[0].side === 'Left side' &&
    last().players[1].id === 'pb' && last().players[1].side === 'Right side');
  check('two players → startable', last().canStart === true);
  const c = await joinAs('pc', 'Cara');
  check('a third join is rejected: game full', !c.res.ok && c.res.reason === 'game-full');
  c.s.close();
  check('no CPU past 2', !(await call(host, 'host:addBot')).ok);

  check('swap sides ok', (await call(host, 'host:swap')).ok);
  await wait(60);
  check('Bob now on the left in green', last().players[0].id === 'pb' && last().players[0].color === '#5BE06B');
  check('players cannot swap', !(await call(a.s, 'host:swap')).ok);
  await call(host, 'host:swap');

  // ---- Target ----
  check('points target accepted', (await call(host, 'host:setTarget', { value: 5 })).ok);
  check('bad target rejected', !(await call(host, 'host:setTarget', { value: 3 })).ok);
  check('players cannot change the target', !(await call(a.s, 'host:setTarget', { value: 12 })).ok);
  await wait(60);
  check('lobby reflects the target', last().pointsToWin === 5);

  // ---- Kick (lobby) + CPU ----
  check('kick in the lobby', (await call(host, 'host:kick', { playerId: 'pb' })).ok);
  await wait(60);
  check('kicked player is told', b.evs.some((x) => x[0] === 'player:rejected'));
  check('Alice keeps the left side', last().total === 1 && last().players[0].id === 'pa' && last().players[0].seat === 0);
  check('add CPU ok', (await call(host, 'host:addBot')).ok);
  await wait(60);
  check('CPU takes the right side and can start', last().players[1].isBot && last().players[1].seat === 1 && last().canStart);
  check('remove CPU', (await call(host, 'host:kick', { playerId: 'bot-1' })).ok);
  b.s.close();
  const b2 = await joinAs('pb2', 'Bob');
  await wait(60);
  check('Bob rejoins on the right', last().players[1].id === 'pb2');

  // ---- Reactions in the lobby ----
  const r1 = await call(a.s, 'player:reaction', { index: 2 });
  await wait(60);
  check('lobby reaction relayed', r1 && r1.ok && hostReacts.some((x) => x.index === 2 && x.id === 'pa'));
  const r2 = await call(a.s, 'player:reaction', { index: 1 });
  check('reaction cooldown enforced', r2 && !r2.ok && r2.reason === 'cooldown');
  check('bad reaction index rejected', !(await call(b2.s, 'player:reaction', { index: 9 })).ok);
  await call(host, 'host:setReactionsMuted', { muted: true });
  const r3 = await call(b2.s, 'player:reaction', { index: 0 });
  check('muted reactions rejected', r3 && !r3.ok && r3.reason === 'muted');
  check('players hear about the mute', a.evs.some((x) => x[0] === 'state:reactionsMuted' && x[1].muted === true));
  await call(host, 'host:setReactionsMuted', { muted: false });

  // ---- Start ----
  const start = await call(host, 'host:start');
  await wait(80);
  check('start ok', start && start.ok);
  const mStart = a.evs.find((x) => x[0] === 'm:start');
  const meta = mStart && mStart[1];
  check('players get m:start, first to 5, 0–0', meta && meta.target === 5 && meta.scores.pa === 0 && meta.scores.pb2 === 0);
  check('roster carries sides + colours', meta && meta.roster[0].id === 'pa' && meta.roster[0].seat === 0 &&
    meta.roster[1].side === 'Right side' && meta.roster.every((r) => /^#[0-9A-F]{6}$/i.test(r.color)));

  const late = await joinAs('plate', 'Late');
  check('mid-match join rejected', !late.res.ok && late.res.reason === 'round-in-progress');
  late.s.close();
  check('kicking is lobby-only', !(await call(host, 'host:kick', { playerId: 'pb2' })).ok);
  check('no target change mid-match', !(await call(host, 'host:setTarget', { value: 7 })).ok);
  check('no swapping mid-match', !(await call(host, 'host:swap')).ok);
  check('no CPU mid-match', !(await call(host, 'host:addBot')).ok);

  // ---- Reactions are closed during play ----
  await wait(5100); // let the lobby cooldown lapse
  const r4 = await call(a.s, 'player:reaction', { index: 3 });
  check('reactions rejected mid-match (phase-closed)', r4 && !r4.ok && r4.reason === 'phase-closed');

  // ---- Input relay ----
  a.s.emit('in', { c: 1, d: 1 });
  a.s.emit('in', { c: 2, d: 0 });
  a.s.emit('in', { c: 3, d: 1 });
  a.s.emit('in', { c: 'x', d: 1 });
  await wait(80);
  check('valid input relayed with the player id', hostIns.some((x) => x.id === 'pa' && x.c === 1 && x.d === 1) &&
    hostIns.some((x) => x.id === 'pa' && x.c === 2 && x.d === 0));
  check('unknown buttons dropped', !hostIns.some((x) => x.c === 3 || x.c === 'x'));

  // ---- Countdown / serve / play / sync / point ----
  host.emit('host:countdown', { n: 3, note: 'GET READY' });
  host.emit('host:serve', { serverId: 'pb2' });
  host.emit('host:play', {});
  host.emit('host:sync', { scores: { pa: 0, pb2: 0 }, live: true, paused: false });
  await wait(80);
  check('players get countdown, serve and play', b2.evs.some((x) => x[0] === 'm:countdown' && x[1].n === 3) &&
    b2.evs.some((x) => x[0] === 'm:serve' && x[1].serverId === 'pb2') && b2.evs.some((x) => x[0] === 'm:play'));
  check('players get the heartbeat', b2.evs.some((x) => x[0] === 'm:sync' && x[1].live === true));
  host.emit('host:point', { scorerId: 'pa', scores: { pa: 1, pb2: 0 } });
  await wait(80);
  const pt = b2.evs.filter((x) => x[0] === 'm:point').pop();
  check('players get the point', pt && pt[1].scorerId === 'pa' && pt[1].scores.pa === 1);

  // ---- A dropped phone stays in the game ----
  b2.s.close();
  await wait(100);
  const dropped = [];
  host.on('player:dropped', (d) => dropped.push(d));
  const reAuth = await call(host, 'host:auth');
  check('dropped player still on the roster', reAuth.match.roster.length === 2 &&
    reAuth.match.roster.some((r) => r.id === 'pb2' && r.connected === false));
  check('scores survive a drop', reAuth.match.scores.pa === 1 && reAuth.match.scores.pb2 === 0);
  const b3 = mk();
  const b3Evs = [];
  b3.onAny((ev, d) => b3Evs.push([ev, d]));
  await connected(b3);
  const rec = await call(b3, 'player:reconnect', { playerId: 'pb2' });
  check('reconnect mid-match returns the full snapshot', rec && rec.ok && rec.phase === 'PLAYING' &&
    rec.match && rec.match.scores.pa === 1 && rec.match.target === 5);

  // ---- Scores are sanitised ----
  host.emit('host:point', { scorerId: 'zz', scores: { pa: 99, pb2: -3, zz: 4 } });
  await wait(80);
  const pt2 = a.evs.filter((x) => x[0] === 'm:point').pop();
  check('scores clamped to the target, unknown ids dropped', pt2 && pt2[1].scores.pa === 5 && pt2[1].scores.pb2 === 0 &&
    pt2[1].scores.zz === undefined && pt2[1].scorerId === null);

  // ---- Pause still relays releases ----
  host.emit('host:pause', {});
  await wait(40);
  const before = hostIns.length;
  a.s.emit('in', { c: 1, d: 0 });
  await wait(60);
  check('button releases still reach the host while paused', hostIns.length === before + 1);
  host.emit('host:resume', { live: true });
  await wait(40);
  check('players get pause + resume', a.evs.some((x) => x[0] === 'm:pause') && a.evs.some((x) => x[0] === 'm:resume'));

  // ---- End ----
  host.emit('host:matchEnd', { winnerId: 'pa', scores: { pa: 3, pb2: 1 } });
  await wait(80);
  const end = a.evs.find((x) => x[0] === 'm:end');
  check('players get m:end with the winner', end && end[1].winnerId === 'pa' && end[1].scores.pa === 3);
  const fin = await call(host, 'host:auth');
  check('phase is FINAL', fin.phase === 'FINAL' && fin.match.winnerId === 'pa');
  const r5 = await call(a.s, 'player:reaction', { index: 4 });
  check('reactions reopen on the final screen', r5 && r5.ok);

  // ---- Play again: straight into a fresh match, no lobby ----
  check('players cannot start a rematch', !(await call(a.s, 'host:rematch')).ok);
  const startsBefore = b3Evs.filter((x) => x[0] === 'm:start').length;
  const rm = await call(host, 'host:rematch');
  await wait(80);
  check('rematch from the results screen ok', rm && rm.ok);
  check('rematch: same players, same sides, same target, 0–0', rm.match && rm.match.target === 5 &&
    rm.match.roster.map((r) => r.id).join() === 'pa,pb2' && rm.match.scores.pa === 0 && rm.match.scores.pb2 === 0 && rm.match.winnerId === null);
  check('players are sent straight into the new match', b3Evs.filter((x) => x[0] === 'm:start').length === startsBefore + 1);
  const re = await call(host, 'host:auth');
  check('phase is PLAYING again', re.phase === 'PLAYING');
  check('rematch only from the results screen', !(await call(host, 'host:rematch')).ok);
  check('reactions close again for the rematch', (await call(a.s, 'player:reaction', { index: 0 })).reason === 'phase-closed');
  host.emit('host:matchEnd', { winnerId: 'pb2', scores: { pa: 2, pb2: 5 } });
  await wait(80);

  await call(host, 'host:reset');
  await wait(80);
  check('reset returns to an empty lobby', last().phase === 'LOBBY' && last().total === 0);
  check('reset after a match keeps the target', last().pointsToWin === 5);
  check('players are told to rejoin', a.evs.some((x) => x[0] === 'state:reset'));
  await call(host, 'host:reset');
  await wait(60);
  check('lobby reset restores the default target', last().pointsToWin === 10);

  // ---- CPU vs CPU is allowed (a demo match) ----
  await call(host, 'host:addBot');
  await call(host, 'host:addBot');
  await wait(60);
  const st3 = await call(host, 'host:start');
  check('CPU vs CPU can start', st3 && st3.ok && st3.match.roster.every((r) => r.isBot));
  await call(host, 'host:reset');
  await call(host, 'host:reset');
  await wait(60);

  [a, b2].forEach((p) => p.s.close());
  b3.close();
  host.close();
  console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
