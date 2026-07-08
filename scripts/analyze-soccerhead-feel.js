'use strict';
// Soccer Head — FEEL analysis. Reliable, scenario-based measurements against the
// real physics engine (no flaky self-play AI). Answers concrete questions:
// pace, lob-over-a-defender success, dash-strike power, keeper coverage, and
// cross-pitch mobility.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'soccerhead', 'js', 'engine.js'), 'utf8');
const sandbox = { window: {}, Math: Math };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const HB = sandbox.window.SoccerHead;
const DT = 1 / 120;
const W = HB.W, GY = HB.GROUND_Y, TOP = HB.TOP_Y, DEPTH = HB.GOAL_DEPTH;

function world(redX, blueX) {
  const w = new HB.World({ mode: '1v1' });
  w.setRoster([{ id: 'r', name: 'R', team: 'red', seat: 0 }, { id: 'b', name: 'B', team: 'blue', seat: 0 }]);
  w.frozen = false;
  w.byId.get('r').x = redX; w.byId.get('r').y = GY;
  w.byId.get('b').x = blueX; w.byId.get('b').y = GY;
  return w;
}
function line(s) { console.log(s); }

line('════════════════ Soccer Head — feel analysis ════════════════');
line('Field: ' + W + 'x' + HB.GROUND_Y + ' (ground)  |  crossbar at y=' + TOP + '  |  goal depth ' + DEPTH);
line('');

// ---- 1. Pace: how fast does the ball move off a kick vs a dash? -------------
(function () {
  function shoot(kind) {
    const w = world(550, 60);
    const r = w.byId.get('r');
    w.ball.x = 605; w.ball.y = GY - 20; w.ball.vx = 0; w.ball.vy = 0;
    if (kind === 'kick') w.setInput('r', 3, true);
    if (kind === 'dash') w.dash('r', 1);
    let peak = 0, crossT = null;
    for (let i = 0; i < 300; i++) {
      w.step(DT);
      peak = Math.max(peak, Math.hypot(w.ball.vx, w.ball.vy));
      if (crossT === null && w.ball.x > 1100) crossT = (i + 1) * DT;
    }
    return { peak, crossT };
  }
  const k = shoot('kick'), d = shoot('dash');
  line('1) PACE');
  line('   Kick: peak ball speed ' + k.peak.toFixed(0) + ' px/s, reaches far third (~500px) in ' + (k.crossT ? k.crossT.toFixed(2) + 's' : '—'));
  line('   Dash: peak ball speed ' + d.peak.toFixed(0) + ' px/s, reaches far third in ' + (d.crossT ? d.crossT.toFixed(2) + 's' : '—'));
  line('   (whole pitch is ' + W + 'px; a shot crossing in ~0.6–1.0s reads as punchy-arcade)');
  line('');
})();

// ---- 2. Lob over an IDLE defender: from how far can you chip it in? ---------
(function () {
  const defX = W - 150;             // idle keeper standing in front of the right goal
  const results = [];
  for (let atk = W - 520; atk <= W - 150; atk += 30) {
    const w = world(atk, defX);
    w.ball.x = atk + 52; w.ball.y = GY - 20; w.ball.vx = 0; w.ball.vy = 0;
    w.setInput('r', 3, true); // single lofted kick, defender never moves
    let scored = null;
    for (let i = 0; i < 320 && !scored; i++) scored = w.step(DT);
    results.push({ dist: (W - DEPTH) - atk, scored: scored === 'red' });
  }
  const hits = results.filter(r => r.scored);
  line('2) LOB OVER AN IDLE DEFENDER (keeper parked in the goal, never moves)');
  line('   Tested ' + results.length + ' launch spots across the attacking half.');
  line('   Scored from ' + hits.length + '/' + results.length + ' of them (' + (100 * hits.length / results.length).toFixed(0) + '%).');
  if (hits.length) {
    const ds = hits.map(h => Math.round(h.dist));
    line('   Working range: ~' + Math.min(...ds) + '–' + Math.max(...ds) + 'px out from the goal line.');
  } else {
    line('   NONE scored — lobbing an idle keeper is too hard.');
  }
  line('');
})();

// ---- 3. Dash-strike from the attacking third ------------------------------
(function () {
  const defX = W - 150;
  let scored = 0, total = 0;
  for (let atk = W - 360; atk <= W - 200; atk += 30) {
    total++;
    const w = world(atk, defX);
    w.ball.x = atk + 50; w.ball.y = GY - 40; w.ball.vx = 0; w.ball.vy = 0;
    w.dash('r', 1);
    let g = null;
    for (let i = 0; i < 260 && !g; i++) g = w.step(DT);
    if (g === 'red') scored++;
  }
  line('3) DASH-STRIKE past an idle keeper: scored ' + scored + '/' + total + ' launch spots');
  line('');
})();

// ---- 4. Keeper coverage: the un-guardable band -----------------------------
(function () {
  // Empirically find a max-jump apex to confirm the top-of-goal gap.
  const w = world(600, 60);
  const r = w.byId.get('r');
  w.setInput('r', 2, true);
  let minY = r.y;
  for (let i = 0; i < 220; i++) { w.step(DT); minY = Math.min(minY, r.y); }
  const f = w.field;
  const jumpHeadTop = minY - f.HEAD_CY - f.HEAD_R;
  const standHeadTop = GY - f.HEAD_CY - f.HEAD_R;
  line('4) KEEPER COVERAGE');
  line('   Standing head-top: y' + standHeadTop.toFixed(0) + '  →  covers the bottom ' + (GY - standHeadTop).toFixed(0) + 'px of the goal.');
  line('   Max-jump head-top: y' + jumpHeadTop.toFixed(0) + '  →  crossbar y' + TOP + ', so the top ' + (jumpHeadTop - TOP).toFixed(0) + 'px stays UN-guardable.');
  line('   Goal opening is ' + (GY - TOP) + 'px tall; un-guardable share ≈ ' + (100 * (jumpHeadTop - TOP) / (GY - TOP)).toFixed(0) + '%.');
  line('');
})();

// ---- 5. Mobility: cross-pitch time -----------------------------------------
(function () {
  function run(withDash) {
    const w = world(70, 40); // park the other player at the far-left wall, out of the lane
    const r = w.byId.get('r');
    let t = null;
    for (let i = 0; i < 1200; i++) {
      w.setInput('r', 1, true);
      if (withDash && r.dashCd <= 0 && r.dash <= 0) w.dash('r', 1);
      w.step(DT);
      if (r.x > W - 80) { t = (i + 1) * DT; break; }
    }
    return t;
  }
  line('5) MOBILITY (cross the full pitch, ~' + (W - 140) + 'px)');
  const runOnly = run(false), runDash = run(true);
  line('   Running only: ' + (runOnly ? runOnly.toFixed(2) + 's' : '>10s'));
  line('   Run + dashes: ' + (runDash ? runDash.toFixed(2) + 's' : '>10s'));
  line('');
})();

line('Note: two identical AIs playing each other stalemate 0-0 — a perfectly-');
line('positioned keeper is very hard to beat at point-blank, so goals in real');
line('play come from lobs, dashes and out-of-position keepers (measured above).');
