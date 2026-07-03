'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Herd Mind — single-room game state machine.
//
// Flow:  LOBBY → INTRO → QUESTION → REVIEW → REVEAL → (loop) → FINAL
//
//   QUESTION : everyone types a short answer before the timer ends.
//   REVIEW   : host-only; answers are auto-bucketed (grouping.js) and the host
//              can merge/split before scoring. Set by the transport layer via
//              setGroups(); scored via scoreRound(finalGroups).
//   REVEAL   : majority group scores +1 each; the lone odd-one-out takes the
//              Pink Cow; leaderboard updates.
//   FINAL    : the sole highest scorer at/above the target, WITHOUT the Pink
//              Cow, wins.
//
// Scoring is intentionally faithful to Herd Mentality — see scoreRound() and
// computeWinner() for the exact rules.
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  INTRO: 'INTRO',
  QUESTION: 'QUESTION',
  REVIEW: 'REVIEW',
  REVEAL: 'REVEAL',
  FINAL: 'FINAL',
};

const MAX_NAME_LEN = 20;
const MAX_ANSWER_LEN = 40;
const INTRO_DURATION_MS = 4000;
const INTRO_GO_HOLD_MS = 1100;
const REVEAL_AUTO_ADVANCE_MS = 12 * 1000;
const DEFAULT_TARGET = 8;

