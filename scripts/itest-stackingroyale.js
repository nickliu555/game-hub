'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const express = require('express');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const { Field } = require('tetris-fumen');
const mountStackingRoyale = require('../server/stackingroyale');
const { STEP_MS } = require('../server/stackingroyale/game');

function request(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(4000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result));
  }).then(result => {
    if (result.state) {
      assert.equal(Object.hasOwn(result.state, 'reactionsMuted'), false);
      assert.ok(result.state.players.every(entry => !Object.hasOwn(entry, 'lastReactionAt')));
      assert.ok(result.state.players.every(entry => !Object.hasOwn(entry, 'targetMode')));
    }
    return result;
  });
}

function eventOnce(socket, event, predicate = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, receive);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    function receive(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, receive);
      resolve(payload);
    }
    socket.on(event, receive);
  });
}

function snapshot(board) {
  return typeof board.snapshot === 'function' ? board.snapshot() : board.snapshot;
}

async function withClockJump(milliseconds, pending) {
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  const now = performance.now.bind(performance);
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now() + milliseconds });
  try {
    return await pending;
  } finally {
    if (descriptor) Object.defineProperty(performance, 'now', descriptor);
    else delete performance.now;
  }
}

async function cpuLifecycle({ game, client, initialHost, outsider }) {
  const { Board } = require('../public/stackingroyale/js/engine');
  let host = initialHost;
  for (const level of ['novice', 'easy', 'medium', 'hard']) {
    assert.equal(game.botDifficulty, 'medium');
    for (const command of ['addBot', 'setBotDifficulty']) {
      assert.equal((await request(outsider, `host:${command}`, { level })).reason, 'not-host');
    }
    for (const payload of [null, [], {}, { level: 'expert' }, { level: 'HARD' }, { level: 1 }, { level: ['easy'] }]) {
      assert.equal((await request(host, 'host:setBotDifficulty', payload)).reason, 'bad-difficulty');
      assert.equal(game.botDifficulty, 'medium');
    }
    const difficultyBroadcast = eventOnce(outsider, 'state:lobby', state => state.botDifficulty === level);
    assert.equal((await request(host, 'host:setBotDifficulty', { level })).state.botDifficulty, level);
    await difficultyBroadcast;
    let humanSocket = await client();
    const humanId = `cpu-test-human-${level}`;
    assert.equal((await request(humanSocket, 'player:join', { playerId: humanId, name: 'CPU 1' })).ok, true);
    assert.equal((await request(humanSocket, 'host:addBot')).reason, 'not-host');
    assert.equal((await request(humanSocket, 'host:setBotDifficulty', { level: 'easy' })).reason, 'not-host');
    const added = eventOnce(humanSocket, 'state:lobby', state => state.players.some(entry => entry.isBot));
    const addition = await request(host, 'host:addBot');
    assert.equal(addition.ok, true);
    const botId = addition.state.players.find(entry => entry.isBot).id;
    const bot = game.players.get(botId);
    assert.equal(bot.name, 'CPU 2');
    assert.equal(bot.socketId, null);
    assert.equal(bot.connected, true);
    assert.equal((await added).players.find(entry => entry.id === botId).isBot, true);
    for (const command of ['player:reconnect', 'player:join']) {
      assert.equal((await request(outsider, command, { playerId: botId, name: 'Hijack' })).reason, 'unknown-player');
      assert.equal(bot.socketId, null);
      assert.equal(bot.name, 'CPU 2');
    }
    if (level === 'easy') {
      for (let count = game.players.size; count < 30; count++) assert.equal((await request(host, 'host:addBot')).ok, true);
      assert.equal(game.players.size, 30);
      assert.equal(new Set([...game.players.values()].map(entry => entry.name.toLowerCase())).size, 30);
      assert.equal(new Set([...game.players.values()].map(entry => entry.color)).size, 30);
      assert.equal((await request(host, 'host:addBot')).reason, 'game-full');
      assert.equal((await request(outsider, 'player:join', { playerId: 'cpu-overflow', name: 'Overflow' })).reason, 'game-full');
      for (const entry of [...game.players.values()].slice(2)) assert.equal((await request(host, 'host:kick', { playerId: entry.id })).ok, true);
    }
    assert.equal((await request(host, 'host:addBot')).ok, true);
    const removable = [...game.players.values()].at(-1).id;
    const removed = eventOnce(humanSocket, 'state:lobby', state => !state.players.some(entry => entry.id === removable));
    assert.equal((await request(host, 'host:kick', { playerId: removable })).ok, true);
    await removed;
    assert.equal((await request(host, 'host:kick', { playerId: removable })).reason, 'unknown-player');
    const started = await request(host, 'host:start');
    assert.equal(started.ok, true);
    assert.equal(started.state.phase, 'COUNTDOWN');
    assert.equal(started.state.botDifficulty, level);
    const matchId = game.matchId;
    for (const command of ['addBot', 'setBotDifficulty', 'kick']) {
      assert.equal((await request(host, `host:${command}`, { level: 'hard', playerId: botId })).reason, 'not-lobby');
    }
    assert.equal((await request(host, 'host:pause')).ok, true);
    const countdown = game.countdownMs;
    const countdownBoard = snapshot(bot.board);
    for (let tick = 0; tick < 60; tick++) game.step();
    assert.equal(game.countdownMs, countdown);
    assert.deepEqual(snapshot(bot.board), countdownBoard);
    game.countdownMs = STEP_MS;
    const active = eventOnce(host, 'state:match', state => state.phase === 'PLAYING');
    assert.equal((await request(host, 'host:resume')).ok, true);
    await active;
    const locked = await eventOnce(host, 'state:match', state => state.players.find(entry => entry.id === botId).view.locks > 0, 12000);
    assert.equal(locked.players.length, 2);
    assert.equal(bot.seq, 0);
    assert.equal(bot.queuedSeq, 0);
    assert.deepEqual(bot.inputs, []);
    assert.equal((await request(outsider, 'player:action', { playerId: botId, matchId, seq: 1, action: 'drop' })).reason, 'not-player');
    const human = game.players.get(humanId);
    assert.equal((await request(humanSocket, 'player:action', { matchId, seq: 1, action: 'drop' })).ok, true);
    assert.equal(human.board.view().locks, 1);
    assert.deepEqual(bot.targetIds, [humanId]);
    assert.deepEqual(human.targetIds, [botId]);
    assert.equal((await request(host, 'host:pause')).ok, true);
    const frozen = game.state(true);
    const frozenPlanner = JSON.stringify(bot.bot);
    for (let tick = 0; tick < 120; tick++) game.step();
    assert.deepEqual(game.state(true), frozen);
    assert.equal(JSON.stringify(bot.bot), frozenPlanner);
    const frozenHuman = snapshot(human.board);
    humanSocket.disconnect();
    await eventOnce(host, 'state:match', state => !state.players.find(entry => entry.id === humanId).connected);
    host.disconnect();
    host = await client();
    const recoveredHost = await request(host, 'host:auth');
    assert.equal(recoveredHost.state.matchId, matchId);
    assert.equal(recoveredHost.state.botDifficulty, level);
    assert.equal(recoveredHost.state.paused, true);
    assert.deepEqual(recoveredHost.state.players.find(entry => entry.id === botId).view, frozen.players.find(entry => entry.id === botId).view);
    const elapsed = game.elapsedMs;
    const continued = eventOnce(host, 'state:match', state => state.elapsedMs >= elapsed + 200);
    assert.equal((await request(host, 'host:resume')).ok, true);
    await continued;
    assert.equal((await request(host, 'host:pause')).ok, true);
    assert.equal(game.phase, 'PLAYING');
    assert.equal(game.players.size, 2);
    assert.equal(human.alive, true);
    assert.equal(human.seq, 1, 'Disconnect must not auto-play the human');
    assert.equal(human.board.view().locks, frozenHuman.locks);
    assert.equal(human.survivalMs, game.elapsedMs);
    assert.deepEqual(bot.targetIds, [humanId]);
    const field = Field.create();
    field.set(9, 8, 'X');
    for (let row = 0; row < 4; row++) for (let column = 0; column < 10; column++) if (column !== 4) field.set(column, row, 'X');
    bot.board = Board.from({ ...new Board(42).snapshot(), field: field.str({ reduced: false, garbage: false, separator: '' }), active: { type: 'I', x: 4, y: 2, rotation: 'right' } });
    bot.bot = { locks: bot.board.view().locks, waitMs: 0, moves: ['drop'] };
    const attacked = eventOnce(host, 'battle:event', event => event.type === 'attack' && event.from === botId);
    assert.equal((await request(host, 'host:resume')).ok, true);
    const attack = await attacked;
    assert.equal((await request(host, 'host:pause')).ok, true);
    assert.equal(attack.to, humanId);
    assert.equal(attack.rows, 4);
    assert.equal(bot.sent, 4);
    assert.equal(human.board.view().incoming, 4);
    assert.equal(human.connected, false);
    humanSocket = await client();
    const recovery = await request(humanSocket, 'player:reconnect', { playerId: humanId });
    assert.equal(recovery.ok, true);
    assert.equal(recovery.state.botDifficulty, level);
    assert.equal(recovery.state.players.filter(entry => entry.isBot).length, 1);
    assert.equal(recovery.seq, 1);
    assert.deepEqual(recovery.board, snapshot(human.board));
    assert.ok(recovery.state.players.every(entry => !entry.view));
    human.board = Board.from({ ...new Board(42).snapshot(), active: null, over: true });
    const final = eventOnce(host, 'state:match', state => state.phase === 'FINAL');
    assert.equal((await request(host, 'host:resume')).ok, true);
    const finalState = await final;
    assert.deepEqual(finalState.winnerIds, [botId]);
    assert.equal(finalState.players.length, 2);
    assert.equal(finalState.players.find(entry => entry.id === botId).isBot, true);
    const resetBroadcast = eventOnce(humanSocket, 'state:reset');
    const reset = await request(host, 'host:reset');
    assert.equal(reset.ok, true);
    assert.deepEqual(reset.state.players, []);
    assert.equal(reset.state.botDifficulty, 'medium');
    assert.notEqual(reset.state.matchId, matchId);
    assert.equal((await resetBroadcast).botDifficulty, 'medium');
    assert.equal((await request(outsider, 'player:reconnect', { playerId: botId })).reason, 'unknown-player');
    assert.equal((await request(humanSocket, 'player:reconnect', { playerId: humanId })).reason, 'unknown-player');
    humanSocket.disconnect();
    console.log(`PASS CPU ${level}: auth, validation, broadcasts, mixed roster, identity protection, timed locks, pause, disconnected human target, attack, reconnect, final/reset`);
  }
  return host;
}

