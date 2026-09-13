'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { Field } = require('tetris-fumen');
const { Board } = require('../public/stackingroyale/js/engine');
const { BOT_SETTINGS, planMoves } = require('../server/stackingroyale/bot');

let checks = 0;
function test(name, run) {
  run();
  checks += 1;
  console.log(`  PASS ${name}`);
}

function fixture(active, filled = [], changes = {}) {
  const field = Field.create();
  for (const [column, row] of filled) field.set(column, row, 'X');
  return Board.from({ ...new Board(42).snapshot(),
    field: field.str({ reduced: false, garbage: false, separator: '' }), active, ...changes });
}

function randomSource(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function well(rows, hole = 1) {
  const filled = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < 10; column += 1) {
      if (column !== hole) filled.push([column, row]);
    }
  }
  return filled;
}

function holeCount(board) {
  const field = Field.create(board.snapshot().field);
  let holes = 0;
  for (let column = 0; column < 10; column += 1) {
    let occupied = false;
    for (let row = 22; row >= 0; row -= 1) {
      if (field.at(column, row) !== '_') occupied = true;
      else if (occupied) holes += 1;
    }
  }
  return holes;
}

function replay(board, moves) {
  assert.equal(moves.at(-1), 'drop');
  assert(moves.length <= 13);
  const start = board.snapshot();
  let locked;
  for (const [index, action] of moves.entries()) {
    assert(['left', 'right', 'rotateCW', 'rotateCCW', 'hold', 'drop'].includes(action));
    const before = board.snapshot();
    const events = board.action(action);
    if (action === 'drop') {
      assert.equal(index, moves.length - 1);
      locked = events.find(event => event.type === 'lock');
      assert(locked);
    } else {
      assert(!board.over);
      assert.equal(board.snapshot().locks, start.locks);
      assert.notDeepEqual(board.snapshot(), before);
    }
  }
  assert.equal(board.snapshot().locks, start.locks + 1);
  return locked;
}

test('all difficulties return legal bounded plans without changing the board', () => {
  for (const difficulty of Object.keys(BOT_SETTINGS)) {
    const board = new Board(123);
    const before = board.snapshot();
    const moves = planMoves(board, difficulty, () => 0.9);
    assert.deepEqual(board.snapshot(), before);
    assert.deepEqual(planMoves(board, difficulty, () => 0.9), moves);
    replay(Board.from(before), moves);
  }
});

test('planning works with deeply frozen live engine state', () => {
  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  }
  const board = new Board(123);
  board.enqueueGarbage(4, 2, 0, 'opponent');
  freeze(board);
  for (const difficulty of Object.keys(BOT_SETTINGS)) {
    const before = board.snapshot();
    replay(Board.from(before), planMoves(board, difficulty, () => 0.9));
    assert.deepEqual(board.snapshot(), before);
  }
});

test('all difficulties find a reachable four-line clear', () => {
  for (const difficulty of Object.keys(BOT_SETTINGS)) {
    const board = fixture({ type: 'I', rotation: 'spawn', x: 4, y: 20 }, well(4));
    assert.equal(replay(board, planMoves(board, difficulty, () => 0.9)).lines, 4);
  }
});

test('pacing is immutable and ordered; unknown difficulties are rejected', () => {
  assert.deepEqual(BOT_SETTINGS, {
    novice: { thinkMs: 1500, actionMs: 260 },
    easy: { thinkMs: 650, actionMs: 160 },
    medium: { thinkMs: 280, actionMs: 85 },
    hard: { thinkMs: 110, actionMs: 40 },
  });
  assert(Object.isFrozen(BOT_SETTINGS));
  for (const settings of Object.values(BOT_SETTINGS)) assert(Object.isFrozen(settings));
  for (const difficulty of [undefined, null, 'expert', 'toString', '__proto__']) {
    assert.throws(() => planMoves(new Board(1), difficulty), RangeError);
  }
});

