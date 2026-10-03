'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const {
  Game,
  PHASES,
  PLAYER_COUNT,
  TRICKS_PER_HAND,
  TARGET_SCORES,
} = require('./game');
const { BOT_SETTINGS, chooseBid, choosePlay } = require('./bot');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
// CPUs always play at full strength — the table has no skill setting.
const BOT_LEVEL = 'hard';
const INACTIVITY_RESET_MS = 60 * 60 * 1000;
const HOST_GRACE_MS = 15000;
// Mirrors EMOTES in public/spades/js/player.js.
const ALLOWED_EMOTES = new Set(['😀', '😂', '😎', '😭', '😡', '👍', '🔥', '💪', '🎉', '😱']);
// The felt (bidding and tricks) shows emotes as seat bubbles; every other screen floats them.
const BUBBLE_PHASES = new Set([PHASES.BID, PHASES.TRICK, PHASES.TRICK_END]);
const EMOTE_BUBBLE_COOLDOWN_MS = 2500;
const EMOTE_FLOAT_COOLDOWN_MS = 10 * 1000;

/**
 * Mount the Spades game onto the hub's Express app and HTTP server.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountSpades(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

  // ---------------- Game state ----------------
  const game = new Game();
  let hostCount = 0;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  let hostLeftIntentionally = false;

  // CPU think-timers. `botSeq` is bumped on every phase change so a timer that
  // was armed for a turn that has since moved on can never fire a card.
  let botTimers = [];
  let botSeq = 0;

  let reactionsMuted = false;
  const nextEmoteAt = new Map();

  function isHostPresent() {
    if (hostLeftIntentionally) return false;
    if (hostCount > 0) return true;
    return lastHostSeenAt > 0 && (Date.now() - lastHostSeenAt) < HOST_GRACE_MS;
  }
  function emitHostPresence(present) {
    ns.emit('state:hostPresence', { present: !!present });
  }

  let lastActivity = Date.now();
  function touchActivity() { lastActivity = Date.now(); }
  setInterval(() => {
    if (Date.now() - lastActivity >= INACTIVITY_RESET_MS) {
      clearBots();
      game.reset();
      ns.emit('state:reset');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  const pub = (f) => path.join(__dirname, '..', '..', 'public', 'spades', f);
  app.get('/spades/host', (_req, res) => res.sendFile(pub('host.html')));
  app.get('/spades/join', (_req, res) => res.sendFile(pub('join.html')));
  app.get('/spades/play', (_req, res) => res.sendFile(pub('player.html')));

  // ---------------- REST endpoints ----------------
  app.get('/api/spades/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({
      joinUrl: `${base}/spades/join`,
      capacity: PLAYER_COUNT,
      targetScores: TARGET_SCORES,
      tricksPerHand: TRICKS_PER_HAND,
    });
  });

  app.get('/api/spades/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg', margin: 1, width: 320,
        color: { dark: '#1A2238', light: '#FFFFFF' },
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      res.send(svg);
    } catch (e) {
      res.status(500).send('qr error');
    }
  });

  // ---------------- Socket.IO namespace ----------------
  // Reuse the single Socket.IO Server shared by all games (attaching a second
  // Server to the same HTTP server breaks WebSocket upgrades).
  if (!httpServer._triviaIo) {
    httpServer._triviaIo = new Server(httpServer, { cors: { origin: '*' } });
  }
  const io = httpServer._triviaIo;
  const ns = io.of('/spades');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() { ns.emit('state:lobby', game.getLobbyPublic()); }

  /**
   * Deal each phone its own hand. One socket at a time — a hand must never ride
   * a broadcast, and the host screen is never a recipient.
   */
  function sendHands(target) {
    for (const p of game.players.values()) {
      if (p.isBot || !p.socketId) continue;
      if (target && p.socketId !== target) continue;
      const priv = game.getPrivateHand(p.id);
      if (priv) ns.to(p.socketId).emit('you:hand', priv);
    }
  }

  function broadcastDeal() { ns.emit('state:deal', game.getDealPublic()); sendHands(); }
  function broadcastBid() { ns.emit('state:bid', game.getBidPublic()); sendHands(); }
  function broadcastTable() { ns.emit('state:table', game.getTablePublic()); sendHands(); }
  function broadcastTrickEnd() { ns.emit('state:trickEnd', game.getTrickEndPublic()); sendHands(); }
  function broadcastHandEnd() { ns.emit('state:handEnd', game.getHandEndPublic()); sendHands(); }
  function broadcastFinal() { ns.emit('state:final', game.getFinalPublic()); sendHands(); }

  /** Push whichever screen the current phase calls for, to everyone. */
  function broadcastPhase() {
    switch (game.phase) {
      case PHASES.LOBBY: broadcastLobby(); break;
      case PHASES.DEAL: broadcastDeal(); break;
      case PHASES.BID: broadcastBid(); break;
      case PHASES.TRICK: broadcastTable(); break;
      case PHASES.TRICK_END: broadcastTrickEnd(); break;
      case PHASES.HAND_END: broadcastHandEnd(); break;
      case PHASES.FINAL: broadcastFinal(); break;
      default: break;
    }
  }

  /** Re-push the current view so a drop dims (and a return un-dims) right away. */
  function broadcastPresence() { broadcastPhase(); }

  // ---------------- CPU driver ----------------
  function clearBots() {
    for (const t of botTimers) clearTimeout(t);
    botTimers = [];
    botSeq++;
  }

  /**
   * Re-arm the CPU think-timers for whoever currently owes the table an
   * action. Called after every state change, so a timer armed for a turn that
   * has since moved on is discarded rather than firing a card into the wrong
   * trick. Humans are NEVER driven this way — a dropped phone makes the table
   * wait, it is never auto-played for.
   */
  function syncBots() {
    clearBots();
    const pending = game.pendingBots();
    if (!pending) return;
    const seq = botSeq;
    const settings = BOT_SETTINGS[BOT_LEVEL];
    for (const bot of pending.players) {
      const delay = pending.phase === PHASES.BID
        ? settings.bidMs + Math.floor(game.rng() * 700)
        : settings.playMs + Math.floor(game.rng() * 350);
      const timer = setTimeout(() => {
        botTimers = botTimers.filter((t) => t !== timer);
        if (seq !== botSeq) return;
        runBot(bot, pending.phase);
      }, delay);
      if (timer.unref) timer.unref();
      botTimers.push(timer);
    }
  }

  /** Broadcast the current phase and re-arm the CPUs. The one way to advance. */
  function pushState() {
    broadcastPhase();
    syncBots();
  }

  function runBot(bot, phase) {
    if (phase === PHASES.BID) {
      const bidder = game.currentBidder();
      if (!bidder || bidder.id !== bot.id) return;
      const choice = chooseBid(game.botView(bot.id), BOT_LEVEL, game.rng);
      const res = game.submitBid({ playerId: bot.id, bid: choice.bid, blind: !!choice.blind });
      if (!res.ok) return;
      afterBid(bot, res);
      return;
    }

    if (game.phase !== PHASES.TRICK) return;
    const current = game.currentPlayer();
    if (!current || current.id !== bot.id) return;
    const card = choosePlay(game.botView(bot.id), BOT_LEVEL, game.rng);
    if (!card) return;
    const res = game.playCard({ playerId: bot.id, card });
    if (!res.ok) return;
    afterPlay(res);
  }

  /** Shared tail for a card hitting the table, whoever played it. */
  function afterPlay(res) {
    if (res.brokeSpades) ns.emit('state:spadesBroken', {});
    pushState();
  }

  /** Shared tail for a bid, whoever made it. */
  function afterBid(p, res) {
    ns.emit('state:bidPlaced', { playerId: p.id, name: p.name, bid: res.bid, nil: res.nil, blind: res.blind });
    pushState();
  }

  // ---------------- Game → transport hooks ----------------
  game.onDealEnd = pushState;
  game.onTrickEnd = pushState;
  game.onAutoAdvance = pushState;

  // ---------------- Socket handlers ----------------
  ns.on('connection', (socket) => {
    let role = null;
    let playerId = null;

    socket.on('query:status', (_p, ack) => {
      ack && ack({
        hostPresent: isHostPresent(),
        phase: game.phase,
        full: game.players.size >= PLAYER_COUNT,
        capacity: PLAYER_COUNT,
      });
    });

    // ---- Player flows ----
    socket.on('player:join', ({ playerId: pid, name } = {}, ack) => {
      touchActivity();
      if (!pid || typeof pid !== 'string') return ack && ack({ ok: false, reason: 'bad-player-id' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      const res = game.addPlayer({ playerId: pid, name, socketId: socket.id });
      if (!res.ok) return ack && ack(res);
      role = 'player';
      playerId = pid;
      socket.join(PLAYER_ROOM);
      ack && ack({
        ok: true,
        player: { id: res.player.id, name: res.player.name, team: res.player.team },
        hostPresent: isHostPresent(),
        reactionsMuted,
      });
      broadcastLobby();
    });

    socket.on('player:reconnect', ({ playerId: pid } = {}, ack) => {
      if (!pid) return ack && ack({ ok: false, reason: 'bad-player-id' });
      const res = game.reconnectPlayer({ playerId: pid, socketId: socket.id });
      if (!res.ok) return ack && ack(res);
      role = 'player';
      playerId = pid;
      socket.join(PLAYER_ROOM);
      const payload = {
        ok: true,
        player: { id: res.player.id, name: res.player.name, seat: game.seatOf(pid), team: res.player.team },
        phase: game.phase,
        hostPresent: isHostPresent(),
        reactionsMuted,
        lobby: game.getLobbyPublic(),
      };
      if (game.phase === PHASES.DEAL) payload.deal = game.getDealPublic();
      else if (game.phase === PHASES.BID) payload.bid = game.getBidPublic();
      else if (game.phase === PHASES.TRICK) payload.table = game.getTablePublic();
      else if (game.phase === PHASES.TRICK_END) payload.trickEnd = game.getTrickEndPublic();
      else if (game.phase === PHASES.HAND_END) payload.handEnd = game.getHandEndPublic();
      else if (game.phase === PHASES.FINAL) payload.final = game.getFinalPublic();
      if (game.phase !== PHASES.LOBBY && game.phase !== PHASES.FINAL) {
        payload.myHand = game.getPrivateHand(pid);
      }
      ack && ack(payload);
      broadcastPresence();
    });

    // Turn this phone's hand face up — giving up the option of a Blind Nil.
    socket.on('player:reveal', (_p, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.reveal(playerId);
      ack && ack(res);
      sendHands(socket.id);
    });

    socket.on('player:bid', ({ bid, blind } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.submitBid({ playerId, bid, blind: !!blind });
      if (!res.ok) {
        ack && ack(res);
        sendHands(socket.id);
        return;
      }
      ack && ack(res);
      afterBid(game.players.get(playerId), res);
    });

    socket.on('player:play', ({ card } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.playCard({ playerId, card });
      if (!res.ok) {
        ack && ack(res);
        sendHands(socket.id); // resync the phone; its view was stale
        return;
      }
      ack && ack({ ok: true, card: res.card });
      afterPlay(res);
    });

    socket.on('player:emote', ({ e } = {}, ack) => {
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (typeof e !== 'string' || !ALLOWED_EMOTES.has(e)) return ack && ack({ ok: false, reason: 'bad-emote' });
      if (reactionsMuted) return ack && ack({ ok: false, reason: 'muted' });
      const now = Date.now();
      const kind = BUBBLE_PHASES.has(game.phase) ? 'bubble' : 'float';
      // A cooldown only holds within the kind that set it, so a float never delays the first bubble.
      const last = nextEmoteAt.get(playerId);
      if (last && last.kind === kind && now < last.at) {
        return ack && ack({ ok: false, reason: 'cooldown', retryInMs: last.at - now });
      }
      const cooldownMs = kind === 'bubble' ? EMOTE_BUBBLE_COOLDOWN_MS : EMOTE_FLOAT_COOLDOWN_MS;
      nextEmoteAt.set(playerId, { at: now + cooldownMs, kind });
      ack && ack({ ok: true, kind, cooldownMs });
      ns.to(HOST_ROOM).emit('host:emote', { id: playerId, e, kind });
    });

    // ---- Host flows ----
    function requireHost(ack) {
      if (role !== 'host') { ack && ack({ ok: false, reason: 'not-host' }); return false; }
      return true;
    }

    socket.on('host:auth', (_p, ack) => {
      role = 'host';
      socket.join(HOST_ROOM);
      if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
      const wasAbsent = !isHostPresent();
      hostLeftIntentionally = false;
      hostCount += 1;
      lastHostSeenAt = Date.now();
      if (wasAbsent) emitHostPresence(true);
      ack && ack({
        ok: true,
        phase: game.phase,
        lobby: game.getLobbyPublic(),
        capacity: PLAYER_COUNT,
      });
      if (game.phase === PHASES.DEAL) socket.emit('state:deal', game.getDealPublic());
      else if (game.phase === PHASES.BID) socket.emit('state:bid', game.getBidPublic());
      else if (game.phase === PHASES.TRICK) socket.emit('state:table', game.getTablePublic());
      else if (game.phase === PHASES.TRICK_END) socket.emit('state:trickEnd', game.getTrickEndPublic());
      else if (game.phase === PHASES.HAND_END) socket.emit('state:handEnd', game.getHandEndPublic());
      else if (game.phase === PHASES.FINAL) socket.emit('state:final', game.getFinalPublic());
    });

    socket.on('host:addBot', ({ team } = {}, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const res = game.addBot(team);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:assign', ({ playerId: pid, team, beforeId } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.assignTeam(pid, team, beforeId);
      if (!res.ok) return ack && ack(res);
      ack && ack(res);
      broadcastLobby();
    });

    socket.on('host:setTargetScore', ({ targetScore } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setTargetScore(targetScore);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, targetScore: game.targetScore });
      broadcastLobby();
    });

    socket.on('host:setAutoAdvance', ({ on } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setAutoAdvance(on);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, autoAdvance: game.autoAdvance });
      broadcastLobby();
    });

    socket.on('host:start', (_p, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      clearBots();
      const res = game.start();
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
      pushState();
    });

    socket.on('host:nextHand', (_p, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      clearBots();
      const res = game.nextHand();
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, phase: game.phase });
      pushState();
    });

    socket.on('host:setReactionsMuted', ({ muted } = {}, ack) => {
      if (!requireHost(ack)) return;
      reactionsMuted = !!muted;
      ack && ack({ ok: true, reactionsMuted });
      ns.emit('state:reactionsMuted', { muted: reactionsMuted });
    });

    socket.on('host:kick', ({ playerId: pid } = {}, ack) => {
      if (!requireHost(ack)) return;
      const p = game.removePlayer(pid);
      if (!p) return ack && ack({ ok: false, reason: 'unknown-player' });
      if (p.socketId) ns.to(p.socketId).emit('player:rejected', { reason: 'kicked' });
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:reset', (_p, ack) => {
      if (!requireHost(ack)) return;
      clearBots();
      game.reset();
      ack && ack({ ok: true });
      ns.emit('state:reset');
      broadcastLobby();
    });

    socket.on('host:leave', (_p, ack) => {
      if (!requireHost(ack)) return;
      clearBots();
      game.reset();
      hostLeftIntentionally = true;
      if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
      emitHostPresence(false);
      ack && ack({ ok: true });
    });

    socket.on('disconnect', () => {
      if (role === 'player') {
        // A dropped phone is backgrounded, not gone. The roster, the seat order
        // and every score stay exactly as they were, and if it was their turn
        // the table simply waits for them to come back.
        game.markDisconnected(socket.id);
        broadcastPresence();
      } else if (role === 'host') {
        hostCount = Math.max(0, hostCount - 1);
        lastHostSeenAt = Date.now();
        if (hostCount === 0) {
          if (hostGraceTimer) clearTimeout(hostGraceTimer);
          hostGraceTimer = setTimeout(() => {
            hostGraceTimer = null;
            if (!isHostPresent()) emitHostPresence(false);
          }, HOST_GRACE_MS);
        }
      }
    });
  });
}

module.exports = mountSpades;
