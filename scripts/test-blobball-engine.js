'use strict';
// Headless physics checks for the Blob Ball engine (public/blobball/js/engine.js).
const BB = require('../public/blobball/js/engine.js');

let failures = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name); if (!cond) failures++; }

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function world(bots) {
  return new BB.World({
    roster: [{ id: 'a', name: 'A', isBot: !!bots }, { id: 'b', name: 'B', isBot: !!bots }],
    rng: seeded(42),
  });
}
// A live court with the ball parked out of the way (high above the far wall).
function liveCourt() {
  const w = world(false);
  w.setupServe(0);
  w.release();
  return w;
}
function park(w) { Object.assign(w.ball, { x: 980, y: 700, vx: 0, vy: 0 }); w.ballHeld = true; }

// ---- Jumping ----
{
  const w = liveCourt(); park(w);
  const a = w.blobs[0];
  w.setInput('a', 2, true);
  let apex = 0, ticks = 0, landed = false;
  for (let t = 0; t < 60; t++) {
    w.step();
    apex = Math.max(apex, a.y);
    ticks++;
    if (w.events.some((e) => e.t === 'land' && e.seat === 0)) { landed = true; break; }
    w.events.length = 0;
  }
  check('full jump apex matches the original (225)', apex === 225);
  check('full jump lands in ~31 ticks', landed && ticks >= 30 && ticks <= 32);
  check('holding JUMP re-jumps on landing', (() => { w.events.length = 0; w.step(); return a.y > 0; })());
  w.setInput('a', 2, false);
}
{
  const w = liveCourt(); park(w);
  const a = w.blobs[0];
  // Press and release before the engine even ticks: still a (short) hop.
  w.setInput('a', 2, true);
  w.setInput('a', 2, false);
  let apex = 0;
  for (let t = 0; t < 40; t++) { w.step(); apex = Math.max(apex, a.y); }
  check('a quick tap still jumps', apex > 0);
  check('a tap is a short hop (25–50% of a full jump)', apex > 225 * 0.25 && apex < 225 * 0.5);
  check('blob is back on the ground', a.y === 0);
}
{
  // Longer holds jump higher.
  const apexFor = (hold) => {
    const w = liveCourt(); park(w);
    const a = w.blobs[0];
    w.setInput('a', 2, true);
    let apex = 0;
    for (let t = 0; t < 40; t++) {
      if (t === hold) w.setInput('a', 2, false);
      w.step();
      apex = Math.max(apex, a.y);
    }
    return apex;
  };
  const h = [2, 5, 8, 12, 40].map(apexFor);
  check('jump height grows with how long JUMP is held (' + h.join(' < ') + ')', h.every((v, i) => i === 0 || v > h[i - 1]));
}

// ---- Moving + side limits ----
{
  const w = liveCourt(); park(w);
  const a = w.blobs[0], b = w.blobs[1];
  w.setInput('a', 1, true);
  w.step();
  check('blob moves 8 units per tick', a.x === BB.HOME[0] + 8);
  for (let t = 0; t < 100; t++) w.step();
  check('left blob stops at its side of the net (445)', a.x === 445);
  w.setInput('b', 0, true);
  for (let t = 0; t < 100; t++) w.step();
  check('right blob stops at its side of the net (555)', b.x === 555);
  w.setInput('a', 1, false); w.setInput('a', 0, true);
  for (let t = 0; t < 100; t++) w.step();
  check('left blob stops at the wall (50)', a.x === 50);
  w.setInput('a', 0, true); w.setInput('a', 1, true);
  const x0 = a.x; w.step();
  check('left + right together stands still', a.x === x0);
}

// ---- Serve ----
{
  const w = world(false);
  w.setupServe(1);
  check('ball hangs above the server', w.ball.x === BB.HOME[1] && w.ball.y === BB.SERVE_Y);
  w.setInput('a', 1, true);
  for (let t = 0; t < 10; t++) w.step();
  check('serve hold: ball hovers, blobs locked', w.ball.y === BB.SERVE_Y && w.blobs[0].x === BB.HOME[0]);
  w.release();
  w.step();
  check('release: the ball drops and a held button acts at once', w.ball.y < BB.SERVE_Y && w.blobs[0].x === BB.HOME[0] + 8);
}

