'use strict';
// Headless physics checks for the Nong engine (public/nong/js/engine.js).
const Nong = require('../public/nong/js/engine.js');
const { axisFor } = require('../server/nong/game.js');

let failures = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name); if (!cond) failures++; }

function roster(n, bots) {
  const out = [];
  for (let s = 0; s < n; s++) out.push({ id: 'p' + s, name: 'P' + s, seat: s, axis: axisFor(n, s), isBot: !!bots });
  return out;
}

// Is (x, y) inside the arena polygon, expanded by `pad`?
function inside(w, x, y, pad) {
  return w.sides.every((s) => (x - s.ax) * s.nx + (y - s.ay) * s.ny >= -pad);
}

// ---- Geometry ----
for (const n of [2, 3, 4]) {
  const w = new Nong.World({ roster: roster(n) });
  check(n + 'P: every seat owns exactly one side', w.paddles.every((p) => p.side >= 0) &&
    new Set(w.paddles.map((p) => p.side)).size === n);
  check(n + 'P: inward normals point at the centre', w.sides.every((s) => -s.ax * s.nx - s.ay * s.ny > 0));
  // The engine's derived axis must agree with the server's (the phone slider).
  const derived = w.paddles.map((p) => {
    const s = w.sides[p.side];
    return Math.abs(s.ty) > Math.abs(s.tx) + 1e-6 ? 'v' : 'h';
  });
  check(n + 'P: server axisFor matches the arena', derived.every((a, s) => a === axisFor(n, s)));
}

// ---- Input mapping follows the screen ----
{
  const w = new Nong.World({ roster: roster(2) });
  w.setInput('p0', 0); for (let i = 0; i < 120; i++) w.step();
  const top = w.paddleCenter(w.paddles[0]);
  w.setInput('p0', 1); for (let i = 0; i < 120; i++) w.step();
  const bottom = w.paddleCenter(w.paddles[0]);
  check('2P: slider top moves the left paddle up the screen', top.y < bottom.y);
  check('2P: paddle stays clear of the corners', top.y - w.paddleLen / 2 >= -240 - 0.01);
}
{
  const w = new Nong.World({ roster: roster(4) });
  for (const p of w.paddles) w.setInput(p.id, 0);
  for (let i = 0; i < 120; i++) w.step();
  const left = w.paddles.map((p) => w.paddleCenter(p).x);
  for (const p of w.paddles) w.setInput(p.id, 1);
  for (let i = 0; i < 120; i++) w.step();
  const right = w.paddles.map((p) => w.paddleCenter(p).x);
  check('4P: slider left moves every diamond paddle left on screen', left.every((x, i) => x < right[i]));
}
{
  const w = new Nong.World({ roster: roster(3) });
  w.setInput('p0', 0); w.setInput('p1', 0); w.setInput('p2', 0);
  for (let i = 0; i < 120; i++) w.step();
  const a = w.paddles.map((p) => w.paddleCenter(p));
  w.setInput('p0', 1); w.setInput('p1', 1); w.setInput('p2', 1);
  for (let i = 0; i < 120; i++) w.step();
  const b = w.paddles.map((p) => w.paddleCenter(p));
  check('3P: base slider runs left→right', a[0].x < b[0].x);
  check('3P: slant sliders run top→bottom', a[1].y < b[1].y && a[2].y < b[2].y);
}

