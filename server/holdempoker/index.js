'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const {
  Game,
  PHASES,
  MAX_PLAYERS,
  START_STACK,
  HANDS_PER_LEVEL_OPTIONS,
} = require('./game');
const { chooseAction, thinkDelay } = require('./bot');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const INACTIVITY_RESET_MS = 60 * 60 * 1000;
const HOST_GRACE_MS = 15000;
// Soccer Head's emote set minus the ball. Mirrors EMOTES in public/holdempoker/js/player.js.
const ALLOWED_EMOTES = new Set(['😀', '😂', '😎', '😭', '😡', '👍', '🔥', '💪', '🎉', '😱']);
const EMOTE_COOLDOWN_MS = 2500;
const TABLE_PHASES = new Set([PHASES.DEAL, PHASES.BETTING, PHASES.RUNOUT]);

/**
 * Mount Hold'em Poker onto the hub's Express app and HTTP server.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountHoldemPoker(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

  // ---------------- Game state ----------------
  const game = new Game();
  let hostCount = 0;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  let hostLeftIntentionally = false;

  // `botSeq` is bumped on every state change so a stale think-timer never acts.
  let botTimers = [];
  let botSeq = 0;

  let reactionsMuted = false;
  const lastEmoteAt = new Map();

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
  const pub = (f) => path.join(__dirname, '..', '..', 'public', 'holdempoker', f);
  app.get('/holdempoker/host', (_req, res) => res.sendFile(pub('host.html')));
  app.get('/holdempoker/join', (_req, res) => res.sendFile(pub('join.html')));
  app.get('/holdempoker/play', (_req, res) => res.sendFile(pub('player.html')));

  // ---------------- REST endpoints ----------------
  app.get('/api/holdempoker/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({
      joinUrl: `${base}/holdempoker/join`,
      capacity: MAX_PLAYERS,
      startStack: START_STACK,
      handsPerLevelOptions: HANDS_PER_LEVEL_OPTIONS,
    });
  });

  app.get('/api/holdempoker/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg', margin: 1, width: 320,
        color: { dark: '#14301F', light: '#FFFFFF' },
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
  const ns = io.of('/holdempoker');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() { ns.emit('state:lobby', game.getLobbyPublic()); }

  /** Each phone gets its own hole cards, one socket at a time — never a broadcast. */
  function sendPrivate(target) {
    for (const p of game.players.values()) {
      if (p.isBot || !p.socketId) continue;
      if (target && p.socketId !== target) continue;
      const priv = game.getPrivate(p.id);
      if (priv) ns.to(p.socketId).emit('you:state', priv);
    }
  }

  function broadcastPhase() {
    if (game.phase === PHASES.LOBBY) { broadcastLobby(); return; }
    if (TABLE_PHASES.has(game.phase)) ns.emit('state:table', game.getTablePublic());
    else if (game.phase === PHASES.HAND_END) ns.emit('state:handEnd', game.getHandEndPublic());
    else if (game.phase === PHASES.FINAL) ns.emit('state:final', game.getFinalPublic());
    sendPrivate();
  }

  // ---------------- CPU driver ----------------
  function clearBots() {
    for (const t of botTimers) clearTimeout(t);
    botTimers = [];
    botSeq++;
  }

  /**
   * Re-arm the CPU think-timer for whoever is on turn. Humans are NEVER driven
   * this way — a dropped phone makes the table wait.
   */
  function syncBots() {
    clearBots();
    const pending = game.pendingBots();
    if (!pending) return;
    const seq = botSeq;
    for (const bot of pending.players) {
      // Decide now so the pause can match the move (a raise takes longer than a check).
      const view = game.botView(bot.id);
      const choice = chooseAction(view, game.rng);
      const timer = setTimeout(() => {
        botTimers = botTimers.filter((t) => t !== timer);
        if (seq !== botSeq) return;
        runBot(bot, choice);
      }, thinkDelay(choice, view, game.rng));
      if (timer.unref) timer.unref();
      botTimers.push(timer);
    }
  }

  function pushState() {
    broadcastPhase();
    syncBots();
  }

  function runBot(bot, choice) {
    if (game.phase !== PHASES.BETTING || game.turnId !== bot.id) return;
    let res = game.act(Object.assign({ playerId: bot.id }, choice));
    // Belt and braces: a rejected choice falls back to the safest legal move.
    if (!res.ok) res = game.act({ playerId: bot.id, type: 'check' });
    if (!res.ok) res = game.act({ playerId: bot.id, type: 'call' });
    if (!res.ok) res = game.act({ playerId: bot.id, type: 'fold' });
    pushState();
  }

  game.onChange = pushState;

  // ---------------- Socket handlers ----------------
  ns.on('connection', (socket) => {
    let role = null;
    let playerId = null;

    socket.on('query:status', (_p, ack) => {
      ack && ack({
        hostPresent: isHostPresent(),
        phase: game.phase,
        full: game.players.size >= MAX_PLAYERS,
        capacity: MAX_PLAYERS,
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
        player: { id: res.player.id, name: res.player.name },
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
        player: { id: res.player.id, name: res.player.name, seat: game.seatOf(pid) },
        phase: game.phase,
        hostPresent: isHostPresent(),
        reactionsMuted,
        lobby: game.getLobbyPublic(),
      };
      if (TABLE_PHASES.has(game.phase)) payload.table = game.getTablePublic();
      else if (game.phase === PHASES.HAND_END) payload.handEnd = game.getHandEndPublic();
      else if (game.phase === PHASES.FINAL) payload.final = game.getFinalPublic();
      if (game.phase !== PHASES.LOBBY) payload.me = game.getPrivate(pid);
      ack && ack(payload);
      // Re-push the table so the host un-dims this seat right away.
      broadcastPhase();
    });

    socket.on('player:action', ({ type, amount } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.act({ playerId, type, amount });
      if (!res.ok) {
        ack && ack(res);
        sendPrivate(socket.id); // resync the phone; its view was stale
        return;
      }
      ack && ack({ ok: true });
      pushState();
    });

    socket.on('player:preAction', ({ type } = {}, ack) => {
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.setPreAction(playerId, type === undefined ? null : type);
      ack && ack(res);
      sendPrivate(socket.id);
    });

    socket.on('player:showCards', (_p, ack) => {
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.showCards(playerId);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastPhase();
    });

    // Speech-bubble emotes: open to anyone still in the tournament, in any phase but FINAL.
    socket.on('player:emote', ({ e } = {}, ack) => {
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (typeof e !== 'string' || !ALLOWED_EMOTES.has(e)) return ack && ack({ ok: false, reason: 'bad-emote' });
      const p = game.players.get(playerId);
      if (!p || p.busted) return ack && ack({ ok: false, reason: 'out' });
      if (game.phase === PHASES.FINAL) return ack && ack({ ok: false, reason: 'phase-closed' });
      if (reactionsMuted) return ack && ack({ ok: false, reason: 'muted' });
      const now = Date.now();
      const last = lastEmoteAt.get(playerId) || 0;
      if (now - last < EMOTE_COOLDOWN_MS) {
        return ack && ack({ ok: false, reason: 'cooldown', retryInMs: EMOTE_COOLDOWN_MS - (now - last) });
      }
      lastEmoteAt.set(playerId, now);
      ack && ack({ ok: true });
      ns.to(HOST_ROOM).emit('host:emote', { id: playerId, e });
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
        capacity: MAX_PLAYERS,
      });
      if (TABLE_PHASES.has(game.phase)) socket.emit('state:table', game.getTablePublic());
      else if (game.phase === PHASES.HAND_END) socket.emit('state:handEnd', game.getHandEndPublic());
      else if (game.phase === PHASES.FINAL) socket.emit('state:final', game.getFinalPublic());
    });

    socket.on('host:addBot', (_p, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const res = game.addBot();
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:reorder', ({ playerId: pid, beforeId } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.reorderPlayer(pid, beforeId);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:setHandsPerLevel', ({ handsPerLevel } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setHandsPerLevel(handsPerLevel);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, handsPerLevel: game.handsPerLevel });
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
        // A dropped phone is backgrounded, not gone: the seat, the stack and the
        // cards stay put, and if it was their turn the table simply waits.
        game.markDisconnected(socket.id);
        broadcastPhase();
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

module.exports = mountHoldemPoker;