test('easy occasionally chooses a lower ranked top candidate using only injected randomness', () => {
  const board = new Board(123);
  const best = planMoves(board, 'easy', () => 0.9);
  for (const sample of [0, 0.5, 0.999999]) {
    let calls = 0;
    const moves = planMoves(board, 'easy', () => calls++ === 0 ? 0 : sample);
    assert.equal(calls, 2);
    assert.notDeepEqual(moves, best);
    replay(Board.from(board.snapshot()), moves);
  }
  for (const difficulty of ['medium', 'hard']) {
    planMoves(board, difficulty, () => assert.fail('Unexpected randomness'));
  }
});

test('novice makes more frequent and wider placement mistakes than easy', () => {
  const board = new Board(123);
  const best = planMoves(board, 'novice', () => 0.9);
  let calls = 0;
  const mistake = planMoves(board, 'novice', () => calls++ === 0 ? 0.5 : 0.999999);
  assert.equal(calls, 2);
  assert.notDeepEqual(mistake, best);
  assert.deepEqual(planMoves(board, 'easy', () => 0.5), best);
  calls = 0;
  assert.notDeepEqual(mistake, planMoves(board, 'easy', () => calls++ === 0 ? 0 : 0.999999));
  replay(Board.from(board.snapshot()), mistake);
  assert(BOT_SETTINGS.novice.thinkMs > BOT_SETTINGS.easy.thinkMs * 2);
  assert(BOT_SETTINGS.novice.actionMs > BOT_SETTINGS.easy.actionMs);
});

test('hidden bag and RNG do not affect plans, including hold with an empty slot', () => {
  for (const hold of [null, 'I']) {
    const source = fixture({ type: 'T', rotation: 'spawn', x: 4, y: 20 }, well(5), { hold });
    const before = source.snapshot();
    for (const difficulty of Object.keys(BOT_SETTINGS)) {
      const expected = planMoves(source, difficulty, randomSource(123));
      for (const changes of [{ rng: 0, bag: [] }, { rng: 0xffffffff, bag: ['Z', 'L', 'O'] }]) {
        const other = Board.from({ ...before, ...changes });
        assert.deepEqual(planMoves(other, difficulty, randomSource(123)), expected);
      }
      assert.deepEqual(source.snapshot(), before);
    }
  }
});

test('hard uses stored hold or visible next to clear; medium never holds; used hold is respected', () => {
  for (const hold of ['I', null]) {
    const board = fixture({ type: 'O', rotation: 'spawn', x: 4, y: 20 }, well(4),
      { hold, next: ['I', 'T', 'S', 'Z', 'L'] });
    const before = board.snapshot();
    const moves = planMoves(board, 'hard');
    assert.deepEqual(board.snapshot(), before);
    assert.equal(moves[0], 'hold');
    assert.equal(moves.filter(action => action === 'hold').length, 1);
    assert.equal(replay(board, moves).lines, 4);
    const medium = Board.from(before);
    assert(!planMoves(medium, 'medium').includes('hold'));
    const used = Board.from({ ...before, holdUsed: true });
    const usedMoves = planMoves(used, 'hard');
    assert(!usedMoves.includes('hold'));
    replay(used, usedMoves);
  }
});

test('survival heuristic avoids burying holes under a raised shelf', () => {
  const filled = [];
  for (let row = 0; row < 4; row += 1) {
    for (const column of [4, 5]) filled.push([column, row]);
  }
  for (const difficulty of Object.keys(BOT_SETTINGS)) {
    const board = fixture({ type: 'O', rotation: 'spawn', x: 4, y: 20 }, filled, { holdUsed: true });
    const careless = Board.from(board.snapshot());
    careless.action('left');
    careless.action('drop');
    assert(holeCount(careless) > 0);
    replay(board, planMoves(board, difficulty, () => 0.9));
    assert.equal(holeCount(board), 0);
  }
});

