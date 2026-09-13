'use strict';

const { randomBytes, randomUUID, randomInt } = require('crypto');
const { BOT_SETTINGS, planMoves } = require('./bot');

const PHASES = Object.freeze({ LOBBY: 'LOBBY', COUNTDOWN: 'COUNTDOWN', PLAYING: 'PLAYING', FINAL: 'FINAL' });
const MIN_PLAYERS = 1;
const MAX_PLAYERS = 30;
const STEP_MS = 1000 / 60;
const ACTIONS = new Set(['left', 'right', 'soft', 'rotateCW', 'rotateCCW', 'hold', 'drop']);
const MAX_SEQ = 0x7fffffff;
const BOT_DIFFICULTIES = Object.freeze(['novice', 'easy', 'medium', 'hard']);

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function reply(ack, result) {
  if (typeof ack === 'function') ack(result);
}

class Game {
  constructor() {
    this.players = new Map();
    this.hostPresent = false;
    this.random = () => randomInt(0x100000000) / 0x100000000;
    this.reset();
  }

  reset() {
    for (const player of this.players.values()) {
      this.cancelInputs(player, 'reset');
    }
    this.players.clear();
    this.phase = PHASES.LOBBY;
    this.matchId = randomUUID();
    this.paused = false;
    this.countdownMs = 0;
    this.elapsedMs = 0;
    this.winnerIds = [];
    this.botDifficulty = 'medium';
    this.botCursor = 0;
  }

  freshPlayerState() {
    return {
      board: null, alive: true, placement: null, lines: 0, sent: 0, survivalMs: 0,
      targetIds: [], seq: 0, queuedSeq: 0, inputs: [],
      tokens: 30, tokenAt: null, spectating: null,
      bot: { moves: [], waitMs: 0, locks: null },
    };
  }

  addPlayer({ playerId, name, socketId }) {
    if (!validId(playerId)) return { ok: false, reason: 'bad-player-id' };
    if (this.players.has(playerId)) return this.reconnectPlayer(playerId, socketId);
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'round-in-progress' };
    if (!this.hostPresent) return { ok: false, reason: 'host-absent' };
    if (this.players.size >= MAX_PLAYERS) return { ok: false, reason: 'game-full' };
    const clean = typeof name === 'string'
      ? Array.from(name.normalize('NFC').replace(/[^\p{L}\p{N} '._-]/gu, '').trim().replace(/\s+/g, ' ')).slice(0, 20).join('')
      : '';
    if (!clean) return { ok: false, reason: 'name-too-short' };
    if ([...this.players.values()].some(player => player.name.toLowerCase() === clean.toLowerCase())) {
      return { ok: false, reason: 'name-taken' };
    }
    const used = new Set([...this.players.values()].map(player => player.color));
    let colorIndex = 0;
    while (used.has(`hsl(${Math.round(colorIndex * 137.508) % 360}, 78%, 62%)`)) colorIndex++;
    const player = {
      id: playerId, name: clean, color: `hsl(${Math.round(colorIndex * 137.508) % 360}, 78%, 62%)`,
      socketId, connected: true, isBot: false, ...this.freshPlayerState(),
    };
    this.players.set(playerId, player);
    return { ok: true, player };
  }

  addBot() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    let number = 1;
    const names = new Set([...this.players.values()].map(player => player.name.toLowerCase()));
    while (names.has(`cpu ${number}`)) number++;
    const result = this.addPlayer({ playerId: `cpu-${randomUUID()}`, name: `CPU ${number}`, socketId: null });
    if (result.ok) result.player.isBot = true;
    return result;
  }

  setBotDifficulty(level) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (!BOT_DIFFICULTIES.includes(level)) return { ok: false, reason: 'bad-difficulty' };
    this.botDifficulty = level;
    return { ok: true };
  }

  reconnectPlayer(playerId, socketId) {
    if (!validId(playerId)) return { ok: false, reason: 'bad-player-id' };
    const player = this.players.get(playerId);
    if (!player || player.isBot) return { ok: false, reason: 'unknown-player' };
    if (player.socketId !== socketId) this.cancelInputs(player, 'superseded');
    player.socketId = socketId;
    player.connected = true;
    return { ok: true, player };
  }

