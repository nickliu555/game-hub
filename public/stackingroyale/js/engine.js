'use strict';

const { Field, Mino } = require('tetris-fumen');

const PIECES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
const ROTATIONS = ['spawn', 'right', 'reverse', 'left'];
const MAX_TIME = Number.MAX_SAFE_INTEGER;
const MAX_GARBAGE = 200;
const KICKS = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const I_KICKS = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};
const I_ORIGINS = [[0, 0], [1, 0], [1, -1], [0, -1]];

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function timer(value, maximum) {
  return Number.isFinite(value) && value >= 0 && value <= maximum;
}

function piece(value) {
  return PIECES.includes(value);
}

function packetValid(packet) {
  return packet && integer(packet.rows, 1, MAX_GARBAGE)
    && integer(packet.hole, 0, 9) && timer(packet.delayMs, 60000)
    && (packet.sender === null || (typeof packet.sender === 'string' && packet.sender.length <= 128));
}

class Board {
  constructor(seed = 0) {
    if (!integer(seed, 0, 0xffffffff)) throw new RangeError('Seed must be uint32');
    this._field = Field.create();
    this._state = {
      rng: seed, bag: [], next: [], active: null, hold: null, holdUsed: false,
      elapsedMs: 0, gravityMs: 0, lockMs: 0, lockResets: 0, lastRotation: null,
      lines: 0, locks: 0, combo: -1, b2b: false, label: '', over: false, garbage: [],
      clearRows: [],
    };
    for (let index = 0; index < 5; index += 1) this._state.next.push(this._draw());
    this._spawn(this._takeNext(), []);
  }

  static from(snapshot) {
    const invalid = () => { throw new TypeError('Invalid Stacking Royale snapshot'); };
    if (!snapshot || snapshot.version !== 1 || typeof snapshot.field !== 'string'
      || !/^[IOTSZJLX_]{230}$/.test(snapshot.field)) invalid();
    if (!integer(snapshot.rng, 0, 0xffffffff)
      || !Array.isArray(snapshot.next) || snapshot.next.length !== 5 || !Array.from(snapshot.next).every(piece)
      || !Array.isArray(snapshot.bag) || snapshot.bag.length > 7 || !Array.from(snapshot.bag).every(piece)
      || new Set(snapshot.bag).size !== snapshot.bag.length
      || !(snapshot.hold === null || piece(snapshot.hold))
      || typeof snapshot.holdUsed !== 'boolean' || typeof snapshot.over !== 'boolean'
      || typeof snapshot.b2b !== 'boolean' || typeof snapshot.label !== 'string' || snapshot.label.length > 128
      || !timer(snapshot.elapsedMs, MAX_TIME) || !timer(snapshot.gravityMs, 800)
      || !timer(snapshot.lockMs, 500) || !integer(snapshot.lockResets, 0, 15)
      || !integer(snapshot.lines, 0, MAX_TIME) || !integer(snapshot.locks, 0, MAX_TIME)
      || !integer(snapshot.combo, -1, MAX_TIME)
      || (snapshot.clearRows !== undefined && (!Array.isArray(snapshot.clearRows)
        || snapshot.clearRows.length > 4 || !Array.from(snapshot.clearRows).every(row => integer(row, -3, 19))
        || new Set(snapshot.clearRows).size !== snapshot.clearRows.length))
      || !(snapshot.lastRotation === null || (snapshot.lastRotation
        && integer(snapshot.lastRotation.kick, 0, 4)))
      || !Array.isArray(snapshot.garbage) || snapshot.garbage.length > MAX_GARBAGE
      || !Array.from(snapshot.garbage).every(packetValid)
      || snapshot.garbage.reduce((total, packet) => total + packet.rows, 0) > MAX_GARBAGE) invalid();
    const field = Field.create(snapshot.field);
    for (let row = 0; row < 23; row += 1) {
      if (Array.from({ length: 10 }, (_, column) => field.at(column, row)).every(cell => cell !== '_')) invalid();
    }
    if (snapshot.over) {
      if (snapshot.active !== null) invalid();
    } else {
      const active = snapshot.active;
      if (!active || !piece(active.type) || !ROTATIONS.includes(active.rotation)
        || !integer(active.x, -2, 11) || !integer(active.y, 0, 22)
        || !Mino.from(active).isValid() || !field.canFill(active)) invalid();
    }
    const board = Object.create(Board.prototype);
    board._field = field;
    board._state = {
      rng: snapshot.rng, bag: [...snapshot.bag], next: [...snapshot.next],
      active: snapshot.active === null ? null : Mino.from(snapshot.active).operation(),
      hold: snapshot.hold, holdUsed: snapshot.holdUsed,
      elapsedMs: snapshot.elapsedMs, gravityMs: snapshot.gravityMs, lockMs: snapshot.lockMs,
      lockResets: snapshot.lockResets, lastRotation: snapshot.lastRotation === null ? null : { kick: snapshot.lastRotation.kick },
      lines: snapshot.lines, locks: snapshot.locks, combo: snapshot.combo,
      clearRows: [...(snapshot.clearRows || [])],
      b2b: snapshot.b2b, label: snapshot.label, over: snapshot.over,
      garbage: snapshot.garbage.map(packet => ({ rows: packet.rows, hole: packet.hole, delayMs: packet.delayMs, sender: packet.sender })),
    };
    return board;
  }

