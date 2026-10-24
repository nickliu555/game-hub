'use strict';

// Shoot Ball engine probe — loads public/shootball/js/engine.js in a window
// shim and exercises flicks, collisions, goals, rest detection, and the
// token-in-goal respawn. Run: `node scripts/test-shootball-physics.js`.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'shootball', 'js', 'engine.js'), 'utf8');
const sandbox = { window: {}, Math, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { World } = sandbox.window.ShootBall;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  FAIL:', msg); } }

const DT = 1 / 120;
function settle(world, maxSec = 12) {
  const steps = Math.round(maxSec / DT);
  for (let i = 0; i < steps; i++) {
    const g = world.step(DT);
    if (g) return g;
    if (world.allAtRest()) return null;
  }
  return 'timeout';
}

// 1) Formation is symmetric + at rest.
{
  const w = new World();
  ok(w.tokens.length === 10, 'ten tokens');
  ok(w.allAtRest(), 'formation starts at rest');
  const rk = w.tokenAt('red', 0), bk = w.tokenAt('blue', 0);
  ok(Math.abs((w.field.W - rk.x) - bk.x) < 0.001, 'keepers mirrored');
  ok(Math.abs(w.ball.x - w.field.W / 2) < 0.001 && Math.abs(w.ball.y - w.field.H / 2) < 0.001, 'ball centered');
}

// 2) A flick moves the token OPPOSITE the pull, then it comes to rest.
{
  const w = new World();
  const t = w.tokenAt('red', 3);
  const x0 = t.x;
  w.applyFlick('red', 3, -1, 0); // pull left at full power -> launch right
  ok(t.vx > 1000, 'launch to the right (opposite pull)');
  const res = settle(w);
  ok(res === null || res === 'red' || res === 'blue', 'settled or scored: ' + res);
  ok(Math.abs(t.x - x0) > 20 || res, 'token was displaced by the flick');
  ok(w.allAtRest() || res, 'world at rest after settle');
}

// 3) Direct shot down the middle scores in the right (blue) net -> 'red'.
{
  const w = new World();
  // Clear blue defenders/keeper out of the way to guarantee a clean lane.
  for (let i = 0; i < 5; i++) { const bt = w.tokenAt('blue', i); bt.y = 60; }
  // Put a red forward just behind the ball and fire straight right.
  const t = w.tokenAt('red', 3);
  t.x = w.ball.x - 80; t.y = w.ball.y;
  w.applyFlick('red', 3, -1, 0);
  const res = settle(w);
  ok(res === 'red', 'straight shot scores for red: ' + res);
}

// 4) Own goal: knock the ball into your OWN (left) net -> 'blue' scores.
{
  const w = new World();
  for (let i = 0; i < 5; i++) { const rt = w.tokenAt('red', i); rt.y = 60; }
  const t = w.tokenAt('red', 0);
  t.x = w.ball.x + 80; t.y = w.ball.y;
  w.applyFlick('red', 0, 1, 0); // pull right -> launch left into own net
  const res = settle(w);
  ok(res === 'blue', 'own goal awards blue: ' + res);
}

// 5) Ball does not tunnel through a token at max flick speed (collision fires).
{
  const w = new World();
  const t = w.tokenAt('red', 3);
  t.x = w.ball.x - 70; t.y = w.ball.y;
  const ballX0 = w.ball.x;
  w.applyFlick('red', 3, -1, 0);
  // Step a few frames; the ball should get pushed (vx becomes positive).
  for (let i = 0; i < 30; i++) { if (w.step(DT)) break; }
  ok(w.ball.vx > 200 || w.ball.x > ballX0 + 20, 'ball is driven forward by the token');
}

// 6) Token-in-goal respawn moves a pocketed token back onto the pitch.
{
  const w = new World();
  const t = w.tokenAt('blue', 1);
  t.x = -20; t.y = w.field.H / 2; t.vx = 0; t.vy = 0; // sitting in the left pocket
  const moved = w.respawnTokensInGoal();
  ok(moved.indexOf(t) >= 0, 'pocketed token flagged for respawn');
  ok(t.x > w.field.TOKEN_R, 'respawned onto the pitch (x>' + w.field.TOKEN_R + '): ' + t.x.toFixed(1));
}

// 7) Snapshot / restore round-trips positions.
{
  const w = new World();
  w.tokenAt('red', 2).x = 500; w.tokenAt('red', 2).y = 200;
  w.ball.x = 900; w.ball.y = 300;
  const snap = w.snapshot();
  const w2 = new World();
  w2.restore(snap);
  ok(Math.abs(w2.tokenAt('red', 2).x - 500) < 1, 'restore token x');
  ok(Math.abs(w2.ball.x - 900) < 1, 'restore ball x');
}

// 8) Every flicked token eventually comes to rest (no perpetual motion).
{
  let allSettled = true;
  for (let trial = 0; trial < 20; trial++) {
    const w = new World();
    const ang = Math.random() * Math.PI * 2;
    w.applyFlick('red', 3, Math.cos(ang), Math.sin(ang));
    const res = settle(w, 14);
    if (res === 'timeout') { allSettled = false; break; }
  }
  ok(allSettled, 'all random flicks settle within 14s');
}

// 9) The goal is awarded on the crossing frame, then the ball keeps rolling on
//    into the pocket instead of freezing on the line — and only scores once.
{
  const w = new World();
  for (let i = 0; i < 5; i++) { const bt = w.tokenAt('blue', i); bt.y = 60; }
  const t = w.tokenAt('red', 3);
  t.x = w.ball.x - 80; t.y = w.ball.y;
  w.applyFlick('red', 3, -1, 0);

  let res = null;
  for (let i = 0; i < Math.round(12 / DT) && !res; i++) res = w.step(DT);
  ok(res === 'red', 'goal reported on the crossing frame: ' + res);
  const crossX = w.ball.x;
  ok(crossX >= w.field.W, 'ball is only just over the line: ' + crossX.toFixed(1));

  let again = null;
  for (let i = 0; i < Math.round(4 / DT); i++) { const g = w.step(DT); if (g) again = g; }
  ok(again === null, 'the same goal is not reported twice: ' + again);
  ok(w.ball.x > crossX + 10, 'ball travelled on into the net: ' + w.ball.x.toFixed(1));
  const back = w.field.W + w.field.GOAL_DEPTH;
  ok(w.ball.x <= back, 'ball stays inside the pocket back wall (<=' + back + '): ' + w.ball.x.toFixed(1));
  ok(w.allAtRest(), 'everything settles during the celebration');

  // A fresh kickoff clears the latch so the next goal counts.
  w.setFormation();
  ok(w.goalScored === null, 'kickoff clears the goal latch');
}

// 10) The back of the net is a solid wall for tokens: a token driven into it
//     rebounds exactly as hard as off a side wall, so it can be banked out of
//     the pocket. Only the ball (already a goal) is deadened by the netting.
{
  const f = new World().field;
  const RIGHT_BACK = f.W + f.GOAL_DEPTH;

  function firstBounce(setup) {
    const w = new World();
    w.ball.x = f.W / 2; w.ball.y = 60;
    for (const b of w.bodies) if (b !== w.ball) { b.x = 200 + w.bodies.indexOf(b) * 40; b.y = f.H - 40; b.vx = 0; b.vy = 0; }
    const body = setup(w);
    for (let i = 0; i < Math.round(2 / DT); i++) {
      const before = body.vx;
      w.step(DT);
      if (before > 0 && body.vx < 0) return { speedIn: before, speedOut: -body.vx, w, body };
    }
    return null;
  }

  // Into the back of the RIGHT net, straight down the middle of the mouth.
  const net = firstBounce((w) => { const t = w.tokenAt('red', 0); t.x = f.W - 60; t.y = f.H / 2; t.vx = 900; t.vy = 0; return t; });
  // Same token, same speed, into the plain end wall above the mouth.
  const wall = firstBounce((w) => { const t = w.tokenAt('red', 0); t.x = f.W - 60; t.y = 120; t.vx = 900; t.vy = 0; return t; });
  ok(!!net && !!wall, 'token bounced off both the net back and the end wall');
  if (net && wall) {
    const netRatio = net.speedOut / net.speedIn;
    const wallRatio = wall.speedOut / wall.speedIn;
    ok(Math.abs(netRatio - wallRatio) < 0.02, 'net back is as bouncy as a wall for a token (net ' + netRatio.toFixed(2) + ' vs wall ' + wallRatio.toFixed(2) + ')');
    ok(net.body.x > RIGHT_BACK - 200, 'the rebound happened at the back of the net: x=' + net.body.x.toFixed(1));
  }

  // A token sitting deep in the net is knocked back out onto the pitch.
  {
    const w = new World();
    w.ball.x = f.W / 2; w.ball.y = 60;
    for (const b of w.bodies) if (b !== w.ball) { b.x = 200 + w.bodies.indexOf(b) * 40; b.y = f.H - 40; b.vx = 0; b.vy = 0; }
    const t = w.tokenAt('red', 0);
    t.x = f.W - 40; t.y = f.H / 2; t.vx = 1100; t.vy = 0;
    let deepest = t.x;
    for (let i = 0; i < Math.round(3 / DT); i++) { w.step(DT); deepest = Math.max(deepest, t.x); }
    ok(deepest > f.W, 'token went into the net: deepest x=' + deepest.toFixed(1));
    ok(t.x < f.W, 'token rebounded off the back of the net and out onto the pitch: x=' + t.x.toFixed(1));
  }

  // The ball is still swallowed by the netting.
  const ball = firstBounce((w) => { w.ball.x = f.W - 60; w.ball.y = f.H / 2; w.ball.vx = 900; w.ball.vy = 0; return w.ball; });
  ok(!ball || ball.speedOut / ball.speedIn < 0.2, 'the ball is still deadened by the net' + (ball ? ' (' + (ball.speedOut / ball.speedIn).toFixed(2) + ')' : ''));
}

console.log('\nShoot Ball physics: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
