'use strict';

const assert = require('node:assert/strict');
const { Field, Mino } = require('tetris-fumen');

const field = Field.create();
const horizontal = new Mino('I', 'spawn', 4, 0);
assert.equal(field.canFill(horizontal), true);
assert.equal(field.canLock(horizontal), true);
assert.equal(field.canFill(new Mino('I', 'spawn', 0, 0)), false);
assert.equal(new Mino('T', 'right', 4, 5).positions().length, 4);
field.fill(horizontal);
assert.equal(field.canFill(horizontal), false);
const restored = Field.create(field.str({ reduced: false, garbage: false, separator: '' }));
assert.equal(restored.str(), field.str());
for (let column = 0; column < 10; column += 1) field.set(column, 0, 'X');
field.clearLine();
assert.equal(field.at(4, 0), '_');
console.log('Stacking Royale: board-library conformance passed');

const { Board } = require('../public/stackingroyale/js/engine');
const board = new Board(123);
assert.deepEqual(Board.from(board.snapshot()).snapshot(), board.snapshot());
assert.equal(board.view().grid.length, 20);
assert.equal(board.view().ghost.length, 4);
assert.equal(board.action('drop')[0].type, 'lock');
assert.equal(board.view().locks, 1);
assert.deepEqual(Board.from(board.snapshot()).snapshot(), board.snapshot());
console.log('Stacking Royale: initial engine drop/restore passed');

const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
const ORIENTATIONS = ['spawn', 'right', 'reverse', 'left'];
let checks = 0;

function test(name, run) {
	run();
	checks += 1;
	console.log(`  PASS ${name}`);
}

function fixture(operation, filled = [], changes = {}, source = new Board(42)) {
	const snapshot = source.snapshot();
	const field = Field.create();
	for (const [column, row, type = 'X'] of filled) field.set(column, row, type);
	return Board.from({ ...snapshot, field: field.str({ reduced: false, garbage: false, separator: '' }),
		active: operation, gravityMs: 0, lockMs: 0, lockResets: 0, lastRotation: null, ...changes });
}

function operation(type, x = 4, y = 10, rotation = 'spawn') {
	return { type, x, y, rotation };
}

function clearFixture(count, changes = {}, source) {
	const filled = [[9, 8]];
	for (let row = 0; row < count; row += 1) {
		for (let column = 0; column < 10; column += 1) {
			if (column !== 4) filled.push([column, row]);
		}
	}
	return fixture(operation('I', 4, 2, 'right'), filled, changes, source);
}

function lockEvent(board) {
	const events = board.action('drop');
	assert.equal(events[0].type, 'lock');
	return events[0];
}

test('view shape, visible coordinates, ghost and snapshot isolation', () => {
	for (const type of TYPES) {
		const board = fixture(operation(type, 4, 20));
		const view = board.view();
		assert.deepEqual(view.active, Mino.from(board.snapshot().active).positions()
			.map(cell => ({ x: cell.x, y: 19 - cell.y, type })));
		assert(view.active.some(cell => cell.y < 0));
		assert(view.ghost.every(cell => cell.x >= 0 && cell.x < 10 && cell.y >= 0 && cell.y < 20));
		assert(view.ghost.some(cell => cell.y === 19));
		assert(view.grid.every(row => row.length === 10 && row.every(cell => cell === '_')));
		const snapshot = board.snapshot();
		snapshot.active.x = -100;
		snapshot.next[0] = 'X';
		snapshot.bag.push('X');
		view.grid[0][0] = 'X';
		view.next[0] = 'X';
		assert.equal(board.snapshot().active.x, 4);
		assert(TYPES.includes(board.view().next[0]));
		assert.equal(board.view().grid[0][0], '_');
	}
});

test('seeded seven bags and serialized RNG across 140 pieces', () => {
	function sequence(seed) {
		let board = new Board(seed);
		const result = [];
		for (let index = 0; index < 140; index += 1) {
			result.push(board.snapshot().active.type);
			board.action('drop');
			const snapshot = board.snapshot();
			snapshot.field = '_'.repeat(230);
			board = Board.from(JSON.parse(JSON.stringify(snapshot)));
		}
		return result;
	}
	for (const seed of [0, 1, 42, 0xffffffff]) {
		const result = sequence(seed);
		assert.deepEqual(result, sequence(seed));
		for (let index = 0; index < result.length; index += 7) {
			assert.deepEqual(result.slice(index, index + 7).sort(), [...TYPES].sort());
		}
	}
	assert.notDeepEqual(sequence(1), sequence(2));
});

