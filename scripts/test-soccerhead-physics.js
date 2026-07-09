'use strict';
// Headless probe of the Soccer Head physics engine (public/soccerhead/js/engine.js).
// Loads the browser IIFE with a minimal window shim and exercises core feel.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'soccerhead', 'js', 'engine.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const HB = sandbox.window.SoccerHead;

let failures = 0;
function check(name, cond, extra) { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) failures++; }

const DT = 1 / 120;
function stepN(w, n) { let g = null; for (let i = 0; i < n; i++) { const s = w.step(DT); if (s) g = s; } return g; }

// 1. Gravity + ground rest.
(function () {
  const w = new HB.World({ mode: '1v1' });
  w.setRoster([{ id: 'r', name: 'R', team: 'red', seat: 0 }, { id: 'b', name: 'B', team: 'blue', seat: 0 }]);
  w.frozen = false;
  w.ball.x = HB.W / 2; w.ball.y = HB.GROUND_Y * 0.3; w.ball.vx = 0; w.ball.vy = 0;
  stepN(w, 360); // 3s — enough to settle from any field height
  const restY = HB.GROUND_Y - w.ball.r;
  check('ball settles on ground', Math.abs(w.ball.y - restY) < 3 && Math.abs(w.ball.vy) < 60, 'y=' + w.ball.y.toFixed(1));
})();

// 2. Kick imparts forward velocity.
(function () {
  const w = new HB.World({ mode: '1v1' });
  w.setRoster([{ id: 'r', name: 'R', team: 'red', seat: 0 }, { id: 'b', name: 'B', team: 'blue', seat: 0 }]);
  w.frozen = false;
  const red = w.byId.get('r');
  red.x = 400; red.y = HB.GROUND_Y;
  w.ball.x = red.x + 55; w.ball.y = HB.GROUND_Y - 24; w.ball.vx = 0; w.ball.vy = 0;
  w.setInput('r', 3, true); // kick
  stepN(w, 24);
  check('kick sends ball toward opponent goal (+x)', w.ball.vx > 200, 'vx=' + w.ball.vx.toFixed(0));
  check('kick lifts ball (vy<0 at contact)', w.ball.vy < 50, 'vy=' + w.ball.vy.toFixed(0));
})();

// 3. Goal detection (right goal => red scores).
(function () {
  const w = new HB.World({ mode: '1v1' });
  w.setRoster([{ id: 'r', name: 'R', team: 'red', seat: 0 }, { id: 'b', name: 'B', team: 'blue', seat: 0 }]);
  w.frozen = false;
  // Move keepers out of the way.
  w.byId.get('b').x = HB.W / 2;
  w.ball.x = HB.W - 70; w.ball.y = HB.GROUND_Y - 90; w.ball.vx = 900; w.ball.vy = 0;
  const g = stepN(w, 30);
  check('ball into right goal => red scores', g === 'red', 'got=' + g);
})();

// 3b. THE KEY ONE: can an attacker chip the ball over an IDLE defender who is
// standing in front of their own goal, and score? (The original bug.)
(function () {
  const w = new HB.World({ mode: '1v1' });
  w.setRoster([{ id: 'r', name: 'R', team: 'red', seat: 0 }, { id: 'b', name: 'B', team: 'blue', seat: 0 }]);
  w.frozen = false;
  const red = w.byId.get('r');
  const blue = w.byId.get('b'); // idle defender
  // Idle blue stands just in front of the right goal, doing nothing.
  blue.x = HB.W - 150; blue.y = HB.GROUND_Y;
  // Red attacker lines up a bit back with the ball just ahead of its boot.
  red.x = HB.W - 420; red.y = HB.GROUND_Y;
  w.ball.x = red.x + 52; w.ball.y = HB.GROUND_Y - 20; w.ball.vx = 0; w.ball.vy = 0;
  w.setInput('r', 3, true); // kick (lob)
  let scored = null;
  let maxAir = 0;
  for (let i = 0; i < 240 && !scored; i++) { // up to 2s of flight
    scored = w.step(DT);
    maxAir = Math.max(maxAir, HB.GROUND_Y - w.ball.y);
    // blue does nothing (idle) — never moves.
  }
  check('lob clears an idle defender and scores', scored === 'red', 'scored=' + scored + ' apex=' + maxAir.toFixed(0));
})();

