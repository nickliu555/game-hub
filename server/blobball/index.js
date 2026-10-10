'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game, PHASES, CAPACITY } = require('./game');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const INACTIVITY_RESET_MS = 60 * 60 * 1000; // 60 minutes
const HOST_GRACE_MS = 15000;

// 6-emoji reactions (index into REACTION_EMOJIS on the host + player pages).
const REACTION_COUNT = 6;
const REACTION_COOLDOWN_MS = 5000;

/**
 * Mount Blob Ball onto the hub's Express app and HTTP server.
 *
 * The live match is simulated on the HOST browser (public/blobball/js/engine.js);
 * this module is a thin relay + lobby manager. It MUST reuse the single shared
 * Socket.IO Server cached on the HTTP server (httpServer._triviaIo) — creating
 * a second Server binds a second engine.io upgrade handler and crashes on the
 * first WebSocket upgrade.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountBlobBall(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

  const game = new Game();
  let hostCount = 0;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  let hostLeftIntentionally = false;
  // The host browser runs the physics, so exactly one screen may drive a match.
  let activeHostId = null;
  let reactionsMuted = false;
  const lastReactionAt = new Map();

  function isHostPresent() {
    if (hostLeftIntentionally) return false;
    if (hostCount > 0) return true;
    return lastHostSeenAt > 0 && (Date.now() - lastHostSeenAt) < HOST_GRACE_MS;
  }
  function emitHostPresence(present) {
    ns.emit('state:hostPresence', { present: !!present });
  }

  // Inactivity auto-reset.
  let lastActivity = Date.now();
  function touchActivity() { lastActivity = Date.now(); }
  setInterval(() => {
    if (Date.now() - lastActivity >= INACTIVITY_RESET_MS) {
      game.reset();
      lastReactionAt.clear();
      ns.emit('state:reset');
      broadcastLobby();
      console.log('[blobball] auto-reset after 60 minutes of inactivity.');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  app.get('/blobball/host', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'blobball', 'host.html'));
  });
  app.get('/blobball/join', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'blobball', 'join.html'));
  });
  app.get('/blobball/play', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'blobball', 'player.html'));
  });

  // ---------------- REST endpoints ----------------
  app.get('/api/blobball/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({ joinUrl: `${base}/blobball/join`, capacity: CAPACITY });
  });

  app.get('/api/blobball/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#0B2B3D', light: '#FFFFFF' },
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      res.send(svg);
    } catch (e) {
      res.status(500).send('qr error');
    }
  });

  // ---------------- Socket.IO namespace ----------------
  if (!httpServer._triviaIo) {
    httpServer._triviaIo = new Server(httpServer, { cors: { origin: '*' } });
  }
  const io = httpServer._triviaIo;
  const ns = io.of('/blobball');

  function broadcastLobby() {
    ns.emit('state:lobby', game.getLobby());
  }

  function playerPayload(p) {
    return { id: p.id, name: p.name };
  }

  // ---------------- Socket handlers ----------------
  ns.on('connection', (socket) => {
    let role = null;
    let playerId = null;

    socket.on('query:status', (_p, ack) => {
      ack && ack({ hostPresent: isHostPresent(), phase: game.phase });
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
        player: playerPayload(res.player),
        hostPresent: isHostPresent(),
        phase: game.phase,
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
        player: playerPayload(res.player),
        phase: game.phase,
        hostPresent: isHostPresent(),
        reactionsMuted,
        lobby: game.getLobby(),
      };
      if (game.phase === PHASES.PLAYING || game.phase === PHASES.FINAL) {
        payload.match = game.getMatchMeta();
      }
      ack && ack(payload);
      if (game.phase === PHASES.PLAYING) ns.to(HOST_ROOM).emit('player:rejoined', { id: pid });
      broadcastLobby();
    });

    // Controller input relay — the latency-critical path, kept minimal.
    // c: 0 = left, 1 = right, 2 = jump; d: 1 down / 0 up. Relayed while paused
    // too, so a button let go during a pause never comes back stuck down.
    socket.on('in', (msg) => {
      if (role !== 'player' || !playerId) return;
      if (game.phase !== PHASES.PLAYING) return;
      const c = msg && msg.c;
      if (c !== 0 && c !== 1 && c !== 2) return;
      ns.to(HOST_ROOM).emit('in', { id: playerId, c, d: msg.d ? 1 : 0 });
    });

    // Reactions: downtime only (lobby + final results), cooldown-throttled,
    // and silenced entirely while the host has them muted.
    socket.on('player:reaction', ({ index } = {}, ack) => {
      if (role !== 'player' || !playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= REACTION_COUNT) {
        return ack && ack({ ok: false, reason: 'bad-index' });
      }
      if (!game.reactionsOpen()) return ack && ack({ ok: false, reason: 'phase-closed' });
      if (reactionsMuted) return ack && ack({ ok: false, reason: 'muted' });
      const now = Date.now();
      const last = lastReactionAt.get(playerId) || 0;
      if (now - last < REACTION_COOLDOWN_MS) {
        return ack && ack({ ok: false, reason: 'cooldown', retryInMs: REACTION_COOLDOWN_MS - (now - last) });
      }
      lastReactionAt.set(playerId, now);
      ack && ack({ ok: true });
      ns.to(HOST_ROOM).emit('host:reaction', { index, id: playerId });
    });

    // ---- Host flows ----
    socket.on('host:auth', (_p, ack) => {
      role = 'host';
      socket.join(HOST_ROOM);
      if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
      const wasAbsent = !isHostPresent();
      hostLeftIntentionally = false;
      hostCount += 1;
      lastHostSeenAt = Date.now();
      if (activeHostId && activeHostId !== socket.id && ns.sockets.get(activeHostId)) {
        ns.to(activeHostId).emit('host:superseded');
      }
      activeHostId = socket.id;
      if (wasAbsent) emitHostPresence(true);
      const payload = {
        ok: true,
        phase: game.phase,
        lobby: game.getLobby(),
        reactionsMuted,
      };
      if (game.phase === PHASES.PLAYING || game.phase === PHASES.FINAL) {
        payload.match = game.getMatchMeta();
      }
      ack && ack(payload);
    });

    function requireHost(ack) {
      if (role !== 'host') {
        ack && ack({ ok: false, reason: 'not-host' });
        return false;
      }
      return true;
    }

    // Only one screen may drive the live match. The newest host screen claims
    // it; if the holder has gone away the slot is free for the next host.
    function isActiveHost() {
      if (role !== 'host') return false;
      if (activeHostId && !ns.sockets.get(activeHostId)) activeHostId = null;
      if (!activeHostId) activeHostId = socket.id;
      return activeHostId === socket.id;
    }

    socket.on('host:setTarget', ({ value } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setTarget(value);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:swap', (_p, ack) => {
      if (!requireHost(ack)) return;
      const res = game.swapSides();
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:kick', ({ playerId: pid } = {}, ack) => {
      if (!requireHost(ack)) return;
      if (game.phase !== PHASES.LOBBY) return ack && ack({ ok: false, reason: 'not-lobby' });
      const p = game.removePlayer(pid);
      if (!p) return ack && ack({ ok: false, reason: 'unknown-player' });
      if (p.socketId) ns.to(p.socketId).emit('player:rejected', { reason: 'kicked' });
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:addBot', (_p, ack) => {
      if (!requireHost(ack)) return;
      const res = game.addBot();
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:setReactionsMuted', ({ muted } = {}, ack) => {
      if (!requireHost(ack)) return;
      reactionsMuted = !!muted;
      ack && ack({ ok: true, reactionsMuted });
      ns.emit('state:reactionsMuted', { muted: reactionsMuted });
    });

    socket.on('host:start', (_p, ack) => {
      if (!requireHost(ack)) return;
      if (!isActiveHost()) return ack && ack({ ok: false, reason: 'not-active-host' });
      touchActivity();
      const res = game.startMatch();
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, match: res.meta });
      ns.emit('m:start', res.meta);
    });

    // Play again from the results screen: same roster, sides and target.
    socket.on('host:rematch', (_p, ack) => {
      if (!requireHost(ack)) return;
      if (!isActiveHost()) return ack && ack({ ok: false, reason: 'not-active-host' });
      touchActivity();
      const res = game.rematch();
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, match: res.meta });
      ns.emit('m:start', res.meta);
      broadcastLobby();
    });

    // ---- Live match meta pushed by the host (rebroadcast to players) ----
    socket.on('host:countdown', ({ n, note } = {}) => {
      if (!isActiveHost() || game.phase !== PHASES.PLAYING) return;
      touchActivity();
      game.setLive(false);
      ns.to(PLAYER_ROOM).emit('m:countdown', {
        n: Number.isInteger(n) ? n : 0,
        note: typeof note === 'string' ? note.slice(0, 40) : null,
      });
    });
    // The ball is hanging over the server, about to drop.
    socket.on('host:serve', ({ serverId } = {}) => {
      if (!isActiveHost() || game.phase !== PHASES.PLAYING) return;
      game.setLive(false);
      ns.to(PLAYER_ROOM).emit('m:serve', { serverId: game.isRosterId(serverId) ? serverId : null });
    });
    socket.on('host:play', () => {
      if (!isActiveHost() || game.phase !== PHASES.PLAYING) return;
      game.setLive(true);
      ns.to(PLAYER_ROOM).emit('m:play', {});
    });
    // The heartbeat carries the full authoritative snapshot so a phone that
    // missed an event (backgrounded, signal blip) re-syncs within a moment.
    socket.on('host:sync', ({ scores, live, paused } = {}) => {
      if (!isActiveHost() || game.phase !== PHASES.PLAYING) return;
      game.setScores(scores);
      if (typeof paused === 'boolean') game.setPaused(paused);
      if (typeof live === 'boolean') game.setLive(live);
      ns.to(PLAYER_ROOM).emit('m:sync', {
        scores: game.match.scores,
        live: game.match.live,
        paused: game.match.paused,
      });
    });
    socket.on('host:point', ({ scorerId, scores } = {}) => {
      if (!isActiveHost() || game.phase !== PHASES.PLAYING) return;
      touchActivity();
      game.setScores(scores);
      game.setLive(false);
      ns.to(PLAYER_ROOM).emit('m:point', {
        scorerId: game.isRosterId(scorerId) ? scorerId : null,
        scores: game.match.scores,
      });
    });
    socket.on('host:pause', () => {
      if (!isActiveHost() || game.phase !== PHASES.PLAYING) return;
      touchActivity();
      game.setPaused(true);
      ns.to(PLAYER_ROOM).emit('m:pause', {});
    });
    // Resume 3-2-1 (the game stays paused until it ends); n = 0 cancels it.
    socket.on('host:resumeCount', ({ n } = {}) => {
      if (!isActiveHost()) return;
      const v = Math.max(0, Math.min(9, Number(n) | 0));
      ns.to(PLAYER_ROOM).emit('m:resumeCount', { n: v });
    });
    socket.on('host:resume', ({ live } = {}) => {
      if (!isActiveHost() || game.phase !== PHASES.PLAYING) return;
      touchActivity();
      game.setPaused(false);
      ns.to(PLAYER_ROOM).emit('m:resume', { live: !!live });
    });
    socket.on('host:matchEnd', ({ winnerId, scores } = {}) => {
      if (!isActiveHost()) return;
      touchActivity();
      const res = game.endMatch({ winnerId, scores });
      if (!res.ok) return;
      const meta = game.getMatchMeta();
      ns.to(PLAYER_ROOM).emit('m:end', {
        winnerId: meta.winnerId,
        scores: meta.scores,
      });
    });

    socket.on('host:reset', (_p, ack) => {
      if (!requireHost(ack)) return;
      if (!isActiveHost()) return ack && ack({ ok: false, reason: 'not-active-host' });
      // Reset from a live/finished match keeps the target setting; a lobby
      // reset returns it to the default.
      const keepConfig = game.phase !== PHASES.LOBBY;
      game.reset(keepConfig);
      lastReactionAt.clear();
      ack && ack({ ok: true });
      ns.emit('state:reset');
      broadcastLobby();
    });

    socket.on('host:leave', (_p, ack) => {
      if (!requireHost(ack)) return;
      if (!isActiveHost()) return ack && ack({ ok: false, reason: 'not-active-host' });
      game.reset();
      lastReactionAt.clear();
      hostLeftIntentionally = true;
      if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
      emitHostPresence(false);
      ack && ack({ ok: true });
    });

    socket.on('disconnect', () => {
      if (role === 'player') {
        // The player stays on the roster — a dropped phone is never a forfeit.
        game.markDisconnected(socket.id);
        broadcastLobby();
        ns.to(HOST_ROOM).emit('player:dropped', { id: playerId });
      } else if (role === 'host') {
        if (activeHostId === socket.id) activeHostId = null;
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

module.exports = mountBlobBall;