test('hold once per piece, held piece respawns and preview advances correctly', () => {
	const board = new Board(5);
	const start = board.snapshot();
	board.action('rotateCW');
	board.action('hold');
	assert.equal(board.view().hold, start.active.type);
	assert.equal(board.snapshot().active.type, start.next[0]);
	assert.equal(board.snapshot().active.rotation, 'spawn');
	const held = board.snapshot();
	assert.deepEqual(board.action('hold'), []);
	assert.deepEqual(board.snapshot(), held);
	board.action('drop');
	const beforeSwap = board.snapshot();
	board.action('hold');
	assert.equal(board.snapshot().active.type, start.active.type);
	assert.equal(board.snapshot().hold, beforeSwap.active.type);
	assert.deepEqual(board.snapshot().next, beforeSwap.next);
});

test('gravity, soft/hard drop, invalid inputs, and no unsolicited events', () => {
	const board = fixture(operation('T'));
	assert.deepEqual(board.step(799), []);
	assert.equal(board.snapshot().active.y, 10);
	board.step(1);
	assert.equal(board.snapshot().active.y, 9);
	board.action('soft');
	assert.equal(board.snapshot().active.y, 8);
	const landing = board.view().ghost;
	assert.equal(lockEvent(board).lines, 0);
	for (const cell of landing) assert.equal(board.view().grid[cell.y][cell.x], 'T');
	assert.deepEqual(board.step(1), []);
	const unchanged = board.snapshot();
	assert.deepEqual(board.action('invalid'), []);
	assert.deepEqual(board.snapshot(), unchanged);
	for (const value of [0, -1, NaN, Infinity, '16', null, undefined]) assert.throws(() => board.step(value), RangeError);
	for (const seed of [-1, 0x100000000, 1.1, NaN, '0']) assert.throws(() => new Board(seed), RangeError);
});

test('time-based gravity ramp, minimum speed and exact 30-second boundary', () => {
	const board = fixture(operation('T'), [], { elapsedMs: 29999 });
	board.step(1);
	assert.equal(board.view().level, 2);
	board.step(738);
	assert.equal(board.snapshot().active.y, 10);
	board.step(1);
	assert.equal(board.snapshot().active.y, 9);
	const fast = fixture(operation('T'), [], { elapsedMs: 900000 });
	fast.step(69);
	assert.equal(fast.snapshot().active.y, 10);
	fast.step(1);
	assert.equal(fast.snapshot().active.y, 9);
});

test('all normal clear attacks, combo bonuses, B2B and perfect clear', () => {
	for (let count = 1; count <= 4; count += 1) {
		const board = clearFixture(count);
		const event = lockEvent(board);
		assert.equal(event.lines, count);
		assert.equal(event.attack, [0, 0, 1, 2, 4][count]);
		assert.equal(event.perfectClear, false);
		assert.equal(event.spin, null);
		assert.equal(board.view().combo, 0);
	}
	let board = clearFixture(4);
	assert.equal(lockEvent(board).attack, 4);
	board = clearFixture(4, {}, board);
	assert.equal(lockEvent(board).attack, 5);
	board = clearFixture(4, {}, board);
	assert.equal(lockEvent(board).attack, 6);
	board = fixture(operation('O', 0, 0), [], {}, board);
	lockEvent(board);
	assert.equal(board.snapshot().b2b, true);
	assert.equal(board.view().combo, -1);
	board = clearFixture(4, {}, board);
	assert.equal(lockEvent(board).attack, 5);
	board = clearFixture(1, {}, board);
	lockEvent(board);
	assert.equal(board.snapshot().b2b, false);
	assert.equal(lockEvent(clearFixture(4, { combo: 100, b2b: true })).attack, 9);
	const perfect = clearFixture(4).snapshot();
	const field = Field.create(perfect.field);
	field.set(9, 8, '_');
	perfect.field = field.str({ reduced: false, garbage: false, separator: '' });
	const event = lockEvent(Board.from(perfect));
	assert.equal(event.attack, 14);
	assert.equal(event.perfectClear, true);
	assert.equal(event.label, 'Perfect Clear');
});

