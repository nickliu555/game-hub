'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Ragdoll Rumble — server-side lobby + match-meta state machine.
//
// Like Bomb Brawl / Soccer Head, the live game (Planck.js ragdoll physics,
// attacks, items, hazards, CPU AI) runs on the HOST browser for the lowest
// possible input latency (player -> server -> host is a single relay hop).
// This module does NOT simulate the game. It owns:
//   • the lobby: 2–6 fighters, Add-CPU bots, and the config knobs (rounds to
//     win, round length, items on/off, stage set, CPU difficulty).
//   • a CACHE of match meta (round, stage, round wins, who is still in, clock,
//     per-player damage % and held item) that the host pushes as rounds run,
//     so reconnecting phones and a refreshed host land on the right screen.
//
// Seat order picks each fighter's color and spawn point. The host can drag
// the roster in the lobby; the order locks when the match starts.
//
// The transport layer (./index.js) owns socket events + broadcasting.
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
  FINAL: 'FINAL',
};

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

const MAX_NAME_LEN = 20;

const MIN_ROUND_SEC = 60;
const MAX_ROUND_SEC = 180;
const DEFAULT_ROUND_SEC = 90;

const MIN_ROUNDS_TO_WIN = 1;
const MAX_ROUNDS_TO_WIN = 7;
const DEFAULT_ROUNDS_TO_WIN = 3;

const BOT_DIFFICULTIES = ['easy', 'normal', 'hard'];
const DEFAULT_BOT_DIFFICULTY = 'normal';

// 'mixed' rotates through every stage; 'classic' is the plain Rooftop only.
const STAGE_SETS = ['mixed', 'classic'];
const DEFAULT_STAGE_SET = 'mixed';

const ITEM_TYPES = ['', 'bat', 'bomb', 'rock'];