const { buildQueue } = require('./questions');

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    /** @type {Map<string, any>} */
    this.players = new Map();

    this.targetScore = DEFAULT_TARGET;
    this.timeLimitSec = 20;
    this.autoAdvanceMs = 0;

    this.queue = [];           // shuffled question queue (draw without replacement)
    this.currentQuestion = null;
    this.roundIndex = 0;       // increments each QUESTION
    this.currentStartTs = 0;
    this.currentEndsAt = 0;
    this.lastEndReason = null; // 'timeout' | 'all-answered' | 'host'

    this.currentGroups = null; // provisional groups shown to host in REVIEW
    this.lastRoundResult = null;
    this.cowHolderId = null;   // player currently holding the Pink Cow (or null)
    this.winnerId = null;

    this.revealEndsAt = 0;

    this._introTimer = null;
    this._questionTimer = null;
    this._revealTimer = null;

    this.onIntroEnd = null;
    this.onQuestionEnd = null;
    this.onRevealEnd = null;
  }

  // ---------------- Lobby / players ----------------

  sanitizeName(raw) {
    if (typeof raw !== 'string') return '';
    let n = raw.replace(/[^\p{L}\p{N} '._-]/gu, '').trim().replace(/\s+/g, ' ');
    if (n.length > MAX_NAME_LEN) n = n.slice(0, MAX_NAME_LEN);
    return n;
  }

  sanitizeAnswer(raw) {
    if (typeof raw !== 'string') return '';
    let a = raw.replace(/[\r\n\t]+/g, ' ').trim().replace(/\s+/g, ' ');
    if (a.length > MAX_ANSWER_LEN) a = a.slice(0, MAX_ANSWER_LEN);
    return a;
  }

  nameIsTaken(name) {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  addPlayer({ playerId, name, socketId }) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'lobby-closed' };
    if (!playerId || typeof playerId !== 'string') return { ok: false, reason: 'bad-player-id' };
    if (this.players.has(playerId)) return this.reconnectPlayer({ playerId, socketId });
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) return { ok: false, reason: 'name-taken', name: clean };
    const player = {
      id: playerId,
      name: clean,
      socketId,
      score: 0,
      answeredRound: -1,
      roundAnswer: '',
      joinedAt: Date.now(),
      connected: true,
    };
    this.players.set(playerId, player);
    return { ok: true, player };
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

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    // If the Pink Cow holder leaves, the cow leaves with them.
    if (this.cowHolderId === playerId) this.cowHolderId = null;
    return p;
  }

  // ---------------- Questions ----------------

  _drawQuestion() {
    if (!this.queue.length) this.queue = buildQueue();
    if (!this.queue.length) {
      // No bank at all — fall back to a placeholder so the game never wedges.
      return { id: 'fallback', text: 'Name something you would find in a house.' };
    }
    return this.queue.shift();
  }

  // ---------------- Progression ----------------

  start({ timeLimitSec, targetScore, autoAdvance } = {}) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'already-started' };
    const t = parseInt(timeLimitSec, 10);
    this.timeLimitSec = (t >= 5 && t <= 120) ? t : 20;
    const target = parseInt(targetScore, 10);
    this.targetScore = (target >= 1 && target <= 50) ? target : DEFAULT_TARGET;
    this.autoAdvanceMs = autoAdvance ? REVEAL_AUTO_ADVANCE_MS : 0;
    this.queue = buildQueue();
    this.roundIndex = 0;
    this.cowHolderId = null;
    this.winnerId = null;
    for (const p of this.players.values()) {
      p.score = 0;
      p.answeredRound = -1;
      p.roundAnswer = '';
    }
    return this._enterIntro();
  }

  _clearTimers() {
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
    if (this._questionTimer) { clearTimeout(this._questionTimer); this._questionTimer = null; }
    if (this._revealTimer) { clearTimeout(this._revealTimer); this._revealTimer = null; }
  }

  _enterIntro() {
    this._clearTimers();
    this.phase = PHASES.INTRO;
    this.currentStartTs = Date.now();
    this.currentEndsAt = this.currentStartTs + INTRO_DURATION_MS;
    this._introTimer = setTimeout(() => {
      this._introTimer = null;
      this._endIntro();
    }, INTRO_DURATION_MS + INTRO_GO_HOLD_MS);
    return { ok: true, phase: PHASES.INTRO };
  }

  _endIntro() {
    if (this.phase !== PHASES.INTRO) return;
    this._clearTimers();
    this._enterQuestion();
    if (typeof this.onIntroEnd === 'function') { try { this.onIntroEnd(); } catch (_) {} }
  }

  _enterQuestion() {
    this._clearTimers();
    this.phase = PHASES.QUESTION;
    this.roundIndex += 1;
    this.currentQuestion = this._drawQuestion();
    this.currentGroups = null;
    this.lastRoundResult = null;
    this.lastEndReason = null;
    for (const p of this.players.values()) {
      p.answeredRound = -1;
      p.roundAnswer = '';
    }
    this.currentStartTs = Date.now();
    this.currentEndsAt = this.currentStartTs + this.timeLimitSec * 1000;
    this._questionTimer = setTimeout(() => {
      this._questionTimer = null;
      this._endQuestion('timeout');
    }, this.timeLimitSec * 1000 + 100);
    return { ok: true, phase: PHASES.QUESTION };
  }

  _endQuestion(reason) {
    if (this.phase !== PHASES.QUESTION) return;
    this._clearTimers();
    this.phase = PHASES.REVIEW;
    this.lastEndReason = reason || 'host';
    if (typeof this.onQuestionEnd === 'function') { try { this.onQuestionEnd(); } catch (_) {} }
  }

  submitAnswer({ playerId, questionId, answer }) {
    if (this.phase !== PHASES.QUESTION) return { ok: false, reason: 'not-accepting-answers' };
    if (!this.currentQuestion || this.currentQuestion.id !== questionId) {
      return { ok: false, reason: 'wrong-question' };
    }
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (p.answeredRound === this.roundIndex) return { ok: false, reason: 'already-answered' };
    const clean = this.sanitizeAnswer(answer);
    if (!clean) return { ok: false, reason: 'empty' };
    p.roundAnswer = clean;
    p.answeredRound = this.roundIndex;
    // End early once every current player has locked an answer.
    const total = this.players.size;
    if (total > 0 && this.answeredCount() >= total) {
      this._endQuestion('all-answered');
    }
    return { ok: true, locked: true, answer: clean };
  }

  answeredCount() {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.answeredRound === this.roundIndex) n++;
    }
    return n;
  }

  // One entry per player. Non-submitters get a blank raw (each becomes its own
  // unique "(no answer)" group, eligible for the Pink Cow).
  collectSubmissions() {
    const out = [];
    for (const p of this.players.values()) {
      out.push({
        playerId: p.id,
        name: p.name,
        raw: p.answeredRound === this.roundIndex ? p.roundAnswer : '',
      });
    }
    return out;
  }

  // Provisional groups from the grouping pipeline (set by the transport layer).
  setGroups(groups) {
    this.currentGroups = Array.isArray(groups) ? groups : [];
  }

  // ---------------- Scoring ----------------

  // Validate host-submitted groups: every current player must appear exactly
  // once, and no unknown players. Returns sanitized groups or null if invalid.
  _validateGroups(hostGroups) {
    if (!Array.isArray(hostGroups)) return null;
    const expected = new Set(this.players.keys());
    const seen = new Set();
    const out = [];
    for (const g of hostGroups) {
      if (!g || !Array.isArray(g.members)) return null;
      const members = [];
      for (const m of g.members) {
        const pid = m && m.playerId;
        const p = pid && this.players.get(pid);
        if (!p) return null;
        if (seen.has(pid)) return null;
        seen.add(pid);
        members.push({ playerId: pid, name: p.name, raw: p.roundAnswer || '' });
      }
      if (members.length === 0) continue;
      out.push({
        id: g.id || ('g' + out.length),
        label: typeof g.label === 'string' && g.label.trim() ? g.label.trim().slice(0, 60) : '(answer)',
        members,
      });
    }
    if (seen.size !== expected.size) return null;
    return out;
  }

  /**
   * Finalize a round. `hostGroups` (from the review screen) takes precedence;
   * if missing/invalid we fall back to the server's provisional groups.
   *
   * Rules (identical to Herd Mentality):
   *  - Only the SINGLE largest group of size >= 2 scores (+1 each). A tie for
   *    largest, or all-singletons, scores nobody.
   *  - The Pink Cow moves ONLY when exactly one player is a sole odd-one-out
   *    (exactly one group of size 1). Zero or 2+ singletons → cow unchanged.
   */
  scoreRound(hostGroups) {
    if (this.phase !== PHASES.REVIEW) return { ok: false, reason: 'not-reviewing' };
    let groups = this._validateGroups(hostGroups);
    if (!groups) {
      groups = (this.currentGroups || []).map((g) => ({
        id: g.id,
        label: g.label,
        members: (g.members || []).map((m) => ({
          playerId: m.playerId, name: m.name, raw: m.raw || '',
        })),
      }));
    }

    const sized = groups
      .map((g) => ({ ...g, size: g.members.length }))
      .filter((g) => g.size > 0);

    // Majority: unique largest group of size >= 2.
    let maxSize = 0;
    for (const g of sized) if (g.size > maxSize) maxSize = g.size;
    const largest = sized.filter((g) => g.size === maxSize);
    let majorityGroupId = null;
    const scorers = new Set();
    if (maxSize >= 2 && largest.length === 1) {
      majorityGroupId = largest[0].id;
      for (const m of largest[0].members) {
        const p = this.players.get(m.playerId);
        if (p) { p.score += 1; scorers.add(m.playerId); }
      }
    }

    // Pink Cow: moves only if exactly one sole odd-one-out (one size-1 group).
    const singletons = sized.filter((g) => g.size === 1);
    const prevCowHolderId = this.cowHolderId;
    let cowMovedTo = null;
    if (singletons.length === 1) {
      this.cowHolderId = singletons[0].members[0].playerId;
      cowMovedTo = this.cowHolderId;
    }

    // Win check (sole leader at/above target, cow-free).
    this.winnerId = this._computeWinner();

    this.lastRoundResult = {
      roundIndex: this.roundIndex,
      questionText: this.currentQuestion ? this.currentQuestion.text : '',
      target: this.targetScore,
      majorityGroupId,
      scorers: Array.from(scorers),
      cowHolderId: this.cowHolderId,
      prevCowHolderId,
      cowMovedTo,
      winnerId: this.winnerId,
      groups: sized.map((g) => ({
        id: g.id,
        label: g.label,
        size: g.size,
        isMajority: g.id === majorityGroupId,
        members: g.members.map((m) => ({ playerId: m.playerId, name: m.name, raw: m.raw })),
      })).sort((a, b) => b.size - a.size || a.label.localeCompare(b.label)),
    };

    this.phase = PHASES.REVEAL;
    this._clearTimers();
    if (this.autoAdvanceMs > 0 && !this.winnerId) {
      this.revealEndsAt = Date.now() + this.autoAdvanceMs;
      this._revealTimer = setTimeout(() => {
        this._revealTimer = null;
        this.revealEndsAt = 0;
        if (typeof this.onRevealEnd === 'function') { try { this.onRevealEnd(); } catch (_) {} }
      }, this.autoAdvanceMs);
    } else {
      this.revealEndsAt = 0;
    }
    return { ok: true };
  }

  _computeWinner() {
    const players = Array.from(this.players.values());
    if (players.length === 0) return null;
    let maxScore = -Infinity;
    for (const p of players) if (p.score > maxScore) maxScore = p.score;
    if (maxScore < this.targetScore) return null;
    const leaders = players.filter((p) => p.score === maxScore);
    if (leaders.length !== 1) return null;         // tie → nobody wins, target effectively rises
    if (leaders[0].id === this.cowHolderId) return null; // holding the cow blocks the win
    return leaders[0].id;
  }

  // Advance out of REVEAL: either the game is over, or on to the next question.
  advanceReveal() {
    if (this.phase !== PHASES.REVEAL) return { ok: false, reason: 'not-reveal' };
    this._clearTimers();
    this.revealEndsAt = 0;
    if (this.winnerId) {
      this.phase = PHASES.FINAL;
      return { ok: true, phase: PHASES.FINAL };
    }
    this._enterQuestion();
    return { ok: true, phase: PHASES.QUESTION };
  }

  // Generic host "Next" dispatcher used by the transport layer.
  advance() {
    if (this.phase === PHASES.INTRO) { this._endIntro(); return { ok: true, phase: PHASES.QUESTION }; }
    if (this.phase === PHASES.QUESTION) { this._endQuestion('host'); return { ok: true, phase: PHASES.REVIEW }; }
    if (this.phase === PHASES.REVEAL) return this.advanceReveal();
    return { ok: false, reason: 'cannot-advance' };
  }

  // ---------------- Views / serialization ----------------

  getQuestionPublic() {
    if (!this.currentQuestion) return null;
    return {
      id: this.currentQuestion.id,
      text: this.currentQuestion.text,
      round: this.roundIndex,
      timeLimitSec: this.timeLimitSec,
      endsAt: this.currentEndsAt,
      serverNow: Date.now(),
      target: this.targetScore,
    };
  }

  getIntroPublic() {
    return {
      endsAt: this.currentEndsAt,
      serverNow: Date.now(),
      durationMs: INTRO_DURATION_MS,
      target: this.targetScore,
    };
  }

  // Host-only review payload: the provisional buckets to merge/split/rename.
  getReviewPublic() {
    return {
      round: this.roundIndex,
      questionText: this.currentQuestion ? this.currentQuestion.text : '',
      target: this.targetScore,
      groups: (this.currentGroups || []).map((g) => ({
        id: g.id,
        label: g.label,
        autoMerged: !!g.autoMerged,
        mergeSource: g.mergeSource || null,
        members: (g.members || []).map((m) => ({ playerId: m.playerId, name: m.name, raw: m.raw })),
      })),
      answered: this.answeredCount(),
      total: this.players.size,
    };
  }

  getRevealPublic() {
    const r = this.lastRoundResult;
    return {
      round: this.roundIndex,
      questionText: r ? r.questionText : (this.currentQuestion ? this.currentQuestion.text : ''),
      target: this.targetScore,
      groups: r ? r.groups : [],
      majorityGroupId: r ? r.majorityGroupId : null,
      cowHolderId: this.cowHolderId,
      cowHolderName: this._nameOf(this.cowHolderId),
      cowMovedTo: r ? r.cowMovedTo : null,
      leaderboard: this.getLeaderboard(),
      gameOver: !!this.winnerId,
      winnerId: this.winnerId,
      winnerName: this._nameOf(this.winnerId),
      autoAdvance: this.autoAdvanceMs > 0 && !this.winnerId,
      revealEndsAt: this.revealEndsAt || 0,
      serverNow: Date.now(),
    };
  }

  _nameOf(pid) {
    if (!pid) return null;
    const p = this.players.get(pid);
    return p ? p.name : null;
  }

  getLeaderboard(limit) {
    const sorted = Array.from(this.players.values())
      .map((p) => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => (b.score !== a.score
        ? b.score - a.score
        : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
    const ranked = [];
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const rank = (i > 0 && sorted[i - 1].score === p.score) ? ranked[i - 1].rank : i + 1;
      ranked.push({ rank, id: p.id, name: p.name, score: p.score, hasCow: p.id === this.cowHolderId });
    }
    return typeof limit === 'number' ? ranked.slice(0, limit) : ranked;
  }

  // Up to 3 podium GROUPS by distinct rank (ties share a card). The winner is
  // always the sole rank-1 player; cow-holders are flagged for display.
  getPodiumGroups() {
    const full = this.getLeaderboard();
    if (full.length === 0) return [];
    const groups = [];
    for (const row of full) {
      const last = groups[groups.length - 1];
      if (last && last.rank === row.rank) {
        last.players.push({ id: row.id, name: row.name, hasCow: row.hasCow });
      } else {
        if (groups.length >= 3) break;
        groups.push({
          rank: row.rank,
          score: row.score,
          players: [{ id: row.id, name: row.name, hasCow: row.hasCow }],
        });
      }
    }
    return groups;
  }

  getFinalPublic() {
    const lb = this.getLeaderboard();
    return {
      podiumGroups: this.getPodiumGroups(),
      fullLeaderboard: lb,
      winnerId: this.winnerId,
      winnerName: this._nameOf(this.winnerId),
      target: this.targetScore,
    };
  }

  getLobbyPlayers() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id, name: p.name, connected: p.connected,
    }));
  }

  // Private per-player result for the phone during REVEAL.
  getPlayerResult(playerId) {
    const p = this.players.get(playerId);
    const r = this.lastRoundResult;
    if (!p || !r) return null;
    const lb = this.getLeaderboard();
    const row = lb.find((e) => e.id === playerId);
    const rank = row ? row.rank : lb.length;
    const tied = lb.filter((e) => e.rank === rank).length > 1;
    const matchedHerd = r.scorers.indexOf(playerId) !== -1;
    return {
      round: r.roundIndex,
      answered: p.answeredRound === r.roundIndex,
      answer: p.roundAnswer || '',
      matchedHerd,
      pointsEarned: matchedHerd ? 1 : 0,
      totalScore: p.score,
      hadMajority: !!r.majorityGroupId,
      gotCow: r.cowMovedTo === playerId,
      hasCow: this.cowHolderId === playerId,
      rank,
      tied,
      totalPlayers: lb.length,
      target: this.targetScore,
      gameOver: !!this.winnerId,
      isWinner: this.winnerId === playerId,
    };
  }

  reset() {
    this._clearTimers();
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.queue = [];
    this.currentQuestion = null;
    this.roundIndex = 0;
    this.currentStartTs = 0;
    this.currentEndsAt = 0;
    this.currentGroups = null;
    this.lastRoundResult = null;
    this.cowHolderId = null;
    this.winnerId = null;
    this.revealEndsAt = 0;
    this.autoAdvanceMs = 0;
  }
}

module.exports = { Game, PHASES, MAX_NAME_LEN, MAX_ANSWER_LEN, INTRO_DURATION_MS, DEFAULT_TARGET };