test('clear rows retain original screen coordinates, including separated and hidden rows', () => {
	for (let count = 1; count <= 4; count += 1) {
		const board = clearFixture(count);
		const rows = Array.from({ length: count }, (_, index) => 19 - index);
		assert.deepEqual(lockEvent(board).clearRows, rows);
		assert.deepEqual(board.view().clearRows, rows);
		assert.deepEqual(Board.from(board.snapshot()).snapshot(), board.snapshot());
	}
	for (const rows of [[0, 2], [19, 20, 21, 22]]) {
		const filled = rows[0] === 19 ? [[4, 18]] : [];
		for (const row of rows) {
			for (let column = 0; column < 10; column += 1) {
				if (column !== 4) filled.push([column, row]);
			}
		}
		const board = fixture(operation('I', 4, rows[0] === 19 ? 21 : 2, 'right'), filled);
		assert.deepEqual(lockEvent(board).clearRows, rows.map(row => 19 - row));
		assert.deepEqual(board.view().clearRows, rows.map(row => 19 - row));
		assert.deepEqual(Board.from(board.snapshot()).snapshot(), board.snapshot());
	}
});

test('clear metadata is optional, validated, isolated and replaced on every lock', () => {
	const board = clearFixture(2);
	const event = lockEvent(board);
	const snapshot = board.snapshot();
	const restored = Board.from(snapshot);
	event.clearRows[0] = 0;
	snapshot.clearRows[0] = 1;
	board.view().clearRows[0] = 2;
	assert.deepEqual(board.snapshot().clearRows, [19, 18]);
	assert.deepEqual(restored.view().clearRows, [19, 18]);
	board.step(1);
	assert.deepEqual(board.view().clearRows, [19, 18]);
	assert.deepEqual(lockEvent(board).clearRows, []);
	assert.deepEqual(board.view().clearRows, []);
	const legacy = restored.snapshot();
	delete legacy.clearRows;
	assert.deepEqual(Board.from(legacy).view().clearRows, []);
	assert.equal(Board.from(legacy).snapshot().version, 1);
	for (const clearRows of [null, '19', {}, [20], [-4], [1.5], [NaN], [1, 1], [0, 1, 2, 3, 4], Array(1)]) {
		assert.throws(() => Board.from({ ...legacy, clearRows }), TypeError);
	}
});

test('T-spin full/mini corners, last-kick upgrade, and rotation preservation', () => {
	const fullBlocks = [[3, 0], [4, 0], [5, 0], [3, 2], [5, 2]];
	const miniBlocks = [[3, 0], [5, 0], [3, 2]];
	assert.equal(lockEvent(fixture(operation('T', 4, 1), fullBlocks, { lastRotation: { kick: 0 } })).spin, 'full');
	assert.equal(lockEvent(fixture(operation('T', 4, 1), miniBlocks, { lastRotation: { kick: 0 } })).spin, 'mini');
	assert.equal(lockEvent(fixture(operation('T', 4, 1), miniBlocks, { lastRotation: { kick: 4 } })).spin, 'full');
	assert.equal(lockEvent(fixture(operation('T', 4, 1), [[3, 0], [5, 0]], { lastRotation: { kick: 4 } })).spin, null);
	assert.equal(lockEvent(fixture(operation('T', 4, 1), fullBlocks)).spin, null);
	for (const type of TYPES.filter(type => type !== 'T')) {
		assert.equal(lockEvent(fixture(operation(type), [], { lastRotation: { kick: 4 } })).spin, null);
	}
	const blocked = fixture(operation('T', 4, 1), fullBlocks, { lastRotation: { kick: 2 } });
	blocked.action('left');
	blocked.action('soft');
	blocked.action('rotateCW');
	assert.deepEqual(blocked.snapshot().lastRotation, { kick: 2 });
	assert.equal(lockEvent(blocked).spin, 'full');
	for (const action of ['left', 'right', 'soft']) {
		const board = fixture(operation('T'), [], { lastRotation: { kick: 1 } });
		board.action(action);
		assert.equal(board.snapshot().lastRotation, null);
	}
	const falling = fixture(operation('T'), [], { lastRotation: { kick: 1 } });
	falling.step(800);
	assert.equal(falling.snapshot().lastRotation, null);
	assert.equal(lockEvent(fixture(operation('T', 4, 5), miniBlocks, { lastRotation: { kick: 4 } })).spin, null);
});

