'use strict';

// End-to-end smoke test for the Boggle socket flow. Requires the server to be
// running on localhost:3000. Exercises: host auth, two players joining, host
// start, board broadcast, valid + invalid word submission, word-count
// broadcast to the host. Not part of the app — a dev harness.

const { io } = require('socket.io-client');
const { isWord } = require('../server/noggle/dictionary');

const URL = 'http://localhost:3000/noggle';

function connect(label) {
  return io(URL, { transports: ['websocket'], forceNew: true });
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
// Resolve immediately if the socket is already connected (avoids a race where
// 'connect' fires before we attach the listener).
function onConnect(sock) {
  return new Promise((res) => { if (sock.connected) return res(); sock.once('connect', res); });
}

// Find one real dictionary word on the board (4x4) and return its cell path.
function findWordPath(grid, minLen) {
  const size = grid.length;
  let result = null;
  const dfs = (r, c, visited, word, cells) => {
    if (result) return;
    const w = word + grid[r][c];
    const cs = cells.concat([{ r, c }]);
    if (w.length >= minLen && w.length <= 7 && isWord(w)) { result = { word: w, path: cs }; return; }
    if (w.length > 7) return;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
      const key = nr * size + nc;
      if (visited.has(key)) continue;
      visited.add(key);
      dfs(nr, nc, visited, w, cs);
      visited.delete(key);
    }
  };
  for (let r = 0; r < size && !result; r++)
    for (let c = 0; c < size && !result; c++)
      dfs(r, c, new Set([r * size + c]), '', []);
  return result;
}

(async function main() {
  const fails = [];
  const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

  const host = connect('host');
  const p1 = connect('p1');
  const p2 = connect('p2');

  let hostCounts = null;
  host.on('state:counts', (d) => { hostCounts = d.counts; });
  let boardFromRound = null;
  p1.on('state:round', (r) => { boardFromRound = r.board; });

  await onConnect(host);
  await new Promise((r) => host.emit('host:auth', {}, () => r()));
  console.log('host authed');

  await onConnect(p1);
  await onConnect(p2);
  const pid1 = 'p1-' + Date.now();
  const pid2 = 'p2-' + Date.now();
  const j1 = await new Promise((r) => p1.emit('player:join', { playerId: pid1, name: 'Alice' }, r));
  const j2 = await new Promise((r) => p2.emit('player:join', { playerId: pid2, name: 'Bob' }, r));
  assert(j1.ok && j2.ok, 'both players joined');

  // Late-join lock: start, then a 3rd player must be rejected.
  const startRes = await new Promise((r) => host.emit('host:start', { boardSize: 4, timeLimitSec: 60 }, r));
  assert(startRes.ok, 'host started');

  const p3 = connect('p3');
  await onConnect(p3);
  const j3 = await new Promise((r) => p3.emit('player:join', { playerId: 'p3', name: 'Carol' }, r));
  assert(!j3.ok && j3.reason === 'round-in-progress', 'late join rejected (round-in-progress)');

  // Wait for intro (4000 + 1100) to elapse and the board to broadcast.
  await wait(5600);
  assert(boardFromRound && boardFromRound.grid, 'player received board on state:round');
  assert(boardFromRound.size === 4, 'board is 4x4');

  // Submit a real word.
  const found = findWordPath(boardFromRound.grid, boardFromRound.minLen);
  assert(!!found, 'found a dictionary word on the board: ' + (found && found.word));
  if (found) {
    const wr = await new Promise((r) => p1.emit('player:word', { path: found.path }, r));
    assert(wr.ok && wr.accepted, 'valid word accepted: ' + wr.word + ' (+' + wr.points + ')');
    assert(wr.score > 0 && wr.wordCount === 1, 'score + wordCount updated');
    // Duplicate submission rejected.
    const dup = await new Promise((r) => p1.emit('player:word', { path: found.path }, r));
    assert(dup.ok && !dup.accepted && dup.reason === 'already-found', 'duplicate word rejected');
  }

  // Non-adjacent path rejected.
  const bad = await new Promise((r) => p1.emit('player:word', { path: [{ r: 0, c: 0 }, { r: 3, c: 3 }] }, r));
  assert(bad.ok === false && bad.reason === 'not-adjacent', 'non-adjacent path rejected');

  // Host received a live-score broadcast reflecting Alice's 1 word + score.
  await wait(200);
  const alice = hostCounts && hostCounts.find((c) => c.name === 'Alice');
  assert(alice && alice.wordCount === 1, 'host counts show Alice: 1 word');
  assert(alice && typeof alice.score === 'number' && alice.score > 0, 'host counts carry live score (shown on host)');

  host.close(); p1.close(); p2.close(); p3.close();
  await wait(150);
  console.log(fails.length ? ('\nFAILED: ' + fails.length) : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})();
