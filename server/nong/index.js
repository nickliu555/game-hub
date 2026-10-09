'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game, PHASES, CAPACITY } = require('./game');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const INACTIVITY_RESET_MS = 60 * 60 * 1000; // 60 minutes
const HOST_GRACE_MS = 15000;

/**
 * Mount Nong onto the hub's Express app and HTTP server.
 *
 * The live match is simulated on the HOST browser (public/nong/js/engine.js);
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
function mountNong(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

  const game = new Game();
  let hostCount = 0;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  let hostLeftIntentionally = false;
  // The host browser runs the physics, so exactly one screen may drive a match.
  let activeHostId = null;

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
      ns.emit('state:reset');
      broadcastLobby();
      console.log('[nong] auto-reset after 60 minutes of inactivity.');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  app.get('/nong/host', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'nong', 'host.html'));
  });
  app.get('/nong/join', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'nong', 'join.html'));
  });
  app.get('/nong/play', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'nong', 'player.html'));
  });

  // ---------------- REST endpoints ----------------
  app.get('/api/nong/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({ joinUrl: `${base}/nong/join`, capacity: CAPACITY });
  });

  app.get('/api/nong/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#0A0A14', light: '#FFFFFF' },
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
  const ns = io.of('/nong');

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
        lobby: game.getLobby(),
      };
      if (game.phase === PHASES.PLAYING || game.phase === PHASES.FINAL) {
        payload.match = game.getMatchMeta();
      }
      ack && ack(payload);
      if (game.phase === PHASES.PLAYING) ns.to(HOST_ROOM).emit('player:rejoined', { id: pid });
      broadcastLobby();
    });

    // Paddle input relay — the latency-critical path, kept minimal.
    // p: 0..1000, the thumb's position along the phone's slider.
    socket.on('in', (msg) => {
      if (role !== 'player' || !playerId) return;
      if (game.phase !== PHASES.PLAYING) return;
      if (game.match.paused) return;
      const p = msg && msg.p;
      if (!Number.isInteger(p) || p < 0 || p > 1000) return;
      ns.to(HOST_ROOM).emit('in', { id: playerId, p });
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

    socket.on('host:setTarget', ({ mode, value } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setTarget(mode, value);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:reorder', ({ playerId: pid, beforeId } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.reorder(pid, typeof beforeId === 'string' ? beforeId : null);
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

    socket.on('host:start', (_p, ack) => {
      if (!requireHost(ack)) return;
      if (!isActiveHost()) return ack && ack({ ok: false, reason: 'not-active-host' });
      touchActivity();
      const res = game.startMatch();
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, match: res.meta });
      ns.emit('m:start', res.meta);
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
    socket.on('host:play', () => {
      if (!isActiveHost() || game.phase !== PHASES.PLAYING) return;
      game.setLive(true);
      ns.to(PLAYER_ROOM).emit('m:play', {});
    });
    // The heartbeat carries the full authoritative snapshot so a phone that
    // missed an event (backgrounded, signal blip) re-syncs within a moment.
    socket.on('host:sync', ({ scores, out, live, paused } = {}) => {
      if (!isActiveHost() || game.phase !== PHASES.PLAYING) return;
      game.setScores(scores, out);
      if (typeof paused === 'boolean') game.setPaused(paused);
      if (typeof live === 'boolean') game.setLive(live);
      ns.to(PLAYER_ROOM).emit('m:sync', {
        scores: game.match.scores,
        out: game.match.out,
        live: game.match.live,
        paused: game.match.paused,
      });
    });
    socket.on('host:point', ({ concededId, scorerId, eliminatedId, scores, out } = {}) => {
      if (!isActiveHost() || game.phase !== PHASES.PLAYING) return;
      touchActivity();
      game.setScores(scores, out);
      game.setLive(false);
      ns.to(PLAYER_ROOM).emit('m:point', {
        concededId: game.isRosterId(concededId) ? concededId : null,
        scorerId: game.isRosterId(scorerId) ? scorerId : null,
        eliminatedId: game.isRosterId(eliminatedId) ? eliminatedId : null,
        scores: game.match.scores,
        out: game.match.out,
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
    socket.on('host:matchEnd', ({ winnerId, scores, out } = {}) => {
      if (!isActiveHost()) return;
      touchActivity();
      const res = game.endMatch({ winnerId, scores, out });
      if (!res.ok) return;
      const meta = game.getMatchMeta();
      ns.to(PLAYER_ROOM).emit('m:end', {
        winnerId: meta.winnerId,
        scores: meta.scores,
        out: meta.out,
        placings: meta.placings,
      });
    });

    socket.on('host:reset', (_p, ack) => {
      if (!requireHost(ack)) return;
      if (!isActiveHost()) return ack && ack({ ok: false, reason: 'not-active-host' });
      // Reset from a live/finished match keeps the target settings; a lobby
      // reset returns them to defaults.
      const keepConfig = game.phase !== PHASES.LOBBY;
      game.reset(keepConfig);
      ack && ack({ ok: true });
      ns.emit('state:reset');
      broadcastLobby();
    });

    socket.on('host:leave', (_p, ack) => {
      if (!requireHost(ack)) return;
      if (!isActiveHost()) return ack && ack({ ok: false, reason: 'not-active-host' });
      game.reset();
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

module.exports = mountNong;