test('T-spin single/double/triple and mini single/double attack tables', () => {
	const spinCases = [
		{ rotation: 'spawn', y: 1, rows: [1], extras: [[3, 0], [5, 0], [3, 2], [5, 2]], spin: 'full', attack: 2 },
		{ rotation: 'reverse', y: 1, rows: [0, 1], extras: [[3, 2]], spin: 'full', attack: 4 },
		{ rotation: 'right', y: 1, rows: [0, 1, 2], extras: [], spin: 'full', attack: 6 },
		{ rotation: 'spawn', y: 1, rows: [1], extras: [[3, 0], [5, 0], [3, 2]], spin: 'mini', attack: 0 },
		{ rotation: 'right', y: 1, rows: [0, 1], extras: [[3, 2]], spin: 'mini', attack: 1 },
	];
	for (const sample of spinCases) {
		const active = operation('T', 4, sample.y, sample.rotation);
		const positions = Mino.from(active).positions();
		const filled = [[9, 8], ...sample.extras];
		for (const row of sample.rows) {
			for (let column = 0; column < 10; column += 1) {
				if (!positions.some(cell => cell.x === column && cell.y === row)) filled.push([column, row]);
			}
		}
		const board = fixture(active, filled, { lastRotation: { kick: 0 } });
		const event = lockEvent(board);
		assert.equal(event.lines, sample.rows.length);
		assert.equal(event.spin, sample.spin);
		assert.equal(event.attack, sample.attack);
		assert.equal(board.snapshot().b2b, true);
		assert.equal(lockEvent(fixture(active, filled, { lastRotation: { kick: 0 }, b2b: true })).attack, sample.attack + 1);
	}
});

test('grounded lock delay, 15-reset cap and failed/no-op actions', () => {
	const board = fixture(operation('T', 4, 0));
	assert.deepEqual(board.step(499), []);
	for (let index = 0; index < 15; index += 1) {
		board.action(index % 2 ? 'left' : 'right');
		assert.equal(board.snapshot().lockMs, 0);
		assert.equal(board.snapshot().lockResets, index + 1);
		board.step(499);
	}
	board.action('left');
	assert.equal(board.snapshot().lockMs, 499);
	assert.equal(board.snapshot().lockResets, 15);
	assert.equal(board.step(1)[0].type, 'lock');
	const noOp = fixture(operation('O', 0, 0));
	noOp.step(499);
	for (let index = 0; index < 30; index += 1) {
		noOp.action('left');
		noOp.action('soft');
		noOp.action('rotateCW');
		noOp.action('rotateCCW');
	}
	assert.equal(noOp.snapshot().lockResets, 0);
	assert.equal(noOp.step(1)[0].type, 'lock');
	const rotating = fixture(operation('T', 4, 0));
	rotating.step(499);
	rotating.action('rotateCW');
	assert.equal(rotating.snapshot().lockResets, 1);
	assert.equal(rotating.snapshot().lockMs, 0);
});

test('garbage cancels oldest first including pending rows and sends only net attack', () => {
	const board = clearFixture(4);
	board.enqueueGarbage(2, 1, 1500, 'first');
	board.enqueueGarbage(5, 8, 0, 'second');
	assert.equal(lockEvent(board).attack, 0);
	assert.deepEqual(board.snapshot().garbage, [{ rows: 3, hole: 8, delayMs: 0, sender: 'second' }]);
	assert.equal(board.view().incoming, 3);
	const net = clearFixture(4);
	net.enqueueGarbage(1, 0);
	assert.equal(lockEvent(net).attack, 3);
	assert.equal(net.view().incoming, 0);
});

