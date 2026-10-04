'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Nong — server-side lobby + match-meta state machine.
//
// Like Nockey, the live match (ball + paddles) is simulated on the HOST browser
// so controller input travels player -> server -> host in a single relay hop.
// This module owns:
//   • the lobby: 2–4 seats (humans + CPU paddles) and the target setting
//   • a CACHE of match meta (points / lives, eliminations) pushed by the host,
//     so reconnecting phones and a refreshed host land on the right screen
//
// Two scoring modes, picked by the roster size at kick-off:
//   • 2 players  → 'points': first to `pointsToWin`
//   • 3–4 players → 'lives': everyone starts with `lives`; a ball past your
//     paddle costs one, at zero you are out and your side is walled off
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
  FINAL: 'FINAL',
};

const CAPACITY = 4;
const MIN_PLAYERS = 2;
const MAX_NAME_LEN = 20;

const POINT_OPTIONS = [3, 5, 7, 11];
const LIFE_OPTIONS = [1, 3, 5, 7];
const DEFAULT_POINTS = 5;
const DEFAULT_LIVES = 3;

// Seat colours, in seat order. Sent to the clients in the roster payload.
const SEAT_COLORS = [
  { name: 'Pink', hex: '#FF4D8D' },
  { name: 'Cyan', hex: '#38E1FF' },
  { name: 'Yellow', hex: '#FFD23F' },
  { name: 'Lime', hex: '#7CFF6B' },
];

// Which way each seat's paddle runs on the host screen, so the phone can show a
// matching slider. Must mirror the arena layouts in public/nong/js/engine.js:
//   2P rectangle: seat 0 left, seat 1 right              → both vertical
//   3P triangle:  seat 0 base, seat 1 right, seat 2 left → base horizontal
//   4P diamond:   all four sides are diagonal            → horizontal
function axisFor(count, seat) {
  if (count === 2) return 'v';
  if (count === 3) return seat === 0 ? 'h' : 'v';
  return 'h';
}

