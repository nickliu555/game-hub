'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Blob Ball — server-side lobby + match-meta state machine.
//
// Like Nong, the live match (blobs + ball) is simulated on the HOST browser so
// controller input travels player -> server -> host in a single relay hop.
// This module owns:
//   • the lobby: two sides of the net with up to two blobs each (humans or
//     CPUs) and the points-to-win setting. 1–2 players is 1v1; 3–4 switches
//     to team play (2v1 / 2v2) on a wider court automatically.
//   • a CACHE of match meta (scores, server) pushed by the host, so
//     reconnecting phones and a refreshed host land on the right screen
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
  FINAL: 'FINAL',
};

const CAPACITY = 4;
const TEAM_SIZE = 2;
const MIN_PLAYERS = 2;
const MAX_NAME_LEN = 20;

const POINT_OPTIONS = [5, 7, 10, 12, 15];
const DEFAULT_POINTS = 10;

// Seat (side) 0 plays the left of the net, 1 the right. A team shares a colour
// family: slot 0 wears the main shade, a teammate in slot 1 the second.
const SEAT_COLORS = [
  { name: 'Green', hex: '#5BE06B', side: 'Left side' },
  { name: 'Pink', hex: '#FF5C8D', side: 'Right side' },
];
const SLOT_COLORS = [
  [SEAT_COLORS[0], { name: 'Lime', hex: '#C8F04B', side: 'Left side' }],
  [SEAT_COLORS[1], { name: 'Rose', hex: '#FFA0C8', side: 'Right side' }],
];
function colorOf(side, slot) { return SLOT_COLORS[side][slot === 1 ? 1 : 0]; }

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
      teams: false,
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

  /** Left side first, then right; within a side by slot. */
  sorted() {
    return Array.from(this.players.values()).sort((a, b) => (a.side - b.side) || (a.slot - b.slot) || (a.order - b.order));
  }

  sideMembers(side) {
    return this.sorted().filter((p) => p.side === side);
  }

  /** 3–4 players switch to team play. */
  isTeams() { return this.players.size >= 3; }

  // A new player takes the side with fewer blobs (left on a tie), so joins
  // fill left, right, left, right.
  _place(p) {
    const left = this.sideMembers(0).length;
    const right = this.sideMembers(1).length;
    p.side = right < left ? 1 : 0;
    p.slot = this.sideMembers(p.side).length;
  }

  // Keep the seating sane after any join, kick or move: at most two a side,
  // slots packed from 0, a lone player always on the left, and two players
  // always on opposite sides.
  _normalize() {
    const list = this.sorted();
    if (list.length === 1) { list[0].side = 0; list[0].slot = 0; return; }
    if (list.length === 2 && list[0].side === list[1].side) {
      list[1].side = 1 - list[1].side;
      list[1].slot = 0;
    }
    for (const side of [0, 1]) {
      this.sideMembers(side).forEach((m, i) => { m.slot = i; });
    }
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
    this._place(player);
    this.players.set(playerId, player);
    this._normalize();
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
    this._place(bot);
    this.players.set(bot.id, bot);
    this._normalize();
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
    this._normalize();
    return p;
  }

  // ---------------- Lobby config ----------------

  /** Swap which side of the net every seated player plays. Lobby-only. */
  swapSides() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (this.players.size < 2) return { ok: false, reason: 'need-two' };
    for (const p of this.players.values()) p.side = 1 - p.side;
    this._normalize();
    return { ok: true };
  }

  /**
   * Drop a player onto a spot (side + slot): swaps with whoever is there, or
   * moves into it if it's open. Seating rules are then re-applied, so a move
   * that would leave one side empty in 1v1 is undone. Lobby-only.
   */
  movePlayer(playerId, side, slot) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if ((side !== 0 && side !== 1) || (slot !== 0 && slot !== 1)) return { ok: false, reason: 'bad-spot' };
    if (p.side === side && p.slot === slot) return { ok: true };
    const occupant = this.sorted().find((q) => q.side === side && q.slot === slot);
    if (occupant) {
      occupant.side = p.side;
      occupant.slot = p.slot;
    } else if (this.sideMembers(side).length >= TEAM_SIZE) {
      return { ok: false, reason: 'side-full' };
    }
    p.side = side;
    // An open spot past the side's last blob is just "the end of that side".
    p.slot = occupant ? slot : this.sideMembers(side).length;
    this._normalize();
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
    return this.phase === PHASES.LOBBY && this.sideMembers(0).length >= 1 && this.sideMembers(1).length >= 1;
  }

  // Reactions are downtime-only: the lobby and the final results.
  reactionsOpen() {
    return this.phase === PHASES.LOBBY || this.phase === PHASES.FINAL;
  }

  // ---------------- Match lifecycle (meta only) ----------------

  _seatInfo(p) {
    const c = colorOf(p.side, p.slot);
    return {
      seat: p.side,
      slot: p.slot,
      color: c.hex,
      colorName: c.name,
      side: c.side,
    };
  }

  _buildRoster() {
    return this.sorted().map((p) => Object.assign({
      id: p.id,
      name: p.name,
    }, this._seatInfo(p), {
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
    this.match.teams = this.isTeams();
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

  /**
   * Accept host-pushed scores, clamped to the roster and the match target.
   * Scores are per player id; teammates share their team's score.
   */
  setScores(scores) {
    if (!scores || typeof scores !== 'object') return;
    for (const r of this.roster) {
      const v = scores[r.id];
      if (Number.isFinite(v)) {
        this.match.scores[r.id] = Math.max(0, Math.min(this.match.target, Math.round(v)));
      }
    }
    if (!this.match.teams) return;
    for (const side of [0, 1]) {
      const team = this.roster.filter((r) => r.seat === side);
      const best = Math.max(0, ...team.map((r) => this.match.scores[r.id] || 0));
      team.forEach((r) => { this.match.scores[r.id] = best; });
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
      teamSize: TEAM_SIZE,
      minPlayers: MIN_PLAYERS,
      total: list.length,
      teams: this.isTeams(),
      mode: this.sideMembers(0).length + 'v' + this.sideMembers(1).length,
      players: list.map((p) => Object.assign({
        id: p.id,
        name: p.name,
      }, this._seatInfo(p), {
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
      teams: !!this.match.teams,
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
    side: 0,
    slot: 0,
    isBot: false,
  };
}

module.exports = {
  Game,
  PHASES,
  CAPACITY,
  MIN_PLAYERS,
  TEAM_SIZE,
  POINT_OPTIONS,
  DEFAULT_POINTS,
  SEAT_COLORS,
  SLOT_COLORS,
};
