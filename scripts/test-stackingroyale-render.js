'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/stackingroyale/js/render.js'), 'utf8');
let checks = 0;

function test(name, run) {
  run();
  checks += 1;
  console.log(`  PASS ${name}`);
}

function harness(reduce = false) {
  let now = 0;
  let identifier = 0;
  const pending = new Map();
  const preference = { matches: reduce };
  const window = {
    matchMedia: () => preference,
    requestAnimationFrame: callback => { pending.set(++identifier, callback); return identifier; },
    cancelAnimationFrame: frame => pending.delete(frame),
  };
  vm.runInNewContext(source, { window, performance: { now: () => now } });
  function canvas() {
    const operations = [];
    const saved = [];
    const context = {
      globalAlpha: 1,
      fillStyle: '',
      fillRect(left, top, width, height) {
        operations.push({ left, top, width, height, color: this.fillStyle, alpha: this.globalAlpha });
      },
      save() { saved.push({ globalAlpha: this.globalAlpha, fillStyle: this.fillStyle }); },
      restore() { Object.assign(this, saved.pop()); },
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {}, rect() {}, clip() {},
    };
    return { width: 300, height: 600, isConnected: true, operations, getContext: () => context };
  }
  return {
    canvas, pending, preference, draw: window.SRRender.draw,
    advance(milliseconds) {
      now += milliseconds;
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach(callback => callback(now));
    },
  };
}

function view(lines = 0, locks = 0, clearRows = [], elapsedMs = 100) {
  return { grid: Array.from({ length: 20 }, () => Array(10).fill('_')), active: [], ghost: [], lines, locks, clearRows, elapsedMs };
}

function highlights(canvas) {
  return canvas.operations.filter(operation => operation.color === '#ffffff' && operation.width === 300 && operation.height === 30);
}

function particles(canvas) {
  return canvas.operations.filter(operation => ['#47c8d3', '#f1cb50', '#ef827d'].includes(operation.color) && operation.width < 10);
}

test('initial empty, restored and legacy boards stay quiet', () => {
  const renderer = harness();
  for (const initial of [view(), view(12, 7, [19, 18, 17, 16]), { grid: [] }]) {
    const canvas = renderer.canvas();
    renderer.draw(canvas, initial);
    assert.equal(highlights(canvas).length, 0);
    assert.equal(particles(canvas).length, 0);
  }
  assert.equal(renderer.pending.size, 0);
});

test('one clear paints exact row, moving sweep and outward rising colored particles', () => {
  const renderer = harness();
  const canvas = renderer.canvas();
  renderer.draw(canvas, view());
  renderer.draw(canvas, view(1, 1, [17]));
  assert.deepEqual(highlights(canvas).map(operation => operation.top), [510]);
  const start = particles(canvas);
  assert.equal(start.length, 8);
  assert.equal(new Set(start.map(operation => operation.color)).size, 3);
  assert.equal(renderer.pending.size, 1);
  canvas.operations.length = 0;
  renderer.advance(100);
  const moved = particles(canvas);
  assert(moved[0].left < start[0].left);
  assert(moved.at(-1).left > start.at(-1).left);
  assert(moved.every((operation, index) => operation.top < start[index].top));
  assert(canvas.operations.some(operation => operation.color === '#ffffff' && operation.width === 60 && operation.left === 12));
  assert.equal(canvas.getContext().globalAlpha, 1);
});

test('multi-line and separated rows are stronger; hidden rows are not shifted onto the board', () => {
  const renderer = harness();
  for (const rows of [[19], [19, 17], [19, 18, 17], [19, 18, 17, 16], [0, -1, -2, -3], [-1, -3]]) {
    const canvas = renderer.canvas();
    renderer.draw(canvas, view());
    renderer.draw(canvas, view(rows.length, 1, rows));
    const visible = rows.filter(row => row >= 0);
    assert.deepEqual(highlights(canvas).map(operation => operation.top), visible.map(row => row * 30));
    assert.equal(particles(canvas).length, visible.length * (6 + rows.length * 2));
    assert(highlights(canvas).every(operation => Math.abs(operation.alpha - (0.5 + rows.length / 4 * 0.22)) < 1e-9));
  }
  assert.equal(renderer.pending.size, 5);
  renderer.advance(500);
  assert.equal(renderer.pending.size, 0);
});

