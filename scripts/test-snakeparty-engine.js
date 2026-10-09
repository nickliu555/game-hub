'use strict';
/* Headless engine tests for Snake Party.
 * Loads maps.js + engine.js + bot.js in a vm sandbox and asserts map sanity,
 * movement, deadly edges (no wrap), the turn queue, growth, every collision rule (edge, wall, self,
 * other body, head-on, head swap, chasing a moving tail), death → one special apple on the tail,
 * apple counts, and long NaN-free bot-vs-bot simulations.
 * Run: node scripts/test-snakeparty-engine.js
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sandbox = { console, Math };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
['maps.js', 'engine.js', 'bot.js'].forEach((f) => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/snakeparty/js', f), 'utf8'), sandbox);
});
const Maps = sandbox.SnakePartyMaps;
const SP = sandbox.SnakeParty;
const Bot = sandbox.SnakePartyBot;
const UP = 0, DOWN = 1, LEFT = 2, RIGHT = 3;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } }
function section(t) { console.log('\n' + t); }

// A tiny open test board (no walls) so scenarios are easy to lay out by hand.
function openMaps(w, h, walls) {
  return {
    build() {
      const wall = new Uint8Array(w * h);
      (walls || []).forEach(([x, y]) => { wall[y * w + x] = 1; });
      return { name: 'Test', w, h, wall, spawns: [{ x: 5, y: 5, dir: RIGHT }, { x: 5, y: 8, dir: RIGHT }, { x: 5, y: 2, dir: RIGHT }, { x: 5, y: 11, dir: RIGHT }] };
    },
  };
}
function roster(n) {
  return Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, seat: i, color: '#fff' }));
}
function mkWorld(n, opts) {
  const w = new SP.World({ maps: (opts && opts.maps) || openMaps(20, 14, opts && opts.walls), rng: (opts && opts.rng) || Math.random });
  w.setRoster(roster(n));
  w.reset(0, { mode: (opts && opts.mode) || 'multi' });
  w.food.clear();
  return w;
}
function place(w, id, cells, dir) {
  const p = w.byId.get(id);
  p.body = cells.map(([x, y]) => ({ x, y }));
  p.prevBody = p.body.map((c) => ({ x: c.x, y: c.y }));
  p.dir = dir; p.queue = []; p.grow = 0; p.alive = true; p.waiting = false;
}
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ---------------- Maps ----------------
section('Maps');
ok(Maps.count >= 5, 'at least 5 hand-designed maps');
const EXPECT = { 1: [24, 14], 2: [30, 18], 3: [36, 22], 4: [40, 24] };
for (let n = 1; n <= 4; n++) {
  const [EW, EH] = EXPECT[n];
  for (let i = 0; i < Maps.count; i++) {
    const b = Maps.build(i, n);
    const W = b.w, H = b.h;
    const name = b.name + ' @' + n;
    ok(W === EW && H === EH && b.wall.length === W * H, name + ': ' + EW + '×' + EH + ' board (got ' + W + '×' + H + ')');
    // The seats this many snakes use: bodies + 5 cells ahead clear, no overlaps.
    const used = new Set();
    b.spawns.slice(0, n).forEach((s, seat) => {
      const d = SP.DIRS[s.dir], back = SP.DIRS[SP.REVERSE[s.dir]];
      for (let k = 0; k < SP.START_LEN; k++) {
        const x = s.x + back.x * k, y = s.y + back.y * k;
        ok(x >= 0 && x < W && y >= 0 && y < H, name + ' seat ' + seat + ' body on the board');
        ok(!b.wall[y * W + x], name + ' seat ' + seat + ' body clear');
        ok(!used.has(y * W + x), name + ' seat ' + seat + ' no overlap');
        used.add(y * W + x);
      }
      for (let k = 1; k <= 5; k++) {
        const x = s.x + d.x * k, y = s.y + d.y * k;
        ok(x >= 0 && x < W && y >= 0 && y < H && !b.wall[y * W + x], name + ' seat ' + seat + ' path ahead clear (' + k + ')');
      }
    });
    // Every open cell is reachable, so no apple can spawn in a sealed pocket.
    let start = -1, open = 0, walls = 0;
    for (let k = 0; k < W * H; k++) { if (!b.wall[k]) { open++; if (start < 0) start = k; } else walls++; }
    const seen = new Set([start]); const q = [start];
    while (q.length) {
      const k = q.pop(); const x = k % W, y = (k / W) | 0;
      for (const d of SP.DIRS) {
        const nx = x + d.x, ny = y + d.y;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const m = ny * W + nx;
        if (!b.wall[m] && !seen.has(m)) { seen.add(m); q.push(m); }
      }
    }
    ok(seen.size === open, name + ': all open cells connected');
    ok(walls > 0, name + ': has obstacles');
    let sym = true;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (b.wall[y * W + x] !== b.wall[y * W + (W - 1 - x)] || b.wall[y * W + x] !== b.wall[(H - 1 - y) * W + x]) sym = false;
    }
    ok(sym, name + ': mirror-symmetric');
  }
}
{
  const w = new SP.World({ maps: Maps });
  for (let n = 1; n <= 4; n++) {
    w.setRoster(roster(n));
    w.reset(0, { mode: n === 1 ? 'solo' : 'multi' });
    ok(w.board.w === EXPECT[n][0] && w.board.h === EXPECT[n][1], 'world with ' + n + ' snake(s) gets the ' + EXPECT[n].join('×') + ' board');
  }
}

// ---------------- Reset / spawn ----------------
section('Reset + apples');
{
  const w = new SP.World({ maps: Maps });
  w.setRoster(roster(4));
  w.reset(0, { mode: 'multi' });
  ok(w.players.every((p) => p.body.length === SP.START_LEN && p.alive), 'every snake spawns alive at length 3');
  ok(w.appleCount() === 6, 'multi: 2 + players apples (got ' + w.appleCount() + ')');
  const ws = new SP.World({ maps: Maps });
  ws.setRoster(roster(1));
  ws.reset(2, { mode: 'solo' });
  ok(ws.appleCount() === 1, 'solo: exactly one apple');
  let foodOnSnake = false;
  ws.food.forEach((f) => { if (ws.players[0].body.some((c) => c.x === f.x && c.y === f.y)) foodOnSnake = true; if (ws.board.wall[f.y * ws.board.w + f.x]) foodOnSnake = true; });
  ok(!foodOnSnake, 'apple never spawns on a snake or a wall');
}

// ---------------- Movement / wrap / queue ----------------
section('Movement');
{
  const w = mkWorld(1);
  const p = w.byId.get('p0');
  place(w, 'p0', [[10, 3], [9, 3], [8, 3]], RIGHT);
  w.step();
  ok(p.body[0].x === 11 && p.body[0].y === 3, 'moves one cell per step');
  ok(p.body.length === 3, 'length unchanged without food');
  // Every edge kills: driving off the board is death, never a wrap.
  const edgeCases = [
    ['right', [[19, 3], [18, 3], [17, 3]], RIGHT],
    ['left', [[0, 6], [1, 6], [2, 6]], LEFT],
    ['top', [[4, 0], [4, 1], [4, 2]], UP],
    ['bottom', [[7, 13], [7, 12], [7, 11]], DOWN],
  ];
  for (const [edge, cells, dir] of edgeCases) {
    const we = mkWorld(1);
    place(we, 'p0', cells, dir);
    const ev = we.step();
    const pe = we.byId.get('p0');
    const death = ev.find((e) => e.type === 'death');
    ok(!pe.alive && death && death.cause === 'edge', edge + ' edge kills instead of wrapping');
    ok(death && death.cells[0].x === cells[0][0] && death.cells[0].y === cells[0][1], edge + ' edge: the snake dies where it was, on the board');
    ok(death && death.cells.every((c) => c.x >= 0 && c.y >= 0 && c.x < 20 && c.y < 14), edge + ' edge: nothing is left off the board');
  }
  // Running along the edge (not into it) is safe.
  {
    const we = mkWorld(1);
    place(we, 'p0', [[5, 0], [4, 0], [3, 0]], RIGHT);
    we.step(); we.step();
    ok(we.byId.get('p0').alive, 'sliding along the top row is safe');
  }

  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  ok(!w.queueDir('p0', LEFT), 'instant reverse rejected');
  ok(!w.queueDir('p0', RIGHT), 'same direction is a no-op');
  ok(w.queueDir('p0', UP), 'turn accepted');
  ok(w.queueDir('p0', LEFT), 'quick second turn (up, then left) buffered');
  ok(!w.queueDir('p0', RIGHT), 'reverse of the BUFFERED heading rejected');
  w.step();
  ok(p.body[0].x === 5 && p.body[0].y === 4, 'first buffered turn applied (up)');
  w.step();
  ok(p.body[0].x === 4 && p.body[0].y === 4, 'second buffered turn applied (left)');
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  w.queueDir('p0', UP); w.queueDir('p0', LEFT); w.queueDir('p0', DOWN);
  ok(!w.queueDir('p0', RIGHT), 'queue capped at ' + SP.MAX_QUEUE);
}

// ---------------- Growth ----------------
section('Eating + growth');
{
  const w = mkWorld(1, { mode: 'solo' });
  w.appleTarget = 0;
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  w.food.set(w.idx(6, 5), { x: 6, y: 5, kind: 'apple' });
  const ev = w.step();
  const p = w.byId.get('p0');
  ok(ev.some((e) => e.type === 'eat' && e.kind === 'apple' && e.id === 'p0'), 'eat event');
  ok(p.apples === 1, 'apple counted');
  ok(p.body.length === 3, 'grows on the NEXT move (tail held)');
  w.step();
  ok(p.body.length === 4, 'length 4 after one apple');
  w.step();
  ok(p.body.length === 4, 'stops growing after one segment');
  const w2 = mkWorld(1, { mode: 'solo' });
  place(w2, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  w2.food.set(w2.idx(6, 5), { x: 6, y: 5, kind: 'apple' });
  w2.step();
  ok(w2.appleCount() === 1, 'solo: eaten apple is replaced');
}

// ---------------- Collisions ----------------
section('Collisions');
{
  const w = mkWorld(1, { walls: [[6, 5]] });
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  const ev = w.step();
  const p = w.byId.get('p0');
  ok(!p.alive && p.deathCause === 'wall', 'wall kills');
  const d = ev.find((e) => e.type === 'death');
  ok(d && d.cells.length === 3 && d.cells[0].x === 5, 'death event carries the pre-move body');
  ok(p.finalLength === 3, 'final length kept');
}
{
  const w = mkWorld(1);
  // A U-shape whose head turns into its own neck region.
  place(w, 'p0', [[5, 5], [5, 6], [6, 6], [7, 6], [7, 5], [7, 4], [6, 4]], UP);
  w.queueDir('p0', RIGHT); // head (5,5) → (6,5)? free. Then down into (6,6) = body.
  w.step();
  w.queueDir('p0', DOWN);
  w.step();
  ok(!w.byId.get('p0').alive && w.byId.get('p0').deathCause === 'self', 'running into yourself kills');
}
{
  const w = mkWorld(1);
  // Head chases its own tail around a 2×2 loop: the tail moves away → safe.
  place(w, 'p0', [[5, 5], [5, 6], [6, 6], [6, 5]], LEFT);
  w.byId.get('p0').dir = UP;
  w.byId.get('p0').queue = [RIGHT];
  w.step();
  ok(w.byId.get('p0').alive, 'moving into your own moving tail is safe');
}
{
  const w = mkWorld(2);
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  place(w, 'p1', [[6, 7], [6, 6], [6, 5], [6, 4]], DOWN);
  w.step();
  const a = w.byId.get('p0'), b = w.byId.get('p1');
  ok(!a.alive && a.deathCause === 'snake' && a.killer === 'p1', 'hitting another body kills, killer recorded');
  ok(b.alive, 'the snake that was hit survives');
  // It leaves exactly one special apple, on its tail (multi).
  let specials = 0, other = 0; w.food.forEach((f) => { if (f.kind === 'special') specials++; else other++; });
  ok(specials === 1 && other === 0, 'a dead snake leaves exactly one special apple and nothing else');
  const sp = w.food.get(w.idx(3, 5));
  ok(sp && sp.kind === 'special', 'the special apple sits on the tail');
  ok(sp && sp.value === SP.SPECIAL_VALUE && SP.SPECIAL_VALUE === 5, 'the special apple is worth 5');
  ok(a.body.length === 0, 'dead snake no longer occupies the board');
  // Eating it grows the eater by 5.
  place(w, 'p1', [[2, 5], [1, 5], [0, 5]], RIGHT);
  w.byId.get('p1').grow = 0;
  const evs = w.step();
  const eat = evs.find((e) => e.type === 'eat');
  ok(eat && eat.kind === 'special' && eat.value === 5, 'eating it reports a special +5');
  for (let i = 0; i < 6; i++) w.step();
  ok(w.byId.get('p1').body.length === 3 + 5, 'eating it adds 5 length (got ' + w.byId.get('p1').body.length + ')');
  ok(!w.food.has(w.idx(3, 5)), 'the special apple is consumed');
}
{
  const w = mkWorld(2);
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  place(w, 'p1', [[7, 5], [8, 5], [9, 5]], LEFT);
  w.step();
  ok(!w.byId.get('p0').alive && !w.byId.get('p1').alive, 'head-on (same cell) kills both');
  ok(w.byId.get('p0').deathCause === 'headon', 'cause = headon');
}
{
  const w = mkWorld(2);
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  place(w, 'p1', [[6, 5], [7, 5], [8, 5]], LEFT);
  w.step();
  ok(!w.byId.get('p0').alive && !w.byId.get('p1').alive, 'head swap (passing through each other) kills both');
}
{
  const w = mkWorld(2);
  // p0 follows p1's moving tail — safe.
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  place(w, 'p1', [[6, 3], [6, 4], [6, 5]], UP);
  w.step();
  ok(w.byId.get('p0').alive && w.byId.get('p1').alive, 'entering a cell another tail just left is safe');
  // …but not if that snake is growing (tail stays put).
  const w2 = mkWorld(2);
  place(w2, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  place(w2, 'p1', [[6, 3], [6, 4], [6, 5]], UP);
  w2.byId.get('p1').grow = 1;
  w2.step();
  ok(!w2.byId.get('p0').alive, 'a growing tail stays solid');
}
{
  const w = mkWorld(1, { mode: 'solo', walls: [[6, 5]] });
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  w.step();
  let specials = 0; w.food.forEach((f) => { if (f.kind === 'special') specials++; });
  ok(specials === 0, 'solo: no special apple on death');
}

{
  // The tail cell is taken (another snake moved onto it): fall back toward the head.
  const w = mkWorld(2);
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  place(w, 'p1', [[6, 7], [6, 6], [6, 5], [6, 4]], DOWN);
  w.food.set(w.idx(3, 5), { x: 3, y: 5, kind: 'apple' });
  w.step();
  const fb = w.food.get(w.idx(4, 5));
  ok(fb && fb.kind === 'special', 'tail already holds food → the special apple moves one cell toward the head');
}
{
  // Two snakes dying together each leave their own special apple.
  const w = mkWorld(2);
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  place(w, 'p1', [[7, 5], [8, 5], [9, 5]], LEFT);
  const evs = w.step();
  let n = 0; w.food.forEach((f) => { if (f.kind === 'special') n++; });
  ok(n === 2, 'a head-on leaves two special apples');
  ok(w.food.get(w.idx(3, 5)).kind === 'special' && w.food.get(w.idx(9, 5)).kind === 'special', 'one on each tail');
  ok(evs.filter((e) => e.type === 'death').every((e) => e.special), 'death events say where the special apple landed');
}

// ---------------- Waiting start ----------------
section('Waiting start');
{
  const w = new SP.World({ maps: Maps });
  w.setRoster([{ id: 'h', name: 'H', seat: 0, color: '#fff' }, { id: 'c', name: 'C', seat: 1, color: '#fff', isBot: true }]);
  w.reset(0, { mode: 'multi' });
  const h = w.byId.get('h'), c = w.byId.get('c');
  ok(h.waiting && !c.waiting, 'humans start waiting, CPUs start moving');
  ok(w.anyWaiting(), 'anyWaiting() reports it');
  const before = JSON.stringify(h.body), cBefore = JSON.stringify(c.body);
  for (let i = 0; i < 5; i++) w.step();
  ok(JSON.stringify(h.body) === before && h.alive, 'a waiting snake holds still (and stays alive)');
  ok(JSON.stringify(c.body) !== cBefore, 'CPUs move meanwhile');
  ok(!w.queueDir('h', SP.REVERSE[h.dir]), 'reversing into your own neck does not release');
  ok(h.waiting, 'still waiting after the reverse');
  ok(w.queueDir('h', h.dir), 'pushing straight ahead releases');
  ok(!h.waiting, 'released');
  w.step();
  ok(JSON.stringify(h.body) !== before, 'released snake moves straight on');
  const w2 = new SP.World({ maps: Maps });
  w2.setRoster(roster(2));
  w2.reset(0, { mode: 'multi' });
  const a = w2.byId.get('p0');
  const turn = a.dir === UP || a.dir === DOWN ? LEFT : UP;
  w2.queueDir('p0', turn);
  w2.step();
  ok(a.dir === turn, 'a turn as the first input releases AND turns');
  ok(w2.byId.get('p1').waiting, 'other players keep waiting');
  ok(JSON.stringify(w2.releaseWaiting()) === '["p1"]' && !w2.anyWaiting(), 'releaseWaiting() starts everyone left (the time limit)');
}
{
  // Another snake running into a waiting snake's tail dies — the whole body is solid.
  const w = mkWorld(2);
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  place(w, 'p1', [[8, 7], [8, 6], [8, 5]], DOWN);
  w.byId.get('p1').waiting = true;
  place(w, 'p0', [[7, 5], [6, 5], [5, 5]], RIGHT);
  w.step();
  ok(!w.byId.get('p0').alive && w.byId.get('p0').killer === 'p1', 'hitting a waiting snake kills you');
  ok(w.byId.get('p1').alive, 'the waiting snake survives');
}

// ---------------- Phantom ----------------
section('Phantom');
{
  // 1.2× speed: 6 cells in the time a normal snake moves 5.
  const w = mkWorld(2);
  place(w, 'p0', [[2, 3], [1, 3], [0, 3]], RIGHT);
  place(w, 'p1', [[2, 9], [1, 9], [0, 9]], RIGHT);
  w.startPhantom('p0');
  for (let i = 0; i < 5; i++) w.step();
  ok(w.byId.get('p0').body[0].x === 8, 'phantom covers 6 cells in 5 moves (x=' + w.byId.get('p0').body[0].x + ')');
  ok(w.byId.get('p1').body[0].x === 7, 'normal snake covers 5');
}
{
  // Passes through walls and other snakes; others pass through it; edges kill.
  const w = mkWorld(2, { walls: [[6, 5], [7, 5]] });
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  place(w, 'p1', [[9, 7], [9, 6], [9, 5], [9, 4]], DOWN);
  w.startPhantom('p0');
  for (let i = 0; i < 4; i++) w.step();
  const a = w.byId.get('p0'), b = w.byId.get('p1');
  ok(a.alive && b.alive, 'phantom passes through a wall and another snake; nobody dies');
  const w2 = mkWorld(2);
  place(w2, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  place(w2, 'p1', [[6, 3], [6, 2], [6, 1]], DOWN);
  w2.startPhantom('p0');
  w2.byId.get('p0').cd = 99;            // hold the phantom still
  w2.step(); w2.step();
  ok(w2.byId.get('p1').alive, 'another snake passes through a phantom body');
  const w3 = mkWorld(2);
  place(w3, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  place(w3, 'p1', [[7, 5], [8, 5], [9, 5]], LEFT);
  w3.startPhantom('p0');
  w3.byId.get('p0').cd = SP.SUB; w3.byId.get('p0').period = SP.SUB;   // same pace → true head-on
  w3.step();
  ok(w3.byId.get('p0').alive && w3.byId.get('p1').alive, 'head-on with a phantom: both survive');
  const w4 = mkWorld(1);
  place(w4, 'p0', [[18, 5], [17, 5], [16, 5]], RIGHT);
  w4.startPhantom('p0');
  for (let i = 0; i < 3; i++) w4.step();
  ok(!w4.byId.get('p0').alive && w4.byId.get('p0').deathCause === 'edge', 'edges still kill a phantom');
  const w5 = mkWorld(1);
  place(w5, 'p0', [[5, 5], [5, 6], [6, 6], [6, 5], [7, 5], [7, 4], [6, 4], [5, 4]], UP);
  w5.startPhantom('p0');
  w5.queueDir('p0', RIGHT);
  w5.step(); w5.step();
  ok(w5.byId.get('p0').alive, 'phantom passes through its own body');
}
{
  // Ends inside a wall: speed drops, stays ghosted until the head is clear.
  const walls = [];
  for (let x = 6; x <= 9; x++) walls.push([x, 5]);
  const w = mkWorld(1, { walls });
  place(w, 'p0', [[7, 5], [6, 5], [5, 5]], RIGHT);
  const p = w.byId.get('p0');
  w.startPhantom('p0');
  w.endPhantom('p0');
  ok(p.phantom === 'ending' && p.period === SP.SUB, 'timer ends inside a wall: normal speed, still ghosted');
  let solid = false;
  for (let i = 0; i < 4 && p.alive; i++) { for (const e of w.step()) if (e.type === 'solid') solid = true; }
  ok(p.alive && p.phantom === null && solid, 'turns solid once the head is in an open cell (and survives)');
  ok(p.body.some((c) => w.board.wall[c.y * w.board.w + c.x]), 'its trailing body can still lie across the wall');
  w.step(); w.step(); w.step();
  ok(p.alive, 'a body left inside a wall is harmless (only heads crash)');
  const w2 = mkWorld(1, { walls });
  place(w2, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  w2.startPhantom('p0');
  w2.endPhantom('p0');
  ok(w2.byId.get('p0').phantom === null, 'ending in an open cell turns solid at once');
  const w3 = mkWorld(1, { walls });
  place(w3, 'p0', [[7, 5], [6, 5], [5, 5]], RIGHT);
  w3.startPhantom('p0'); w3.endPhantom('p0'); w3.forceSolid('p0');
  w3.step();
  ok(!w3.byId.get('p0').alive && w3.byId.get('p0').deathCause === 'wall', 'after the grace runs out a head still inside a wall crashes on its next move');
}
{
  // Once solid, its leftover body blocks others again.
  const w2 = mkWorld(2);
  place(w2, 'p0', [[8, 6], [8, 5], [8, 4], [8, 3]], DOWN);
  place(w2, 'p1', [[6, 5], [5, 5], [4, 5]], RIGHT);
  w2.byId.get('p0').cd = 99;
  w2.step(); w2.step();
  ok(!w2.byId.get('p1').alive && w2.byId.get('p1').killer === 'p0', 'a solid (post-Phantom) body kills a head that hits it');
}

// ---------------- Magnet ----------------
section('Magnet');
{
  const w = mkWorld(1);
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], UP);
  w.setMagnet('p0', true);
  const apple = { x: 8, y: 5, kind: 'apple' };
  w.food.set(w.idx(8, 5), apple);
  w.step();
  ok(apple.x === 6 && apple.y === 5, 'pulls an apple ' + SP.MAGNET_STEPS + ' cells toward the head per move (at ' + apple.x + ',' + apple.y + ')');
  const far = mkWorld(1);
  place(far, 'p0', [[5, 5], [4, 5], [3, 5]], UP);
  far.setMagnet('p0', true);
  const f2 = { x: 10, y: 5, kind: 'apple' };
  far.food.set(far.idx(10, 5), f2);
  far.step();
  ok(f2.x === 10, 'out of range (more than 3 cells): not pulled');
}
{
  const w = mkWorld(1);
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], UP);
  w.setMagnet('p0', true);
  w.food.set(w.idx(5, 3), { x: 5, y: 3, kind: 'special', value: SP.SPECIAL_VALUE });
  const evs = w.step();
  ok(evs.some((e) => e.type === 'eat' && e.kind === 'special') && w.byId.get('p0').specials === 1, 'pulls the golden apple too — straight into the head eats it');
  ok(w.byId.get('p0').grow === SP.SPECIAL_VALUE, 'and it grows by its value');
}
{
  const w = mkWorld(1, { walls: [[7, 5]] });
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], UP);
  w.setMagnet('p0', true);
  const apple = { x: 8, y: 5, kind: 'apple' };
  w.food.set(w.idx(8, 5), apple);
  w.step();
  ok(!(apple.x === 7 && apple.y === 5) && !w.board.wall[apple.y * w.board.w + apple.x], 'never pulls food into a wall');
  const w2 = mkWorld(1);
  place(w2, 'p0', [[5, 5], [4, 5], [3, 5]], UP);
  w2.setMagnet('p0', true);
  w2.food.set(w2.idx(7, 5), { x: 7, y: 5, kind: 'power', power: 'phantom' });
  w2.step();
  ok(w2.food.get(w2.idx(7, 5)) && w2.food.get(w2.idx(7, 5)).kind === 'power', 'power-ups are never pulled');
}
{
  // Two magnets equally close: the apple stays put.
  const w = mkWorld(2);
  place(w, 'p0', [[5, 5], [5, 6], [5, 7]], UP);
  place(w, 'p1', [[9, 5], [9, 6], [9, 7]], UP);
  w.setMagnet('p0', true); w.setMagnet('p1', true);
  const apple = { x: 7, y: 2, kind: 'apple' };
  w.food.set(w.idx(7, 2), apple);
  w.step();
  ok(apple.x === 7, 'tie between two magnets: no pull');
}
{
  // Every apple in range gets pulled in — beside, behind, across the body.
  const open = { build() { const W = 30, H = 18; return { name: 'T', w: W, h: H, wall: new Uint8Array(W * H), spawns: [{ x: 5, y: 5, dir: RIGHT }] }; } };
  const cases = [['ahead, on the line', [13, 5]], ['ahead, off to the side', [12, 7]], ['beside the head', [10, 8]],
    ['just behind, beside the body', [8, 7]], ['behind, across the body', [7, 3]], ['behind, moving away', [7, 7]], ['diagonal corner', [13, 8]]];
  for (const [label, at] of cases) {
    const w = new SP.World({ maps: open });
    w.setRoster([{ id: 'a', name: 'A', seat: 0, color: '#fff' }]);
    w.reset(0, { mode: 'multi' });
    w.food.clear(); w.appleTarget = 0;
    const p = w.byId.get('a');
    p.waiting = false;
    p.body = [[10, 5], [9, 5], [8, 5], [7, 5], [6, 5], [5, 5]].map(([x, y]) => ({ x, y }));
    p.prevBody = p.body.map((c) => ({ x: c.x, y: c.y })); p.dir = RIGHT;
    w.setMagnet('a', true);
    w.food.set(w.idx(at[0], at[1]), { x: at[0], y: at[1], kind: 'apple' });
    let moves = 0, ate = false;
    while (moves < 4 && !ate) { for (const e of w.step()) if (e.type === 'eat') ate = true; moves++; }
    ok(ate && p.apples === 1, 'magnet pulls in an apple ' + label + ' (' + moves + ' moves)');
  }
}
{
  // Another snake's body still blocks the pull; walls too.
  const w = mkWorld(2);
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  place(w, 'p1', [[8, 9], [8, 8], [8, 7], [8, 6], [8, 5], [8, 4], [8, 3]], DOWN);
  w.byId.get('p1').cd = 99;
  w.setMagnet('p0', true);
  const apple = { x: 9, y: 5, kind: 'apple' };
  w.food.set(w.idx(9, 5), apple);
  w.appleTarget = 0;
  w.step();
  ok(apple.x === 9, 'another snake standing between blocks the pull');
}

// ---------------- Power-up pickups + golden apple placement ----------------
section('Pickups');
{
  const w = mkWorld(1);
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  w.food.set(w.idx(6, 5), { x: 6, y: 5, kind: 'power', power: 'magnet' });
  const evs = w.step();
  ok(evs.some((e) => e.type === 'power' && e.power === 'magnet' && e.id === 'p0'), 'picking up a power-up fires a power event');
  ok(w.byId.get('p0').grow === 0, 'a power-up does not grow you');
  const w2 = new SP.World({ maps: Maps });
  w2.setRoster(roster(3));
  w2.reset(1, { mode: 'multi' });
  const item = w2.spawnPower('phantom');
  ok(item && !w2.board.wall[item.y * w2.board.w + item.x] && w2.powerCount() === 1, 'spawnPower lands on an open cell');
}
{
  // A snake that dies with its whole body inside walls still leaves a golden apple on open ground.
  const walls = [];
  for (let x = 4; x <= 9; x++) walls.push([x, 5]);
  const w = mkWorld(2, { walls });
  place(w, 'p0', [[8, 5], [7, 5], [6, 5], [5, 5]], RIGHT);
  w.startPhantom('p0');
  place(w, 'p1', [[2, 10], [1, 10], [0, 10]], RIGHT);
  const p = w.byId.get('p0');
  p.phantom = null; p.period = SP.SUB; p.cd = SP.SUB;
  const evs = w.step();
  const d = evs.find((e) => e.type === 'death' && e.id === 'p0');
  ok(d && d.special, 'golden apple placed even though every body cell is a wall');
  ok(d && !w.board.wall[d.special.y * w.board.w + d.special.x], 'and never in a wall (' + (d && JSON.stringify(d.special)) + ')');
}

// ---------------- Bots ----------------
section('Bots');
{
  const saved = Object.assign({}, Bot.SKILL);
  Object.assign(Bot.SKILL, { lazy: 0, blunder: 0, headonCare: 1, lookahead: 1, foodSight: 999, turnGap: 0 , slip: 0 });
  const w = mkWorld(1);
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  w.food.set(w.idx(5, 9), { x: 5, y: 9, kind: 'apple' });
  ok(Bot.think(w, w.byId.get('p0')) === DOWN, 'bot heads for the nearest food');
  const w2 = mkWorld(1, { walls: [[6, 5], [5, 4]] });
  place(w2, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  ok(Bot.think(w2, w2.byId.get('p0')) === DOWN, 'bot avoids walls (only DOWN is open)');
  Object.assign(Bot.SKILL, saved);
}
{
  // Even at full laziness a bot never drives straight into a wall.
  const saved = Object.assign({}, Bot.SKILL);
  Object.assign(Bot.SKILL, { lazy: 1, blunder: 1 , slip: 0 });
  let safe = true;
  for (let i = 0; i < 50; i++) {
    const w = mkWorld(1, { walls: [[6, 5], [5, 4]] });
    place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
    if (Bot.think(w, w.byId.get('p0')) !== DOWN) safe = false;
  }
  ok(safe, 'lazy/blundering bots still never pick a blocked cell');
  Object.assign(Bot.SKILL, saved);
}
{
  // No sharp turns: right after a turn the bot keeps going straight (even past
  // food) for turnGap cells, but always dodges a crash right in front of it.
  const saved = Object.assign({}, Bot.SKILL);
  Object.assign(Bot.SKILL, { lazy: 0, blunder: 0, headonCare: 1, lookahead: 1, foodSight: 999, turnGap: 3, reflex: 0 , slip: 0 });
  const w = mkWorld(1);
  place(w, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  const p = w.byId.get('p0');
  p.botLastDir = UP; // it has just turned onto RIGHT
  w.food.set(w.idx(5, 9), { x: 5, y: 9, kind: 'apple' });
  ok(Bot.think(w, p) === RIGHT, 'just turned: ignores the food below and keeps going straight');
  const w2 = mkWorld(1, { walls: [[6, 5]] });
  place(w2, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  const p2 = w2.byId.get('p0');
  p2.botLastDir = UP;
  ok(Bot.think(w2, p2) !== RIGHT, 'just turned: still dodges a wall right in front');
  const w3 = mkWorld(1);
  place(w3, 'p0', [[5, 5], [4, 5], [3, 5]], RIGHT);
  const p3 = w3.byId.get('p0');
  p3.botLastDir = RIGHT; p3.botStraight = 5;
  w3.food.set(w3.idx(5, 9), { x: 5, y: 9, kind: 'apple' });
  ok(Bot.think(w3, p3) === DOWN, 'after going straight long enough it turns for food again');
  Object.assign(Bot.SKILL, saved);
}
{
  // An apple just off its line right after a turn: the bot can't turn sharply,
  // but it plans a route it can actually drive and gets it — no endless circling.
  const saved = Object.assign({}, Bot.SKILL);
  Object.assign(Bot.SKILL, { lazy: 0, blunder: 0, headonCare: 1, lookahead: 1, foodSight: 999, turnGap: 3, reflex: 0 , slip: 0 });
  let worst = 0;
  for (const [ax, ay] of [[9, 7], [9, 5], [10, 7], [8, 8]]) {
    const w = mkWorld(1);
    place(w, 'p0', [[8, 6], [7, 6], [6, 6]], RIGHT);
    const p = w.byId.get('p0');
    p.botLastDir = UP;                  // it has just turned onto RIGHT
    w.appleTarget = 0;
    w.food.set(w.idx(ax, ay), { x: ax, y: ay, kind: 'apple' });
    let moves = 0, ate = false;
    while (moves < 60 && p.alive && !ate) {
      if (w.willMove(p)) { w.setBotDir('p0', Bot.think(w, p)); moves++; }
      for (const e of w.substep()) if (e.type === 'eat') ate = true;
    }
    ok(ate, 'reaches the apple at (' + ax + ',' + ay + ') without circling (' + moves + ' moves)');
    worst = Math.max(worst, moves);
  }
  ok(worst <= 24, 'every one within 24 moves (worst ' + worst + ')');
  Object.assign(Bot.SKILL, saved);
}
const simTicks = [];
for (let seed = 1; seed <= 12; seed++) {
  const rng = seeded(seed);
  const w = new SP.World({ maps: Maps, rng });
  w.setRoster(roster(4));
  w.reset(seed % Maps.count, { mode: 'multi' });
  w.releaseWaiting();
  let nan = false, ticks = 0, overlap = false;
  while (w.aliveCount() > 1 && ticks < 4000) {
    for (const p of w.players) if (p.alive) w.setBotDir(p.id, Bot.think(w, p));
    w.step(); ticks++;
    const cells = new Set();
    for (const p of w.players) {
      if (!p.alive) continue;
      for (const c of p.body) {
        if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || c.x < 0 || c.x >= w.board.w || c.y < 0 || c.y >= w.board.h) nan = true;
        const k = c.y * w.board.w + c.x;
        if (cells.has(k) || w.board.wall[k]) overlap = true;
        cells.add(k);
      }
    }
  }
  ok(!nan, 'seed ' + seed + ': all cells finite + on-board');
  ok(!overlap, 'seed ' + seed + ': no living snakes overlap or sit in walls');
  simTicks.push(ticks);
  const longest = Math.max.apply(null, w.players.map((p) => p.maxLen));
  ok(longest > SP.START_LEN, 'seed ' + seed + ': bots eat (max len ' + longest + ')');
}

{
  // CPUs slip up now and then, so one game can end early — but on average
  // they should last a good while (a broken bot dies almost at once).
  const avg = simTicks.reduce((a, b) => a + b, 0) / simTicks.length;
  ok(simTicks.length === 12 && avg > 150, 'bots survive a while on average (' + Math.round(avg) + ' ticks; min ' + Math.min.apply(null, simTicks) + ')');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
