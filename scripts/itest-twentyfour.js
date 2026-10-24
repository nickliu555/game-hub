'use strict';

// End-to-end smoke test for the 24 socket flow, focused on "Play again".
// Requires the server to be running (default localhost:3000; override with
// TWENTYFOUR_URL). Plays a short Race game to the results, then checks the
// host-only rematch: refused mid-game / for non-hosts, same roster + settings,
// scores reset, the game plays again, no late joins, no double-fire. Then does
// the same for a short Sprint game. Not part of the app — a dev harness.

const { io } = require('socket.io-client');
const { replay } = require('../server/twentyfour/solver');

const URL = process.env.TWENTYFOUR_URL || 'http://localhost:3000/twentyfour';

function connect() {
  return io(URL, { transports: ['websocket'], forceNew: true });
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function onConnect(sock) {
  return new Promise((res) => { if (sock.connected) return res(); sock.once('connect', res); });
}
function emit(sock, ev, payload) {
  return new Promise((r) => sock.emit(ev, payload, r));
}
function waitFor(sock, ev, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms || 8000);
    sock.once(ev, (d) => { clearTimeout(t); res(d); });
  });
}

// Brute-force a sequence of combine steps that reaches 24.
const OPS = ['+', '-', '*', '/'];
function findSteps(numbers) {
  let found = null;
  const dfs = (ids, steps) => {
    if (found) return;
    if (ids.length === 1) {
      const r = replay(numbers, steps);
      if (r.ok && r.reached24) found = steps;
      return;
    }
    for (const a of ids) for (const b of ids) {
      if (a === b) continue;
      for (const op of OPS) {
        dfs(ids.filter((x) => x !== a), steps.concat([{ aId: a, op, bId: b }]));
        if (found) return;
      }
    }
  };
  dfs([0, 1, 2, 3], []);
  return found;
}