test('all types and orientations replay legally from low and wall-adjacent positions', () => {
  for (const type of ['I', 'O', 'T', 'S', 'Z', 'J', 'L']) {
    for (const rotation of ['spawn', 'right', 'reverse', 'left']) {
      for (const column of [2, 7]) {
        const board = fixture({ type, rotation, x: column, y: 3 }, [], { holdUsed: true });
        for (const difficulty of Object.keys(BOT_SETTINGS)) {
          const before = board.snapshot();
          replay(Board.from(before), planMoves(board, difficulty, () => 0.9));
          assert.deepEqual(board.snapshot(), before);
        }
      }
    }
  }
});

test('high stacks and ready garbage prefer clears and never alter pending packets', () => {
  for (const rows of [12, 16, 19]) {
    for (const difficulty of Object.keys(BOT_SETTINGS)) {
      const board = fixture({ type: 'I', rotation: 'spawn', x: 4, y: 20 }, well(rows), { holdUsed: true });
      board.enqueueGarbage(8, 7, 0, 'opponent');
      board.enqueueGarbage(3, 3, 500, 'other');
      const before = board.snapshot();
      const moves = planMoves(board, difficulty, () => 0.9);
      assert.deepEqual(board.snapshot(), before);
      assert.equal(replay(board, moves).lines, 4);
      assert.equal(board.over, false);
    }
  }
});

test('blocked hold and unavoidable topout still produce a legal drop; dead boards return no actions', () => {
  const board = fixture({ type: 'O', rotation: 'spawn', x: 0, y: 20 },
    well(20, 9).concat([[4, 20]]), { hold: 'T' });
  const held = Board.from(board.snapshot());
  held.action('hold');
  assert(held.over);
  for (const difficulty of Object.keys(BOT_SETTINGS)) {
    const copy = Board.from(board.snapshot());
    const moves = planMoves(copy, difficulty, () => 0.9);
    assert(!moves.includes('hold'));
    replay(copy, moves);
    assert(copy.over);
  }
  const dead = Board.from({ ...board.snapshot(), over: true, active: null });
  for (const difficulty of Object.keys(BOT_SETTINGS)) assert.deepEqual(planMoves(dead, difficulty), []);
});

test('irregular adversarial stacks with holes and due garbage have legal bounded plans', () => {
  const random = randomSource(7654);
  const types = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  for (let index = 0; index < 30; index += 1) {
    const filled = [];
    for (let column = 1; column < 10; column += 1) {
      const height = 8 + Math.floor(random() * 12);
      for (let row = 0; row < height; row += 1) {
        if (random() > 0.12) filled.push([column, row]);
      }
    }
    const board = fixture({ type: types[index % types.length], rotation: 'spawn', x: 4, y: 20 }, filled);
    board.enqueueGarbage(8, index % 10, 0, 'opponent');
    const before = board.snapshot();
    for (const difficulty of Object.keys(BOT_SETTINGS)) {
      const moves = planMoves(board, difficulty, randomSource(index));
      assert.deepEqual(board.snapshot(), before);
      replay(Board.from(before), moves);
    }
  }
});

test('engine action count is bounded independently of stack complexity', () => {
  const original = Board.prototype.action;
  let actions = 0;
  Board.prototype.action = function (name) {
    actions += 1;
    return original.call(this, name);
  };
  try {
    for (const rows of [0, 12, 19]) {
      for (const difficulty of Object.keys(BOT_SETTINGS)) {
        const board = fixture({ type: 'I', rotation: 'spawn', x: 4, y: 20 }, well(rows), { hold: 'T' });
        actions = 0;
        planMoves(board, difficulty, () => 0.9);
        assert(actions <= 800, `${difficulty}: ${actions} engine actions`);
      }
    }
  } finally {
    Board.prototype.action = original;
  }
});

