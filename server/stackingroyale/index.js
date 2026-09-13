'use strict';

const path = require('path');
const { performance } = require('perf_hooks');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Game, PHASES, MIN_PLAYERS, MAX_PLAYERS, STEP_MS, validId } = require('./game');

const HOST_ROOM = 'hosts';
const HOST_GRACE_MS = 15000;
const INACTIVITY_MS = 60 * 60 * 1000;

function mountStackingRoyale(app, httpServer, opts = {}) {
  const game = new Game();
  const getPublicBaseUrl = opts.getPublicBaseUrl || (() => '');
  if (!httpServer._triviaIo) httpServer._triviaIo = new Server(httpServer, { cors: { origin: '*' } });
  const ns = httpServer._triviaIo.of('/stackingroyale');
  const hosts = new Set();
  let graceTimer = null;
  let closed = false;
  let lastActivity = performance.now();
  let previousTime = lastActivity;
  let accumulator = 0;
  let ticks = 0;

  app.get('/stackingroyale/vendor/lucide.js', (_req, res) => {
    res.sendFile(require.resolve('lucide/dist/umd/lucide.js'));
  });

  for (const [route, file] of Object.entries({ host: 'host', join: 'join', play: 'player', practice: 'practice' })) {
    app.get(`/stackingroyale/${route}`, (_req, res) => {
      res.sendFile(path.join(__dirname, '../../public/stackingroyale', `${file}.html`));
    });
  }
  app.get('/api/stackingroyale/config', (_req, res) => {
    res.json({ joinUrl: `${getPublicBaseUrl()}/stackingroyale/join`, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS });
  });
  app.get('/api/stackingroyale/qr', async (req, res) => {
    const url = req.query.url;
    if (typeof url !== 'string' || !url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg', margin: 1, width: 320, color: { dark: '#182520', light: '#FFFFFF' },
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      res.send(svg);
    } catch (error) {
      res.status(500).send('qr error');
    }
  });

  function touchActivity() {
    lastActivity = performance.now();
  }

  function boardSnapshot(player) {
    return typeof player.board.snapshot === 'function' ? player.board.snapshot() : player.board.snapshot;
  }

  function response(socket) {
    const result = { ok: true, state: game.state(hosts.has(socket.id)) };
    const player = game.players.get(socket.data.playerId);
    if (player && player.socketId === socket.id) {
      result.player = { id: player.id, name: player.name, color: player.color };
      result.seq = player.seq;
      if (player.board) result.board = boardSnapshot(player);
    }
    return result;
  }

  function broadcastState() {
    if (game.phase === PHASES.LOBBY) ns.emit('state:lobby', game.state());
    else {
      ns.to(HOST_ROOM).emit('state:match', game.state(true));
      ns.except(HOST_ROOM).emit('state:match', game.state());
    }
  }

  function broadcastBoards() {
    for (const player of game.players.values()) {
      if (!player.connected || !player.socketId || !player.board) continue;
      ns.to(player.socketId).emit('state:board', { matchId: game.matchId, seq: player.seq, board: boardSnapshot(player) });
    }
  }

  function broadcastSpectators() {
    for (const player of game.players.values()) {
      if (player.alive || !player.connected || !player.spectating) continue;
      const target = game.players.get(player.spectating);
      if (target && target.board) ns.to(player.socketId).emit('state:spectate', { playerId: target.id, view: target.board.view() });
    }
  }

  function setPresence(present) {
    if (game.hostPresent === present) return;
    game.hostPresent = present;
    ns.emit('state:hostPresence', { present });
    broadcastState();
  }

  function removeHost(socket, intentional) {
    if (!hosts.delete(socket.id)) return;
    socket.leave(HOST_ROOM);
    socket.data.role = null;
    if (hosts.size) return;
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = null;
    if (intentional) setPresence(false);
    else {
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (!hosts.size) setPresence(false);
      }, HOST_GRACE_MS);
      graceTimer.unref();
    }
  }

  function reset() {
    game.reset();
    for (const socket of ns.sockets.values()) {
      if (socket.data.role !== 'player') continue;
      socket.data.role = null;
      socket.data.playerId = null;
    }
    accumulator = 0;
    ns.emit('state:reset', game.state());
    broadcastState();
  }

  function onConnection(socket) {
    function on(event, handler) {
      socket.on(event, (payload, ack) => {
        if (closed) return;
        if (typeof payload === 'function') {
          ack = payload;
          payload = {};
        }
        const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
        handler(data, result => { if (typeof ack === 'function') ack(result); });
      });
    }

    function playerForSocket() {
      const player = game.players.get(socket.data.playerId);
      return player && player.socketId === socket.id && player.connected ? player : null;
    }

    function hostCommand(event, handler) {
      on(event, (payload, ack) => {
        if (!hosts.has(socket.id)) return ack({ ok: false, reason: 'not-host' });
        const result = handler(payload);
        if (!result.ok) return ack(result);
        touchActivity();
        ack({ ok: true, state: game.state(hosts.has(socket.id)) });
        broadcastState();
      });
    }

    function bindPlayer(payload, ack, reconnect) {
      if (socket.data.role === 'host') return ack({ ok: false, reason: 'bad-role' });
      if (socket.data.playerId && socket.data.playerId !== payload.playerId) return ack({ ok: false, reason: 'identity-bound' });
      const result = reconnect
        ? game.reconnectPlayer(payload.playerId, socket.id)
        : game.addPlayer({ playerId: payload.playerId, name: payload.name, socketId: socket.id });
      if (!result.ok) return ack(result);
      socket.data.role = 'player';
      socket.data.playerId = result.player.id;
      touchActivity();
      ack(response(socket));
      broadcastState();
    }

    on('query:status', (_payload, ack) => ack(response(socket)));
    on('player:join', (payload, ack) => bindPlayer(payload, ack, false));
    on('player:reconnect', (payload, ack) => bindPlayer(payload, ack, true));
    on('host:auth', (_payload, ack) => {
      if (socket.data.role === 'player') return ack({ ok: false, reason: 'bad-role' });
      hosts.add(socket.id);
      socket.data.role = 'host';
      socket.join(HOST_ROOM);
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = null;
      setPresence(true);
      touchActivity();
      ack(response(socket));
    });

    hostCommand('host:start', () => {
      try {
        const result = game.start();
        if (result.ok) {
          accumulator = 0;
          previousTime = performance.now();
          broadcastBoards();
        }
        return result;
      } catch (error) {
        console.error('[stackingroyale] Unable to start:', error.message);
        return { ok: false, reason: 'engine-unavailable' };
      }
    });
    hostCommand('host:addBot', () => game.addBot());
    hostCommand('host:setBotDifficulty', payload => game.setBotDifficulty(payload.level));
    hostCommand('host:pause', () => game.setPaused(true));
    hostCommand('host:resume', () => game.setPaused(false));
    hostCommand('host:reset', () => {
      reset();
      return { ok: true };
    });
    hostCommand('host:leave', () => {
      removeHost(socket, true);
      return { ok: true };
    });
    hostCommand('host:kick', payload => {
      const result = game.kick(payload.playerId);
      if (result.ok && result.player.socketId) {
        const kicked = ns.sockets.get(result.player.socketId);
        if (kicked) {
          kicked.emit('player:rejected', { reason: 'kicked' });
          kicked.data.playerId = null;
          kicked.data.role = null;
        }
      }
      return result;
    });
    on('player:action', (payload, ack) => {
      game.enqueueAction(playerForSocket(), socket.id, payload, performance.now(), result => {
        if (result.ok) touchActivity();
        ack(result);
      });
    });
    on('player:spectate', (payload, ack) => {
      const player = playerForSocket();
      if (!player) return ack({ ok: false, reason: 'not-player' });
      if (player.alive || ![PHASES.PLAYING, PHASES.FINAL].includes(game.phase)) return ack({ ok: false, reason: 'not-eliminated' });
      const target = validId(payload.playerId) && game.players.get(payload.playerId);
      if (!target || !target.board) return ack({ ok: false, reason: 'unknown-player' });
      player.spectating = target.id;
      socket.emit('state:spectate', { playerId: target.id, view: target.board.view() });
      ack({ ok: true });
    });

    socket.on('disconnect', () => {
      if (closed) return;
      removeHost(socket, false);
      if (game.disconnect(socket.id)) broadcastState();
    });
  }

  ns.on('connection', onConnection);
  const interval = setInterval(() => {
    const now = performance.now();
    accumulator = Math.min(STEP_MS * 5, accumulator + Math.max(0, now - previousTime));
    previousTime = now;
    if (now - lastActivity >= INACTIVITY_MS) {
      reset();
      touchActivity();
    }
    while (accumulator + 0.000001 >= STEP_MS) {
      accumulator -= STEP_MS;
      const phase = game.phase;
      const countdown = Math.ceil(game.countdownMs / 1000);
      const events = game.step();
      for (const event of events) ns.emit('battle:event', event);
      const changed = phase !== game.phase || countdown !== Math.ceil(game.countdownMs / 1000) || events.some(event => event.type === 'elimination');
      if (changed) {
        broadcastState();
        broadcastBoards();
      }
      ticks++;
      if (ticks % 3 === 0 && game.phase !== PHASES.LOBBY) broadcastBoards();
      if (ticks % 6 === 0 && game.phase !== PHASES.LOBBY) {
        broadcastState();
        broadcastSpectators();
      }
    }
  }, STEP_MS);
  interval.unref();

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = null;
    ns.off('connection', onConnection);
    for (const player of game.players.values()) game.cancelInputs(player, 'closed');
    ns.disconnectSockets(false);
    hosts.clear();
    httpServer.off('close', close);
  }

  httpServer.once('close', close);
  return { game, ns, close };
}

module.exports = mountStackingRoyale;