function modeFor(count) { return count >= 3 ? 'lives' : 'points'; }

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    this.pointsToWin = DEFAULT_POINTS;
    this.lives = DEFAULT_LIVES;
    this._orderSeq = 0;
    /** @type {Map<string, object>} */
    this.players = new Map();
    this.roster = [];
    this.match = this._freshMatch();
  }

  _freshMatch() {
    return {
      mode: 'points',
      target: this.pointsToWin,
      scores: {},     // id -> points (points mode) or lives left (lives mode)
      out: [],        // ids in the order they were eliminated
      live: false,
      paused: false,
      winnerId: null,
      placings: [],
    };
  }

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

  sorted() {
    return Array.from(this.players.values()).sort((a, b) => a.order - b.order);
  }

  addPlayer({ playerId, name, socketId }) {
    if (!playerId || typeof playerId !== 'string') return { ok: false, reason: 'bad-player-id' };
    if (this.players.has(playerId)) return this.reconnectPlayer({ playerId, socketId });
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'round-in-progress' };
    if (this.players.size >= CAPACITY) return { ok: false, reason: 'game-full' };
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) return { ok: false, reason: 'name-taken', name: clean };
    const player = makePlayer(playerId, clean, socketId);
    player.order = this._orderSeq++;
    this.players.set(playerId, player);
    return { ok: true, player };
  }

  /** A CPU paddle. Bots have no socket; the host drives them locally. */
  addBot() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (this.players.size >= CAPACITY) return { ok: false, reason: 'game-full' };
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
      if (p.socketId === socketId) { p.connected = false; return p; }
    }
    return null;
  }

  // Kicking is lobby-only: once the match starts the roster is locked.
  removePlayer(playerId) {
    if (this.phase !== PHASES.LOBBY) return null;
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    return p;
  }

  // ---------------- Lobby config ----------------

  /** Move `playerId` to the seat just before `beforeId` (or to the end). Lobby-only. */
  reorder(playerId, beforeId) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    const rest = this.sorted().filter((q) => q.id !== playerId);
    let idx = beforeId ? rest.findIndex((q) => q.id === beforeId) : -1;
    if (idx < 0) idx = rest.length;
    rest.splice(idx, 0, p);
    rest.forEach((q, i) => { q.order = i; });
    this._orderSeq = rest.length;
    return { ok: true };
  }

  setTarget(mode, value) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const v = Math.round(Number(value));
    if (mode === 'points') {
      if (!POINT_OPTIONS.includes(v)) return { ok: false, reason: 'bad-target' };
      this.pointsToWin = v;
    } else if (mode === 'lives') {
      if (!LIFE_OPTIONS.includes(v)) return { ok: false, reason: 'bad-target' };
      this.lives = v;
    } else {
      return { ok: false, reason: 'bad-mode' };
    }
    return { ok: true };
  }

  humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  canStart() {
    return this.phase === PHASES.LOBBY &&
      this.players.size >= MIN_PLAYERS &&
      this.players.size <= CAPACITY &&
      this.humanCount() >= 1;
  }

  // ---------------- Match lifecycle (meta only) ----------------

  _buildRoster() {
    const list = this.sorted();
    const n = list.length;
    return list.map((p, seat) => ({
      id: p.id,
      name: p.name,
      seat,
      color: SEAT_COLORS[seat].hex,
      colorName: SEAT_COLORS[seat].name,
      axis: axisFor(n, seat),
      isBot: !!p.isBot,
      connected: p.connected,
    }));
  }

  getRoster() {
    // The roster is frozen at kick-off; only connection flags stay live.
    return this.roster.map((r) => {
      const p = this.players.get(r.id);
      return Object.assign({}, r, { connected: p ? p.connected : false });
    });
  }

  startMatch() {
    if (!this.canStart()) return { ok: false, reason: 'cannot-start' };
    this.phase = PHASES.PLAYING;
    this.roster = this._buildRoster();
    this.match = this._freshMatch();
    this.match.mode = modeFor(this.roster.length);
    this.match.target = this.match.mode === 'lives' ? this.lives : this.pointsToWin;
    for (const r of this.roster) {
      this.match.scores[r.id] = this.match.mode === 'lives' ? this.match.target : 0;
    }
    return { ok: true, meta: this.getMatchMeta() };
  }

  isRosterId(id) { return this.roster.some((r) => r.id === id); }

  /** Accept host-pushed scores, clamped to the roster and the match target. */
  setScores(scores, out) {
    if (scores && typeof scores === 'object') {
      for (const r of this.roster) {
        const v = scores[r.id];
        if (Number.isFinite(v)) {
          this.match.scores[r.id] = Math.max(0, Math.min(this.match.target, Math.round(v)));
        }
      }
    }
    if (Array.isArray(out) && this.match.mode === 'lives') {
      const seen = new Set();
      this.match.out = out.filter((id) => {
        if (typeof id !== 'string' || seen.has(id) || !this.isRosterId(id)) return false;
        seen.add(id);
        return true;
      }).slice(0, Math.max(0, this.roster.length - 1));
    }
  }

  setLive(live) { this.match.live = !!live; }
  setPaused(on) { this.match.paused = !!on; }

  endMatch({ winnerId, scores, out } = {}) {
    if (this.phase !== PHASES.PLAYING) return { ok: false, reason: 'not-playing' };
    this.setScores(scores, out);
    this.phase = PHASES.FINAL;
    this.match.live = false;
    this.match.paused = false;
    this.match.winnerId = this.isRosterId(winnerId) ? winnerId : null;
    this.match.placings = this.computePlacings();
    return { ok: true };
  }

  computePlacings() {
    const ids = this.roster.map((r) => r.id);
    const byScore = (a, b) => {
      if (a === this.match.winnerId) return -1;
      if (b === this.match.winnerId) return 1;
      return (this.match.scores[b] || 0) - (this.match.scores[a] || 0);
    };
    if (this.match.mode === 'points') return ids.slice().sort(byScore);
    // Lives: the survivors first (winner on top), then the eliminated in reverse
    // order of elimination — the last one out places highest.
    const out = this.match.out.slice();
    const alive = ids.filter((id) => !out.includes(id)).sort(byScore);
    return alive.concat(out.reverse());
  }

  reset(keepConfig) {
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this._orderSeq = 0;
    this.roster = [];
    if (!keepConfig) {
      this.pointsToWin = DEFAULT_POINTS;
      this.lives = DEFAULT_LIVES;
    }
    this.match = this._freshMatch();
  }

  // ---------------- Public payloads ----------------

  getLobby() {
    const list = this.sorted();
    const n = list.length;
    return {
      phase: this.phase,
      capacity: CAPACITY,
      minPlayers: MIN_PLAYERS,
      total: n,
      players: list.map((p, seat) => ({
        id: p.id,
        name: p.name,
        seat,
        color: SEAT_COLORS[seat].hex,
        colorName: SEAT_COLORS[seat].name,
        connected: p.connected,
        isBot: !!p.isBot,
      })),
      mode: modeFor(n),
      pointsToWin: this.pointsToWin,
      lives: this.lives,
      pointOptions: POINT_OPTIONS,
      lifeOptions: LIFE_OPTIONS,
      canStart: this.canStart(),
    };
  }

  getMatchMeta() {
    return {
      roster: this.getRoster(),
      mode: this.match.mode,
      target: this.match.target,
      scores: Object.assign({}, this.match.scores),
      out: this.match.out.slice(),
      live: this.match.live,
      paused: this.match.paused,
      winnerId: this.match.winnerId,
      placings: this.match.placings.slice(),
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
  CAPACITY,
  MIN_PLAYERS,
  POINT_OPTIONS,
  LIFE_OPTIONS,
  DEFAULT_POINTS,
  DEFAULT_LIVES,
  SEAT_COLORS,
  axisFor,
  modeFor,
};