// ---- Paddle returns the ball, a miss concedes ----
{
  const w = new Nong.World({ roster: roster(2) });
  w.frozen = false;
  w.serve(0);
  w.ball.vx = -Nong.START_SPEED; w.ball.vy = 0;
  let res = null, hit = false;
  for (let i = 0; i < 400 && !res; i++) {
    res = w.step();
    if (w.events.some((e) => e.t === 'hit')) hit = true;
    w.events.length = 0;
    if (hit) break;
  }
  check('2P: a centred paddle returns a straight ball', hit && w.ball.vx > 0);
  check('2P: the first return lifts a slow serve to rally speed', w.ball.speed === Nong.START_SPEED);
  w.ball.speed = Nong.START_SPEED * 1.2;
  w.ball.vx = -w.ball.speed; w.ball.vy = 0;
  let again = false;
  for (let i = 0; i < 400 && !again; i++) { w.step(); again = w.events.some((e) => e.t === 'hit'); w.events.length = 0; }
  check('2P: each later return speeds the ball up', again && w.ball.speed > Nong.START_SPEED * 1.2);

  const w2 = new Nong.World({ roster: roster(2) });
  w2.frozen = false;
  w2.serve(0);
  w2.ball.x = 0; w2.ball.y = 200; w2.ball.vx = -Nong.START_SPEED; w2.ball.vy = 0;
  w2.setInput('p0', 0);
  let r2 = null;
  for (let i = 0; i < 400 && !r2; i++) r2 = w2.step();
  check('2P: a ball past the paddle concedes for that seat', r2 && r2.seat === 0);

  // Hitting the paddle's edge sends the ball off at a steep angle.
  const w3 = new Nong.World({ roster: roster(2) });
  w3.frozen = false;
  w3.serve(1);
  const pc = w3.paddleCenter(w3.paddles[1]);
  w3.ball.x = 0; w3.ball.y = pc.y + w3.paddleLen / 2 - 4; w3.ball.vx = Nong.START_SPEED; w3.ball.vy = 0;
  let edge = false;
  for (let i = 0; i < 400; i++) { w3.step(); if (w3.events.some((e) => e.t === 'hit')) { edge = true; break; } w3.events.length = 0; }
  check('2P: an edge hit returns at a steep angle', edge && Math.abs(w3.ball.vy) > Math.abs(w3.ball.vx) * 0.8);
}

// ---- Serves are gentle ----
for (const n of [2, 3, 4]) {
  const w = new Nong.World({ roster: roster(n) });
  w.frozen = false;
  w.serve(null);
  const sp = Math.hypot(w.ball.vx, w.ball.vy);
  check(n + 'P: a serve leaves slower than rally speed', Math.abs(sp - Nong.SERVE_SPEED) < 1e-9 && Nong.SERVE_SPEED < Nong.START_SPEED);
}

// ---- Walls bounce ----
{
  const w = new Nong.World({ roster: roster(2) });
  w.frozen = false;
  w.serve(0);
  w.ball.x = 0; w.ball.y = 0; w.ball.vx = 0.5; w.ball.vy = -Nong.START_SPEED;
  let wall = false;
  for (let i = 0; i < 200; i++) { w.step(); if (w.events.some((e) => e.t === 'wall')) { wall = true; break; } }
  check('2P: the top wall bounces the ball', wall && w.ball.vy > 0);
}

// ---- Eliminated sides are walls ----
{
  const w = new Nong.World({ roster: roster(3) });
  w.eliminate('p0');
  w.frozen = false;
  w.serve(1);
  w.ball.x = 0; w.ball.y = 0; w.ball.vx = 0; w.ball.vy = Nong.START_SPEED;
  let res = null, wall = false;
  for (let i = 0; i < 300 && !res; i++) { res = w.step(); if (w.events.some((e) => e.t === 'wall')) wall = true; w.events.length = 0; if (wall) break; }
  check('3P: an eliminated base is a solid wall', !res && wall && w.ball.vy < 0);
  check('3P: serve never targets an eliminated seat', Array.from({ length: 40 }, () => w.serve(null)).every((s) => s !== 0));
}

// ---- Corner stretches are walls, the mouth is a goal ----
{
  const w = new Nong.World({ roster: roster(4) });
  w.frozen = false;
  const p = w.paddles[0];
  const side = w.sides[p.side];
  // Aim straight at the corner stretch of seat 0's side with the paddle parked far away.
  w.setInput('p0', 1);
  for (let i = 0; i < 60; i++) w.step();
  w.serve(0);
  const t = side.g0 / 2;
  w.ball.x = side.ax + side.tx * t + side.nx * 80;
  w.ball.y = side.ay + side.ty * t + side.ny * 80;
  w.ball.vx = -side.nx * Nong.START_SPEED; w.ball.vy = -side.ny * Nong.START_SPEED;
  let res = null, wall = false;
  for (let i = 0; i < 200 && !res && !wall; i++) { res = w.step(); wall = w.events.some((e) => e.t === 'wall'); w.events.length = 0; }
  check('4P: a corner stretch bounces instead of scoring', wall && !res);
}

