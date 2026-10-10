'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Blob Ball — server-side lobby + match-meta state machine.
//
// Like Nong, the live match (blobs + ball) is simulated on the HOST browser so
// controller input travels player -> server -> host in a single relay hop.
// This module owns:
//   • the lobby: two seats (left / right side of the net), humans or a CPU,
//     and the points-to-win setting
//   • a CACHE of match meta (scores, server) pushed by the host, so
//     reconnecting phones and a refreshed host land on the right screen
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
  FINAL: 'FINAL',
};

const CAPACITY = 2;
const MIN_PLAYERS = 2;
const MAX_NAME_LEN = 20;

const POINT_OPTIONS = [5, 7, 10, 12, 15];
const DEFAULT_POINTS = 10;

// Seat 0 plays the left side of the net, seat 1 the right.
const SEAT_COLORS = [
  { name: 'Green', hex: '#5BE06B', side: 'Left side' },
  { name: 'Pink', hex: '#FF5C8D', side: 'Right side' },
];

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    this.pointsToWin = DEFAULT_POINTS;
    this._orderSeq = 0;
    /** @type {Map<string, object>} */
    this.players = new Map();
    this.roster = [];
    this.match = this._freshMatch();
  }

  _freshMatch() {
    return {
      target: this.pointsToWin,
      scores: {},
      live: false,
      paused: false,
      winnerId: null,
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

  /** A CPU blob. Bots have no socket; the host drives them locally. */
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
    // Close the gap so a lone remaining player always holds the left seat.
    this.sorted().forEach((q, i) => { q.order = i; });
    this._orderSeq = this.players.size;
    return p;
  }

  // ---------------- Lobby config ----------------

  /** Swap which side of the net each seated player plays. Lobby-only. */
  swapSides() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const list = this.sorted();
    if (list.length < 2) return { ok: false, reason: 'need-two' };
    const t = list[0].order;
    list[0].order = list[1].order;
    list[1].order = t;
    return { ok: true };
  }

  setTarget(value) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const v = Math.round(Number(value));
    if (!POINT_OPTIONS.includes(v)) return { ok: false, reason: 'bad-target' };
    this.pointsToWin = v;
    return { ok: true };
  }

  canStart() {
    return this.phase === PHASES.LOBBY && this.players.size === CAPACITY;
  }

  // Reactions are downtime-only: the lobby and the final results.
  reactionsOpen() {
    return this.phase === PHASES.LOBBY || this.phase === PHASES.FINAL;
  }

  // ---------------- Match lifecycle (meta only) ----------------

  _buildRoster() {
    return this.sorted().map((p, seat) => ({
      id: p.id,
      name: p.name,
      seat,
      color: SEAT_COLORS[seat].hex,
      colorName: SEAT_COLORS[seat].name,
      side: SEAT_COLORS[seat].side,
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
    for (const r of this.roster) this.match.scores[r.id] = 0;
    return { ok: true, meta: this.getMatchMeta() };
  }

  /** Same players, same sides, same target — straight back into a new match. */
  rematch() {
    if (this.phase !== PHASES.FINAL) return { ok: false, reason: 'not-final' };
    this.phase = PHASES.LOBBY;
    const res = this.startMatch();
    if (!res.ok) this.phase = PHASES.FINAL;
    return res;
  }

  isRosterId(id) { return this.roster.some((r) => r.id === id); }

  /** Accept host-pushed scores, clamped to the roster and the match target. */
  setScores(scores) {
    if (!scores || typeof scores !== 'object') return;
    for (const r of this.roster) {
      const v = scores[r.id];
      if (Number.isFinite(v)) {
        this.match.scores[r.id] = Math.max(0, Math.min(this.match.target, Math.round(v)));
      }
    }
  }

  setLive(live) { this.match.live = !!live; }
  setPaused(on) { this.match.paused = !!on; }

  endMatch({ winnerId, scores } = {}) {
    if (this.phase !== PHASES.PLAYING) return { ok: false, reason: 'not-playing' };
    this.setScores(scores);
    this.phase = PHASES.FINAL;
    this.match.live = false;
    this.match.paused = false;
    this.match.winnerId = this.isRosterId(winnerId) ? winnerId : null;
    return { ok: true };
  }

  reset(keepConfig) {
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this._orderSeq = 0;
    this.roster = [];
    if (!keepConfig) this.pointsToWin = DEFAULT_POINTS;
    this.match = this._freshMatch();
  }

  // ---------------- Public payloads ----------------

  getLobby() {
    const list = this.sorted();
    return {
      phase: this.phase,
      capacity: CAPACITY,
      minPlayers: MIN_PLAYERS,
      total: list.length,
      players: list.map((p, seat) => ({
        id: p.id,
        name: p.name,
        seat,
        color: SEAT_COLORS[seat].hex,
        colorName: SEAT_COLORS[seat].name,
        side: SEAT_COLORS[seat].side,
        connected: p.connected,
        isBot: !!p.isBot,
      })),
      pointsToWin: this.pointsToWin,
      pointOptions: POINT_OPTIONS,
      canStart: this.canStart(),
    };
  }

  getMatchMeta() {
    return {
      roster: this.getRoster(),
      target: this.match.target,
      scores: Object.assign({}, this.match.scores),
      live: this.match.live,
      paused: this.match.paused,
      winnerId: this.match.winnerId,
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
  DEFAULT_POINTS,
  SEAT_COLORS,
};