  disconnect(socketId) {
    for (const player of this.players.values()) {
      if (player.socketId !== socketId) continue;
      player.connected = false;
      player.socketId = null;
      this.cancelInputs(player, 'disconnected');
      return true;
    }
    return false;
  }

  kick(playerId) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: 'unknown-player' };
    this.cancelInputs(player, 'kicked');
    this.players.delete(playerId);
    return { ok: true, player };
  }

  start() {
    if (!this.hostPresent) return { ok: false, reason: 'host-absent' };
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (this.players.size < MIN_PLAYERS || this.players.size > MAX_PLAYERS) {
      return { ok: false, reason: 'player-count' };
    }
    const { Board } = require('../../public/stackingroyale/js/engine.js');
    const seed = randomBytes(4).readUInt32LE(0);
    const boards = [...this.players.values()].map(player => ({ player, board: new Board(seed) }));
    this.matchId = randomUUID();
    this.phase = PHASES.COUNTDOWN;
    this.countdownMs = 3000;
    this.elapsedMs = 0;
    this.paused = false;
    this.winnerIds = [];
    for (const { player, board } of boards) Object.assign(player, this.freshPlayerState(), { board });
    this.refreshTargets();
    return { ok: true };
  }

  setPaused(paused) {
    if (![PHASES.COUNTDOWN, PHASES.PLAYING].includes(this.phase)) return { ok: false, reason: 'not-playing' };
    this.paused = paused;
    if (paused) for (const player of this.players.values()) this.cancelInputs(player, 'paused');
    return { ok: true };
  }

  controlsReason(player, socketId, matchId) {
    if (!player || player.isBot || !player.connected || player.socketId !== socketId) return 'not-player';
    if (matchId !== this.matchId) return 'stale-match';
    if (this.phase !== PHASES.PLAYING) return 'not-playing';
    if (this.paused) return 'paused';
    if (!player.alive || player.board.over) return 'eliminated';
    return null;
  }

  enqueueAction(player, socketId, payload, now, ack) {
    const reason = this.controlsReason(player, socketId, payload.matchId);
    const reject = failure => reply(ack, { ok: false, reason: failure, seq: player ? player.seq : 0 });
    if (reason) return reject(reason);
    if (!ACTIONS.has(payload.action)) return reject('bad-action');
    if (!Number.isSafeInteger(payload.seq) || payload.seq <= player.queuedSeq || payload.seq > MAX_SEQ || payload.seq > player.seq + 1024) {
      return reject('bad-seq');
    }
    if (player.tokenAt !== null) player.tokens = Math.min(30, player.tokens + Math.max(0, now - player.tokenAt) * 0.06);
    player.tokenAt = now;
    if (player.inputs.length >= 30 || player.tokens < 1) return reject('rate-limited');
    player.tokens--;
    player.queuedSeq = payload.seq;
    player.inputs.push({ socketId, matchId: payload.matchId, action: payload.action, seq: payload.seq, ack });
  }

  cancelInputs(player, reason) {
    for (const input of player.inputs || []) reply(input.ack, { ok: false, reason, seq: player.seq });
    player.inputs = [];
    player.queuedSeq = player.seq;
  }

  chooseTargets(player, reroll = false) {
    const candidates = [...this.players.values()].filter(other => other.id !== player.id && other.alive && other.board && !other.board.over);
    if (!candidates.length) return [];
    if (!reroll && player.targetIds.length === 1 && candidates.some(other => other.id === player.targetIds[0])) return [...player.targetIds];
    return [candidates[Math.floor(this.random() * candidates.length)].id];
  }

  refreshTargets() {
    for (const player of this.players.values()) {
      player.targetIds = player.alive && player.board && !player.board.over ? this.chooseTargets(player) : [];
    }
  }

  prepareBots() {
    const bots = [...this.players.values()].filter(player => player.isBot && player.alive && !player.board.over);
    const settings = BOT_SETTINGS[this.botDifficulty];
    for (const player of bots) {
      const locks = player.board.view().locks;
      if (player.bot.locks !== locks) {
        player.bot = { moves: [], waitMs: settings.thinkMs, locks };
      }
      player.bot.waitMs = Math.max(0, player.bot.waitMs - STEP_MS);
    }
    for (let offset = 0; offset < bots.length; offset++) {
      const index = (this.botCursor + offset) % bots.length;
      const player = bots[index];
      if (player.bot.waitMs > 0 || player.bot.moves.length) continue;
      player.bot.moves = planMoves(player.board, this.botDifficulty, this.random);
      this.botCursor = (index + 1) % bots.length;
      break;
    }
  }

  step() {
    const events = [];
    if (this.paused) return events;
    if (this.phase === PHASES.COUNTDOWN) {
      this.countdownMs = Math.max(0, this.countdownMs - STEP_MS);
      if (this.countdownMs < 0.000001) {
        this.countdownMs = 0;
        this.phase = PHASES.PLAYING;
      }
      return events;
    }
    if (this.phase !== PHASES.PLAYING) return events;
    this.elapsedMs += STEP_MS;
    const attacks = [];
    const collect = (player, boardEvents) => {
      for (const event of boardEvents || []) {
        if (event.type === 'lock' && Number.isSafeInteger(event.attack) && event.attack > 0) attacks.push({ player, ...event });
      }
    };
    this.prepareBots();
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      player.survivalMs = this.elapsedMs;
      if (player.isBot && player.bot.waitMs === 0 && player.bot.moves.length) {
        collect(player, player.board.action(player.bot.moves.shift()));
        player.bot.waitMs = BOT_SETTINGS[this.botDifficulty].actionMs;
      }
      const inputs = player.inputs.splice(0);
      for (const input of inputs) {
        const reason = this.controlsReason(player, input.socketId, input.matchId);
        if (reason) {
          reply(input.ack, { ok: false, reason, seq: player.seq });
          continue;
        }
        collect(player, player.board.action(input.action));
        player.seq = input.seq;
        reply(input.ack, { ok: true, seq: player.seq });
      }
      player.queuedSeq = player.seq;
      if (!player.board.over) collect(player, player.board.step(STEP_MS));
      player.lines = player.board.view().lines;
    }
    const eliminated = [...this.players.values()].filter(player => player.alive && player.board.over);
    const remaining = [...this.players.values()].filter(player => player.alive && !player.board.over);
    for (const player of eliminated) {
      player.alive = false;
      player.placement = remaining.length + 1;
      player.targetIds = [];
      events.push({ type: 'elimination', playerId: player.id });
    }
    this.refreshTargets();
    for (const attack of attacks) {
      const targets = this.chooseTargets(attack.player, true);
      if (attack.player.alive) attack.player.targetIds = targets;
      targets.forEach(targetId => {
        const target = this.players.get(targetId);
        const rows = attack.attack;
        if (!rows || !target.alive || target.board.over) return;
        const incoming = target.board.view().incoming;
        target.board.enqueueGarbage(rows, Math.floor(this.random() * 10), 1500, attack.player.id);
        const accepted = target.board.view().incoming - incoming;
        if (!accepted) return;
        attack.player.sent += accepted;
        events.push({ type: 'attack', from: attack.player.id, to: targetId, rows: accepted, label: attack.label });
      });
    }
    if (remaining.length === 0 || (this.players.size > 1 && remaining.length === 1)) {
      this.phase = PHASES.FINAL;
      this.winnerIds = remaining.map(player => player.id);
      for (const player of remaining) player.placement = 1;
      for (const player of this.players.values()) this.cancelInputs(player, 'match-ended');
    }
    return events;
  }

  state(includeViews = false) {
    return {
      phase: this.phase, matchId: this.matchId, paused: this.paused,
      countdown: Math.ceil(this.countdownMs / 1000), elapsedMs: this.elapsedMs,
      hostPresent: this.hostPresent, botDifficulty: this.botDifficulty,
      players: [...this.players.values()].map(player => ({
        id: player.id, name: player.name, color: player.color, connected: player.connected, isBot: player.isBot,
        alive: player.alive, placement: player.placement, lines: player.lines, sent: player.sent, survivalMs: player.survivalMs,
        targetIds: [...player.targetIds],
        ...(includeViews && player.board ? { view: player.board.view() } : {}),
      })),
      winnerIds: [...this.winnerIds],
    };
  }
}

module.exports = { Game, PHASES, MIN_PLAYERS, MAX_PLAYERS, STEP_MS, BOT_DIFFICULTIES, validId };