// ---- Walls, ceiling, net ----
{
  const w = liveCourt();
  Object.assign(w.ball, { x: 25, y: 400, vx: -15, vy: 0 });
  w.step();
  check('left wall bounces the ball back', w.ball.vx > 0 && w.ball.x >= BB.WALL_MIN);
  Object.assign(w.ball, { x: 975, y: 400, vx: 15, vy: 0 });
  w.step();
  check('right wall bounces the ball back', w.ball.vx < 0 && w.ball.x <= BB.WALL_MAX);
  Object.assign(w.ball, { x: 300, y: BB.CEIL - 30, vx: 0, vy: 20 });
  w.step();
  check('ceiling bounces the ball down', w.ball.vy < 0 && w.ball.y <= BB.CEIL - BB.BALL_R);
  Object.assign(w.ball, { x: 497, y: 150, vx: 2, vy: -15 });
  let up = false;
  for (let t = 0; t < 3; t++) { w.step(); if (w.ball.vy > 0) up = true; }
  check('ball dropping onto the net top bounces up', up && w.ball.y >= 130);
  Object.assign(w.ball, { x: 470, y: 60, vx: 12, vy: 5 });
  w.step();
  check('ball hitting the net side bounces back', w.ball.vx < 0 && w.ball.x <= 480);
  check('net hits are reported', w.events.some((e) => e.t === 'net'));
}

// ---- Ball off a blob ----
{
  const w = liveCourt();
  const a = w.blobs[0];
  // Falling just net-side of a still blob's crown: goes up and toward the net.
  Object.assign(w.ball, { x: a.x + 15, y: 160, vx: 0, vy: -10 });
  let hit = null;
  for (let t = 0; t < 10 && !hit; t++) { w.step(); hit = w.events.find((e) => e.t === 'hit'); }
  check('ball bounces off a blob', !!hit && hit.seat === 0);
  check('…up and toward the net', w.ball.vy > 0 && w.ball.vx > 0);
  const still = Math.hypot(w.ball.vx, w.ball.vy);

  // Same contact but the blob is jumping into it: a harder hit (velocity adds on).
  const w2 = liveCourt();
  const a2 = w2.blobs[0];
  w2.setInput('a', 2, true);
  for (let t = 0; t < 3; t++) w2.step();
  Object.assign(w2.ball, { x: a2.x + 15, y: a2.y + 150, vx: 0, vy: -10 });
  let hit2 = null;
  for (let t = 0; t < 10 && !hit2; t++) { w2.step(); hit2 = w2.events.find((e) => e.t === 'hit'); }
  const jumping = Math.hypot(w2.ball.vx, w2.ball.vy);
  check('jumping into the ball hits it harder (' + still.toFixed(1) + ' → ' + jumping.toFixed(1) + ')', !!hit2 && jumping > still);
  check('ball speed stays within the caps', Math.abs(w2.ball.vx) <= BB.MAX_VX && Math.abs(w2.ball.vy) <= BB.MAX_VY);
}

// ---- Scoring + dead ball ----
for (const [x, scorer] of [[750, 0], [250, 1]]) {
  const w = liveCourt();
  Object.assign(w.ball, { x, y: 60, vx: 0, vy: -10 });
  let res = null;
  for (let t = 0; t < 20 && !res; t++) res = w.step();
  check('ball down at x=' + x + ' scores for seat ' + scorer, res && res.point && res.scorerSeat === scorer && res.loserSeat === 1 - scorer);
}
{
  const w = liveCourt();
  Object.assign(w.ball, { x: 750, y: 300, vx: 4, vy: -12 });
  let res = null, points = 0, rose = false, lowest = Infinity;
  w.setInput('a', 1, true);
  for (let t = 0; t < 400; t++) {
    res = w.step();
    if (res) points++;
    if (points) {
      lowest = Math.min(lowest, w.ball.y);
      if (w.ball.vy > 0) rose = true;
    }
  }
  check('a point is reported exactly once', points === 1);
  check('after the point the ball keeps bouncing', rose);
  check('…never sinks into the sand', lowest >= BB.BALL_R);
  check('…and finally settles', w.ball.vy === 0 && w.ball.y === BB.BALL_R);
  const ax = w.blobs[0].x;
  w.step();
  check('blobs ignore input while the ball is dead', w.blobs[0].x === ax);
}

// ---- Disconnect clears held input ----
{
  const w = liveCourt(); park(w);
  w.setInput('a', 1, true);
  w.setConnected('a', false);
  const x0 = w.blobs[0].x;
  w.step();
  check('a dropped controller stops its blob (no stuck input)', w.blobs[0].x === x0);
}