test('duplicates and rollback/reconciliation never replay or extend a burst', () => {
  const renderer = harness();
  const canvas = renderer.canvas();
  renderer.draw(canvas, view(2, 4, [19, 18]));
  renderer.draw(canvas, view(4, 5, [19, 17]));
  renderer.advance(200);
  for (const snapshot of [view(4, 5, [19, 17]), view(2, 4, [19, 18]), view(4, 5, [18, 16])]) {
    canvas.operations.length = 0;
    renderer.draw(canvas, snapshot);
    assert.deepEqual(highlights(canvas).map(operation => operation.top), [570, 510]);
    assert.equal(renderer.pending.size, 1);
  }
  canvas.operations.length = 0;
  renderer.advance(300);
  assert.equal(highlights(canvas).length, 0);
  assert.equal(renderer.pending.size, 0);
  renderer.draw(canvas, view(4, 5, [19, 17]));
  renderer.draw(canvas, view(5, 5, [18]));
  assert.equal(renderer.pending.size, 0);
  renderer.draw(canvas, view(6, 6, [16]));
  assert.deepEqual(highlights(canvas).map(operation => operation.top), [480]);
});

test('RAF repaints the latest board then erases the effect and stops without further draws', () => {
  const renderer = harness();
  const canvas = renderer.canvas();
  renderer.draw(canvas, view());
  renderer.draw(canvas, view(1, 1, [19]));
  const latest = view(1, 1, [19]);
  latest.active = [{ x: 3, y: 2, type: 'O' }];
  renderer.draw(canvas, latest);
  canvas.operations.length = 0;
  renderer.advance(499);
  assert(canvas.operations.some(operation => operation.color === '#f1cb50' && operation.left === 91 && operation.top === 61));
  assert(highlights(canvas)[0].alpha < 0.01);
  canvas.operations.length = 0;
  renderer.advance(1);
  assert.equal(highlights(canvas).length, 0);
  assert.equal(particles(canvas).length, 0);
  assert(canvas.operations.some(operation => operation.color === '#172422'));
  assert.equal(renderer.pending.size, 0);
});

test('reduced motion uses only a short static fading row highlight', () => {
  const renderer = harness(true);
  const canvas = renderer.canvas();
  renderer.draw(canvas, view());
  renderer.draw(canvas, view(4, 1, [19, 18, 17, 16]));
  const initial = highlights(canvas);
  assert.equal(initial.length, 4);
  assert.equal(particles(canvas).length, 0);
  assert.equal(canvas.operations.filter(operation => operation.width === 60).length, 0);
  canvas.operations.length = 0;
  renderer.advance(80);
  assert.deepEqual(highlights(canvas).map(operation => operation.top), initial.map(operation => operation.top));
  assert(highlights(canvas).every(operation => operation.alpha === 0.225));
  assert.equal(particles(canvas).length, 0);
  canvas.operations.length = 0;
  renderer.advance(80);
  assert.equal(highlights(canvas).length, 0);
  assert.equal(renderer.pending.size, 0);
});

test('zeroed new game and cleared canvas reset detection and cancel pending work', () => {
  const renderer = harness();
  const canvas = renderer.canvas();
  renderer.draw(canvas, view(20, 20));
  renderer.draw(canvas, view(21, 21, [19]));
  renderer.draw(canvas, view(0, 0, [], 0));
  assert.equal(renderer.pending.size, 0);
  canvas.operations.length = 0;
  renderer.draw(canvas, view(1, 1, [18]));
  assert.deepEqual(highlights(canvas).map(operation => operation.top), [540]);
  renderer.draw(canvas, null);
  assert.equal(renderer.pending.size, 0);
  canvas.operations.length = 0;
  renderer.draw(canvas, view(10, 10, [19]));
  assert.equal(highlights(canvas).length, 0);
});

test('30 boards have independent bounded bursts and a single scheduled frame each', () => {
  const renderer = harness();
  const canvases = Array.from({ length: 30 }, () => renderer.canvas());
  for (const canvas of canvases) {
    renderer.draw(canvas, view());
    for (let lock = 1; lock <= 10; lock += 1) {
      canvas.operations.length = 0;
      renderer.draw(canvas, view(lock * 4, lock, [19, 18, 17, 16]));
      assert(highlights(canvas).length <= 8);
      assert(particles(canvas).length <= 112);
    }
  }
  assert.equal(renderer.pending.size, 30);
  canvases[0].isConnected = false;
  renderer.advance(100);
  assert.equal(renderer.pending.size, 29);
  renderer.advance(400);
  assert.equal(renderer.pending.size, 0);
});

console.log(`Stacking Royale renderer: ${checks} groups passed`);