test('garbage freezes without step, never moves active, and inserts at most eight on nonclear', () => {
	const board = fixture(operation('O', 0, 10));
	const active = board.snapshot().active;
	board.enqueueGarbage(3, 4, 1500, 'later');
	board.enqueueGarbage(10, 8, 0, 'due');
	assert.deepEqual(board.snapshot().active, active);
	board.action('right');
	assert.equal(board.snapshot().garbage[0].delayMs, 1500);
	board.step(500);
	assert(Math.abs(board.snapshot().garbage[0].delayMs - 1000) < 1e-8);
	assert.equal(board.view().grid.flat().filter(cell => cell === 'X').length, 0);
	const landing = board.view().ghost;
	lockEvent(board);
	assert.equal(board.view().incoming, 5);
	assert.equal(board.snapshot().active.y, 20);
	for (const cell of landing) assert.equal(board.view().grid[cell.y - 8][cell.x], 'O');
	for (let row = 12; row < 20; row += 1) {
		assert.equal(board.view().grid[row].join(''), 'XXXXXXXX_X');
	}
	board.step(1000);
	lockEvent(board);
	assert.equal(board.view().incoming, 0);
	assert.equal(board.view().grid[19].join(''), 'XXXXXXXX_X');
	assert.equal(board.view().grid[17].join(''), 'XXXX_XXXXX');
	const clearing = clearFixture(1);
	clearing.enqueueGarbage(4, 2, 0);
	assert.equal(lockEvent(clearing).lines, 1);
	assert.equal(clearing.view().incoming, 4);
	assert.equal(clearing.view().grid[19][2], '_');
});

test('garbage bounds and deep-copy packet isolation', () => {
	const board = new Board(0);
	for (let index = 0; index < 300; index += 1) board.enqueueGarbage(1, index % 10);
	assert.equal(board.view().incoming, 200);
	assert.equal(board.snapshot().garbage.length, 200);
	const snapshot = board.snapshot();
	snapshot.garbage[0].rows = 200;
	assert.equal(board.snapshot().garbage[0].rows, 1);
	for (const args of [[0, 0], [-1, 0], [201, 0], [1.5, 0], [1, 10], [1, -1], [1, 0, -1], [1, 0, Infinity], [1, 0, 60001], [1, 0, 0, {}]]) {
		assert.throws(() => board.enqueueGarbage(...args), RangeError);
	}
});

test('spawn, hold, hidden-lock and garbage-overflow topout with ordered events', () => {
	const spawn = fixture(operation('O', 0, 0), [[4, 20]], { next: ['T', 'I', 'J', 'L', 'S'] });
	assert.deepEqual(spawn.action('drop').map(event => event.type), ['lock', 'topout']);
	const hold = fixture(operation('O', 0, 0), [[4, 20]], { hold: 'T' });
	assert.deepEqual(hold.action('hold'), [{ type: 'topout' }]);
	const hidden = fixture(operation('O', 0, 20), [[0, 19]]);
	assert.deepEqual(hidden.action('drop').map(event => event.type), ['lock', 'topout']);
	const partial = fixture(operation('O', 0, 19), [[0, 18]]);
	assert.equal(lockEvent(partial).type, 'lock');
	assert.equal(partial.over, false);
	const overflow = fixture(operation('O', 0, 0), [[9, 21]]);
	overflow.enqueueGarbage(1, 5, 0);
	overflow.enqueueGarbage(2, 6, 0);
	assert.deepEqual(overflow.action('drop').map(event => event.type), ['lock', 'topout']);
	for (const ended of [spawn, hold, hidden, overflow]) {
		assert.equal(ended.over, true);
		assert.deepEqual(ended.view().active, []);
		assert.deepEqual(ended.view().ghost, []);
		assert.deepEqual(Board.from(ended.snapshot()).snapshot(), ended.snapshot());
		const snapshot = ended.snapshot();
		assert.deepEqual(ended.step(1000), []);
		for (const action of ['left', 'right', 'soft', 'rotateCW', 'rotateCCW', 'hold', 'drop']) assert.deepEqual(ended.action(action), []);
		ended.enqueueGarbage(1, 0);
		assert.deepEqual(ended.snapshot(), snapshot);
	}
});

