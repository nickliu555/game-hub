'use strict';

// Headless end-to-end integration test for Herd Mind. Spins up an in-process
// server, connects a host + 4 player sockets, and drives a full game with
// SCRIPTED answers to force known outcomes (majority scoring, Pink Cow moves,
// and a clean win), asserting the broadcast payloads at each step.
//
//   node scripts/itest-herdmind.js   (or: npm run itest:herdmind)

// Keep grouping deterministic (no Groq) regardless of the caller's env.
delete process.env.GROQ_API_KEY;

const assert = require('assert');
const http = require('http');
const express = require('express');
const { io: Client } = require('socket.io-client');
const mountHerdMind = require('../server/herdmind');

const app = express();
const server = http.createServer(app);
mountHerdMind(app, server, { getPublicBaseUrl: () => 'http://localhost' });

// Answers per round → forces: R1 dog-herd + D cow; R3 A reaches target 3 alone.
const SCRIPT = {
  1: { A: 'dog', B: 'dog', C: 'dog', D: 'cat' },
  2: { A: 'sun', B: 'sun', C: 'moon', D: 'star' },
  3: { A: 'red', B: 'blue', C: 'red', D: 'green' },
};
const TARGET = 3;

let failed = false;
function check(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failed = true; console.log('  ✗ ' + msg); }
}

function connect() {
  return new Promise((resolve) => {
    const url = 'http://localhost:' + server.address().port + '/herdmind';
    const s = Client(url, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
  });
}

(async () => {
  await new Promise((r) => server.listen(0, r));

  // ---- Host ----
  const host = await connect();
  await new Promise((res) => host.emit('host:auth', {}, () => res()));

  // ---- Players ----
  const letters = ['A', 'B', 'C', 'D'];
  const pidByLetter = {};
  const letterByPid = {};
  for (const L of letters) {
    const s = await connect();
    const pid = 'pid_' + L;
    pidByLetter[L] = pid; letterByPid[pid] = L;
    await new Promise((res, rej) => {
      s.emit('player:join', { playerId: pid, name: L }, (ack) => {
        if (ack && ack.ok) res(); else rej(new Error('join ' + L + ' failed: ' + JSON.stringify(ack)));
      });
    });
    // Each player answers per the script when a question opens.
    s.on('state:question', (q) => {
      const ans = SCRIPT[q.round] && SCRIPT[q.round][L];
      if (ans) s.emit('player:answer', { questionId: q.id, answer: ans });
    });
  }

  const done = new Promise((resolve) => {
    // Host echoes the auto-grouped buckets straight back (exercises host:score
    // validation + scoring). Distinct words → one bucket per distinct answer.
    host.on('state:review', (p) => {
      const groups = (p.groups || []).map((g) => ({
        id: g.id, label: g.label,
        members: g.members.map((m) => ({ playerId: m.playerId })),
      }));
      host.emit('host:score', { groups });
    });

    host.on('state:reveal', (r) => {
      console.log('\nRound ' + r.round + ' reveal:');
      if (r.round === 1) {
        const maj = r.groups.find((g) => g.isMajority);
        check(maj && maj.size === 3, 'R1 majority bucket has 3 players');
        check(r.cowHolderId === pidByLetter.D, 'R1 Pink Cow goes to sole odd-one-out D');
        check(!r.gameOver, 'R1 game not over');
      }
      if (r.round === 2) {
        check(r.cowHolderId === pidByLetter.D, 'R2 cow stays with D (two singletons)');
        const lbA = r.leaderboard.find((e) => e.id === pidByLetter.A);
        check(lbA && lbA.score === 2, 'R2 A has 2 points');
      }
      if (r.round === 3) {
        check(r.gameOver, 'R3 game is over');
        check(r.winnerId === pidByLetter.A, 'R3 winner is sole leader A');
      }
      // Advance: next question, or (when the game is won) on to the results.
      setTimeout(() => host.emit('host:next', {}), 30);
    });

    host.on('state:final', (f) => {
      check(f.winnerName === 'A', 'final winner name is A');
      check(f.fullLeaderboard.length === 4, 'final leaderboard has 4 players');
      const aRow = f.fullLeaderboard.find((e) => e.name === 'A');
      check(aRow && aRow.rank === 1 && aRow.score === 3, 'A is rank 1 with 3 points');
      resolve();
    });
  });

  // Kick off the game (short timer; all-answered ends each question fast).
  host.emit('host:start', { timeLimitSec: 30, targetScore: TARGET, autoAdvance: false });

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 15000));
  try {
    await Promise.race([done, timeout]);
  } catch (e) {
    failed = true;
    console.log('\n✗ ' + e.message);
  }

  host.close();
  server.close();
  console.log('');
  if (failed) { console.log('✗ Integration test FAILED.'); process.exit(1); }
  console.log('✓ Herd Mind integration test passed.');
  process.exit(0);
})();
