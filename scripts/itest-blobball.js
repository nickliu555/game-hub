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
  check('capacity is 4, default first to 10', auth.lobby.capacity === 4 && auth.lobby.pointsToWin === 10 &&
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
  check('two players → startable 1v1', last().canStart === true && last().teams === false && last().mode === '1v1');

  // ---- Teams: a 3rd and 4th player switch to 2v1 / 2v2 ----
  const spot = (l, id) => { const p = l.players.find((q) => q.id === id); return p ? p.seat + ':' + p.slot : null; };
  const c = await joinAs('pc', 'Cara');
  await wait(60);
  check('a third player joins the left team → 2v1 teams', c.res.ok && last().teams === true && last().mode === '2v1' &&
    spot(last(), 'pa') === '0:0' && spot(last(), 'pc') === '0:1' && spot(last(), 'pb') === '1:0' && last().canStart);
  const cara = last().players.find((q) => q.id === 'pc');
  check('teammates share a colour family (Cara is Lime)', cara.color === '#C8F04B' && cara.colorName === 'Lime' && cara.side === 'Left side');
  check('a CPU fills the 4th spot → 2v2', (await call(host, 'host:addBot')).ok);
  await wait(60);
  check('2v2 lobby: CPU on the right in Rose', last().mode === '2v2' && spot(last(), 'bot-1') === '1:1' &&
    last().players.find((q) => q.id === 'bot-1').color === '#FFA0C8');
  const e5 = await joinAs('pe', 'Eve');
  check('a fifth join is rejected: game full', !e5.res.ok && e5.res.reason === 'game-full');
  e5.s.close();
  check('no CPU past 4', !(await call(host, 'host:addBot')).ok);
  check('drop onto a player swaps them', (await call(host, 'host:move', { playerId: 'pc', side: 1, slot: 1 })).ok);
  await wait(60);
  check('Cara and the CPU traded spots', spot(last(), 'pc') === '1:1' && spot(last(), 'bot-1') === '0:1');
  check('swap within a team (who serves first)', (await call(host, 'host:move', { playerId: 'pc', side: 1, slot: 0 })).ok);
  await wait(60);
  check('Cara now slot 0 on the right', spot(last(), 'pc') === '1:0' && spot(last(), 'pb') === '1:1');
  check('bad spots rejected', !(await call(host, 'host:move', { playerId: 'pc', side: 2, slot: 0 })).ok &&
    !(await call(host, 'host:move', { playerId: 'pc', side: 0, slot: 5 })).ok &&
    !(await call(host, 'host:move', { playerId: 'nobody', side: 0, slot: 0 })).ok);
  check('players cannot move seats', !(await call(a.s, 'host:move', { playerId: 'pa', side: 1, slot: 0 })).ok);
  await call(host, 'host:kick', { playerId: 'bot-1' });
  await wait(60);
  check('kick back to 3 → 1v2', last().mode === '1v2' && last().teams === true && spot(last(), 'pa') === '0:0');
  check('move onto an open spot', (await call(host, 'host:move', { playerId: 'pb', side: 0, slot: 1 })).ok);
  await wait(60);
  check('Bob moved to the left team → 2v1, Cara alone on the right', last().mode === '2v1' && spot(last(), 'pb') === '0:1' && spot(last(), 'pc') === '1:0');
  await call(host, 'host:kick', { playerId: 'pc' });
  c.s.close();
  await wait(60);
  check('back to 1v1 on opposite sides', last().mode === '1v1' && last().teams === false && spot(last(), 'pa') === '0:0' && spot(last(), 'pb') === '1:0');
  check('1v1: moving next to the other is undone (sides stay split)', (await call(host, 'host:move', { playerId: 'pa', side: 1, slot: 1 })).ok);
  await wait(60);
  check('…Alice is still on the left', spot(last(), 'pa') === '0:0' && spot(last(), 'pb') === '1:0');

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
  check('1v1 match is not teams', meta && meta.teams === false);
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

  // ---- A whiffed serve: relayed, no score change ----
  host.emit('host:miss', { serverId: 'pb2' });
  host.emit('host:miss', { serverId: 'nobody' });
  await wait(80);
  const misses = b2.evs.filter((x) => x[0] === 'm:miss');
  check('players hear about a missed serve (same server)', misses.length === 2 && misses[0][1].serverId === 'pb2');
  check('unknown server ids are dropped from a miss', misses[1][1].serverId === null);
  a.s.emit('host:miss', { serverId: 'pa' });
  await wait(60);
  check('players cannot fake a missed serve', b2.evs.filter((x) => x[0] === 'm:miss').length === 2);
  const afterMiss = await call(host, 'host:auth');
  check('a missed serve changes no score', afterMiss.match.scores.pa === 0 && afterMiss.match.scores.pb2 === 0);
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

  // ---- A 2v2 team match ----
  const t1 = await joinAs('t1', 'Tia');
  const t2 = await joinAs('t2', 'Tom');
  const t3 = await joinAs('t3', 'Tess');
  await call(host, 'host:addBot');
  await wait(60);
  check('2v2 lobby ready', last().mode === '2v2' && last().canStart);
  const ts = await call(host, 'host:start');
  await wait(80);
  const tm = ts && ts.match;
  check('team match starts with teams on', ts && ts.ok && tm.teams === true && tm.roster.length === 4);
  check('team roster: sides + slots + shades', tm.roster.map((r) => r.id + '@' + r.seat + ':' + r.slot).join() === 't1@0:0,t3@0:1,t2@1:0,bot-1@1:1' &&
    tm.roster[1].color === '#C8F04B' && tm.roster[3].color === '#FFA0C8');
  check('players are told it\'s teams', t2.evs.some((x) => x[0] === 'm:start' && x[1].teams === true));
  host.emit('host:point', { scorerId: 't1', scores: { t1: 2, t3: 2, t2: 1, 'bot-1': 1 } });
  await wait(60);
  host.emit('host:sync', { scores: { t1: 3, t3: 1, t2: 1, 'bot-1': 1 }, live: true, paused: false });
  await wait(60);
  const tsync = t3.evs.filter((x) => x[0] === 'm:sync').pop();
  check('teammates always share the team score', tsync && tsync[1].scores.t1 === 3 && tsync[1].scores.t3 === 3 && tsync[1].scores.t2 === 1);
  t3.s.close();
  await wait(80);
  const tAuth = await call(host, 'host:auth');
  check('a dropped teammate stays on the roster', tAuth.match.roster.length === 4 && tAuth.match.roster.some((r) => r.id === 't3' && r.connected === false));
  const t3b = mk();
  await connected(t3b);
  const t3rec = await call(t3b, 'player:reconnect', { playerId: 't3' });
  check('team reconnect snapshot says teams', t3rec.ok && t3rec.phase === 'PLAYING' && t3rec.match.teams === true && t3rec.match.scores.t3 === 3);
  host.emit('host:matchEnd', { winnerId: 't1', scores: { t1: 5, t3: 5, t2: 2, 'bot-1': 2 } });
  await wait(80);
  const tend = t2.evs.find((x) => x[0] === 'm:end');
  check('team match end relayed', tend && tend[1].winnerId === 't1' && tend[1].scores.t3 === 5);
  const trm = await call(host, 'host:rematch');
  check('team rematch keeps the teams', trm.ok && trm.match.teams === true &&
    trm.match.roster.map((r) => r.id + '@' + r.seat + ':' + r.slot).join() === 't1@0:0,t3@0:1,t2@1:0,bot-1@1:1');
  await call(host, 'host:reset');
  await call(host, 'host:reset');
  await wait(60);
  [t1, t2].forEach((p) => p.s.close());
  t3b.close();

  [a, b2].forEach((p) => p.s.close());
  b3.close();
  host.close();
  console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