test('exact serialized replay including lock/gravity timers, rotation and pending packets', () => {
	const original = fixture(operation('T', 4, 0));
	original.enqueueGarbage(2, 3, 750, 'sender');
	original.step(123.25);
	original.action('rotateCW');
	original.step(43.75);
	const snapshot = JSON.parse(JSON.stringify(original.snapshot()));
	const restored = Board.from(snapshot);
	assert.deepEqual(restored.snapshot(), snapshot);
	snapshot.garbage[0].rows = 100;
	snapshot.lastRotation.kick = 4;
	assert.notDeepEqual(restored.snapshot(), snapshot);
	for (let index = 0; index < 600; index += 1) {
		const action = ['left', 'right', 'rotateCW', 'rotateCCW', 'soft', 'hold', 'drop'][index % 7];
		if (index % 11 === 0) assert.deepEqual(restored.action(action), original.action(action));
		assert.deepEqual(restored.step(1000 / 60), original.step(1000 / 60));
		assert.deepEqual(restored.snapshot(), original.snapshot());
	}
});

test('substepping retains every lock/topout event and matches split elapsed time', () => {
	const batched = new Board(812);
	const split = new Board(812);
	batched.enqueueGarbage(3, 8, 1500);
	split.enqueueGarbage(3, 8, 1500);
	const events = batched.step(200000);
	const expected = [];
	for (let index = 0; index < 12000 && !split.over; index += 1) expected.push(...split.step(1000 / 60));
	assert.deepEqual(events, expected);
	assert(events.filter(event => event.type === 'lock').length > 3);
	assert.equal(events.at(-1).type, 'topout');
	const actualState = batched.snapshot();
	const expectedState = split.snapshot();
	for (const timer of ['elapsedMs', 'gravityMs', 'lockMs']) {
		assert(Math.abs(actualState[timer] - expectedState[timer]) < 1e-6, timer);
		delete actualState[timer];
		delete expectedState[timer];
	}
	assert.deepEqual(actualState, expectedState);
});

test('corrupt snapshots reject malformed shape, pieces, bounds, RNG, timers and packets', () => {
	const good = new Board(5).snapshot();
	for (const value of [null, undefined, 0, {}, [], { ...good, version: 2 }]) assert.throws(() => Board.from(value), TypeError);
	const mutations = [
		state => { state.field = '_'.repeat(229); },
		state => { state.field = '?'.repeat(230); },
		state => { state.field = 'X'.repeat(10) + '_'.repeat(220); },
		state => { state.field = state.field.slice(0, 24) + 'X' + state.field.slice(25); },
		state => { state.active = null; },
		state => { state.active.type = 'X'; },
		state => { state.active.rotation = 'up'; },
		state => { state.active.x = -5; },
		state => { state.active.y = 23; },
		state => { state.active.x = 0.5; },
		state => { state.active.y = NaN; },
		state => { state.rng = -1; },
		state => { state.rng = 0x100000000; },
		state => { state.hold = 'X'; },
		state => { state.holdUsed = 1; },
		state => { state.over = 'false'; },
		state => { state.over = true; },
		state => { state.next.pop(); },
		state => { state.next[0] = 'X'; },
		state => { state.next = new Array(5); },
		state => { state.bag = ['T', 'T']; },
		state => { state.bag = [null]; },
		state => { state.bag = new Array(1); },
		state => { state.elapsedMs = Infinity; },
		state => { state.gravityMs = 801; },
		state => { state.lockMs = 501; },
		state => { state.lockResets = 16; },
		state => { state.lockResets = 0.5; },
		state => { state.lines = -1; },
		state => { state.locks = NaN; },
		state => { state.combo = -2; },
		state => { state.b2b = 1; },
		state => { state.label = 'X'.repeat(129); },
		state => { state.lastRotation = {}; },
		state => { state.lastRotation = { kick: 5 }; },
		state => { state.garbage = new Array(1); },
		state => { state.garbage = [{ rows: 1, hole: 0, delayMs: -1, sender: null }]; },
		state => { state.garbage = [{ rows: 0, hole: 0, delayMs: 0, sender: null }]; },
		state => { state.garbage = [{ rows: 1, hole: 10, delayMs: 0, sender: null }]; },
		state => { state.garbage = [{ rows: 1, hole: 0, delayMs: 0, sender: 'x'.repeat(129) }]; },
		state => { state.garbage = [{ rows: 200, hole: 0, delayMs: 0, sender: null }, { rows: 1, hole: 0, delayMs: 0, sender: null }]; },
	];
	for (const mutate of mutations) {
		const corrupt = JSON.parse(JSON.stringify(good));
		mutate(corrupt);
		assert.throws(() => Board.from(corrupt), TypeError, mutate.toString());
	}
});

