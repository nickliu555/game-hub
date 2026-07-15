'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Sling Soccer — server-side lobby + turn/match-meta state machine.
//
// Like Soccer Head, the live game (top-down flick physics, turn resolution,
// scoring) runs on the HOST browser for the lowest possible input latency
// (player -> server -> host is a single relay hop). This module does NOT
// simulate the match. It owns:
//   • the lobby: players, red/blue teams (1–3 per side, ≥1 each), goal target
//   • a CACHE of match meta (scores, whose turn it is, the resting board
//     snapshot) pushed by the host as the match runs, so a reconnecting phone
//     or a refreshed host can be restored to the right screen/turn.
//
// The transport layer (./index.js) owns socket events + broadcasting and gates
// the per-turn aim relay on `currentPlayerId`.
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
  FINAL: 'FINAL',
};

const MAX_PER_TEAM = 3;   // up to 3 humans/CPUs share a side's 5 tokens
const MAX_PLAYERS = MAX_PER_TEAM * 2;

const MAX_NAME_LEN = 20;

const MIN_GOAL_TARGET = 1;
const MAX_GOAL_TARGET = 10;
const DEFAULT_GOAL_TARGET = 3;

const TEAMS = ['red', 'blue'];

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    this.goalTarget = DEFAULT_GOAL_TARGET;
    // Monotonic counter giving each player an `order` for stable, reorderable
    // seat ordering within a team — this IS the round-robin rotation order.
    this._orderSeq = 0;
    /** @type {Map<string, object>} */
    this.players = new Map();
    // Cache of the live match state, kept fresh by host:* events.
    this.match = this._freshMatch();
  }

  _freshMatch() {
    return {
      redScore: 0,
      blueScore: 0,
      goalTarget: this.goalTarget,
      currentTeam: null,      // 'red' | 'blue' — whose turn it is
      currentPlayerId: null,  // player id allowed to aim right now
      currentPlayerName: null,
      winner: null,           // 'red' | 'blue' | null
      // Resting board snapshot pushed by the host each turn boundary so a host
      // refresh can restore the exact positions (turn-based => cheap + exact).
      board: null,            // { tokens: [{team,idx,x,y}], ball: {x,y} }
    };
  }

  capacity() { return MAX_PLAYERS; }
  perTeam() { return MAX_PER_TEAM; }

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

  teamCount(team) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
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
    const team = this._emptierTeam();
    // A side is capped at MAX_PER_TEAM; if the emptier side is full the other
    // side must have room (total < capacity was checked above).
    const chosen = this.teamCount(team) < MAX_PER_TEAM ? team : (team === 'red' ? 'blue' : 'red');
    const player = makePlayer(playerId, clean, socketId, chosen);
    player.order = this._orderSeq++;
    this.players.set(playerId, player);
    return { ok: true, player };
  }

  _emptierTeam() {
    return this.teamCount('red') <= this.teamCount('blue') ? 'red' : 'blue';
  }

  /**
   * Add a CPU/bot player to fill a side. The bot has no socket; the host drives
   * its flick locally during the match. Enables solo play (1 human vs CPU).
   */
  addBot() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (this.players.size >= this.capacity()) return { ok: false, reason: 'game-full' };
    const team = this._emptierTeam();
    const chosen = this.teamCount(team) < MAX_PER_TEAM ? team : (team === 'red' ? 'blue' : 'red');
    let n = 1;
    while (this.players.has('bot-' + n)) n++;
    let name = 'CPU';
    if (this.nameIsTaken(name)) { let k = 2; while (this.nameIsTaken('CPU ' + k)) k++; name = 'CPU ' + k; }
    const bot = makePlayer('bot-' + n, name, null, chosen);
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

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    return p;
  }

  // ---------------- Lobby config ----------------

  setGoalTarget(n) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return { ok: false, reason: 'bad-target' };
    this.goalTarget = Math.min(MAX_GOAL_TARGET, Math.max(MIN_GOAL_TARGET, v));
    this.match.goalTarget = this.goalTarget;
    return { ok: true };
  }

  assignTeam(playerId, team, beforeId) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (!TEAMS.includes(team)) return { ok: false, reason: 'bad-team' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    // Moving to a DIFFERENT team must respect the per-team cap.
    if (p.team !== team && this.teamCount(team) >= MAX_PER_TEAM) {
      return { ok: false, reason: 'team-full' };
    }
    p.team = team;
    // Reorder within the (target) team: drop `p` just before `beforeId`, or at
    // the end if none/unknown. Renumbers the team's `order` so seats stay stable.
    const inTeam = Array.from(this.players.values())
      .filter((q) => q.team === team && q.id !== playerId)
      .sort((a, b) => a.order - b.order);
    let idx = beforeId ? inTeam.findIndex((q) => q.id === beforeId) : -1;
    if (idx < 0) idx = inTeam.length;
    inTeam.splice(idx, 0, p);
    inTeam.forEach((q, i) => { q.order = i; });
    return { ok: true };
  }

  canStart() {
    if (this.phase !== PHASES.LOBBY) return false;
    const red = this.teamCount('red');
    const blue = this.teamCount('blue');
    // At least one on each side; each side capped at MAX_PER_TEAM.
    return red >= 1 && blue >= 1 && red <= MAX_PER_TEAM && blue <= MAX_PER_TEAM;
  }

  // ---------------- Match lifecycle (meta only) ----------------

  /**
   * Ordered roster the host uses to build round-robin queues. Each side is
   * ordered by `order` (= lobby join / host-reordered seating).
   */
  getRoster() {
    const bySeat = { red: [], blue: [] };
    const sorted = Array.from(this.players.values()).sort((a, b) => a.order - b.order);
    for (const p of sorted) {
      const team = p.team === 'blue' ? 'blue' : 'red';
      bySeat[team].push(p);
    }
    const roster = [];
    for (const team of TEAMS) {
      bySeat[team].forEach((p, seat) => {
        roster.push({ id: p.id, name: p.name, team, seat, connected: p.connected, isBot: !!p.isBot });
      });
    }
    return roster;
  }

  startMatch() {
    if (!this.canStart()) return { ok: false, reason: 'cannot-start' };
    this.phase = PHASES.PLAYING;
    this.match = this._freshMatch();
    return { ok: true, roster: this.getRoster(), goalTarget: this.goalTarget };
  }

  // Host pushes live meta as the match runs. These keep the cache fresh.
  setTurn({ team, playerId, playerName, red, blue } = {}) {
    if (team === 'red' || team === 'blue') this.match.currentTeam = team;
    if (typeof playerId === 'string' || playerId === null) this.match.currentPlayerId = playerId;
    if (typeof playerName === 'string' || playerName === null) this.match.currentPlayerName = playerName;
    if (Number.isFinite(red)) this.match.redScore = red | 0;
    if (Number.isFinite(blue)) this.match.blueScore = blue | 0;
  }
  setScore(redScore, blueScore) {
    if (Number.isFinite(redScore)) this.match.redScore = redScore | 0;
    if (Number.isFinite(blueScore)) this.match.blueScore = blueScore | 0;
  }
  setBoard(board) {
    if (board && Array.isArray(board.tokens) && board.ball) this.match.board = board;
  }
  endMatch({ winner, redScore, blueScore } = {}) {
    this.phase = PHASES.FINAL;
    if (Number.isFinite(redScore)) this.match.redScore = redScore | 0;
    if (Number.isFinite(blueScore)) this.match.blueScore = blueScore | 0;
    this.match.winner = winner === 'red' || winner === 'blue' ? winner : null;
    this.match.currentPlayerId = null;
    this.match.currentTeam = null;
  }

  reset(keepConfig) {
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this._orderSeq = 0;
    if (!keepConfig) {
      this.goalTarget = DEFAULT_GOAL_TARGET;
    }
    this.match = this._freshMatch();
  }

  // ---------------- Public payloads ----------------

  getLobby() {
    const red = [];
    const blue = [];
    const sorted = Array.from(this.players.values()).sort((a, b) => a.order - b.order);
    for (const p of sorted) {
      (p.team === 'blue' ? blue : red).push({ id: p.id, name: p.name, connected: p.connected, isBot: !!p.isBot });
    }
    return {
      phase: this.phase,
      goalTarget: this.goalTarget,
      capacity: this.capacity(),
      perTeam: this.perTeam(),
      teams: { red, blue },
      total: this.players.size,
      canStart: this.canStart(),
    };
  }

  getMatchMeta() {
    return {
      goalTarget: this.goalTarget,
      roster: this.getRoster(),
      redScore: this.match.redScore,
      blueScore: this.match.blueScore,
      currentTeam: this.match.currentTeam,
      currentPlayerId: this.match.currentPlayerId,
      currentPlayerName: this.match.currentPlayerName,
      winner: this.match.winner,
      board: this.match.board,
    };
  }
}

function makePlayer(id, name, socketId, team) {
  return {
    id,
    name,
    socketId,
    connected: true,
    joinedAt: Date.now(),
    order: 0,
    team: team === 'blue' ? 'blue' : 'red',
    isBot: false,
  };
}

module.exports = {
  Game,
  PHASES,
  TEAMS,
  MAX_PER_TEAM,
  MAX_PLAYERS,
  MIN_GOAL_TARGET,
  MAX_GOAL_TARGET,
  DEFAULT_GOAL_TARGET,
};
