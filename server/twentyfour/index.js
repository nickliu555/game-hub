'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game, PHASES, SKIP_LOCKOUT_MS } = require('./game');
const { isBlocked } = require('./profanity');
const { counts } = require('./puzzles');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const INACTIVITY_RESET_MS = 60 * 60 * 1000; // 60 minutes
const HOST_GRACE_MS = 15000;

/**
 * Mount the "24" math game onto the hub's Express app and HTTP server.
 *
 * Architecture mirrors server/trivia/: a Socket.IO namespace at /twentyfour
 * for all real-time events, plus a couple of REST endpoints for QR/config.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountTwentyFour(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

  // ---------------- Game state ----------------
  const game = new Game();
  let hostCount = 0;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  let hostLeftIntentionally = false;
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
      console.log('[twentyfour] auto-reset after 60 minutes of inactivity.');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  app.get('/twentyfour/host', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'twentyfour', 'host.html'));
  });
  app.get('/twentyfour/join', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'twentyfour', 'join.html'));
  });
  app.get('/twentyfour/play', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'twentyfour', 'player.html'));
  });
  // Solo practice mode — no socket connection, runs entirely client-side
  // off the pre-generated puzzles.json + solutions.json static assets.
  app.get('/twentyfour/practice', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'twentyfour', 'practice.html'));
  });

  // ---------------- REST endpoints ----------------
  app.get('/api/twentyfour/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({ joinUrl: `${base}/twentyfour/join`, puzzleCounts: counts() });
  });

  app.get('/api/twentyfour/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#1A1A1A', light: '#FFFFFF' },
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      res.send(svg);
    } catch (e) {
      res.status(500).send('qr error');
    }
  });

  // ---------------- Socket.IO namespace ----------------
  // Reuse the same Server instance trivia attached (cached on httpServer)
  // so we don't bind two engines to the same port.
  if (!httpServer._triviaIo) {
    httpServer._triviaIo = new Server(httpServer, { cors: { origin: '*' } });
  }
  const io = httpServer._triviaIo;
  const ns = io.of('/twentyfour');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() {
    ns.emit('state:lobby', {
      phase: game.phase,
      players: game.getLobbyPlayers(),
      total: game.players.size,
    });
  }
  function broadcastRound() {
    ns.emit('state:round', game.getRoundPublic());
  }
  function broadcastIntro() {
    ns.emit('state:intro', game.getIntroPublic());
  }
  function broadcastFinal() {
    ns.emit('state:final', {
      podium: game.getPodium(),
      fullLeaderboard: game.getLeaderboard(),
    });
    // Per-player private payload: list of puzzle ids each player didn't
    // finish (skipped + in-flight at buzzer). Sent privately so a player's
    // misses aren't visible to everyone via DevTools. Players without a
    // live socket get the data via the reconnect snapshot below.
    for (const player of game.players.values()) {
      if (!player.socketId) continue;
      ns.to(player.socketId).emit('you:final', game.getPersonalFinal(player.id));
    }
  }
  function broadcastScores() {
    ns.emit('score:update', { leaderboard: game.getLeaderboard() });
  }
  function sendPuzzleTo(player) {
    if (!player || !player.socketId) return;
    if (player.done) {
      // Player exhausted the shared queue earlier this round (or just now).
      // Send the lock-out event so their client shows the "all solved"
      // screen rather than waiting for a puzzle that will never arrive.
      ns.to(player.socketId).emit('puzzle:done', {
        solvedCount: player.solvedCount,
        skippedCount: player.skippedCount,
      });
      return;
    }
    const payload = game.getPuzzlePayloadFor(player.id);
    if (!payload) return;
    ns.to(player.socketId).emit('puzzle:next', payload);
  }

  // When the round timer fires server-side, switch everyone to FINAL.
  game.onRoundEnd = () => {
    broadcastFinal();
  };

  // When the pre-round INTRO countdown elapses, the game has just armed the
  // round timer and served puzzle #1 to every player — push the matching
  // socket events so clients leave the "Get ready" splash.
  game.onIntroEnd = () => {
    broadcastRound();
    broadcastScores();
    for (const player of game.players.values()) {
      sendPuzzleTo(player);
    }
  };

  // ---------------- Socket handlers ----------------
  ns.on('connection', (socket) => {
    let role = null;
    let playerId = null;

    socket.on('query:status', (_p, ack) => {
      ack && ack({
        hostPresent: isHostPresent(),
        phase: game.phase,
      });
    });

    // ---- Player flows ----
    socket.on('player:join', ({ playerId: pid, name } = {}, ack) => {
      touchActivity();
      if (!pid || typeof pid !== 'string') return ack && ack({ ok: false, reason: 'bad-player-id' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (isBlocked(name)) return ack && ack({ ok: false, reason: 'name-blocked' });
      const res = game.addPlayer({ playerId: pid, name, socketId: socket.id });
      if (!res.ok) return ack && ack(res);
      role = 'player';
      playerId = pid;
      socket.join(PLAYER_ROOM);
      ack && ack({
        ok: true,
        player: { id: res.player.id, name: res.player.name, score: res.player.score },
        hostPresent: isHostPresent(),
        phase: game.phase,
      });
      broadcastLobby();
      // If the round is already running, the player was given an initial
      // puzzle by addPlayer() — push it to them and update everyone's view
      // of the round + scoreboard.
      if (game.phase === PHASES.INTRO) {
        socket.emit('state:intro', game.getIntroPublic());
      } else if (game.phase === PHASES.ROUND) {
        socket.emit('state:round', game.getRoundPublic());
        sendPuzzleTo(res.player);
        broadcastScores();
      }
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
        player: { id: res.player.id, name: res.player.name, score: res.player.score },
        phase: game.phase,
        hostPresent: isHostPresent(),
        total: game.players.size,
      };
      if (game.phase === PHASES.ROUND) {
        payload.round = game.getRoundPublic();
        if (res.player.done) {
          // Player previously cleared the shared queue this round. Restore
          // the locked-out view rather than trying to send them a puzzle.
          payload.done = {
            solvedCount: res.player.solvedCount,
            skippedCount: res.player.skippedCount,
          };
        } else {
          payload.currentPuzzle = game.getPuzzlePayloadFor(pid);
        }
      } else if (game.phase === PHASES.INTRO) {
        payload.intro = game.getIntroPublic();
      } else if (game.phase === PHASES.FINAL) {
        payload.podium = game.getPodium();
        payload.fullLeaderboard = game.getLeaderboard();
        // Personal "puzzles you didn't finish" payload — same shape as
        // the live `you:final` event so the client handler can reuse it.
        payload.youFinal = game.getPersonalFinal(pid);
      }
      ack && ack(payload);
      broadcastLobby();
    });

    socket.on('player:solve', ({ puzzleId, steps } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (typeof puzzleId !== 'number') return ack && ack({ ok: false, reason: 'bad-puzzle' });
      const res = game.submitSolve({ playerId, puzzleId, steps });
      if (!res.ok) return ack && ack(res);
      ack && ack({
        ok: true,
        accepted: res.accepted,
        score: res.score,
        next: res.next || null,
        done: !!res.done,
      });
      if (res.accepted) {
        broadcastScores();
      }
      if (res.done) {
        const p = game.players.get(playerId);
        if (p) sendPuzzleTo(p);
      }
    });

    socket.on('player:skip', ({ puzzleId } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (typeof puzzleId !== 'number') return ack && ack({ ok: false, reason: 'bad-puzzle' });
      const res = game.requestSkip({ playerId, puzzleId });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, next: res.next || null, done: !!res.done });
      if (res.done) {
        const p = game.players.get(playerId);
        if (p) sendPuzzleTo(p);
      }
      // Skip count is part of the leaderboard (tiebreaker + visible column on
      // the host). Re-broadcast so all clients refresh — score:update is the
      // existing channel for leaderboard data.
      broadcastScores();
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
      if (wasAbsent) emitHostPresence(true);
      const payload = {
        ok: true,
        phase: game.phase,
        players: game.getLobbyPlayers(),
        puzzleCounts: counts(),
      };
      if (game.phase === PHASES.ROUND) {
        payload.round = game.getRoundPublic();
        payload.leaderboard = game.getLeaderboard();
      } else if (game.phase === PHASES.INTRO) {
        payload.intro = game.getIntroPublic();
      } else if (game.phase === PHASES.FINAL) {
        payload.podium = game.getPodium();
        payload.fullLeaderboard = game.getLeaderboard();
      }
      ack && ack(payload);
      // Push the appropriate state events so the host UI lands on the
      // right screen even after a refresh.
      if (game.phase === PHASES.ROUND) {
        socket.emit('state:round', game.getRoundPublic());
        socket.emit('score:update', { leaderboard: game.getLeaderboard() });
      } else if (game.phase === PHASES.INTRO) {
        socket.emit('state:intro', game.getIntroPublic());
      } else if (game.phase === PHASES.FINAL) {
        socket.emit('state:final', {
          podium: game.getPodium(),
          fullLeaderboard: game.getLeaderboard(),
        });
      }
    });

    function requireHost(ack) {
      if (role !== 'host') {
        ack && ack({ ok: false, reason: 'not-host' });
        return false;
      }
      return true;
    }

    socket.on('host:start', (payload, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const { difficulty, durationMin } = payload || {};
      const res = game.start({ difficulty, durationMin });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
      // Hold everyone on a "Get ready" countdown for a few seconds before
      // the round actually starts. The matching `state:round` + per-player
      // `puzzle:next` are emitted from game.onIntroEnd above when the
      // server-side intro timer elapses.
      broadcastIntro();
    });

    socket.on('host:kick', ({ playerId: pid } = {}, ack) => {
      if (!requireHost(ack)) return;
      const p = game.removePlayer(pid);
      if (!p) return ack && ack({ ok: false, reason: 'unknown-player' });
      if (p.socketId) ns.to(p.socketId).emit('player:rejected', { reason: 'kicked' });
      ack && ack({ ok: true });
      broadcastLobby();
      if (game.phase === PHASES.ROUND) broadcastScores();
    });

    socket.on('host:reset', (_p, ack) => {
      if (!requireHost(ack)) return;
      game.reset();
      ack && ack({ ok: true });
      ns.emit('state:reset');
      broadcastLobby();
    });

    socket.on('host:leave', (_p, ack) => {
      if (!requireHost(ack)) return;
      game.reset();
      hostLeftIntentionally = true;
      if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
      emitHostPresence(false);
      ack && ack({ ok: true });
    });

    socket.on('disconnect', () => {
      if (role === 'player') {
        game.markDisconnected(socket.id);
        broadcastLobby();
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

module.exports = mountTwentyFour;