(async function main() {
  const fails = [];
  const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

  const host = connect();
  const p1 = connect();
  const p2 = connect();
  await onConnect(host);
  await emit(host, 'host:auth', {});
  await emit(host, 'host:reset', {});
  await onConnect(p1);
  await onConnect(p2);

  const pid1 = 'p1-' + Date.now();
  const pid2 = 'p2-' + Date.now();
  const j1 = await emit(p1, 'player:join', { playerId: pid1, name: 'Alice' });
  const j2 = await emit(p2, 'player:join', { playerId: pid2, name: 'Bob' });
  assert(j1.ok && j2.ok, 'both players joined');

  assert((await emit(host, 'host:rematch', {})).reason === 'not-final', 'play again is refused in the lobby');

  // ---- Race game: first to 3, 30s per problem, easy, manual advance ----
  const raceOpts = { mode: 'race', difficulty: 'easy', targetScore: 3, problemTimeLimitSec: 30, autoAdvance: false };
  let problem = waitFor(p1, 'state:raceProblem', 8000);
  assert((await emit(host, 'host:start', raceOpts)).ok, 'host started a race');
  let prob = await problem;
  assert((await emit(host, 'host:rematch', {})).reason === 'not-final', 'play again is refused mid-game');
  assert((await emit(p1, 'host:rematch', {})).reason === 'not-host', 'only the host can play again');

  async function winRace() {
    let finalEv = null;
    const onFinal = (f) => { finalEv = f; };
    p1.on('state:final', onFinal);
    for (let i = 0; i < 3; i++) {
      const steps = findSteps(prob.numbers);
      const r = await emit(p1, 'player:raceSolve', { puzzleId: prob.puzzleId, steps });
      if (!(r.ok && r.won)) return { ok: false };
      if (i < 2) {
        problem = waitFor(p1, 'state:raceProblem', 4000);
        await emit(host, 'host:nextProblem', {});
        prob = await problem;
      } else {
        await emit(host, 'host:nextProblem', {});
      }
    }
    await wait(200);
    p1.off('state:final', onFinal);
    return { ok: true, final: finalEv };
  }

  const g1 = await winRace();
  assert(g1.ok && g1.final, 'Alice won the first race and results were broadcast');
  const alice1 = g1.final && g1.final.fullLeaderboard.find((p) => p.id === pid1);
  assert(alice1 && alice1.score === 3, 'Alice finished the first race on 3');

  // Bob drops before Play again — he must stay on the roster.
  p2.close();
  await wait(200);

  const introP = waitFor(p1, 'state:intro', 3000);
  const lobbyP = waitFor(host, 'state:lobby', 3000);
  const again = await emit(host, 'host:rematch', {});
  assert(again && again.ok, 'host plays again from the results');
  const intro = await introP.catch(() => null);
  assert(!!intro, 'players get a fresh Get ready countdown');
  const lobby = await lobbyP.catch(() => null);
  assert(lobby && lobby.phase === 'INTRO' && lobby.total === 2, 'roster unchanged (2 players, incl. disconnected Bob)');
  assert(lobby && lobby.players.every((p) => p.score === 0), 'everyone is back to 0 during the intro');
  assert(lobby && lobby.players.some((p) => p.id === pid2 && !p.connected), 'disconnected Bob kept on the roster');
  assert((await emit(host, 'host:rematch', {})).reason === 'not-final', 'play again cannot be double-fired');

  const p3 = connect();
  await onConnect(p3);
  const j3 = await emit(p3, 'player:join', { playerId: 'p3-' + Date.now(), name: 'Carol' });
  assert(!j3.ok && j3.reason === 'round-in-progress', 'nobody new can join a rematch');

  // Bob reconnects mid-intro and lands on the new game.
  const p2b = connect();
  await onConnect(p2b);
  const rec = await emit(p2b, 'player:reconnect', { playerId: pid2 });
  assert(rec.ok && rec.phase === 'INTRO' && rec.intro && rec.player.score === 0, 'Bob reconnects into the rematch intro at 0');
  const hostRec = connect();
  await onConnect(hostRec);
  const hr = await emit(hostRec, 'host:auth', {});
  assert(hr.ok && hr.phase === 'INTRO' && hr.intro, 'a reconnecting host lands on the rematch intro');
  hostRec.close();

  problem = waitFor(p1, 'state:raceProblem', 8000);
  prob = await problem.catch(() => null);
  assert(!!prob, 'rematch serves a new race problem');
  assert(prob && prob.problemNumber === 1, 'rematch starts again at problem 1');
  assert(prob && prob.targetScore === 3 && prob.difficulty === 'easy' && prob.autoAdvance === false, 'rematch keeps race settings (first to 3, easy, manual advance)');
  assert(prob && prob.endsAt - prob.serverNow > 25000 && prob.endsAt - prob.serverNow <= 30100, 'rematch keeps the 30s problem time');
  assert(prob && prob.leaderboard.length === 2 && prob.leaderboard.every((p) => p.score === 0 && p.solvedCount === 0), 'leaderboard reset to 0 for both players');

  const g2 = await winRace();
  assert(g2.ok && g2.final, 'the rematch plays through to a second results screen');
  const alice2 = g2.final && g2.final.fullLeaderboard.find((p) => p.id === pid1);
  assert(alice2 && alice2.score === 3, 'Alice scored 3 in the rematch (not 6)');
  assert(g2.final && g2.final.raceRounds === 3, 'rounds played counted from zero');

  // ---- Sprint game: 0.1 min (6 s) round ----
  await emit(host, 'host:reset', {});
  const s1 = connect();
  await onConnect(s1);
  const spid = 's1-' + Date.now();
  assert((await emit(s1, 'player:join', { playerId: spid, name: 'Sam' })).ok, 'sprint player joined');
  assert((await emit(host, 'host:start', { mode: 'sprint', difficulty: 'medium', durationMin: 0.1 })).ok, 'host started a 6s sprint');
  let puzzle = await waitFor(s1, 'puzzle:next', 8000);
  const sr = await emit(s1, 'player:solve', { puzzleId: puzzle.puzzleId, steps: findSteps(puzzle.numbers) });
  assert(sr.ok && sr.accepted && sr.score > 0, 'sprint solve scored');
  const sf = await waitFor(s1, 'state:final', 9000);
  assert(sf.fullLeaderboard[0].score > 0, 'sprint results show the score');
  const roundP = waitFor(s1, 'state:round', 8000);
  assert((await emit(host, 'host:rematch', {})).ok, 'host plays the sprint again');
  const round = await roundP.catch(() => null);
  assert(round && round.phase === 'ROUND' && round.durationMs === 6000 && round.difficulty === 'medium', 'sprint rematch keeps 6s + medium');
  const srec = await emit(s1, 'player:reconnect', { playerId: spid });
  assert(srec.ok && srec.player.score === 0 && srec.currentPuzzle && srec.currentPuzzle.puzzleNumber === 1, 'sprint rematch: score 0, back on puzzle #1');
  await waitFor(s1, 'state:final', 9000);
  const sfrec = await emit(s1, 'player:reconnect', { playerId: spid });
  assert(sfrec.ok && sfrec.phase === 'FINAL' && sfrec.youFinal.unfinishedIds.length <= 1, 'sprint rematch results carry no previous-game skips');

  await emit(host, 'host:reset', {});
  host.close(); p1.close(); p2b.close(); p3.close(); s1.close();
  await wait(150);
  console.log(fails.length ? ('\nFAILED: ' + fails.length) : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