  get over() { return this._state.over; }

  snapshot() {
    const state = this._state;
    return {
      version: 1, ...state,
      field: this._field.str({ reduced: false, garbage: false, separator: '' }),
      active: state.active === null ? null : { ...state.active },
      bag: [...state.bag], next: [...state.next],
      clearRows: [...state.clearRows],
      lastRotation: state.lastRotation === null ? null : { ...state.lastRotation },
      garbage: state.garbage.map(packet => ({ ...packet })),
    };
  }

  view() {
    const state = this._state;
    const cells = operation => operation === null ? [] : Mino.from(operation).positions()
      .map(position => ({ x: position.x, y: 19 - position.y, type: operation.type }));
    return {
      grid: Array.from({ length: 20 }, (_, row) => Array.from({ length: 10 }, (_, column) => this._field.at(column, 19 - row))),
      active: cells(state.active), ghost: cells(this._ghost()), hold: state.hold, next: [...state.next],
      lines: state.lines, level: this._level(), elapsedMs: state.elapsedMs, over: state.over,
      combo: state.combo, label: state.label, locks: state.locks,
      clearRows: [...state.clearRows],
      incoming: state.garbage.reduce((total, packet) => total + packet.rows, 0),
    };
  }

  enqueueGarbage(rows, hole, delayMs = 1500, sender = null) {
    const packet = { rows, hole, delayMs, sender };
    if (!packetValid(packet)) throw new RangeError('Invalid garbage packet');
    if (this.over) return;
    packet.rows = Math.min(rows, MAX_GARBAGE - this.view().incoming);
    if (packet.rows > 0) this._state.garbage.push(packet);
  }

  action(name) {
    const events = [];
    if (this.over) return events;
    const state = this._state;
    if (name === 'left' || name === 'right') this._move(name === 'left' ? -1 : 1, 0, true);
    else if (name === 'soft') this._move(0, -1, false);
    else if (name === 'rotateCW' || name === 'rotateCCW') this._rotate(name === 'rotateCW' ? 1 : -1);
    else if (name === 'hold' && !state.holdUsed) {
      const previous = state.hold;
      state.hold = state.active.type;
      state.holdUsed = true;
      this._spawn(previous === null ? this._takeNext() : previous, events);
    } else if (name === 'drop') {
      const landing = this._ghost();
      if (landing.y !== state.active.y) state.lastRotation = null;
      state.active = landing;
      this._lock(events);
    }
    return events;
  }