const benchmarkBoards = [];
test('all difficulties play many seeded pieces with legal replay and no planner mutation', () => {
  const totals = {};
  for (const difficulty of Object.keys(BOT_SETTINGS)) {
    const results = [];
    totals[difficulty] = 0;
    for (const seed of [42, 123, 9876]) {
      const board = new Board(seed);
      const random = randomSource(seed);
      for (let piece = 0; piece < 160 && !board.over; piece += 1) {
        const before = board.snapshot();
        if (piece === 20) benchmarkBoards.push(Board.from(before));
        const moves = planMoves(board, difficulty, random);
        assert.deepEqual(board.snapshot(), before);
        replay(board, moves);
      }
      const result = board.snapshot();
      assert(result.locks >= (difficulty === 'novice' ? 20 : difficulty === 'easy' ? 60 : 160), `${difficulty} seed ${seed}: ${result.locks} locks`);
      assert(result.lines >= (difficulty === 'novice' ? 0 : difficulty === 'easy' ? 15 : 50), `${difficulty} seed ${seed}: ${result.lines} lines`);
      totals[difficulty] += result.lines;
      results.push(`${result.locks} pieces/${result.lines} lines`);
    }
    console.log(`    ${difficulty}: ${results.join(', ')}`);
  }
  assert(totals.hard > totals.medium);
  assert(totals.medium > totals.easy);
  assert(totals.novice < totals.easy / 2, 'Novice should clear substantially fewer lines than Easy across the seeded runs');
});

test('tick-delayed execution discards stale plans when gravity locks a piece', () => {
  for (const difficulty of Object.keys(BOT_SETTINGS)) {
    const board = new Board(42);
    const settings = BOT_SETTINGS[difficulty];
    let plans = 0;
    for (let turn = 0; turn < 60 && !board.over; turn += 1) {
      const locks = board.snapshot().locks;
      board.step(settings.thinkMs);
      if (board.over || board.snapshot().locks !== locks) continue;
      const moves = planMoves(board, difficulty, () => 0.9);
      plans += 1;
      for (const action of moves) {
        board.step(settings.actionMs);
        if (board.over || board.snapshot().locks !== locks) break;
        board.action(action);
      }
    }
    assert(plans >= 20);
    assert(board.snapshot().locks >= 20);
    const grounded = fixture({ type: 'O', rotation: 'spawn', x: 4, y: 0 }, [],
      { lockMs: 499, elapsedMs: 900000, lockResets: 15 });
    const locks = grounded.snapshot().locks;
    planMoves(grounded, difficulty, () => 0.9);
    grounded.step(settings.actionMs);
    assert.notEqual(grounded.snapshot().locks, locks);
  }
});

for (const rows of [12, 16, 19]) {
  const board = fixture({ type: 'I', rotation: 'spawn', x: 4, y: 20 }, well(rows), { hold: 'T' });
  board.enqueueGarbage(8, 7, 0, 'opponent');
  benchmarkBoards.push(board);
}
for (const difficulty of Object.keys(BOT_SETTINGS)) {
  for (const board of benchmarkBoards) planMoves(board, difficulty, () => 0.9);
  const timings = [];
  const batches = [];
  for (let batch = 0; batch < 5; batch += 1) {
    const batchStart = performance.now();
    for (let cpu = 0; cpu < 30; cpu += 1) {
      const board = benchmarkBoards[(batch * 30 + cpu) % benchmarkBoards.length];
      const start = performance.now();
      planMoves(board, difficulty, () => 0.9);
      timings.push(performance.now() - start);
    }
    batches.push(performance.now() - batchStart);
  }
  timings.sort((first, second) => first - second);
  console.log(`  BENCH ${difficulty}: median=${timings[75].toFixed(2)}ms p95=${timings[142].toFixed(2)}ms worst=${timings[149].toFixed(2)}ms; 30 CPUs mean=${(batches.reduce((sum, value) => sum + value, 0) / batches.length).toFixed(2)}ms worst=${Math.max(...batches).toFixed(2)}ms`);
}

console.log(`Stacking Royale bot: ${checks} checks passed`);