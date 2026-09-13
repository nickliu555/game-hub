'use strict';

const { Field, Mino } = require('tetris-fumen');
const { Board } = require('../../public/stackingroyale/js/engine');

const BOT_SETTINGS = Object.freeze({
  novice: Object.freeze({ thinkMs: 1500, actionMs: 260 }),
  easy: Object.freeze({ thinkMs: 650, actionMs: 160 }),
  medium: Object.freeze({ thinkMs: 280, actionMs: 85 }),
  hard: Object.freeze({ thinkMs: 110, actionMs: 40 }),
});
const ROTATION_PATHS = [[], ['rotateCW'], ['rotateCCW'], ['rotateCW', 'rotateCW']];

function positionKey(active) {
  return `${active.rotation}:${active.x}:${active.y}`;
}

function evaluate(snapshot, event, difficulty) {
  const field = Field.create(snapshot.field);
  const heights = [];
  let holes = 0;
  let covered = 0;
  for (let column = 0; column < 10; column += 1) {
    let height = 0;
    let blocks = 0;
    for (let row = 22; row >= 0; row -= 1) {
      if (field.at(column, row) !== '_') {
        if (height === 0) height = row + 1;
        blocks += 1;
      } else if (blocks > 0) {
        holes += 1;
        covered += blocks;
      }
    }
    heights.push(height);
  }
  let bumpiness = 0;
  let wells = 0;
  for (let column = 0; column < 10; column += 1) {
    if (column > 0) bumpiness += Math.abs(heights[column] - heights[column - 1]);
    const depth = Math.min(column === 0 ? 23 : heights[column - 1],
      column === 9 ? 23 : heights[column + 1]) - heights[column];
    wells += Math.max(0, depth - 2) ** 2;
  }
  const maximum = Math.max(...heights);
  const hard = difficulty === 'hard';
  return (snapshot.over ? -1000000 : 0)
    - heights.reduce((total, height) => total + height, 0) * 0.65
    - holes * (hard ? 11 : 8) - covered * (hard ? 0.45 : 0.2)
    - bumpiness * 0.4 - wells * (hard ? 0.25 : 0.1)
    - maximum * 0.8 - Math.max(0, maximum - 12) ** 2 * 1.5
    + event.lines * 3 + (hard ? event.attack * 0.6 : 0);
}

function placements(snapshot, prefix, difficulty) {
  const candidates = [];
  const seen = new Set();
  const blockedRotations = [];
  const field = Field.create(snapshot.field);
  function consider(board, path) {
    const state = board.snapshot();
    const landing = Mino.from(state.active).operation();
    while (field.canFill({ ...landing, y: landing.y - 1 })) landing.y -= 1;
    const key = Mino.from(landing).positions().map(cell => `${cell.x}:${cell.y}`).sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    const replay = Board.from(state);
    const event = replay.action('drop').find(result => result.type === 'lock');
    if (!event) return;
    const result = replay.snapshot();
    candidates.push({ moves: [...prefix, ...path, 'drop'], over: result.over,
      score: evaluate(result, event, difficulty) - (path.length + prefix.length) * 0.015 });
  }
  for (const rotations of ROTATION_PATHS) {
    const rotated = Board.from(snapshot);
    let valid = true;
    for (const action of rotations) {
      const before = positionKey(rotated.snapshot().active);
      rotated.action(action);
      if (positionKey(rotated.snapshot().active) === before) {
        valid = false;
        break;
      }
    }
    if (!valid) {
      if (snapshot.active.type !== 'O') blockedRotations.push(rotations);
      continue;
    }
    consider(rotated, rotations);
    for (const direction of ['left', 'right']) {
      const shifted = Board.from(rotated.snapshot());
      const path = [...rotations];
      for (let distance = 0; distance < 9; distance += 1) {
        const before = positionKey(shifted.snapshot().active);
        shifted.action(direction);
        if (positionKey(shifted.snapshot().active) === before) break;
        path.push(direction);
        consider(shifted, path);
      }
    }
  }
  if (blockedRotations.length > 0) {
    for (const direction of ['left', 'right']) {
      const shifted = Board.from(snapshot);
      const path = [];
      for (let distance = 0; distance < 9; distance += 1) {
        const before = positionKey(shifted.snapshot().active);
        shifted.action(direction);
        if (positionKey(shifted.snapshot().active) === before) break;
        path.push(direction);
        for (const rotations of blockedRotations) {
          const rotated = Board.from(shifted.snapshot());
          let valid = true;
          for (const action of rotations) {
            const previous = positionKey(rotated.snapshot().active);
            rotated.action(action);
            if (positionKey(rotated.snapshot().active) === previous) {
              valid = false;
              break;
            }
          }
          if (valid) consider(rotated, [...path, ...rotations]);
        }
      }
    }
  }
  return candidates;
}

function planMoves(board, difficulty, random = Math.random) {
  if (!Object.hasOwn(BOT_SETTINGS, difficulty)) throw new RangeError('Unknown CPU difficulty');
  if (board.over) return [];
  const snapshot = { ...board.snapshot(), rng: 0, bag: [] };
  const candidates = placements(snapshot, [], difficulty);
  if (difficulty === 'hard' && !snapshot.holdUsed) {
    const held = Board.from(snapshot);
    held.action('hold');
    if (!held.over) candidates.push(...placements(held.snapshot(), ['hold'], difficulty));
  }
  candidates.sort((first, second) => second.score - first.score);
  let choice = 0;
  const novice = difficulty === 'novice';
  if ((novice || difficulty === 'easy') && candidates.length > 1 && random() < (novice ? 0.7 : 0.25)) {
    const alternatives = Math.min(novice ? 8 : 3, candidates.filter(candidate => candidate.over === candidates[0].over).length - 1);
    if (alternatives > 0) choice = 1 + Math.min(alternatives - 1, Math.max(0, Math.floor(random() * alternatives)));
  }
  return candidates[choice].moves;
}

module.exports = { BOT_SETTINGS, planMoves };