test('30-board deterministic simulation smoke', () => {
	const boards = Array.from({ length: 30 }, (_, index) => new Board(index));
	const mirrors = boards.map(board => Board.from(board.snapshot()));
	for (let frame = 0; frame < 600; frame += 1) {
		for (let index = 0; index < boards.length; index += 1) {
			const board = boards[index];
			const mirror = mirrors[index];
			if (frame % 53 === 0) {
				board.enqueueGarbage(1, index % 10);
				mirror.enqueueGarbage(1, index % 10);
			}
			if (frame % 17 === 0) {
				const action = ['left', 'right', 'rotateCW', 'rotateCCW', 'soft', 'hold', 'drop'][(frame + index) % 7];
				assert.deepEqual(board.action(action), mirror.action(action));
			}
			assert.deepEqual(board.step(1000 / 60), mirror.step(1000 / 60));
		}
	}
	for (let index = 0; index < boards.length; index += 1) {
		assert.deepEqual(boards[index].snapshot(), mirrors[index].snapshot());
		assert.deepEqual(Board.from(boards[index].snapshot()).snapshot(), boards[index].snapshot());
	}
});

test('SRS four-turn cycles preserve exact geometry for every piece', () => {
	for (const type of TYPES) {
		for (const direction of ['rotateCW', 'rotateCCW']) {
			const board = fixture(operation(type));
			const initial = board.snapshot().active;
			for (let turn = 0; turn < 4; turn += 1) board.action(direction);
			assert.deepEqual(board.snapshot().active, initial);
			assert.deepEqual(board.view().active, Mino.from(initial).positions()
				.map(cell => ({ x: cell.x, y: 19 - cell.y, type })));
		}
	}
	const clockwise = fixture(operation('I'));
	clockwise.action('rotateCW');
	assert.deepEqual(clockwise.snapshot().active, operation('I', 5, 10, 'right'));
	const counterclockwise = fixture(operation('I'));
	counterclockwise.action('rotateCCW');
	assert.deepEqual(counterclockwise.snapshot().active, operation('I', 4, 9, 'left'));
});

test('SRS ordered kick fixtures for every constructible CW/CCW candidate', () => {
	const reference = {
		normal: {
			'0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
			'1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
			'1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
			'2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
			'2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
			'3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
			'3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
			'0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
		},
		I: {
			'0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
			'1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
			'1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
			'2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
			'2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
			'3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
			'3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
			'0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
		},
	};
	const origins = [[0, 0], [1, 0], [1, -1], [0, -1]];
	let fixtures = 0;
	let boundaryFixtures = 0;
	const missing = [];
	for (const type of TYPES.filter(type => type !== 'O')) {
		for (let before = 0; before < 4; before += 1) {
			for (const direction of [-1, 1]) {
				const after = (before + direction + 4) % 4;
				const kicks = reference[type === 'I' ? 'I' : 'normal'][`${before}>${after}`];
				for (let kick = 0; kick < 5; kick += 1) {
					let found = false;
					for (let row = 0; row < 23 && !found; row += 1) {
						for (let column = 0; column < 10 && !found; column += 1) {
							const active = new Mino(type, ORIENTATIONS[before], column, row);
							if (!active.isValid()) continue;
							const candidates = kicks.map(([horizontal, vertical]) => new Mino(type, ORIENTATIONS[after],
								column + horizontal + (type === 'I' ? origins[after][0] - origins[before][0] : 0),
								row + vertical + (type === 'I' ? origins[after][1] - origins[before][1] : 0)));
							const target = candidates[kick];
							if (!target.isValid()) continue;
							const protectedCells = [...active.positions(), ...target.positions()];
							const filled = [];
							let possible = true;
							let boundary = false;
							for (const earlier of candidates.slice(0, kick)) {
								if (!earlier.isValid()) {
									boundary = true;
									continue;
								}
								const blocker = earlier.positions().find(cell => !protectedCells.some(protectedCell =>
									cell.x === protectedCell.x && cell.y === protectedCell.y));
								if (!blocker) {
									possible = false;
									break;
								}
								filled.push([blocker.x, blocker.y]);
							}
							if (!possible) continue;
							const board = fixture(active.operation(), filled);
							board.action(direction === 1 ? 'rotateCW' : 'rotateCCW');
							assert.deepEqual(board.snapshot().active, target.operation(), `${type} ${before}>${after} kick ${kick}`);
							assert.equal(board.snapshot().lastRotation.kick, kick);
							fixtures += 1;
							if (boundary) boundaryFixtures += 1;
							found = true;
						}
					}
					if (!found) missing.push(`${type} ${before}>${after} kick ${kick}`);
				}
			}
		}
	}
	assert(fixtures >= 200);
	assert(boundaryFixtures >= 40);
	console.log(`    SRS: ${fixtures}/240 constructible kick fixtures, ${boundaryFixtures} boundary fixtures`);
	if (missing.length) console.log(`    Geometrically unreachable candidates: ${missing.join('; ')}`);
});

