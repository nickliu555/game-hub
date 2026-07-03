'use strict';

// Pure-logic unit tests for Herd Mind. No server, no network (Groq layer off).
//   node scripts/test-herdmind.js   (or: npm run test:herdmind)

const assert = require('assert');
const path = require('path');

const { Game } = require(path.join('..', 'server', 'herdmind', 'game'));
const grouping = require(path.join('..', 'server', 'herdmind', 'grouping'));
const { buildGroups, normalizeAnswer } = grouping;

let passed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; })
    .catch((e) => { failures.push({ name, err: e }); });
}

// Build a game with the given player ids/names (all in LOBBY).
function gameWith(ids) {
  const g = new Game();
  for (const id of ids) {
    const r = g.addPlayer({ playerId: id, name: id, socketId: 's_' + id });
    assert.ok(r.ok, 'addPlayer ' + id + ': ' + JSON.stringify(r));
  }
  return g;
}

// Simulate one scored round. `answers` maps playerId -> string (or null = blank).
async function playRound(g, answers, opts = {}) {
  g.phase = 'QUESTION';
  g.roundIndex += 1;
  g.currentQuestion = { id: 'q' + g.roundIndex, text: '?' };
  for (const p of g.players.values()) {
    const a = answers[p.id];
    if (a != null) { p.roundAnswer = String(a); p.answeredRound = g.roundIndex; }
    else { p.roundAnswer = ''; p.answeredRound = -1; }
  }
  g.phase = 'REVIEW';
  const groups = await buildGroups(g.collectSubmissions(), { groqKey: null });
  g.setGroups(groups);
  return g.scoreRound(opts.hostGroups || null);
}

function scoreOf(g, id) { return g.players.get(id).score; }