// ---- Corner bounces can't sneak behind the paddle (3P/4P) ----
// Park the paddle at the end next to a corner and fire shots into that corner
// stretch. The ball may bounce off the corner, but it must never then slip
// along the wall into the goal behind the paddle.
for (const n of [3, 4]) {
  let seed = 777 + n;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let sneaks = 0, cornerHits = 0;
  for (let shot = 0; shot < 4000; shot++) {
    const w = new Nong.World({ roster: roster(n), rand });
    const p = w.paddles[0];
    const side = w.sides[p.side];
    const nearA = rand() < 0.5;
    w.setInput('p0', p.forward === nearA ? 0 : 1);
    for (let i = 0; i < 60; i++) w.step();
    w.frozen = false;
    w.serve(0);
    // Aim at a random point on the corner stretch from somewhere inside.
    const t = nearA ? rand() * side.g0 : side.len - rand() * side.g0;
    const tx = side.ax + side.tx * t, ty = side.ay + side.ty * t;
    const depth = 30 + rand() * 200;
    const along = (rand() * 2 - 1) * 260;
    w.ball.x = tx + side.nx * depth + side.tx * along;
    w.ball.y = ty + side.ny * depth + side.ty * along;
    const dx = tx - w.ball.x, dy = ty - w.ball.y, len = Math.hypot(dx, dy);
    const sp = Nong.START_SPEED + rand() * (Nong.MAX_SPEED - Nong.START_SPEED);
    w.ball.speed = sp; w.ball.vx = dx / len * sp; w.ball.vy = dy / len * sp;
    if (!inside(w, w.ball.x, w.ball.y, 0)) continue;
    for (let i = 0; i < 240; i++) {
      const r = w.step();
      const evs = w.events.splice(0);
      if (evs.some((e) => e.t === 'hit')) break;
      if (evs.some((e) => e.t === 'wall')) {
        // A bounce off another side means a fresh approach; stop following.
        const d = (w.ball.x - side.ax) * side.nx + (w.ball.y - side.ay) * side.ny;
        if (d > Nong.BALL_R + 1) break;
        cornerHits++;
      }
      if (r && r.seat === 0) { sneaks++; break; }
      if (r) break;
    }
  }
  check(n + 'P: corner shots were tested (' + cornerHits + ' corner bounces)', cornerHits > 200);
  check(n + 'P: no ball sneaks behind a parked paddle (' + sneaks + ')', sneaks === 0);
}

// ---- Long CPU-vs-CPU soak: the ball never escapes, goals keep coming ----
for (const n of [2, 3, 4]) {
  let seed = 12345 + n;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const w = new Nong.World({ roster: roster(n, true), rand });
  w.frozen = false;
  w.serve(null);
  let goals = 0, hits = 0, idles = 0, escaped = false, maxRally = 0, rally = 0;
  for (let i = 0; i < 60 * 60 * 10; i++) {
    w.stepBots();
    const r = w.step();
    for (const e of w.events) if (e.t === 'hit') { hits++; rally++; }
    w.events.length = 0;
    if (!inside(w, w.ball.x, w.ball.y, w.goalDepth + Nong.BALL_R) && !r) escaped = true;
    if (r && r.seat !== undefined) { goals++; maxRally = Math.max(maxRally, rally); rally = 0; w.serve(r.seat); }
    else if (r && r.idle) { idles++; w.serve(null); }
  }
  check(n + 'P soak: ball never leaves the arena', !escaped);
  check(n + 'P soak: CPUs return the ball (' + hits + ' hits)', hits > 50);
  check(n + 'P soak: CPUs are beatable (' + goals + ' goals in 10 min)', goals >= 10);
  check(n + 'P soak: rallies happen (longest ' + maxRally + ')', maxRally >= 3);
  check(n + 'P soak: stalls are rare (' + idles + ')', idles <= goals);
}

console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nAll checks passed');
process.exit(failures ? 1 : 0);