// Fighter colors by seat.
const PLAYER_COLORS = ['#FF4D4D', '#3DA5FF', '#3DDC84', '#FFD23F', '#B266FF', '#FF8A3D', '#2EE6D6', '#FF6FB5'];

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    this.roundLengthSec = DEFAULT_ROUND_SEC;
    this.roundsToWin = DEFAULT_ROUNDS_TO_WIN;
    this.items = true;
    this.stageSet = DEFAULT_STAGE_SET;
    this.botDifficulty = DEFAULT_BOT_DIFFICULTY;
    this._orderSeq = 0;
    /** @type {Map<string, object>} */
    this.players = new Map();
    this.match = this._freshMatch();
  }

  _freshMatch() {
    return {
      round: 1,
      seed: 0,            // physics seed for the current round (host-generated)
      stage: '',          // stage id for the current round
      clockMs: this.roundLengthSec * 1000,
      live: false,        // true only while controls are active (host:play)
      paused: false,      // true while the host has the game paused
      roundOver: false,   // true between a round's result and the next round's start
      suddenDeath: false, // true once the blast zone has started closing in
      gamePoints: {},     // playerId -> rounds won so far
      alive: {},          // playerId -> bool (still in this round)
      hud: {},            // playerId -> { dmg, item, glove }
      winnerIds: [],      // final: id(s) that reached roundsToWin
    };
  }

  capacity() { return MAX_PLAYERS; }

  // ---------------- Names / players ----------------

  sanitizeName(raw) {
    if (typeof raw !== 'string') return '';
    let n = raw.replace(/[^\p{L}\p{N} '._-]/gu, '').trim().replace(/\s+/g, ' ');
    if (n.length > MAX_NAME_LEN) n = n.slice(0, MAX_NAME_LEN);
    return n;
  }

  nameIsTaken(name) {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  addPlayer({ playerId, name, socketId }) {
    if (!playerId || typeof playerId !== 'string') {
      return { ok: false, reason: 'bad-player-id' };
    }
    if (this.players.has(playerId)) {
      return this.reconnectPlayer({ playerId, socketId });
    }
    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, reason: 'round-in-progress' };
    }
    if (this.players.size >= this.capacity()) {
      return { ok: false, reason: 'game-full' };
    }
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) {
      return { ok: false, reason: 'name-taken', name: clean };
    }
    const player = makePlayer(playerId, clean, socketId);
    player.order = this._orderSeq++;
    this.players.set(playerId, player);
    return { ok: true, player };
  }

  /**
   * Add a CPU fighter to fill an open slot. The bot has no socket; the host
   * drives its inputs locally during a round. Lets 1 human play a real match.
   */
  addBot() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (this.players.size >= this.capacity()) return { ok: false, reason: 'game-full' };
    let n = 1;
    while (this.players.has('bot-' + n)) n++;
    let name = 'CPU';
    if (this.nameIsTaken(name)) { let k = 2; while (this.nameIsTaken('CPU ' + k)) k++; name = 'CPU ' + k; }
    const bot = makePlayer('bot-' + n, name, null);
    bot.isBot = true;
    bot.order = this._orderSeq++;
    this.players.set(bot.id, bot);
    return { ok: true, player: bot };
  }

  reconnectPlayer({ playerId, socketId }) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    p.socketId = socketId;
    p.connected = true;
    return { ok: true, player: p };
  }

  markDisconnected(socketId) {
    for (const p of this.players.values()) {
      if (p.socketId === socketId) {
        p.connected = false;
        return p;
      }
    }
    return null;
  }

  /** Kicking is lobby-only: once the match starts the roster is locked. */
  removePlayer(playerId) {
    if (this.phase !== PHASES.LOBBY) return null;
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    return p;
  }

  /**
   * Reorder a player to sit just before `beforeId` (or at the end if null/
   * unknown), renumbering everyone's `order`. Order = seat = color = spawn.
   */
  reorderPlayer(playerId, beforeId) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    const list = Array.from(this.players.values())
      .filter((q) => q.id !== playerId)
      .sort((a, b) => a.order - b.order);
    let idx = beforeId ? list.findIndex((q) => q.id === beforeId) : -1;
    if (idx < 0) idx = list.length;
    list.splice(idx, 0, p);
    list.forEach((q, i) => { q.order = i; });
    return { ok: true };
  }

  // ---------------- Lobby config ----------------

  setRoundLength(sec) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const n = Math.round(Number(sec));
    if (!Number.isFinite(n)) return { ok: false, reason: 'bad-duration' };
    this.roundLengthSec = Math.min(MAX_ROUND_SEC, Math.max(MIN_ROUND_SEC, n));
    this.match.clockMs = this.roundLengthSec * 1000;
    return { ok: true };
  }

  setRoundsToWin(n) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return { ok: false, reason: 'bad-rounds' };
    this.roundsToWin = Math.min(MAX_ROUNDS_TO_WIN, Math.max(MIN_ROUNDS_TO_WIN, v));
    return { ok: true };
  }

  setItems(on) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    this.items = !!on;
    return { ok: true };
  }

  setStageSet(set) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (STAGE_SETS.indexOf(set) < 0) return { ok: false, reason: 'bad-stage-set' };
    this.stageSet = set;
    return { ok: true };
  }

  setBotDifficulty(level) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (BOT_DIFFICULTIES.indexOf(level) < 0) return { ok: false, reason: 'bad-difficulty' };
    this.botDifficulty = level;
    return { ok: true };
  }

  canStart() {
    if (this.phase !== PHASES.LOBBY) return false;
    return this.players.size >= MIN_PLAYERS && this.players.size <= MAX_PLAYERS;
  }

  // ---------------- Match lifecycle (meta only) ----------------

  /** Ordered roster the host uses to spawn fighters (seat = color + spawn). */
  getRoster() {
    const sorted = Array.from(this.players.values()).sort((a, b) => a.order - b.order);
    return sorted.map((p, seat) => publicPlayer(p, seat));
  }

  startMatch() {
    if (!this.canStart()) return { ok: false, reason: 'cannot-start' };
    this.phase = PHASES.PLAYING;
    this.match = this._freshMatch();
    const roster = this.getRoster();
    for (const r of roster) {
      this.match.gamePoints[r.id] = 0;
      this.match.alive[r.id] = true;
      this.match.hud[r.id] = { dmg: 0, item: '', glove: false };
    }
    return { ok: true, roster };
  }

  /** Same players, same settings — straight back into a new match. */
  rematch() {
    if (this.phase !== PHASES.FINAL) return { ok: false, reason: 'not-final' };
    this.phase = PHASES.LOBBY;
    const res = this.startMatch();
    if (!res.ok) this.phase = PHASES.FINAL;
    return res;
  }

  // Host pushes live meta as rounds run. These keep the cache fresh.
  setLive(live) { this.match.live = !!live; }
  setPaused(on) { this.match.paused = !!on; }
  setSuddenDeath(on) { this.match.suddenDeath = !!on; }
  setRoundOver(on) { this.match.roundOver = !!on; }

  /** Reactions are a downtime-only thing: lobby, between-round results, final. */
  reactionsOpen() {
    if (this.phase === PHASES.LOBBY || this.phase === PHASES.FINAL) return true;
    return this.phase === PHASES.PLAYING && this.match.roundOver;
  }
  setRound(round, seed, stage) {
    if (Number.isFinite(round)) this.match.round = round | 0;
    if (Number.isFinite(seed)) this.match.seed = seed >>> 0;
    if (typeof stage === 'string' && /^[a-z]{1,20}$/.test(stage)) this.match.stage = stage;
  }
  setClock(ms) {
    if (Number.isFinite(ms)) this.match.clockMs = Math.max(0, Math.round(ms));
  }
  setGamePoints(gp) {
    if (gp && typeof gp === 'object') {
      for (const id of Object.keys(gp)) {
        if (this.players.has(id) && Number.isFinite(gp[id])) this.match.gamePoints[id] = gp[id] | 0;
      }
    }
  }
  setAlive(alive) {
    if (alive && typeof alive === 'object') {
      for (const id of Object.keys(alive)) {
        if (this.players.has(id)) this.match.alive[id] = !!alive[id];
      }
    }
  }
  setHud(id, hud) {
    if (!this.players.has(id) || !hud || typeof hud !== 'object') return null;
    const clean = {
      dmg: clampInt(hud.dmg, 0, 999, 0),
      item: ITEM_TYPES.indexOf(hud.item) >= 0 ? hud.item : '',
      glove: !!hud.glove,
    };
    this.match.hud[id] = clean;
    return clean;
  }

  endMatch({ winnerIds, gamePoints } = {}) {
    this.phase = PHASES.FINAL;
    this.match.live = false;
    this.match.suddenDeath = false;
    if (gamePoints) this.setGamePoints(gamePoints);
    this.match.winnerIds = Array.isArray(winnerIds) ? winnerIds.filter((id) => this.players.has(id)) : [];
  }

  reset(keepConfig) {
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this._orderSeq = 0;
    if (!keepConfig) {
      this.roundLengthSec = DEFAULT_ROUND_SEC;
      this.roundsToWin = DEFAULT_ROUNDS_TO_WIN;
      this.items = true;
      this.stageSet = DEFAULT_STAGE_SET;
      this.botDifficulty = DEFAULT_BOT_DIFFICULTY;
    }
    this.match = this._freshMatch();
  }

  // ---------------- Public payloads ----------------

  getConfig() {
    return {
      roundLengthSec: this.roundLengthSec,
      roundsToWin: this.roundsToWin,
      items: this.items,
      stageSet: this.stageSet,
      botDifficulty: this.botDifficulty,
    };
  }

  getLobby() {
    return Object.assign(this.getConfig(), {
      phase: this.phase,
      capacity: this.capacity(),
      minPlayers: MIN_PLAYERS,
      players: this.getRoster(),
      total: this.players.size,
      canStart: this.canStart(),
    });
  }

  getMatchMeta() {
    return Object.assign(this.getConfig(), {
      roster: this.getRoster(),
      round: this.match.round,
      seed: this.match.seed,
      stage: this.match.stage,
      clockMs: this.match.clockMs,
      live: this.match.live,
      paused: this.match.paused,
      roundOver: this.match.roundOver,
      suddenDeath: this.match.suddenDeath,
      gamePoints: this.match.gamePoints,
      alive: this.match.alive,
      hud: this.match.hud,
      winnerIds: this.match.winnerIds,
    });
  }
}

function publicPlayer(p, seat) {
  return {
    id: p.id,
    name: p.name,
    seat,
    color: PLAYER_COLORS[seat % PLAYER_COLORS.length],
    connected: p.connected,
    isBot: !!p.isBot,
  };
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function makePlayer(id, name, socketId) {
  return {
    id,
    name,
    socketId,
    connected: true,
    joinedAt: Date.now(),
    order: 0,
    isBot: false,
  };
}

module.exports = {
  Game,
  PHASES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MIN_ROUND_SEC,
  MAX_ROUND_SEC,
  DEFAULT_ROUND_SEC,
  MIN_ROUNDS_TO_WIN,
  MAX_ROUNDS_TO_WIN,
  DEFAULT_ROUNDS_TO_WIN,
  BOT_DIFFICULTIES,
  DEFAULT_BOT_DIFFICULTY,
  STAGE_SETS,
  PLAYER_COLORS,
};
