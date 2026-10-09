'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const {
  Game,
  PHASES,
  STAGES,
  MIN_ROUND_SEC,
  MAX_ROUND_SEC,
  ROUND_SEC_STEP,
  DEFAULT_ROUND_SEC,
  MIN_ROUNDS_TO_WIN,
  MAX_ROUNDS_TO_WIN,
  DEFAULT_ROUNDS_TO_WIN,
} = require('./game');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const INACTIVITY_RESET_MS = 60 * 60 * 1000; // 60 minutes
const HOST_GRACE_MS = 15000;

// 6-emoji reactions (index into REACTION_EMOJIS on the host + player pages).
const REACTION_COUNT = 6;
const REACTION_COOLDOWN_MS = 3000;

/**
 * Mount Snek onto the hub's Express app and HTTP server.
 *
 * The live game runs on the HOST browser; this module is a thin relay + lobby
 * manager + match-meta cache. It MUST reuse the single shared Socket.IO Server
 * cached on the HTTP server (httpServer._triviaIo) — creating a second Server
 * binds a second engine.io upgrade handler and crashes on the first WebSocket
 * upgrade.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountSnek(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

  const game = new Game();
  let hostCount = 0;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  let hostLeftIntentionally = false;
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
      game.clearSoloBest();
      ns.emit('state:reset');
      broadcastLobby();
      console.log('[snek] auto-reset after 60 minutes of inactivity.');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  app.get('/snek/host', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'snek', 'host.html'));
  });
  app.get('/snek/join', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'snek', 'join.html'));
  });
  app.get('/snek/play', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'snek', 'player.html'));
  });

  // ---------------- REST endpoints ----------------
  app.get('/api/snek/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({
      joinUrl: `${base}/snek/join`,
      minRoundSec: MIN_ROUND_SEC,
      maxRoundSec: MAX_ROUND_SEC,
      roundSecStep: ROUND_SEC_STEP,
      defaultRoundSec: DEFAULT_ROUND_SEC,
      minRoundsToWin: MIN_ROUNDS_TO_WIN,
      maxRoundsToWin: MAX_ROUNDS_TO_WIN,
      defaultRoundsToWin: DEFAULT_ROUNDS_TO_WIN,
    });
  });

  app.get('/api/snek/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#0f2a1d', light: '#FFFFFF' },
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
  const ns = io.of('/snek');

  function broadcastLobby() {
    ns.emit('state:lobby', game.getLobby());
  }

  function startPayload(res) {
    return {
      roster: res.roster,
      mode: res.mode,
      roundLengthSec: game.roundLengthSec,
      roundsToWin: game.roundsToWin,
      powerups: game.powerups,
      soloBest: game.soloBest,
    };
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
        player: { id: res.player.id, name: res.player.name },
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
        player: { id: res.player.id, name: res.player.name },
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

    // Controller input relay: forwarded straight to the host with the player's
    // id attached. dir: 0=up 1=down 2=left 3=right (a turn request).
    socket.on('in', (msg) => {
      if (role !== 'player' || !playerId) return;
      if (game.phase !== PHASES.PLAYING || !game.match.live) return;
      if (game.match.paused) return;
      if (game.match.alive && game.match.alive[playerId] === false) return;
      const dir = msg && msg.dir;
      if (dir !== 0 && dir !== 1 && dir !== 2 && dir !== 3) return;
      ns.to(HOST_ROOM).emit('in', { id: playerId, dir });
    });

    // Reactions: downtime only (lobby, round results, final), cooldown-throttled,
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
      if (wasAbsent) emitHostPresence(true);
      const payload = {
        ok: true,
        phase: game.phase,
        lobby: game.getLobby(),
        reactionsMuted,
        minRoundSec: MIN_ROUND_SEC,
        maxRoundSec: MAX_ROUND_SEC,
        roundSecStep: ROUND_SEC_STEP,
        minRoundsToWin: MIN_ROUNDS_TO_WIN,
        maxRoundsToWin: MAX_ROUNDS_TO_WIN,
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

    socket.on('host:setRoundLength', ({ roundLengthSec } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setRoundLength(roundLengthSec);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, roundLengthSec: game.roundLengthSec });
      broadcastLobby();
    });

    socket.on('host:setPowerups', ({ on } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setPowerups(on);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, powerups: game.powerups });
      broadcastLobby();
    });

    socket.on('host:setRoundsToWin', ({ roundsToWin } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setRoundsToWin(roundsToWin);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, roundsToWin: game.roundsToWin });
      broadcastLobby();
    });

    socket.on('host:setReactionsMuted', ({ muted } = {}, ack) => {
      if (!requireHost(ack)) return;
      reactionsMuted = !!muted;
      ack && ack({ ok: true, reactionsMuted });
      ns.emit('state:reactionsMuted', { muted: reactionsMuted });
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

    socket.on('host:reorder', ({ playerId: pid, beforeId } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.reorderPlayer(pid, beforeId);
      if (!res.ok) return ack && ack(res);
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
      touchActivity();
      const res = game.startMatch();
      if (!res.ok) return ack && ack(res);
      const payload = startPayload(res);
      ack && ack(Object.assign({ ok: true }, payload));
      ns.emit('m:start', payload);
      broadcastLobby();
    });

    // Solo "Play again" from the phone: only the lone player of a finished
    // solo game can ask; the host restarts it exactly like its own button.
    socket.on('player:playAgain', (_p, ack) => {
      if (role !== 'player' || !playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (game.phase !== PHASES.FINAL || game.match.mode !== 'solo') return ack && ack({ ok: false, reason: 'not-solo-final' });
      if (!game.players.has(playerId)) return ack && ack({ ok: false, reason: 'unknown-player' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      touchActivity();
      ns.to(HOST_ROOM).emit('host:playAgainRequest', {});
      ack && ack({ ok: true });
    });

    socket.on('host:rematch', (_p, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const res = game.rematch();
      if (!res.ok) return ack && ack(res);
      const payload = startPayload(res);
      ack && ack(Object.assign({ ok: true }, payload));
      ns.emit('m:start', payload);
      broadcastLobby();
    });

    // ---- Live match meta pushed by the host (rebroadcast to players) ----
    socket.on('host:roundStart', ({ round, mapIndex, durationSec } = {}) => {
      if (role !== 'host' || game.phase !== PHASES.PLAYING) return;
      touchActivity();
      game.setRound(round, mapIndex);
      game.setClock((durationSec || game.roundLengthSec) * 1000);
      game.setLive(false);
      game.setPaused(false);
      game.setStage(STAGES.COUNTDOWN);
      game.setAllAlive();
      game.clearPowers();
      ns.to(PLAYER_ROOM).emit('m:roundStart', {
        round: game.match.round,
        mapIndex: game.match.mapIndex,
        roundsToWin: game.roundsToWin,
        durationSec: durationSec || game.roundLengthSec,
        mode: game.match.mode,
      });
    });
    socket.on('host:countdown', ({ n } = {}) => {
      if (role !== 'host' || game.phase !== PHASES.PLAYING) return;
      touchActivity();
      game.setLive(false);
      game.setStage(STAGES.COUNTDOWN);
      ns.to(PLAYER_ROOM).emit('m:countdown', { n });
    });
    socket.on('host:play', () => {
      if (role !== 'host' || game.phase !== PHASES.PLAYING) return;
      game.setLive(true);
      game.setStage(STAGES.PLAY);
      ns.to(PLAYER_ROOM).emit('m:play', {});
    });
    socket.on('host:pause', () => {
      if (role !== 'host' || game.phase !== PHASES.PLAYING) return;
      touchActivity();
      game.setPaused(true);
      ns.to(PLAYER_ROOM).emit('m:pause', {});
    });
    // Resume 3-2-1 (the game stays paused until it ends); n = 0 cancels it.
    socket.on('host:resumeCount', ({ n } = {}) => {
      if (role !== 'host') return;
      const v = Math.max(0, Math.min(9, Number(n) | 0));
      ns.to(PLAYER_ROOM).emit('m:resumeCount', { n: v });
    });
    socket.on('host:resume', ({ live } = {}) => {
      if (role !== 'host' || game.phase !== PHASES.PLAYING) return;
      touchActivity();
      game.setPaused(false);
      ns.to(PLAYER_ROOM).emit('m:resume', { live: !!live });
    });
    socket.on('host:clock', ({ ms, lengths } = {}) => {
      if (role !== 'host' || game.phase !== PHASES.PLAYING) return;
      game.setClock(ms);
      if (lengths) game.setLengths(lengths);
      ns.to(PLAYER_ROOM).emit('m:clock', { ms: game.match.clockMs, lengths: game.match.lengths });
    });
    // A snake picked up (sec > 0) or lost (sec 0) a power-up: tell the phones.
    socket.on('host:power', ({ id, power, sec } = {}) => {
      if (role !== 'host' || game.phase !== PHASES.PLAYING) return;
      if (!id || !game.players.has(id)) return;
      if (power !== 'magnet' && power !== 'phantom') return;
      const s = Math.max(0, Math.min(30, Number(sec) || 0));
      game.setPower(id, power, s);
      ns.to(PLAYER_ROOM).emit('m:power', { id, power, sec: s });
    });
    socket.on('host:eliminated', ({ id, length } = {}) => {
      if (role !== 'host' || game.phase !== PHASES.PLAYING) return;
      if (!id || !game.players.has(id)) return;
      touchActivity();
      game.setAlive({ [id]: false });
      game.setPower(id, null, 0);
      if (Number.isFinite(length)) game.setLengths({ [id]: length });
      ns.to(PLAYER_ROOM).emit('m:eliminated', { id, length: game.match.lengths[id] || 0 });
    });
    // The round is decided (slow-mo + frozen clock): controls go dead now.
    socket.on('host:decided', () => {
      if (role !== 'host' || game.phase !== PHASES.PLAYING) return;
      game.setLive(false);
      ns.to(PLAYER_ROOM).emit('m:decided', {});
    });
    socket.on('host:roundOver', ({ round, winnerId, draw, reason, lengths, gamePoints, alive } = {}) => {
      if (role !== 'host' || game.phase !== PHASES.PLAYING) return;
      touchActivity();
      game.setLive(false);
      game.setStage(STAGES.ROUNDOVER);
      if (lengths) game.setLengths(lengths);
      if (gamePoints) game.setGamePoints(gamePoints);
      if (alive) game.setAlive(alive);
      game.setLastRound({ round, winnerId, draw, reason });
      ns.to(PLAYER_ROOM).emit('m:roundOver', {
        round: game.match.lastRound.round,
        winnerId: game.match.lastRound.winnerId,
        draw: game.match.lastRound.draw,
        reason: game.match.lastRound.reason,
        lengths: game.match.lengths,
        gamePoints: game.match.gamePoints,
        roundsToWin: game.roundsToWin,
      });
    });
    socket.on('host:matchEnd', ({ winnerIds, gamePoints, awards, soloScore, soloLength } = {}, ack) => {
      if (role !== 'host' || game.phase !== PHASES.PLAYING) return ack && ack({ ok: false, reason: 'not-playing' });
      touchActivity();
      game.endMatch({ winnerIds, gamePoints, awards, soloScore, soloLength });
      const out = {
        mode: game.match.mode,
        winnerIds: game.match.winnerIds,
        gamePoints: game.match.gamePoints,
        lengths: game.match.lengths,
        solo: game.match.solo,
        soloBest: game.soloBest,
      };
      ack && ack(Object.assign({ ok: true }, out));
      ns.to(PLAYER_ROOM).emit('m:end', out);
      broadcastLobby();
    });

    socket.on('host:reset', (_p, ack) => {
      if (!requireHost(ack)) return;
      const keepConfig = game.phase !== PHASES.LOBBY;
      game.reset(keepConfig);
      lastReactionAt.clear();
      ack && ack({ ok: true });
      ns.emit('state:reset');
      broadcastLobby();
    });

    socket.on('host:leave', (_p, ack) => {
      if (!requireHost(ack)) return;
      game.reset();
      game.clearSoloBest();
      lastReactionAt.clear();
      hostLeftIntentionally = true;
      if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
      emitHostPresence(false);
      ack && ack({ ok: true });
    });

    socket.on('disconnect', () => {
      if (role === 'player') {
        game.markDisconnected(socket.id);
        broadcastLobby();
        ns.to(HOST_ROOM).emit('player:dropped', { id: playerId });
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

module.exports = mountSnek;