  step(ms) {
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_TIME - this._state.elapsedMs) {
      throw new RangeError('Step must be finite positive milliseconds within the safe time range');
    }
    const events = [];
    let remaining = ms;
    while (remaining > 0 && !this.over) {
      const state = this._state;
      const grounded = this._field.canLock(state.active);
      const gravity = this._gravity();
      const untilLevel = 30000 - state.elapsedMs % 30000;
      const delta = Math.min(remaining, 1000 / 60, untilLevel,
        Math.max(0, gravity - state.gravityMs), grounded ? Math.max(0, 500 - state.lockMs) : Infinity);
      state.elapsedMs += delta;
      state.gravityMs += delta;
      if (grounded) state.lockMs += delta;
      for (const packet of state.garbage) packet.delayMs = Math.max(0, packet.delayMs - delta);
      remaining = Math.max(0, remaining - delta);
      if (grounded && state.lockMs >= 500 - 1e-8) {
        this._lock(events);
      } else if (state.gravityMs >= this._gravity() - 1e-8) {
        state.gravityMs = Math.max(0, state.gravityMs - this._gravity());
        this._move(0, -1, false);
      }
    }
    return events;
  }

  _level() { return Math.floor(this._state.elapsedMs / 30000) + 1; }

  _gravity() { return Math.max(70, 800 - (this._level() - 1) * 60); }

  _draw() {
    const state = this._state;
    if (state.bag.length === 0) {
      state.bag = [...PIECES];
      for (let index = 6; index > 0; index -= 1) {
        state.rng = (Math.imul(state.rng, 1664525) + 1013904223) >>> 0;
        const other = Math.floor(state.rng / 0x100000000 * (index + 1));
        [state.bag[index], state.bag[other]] = [state.bag[other], state.bag[index]];
      }
    }
    return state.bag.shift();
  }

  _takeNext() {
    const next = this._state.next.shift();
    this._state.next.push(this._draw());
    return next;
  }

  _spawn(type, events) {
    const state = this._state;
    state.active = new Mino(type, 'spawn', 4, 20).operation();
    state.gravityMs = 0;
    state.lockMs = 0;
    state.lockResets = 0;
    state.lastRotation = null;
    if (!this._field.canFill(state.active)) this._topout(events);
  }

  _topout(events) {
    if (this.over) return;
    this._state.over = true;
    this._state.active = null;
    events.push({ type: 'topout' });
  }

  _ghost() {
    if (this._state.active === null) return null;
    const ghost = { ...this._state.active };
    while (this._field.canFill({ ...ghost, y: ghost.y - 1 })) ghost.y -= 1;
    return ghost;
  }

  _resetLock(wasGrounded) {
    const state = this._state;
    if (wasGrounded && state.lockResets < 15) {
      state.lockMs = 0;
      state.lockResets += 1;
    }
  }

  _move(horizontal, vertical, reset) {
    const state = this._state;
    const candidate = { ...state.active, x: state.active.x + horizontal, y: state.active.y + vertical };
    if (!this._field.canFill(candidate)) return false;
    const grounded = this._field.canLock(state.active);
    state.active = candidate;
    state.lastRotation = null;
    if (reset) this._resetLock(grounded);
    return true;
  }

  _rotate(direction) {
    const state = this._state;
    const active = state.active;
    if (active.type === 'O') return false;
    const before = ROTATIONS.indexOf(active.rotation);
    const after = (before + direction + 4) % 4;
    const kicks = (active.type === 'I' ? I_KICKS : KICKS)[`${before}>${after}`];
    const originBefore = active.type === 'I' ? I_ORIGINS[before] : [0, 0];
    const originAfter = active.type === 'I' ? I_ORIGINS[after] : [0, 0];
    for (let index = 0; index < kicks.length; index += 1) {
      const [horizontal, vertical] = kicks[index];
      const candidate = new Mino(active.type, ROTATIONS[after],
        active.x + originAfter[0] - originBefore[0] + horizontal,
        active.y + originAfter[1] - originBefore[1] + vertical).operation();
      if (!this._field.canFill(candidate)) continue;
      const grounded = this._field.canLock(active);
      state.active = candidate;
      state.lastRotation = { kick: index };
      this._resetLock(grounded);
      return true;
    }
    return false;
  }

  _spin() {
    const state = this._state;
    const active = state.active;
    if (active.type !== 'T' || state.lastRotation === null) return null;
    const occupied = (horizontal, vertical) => {
      const column = active.x + horizontal;
      const row = active.y + vertical;
      return column < 0 || column > 9 || row < 0 || row > 22 || this._field.at(column, row) !== '_';
    };
    const corners = [occupied(-1, 1), occupied(1, 1), occupied(1, -1), occupied(-1, -1)];
    if (corners.filter(Boolean).length < 3) return null;
    const front = ROTATIONS.indexOf(active.rotation);
    return (corners[front] && corners[(front + 1) % 4]) || state.lastRotation.kick === 4 ? 'full' : 'mini';
  }

  _lock(events) {
    const state = this._state;
    const spin = this._spin();
    const hidden = Mino.from(state.active).positions().every(position => position.y >= 20);
    this._field.fill(state.active);
    state.clearRows = [];
    for (let row = 0; row < 23; row += 1) {
      if (Array.from({ length: 10 }, (_, column) => this._field.at(column, row)).every(cell => cell !== '_')) state.clearRows.push(19 - row);
    }
    const cleared = state.clearRows.length;
    this._field.clearLine();
    const perfectClear = this._field.str({ garbage: false, separator: '' }) === '';
    const difficult = cleared > 0 && (cleared === 4 || spin !== null);
    let attack = spin === 'full' ? [0, 2, 4, 6][cleared]
      : spin === 'mini' ? [0, 0, 1][cleared] : [0, 0, 1, 2, 4][cleared];
    if (cleared > 0) {
      state.combo += 1;
      attack += Math.min(4, Math.floor(state.combo / 2));
      if (difficult && state.b2b) attack += 1;
      state.b2b = difficult;
    } else state.combo = -1;
    if (perfectClear) attack += 10;
    for (const packet of state.garbage) {
      const cancelled = Math.min(attack, packet.rows);
      packet.rows -= cancelled;
      attack -= cancelled;
    }
    state.garbage = state.garbage.filter(packet => packet.rows > 0);
    state.lines += cleared;
    state.locks += 1;
    state.label = perfectClear ? 'Perfect Clear' : spin !== null
      ? `${spin === 'mini' ? 'Mini T-Spin' : 'T-Spin'}${cleared ? ` ${cleared}` : ''}`
      : ['', 'Single', 'Double', 'Triple', 'Tetris'][cleared];
    events.push({ type: 'lock', lines: cleared, clearRows: [...state.clearRows], attack, label: state.label, perfectClear, spin });
    state.active = null;
    if (hidden && cleared === 0) {
      this._topout(events);
      return;
    }
    if (cleared === 0) this._applyGarbage(events);
    if (this.over) return;
    state.holdUsed = false;
    this._spawn(this._takeNext(), events);
  }

  _applyGarbage(events) {
    let applied = 0;
    for (const packet of this._state.garbage) {
      if (packet.delayMs > 0) continue;
      while (packet.rows > 0 && applied < 8) {
        for (let column = 0; column < 10; column += 1) {
          if (this._field.at(column, 22) !== '_') {
            this._topout(events);
            this._state.garbage = this._state.garbage.filter(pending => pending.rows > 0);
            return;
          }
        }
        for (let row = 22; row > 0; row -= 1) {
          for (let column = 0; column < 10; column += 1) this._field.set(column, row, this._field.at(column, row - 1));
        }
        for (let column = 0; column < 10; column += 1) this._field.set(column, 0, column === packet.hole ? '_' : 'X');
        packet.rows -= 1;
        applied += 1;
      }
    }
    this._state.garbage = this._state.garbage.filter(packet => packet.rows > 0);
  }
}

module.exports = { Board };