// ---- The net is solid: the ball NEVER passes through the post ----
{
  // A crossing of x = 500 is only legal above the post top.
  const through = (px, py, x, y) => {
    if ((px < BB.NET_X) === (x < BB.NET_X)) return false;
    const t = (BB.NET_X - px) / (x - px);
    return py + (y - py) * t < BB.NET_TOP;
  };
  const inPost = (b) => b.x > BB.NET_X - BB.NET_BAND && b.x < BB.NET_X + BB.NET_BAND && b.y < BB.NET_TOP;

  // A fast drop onto the post top just past the centre.
  let w = liveCourt();
  Object.assign(w.ball, { x: 509, y: 152, vx: -15, vy: -22 });
  let px = w.ball.x, py = w.ball.y;
  w.step();
  check('a fast drop onto the post top bounces up, not through', w.ball.vy > 0 && !through(px, py, w.ball.x, w.ball.y) && !inPost(w.ball));

  // A blob pressed against the net shoving the ball sideways into the post.
  w = liveCourt();
  w.setInput('a', 1, true);
  for (let t = 0; t < 40; t++) w.step();
  Object.assign(w.ball, { x: 470, y: 120, vx: 3, vy: 0 });
  let ok = true;
  for (let t = 0; t < 60; t++) {
    px = w.ball.x; py = w.ball.y;
    w.setInput('a', 2, t % 20 < 10);
    w.step();
    if (through(px, py, w.ball.x, w.ball.y) || inPost(w.ball)) ok = false;
  }
  check('a blob shoving the ball into the net never pushes it through', ok);

  // A dead ball rolling along the sand stops at the post.
  w = liveCourt();
  Object.assign(w.ball, { x: 300, y: 26, vx: 12, vy: 0 });
  w.live = false;
  for (let t = 0; t < 120; t++) w.step();
  check('a ball rolling along the sand bounces off the post', w.ball.x < BB.NET_X);

  // Stress: random balls hugging the net, CPUs and a mashing human, ~450k ticks.
  const rng = seeded(9);
  let crossings = 0, inside = 0;
  for (let game = 0; game < 300; game++) {
    const s = new BB.World({ roster: [{ id: 'a', isBot: game % 2 === 0 }, { id: 'b', isBot: true }], rng });
    s.setupServe(game % 2);
    s.release();
    Object.assign(s.ball, { x: 440 + rng() * 120, y: 30 + rng() * 300, vx: (rng() * 2 - 1) * 15, vy: (rng() * 2 - 1) * 22 });
    if (inPost(s.ball)) s.ball.y = BB.NET_TOP + 5;
    s.blobs[0].x = 300 + rng() * 145;
    s.blobs[1].x = 555 + rng() * 145;
    for (let t = 0; t < 1500; t++) {
      if (!s.blobs[0].isBot && t % 7 === 0) {
        s.setInput('a', 0, rng() < 0.3);
        s.setInput('a', 1, rng() < 0.6);
        s.setInput('a', 2, rng() < 0.5);
      }
      s.stepBots();
      px = s.ball.x; py = s.ball.y;
      const r = s.step();
      if (through(px, py, s.ball.x, s.ball.y)) crossings++;
      if (inPost(s.ball)) inside++;
      if (!s.live) { s.setupServe(r ? r.loserSeat : 0); s.release(); }
    }
  }
  check('stress: the ball never crosses below the post top (' + crossings + ')', crossings === 0);
  check('stress: the ball never ends a tick inside the post (' + inside + ')', inside === 0);
}

// ---- CPU vs CPU ----
{
  const w = world(true);
  let serve = 0, pts = 0, hits = 0, stalls = 0;
  const wins = [0, 0];
  for (let p = 0; p < 200; p++) {
    w.setupServe(serve);
    w.release();
    let res = null, t = 0;
    while (!res && t < 3000) {
      w.stepBots();
      res = w.step();
      t++;
      for (const e of w.events) if (e.t === 'hit') hits++;
      w.events.length = 0;
    }
    if (!res) { stalls++; serve = 1 - serve; continue; }
    pts++;
    wins[res.scorerSeat]++;
    serve = res.loserSeat;
  }
  const avg = hits / Math.max(1, pts);
  check('CPU rallies always end (no endless dribbles)', stalls === 0);
  check('CPU keeps a rally going (avg ' + avg.toFixed(1) + ' hits per point)', avg >= 3);
  check('both sides win points (' + wins.join(' / ') + ')', wins[0] > 40 && wins[1] > 40);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nAll engine checks passed.');
process.exit(failures ? 1 : 0);
