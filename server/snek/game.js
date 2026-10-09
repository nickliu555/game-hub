'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Snek — server-side lobby + match-meta state machine.
//
// Like Chomp-Man, the live game (grid, movement, collisions, food) runs on the
// HOST browser for the lowest possible input latency (player -> server -> host
// is a single relay hop). This module does NOT simulate the game. It owns:
//   • the lobby: 1–4 snakes (humans + Add-CPU bots), rounds-to-win + round
//     length config. Exactly one human and no CPUs = SOLO (classic Snake).
//   • a CACHE of match meta (mode, round, stage, per-snake length, round wins,
//     who is alive, clock, last round result, solo result) that the host pushes
//     as rounds run, so reconnecting phones and a refreshed host can be
//     restored to the right screen.
//   • the solo "best this session" high score.
//
// The transport layer (./index.js) owns socket events + broadcasting.
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
  FINAL: 'FINAL',
};

// Stage within PLAYING. 'roundover' is the between-rounds results screen.
const STAGES = {
  COUNTDOWN: 'countdown',
  PLAY: 'play',
  ROUNDOVER: 'roundover',
};

const MIN_PLAYERS = 1;
const MAX_PLAYERS = 4;

const MAX_NAME_LEN = 20;

const MIN_ROUND_SEC = 30;
const MAX_ROUND_SEC = 120;
const ROUND_SEC_STEP = 15;
const DEFAULT_ROUND_SEC = 60;

const MIN_ROUNDS_TO_WIN = 1;
const MAX_ROUNDS_TO_WIN = 7;
const DEFAULT_ROUNDS_TO_WIN = 3;