async function run() {
  const app = express();
  const server = http.createServer(app);
  const sharedIo = new Server(server);
  server._triviaIo = sharedIo;
  const mounted = mountStackingRoyale(app, server, { getPublicBaseUrl: () => 'https://example.test' });
  const { game, ns } = mounted;
  const clients = [];
  const players = [];
  let base;

  async function client() {
    const socket = connect(`${base}/stackingroyale`, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(socket);
    await eventOnce(socket, 'connect');
    const serverSocket = ns.sockets.get(socket.id);
    assert.ok(serverSocket);
    assert.equal(serverSocket.listenerCount('host:setReactionsMuted'), 0);
    assert.equal(serverSocket.listenerCount('player:reaction'), 0);
    assert.equal(serverSocket.listenerCount('player:target'), 0);
    return socket;
  }

  function player(index) {
    return game.players.get(`player-${index}`);
  }

  async function rejoinPlayers(count = players.length) {
    for (let index = 0; index < count; index++) {
      const socket = players[index];
      assert.equal(socket.connected, true);
      const playerId = `player-${index}`;
      assert.equal((await request(socket, 'player:reconnect', { playerId })).reason, 'unknown-player');
      const joined = await request(socket, 'player:join', { playerId, name: `Player ${index}` });
      assert.equal(joined.ok, true, joined.reason);
      assert.equal(joined.player.id, playerId);
      assert.equal(player(index).survivalMs, 0);
      for (const field of ['targetMode', 'targetTokens', 'targetTokenAt']) assert.equal(Object.hasOwn(player(index), field), false);
      assert.equal(joined.state.players.find(entry => entry.id === playerId).survivalMs, 0);
    }
    assert.equal(game.players.size, count);
  }

  async function resetGame(host) {
    const previousMatchId = game.matchId;
    const result = await request(host, 'host:reset');
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.state.phase, 'LOBBY');
    assert.deepEqual(result.state.players, []);
    assert.equal(result.state.hostPresent, true);
    assert.equal(result.state.elapsedMs, 0);
    assert.equal(result.state.paused, false);
    assert.notEqual(result.state.matchId, previousMatchId);
    assert.equal(game.players.size, 0);
    assert.equal((await request(host, 'host:start')).reason, 'player-count');
  }

  async function start(host) {
    const result = await request(host, 'host:start');
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.state.phase, 'COUNTDOWN');
    assert.equal(result.state.countdown, 3);
    assert.ok(result.state.players.every(entry => entry.survivalMs === 0));
    assert.ok([...game.players.values()].every(entry => entry.survivalMs === 0));
    return result.state.matchId;
  }

  async function advanceToPlaying(host) {
    assert.equal((await request(host, 'host:pause')).ok, true);
    game.countdownMs = STEP_MS;
    const playing = eventOnce(host, 'state:match', state => state.phase === 'PLAYING');
    assert.equal((await request(host, 'host:resume')).ok, true);
    await playing;
  }

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal(server._triviaIo, sharedIo);
    assert.equal(ns.name, '/stackingroyale');
    assert.equal(Object.hasOwn(game, 'reactionsMuted'), false);
    const config = await (await fetch(`${base}/api/stackingroyale/config`)).json();
    assert.deepEqual(config, { joinUrl: 'https://example.test/stackingroyale/join', minPlayers: 1, maxPlayers: 30 });
    for (const suffix of ['', '?url=', `?url=${'a'.repeat(501)}`, '?url[]=bad']) {
      assert.equal((await fetch(`${base}/api/stackingroyale/qr${suffix}`)).status, 400);
    }
    const qr = await fetch(`${base}/api/stackingroyale/qr?url=${encodeURIComponent(config.joinUrl)}`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await qr.text(), /<svg/);

    let host = await client();
    const outsider = await client();
    assert.equal((await request(outsider, 'query:status')).state.hostPresent, false);
    assert.equal((await request(outsider, 'player:join', { playerId: 'absent', name: 'Absent' })).reason, 'host-absent');
    for (const command of ['start', 'pause', 'resume', 'reset', 'leave', 'kick']) {
      assert.equal((await request(outsider, `host:${command}`, { playerId: 'player-0' })).reason, 'not-host');
    }
    assert.equal((await request(host, 'host:auth')).ok, true);
    assert.equal((await request(host, 'host:auth')).ok, true);
    host = await cpuLifecycle({ game, client, initialHost: host, outsider });
    if (process.env.SR_CPU_ONLY === '1') return;
    assert.equal((await request(host, 'host:start')).reason, 'player-count');
    assert.equal((await request(host, 'player:join', { playerId: 'host-player', name: 'Host' })).reason, 'bad-role');
    for (const payload of [null, [], {}, { playerId: '../bad', name: 'Name' }, { playerId: 'a'.repeat(129), name: 'Name' }]) {
      assert.equal((await request(outsider, 'player:join', payload)).reason, 'bad-player-id');
    }
    assert.equal((await request(outsider, 'player:join', { playerId: 'empty', name: '<>!@' })).reason, 'name-too-short');

    for (let index = 0; index < 30; index++) {
      const socket = await client();
      players.push(socket);
      const name = index === 0 ? '  Zo\u00eb <>___abcdefghijklmnopqrstu  ' : `Player ${index}`;
      const joined = await request(socket, 'player:join', { playerId: `player-${index}`, name });
      assert.equal(joined.ok, true);
      assert.equal(Object.hasOwn(player(index), 'lastReactionAt'), false);
      assert.equal(joined.player.id, `player-${index}`);
      assert.equal(player(index).survivalMs, 0);
      assert.equal(joined.state.players.find(entry => entry.id === `player-${index}`).survivalMs, 0);
      assert.ok(Array.from(joined.player.name).length <= 20);
      assert.ok(!joined.player.name.includes('<'));
      if (index === 0) {
        assert.equal((await request(outsider, 'player:join', { playerId: 'duplicate-name', name: joined.player.name.toUpperCase() })).reason, 'name-taken');
        const soloMatchId = await start(host);
        await advanceToPlaying(host);
        await eventOnce(host, 'state:match', state => state.phase === 'PLAYING' && state.elapsedMs > 100);
        assert.equal(game.phase, 'PLAYING', 'One-player games must not end immediately');
        assert.deepEqual(game.winnerIds, []);
        assert.deepEqual(player(0).targetIds, [], 'Solo players must not target themselves');
        assert.equal((await request(host, 'host:pause')).ok, true);
        const soloBoard = snapshot(player(0).board);
        const restored = await request(socket, 'player:reconnect', { playerId: 'player-0' });
        assert.equal(restored.ok, true);
        assert.deepEqual(restored.board, soloBoard);
        assert.equal(restored.state.paused, true);
        assert.equal((await request(host, 'host:resume')).ok, true);
        player(0).board.enqueueGarbage(40, 0, 0, 'fixture');
        for (let drop = 0; drop < 10 && game.phase === 'PLAYING'; drop++) {
          assert.equal((await request(socket, 'player:action', { matchId: soloMatchId, seq: player(0).seq + 1, action: 'drop' })).ok, true);
        }
        assert.equal(game.phase, 'FINAL', 'A one-player game ends on normal top-out');
        assert.equal(player(0).alive, false);
        assert.deepEqual(game.winnerIds, []);
        const reset = await request(host, 'host:reset');
        assert.equal(reset.ok, true);
        assert.deepEqual(reset.state.players, []);
        assert.equal(reset.state.hostPresent, true);
        assert.equal(game.players.size, 0);
        assert.equal(game.phase, 'LOBBY');
        assert.notEqual(game.matchId, soloMatchId);
        assert.equal(game.elapsedMs, 0);
        assert.equal(game.paused, false);
        assert.equal((await request(socket, 'player:reconnect', { playerId: 'player-0' })).reason, 'unknown-player');
        assert.equal((await request(host, 'host:start')).reason, 'player-count');
        const rejoined = await request(socket, 'player:join', { playerId: 'fresh-solo', name });
        assert.equal(rejoined.ok, true, rejoined.reason);
        assert.equal(rejoined.player.id, 'fresh-solo');
        assert.equal(game.players.get('fresh-solo').survivalMs, 0);
        assert.equal(rejoined.state.players[0].survivalMs, 0);
        assert.equal((await request(host, 'host:kick', { playerId: 'fresh-solo' })).ok, true);
        assert.equal((await request(socket, 'player:join', { playerId: 'player-0', name })).ok, true);
      }
    }
    assert.equal(game.players.size, 30);
    assert.equal(new Set([...game.players.values()].map(entry => entry.color)).size, 30);
    assert.equal((await request(outsider, 'player:join', { playerId: 'player-30', name: 'Overflow' })).reason, 'game-full');
    assert.equal((await request(players[0], 'host:auth')).reason, 'bad-role');
    assert.equal((await request(players[0], 'player:reconnect', { playerId: 'player-1' })).reason, 'identity-bound');
    assert.equal((await request(outsider, 'player:reconnect', { playerId: 'unknown' })).reason, 'unknown-player');
    const lobbyUpdate = eventOnce(players[0], 'state:lobby', state => !state.players.some(entry => entry.id === 'player-29'));
    const rejected = eventOnce(players[29], 'player:rejected');
    assert.equal((await request(host, 'host:kick', { playerId: 'player-29' })).ok, true);
    assert.equal((await rejected).reason, 'kicked');
    await lobbyUpdate;
    assert.equal((await request(players[29], 'player:join', { playerId: 'player-29', name: 'Player 29' })).ok, true);

    const absent = eventOnce(players[0], 'state:hostPresence', state => !state.present);
    assert.equal((await request(host, 'host:leave')).ok, true);
    await absent;
    assert.equal((await request(host, 'host:reset')).reason, 'not-host');
    assert.equal((await request(outsider, 'player:join', { playerId: 'absent', name: 'Absent' })).reason, 'host-absent');
    const replacement = await client();
    assert.equal((await request(replacement, 'player:reconnect', { playerId: 'player-0' })).ok, true);
    players[0].disconnect();
    await request(replacement, 'query:status');
    assert.equal(player(0).connected, true);
    players[0] = replacement;
    assert.equal((await request(host, 'host:auth')).ok, true);
    console.log('PASS isolated routes, shared namespace, 30/31 capacity, names, kicks, no reaction handlers/state, lobby presence, ownership, solo start/top-out');

    try {
      require.resolve('../public/stackingroyale/js/engine.js');
    } catch (error) {
      throw new Error('BLOCKED: concurrent public/stackingroyale/js/engine.js is not available; lobby socket tests passed');
    }

    let matchId = await start(host);
    assert.equal(game.players.size, 30);
    assert.equal((await request(host, 'host:kick', { playerId: 'player-29' })).reason, 'not-lobby');
    assert.equal((await request(outsider, 'player:join', { playerId: 'late', name: 'Late' })).reason, 'round-in-progress');
    assert.equal((await request(players[0], 'player:action', { matchId, seq: 1, action: 'drop' })).reason, 'not-playing');
    const countdownBoard = snapshot(player(0).board);
    assert.equal((await request(host, 'host:pause')).ok, true);
    const frozenCountdown = game.countdownMs;
    const pausedState = await eventOnce(players[0], 'state:match', state => state.paused);
    assert.equal(pausedState.players.length, 30);
    assert.ok(pausedState.players.every(entry => !Object.hasOwn(entry, 'view')));
    for (let index = 0; index < 240; index++) game.step();
    assert.equal(game.countdownMs, frozenCountdown);
    assert.deepEqual(snapshot(player(0).board), countdownBoard);
    assert.ok(pausedState.players.every(entry => entry.survivalMs === 0));
    assert.ok([...game.players.values()].every(entry => entry.survivalMs === 0));
    const countdownStates = new Set();
    const recordCountdown = state => {
      if (state.phase === 'COUNTDOWN') {
        countdownStates.add(state.countdown);
        assert.ok(state.players.every(entry => entry.survivalMs === 0));
      }
    };
    host.on('state:match', recordCountdown);
    const playing = eventOnce(host, 'state:match', state => state.phase === 'PLAYING');
    assert.equal((await request(host, 'host:resume')).ok, true);
    await playing;
    host.off('state:match', recordCountdown);
    assert.ok(countdownStates.has(2) && countdownStates.has(1));
    const hostState = (await request(host, 'query:status')).state;
    assert.equal(hostState.players.length, 30);
    assert.ok(hostState.players.every(entry => entry.view && entry.view.grid.length === 20));
    assert.ok(hostState.players.every(entry => entry.survivalMs === hostState.elapsedMs));
    assert.ok(hostState.players.every(entry => entry.targetIds.length === 1 && !entry.targetIds.includes(entry.id)));
    let targetViews = 0;
    const boardViews = new Map();
    for (const entry of game.players.values()) {
      boardViews.set(entry.id, entry.board.view);
      entry.board.view = function () {
        targetViews++;
        return boardViews.get(entry.id).call(this);
      };
    }
    game.refreshTargets();
    assert.equal(targetViews, 0, 'Random targeting must not scan board heights');
    for (const entry of game.players.values()) {
      entry.board.view = boardViews.get(entry.id);
    }
    assert.ok((await request(players[0], 'query:status')).board);
    assert.equal((await request(players[0], 'player:spectate', { playerId: 'player-1' })).reason, 'not-eliminated');
    assert.equal((await request(host, 'host:start')).reason, 'not-lobby');
    assert.equal((await request(host, 'host:kick', { playerId: 'player-29' })).reason, 'not-lobby');
    assert.equal((await request(outsider, 'player:join', { playerId: 'late', name: 'Late' })).reason, 'round-in-progress');

    for (const action of ['left', 'right', 'soft', 'rotateCW', 'rotateCCW', 'hold', 'drop']) {
      const seq = player(0).seq + 1;
      const result = await request(players[0], 'player:action', { matchId, seq, action });
      assert.deepEqual(result, { ok: true, seq });
      assert.equal(player(0).seq, seq);
    }
    const duplicateSeq = player(0).seq;
    for (const seq of [duplicateSeq, 0, -1, 1.5, '8', Number.MAX_SAFE_INTEGER, 2147483648, duplicateSeq + 1025]) {
      assert.equal((await request(players[0], 'player:action', { matchId, seq, action: 'left' })).reason, 'bad-seq');
    }
    assert.equal((await request(players[0], 'player:action', { matchId: 'old', seq: 99, action: 'left' })).reason, 'stale-match');
    for (const action of ['hack', null, {}, ['left']]) {
      assert.equal((await request(players[0], 'player:action', { matchId, seq: 99, action })).reason, 'bad-action');
    }
    assert.equal((await request(outsider, 'player:action', { matchId, seq: 1, action: 'drop' })).reason, 'not-player');

    const observed = [];
    const enqueueAction = game.enqueueAction;
    game.enqueueAction = function (...args) {
      const before = args[0] && args[0].seq;
      const result = enqueueAction.apply(this, args);
      if (args[0]) observed.push({ before, after: args[0].seq, queued: args[0].queuedSeq, length: args[0].inputs.length });
      return result;
    };
    player(1).tokens = 30;
    player(1).tokenAt = null;
    const burst = await Promise.all(Array.from({ length: 70 }, (_value, index) => request(players[1], 'player:action', { matchId, seq: index + 1, action: 'left' })));
    game.enqueueAction = enqueueAction;
    assert.ok(burst.some(result => result.reason === 'rate-limited'));
    assert.ok(burst.filter(result => result.ok).length <= 35);
    assert.ok(observed.every(entry => entry.before === entry.after && entry.length <= 30));
    assert.ok(observed.some(entry => entry.queued > entry.after));

    const originalRandom = game.random;
    const pieceRng = player(0).board.snapshot().rng;
    try {
      for (const value of [0, ...Array.from({ length: 29 }, (_entry, index) => (index + 0.5) / 29), 0.999999]) {
        game.random = () => value;
        assert.deepEqual(game.chooseTargets(player(0), true), [`player-${Math.floor(value * 29) + 1}`]);
      }
      const displayedTargets = [...game.players.values()].map(entry => [...entry.targetIds]);
      game.random = () => { throw new Error('Refreshing valid targets must not reroll'); };
      for (let refresh = 0; refresh < 10; refresh++) game.refreshTargets();
      assert.deepEqual([...game.players.values()].map(entry => entry.targetIds), displayedTargets);
      assert.equal(player(0).board.snapshot().rng, pieceRng);
    } finally {
      game.random = originalRandom;
    }
    console.log('PASS random targets: every nonself candidate, deterministic range, stable refresh, no height scans, independent piece RNG');
    assert.equal((await request(host, 'host:pause')).ok, true);
    const frozen = snapshot(player(0).board);
    const elapsed = game.elapsedMs;
    assert.ok(elapsed > 0);
    const frozenSurvival = [...game.players.values()].map(entry => entry.survivalMs);
    assert.ok(frozenSurvival.every(survivalMs => survivalMs === elapsed));
    assert.equal((await request(players[0], 'player:action', { matchId, seq: 99, action: 'drop' })).reason, 'paused');
    for (let index = 0; index < 60; index++) game.step();
    assert.deepEqual(snapshot(player(0).board), frozen);
    assert.equal(game.elapsedMs, elapsed);
    assert.deepEqual([...game.players.values()].map(entry => entry.survivalMs), frozenSurvival);

    const newTab = await client();
    const recovered = await request(newTab, 'player:reconnect', { playerId: 'player-0' });
    assert.deepEqual(recovered.board, frozen);
    assert.equal(recovered.seq, player(0).seq);
    assert.ok(recovered.state.players.every(entry => !entry.view));
    assert.deepEqual(recovered.state.players.map(entry => entry.survivalMs), frozenSurvival);
    assert.equal((await request(players[0], 'player:action', { matchId, seq: 99, action: 'left' })).reason, 'not-player');
    players[0].disconnect();
    players[0] = newTab;
    await request(newTab, 'query:status');
    assert.equal(player(0).connected, true);
    const beforeHostReconnect = game.matchId;
    host.disconnect();
    host = await client();
    const recoveredHost = await request(host, 'host:auth');
    assert.equal(recoveredHost.state.matchId, beforeHostReconnect);
    assert.equal(recoveredHost.state.paused, true);
    assert.ok(recoveredHost.state.players.every(entry => entry.view));
    assert.deepEqual(recoveredHost.state.players.map(entry => entry.survivalMs), frozenSurvival);
    assert.equal((await request(host, 'host:auth')).ok, true);
    assert.equal((await request(host, 'host:resume')).ok, true);

    const dropped = eventOnce(host, 'state:match', state => !state.players.find(entry => entry.id === 'player-2').connected);
    const afkBoard = player(2).board;
    const afkBefore = afkBoard.view();
    players[2].disconnect();
    await dropped;
    const progressed = await eventOnce(host, 'state:match', state => state.elapsedMs > elapsed + 300);
    assert.equal(progressed.players.length, 30);
    assert.equal(player(2).alive, true);
    assert.equal(player(2).board, afkBoard);
    assert.ok(afkBoard.view().elapsedMs > afkBefore.elapsedMs);
    assert.ok(progressed.players.every(entry => entry.alive && entry.survivalMs === progressed.elapsedMs));
    assert.equal(progressed.players.find(entry => entry.id === 'player-2').connected, false);
    assert.ok(player(2).survivalMs > elapsed);
    const afkReconnect = await client();
    const afkRecovery = await request(afkReconnect, 'player:reconnect', { playerId: 'player-2' });
    players[2] = afkReconnect;
    assert.equal(afkRecovery.ok, true);
    assert.equal(player(2).board, afkBoard);
    assert.equal(afkRecovery.state.players.find(entry => entry.id === 'player-2').survivalMs, afkRecovery.state.elapsedMs);
    assert.ok(afkRecovery.state.elapsedMs >= progressed.elapsedMs);

    const matchBeforeLeave = game.matchId;
    const elapsedBeforeLeave = game.elapsedMs;
    assert.equal((await request(host, 'host:leave')).ok, true);
    await eventOnce(players[0], 'state:match', state => !state.hostPresent && state.elapsedMs > elapsedBeforeLeave + 150);
    assert.equal(game.matchId, matchBeforeLeave);
    assert.equal(game.phase, 'PLAYING');
    assert.equal((await request(host, 'host:pause')).reason, 'not-host');
    assert.equal((await request(host, 'host:auth')).ok, true);

    const graceExpired = eventOnce(players[0], 'state:hostPresence', state => !state.present, 18000);
    host.disconnect();
    const graceState = await request(players[0], 'query:status');
    assert.equal(graceState.state.hostPresent, true);
    const graceElapsed = game.elapsedMs;
    await graceExpired;
    assert.ok(game.elapsedMs > graceElapsed + 10000);
    assert.equal(game.players.size, 30);
    host = await client();
    assert.equal((await request(host, 'host:auth')).state.hostPresent, true);

    const resetState = eventOnce(players[0], 'state:reset');
    const oldMatch = matchId;
    await resetGame(host);
    const resetSnapshot = await resetState;
    assert.equal(resetSnapshot.phase, 'LOBBY');
    assert.deepEqual(resetSnapshot.players, []);
    assert.equal(resetSnapshot.hostPresent, true);
    assert.notEqual(game.matchId, oldMatch);
    await rejoinPlayers();
    assert.ok([...game.players.values()].every(entry => !entry.board && entry.seq === 0 && entry.alive));
    assert.equal((await request(players[0], 'player:action', { matchId: oldMatch, seq: 100, action: 'drop' })).reason, 'stale-match');
    console.log('PASS countdown, pause, 30-board broadcasts, input validation/rate limits, targeting, reconnect, AFK gravity, host grace/reset');

    const { Board } = require('../public/stackingroyale/js/engine');
    function fixture(filled = [], changes = {}) {
      const field = Field.create();
      for (const [column, row] of filled) field.set(column, row, 'X');
      return Board.from({
        ...new Board(42).snapshot(),
        field: field.str({ reduced: false, garbage: false, separator: '' }),
        ...changes,
      });
    }

    function clearFixture(incoming = 0) {
      const filled = [[9, 8]];
      for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 10; column++) if (column !== 4) filled.push([column, row]);
      }
      const board = fixture(filled, { active: { type: 'I', x: 4, y: 2, rotation: 'right' } });
      if (incoming) board.enqueueGarbage(incoming, 2, 1500, 'player-1');
      return board;
    }

    matchId = await start(host);
    await advanceToPlaying(host);
    await request(host, 'host:pause');
    for (const entry of game.players.values()) {
      entry.board = new Board(42);
      entry.targetIds = [entry.id === 'player-0' ? 'player-1' : 'player-29'];
    }
    player(0).board = clearFixture();
    game.random = () => 1.5 / 29;
    const afkCombat = eventOnce(host, 'state:match', state => !state.players.find(entry => entry.id === 'player-2').connected);
    players[2].disconnect();
    await afkCombat;
    const attacks = [];
    const captureAttack = event => { if (event.type === 'attack') attacks.push(event); };
    host.on('battle:event', captureAttack);
    await request(host, 'host:resume');
    const randomAttack = await request(players[0], 'player:action', { matchId, seq: 1, action: 'drop' });
    assert.equal(randomAttack.ok, true);
    await request(host, 'host:pause');
    assert.equal(player(0).sent, 4);
    assert.equal(player(0).lines, 4);
    assert.deepEqual([1, 2, 3].map(index => player(index).board.view().incoming), [0, 4, 0]);
    assert.deepEqual(player(0).targetIds, ['player-2'], 'Actual attacks reroll the previously displayed target');
    assert.equal(player(2).connected, false);
    assert.equal(player(2).alive, true);
    assert.deepEqual(attacks.map(event => [event.from, event.to, event.rows]), [
      ['player-0', 'player-2', 4],
    ]);
    const packet = player(2).board.snapshot().garbage[0];
    assert.equal(packet.sender, 'player-0');
    assert.ok(packet.delayMs > 1400 && packet.delayMs <= 1500);
    assert.ok(Number.isInteger(packet.hole) && packet.hole >= 0 && packet.hole < 10);

    player(0).board = clearFixture(3);
    game.random = () => 0;
    await request(host, 'host:resume');
    assert.equal((await request(players[0], 'player:action', { matchId, seq: 2, action: 'drop' })).ok, true);
    await request(host, 'host:pause');
    assert.equal(player(0).sent, 5);
    assert.equal(player(0).board.view().incoming, 0);
    assert.deepEqual([1, 2, 3].map(index => player(index).board.view().incoming), [1, 4, 0]);
    assert.deepEqual(player(0).targetIds, ['player-1']);
    player(0).board = clearFixture(8);
    await request(host, 'host:resume');
    assert.equal((await request(players[0], 'player:action', { matchId, seq: 3, action: 'drop' })).ok, true);
    await request(host, 'host:pause');
    assert.equal(player(0).sent, 5);
    assert.equal(player(0).board.view().incoming, 4);
    assert.equal(attacks.reduce((total, event) => total + event.rows, 0), 5);

    player(0).board = clearFixture();
    player(0).targetIds = ['player-4'];
    player(4).board = fixture([[0, 17]], { active: null, over: true });
    game.random = () => 3.5 / 28;
    assert.deepEqual(game.chooseTargets(player(0)), ['player-5'], 'A topped-out board is excluded before elimination resolves');
    await request(host, 'host:resume');
    assert.equal((await request(players[0], 'player:action', { matchId, seq: 4, action: 'drop' })).ok, true);
    await request(host, 'host:pause');
    assert.equal(player(4).alive, false);
    assert.equal(player(4).placement, 30);
    const eliminatedSurvival = player(4).survivalMs;
    assert.ok(eliminatedSurvival > 0 && eliminatedSurvival <= game.elapsedMs);
    assert.equal(player(4).board.view().incoming, 0);
    assert.equal(player(5).board.view().incoming, 4);
    assert.ok([...game.players.values()].every(entry => !entry.targetIds.includes('player-4')));
    assert.deepEqual(player(4).targetIds, []);
    for (const value of [0, ...Array.from({ length: 28 }, (_entry, index) => (index + 0.5) / 28), 0.999999]) {
      game.random = () => value;
      const candidates = [...game.players.values()].filter(entry => entry.id !== 'player-0' && entry.id !== 'player-4');
      assert.deepEqual(game.chooseTargets(player(0), true), [candidates[Math.floor(value * candidates.length)].id]);
    }
    game.random = originalRandom;
    assert.equal((await request(players[4], 'player:action', { matchId, seq: 1, action: 'drop' })).reason, 'paused');
    await request(host, 'host:resume');
    assert.equal((await request(players[4], 'player:action', { matchId, seq: 1, action: 'drop' })).reason, 'eliminated');
    host.off('battle:event', captureAttack);

    await request(host, 'host:pause');
    const originalStep = game.step;
    game.step = () => [];
    await request(host, 'host:resume');
    const pendingSeq = player(0).seq + 1;
    let applied = false;
    const pending = request(players[0], 'player:action', { matchId, seq: pendingSeq, action: 'right' }).then(result => { applied = true; return result; });
    const unprocessed = await request(players[0], 'query:status');
    assert.equal(applied, false);
    assert.equal(unprocessed.seq, pendingSeq - 1);
    assert.equal(player(0).queuedSeq, pendingSeq);
    assert.equal((await request(players[0], 'player:action', { matchId, seq: pendingSeq, action: 'right' })).reason, 'bad-seq');
    const queuedTab = await client();
    const queuedRecovery = await request(queuedTab, 'player:reconnect', { playerId: 'player-0' });
    assert.equal((await pending).reason, 'superseded');
    assert.equal(queuedRecovery.seq, pendingSeq - 1);
    assert.equal(player(0).inputs.length, 0);
    assert.equal(player(0).queuedSeq, player(0).seq);
    players[0].disconnect();
    players[0] = queuedTab;
    const beforeRetry = snapshot(player(0).board);
    const retry = request(players[0], 'player:action', { matchId, seq: pendingSeq, action: 'right' });
    await request(players[0], 'query:status');
    assert.equal(player(0).inputs.length, 1);
    assert.deepEqual(snapshot(player(0).board), beforeRetry);
    const beforeRetryElapsed = game.elapsedMs;
    originalStep.call(game);
    assert.ok(game.elapsedMs > beforeRetryElapsed);
    assert.ok([...game.players.values()].filter(entry => entry.alive).every(entry => entry.survivalMs === game.elapsedMs));
    assert.equal(player(4).survivalMs, eliminatedSurvival);
    const eliminatedRecovery = await request(players[4], 'player:reconnect', { playerId: 'player-4' });
    assert.equal(eliminatedRecovery.state.players.find(entry => entry.id === 'player-4').survivalMs, eliminatedSurvival);
    assert.deepEqual(await retry, { ok: true, seq: pendingSeq });
    const resetPending = request(players[0], 'player:action', { matchId, seq: pendingSeq + 1, action: 'left' });
    await request(players[0], 'query:status');
    assert.equal(player(0).inputs.length, 1);
    const removedPlayer = player(0);
    await resetGame(host);
    assert.equal((await resetPending).reason, 'reset');
    assert.equal(removedPlayer.inputs.length, 0);
    assert.equal(removedPlayer.queuedSeq, removedPlayer.seq);
    game.step = originalStep;
    console.log('PASS random attack rerolls, net garbage, AFK recipient, dead targets, queued duplicates, replacement/reset races');

    players[2] = await client();
    await rejoinPlayers();
    matchId = await start(host);
    await advanceToPlaying(host);
    await request(host, 'host:pause');
    player(29).board = fixture([[9, 17]]);
    player(29).board.enqueueGarbage(198, 2, 1500, 'player-1');
    player(0).board = clearFixture();
    game.random = () => 0.999999;
    const delivered = [];
    const captureDelivery = event => { if (event.type === 'attack') delivered.push(event); };
    host.on('battle:event', captureDelivery);
    await request(host, 'host:resume');
    assert.equal((await request(players[0], 'player:action', { matchId, seq: 1, action: 'drop' })).ok, true);
    await request(host, 'host:pause');
    assert.equal(player(29).board.view().incoming, 200);
    assert.equal(player(0).sent, 2);
    assert.deepEqual(delivered.map(event => [event.to, event.rows]), [['player-29', 2]]);
    player(0).board = clearFixture();
    await request(host, 'host:resume');
    assert.equal((await request(players[0], 'player:action', { matchId, seq: 2, action: 'drop' })).ok, true);
    await request(host, 'host:pause');
    assert.equal(player(29).board.view().incoming, 200);
    assert.equal(player(0).sent, 2);
    assert.equal(delivered.length, 1);

    player(29).board = fixture([[9, 17]]);
    delivered.length = 0;
    for (let index = 0; index < 29; index++) {
      player(index).board = Board.from({ ...clearFixture().snapshot(), combo: 100, b2b: true });
    }
    const sentBefore = [...game.players.values()].map(entry => entry.sent);
    await request(host, 'host:resume');
    const saturation = await Promise.all(players.slice(0, 29).map((socket, index) => request(socket, 'player:action', {
      matchId, seq: player(index).seq + 1, action: 'drop',
    })));
    assert.ok(saturation.every(result => result.ok));
    await request(host, 'host:pause');
    assert.equal(player(29).board.view().incoming, 200);
    assert.equal(delivered.reduce((total, event) => total + event.rows, 0), 200);
    assert.ok(delivered.every(event => event.to === 'player-29' && event.rows > 0));
    for (let index = 0; index < 30; index++) {
      assert.equal(player(index).sent - sentBefore[index], delivered.filter(event => event.from === player(index).id).reduce((total, event) => total + event.rows, 0));
    }
    const deliveryState = (await request(host, 'query:status')).state;
    assert.equal(deliveryState.players.reduce((total, entry) => total + entry.sent, 0), 202);
    assert.equal(deliveryState.players[29].view.incoming, 200);
    host.off('battle:event', captureDelivery);
    game.random = originalRandom;
    await resetGame(host);
    await rejoinPlayers();
    console.log('PASS garbage saturation: 198 + 4 delivers/credits 2; full queue delivers/credits 0; 29 concurrent attackers deliver/credit exactly 200, matching events and snapshots');

    for (let index = 2; index < 30; index++) assert.equal((await request(host, 'host:kick', { playerId: `player-${index}` })).ok, true);
    assert.equal(game.players.size, 2);
    matchId = await start(host);
    await advanceToPlaying(host);
    const boardCounts = { host: 0, player: 0, board: 0 };
    const hostPacket = state => { boardCounts.host++; assert.ok(state.players.every(entry => entry.view)); };
    const playerPacket = state => { boardCounts.player++; assert.ok(state.players.every(entry => !entry.view)); };
    const boardPacket = payload => { boardCounts.board++; assert.equal(payload.matchId, matchId); assert.ok(payload.board); };
    host.on('state:match', hostPacket);
    players[0].on('state:match', playerPacket);
    players[0].on('state:board', boardPacket);
    const rateStart = game.elapsedMs;
    await eventOnce(host, 'state:match', state => state.elapsedMs >= rateStart + 1000);
    host.off('state:match', hostPacket);
    players[0].off('state:match', playerPacket);
    players[0].off('state:board', boardPacket);
    assert.ok(boardCounts.host >= 8 && boardCounts.host <= 13, JSON.stringify(boardCounts));
    assert.ok(boardCounts.player >= 8 && boardCounts.player <= 13, JSON.stringify(boardCounts));
    assert.ok(boardCounts.board >= 17 && boardCounts.board <= 25, JSON.stringify(boardCounts));

    const beforeOverload = game.elapsedMs;
    const afterOverload = await withClockJump(5000, eventOnce(host, 'state:match', state => state.elapsedMs > beforeOverload));
    assert.ok(afterOverload.elapsedMs - beforeOverload <= STEP_MS * 12, 'overload must discard massive catch-up');
    assert.ok(afterOverload.elapsedMs - beforeOverload >= STEP_MS * 4);

    const boardBeforeForgery = snapshot(player(0).board);
    for (const event of ['host:board', 'host:eliminated', 'host:matchEnd', 'player:board', 'player:score', 'player:attack']) {
      players[0].emit(event, { board: {}, winnerIds: ['player-0'], attack: 99999, lines: 99999, id: 'player-1' });
    }
    await request(players[0], 'query:status');
    assert.equal(player(0).lines, 0);
    assert.equal(player(0).sent, 0);
    assert.equal(player(1).alive, true);
    assert.equal(snapshot(player(0).board).field, boardBeforeForgery.field);

    const loser = player(0);
    loser.board.enqueueGarbage(40, 0, 0, 'player-1');
    const elimination = eventOnce(host, 'battle:event', event => event.type === 'elimination' && event.playerId === loser.id);
    let actions = 0;
    while (game.phase === 'PLAYING' && actions < 30) {
      await request(players[0], 'player:action', { matchId, seq: loser.seq + 1, action: 'drop' });
      actions++;
    }
    await elimination;
    assert.equal(loser.alive, false);
    assert.equal(loser.placement, 2);
    assert.equal(player(1).placement, 1);
    assert.deepEqual(game.winnerIds, ['player-1']);
    assert.equal(game.players.size, 2);
    const finalDuration = game.elapsedMs;
    assert.ok(finalDuration > 0);
    assert.equal(loser.survivalMs, finalDuration, 'The input that causes topout must count its tick');
    assert.equal(player(1).survivalMs, finalDuration, 'The winner survives the full match');
    for (let index = 0; index < 60; index++) game.step();
    assert.equal(game.elapsedMs, finalDuration);
    assert.equal(loser.survivalMs, finalDuration);
    assert.equal(player(1).survivalMs, finalDuration);
    const finalRecovery = await request(players[0], 'player:reconnect', { playerId: 'player-0' });
    assert.equal(finalRecovery.state.phase, 'FINAL');
    assert.ok(finalRecovery.state.players.every(entry => entry.survivalMs === finalDuration));
    assert.deepEqual(finalRecovery.board, snapshot(loser.board));
    const finalHostRecovery = await request(host, 'host:auth');
    assert.ok(finalHostRecovery.state.players.every(entry => entry.survivalMs === finalDuration));
    const spectate = eventOnce(players[0], 'state:spectate', state => state.playerId === 'player-1');
    assert.equal((await request(players[0], 'player:spectate', { playerId: 'player-1' })).ok, true);
    assert.ok((await spectate).view);
    assert.equal((await request(players[0], 'player:spectate', { playerId: 'unknown' })).reason, 'unknown-player');
    assert.equal((await request(host, 'host:kick', { playerId: 'player-0' })).reason, 'not-lobby');

    await resetGame(host);
    await rejoinPlayers(2);
    matchId = await start(host);
    await advanceToPlaying(host);
    const disconnectedState = eventOnce(host, 'state:match', state => state.players.every(entry => !entry.connected));
    players[0].disconnect();
    players[1].disconnect();
    await disconnectedState;
    const naturalEvents = [];
    for (let index = 0; index < 100000 && game.phase === 'PLAYING'; index++) naturalEvents.push(...game.step());
    assert.equal(game.phase, 'FINAL', 'AFK gravity must eventually cause a natural topout');
    assert.equal(game.players.size, 2);
    assert.equal(naturalEvents.filter(event => event.type === 'elimination').length, 2);
    assert.deepEqual(game.winnerIds, []);
    assert.equal(player(0).placement, 1);
    assert.equal(player(1).placement, 1);
    assert.equal(player(0).board.over, true);
    assert.equal(player(1).board.over, true);
    assert.ok(game.elapsedMs > 0);
    const tieDuration = game.elapsedMs;
    assert.equal(player(0).survivalMs, tieDuration);
    assert.equal(player(1).survivalMs, tieDuration);
    for (let index = 0; index < 60; index++) game.step();
    assert.equal(game.elapsedMs, tieDuration);
    assert.equal(player(0).survivalMs, tieDuration);
    assert.equal(player(1).survivalMs, tieDuration);
    const tieState = (await request(host, 'query:status')).state;
    assert.ok(tieState.players.every(entry => entry.survivalMs === tieDuration));
    console.log('PASS 2-player match, broadcast rates, authority, natural garbage topout, final recovery/spectate, simultaneous AFK draw');

    const inactivityMatch = game.matchId;
    const inactivity = await withClockJump(60 * 60 * 1000 + 1000, eventOnce(host, 'state:reset'));
    assert.equal(inactivity.phase, 'LOBBY');
    assert.notEqual(inactivity.matchId, inactivityMatch);
    assert.deepEqual(inactivity.players, []);
    assert.equal(game.players.size, 0);
    assert.equal(inactivity.elapsedMs, 0);
    assert.equal(inactivity.paused, false);
    assert.equal(inactivity.hostPresent, true);
    assert.equal((await request(host, 'host:start')).reason, 'player-count');
    assert.equal((await request(outsider, 'player:reconnect', { playerId: 'player-0' })).reason, 'unknown-player');
    const afterInactivity = await request(outsider, 'player:join', { playerId: 'after-inactivity', name: 'After Inactivity' });
    assert.equal(afterInactivity.ok, true, afterInactivity.reason);
    assert.equal(game.players.get('after-inactivity').survivalMs, 0);
    assert.equal(afterInactivity.state.players[0].survivalMs, 0);
    console.log('PASS capped overload catch-up and 60-minute inactivity reset');
    console.log('PASS survival time: fresh/countdown zero, pause freeze, alive/AFK progress, elimination freeze, winner/tie duration, reconnect, reset');

    const timeAtClose = game.elapsedMs;
    server.emit('close');
    mounted.close();
    assert.equal(ns.sockets.size, 0);
    assert.equal(game.elapsedMs, timeAtClose);
    console.log('Stacking Royale integration tests passed');
  } finally {
    for (const socket of clients) socket.disconnect();
    mounted.close();
    await new Promise(resolve => sharedIo.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});