'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Soccer Head — server-side lobby + match-meta state machine.
//
// Unlike the other five games, the live game (physics, ball, scoring) runs on
// the HOST browser for the lowest possible input latency (player -> server ->
// host is a single relay hop). This module therefore does NOT simulate the
// match. It owns:
//   • the lobby: players, 1v1/2v2 mode, team assignment, match length
//   • a small CACHE of match meta (scores, clock, sudden-death, controls-live)
//     that the host pushes as the match runs, so late joiners / reconnecting
//     phones and a refreshed host can be brought back to the right screen.
//
// The transport layer (./index.js) owns socket events + broadcasting.
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
  FINAL: 'FINAL',
};

const MODES = { '1v1': 2, '2v2': 4 };
const DEFAULT_MODE = '1v1';

const MAX_NAME_LEN = 20;

const MIN_DURATION_SEC = 30;
const MAX_DURATION_SEC = 120;
const DEFAULT_DURATION_SEC = 90;

const TEAMS = ['red', 'blue'];

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    this.mode = DEFAULT_MODE;
    this.durationSec = DEFAULT_DURATION_SEC;
    // Monotonic counter giving each player an `order` for stable, reorderable
    // seat ordering within a team (seat 0 = first, wears the cap in 2v2).
    this._orderSeq = 0;
    /** @type {Map<string, object>} */
    this.players = new Map();
    // Cache of the live match state, kept fresh by host:* events. Used to
    // restore reconnecting players and a refreshed host to the right screen.
    this.match = this._freshMatch();
  }

  _freshMatch() {
    return {
      redScore: 0,
      blueScore: 0,
      clockMs: this.durationSec * 1000,
      sudden: false,
      live: false, // true only while controls are active (host:play)
      winner: null, // 'red' | 'blue' | null
    };
  }

  capacity() {
    return MODES[this.mode] || 2;
  }
  perTeam() {
    return this.capacity() / 2;
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
    // New players can only join while the host hasn't started yet.
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
    // Auto-assign to the emptier team (red wins ties) for balanced lobbies.
    const team = this.teamCount('red') <= this.teamCount('blue') ? 'red' : 'blue';
    const player = makePlayer(playerId, clean, socketId, team);
    player.order = this._orderSeq++;
    this.players.set(playerId, player);
    return { ok: true, player };
  }

  /**
   * Add a CPU/bot player to fill an open slot. The bot has no socket; the host
   * drives its inputs locally during the match. Used for solo playtesting.
   */
  addBot() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (this.players.size >= this.capacity()) return { ok: false, reason: 'game-full' };
    const team = this.teamCount('red') <= this.teamCount('blue') ? 'red' : 'blue';
    // Unique bot id + a friendly, non-colliding name.
    let n = 1;
    while (this.players.has('bot-' + n)) n++;
    let name = 'CPU';
    if (this.nameIsTaken(name)) { let k = 2; while (this.nameIsTaken('CPU ' + k)) k++; name = 'CPU ' + k; }
    const bot = makePlayer('bot-' + n, name, null, team);
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

  setMode(mode) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (!MODES[mode]) return { ok: false, reason: 'bad-mode' };
    if (this.players.size > MODES[mode]) {
      return { ok: false, reason: 'too-many-players' };
    }
    this.mode = mode;
    this.match.clockMs = this.durationSec * 1000;
    return { ok: true };
  }

  setDuration(sec) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const n = Math.round(Number(sec));
    if (!Number.isFinite(n)) return { ok: false, reason: 'bad-duration' };
    this.durationSec = Math.min(MAX_DURATION_SEC, Math.max(MIN_DURATION_SEC, n));
    this.match.clockMs = this.durationSec * 1000;
    return { ok: true };
  }

  assignTeam(playerId, team, beforeId) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (!TEAMS.includes(team)) return { ok: false, reason: 'bad-team' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
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

  isBalanced() {
    return this.players.size === this.capacity()
      && this.teamCount('red') === this.perTeam()
      && this.teamCount('blue') === this.perTeam();
  }
  canStart() {
    if (this.phase !== PHASES.LOBBY) return false;
    const red = this.teamCount('red');
    const blue = this.teamCount('blue');
    const per = this.perTeam();
    // 1v1: exactly one per side (unchanged). 2v2: each team 1..2 players and at
    // least 3 total, so a plain 1v1 inside 2v2 isn't allowed (uneven 2v1 is).
    if (this.mode === '2v2') {
      return red >= 1 && red <= per && blue >= 1 && blue <= per && (red + blue) >= 3;
    }
    return red === per && blue === per && this.players.size === this.capacity();
  }

  // ---------------- Match lifecycle (meta only) ----------------

  /**
   * Build the ordered roster the host uses to spawn characters. Each side is
   * ordered by join time so seat 0/1 are stable across reconnects.
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
    this.match.live = false;
    return { ok: true, roster: this.getRoster() };
  }

  // Host pushes live meta as the match runs. These just keep the cache fresh.
  setLive(live) { this.match.live = !!live; }
  setClock(ms, sudden) {
    if (Number.isFinite(ms)) this.match.clockMs = Math.max(0, Math.round(ms));
    if (typeof sudden === 'boolean') this.match.sudden = sudden;
  }
  setScore(redScore, blueScore) {
    if (Number.isFinite(redScore)) this.match.redScore = redScore | 0;
    if (Number.isFinite(blueScore)) this.match.blueScore = blueScore | 0;
  }
  setSudden(on) { this.match.sudden = !!on; }
  endMatch({ winner, redScore, blueScore } = {}) {
    this.phase = PHASES.FINAL;
    this.match.live = false;
    if (Number.isFinite(redScore)) this.match.redScore = redScore | 0;
    if (Number.isFinite(blueScore)) this.match.blueScore = blueScore | 0;
    this.match.winner = winner === 'red' || winner === 'blue' ? winner : null;
  }

  reset(keepConfig) {
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this._orderSeq = 0;
    // Resetting from a live/finished match keeps the mode + match-length the host
    // picked; a plain lobby reset drops them back to defaults.
    if (!keepConfig) {
      this.mode = DEFAULT_MODE;
      this.durationSec = DEFAULT_DURATION_SEC;
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
      mode: this.mode,
      capacity: this.capacity(),
      perTeam: this.perTeam(),
      durationSec: this.durationSec,
      teams: { red, blue },
      total: this.players.size,
      canStart: this.canStart(),
    };
  }

  getMatchMeta() {
    return {
      mode: this.mode,
      durationSec: this.durationSec,
      roster: this.getRoster(),
      redScore: this.match.redScore,
      blueScore: this.match.blueScore,
      clockMs: this.match.clockMs,
      sudden: this.match.sudden,
      live: this.match.live,
      winner: this.match.winner,
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
  MODES,
  TEAMS,
  MIN_DURATION_SEC,
  MAX_DURATION_SEC,
  DEFAULT_DURATION_SEC,
  DEFAULT_MODE,
};
