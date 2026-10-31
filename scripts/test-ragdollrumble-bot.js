'use strict';
/* Headless CPU-fighter tests for Ragdoll Rumble.
 * Runs full 8-CPU free-for-alls on every stage at every difficulty and checks
 * that rounds actually finish through fighting (no stalemates, no NaNs), that
 * bots use a spread of moves, that a CPU beats an idle dummy, that CPUs
 * recover to the stage after being knocked off, and that harder bots win
 * more often than easy ones.
 * Run: node scripts/test-ragdollrumble-bot.js
 */
globalThis.planck = require('planck');
require('../public/ragdollrumble/js/engine.js');
require('../public/ragdollrumble/js/bot.js');
const NM = globalThis.RagdollRumble;
const NB = globalThis.RagdollRumbleBot;
const DT = 1 / 120;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

function brawl(stage, diffs, seed, items) {
  const w = new NM.World({ stage: stage, items: items !== false });
  const roster = diffs.map((d, i) => ({ id: 'b' + i, seat: i, isBot: true }));
  w.reset(seed, roster);
  const bots = roster.map((r, i) => new NB.Bot(r.id, diffs[i], NM.mulberry32(seed * 100 + i)));
  let t = 0, bad = false;
  const kinds = {};
  const lastHit = {};
  let kos = 0, credited = 0, selfKOs = 0;
  while (w.alivePlayers().length > 1 && t < 200) {
    bots.forEach((b) => b.update(w, DT));
    const ev = w.step(DT);
    t += DT;
    if (t >= 90 && !w.suddenDeath) w.startSuddenDeath();
    for (const e of ev) {
      if (e.type === 'hit') { kinds[e.kind] = (kinds[e.kind] || 0) + 1; lastHit[e.id] = { t: t, kind: e.kind }; }
      if (e.type === 'ko') {
        kos++;
        const lh = lastHit[e.id];
        // Thrown out by the stage itself (lava, spikes) counts as the stage's KO.
        const stage = lh && (lh.kind === 'lava' || lh.kind === 'spike') && t - lh.t < 3;
        if (e.by) credited++; else if (!stage) selfKOs++;
      }
    }
    for (const p of w.players) {
      if (!p.alive || !p.parts) continue;
      const q = p.parts.torso.getPosition();
      if (!isFinite(q.x) || !isFinite(q.y)) bad = true;
    }
  }
  return { w, t, bad, kinds, kos, credited, selfKOs, winner: w.alivePlayers()[0] || null };
}

console.log('\n8-CPU free-for-alls (every stage × difficulty)');
const EIGHT = (d) => [d, d, d, d, d, d, d, d];
for (const diff of ['easy', 'normal', 'hard']) {
  for (const stage of NM.STAGE_IDS) {
    const r = brawl(stage, EIGHT(diff), 5);
    const moves = Object.keys(r.kinds).length;
    const maxSelf = diff === 'easy' ? 3 : 2;
    check(`${diff} @ ${stage}: finishes by fighting (${r.t.toFixed(0)}s, ${r.kos} KOs, ${r.credited} credited, ${r.selfKOs} self-KOs, ${moves} move types)`,
      !r.bad && r.w.alivePlayers().length <= 1 && r.t < 200 && r.selfKOs <= maxSelf && moves >= 3,
      { t: r.t, kos: r.kos, selfKOs: r.selfKOs, kinds: r.kinds });
  }
}

console.log('\nCPU vs an idle dummy');
{
  let wins = 0;
  for (let seed = 1; seed <= 4; seed++) {
    const w = new NM.World({ stage: 'rooftop', items: false });
    w.reset(seed, [{ id: 'bot', seat: 0, isBot: true }, { id: 'dummy', seat: 1 }]);
    const bot = new NB.Bot('bot', 'normal', NM.mulberry32(seed));
    let t = 0;
    while (w.alivePlayers().length > 1 && t < 60) { bot.update(w, DT); w.step(DT); t += DT; }
    if (w.byId.bot.alive && !w.byId.dummy.alive) wins++;
  }
  check('a normal CPU knocks out a stationary fighter (4/4)', wins === 4, wins);
}

