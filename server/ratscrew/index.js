'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game, PHASES, MAX_PLAYERS } = require('./game');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const INACTIVITY_RESET_MS = 60 * 60 * 1000;
const HOST_GRACE_MS = 15000;
// Mirrors EMOTES in public/ratscrew/js/player.js (same set as the other card games).
const ALLOWED_EMOTES = new Set(['😀', '😂', '😎', '😭', '😡', '👍', '🔥', '💪', '🎉', '😱']);
// Mid-game a reaction is a bubble on the player's seat; the lobby and final standings float it.
const EMOTE_BUBBLE_COOLDOWN_MS = 2500;
const EMOTE_FLOAT_COOLDOWN_MS = 5 * 1000;

// CPU timing: a beat after the play lock lifts, and a slap slow enough for people to
// beat — only one CPU goes for each slap (several racing would just be the fastest roll),
// and it sometimes misses it altogether.
const BOT_PLAY_MIN_MS = 350;
const BOT_PLAY_JITTER_MS = 800;
const BOT_SLAP_MIN_MS = 900;
const BOT_SLAP_JITTER_MS = 700;
const BOT_SLAP_MISS = 0.25;

/**
 * Mount Egyptian Ratscrew onto the hub's Express app and HTTP server.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountRatscrew(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

  // ---------------- Game state ----------------
  const game = new Game();
  let hostCount = 0;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  let hostLeftIntentionally = false;

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
  const pub = (f) => path.join(__dirname, '..', '..', 'public', 'ratscrew', f);
  app.get('/ratscrew/host', (_req, res) => res.sendFile(pub('host.html')));
  app.get('/ratscrew/join', (_req, res) => res.sendFile(pub('join.html')));
  app.get('/ratscrew/play', (_req, res) => res.sendFile(pub('player.html')));

  // ---------------- REST endpoints ----------------
  app.get('/api/ratscrew/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({ joinUrl: `${base}/ratscrew/join`, capacity: MAX_PLAYERS });
  });

  app.get('/api/ratscrew/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg', margin: 1, width: 320,
        color: { dark: '#3A0F19', light: '#FFFFFF' },
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
  const ns = io.of('/ratscrew');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() { ns.emit('state:lobby', game.getLobbyPublic()); }

  // Nothing is private in this game (every deck is face down), so everyone gets the same table.
  function broadcastPhase() {
    if (game.phase === PHASES.LOBBY) broadcastLobby();
    else if (game.phase === PHASES.PLAYING) ns.emit('state:table', game.getTablePublic());
    else if (game.phase === PHASES.FINAL) ns.emit('state:final', game.getFinalPublic());
  }

  // ---------------- CPU driver ----------------
  // Keyed so an unrelated update (a bad slap, a reconnect) never restarts a CPU's reaction.
  let turnTimer = null;
  let turnKey = '';
  let slapTimers = [];
  let slapKey = '';

  function clearBots() {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
    turnKey = '';
    slapTimers.forEach(clearTimeout);
    slapTimers = [];
    slapKey = '';
  }

  function later(fn, ms) {
    const t = setTimeout(fn, Math.max(0, ms));
    if (t.unref) t.unref();
    return t;
  }

  /** Humans are NEVER driven this way — a dropped phone makes the table wait. */
  function syncBots() {
    if (game.phase !== PHASES.PLAYING || game.ending) { clearBots(); return; }

    const bt = game.botTurn();
    const tk = bt ? bt.id + '|' + game.pileSeq + '|' + bt.at : '';
    if (tk !== turnKey) {
      if (turnTimer) clearTimeout(turnTimer);
      turnTimer = null;
      turnKey = tk;
      if (bt) {
        const wait = bt.at - Date.now() + BOT_PLAY_MIN_MS + game.rng() * BOT_PLAY_JITTER_MS;
        turnTimer = later(() => {
          turnTimer = null;
          turnKey = '';
          const res = game.play(bt.id);
          if (res.ok) pushState(); else syncBots();
        }, wait);
      }
    }

    const pattern = game.slapOpen() ? game.currentPattern() : null;
    const sk = pattern ? game.pileSeq + '|' + pattern : '';
    if (sk !== slapKey) {
      slapTimers.forEach(clearTimeout);
      slapTimers = [];
      slapKey = sk;
      if (pattern) {
        const seq = game.pileSeq;
        const bots = game.botSlappers();
        const bot = bots.length && game.rng() >= BOT_SLAP_MISS ? bots[Math.floor(game.rng() * bots.length)] : null;
        if (bot) {
          const t = later(() => {
            slapTimers = slapTimers.filter((x) => x !== t);
            // CPUs never slap a pile that has changed under them — no false slaps.
            if (game.pileSeq !== seq || !game.slapOpen() || !game.currentPattern()) return;
            const res = game.slap(bot.id);
            if (res.ok && res.result !== 'late') pushState();
          }, BOT_SLAP_MIN_MS + game.rng() * BOT_SLAP_JITTER_MS);
          slapTimers.push(t);
        }
      }
    }
  }

  function pushState() {
    broadcastPhase();
    syncBots();
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
      if (game.phase === PHASES.PLAYING) payload.table = game.getTablePublic();
      else if (game.phase === PHASES.FINAL) payload.final = game.getFinalPublic();
      ack && ack(payload);
      // Re-push so the host un-dims this seat right away.
      broadcastPhase();
    });

    socket.on('player:play', (_p, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.play(playerId);
      ack && ack(res.ok ? { ok: true } : res);
      if (res.ok) pushState();
      else socket.emit('state:table', game.getTablePublic());   // the phone's view was stale
    });

    socket.on('player:slap', (_p, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.slap(playerId);
      ack && ack(res);
      if (res.ok && res.result !== 'late') pushState();
    });

    socket.on('player:emote', ({ e } = {}, ack) => {
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (typeof e !== 'string' || !ALLOWED_EMOTES.has(e)) return ack && ack({ ok: false, reason: 'bad-emote' });
      if (reactionsMuted) return ack && ack({ ok: false, reason: 'muted' });
      const now = Date.now();
      const kind = game.phase === PHASES.PLAYING ? 'bubble' : 'float';
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
        capacity: MAX_PLAYERS,
        reactionsMuted,
      });
      if (game.phase === PHASES.PLAYING) socket.emit('state:table', game.getTablePublic());
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

    socket.on('host:setFlush', ({ flush } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setFlush(flush);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, flush: game.flush });
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

    socket.on('host:rematch', (_p, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      clearBots();
      const res = game.rematch();
      if (!res.ok) return ack && ack(res);
      nextEmoteAt.clear();
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
      nextEmoteAt.clear();
      ack && ack({ ok: true });
      ns.emit('state:reset');
      broadcastLobby();
    });

    socket.on('host:leave', (_p, ack) => {
      if (!requireHost(ack)) return;
      clearBots();
      game.reset();
      nextEmoteAt.clear();
      hostLeftIntentionally = true;
      if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
      reactionsMuted = false;
      // Phones drop their seat now (back to join) — the host-absent overlay covers it.
      ns.except(HOST_ROOM).emit('state:reset');
      emitHostPresence(false);
      ack && ack({ ok: true });
    });

    socket.on('disconnect', () => {
      if (role === 'player') {
        // A dropped phone is backgrounded, not gone: the seat and the deck stay
        // put, and if it was their turn the table simply waits.
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

  // The socket test (scripts/itest-ratscrew.js) stacks decks through this handle.
  return { game };
}

module.exports = mountRatscrew;
