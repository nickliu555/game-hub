'use strict';

// Sling Soccer engine probe — loads public/slingsoccer/js/engine.js in a window
// shim and exercises flicks, collisions, goals, rest detection, and the
// token-in-goal respawn. Run: `node scripts/test-slingsoccer-physics.js`.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'slingsoccer', 'js', 'engine.js'), 'utf8');
const sandbox = { window: {}, Math, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { World } = sandbox.window.SlingSoccer;

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

console.log('\nSling Soccer physics: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
