'use strict';
// Headless end-to-end smoke test for Chomp-Man: lobby, start gating,
// CPU bots, input-relay gating, round-meta rebroadcast, elimination, reconnect,
// downtime-only reactions.
// Not a unit test — a socket-flow probe against a running server on :3000.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000/chompman';

function mk(opts) { return io(URL, Object.assign({ transports: ['websocket'], forceNew: true }, opts)); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name); if (!cond) failures++; }

async function main() {
  const host = mk();
  await new Promise((r) => host.on('connect', r));
  const auth = await new Promise((r) => host.emit('host:auth', {}, r));
  check('host:auth ok (LOBBY)', auth && auth.ok && auth.phase === 'LOBBY');

  const hostLobbies = [];
  host.on('state:lobby', (l) => hostLobbies.push(l));

  // Start with too few players is blocked.
  const early = await new Promise((r) => host.emit('host:start', {}, r));
  check('start blocked with 0 players', early && !early.ok);

  // One human joins.
  const p1 = mk();
  await new Promise((r) => p1.on('connect', r));
  const j1 = await new Promise((r) => p1.emit('player:join', { playerId: 'p1', name: 'Alice' }, r));
  check('p1 join ok', j1 && j1.ok);
  await wait(60);
  let lob = hostLobbies[hostLobbies.length - 1];
  check('1 player → solo mode, can start', lob && lob.total === 1 && lob.canStart === true && lob.mode === 'solo');

  // Reactions: downtime only, cooldown-throttled, host-mutable.
  const ask = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
  const hostReactions = [];
  host.on('host:reaction', (d) => hostReactions.push(d));
  const rLobby = await ask(p1, 'player:reaction', { index: 2 });
  await wait(40);
  check('lobby reaction ok + relayed to the host', rLobby && rLobby.ok && hostReactions.some((d) => d.id === 'p1' && d.index === 2));
  const rAgain = await ask(p1, 'player:reaction', { index: 0 });
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
  const notJoined = mk();
  await new Promise((r) => notJoined.on('connect', r));
  const rAnon = await ask(notJoined, 'player:reaction', { index: 0 });
  check('reaction from a non-player refused', rAnon && !rAnon.ok && rAnon.reason === 'not-joined');
  notJoined.close();

  // Config setters.
  const rw = await new Promise((r) => host.emit('host:setRoundsToWin', { roundsToWin: 2 }, r));
  check('setRoundsToWin ok', rw && rw.ok && rw.roundsToWin === 2);
  const rl = await new Promise((r) => host.emit('host:setRoundLength', { roundLengthSec: 60 }, r));
  check('setRoundLength ok', rl && rl.ok && rl.roundLengthSec === 60);

  // Add a CPU to make it 2 → canStart.
  const bot = await new Promise((r) => host.emit('host:addBot', {}, r));
  check('addBot ok', bot && bot.ok);
  await wait(60);
  lob = hostLobbies[hostLobbies.length - 1];
  check('2 players (1 human + CPU) canStart, multiplayer', lob && lob.total === 2 && lob.canStart === true && lob.mode === 'multi');
  check('roster has a bot with a colour', lob.players.some((p) => p.isBot && p.color));

  // Player receives m:start and round events.
  const pev = [];
  ['m:start', 'm:roundStart', 'm:countdown', 'm:play', 'm:clock', 'm:powered', 'm:eliminated', 'm:pause', 'm:resume', 'm:roundOver', 'm:end'].forEach((e) => p1.on(e, (d) => pev.push([e, d])));
  const relayed = [];
  host.on('in', (d) => relayed.push(d));

  const start = await new Promise((r) => host.emit('host:start', {}, r));
  check('host:start ok with roster', start && start.ok && Array.isArray(start.roster) && start.roster.length === 2);
  check('start echoes config', start.roundsToWin === 2 && start.roundLengthSec === 60);
  await wait(60);
  check('player got m:start', pev.some((e) => e[0] === 'm:start'));

  // Input BEFORE the round is live must NOT be relayed.
  p1.emit('in', { dir: 3 });
  await wait(40);
  check('input dropped before live', !relayed.some((d) => d && d.id === 'p1'));

  // Host drives the round meta.
  host.emit('host:roundStart', { round: 1, mazeIndex: 0, durationSec: 60 });
  await wait(30);
  host.emit('host:play', {});
  await wait(40);
  check('player got m:roundStart', pev.some((e) => e[0] === 'm:roundStart'));
  check('player got m:play', pev.some((e) => e[0] === 'm:play'));

  // Now input IS relayed with id + dir.
  p1.emit('in', { dir: 2 });
  await wait(40);
  check('input relayed once live', relayed.some((d) => d && d.id === 'p1' && d.dir === 2));
  const rLive = await ask(p1, 'player:reaction', { index: 1 });
  check('no reactions mid-round', rLive && !rLive.ok && rLive.reason === 'phase-closed');

  // Pause blocks input relay; resume restores it.
  host.emit('host:pause', {});
  await wait(40);
  check('player got m:pause', pev.some((e) => e[0] === 'm:pause'));
  const beforePause = relayed.length;
  p1.emit('in', { dir: 1 });
  await wait(40);
  check('input dropped while paused', relayed.length === beforePause);
  host.emit('host:resume', { live: true });
  await wait(40);
  check('player got m:resume (live)', pev.some((e) => e[0] === 'm:resume' && e[1] && e[1].live === true));
  p1.emit('in', { dir: 3 });
  await wait(40);
  check('input relayed after resume', relayed.some((d) => d && d.id === 'p1' && d.dir === 3));

  // Powered + clock + elimination rebroadcasts.
  host.emit('host:powered', { id: 'p1', on: true });
  host.emit('host:clock', { ms: 42000, scores: { p1: 120 } });
  await wait(40);
  check('player got m:powered', pev.some((e) => e[0] === 'm:powered' && e[1] && e[1].on === true));
  check('player got m:clock with scores', pev.some((e) => e[0] === 'm:clock' && e[1] && e[1].scores && e[1].scores.p1 === 120));

  host.emit('host:eliminated', { id: 'p1' });
  await wait(40);
  check('player got m:eliminated', pev.some((e) => e[0] === 'm:eliminated' && e[1] && e[1].id === 'p1'));

  // Input from an ELIMINATED player must NOT be relayed.
  const beforeLen = relayed.length;
  p1.emit('in', { dir: 0 });
  await wait(40);
  check('eliminated player input dropped', relayed.length === beforeLen);

  // Reconnect mid-round returns PLAYING + match meta (alive=false for p1).
  const p1b = mk();
  await new Promise((r) => p1b.on('connect', r));
  const rec = await new Promise((r) => p1b.emit('player:reconnect', { playerId: 'p1' }, r));
  check('reconnect returns PLAYING + meta', rec && rec.ok && rec.phase === 'PLAYING' && rec.match);
  check('reconnect meta shows eliminated', rec.match && rec.match.alive && rec.match.alive.p1 === false);

  // Round over → game points; then match end.
  host.emit('host:roundOver', { round: 1, scores: { p1: 120, 'bot-1': 90 }, winnerIds: ['p1'], gamePoints: { p1: 1 }, alive: { p1: false } });
  await wait(40);
  check('player got m:roundOver', pev.some((e) => e[0] === 'm:roundOver' && e[1] && e[1].winnerIds.indexOf('p1') >= 0));
  await wait(5100); // let the lobby reaction's cooldown lapse
  const rRound = await ask(p1b, 'player:reaction', { index: 3 });
  await wait(40);
  check('reactions open on the round result', rRound && rRound.ok && hostReactions.some((d) => d.id === 'p1' && d.index === 3));
  const p1c = mk();
  await new Promise((r) => p1c.on('connect', r));
  const recRo = await ask(p1c, 'player:reconnect', { playerId: 'p1' });
  check('reconnect snapshot flags the round result', recRo && recRo.ok && recRo.match && recRo.match.roundOver === true && recRo.reactionsMuted === false);
  host.emit('host:countdown', { n: 3 });
  await wait(40);
  const rNext = await ask(p1c, 'player:reaction', { index: 0 });
  check('reactions close again when the next round starts', rNext && !rNext.ok && rNext.reason === 'phase-closed');

  host.emit('host:matchEnd', { winnerIds: ['p1'], gamePoints: { p1: 2 } });
  await wait(40);
  check('player got m:end', pev.some((e) => e[0] === 'm:end' && e[1] && e[1].winnerIds.indexOf('p1') >= 0));
  await wait(5100);
  const rFinal = await ask(p1c, 'player:reaction', { index: 5 });
  await wait(40);
  check('reactions open on the final results', rFinal && rFinal.ok && hostReactions.some((d) => d.id === 'p1' && d.index === 5));

  // Hub (host:leave) puts the mute back to its default.
  await ask(host, 'host:setReactionsMuted', { muted: true });
  await ask(host, 'host:leave', {});
  const authBack = await ask(host, 'host:auth', {});
  check('host:leave resets reactions to unmuted', authBack && authBack.ok && authBack.reactionsMuted === false);

  // Reset returns to lobby.
  await new Promise((r) => host.emit('host:reset', {}, r));
  await wait(40);

  [host, p1, p1b, p1c].forEach((s) => s.close());
  console.log('\n' + (failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