console.log('\nDucking');
{
  let ducks = 0, whiffs = 0;
  for (let seed = 1; seed <= 4; seed++) {
    const w = new NM.World({ stage: 'rooftop', items: false });
    w.reset(seed, [{ id: 'jabber', seat: 0 }, { id: 'bot', seat: 1, isBot: true }]);
    const bot = new NB.Bot('bot', 'hard', NM.mulberry32(seed + 40));
    const J = w.byId.jabber, B = w.byId.bot;
    const place = (p, x) => { const t = p.parts.torso.getPosition(); p.partList.forEach((q) => { const r = q.getPosition(); q.setTransform(planck.Vec2(r.x + x - t.x, r.y), q.getAngle()); }); };
    place(J, -0.6); place(B, 0.6);
    let ap = 0, t = 0;
    while (t < 8 && B.alive) {
      if (Math.round(t * 120) % 60 === 0) { ap++; w.setInput('jabber', 0, 0, 2, 0, ap); }
      if (Math.round(t * 120) % 60 === 3) w.setInput('jabber', 0, 0, 0, 0, ap);
      bot.update(w, DT);
      w.step(DT).forEach((e) => { if (e.type === 'crouch' && e.id === 'bot') ducks++; if (e.type === 'whiff' && e.id === 'jabber') whiffs++; });
      t += DT;
    }
  }
  check('hard CPUs duck incoming jabs (and make some whiff)', ducks > 0 && whiffs > 0, { ducks, whiffs });
}

console.log('\nRecovery');
{
  let back = 0, tries = 0;
  for (const side of [-1, 1]) for (let seed = 1; seed <= 3; seed++) {
    const w = new NM.World({ stage: 'rooftop', items: false });
    w.reset(seed, [{ id: 'bot', seat: 0, isBot: true }]);
    const p = w.byId.bot;
    const bot = new NB.Bot('bot', 'hard', NM.mulberry32(seed + 7));
    // Fling it off the side at a moderate %.
    p.dmg = 60;
    w._hit(null, p, NM.HITS.throwF, 1, side, 0, [], {});
    let t = 0;
    while (t < 6 && p.alive) { bot.update(w, DT); w.step(DT); t += DT; if (p.grounded && t > 0.5) break; }
    tries++;
    if (p.alive && p.grounded) back++;
  }
  check('a hard CPU gets back to the stage after a throw (≥5/6)', back >= 5, back + '/' + tries);
}

console.log('\nEdge-guarding');
{
  let spiked = 0, botLost = 0;
  for (const side of [-1, 1]) for (let seed = 1; seed <= 8; seed++) {
    const w = new NM.World({ stage: 'rooftop', items: false });
    w.reset(seed, [{ id: 'bot', seat: 0, isBot: true }, { id: 'v', seat: 1, isBot: true }]);
    const B = w.byId.bot, V = w.byId.v;
    const bot = new NB.Bot('bot', 'hard', NM.mulberry32(seed * 7919 + side));
    const rec = new NB.Bot('v', 'normal', NM.mulberry32(seed + 190));
    const main = w.groundSpans().filter((s) => !s.oneWay).reduce((m, s) => (s.x1 - s.x0 > m.x1 - m.x0 ? s : m));
    const edge = side > 0 ? main.x1 : main.x0;
    const place = (p, x, y) => { const t = p.parts.torso.getPosition(), dx = x - t.x, dy = y - t.y; p.partList.forEach((q) => { const r = q.getPosition(); q.setTransform(planck.Vec2(r.x + dx, r.y + dy), q.getAngle()); q.setLinearVelocity(planck.Vec2(0, 0)); }); };
    place(B, edge - side * 1.5, main.y - NM.STAND_H - 0.05);
    for (let i = 0; i < 30; i++) w.step(DT);
    // Knock the victim out past the ledge, below stage level, recovering.
    place(V, edge + side * 2.2, main.y + 2.5); V.airJumps = 0;
    let t = 0, got = false;
    while (t < 4 && V.alive && B.alive) {
      bot.update(w, DT); rec.update(w, DT);
      w.step(DT).forEach((e) => { if (e.type === 'hit' && e.spike && e.id === 'v') got = true; });
      t += DT;
    }
    if (got) spiked++;
    if (!B.alive) botLost++;
  }
  check('a hard CPU edge-guards with spikes (≥6/16) without dying doing it', spiked >= 6 && botLost === 0, { spiked, botLost });
}

console.log('\nDifficulty matters');
{
  let hardWins = 0, games = 0;
  for (const stage of ['rooftop', 'peak', 'factory']) for (let seed = 1; seed <= 4; seed++) {
    const r = brawl(stage, ['hard', 'easy', 'hard', 'easy'], seed, false);
    if (r.winner) { games++; if (r.winner.id === 'b0' || r.winner.id === 'b2') hardWins++; }
  }
  check('hard CPUs beat easy ones more often than not', hardWins > games / 2, hardWins + '/' + games);
}

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' PASS' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