test('every feasible empty-field SRS wall and floor transition', () => {
	let wallChecks = 0;
	let floorChecks = 0;
	for (const type of TYPES.filter(type => type !== 'O')) {
		for (const rotation of ORIENTATIONS) {
			for (const action of ['rotateCW', 'rotateCCW']) {
				for (let column = 0; column < 10; column += 1) {
					for (let row = 0; row <= 3; row += 1) {
						const active = new Mino(type, rotation, column, row);
						if (!active.isValid()) continue;
						const cells = active.positions();
						const wall = cells.some(cell => cell.x === 0 || cell.x === 9);
						const floor = cells.some(cell => cell.y === 0);
						if (!wall && !floor) continue;
						const board = fixture(active.operation());
						board.action(action);
						const result = board.snapshot();
						assert(Mino.from(result.active).isValid());
						assert(Field.create().canFill(result.active));
						assert.notEqual(result.active.rotation, rotation, `${type} ${rotation} ${action} ${column},${row}`);
						assert(result.lastRotation !== null);
						if (wall) wallChecks += 1;
						if (floor) floorChecks += 1;
					}
				}
			}
		}
	}
	console.log(`    SRS: ${wallChecks} wall checks and ${floorChecks} floor checks`);
});

test('actual rotations score a mini single and fifth-kick T-spin triple', () => {
	const singleBlocks = [[3, 0], [5, 0], [3, 2], [9, 8]];
	for (let column = 0; column < 10; column += 1) {
		if (column < 3 || column > 5) singleBlocks.push([column, 1]);
	}
	const mini = fixture(operation('T', 4, 1, 'right'), singleBlocks);
	mini.action('rotateCCW');
	assert.deepEqual(mini.snapshot().lastRotation, { kick: 0 });
	assert.equal(lockEvent(mini).spin, 'mini');
	const filled = [[4, 4]];
	const landing = new Mino('T', 'right', 4, 1).positions();
	for (let row = 0; row < 3; row += 1) {
		for (let column = 0; column < 10; column += 1) {
			if (!landing.some(cell => cell.x === column && cell.y === row)) filled.push([column, row]);
		}
	}
	const triple = fixture(operation('T', 5, 3), filled);
	triple.action('rotateCW');
	assert.deepEqual(triple.snapshot().active, operation('T', 4, 1, 'right'));
	assert.deepEqual(triple.snapshot().lastRotation, { kick: 4 });
	const event = lockEvent(triple);
	assert.equal(event.spin, 'full');
	assert.equal(event.lines, 3);
	assert.equal(event.attack, 6);
});

test('garbage expiry at exact substep boundaries is due on the next lock', () => {
	for (const delay of [0.5, 16, 1000 / 60, 499, 500, 1000, 1500]) {
		const board = fixture(operation('O', 0, 10));
		board.enqueueGarbage(1, 7, delay);
		board.step(delay);
		lockEvent(board);
		assert.equal(board.view().incoming, 0, `delay ${delay}`);
	}
});

console.log(`Stacking Royale: ${checks} rule groups passed`);