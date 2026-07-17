'use strict';

// Headless end-to-end integration test for Ranking. Spins up an in-process
// server, connects a host + 3 player sockets, and drives a full co-op game,
// asserting role assignment (each player ranker once + submitter once, never
// both in a round), the live scoring (matches → group, misses → game), and the
// final win/lose tally.
//
//   node scripts/itest-ranking.js   (or: npm run itest:ranking)

const assert = require('assert');
const http = require('http');
const express = require('express');
const { io: Client } = require('socket.io-client');
const mountRanking = require('../server/ranking');

const app = express();
const server = http.createServer(app);
mountRanking(app, server, { getPublicBaseUrl: () => 'http://localhost' });

let failed = false;
function check(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failed = true; console.log('  ✗ ' + msg); }
}

function connect() {
  return new Promise((resolve) => {
    const url = 'http://localhost:' + server.address().port + '/ranking';
    const s = Client(url, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
  });
}

// A buffered event waiter so no broadcast is missed between awaits.
function makeQueue(socket, event) {
  const q = [];
  const waiters = [];
  socket.on(event, (p) => { if (waiters.length) waiters.shift()(p); else q.push(p); });
  return () => (q.length ? Promise.resolve(q.shift()) : new Promise((r) => waiters.push(r)));
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload || {}, resolve));
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  console.log('Ranking itest on port', server.address().port);

  const host = await connect();
  await emitAck(host, 'host:auth', {});

  const NAMES = ['Alice', 'Bob', 'Cara'];
  const N = NAMES.length;
  const byId = {};       // playerId -> socket
  const nameById = {};
  const rankItemsQ = {}; // playerId -> queue for you:rankItems

  for (let i = 0; i < N; i++) {
    const s = await connect();
    const pid = 'pid-' + i;
    const res = await emitAck(s, 'player:join', { playerId: pid, name: NAMES[i] });
    check(res && res.ok, 'player ' + NAMES[i] + ' joined');
    byId[pid] = s;
    nameById[pid] = NAMES[i];
    rankItemsQ[pid] = makeQueue(s, 'you:rankItems');
  }

  // Reset now clears the whole lobby, so players must rejoin before a restart.
  async function rejoinAll() {
    for (const pid of Object.keys(byId)) {
      await emitAck(byId[pid], 'player:join', { playerId: pid, name: nameById[pid] });
    }
  }

  // Queues on the host for the phase broadcasts we drive against.
  const hostRank = makeQueue(host, 'state:rank');
  const hostDiscuss = makeQueue(host, 'state:discuss');
  const hostReveal = makeQueue(host, 'state:reveal');
  const hostFinal = makeQueue(host, 'state:final');

  // Classic mode: turn Custom Words OFF so start goes straight into the game.
  const cwOff = await emitAck(host, 'host:setCustomWords', { on: false });
  check(cwOff && cwOff.ok && cwOff.customWords === false, 'custom words toggled off');

  const startRes = await emitAck(host, 'host:start', {});
  check(startRes && startRes.ok, 'host started the game');

  const rankerSeen = {};
  const submitterSeen = {};
  let runningGroup = 0;
  let runningGame = 0;

  for (let r = 1; r <= N; r++) {
    const rank = await hostRank();
    check(rank.round === r, 'round ' + r + ' rank broadcast (round=' + rank.round + ')');
    const rankerId = rank.rankerId;
    rankerSeen[rankerId] = (rankerSeen[rankerId] || 0) + 1;

    // The ranker privately receives the 5 items; lock in a known secret order.
    const itemsMsg = await rankItemsQ[rankerId]();
    const R = itemsMsg.items.map((it) => it.id);
    check(R.length === 5, 'ranker got 5 items');
    const uniqueTexts = new Set(itemsMsg.items.map((it) => it.text));
    check(uniqueTexts.size === 5, 'the 5 items are distinct');
    await emitAck(byId[rankerId], 'player:rank', { order: R });

    const discuss = await hostDiscuss();
    check(discuss.submitterId !== rankerId, 'submitter is NOT the ranker (round ' + r + ')');
    submitterSeen[discuss.submitterId] = (submitterSeen[discuss.submitterId] || 0) + 1;

    // Submitter's guess: identity on odd rounds (5/5), swap the top two on even.
    const sub = R.slice();
    if (r % 2 === 0) { const t = sub[0]; sub[0] = sub[1]; sub[1] = t; }
    const expected = sub.reduce((a, v, i) => a + (v === R[i] ? 1 : 0), 0);

    // A live consensus nudge should mirror to the host before the final submit.
    await emitAck(byId[discuss.submitterId], 'player:consensus', { order: sub });
    await emitAck(byId[discuss.submitterId], 'player:submit', { order: sub });

    const reveal = await hostReveal();
    check(reveal.groupPts === expected, 'round ' + r + ' group +' + reveal.groupPts + ' (expected ' + expected + ')');
    check(reveal.gamePts === 5 - expected, 'round ' + r + ' game +' + reveal.gamePts);
    runningGroup += expected;
    runningGame += 5 - expected;
    check(reveal.groupScore === runningGroup, 'running group total = ' + runningGroup);
    check(reveal.gameScore === runningGame, 'running game total = ' + runningGame);

    await emitAck(host, 'host:next', {});
  }

  const final = await hostFinal();
  check(final.groupScore === runningGroup && final.gameScore === runningGame, 'final tally matches running totals');
  check(final.playersWin === (runningGroup >= runningGame), 'playersWin reflects group >= game');
  check(final.recap.length === N, 'recap has one row per round');

  const eachRankerOnce = Object.keys(rankerSeen).length === N && Object.values(rankerSeen).every((c) => c === 1);
  const eachSubmitterOnce = Object.keys(submitterSeen).length === N && Object.values(submitterSeen).every((c) => c === 1);
  check(eachRankerOnce, 'every player was ranker exactly once');
  check(eachSubmitterOnce, 'every player was submitter exactly once');

  // ---- Reset clears the lobby ----
  const reconRes = await emitAck(host, 'host:reset', {});
  check(reconRes && reconRes.ok, 'host reset back to lobby');
  const afterReset = await emitAck(host, 'host:auth', {});
  check(afterReset.players && afterReset.players.length === 0, 'reset clears all players from the lobby');
  await rejoinAll();

  // ---- Custom Words mode ----
  const cwOn = await emitAck(host, 'host:setCustomWords', { on: true });
  check(cwOn && cwOn.customWords === true, 'custom words toggled on');
  const hostIntro2 = makeQueue(host, 'state:intro');
  const cwStart = await emitAck(host, 'host:start', {});
  check(cwStart && cwStart.ok && cwStart.phase === 'COLLECT', 'custom start → COLLECT phase');

  // Everyone but the last submits: game must NOT advance yet.
  const submittedWords = {};
  const pids = Object.keys(byId);
  for (let i = 0; i < pids.length; i++) {
    const pid = pids[i];
    const w = [0, 1, 2, 3, 4].map((k) => nameById[pid] + '-w' + k);
    submittedWords[pid] = w;
    const r = await emitAck(byId[pid], 'player:words', { words: w });
    check(r && r.ok, 'words accepted for ' + nameById[pid]);
    if (i < pids.length - 1) check(r.phase === 'COLLECT', 'still COLLECT after ' + (i + 1) + '/' + pids.length);
    else check(r.phase === 'INTRO', 'all submitted → INTRO');
  }
  // Re-submission is rejected (locked).
  const dup = await emitAck(byId[pids[0]], 'player:words', { words: ['a', 'b', 'c', 'd', 'e'] });
  check(dup && !dup.ok, 'cannot resubmit words');

  const intro2 = await hostIntro2();
  check(intro2 && intro2.totalRounds === N, 'custom game built N rounds');

  // Verify the round pool is EXACTLY the submitted words, each used once.
  const hostRank2 = makeQueue(host, 'state:rank');
  const hostDiscuss2 = makeQueue(host, 'state:discuss');
  const allSubmitted = pids.flatMap((p) => submittedWords[p]).sort();
  const seenTexts = [];
  for (let r = 1; r <= N; r++) {
    const rank = await hostRank2();
    const items = await rankItemsQ[rank.rankerId]();
    items.items.forEach((it) => seenTexts.push(it.text));
    const order = items.items.map((it) => it.id);
    await emitAck(byId[rank.rankerId], 'player:rank', { order });
    const discuss = await hostDiscuss2();
    await emitAck(byId[discuss.submitterId], 'player:submit', { order });
    if (r < N) await emitAck(host, 'host:next', {});
  }
  check(JSON.stringify(seenTexts.sort()) === JSON.stringify(allSubmitted),
    'pool = submitted words, each used exactly once');

  // ---- Kicking is blocked once the game has started (COLLECT) ----
  await emitAck(host, 'host:reset', {});
  await rejoinAll();
  await emitAck(host, 'host:setCustomWords', { on: true });
  await emitAck(host, 'host:start', {});
  const blockedKick = await emitAck(host, 'host:kick', { playerId: Object.keys(byId)[0] });
  check(blockedKick && !blockedKick.ok, 'kicking during COLLECT is rejected');
  const stillThere = await emitAck(host, 'host:auth', {});
  check(stillThere.phase === 'COLLECT' && stillThere.players.length === N,
    'phase + roster unchanged after a blocked kick');

  // ---- Duplicate word handling (Tier-A normalization) ----
  await emitAck(host, 'host:reset', {});
  await rejoinAll();
  await emitAck(host, 'host:setCustomWords', { on: true });
  await emitAck(host, 'host:start', {});
  const dp = Object.keys(byId);
  const ownDup = await emitAck(byId[dp[0]], 'player:words', { words: ['Pizza', 'pizza', 'x', 'y', 'z'] });
  check(ownDup && ownDup.reason === 'duplicate-own' && JSON.stringify(ownDup.dupIndexes) === '[1]',
    'own duplicate rejected with the repeat index');
  const artDup = await emitAck(byId[dp[0]], 'player:words', { words: ['The Office', 'office', 'x', 'y', 'z'] });
  check(artDup && artDup.reason === 'duplicate-own', 'article-stripped duplicate rejected (The Office == Office)');
  const okA = await emitAck(byId[dp[0]], 'player:words', { words: ['Red', 'Green', 'Blue', 'One', 'Two'] });
  check(okA && okA.ok, 'distinct words accepted');
  const crossDup = await emitAck(byId[dp[1]], 'player:words', { words: ['red', 'p', 'GREEN', 'r', 's'] });
  check(crossDup && crossDup.reason === 'duplicate-taken' && JSON.stringify(crossDup.dupIndexes) === '[0,2]',
    'cross-player duplicate rejected case-insensitively, with indexes');
  const okB = await emitAck(byId[dp[1]], 'player:words', { words: ['purple', 'p', 'q', 'r', 's'] });
  check(okB && okB.ok, 'resubmit with unique words accepted');
  // Remaining players submit unique words so the game can begin.
  for (let i = 2; i < dp.length; i++) {
    await emitAck(byId[dp[i]], 'player:words', { words: [0, 1, 2, 3, 4].map((k) => nameById[dp[i]] + '-d' + k) });
  }
  const allDistinct = await emitAck(host, 'host:auth', {});
  check(allDistinct.phase === 'INTRO' || allDistinct.phase === 'RANK', 'game began once all words are unique');

  console.log(failed ? '\n✗ FAILED' : '\n✓ ALL PASSED');
  host.close();
  Object.values(byId).forEach((s) => s.close());
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