// Snake colours by seat. Chosen to read clearly against the red apples and
// the dark-green board.
const PLAYER_COLORS = ['#4ADE80', '#FACC15', '#60A5FA', '#F472B6'];

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    this.roundLengthSec = DEFAULT_ROUND_SEC;
    this.roundsToWin = DEFAULT_ROUNDS_TO_WIN;
    this.powerups = true;   // multiplayer power-ups (Magnet / Phantom)
    this._orderSeq = 0;
    /** @type {Map<string, object>} */
    this.players = new Map();
    this.soloBest = null; // { score, name } — best solo length this session (cleared on any return to the lobby)
    this.match = this._freshMatch();
  }

  _freshMatch() {
    return {
      mode: 'multi',      // 'solo' | 'multi' (fixed when the match starts)
      round: 1,
      mapIndex: 0,
      stage: STAGES.COUNTDOWN,
      clockMs: this.roundLengthSec * 1000,
      live: false,        // true only while controls are active (host:play)
      paused: false,
      lengths: {},        // playerId -> current snake length
      gamePoints: {},     // playerId -> rounds won
      alive: {},          // playerId -> bool (alive this round)
      lastRound: null,    // { round, winnerId, draw, reason }
      winnerIds: [],      // final: id(s) that reached roundsToWin
      awards: [],         // final: award cards (host-pushed)
      solo: null,         // final (solo): { score, length, newBest }
      powers: {},         // playerId -> { power, untilMs } (active power-up, for phone reconnects)
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

  /** Add a CPU snake to fill an open seat. Bots have no socket; the host drives them. */
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

  /** Kicking is lobby-only: once the game starts the roster is locked. */
  removePlayer(playerId) {
    if (this.phase !== PHASES.LOBBY) return null;
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    return p;
  }

  /** Reorder a player to sit just before `beforeId` (or last). Order = seat = colour = spawn. */
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
    const n = Number(sec);
    if (!Number.isFinite(n)) return { ok: false, reason: 'bad-duration' };
    const snapped = Math.round(n / ROUND_SEC_STEP) * ROUND_SEC_STEP;
    this.roundLengthSec = Math.min(MAX_ROUND_SEC, Math.max(MIN_ROUND_SEC, snapped));
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

  setPowerups(on) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    this.powerups = !!on;
    return { ok: true };
  }

  /** Track a snake's active power-up (sec <= 0 clears it). */
  setPower(id, power, sec) {
    if (!this.players.has(id)) return;
    if (!(sec > 0) || (power !== 'magnet' && power !== 'phantom')) { delete this.match.powers[id]; return; }
    this.match.powers[id] = { power, untilMs: Date.now() + Math.round(sec * 1000) };
  }
  clearPowers() { this.match.powers = {}; }
  activePowers() {
    const out = {}, now = Date.now();
    for (const id of Object.keys(this.match.powers)) {
      const v = this.match.powers[id];
      if (v.untilMs > now) out[id] = { power: v.power, sec: (v.untilMs - now) / 1000 };
    }
    return out;
  }

  /** A single snake (human or CPU) plays classic solo Snake; 2+ is multiplayer. */
  lobbyMode() {
    return this.players.size === 1 ? 'solo' : 'multi';
  }

  canStart() {
    if (this.phase !== PHASES.LOBBY) return false;
    return this.players.size >= MIN_PLAYERS && this.players.size <= MAX_PLAYERS;
  }

  // ---------------- Match lifecycle (meta only) ----------------

  /** Ordered roster (by seat) the host uses to spawn snakes. */
  getRoster() {
    const sorted = Array.from(this.players.values()).sort((a, b) => a.order - b.order);
    return sorted.map((p, seat) => ({
      id: p.id,
      name: p.name,
      seat,
      color: PLAYER_COLORS[seat % PLAYER_COLORS.length],
      connected: p.connected,
      isBot: !!p.isBot,
    }));
  }

  startMatch() {
    if (!this.canStart()) return { ok: false, reason: 'cannot-start' };
    const mode = this.lobbyMode();
    this.phase = PHASES.PLAYING;
    this.match = this._freshMatch();
    this.match.mode = mode;
    const roster = this.getRoster();
    for (const r of roster) {
      this.match.lengths[r.id] = 0;
      this.match.gamePoints[r.id] = 0;
      this.match.alive[r.id] = true;
    }
    return { ok: true, roster, mode };
  }

  /** Final screen → same roster, straight into a fresh match. */
  rematch() {
    if (this.phase !== PHASES.FINAL) return { ok: false, reason: 'not-final' };
    this.phase = PHASES.LOBBY;
    return this.startMatch();
  }

  setLive(live) { this.match.live = !!live; }
  setPaused(on) { this.match.paused = !!on; }
  setStage(stage) {
    if (stage === STAGES.COUNTDOWN || stage === STAGES.PLAY || stage === STAGES.ROUNDOVER) this.match.stage = stage;
  }
  setRound(round, mapIndex) {
    if (Number.isFinite(round)) this.match.round = round | 0;
    if (Number.isFinite(mapIndex)) this.match.mapIndex = mapIndex | 0;
  }
  setClock(ms) {
    if (Number.isFinite(ms)) this.match.clockMs = Math.max(0, Math.round(ms));
  }
  setLengths(lengths) {
    if (lengths && typeof lengths === 'object') {
      for (const id of Object.keys(lengths)) {
        if (this.players.has(id) && Number.isFinite(lengths[id])) this.match.lengths[id] = lengths[id] | 0;
      }
    }
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
  setAllAlive() {
    for (const id of this.players.keys()) this.match.alive[id] = true;
  }
  setLastRound({ round, winnerId, draw, reason } = {}) {
    this.match.lastRound = {
      round: Number.isFinite(round) ? round | 0 : this.match.round,
      winnerId: (winnerId && this.players.has(winnerId)) ? winnerId : null,
      draw: !!draw,
      reason: typeof reason === 'string' ? reason.slice(0, 20) : '',
    };
  }

  endMatch({ winnerIds, gamePoints, awards, soloScore, soloLength } = {}) {
    this.phase = PHASES.FINAL;
    this.match.live = false;
    this.match.paused = false;
    if (gamePoints) this.setGamePoints(gamePoints);
    this.match.winnerIds = Array.isArray(winnerIds) ? winnerIds.filter((id) => this.players.has(id)) : [];
    this.match.awards = Array.isArray(awards) ? awards.slice(0, 12) : [];
    if (this.match.mode === 'solo') {
      const score = Math.max(0, Number.isFinite(soloScore) ? soloScore | 0 : 0);
      const length = Math.max(0, Number.isFinite(soloLength) ? soloLength | 0 : 0);
      const roster = this.getRoster();
      const name = roster.length ? roster[0].name : '';
      // The session best is for people to chase — a CPU's solo run never sets it.
      const isBot = roster.length > 0 && roster[0].isBot;
      const newBest = !isBot && (!this.soloBest || score > this.soloBest.score);
      if (newBest) this.soloBest = { score, name };
      this.match.solo = { score, length, newBest: newBest && score > 0 };
    }
  }

  /** Back to an empty lobby. keepConfig keeps the lobby settings; the solo best
   *  is per session, so it is always cleared (only "Play again" keeps it). */
  reset(keepConfig) {
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.soloBest = null;
    this._orderSeq = 0;
    if (!keepConfig) {
      this.roundLengthSec = DEFAULT_ROUND_SEC;
      this.roundsToWin = DEFAULT_ROUNDS_TO_WIN;
      this.powerups = true;
    }
    this.match = this._freshMatch();
  }

  clearSoloBest() { this.soloBest = null; }

  /** Reactions are a downtime-only thing: lobby, between-round results, final. */
  reactionsOpen() {
    if (this.phase === PHASES.LOBBY || this.phase === PHASES.FINAL) return true;
    return this.phase === PHASES.PLAYING && this.match.stage === STAGES.ROUNDOVER;
  }

  // ---------------- Public payloads ----------------

  getLobby() {
    return {
      phase: this.phase,
      capacity: this.capacity(),
      minPlayers: MIN_PLAYERS,
      roundLengthSec: this.roundLengthSec,
      roundsToWin: this.roundsToWin,
      powerups: this.powerups,
      mode: this.lobbyMode(),
      soloBest: this.soloBest,
      players: this.getRoster(),
      total: this.players.size,
      canStart: this.canStart(),
    };
  }

  getMatchMeta() {
    return {
      mode: this.match.mode,
      roundLengthSec: this.roundLengthSec,
      roundsToWin: this.roundsToWin,
      powerups: this.powerups,
      powers: this.activePowers(),
      roster: this.getRoster(),
      round: this.match.round,
      mapIndex: this.match.mapIndex,
      stage: this.match.stage,
      clockMs: this.match.clockMs,
      live: this.match.live,
      paused: this.match.paused,
      lengths: this.match.lengths,
      gamePoints: this.match.gamePoints,
      alive: this.match.alive,
      lastRound: this.match.lastRound,
      winnerIds: this.match.winnerIds,
      awards: this.match.awards,
      solo: this.match.solo,
      soloBest: this.soloBest,
    };
  }
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
  STAGES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MIN_ROUND_SEC,
  MAX_ROUND_SEC,
  ROUND_SEC_STEP,
  DEFAULT_ROUND_SEC,
  MIN_ROUNDS_TO_WIN,
  MAX_ROUNDS_TO_WIN,
  DEFAULT_ROUNDS_TO_WIN,
  PLAYER_COLORS,
};