(async () => {
  // ---- Normalization ----
  await test('normalize: dog / dogs / "a dog" / DOG collapse', () => {
    const k = normalizeAnswer('dog');
    assert.strictEqual(normalizeAnswer('dogs'), k);
    assert.strictEqual(normalizeAnswer('a dog'), k);
    assert.strictEqual(normalizeAnswer('DOG'), k);
    assert.strictEqual(normalizeAnswer('  the Dog! '), k);
  });

  await test('normalize: running -> run, café -> cafe, 7 -> seven', () => {
    assert.strictEqual(normalizeAnswer('running'), normalizeAnswer('run'));
    assert.strictEqual(normalizeAnswer('café'), normalizeAnswer('cafe'));
    assert.strictEqual(normalizeAnswer('7'), normalizeAnswer('seven'));
  });

  // ---- Fuzzy typo pass ----
  await test('fuzzy: banana / bananna merge into one group', async () => {
    const groups = await buildGroups([
      { playerId: 'a', name: 'a', raw: 'banana' },
      { playerId: 'b', name: 'b', raw: 'banana' },
      { playerId: 'c', name: 'c', raw: 'bananna' },
    ], {});
    assert.strictEqual(groups.length, 1, JSON.stringify(groups));
    assert.strictEqual(groups[0].members.length, 3);
  });

  await test('fuzzy: elephant / elefant merge', async () => {
    const groups = await buildGroups([
      { playerId: 'a', name: 'a', raw: 'elephant' },
      { playerId: 'b', name: 'b', raw: 'elefant' },
    ], {});
    assert.strictEqual(groups.length, 1);
  });

  await test('fuzzy: cat / bat do NOT merge (len < 4 guard)', async () => {
    const groups = await buildGroups([
      { playerId: 'a', name: 'a', raw: 'cat' },
      { playerId: 'b', name: 'b', raw: 'bat' },
    ], {});
    assert.strictEqual(groups.length, 2);
  });

  await test('fuzzy: two multi-submitter keys 1 edit apart do NOT merge', async () => {
    const groups = await buildGroups([
      { playerId: 'a', name: 'a', raw: 'grape' },
      { playerId: 'b', name: 'b', raw: 'grape' },
      { playerId: 'c', name: 'c', raw: 'gripe' },
      { playerId: 'd', name: 'd', raw: 'gripe' },
    ], {});
    assert.strictEqual(groups.length, 2, JSON.stringify(groups.map(g => g.label)));
  });

  await test('blanks: each non-answer is its own unique group', async () => {
    const groups = await buildGroups([
      { playerId: 'a', name: 'a', raw: 'dog' },
      { playerId: 'b', name: 'b', raw: '' },
      { playerId: 'c', name: 'c', raw: '   ' },
    ], {});
    // one 'dog' group + two separate blank groups
    assert.strictEqual(groups.length, 3);
    const blanks = groups.filter(g => g.members.length === 1 && g.label === '(no answer)');
    assert.strictEqual(blanks.length, 2);
  });

  // ---- Majority scoring ----
  await test('majority: unique largest group (>=2) each +1', async () => {
    const g = gameWith(['A', 'B', 'C', 'D', 'E']);
    await playRound(g, { A: 'dog', B: 'dog', C: 'dog', D: 'cat', E: 'cat' });
    assert.strictEqual(scoreOf(g, 'A'), 1);
    assert.strictEqual(scoreOf(g, 'B'), 1);
    assert.strictEqual(scoreOf(g, 'C'), 1);
    assert.strictEqual(scoreOf(g, 'D'), 0);
    assert.strictEqual(scoreOf(g, 'E'), 0);
  });

  await test('majority: tie for largest scores nobody', async () => {
    const g = gameWith(['A', 'B', 'C', 'D']);
    await playRound(g, { A: 'dog', B: 'dog', C: 'cat', D: 'cat' });
    ['A', 'B', 'C', 'D'].forEach((id) => assert.strictEqual(scoreOf(g, id), 0));
  });

  await test('majority: all singletons score nobody', async () => {
    const g = gameWith(['A', 'B', 'C']);
    await playRound(g, { A: 'apple', B: 'orange', C: 'banana' });
    ['A', 'B', 'C'].forEach((id) => assert.strictEqual(scoreOf(g, id), 0));
  });

  // ---- Pink Cow ----
  await test('cow: starts unheld', () => {
    const g = gameWith(['A', 'B']);
    assert.strictEqual(g.cowHolderId, null);
  });

  await test('cow: exactly one sole-unique takes the cow', async () => {
    const g = gameWith(['A', 'B', 'C', 'D']);
    await playRound(g, { A: 'dog', B: 'dog', C: 'dog', D: 'cat' });
    assert.strictEqual(g.cowHolderId, 'D');
  });

  await test('cow: zero sole-uniques leaves cow put', async () => {
    const g = gameWith(['A', 'B', 'C', 'D']);
    g.cowHolderId = 'A';
    await playRound(g, { A: 'dog', B: 'dog', C: 'cat', D: 'cat' });
    assert.strictEqual(g.cowHolderId, 'A');
  });

  await test('cow: two+ sole-uniques leaves cow put', async () => {
    const g = gameWith(['A', 'B', 'C', 'D']);
    g.cowHolderId = 'A';
    await playRound(g, { A: 'dog', B: 'dog', C: 'cat', D: 'fish' });
    assert.strictEqual(g.cowHolderId, 'A');
  });

  await test('cow: passes from old holder to new sole-unique', async () => {
    const g = gameWith(['A', 'B', 'C', 'D']);
    g.cowHolderId = 'A';
    await playRound(g, { A: 'dog', B: 'dog', C: 'dog', D: 'cat' });
    assert.strictEqual(g.cowHolderId, 'D');
  });

  // ---- Win check ----
  function winnerWith(scores, target, cow) {
    const g = gameWith(Object.keys(scores));
    g.targetScore = target;
    for (const id of Object.keys(scores)) g.players.get(id).score = scores[id];
    g.cowHolderId = cow || null;
    return g._computeWinner();
  }

  await test('win: sole leader at target, cow-free -> wins', () => {
    assert.strictEqual(winnerWith({ A: 8, B: 5, C: 3 }, 8, null), 'A');
  });
  await test('win: sole leader at target but holds cow -> no win', () => {
    assert.strictEqual(winnerWith({ A: 8, B: 5 }, 8, 'A'), null);
  });
  await test('win: two tied at/above target -> no win', () => {
    assert.strictEqual(winnerWith({ A: 8, B: 8, C: 2 }, 8, null), null);
  });
  await test('win: below target -> no win', () => {
    assert.strictEqual(winnerWith({ A: 7, B: 6 }, 8, null), null);
  });
  await test('win: cow-holder leads but a lower cow-free player is NOT a winner', () => {
    // A leads at 9 with cow; B at 8 cow-free but not the top -> nobody wins yet.
    assert.strictEqual(winnerWith({ A: 9, B: 8 }, 8, 'A'), null);
  });

  // ---- End-to-end reveal payload sanity ----
  await test('reveal payload: majority flagged, result private fields present', async () => {
    const g = gameWith(['A', 'B', 'C', 'D']);
    await playRound(g, { A: 'dog', B: 'dog', C: 'dog', D: 'cat' });
    const rv = g.getRevealPublic();
    const maj = rv.groups.find((x) => x.isMajority);
    assert.ok(maj && maj.size === 3, 'majority group size 3');
    assert.strictEqual(rv.cowHolderId, 'D');
    const resD = g.getPlayerResult('D');
    assert.strictEqual(resD.gotCow, true);
    assert.strictEqual(resD.matchedHerd, false);
    const resA = g.getPlayerResult('A');
    assert.strictEqual(resA.matchedHerd, true);
    assert.strictEqual(resA.pointsEarned, 1);
  });

  await test('host merge override: merging two buckets changes the majority', async () => {
    const g = gameWith(['A', 'B', 'C', 'D']);
    // Auto-group would make dog(2) vs sofa(1) vs couch(1): dog is unique largest.
    // Host merges sofa+couch -> couches(2), tying dog -> nobody scores.
    g.phase = 'QUESTION';
    g.roundIndex = 1;
    g.currentQuestion = { id: 'q1', text: '?' };
    const map = { A: 'dog', B: 'dog', C: 'sofa', D: 'couch' };
    for (const p of g.players.values()) { p.roundAnswer = map[p.id]; p.answeredRound = 1; }
    g.phase = 'REVIEW';
    g.setGroups(await buildGroups(g.collectSubmissions(), {}));
    const hostGroups = [
      { id: 'g1', label: 'dog', members: [{ playerId: 'A' }, { playerId: 'B' }] },
      { id: 'g2', label: 'couch', members: [{ playerId: 'C' }, { playerId: 'D' }] },
    ];
    g.scoreRound(hostGroups);
    ['A', 'B', 'C', 'D'].forEach((id) => assert.strictEqual(scoreOf(g, id), 0, id + ' should be 0'));
  });

  // ---- Report ----
  console.log('');
  if (failures.length === 0) {
    console.log(`✓ All ${passed} Herd Mind unit tests passed.`);
    process.exit(0);
  } else {
    console.log(`✓ ${passed} passed, ✗ ${failures.length} failed:\n`);
    for (const f of failures) {
      console.log(`  ✗ ${f.name}`);
      console.log(`      ${f.err && f.err.message}`);
    }
    process.exit(1);
  }
})();