// 4. Jump leaves the ground and returns — but a MAX jump must NOT reach the
//    crossbar (the top of the goal has to stay un-guardable, like Head Soccer).
(function () {
  const w = new HB.World({ mode: '1v1' });
  w.setRoster([{ id: 'r', name: 'R', team: 'red', seat: 0 }, { id: 'b', name: 'B', team: 'blue', seat: 0 }]);
  w.frozen = false;
  const red = w.byId.get('r');
  const f = w.field;
  w.setInput('r', 2, true); // jump down (held = full-height jump)
  let minY = red.y;
  for (let i = 0; i < 220; i++) { w.step(DT); minY = Math.min(minY, red.y); }
  const jumpHeadTop = minY - f.HEAD_CY - f.HEAD_R; // highest the head reaches
  const jumpFeet = minY;                            // highest the feet reach
  const standHeadTop = HB.GROUND_Y - f.HEAD_CY - f.HEAD_R; // an idle opponent's head
  check('jump raises player off ground', minY < HB.GROUND_Y - 120, 'apex rise=' + (HB.GROUND_Y - minY).toFixed(0));
  check('jump clears an opponent\'s head (can leap over the body)', jumpFeet < standHeadTop,
    'feet=' + jumpFeet.toFixed(0) + ' oppHead=' + standHeadTop.toFixed(0));
  check('a max jump can reach the goal top (goal is defendable)', jumpHeadTop <= f.TOP_Y + 6,
    'headTop=' + jumpHeadTop.toFixed(0) + ' crossbar=' + f.TOP_Y + ' reach=' + (f.TOP_Y - jumpHeadTop).toFixed(0));
  check('player lands back on ground', Math.abs(red.y - HB.GROUND_Y) < 2, 'y=' + red.y.toFixed(1));
})();

// 5. Dash bursts speed then goes on cooldown.
(function () {
  const w = new HB.World({ mode: '1v1' });
  w.setRoster([{ id: 'r', name: 'R', team: 'red', seat: 0 }, { id: 'b', name: 'B', team: 'blue', seat: 0 }]);
  w.frozen = false;
  const red = w.byId.get('r');
  red.x = 600;
  w.dash('r', 1);
  w.step(DT);
  check('dash produces a high burst speed', Math.abs(red.vx) > 900, 'vx=' + red.vx.toFixed(0));
  const cdBefore = red.dashCd;
  w.dash('r', 1); // should be ignored (cooldown)
  check('dash on cooldown cannot re-trigger', red.dashCd <= cdBefore + 0.001);
})();

// 5b. Dashing INTO the ball is a power body-check — far harder than a walk-in.
(function () {
  function ballSpeedAfterContact(dashing) {
    const w = new HB.World({ mode: '1v1' });
    w.setRoster([{ id: 'r', name: 'R', team: 'red', seat: 0 }, { id: 'b', name: 'B', team: 'blue', seat: 0 }]);
    w.frozen = false;
    const red = w.byId.get('r');
    w.byId.get('b').x = HB.W / 2;
    red.x = 600; red.y = HB.GROUND_Y;
    // Ball just ahead of the body at torso height.
    w.ball.x = red.x + 55; w.ball.y = HB.GROUND_Y - 58; w.ball.vx = 0; w.ball.vy = 0;
    if (dashing) { w.dash('r', 1); }
    else { red.vx = 440; } // full run speed walk-in for comparison
    let best = 0;
    for (let i = 0; i < 20; i++) { w.step(DT); best = Math.max(best, Math.abs(w.ball.vx)); }
    return best;
  }
  const walkHit = ballSpeedAfterContact(false);
  const dashHit = ballSpeedAfterContact(true);
  check('dash body-check launches the ball hard', dashHit > 900, 'dashVx=' + dashHit.toFixed(0));
  check('dash hit is stronger than a walk-in', dashHit > walkHit * 1.5, 'dash=' + dashHit.toFixed(0) + ' walk=' + walkHit.toFixed(0));
})();

// 6. Movement respects max run speed on the ground.
(function () {
  const w = new HB.World({ mode: '1v1' });
  w.setRoster([{ id: 'r', name: 'R', team: 'red', seat: 0 }, { id: 'b', name: 'B', team: 'blue', seat: 0 }]);
  w.frozen = false;
  const red = w.byId.get('r');
  w.byId.get('b').x = 60; // park the other player out of the running lane
  red.x = 300;
  w.setInput('r', 1, true);
  for (let i = 0; i < 120; i++) w.step(DT);
  check('grounded run speed capped (~440)', Math.abs(red.vx) <= 445 && Math.abs(red.vx) > 380, 'vx=' + red.vx.toFixed(0));
})();

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
