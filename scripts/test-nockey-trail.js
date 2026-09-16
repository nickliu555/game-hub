// Exercises Renderer.prototype._drawTrail in isolation (no canvas needed).
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'nockey', 'js', 'render.js'), 'utf8');
global.window = {};
new Function(src)();
const proto = window.NockeyRender.Renderer.prototype;

let fails = 0;
const check = (l, ok, x) => { console.log((ok ? '  \u2713 ' : '  \u2717 FAIL ') + l + (x !== undefined ? '  ' + JSON.stringify(x) : '')); if (!ok) fails++; };

const ctx = { beginPath() {}, arc() {}, fill() {}, set fillStyle(_) {} };
function frame(self, ball, x, y) { proto._drawTrail.call(self, ctx, x, y, Object.assign({ r: 10 }, ball)); }

// 1. A fast ball builds a trail.
const r1 = { trail: [] };
let x = -300;
for (let i = 0; i < 20; i++) { x += 8; frame(r1, { vx: 8, vy: 0 }, x, 0); }
check('fast ball builds a capped trail', r1.trail.length === 14, r1.trail.length);

// 2. THE BUG: a ball creeping at 0.4..1.2 used to freeze the trail in place.
const before = r1.trail.slice();
for (let i = 0; i < 20; i++) { x += 0.8; frame(r1, { vx: 0.8, vy: 0 }, x, 0); }
check('slow-rolling ball drains the trail', r1.trail.length === 0, { was: before.length, now: r1.trail.length });

// 3. A stopped ball also drains.
const r2 = { trail: [] };
let x2 = 0;
for (let i = 0; i < 20; i++) { x2 += 8; frame(r2, { vx: 8, vy: 0 }, x2, 0); }
for (let i = 0; i < 20; i++) frame(r2, { vx: 0, vy: 0 }, x2, 0);
check('stopped ball drains the trail', r2.trail.length === 0, r2.trail.length);

// 4. A kickoff teleport must not leave a streak across the pitch.
const r3 = { trail: [] };
let x3 = 100;
for (let i = 0; i < 20; i++) { x3 += 10; frame(r3, { vx: 10, vy: 0 }, x3, 0); }
check('trail present before the teleport', r3.trail.length > 0, r3.trail.length);
frame(r3, { vx: 0, vy: 0 }, 0, 0);   // ball snapped back to the centre spot
check('teleport clears the stale trail', r3.trail.length === 0, r3.trail);

// 5. Normal fast movement is NOT mistaken for a teleport.
const r4 = { trail: [] };
let x4 = 0;
for (let i = 0; i < 30; i++) { x4 += 20; frame(r4, { vx: 20, vy: 0 }, x4, 0); }
check('a genuinely fast ball keeps its trail', r4.trail.length === 14, r4.trail.length);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASSED'));
process.exit(fails ? 1 : 0);
