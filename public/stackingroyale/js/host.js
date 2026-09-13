(function () {
  'use strict';
  const ui = SRUI;
  const el = ui.el;
  const socket = io('/stackingroyale');
  let state = null;
  let authorized = false;
  let minimum = 1;
  let maximum = 30;
  let selected = [];
  let rosterSignature = '';
  let boardSignature = '';
  const boardElements = new Map();
  ui.icons();
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', function () { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wakeLock === null) acquireWakeLock();
  });
  acquireWakeLock();
  document.addEventListener('click', function once() {
    document.removeEventListener('click', once);
    if (wakeLock === null) acquireWakeLock();
  });
  function notice(text) { el('hostNotice').hidden = !text; el('hostNotice').textContent = text; }
  function command(event, data, complete) {
    if (!authorized || !socket.connected) { notice('The host is reconnecting. Please wait.'); return; }
    socket.timeout(6000).emit(event, data || {}, function (error, response) {
      if (error || !response || !response.ok) { notice(error ? 'The server did not respond. Please try again.' : ui.friendly(response && response.reason)); return; }
      notice(''); if (response.state) applyState(response.state); if (complete) complete();
    });
  }
  function confirmReset() {
    window.showConfirm('Reset the entire game and remove all players? Everyone will need to join again.', 'Reset game', { danger: true }).then(function (confirmed) { if (confirmed) command('host:reset'); });
  }
  ui.activate(el('resetBtn'), confirmReset);
  ui.activate(el('againBtn'), function () { command('host:reset'); });
  ui.activate(el('backBtn'), function () {
    window.showConfirm('Leave the host screen? Any match in progress will continue.', 'Leave game', { danger: true }).then(function (confirmed) { if (confirmed) command('host:leave', {}, function () {
      if (window.Iris && typeof window.Iris.transitionTo === 'function') window.Iris.transitionTo('/', null, { emoji: '🧱', name: 'Stacking Royale', color: '#1b2838' });
      else location.href = '/';
    }); });
  });
  ui.activate(el('fullscreenBtn'), function () {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
    else if (document.exitFullscreen) document.exitFullscreen().catch(function () {});
  });
  ui.activate(el('startBtn'), function () { ui.unlockAudio(); command('host:start'); });
  ui.activate(el('addBotBtn'), function () { ui.unlockAudio(); command('host:addBot'); });
  el('diffSeg').querySelectorAll('button').forEach(function (button) {
    ui.activate(button, function () { command('host:setBotDifficulty', { level: button.dataset.diff }); });
  });
  ui.activate(el('pauseBtn'), function () { if (state) command(state.paused ? 'host:resume' : 'host:pause'); });
  function lobbyRoster() {
    el('lobbyRoster').replaceChildren();
    if (!state.players.length) { const empty = document.createElement('p'); empty.className = 'player-empty'; empty.textContent = 'Waiting for players to join...'; el('lobbyRoster').append(empty); }
    state.players.forEach(function (player) {
      const row = document.createElement('div'); row.className = 'player-chip' + (player.connected ? '' : ' disconnected') + (player.isBot ? ' is-bot' : '');
      const kick = document.createElement('button'); kick.type = 'button'; kick.className = 'kick'; kick.title = 'Remove ' + player.name; kick.setAttribute('aria-label', kick.title); kick.innerHTML = ui.icon('x');
      ui.activate(kick, function () {
        if (state.phase !== 'LOBBY') return;
        window.showConfirm('Remove this player from the lobby?', 'Remove player', { danger: true }).then(function (confirmed) { if (confirmed && state.phase === 'LOBBY') command('host:kick', { playerId: player.id }); });
      });
      const name = ui.name(player); name.style.color = '#1a1a1a';
      if (player.isBot) { const badge = document.createElement('span'); badge.className = 'cpu-badge'; badge.title = 'CPU player'; badge.setAttribute('aria-label', 'CPU player'); badge.innerHTML = ui.icon('bot'); row.append(badge); }
      row.append(name, kick); el('lobbyRoster').append(row);
    });
    ui.icons();
  }
  function featuredStandings() {
    return state.players.slice().sort(function (first, second) {
      return Number(second.alive) - Number(first.alive) || (second.lines || 0) - (first.lines || 0);
    });
  }
  function fillSelection() {
    selected = featuredStandings().slice(0, 4).map(function (player) { return player.id; });
  }
  function battleRoster() {
    const scrollTop = el('battleRoster').scrollTop;
    el('battleRoster').replaceChildren();
    featuredStandings().forEach(function (player) {
      const row = document.createElement('div'); row.className = 'watch-row' + (player.alive ? '' : ' out') + (selected.includes(player.id) ? ' featured' : '');
      const details = document.createElement('span'); details.className = 'watch-details'; details.textContent = player.placement ? '#' + player.placement : (player.lines || 0) + ' lines';
      row.append(ui.name(player), details);
      el('battleRoster').append(row);
    });
    el('battleRoster').scrollTop = scrollTop;
  }
  function featured() {
    const signature = selected.join('|');
    if (signature !== boardSignature) {
      boardSignature = signature; boardElements.clear(); el('featuredBoards').replaceChildren();
      selected.forEach(function (id) {
        const article = document.createElement('article'); article.className = 'featured-board';
        const title = document.createElement('div'); title.className = 'featured-name';
        const wrap = document.createElement('div'); wrap.className = 'featured-canvas-wrap';
        const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 600; wrap.append(canvas);
        const stats = document.createElement('div'); stats.className = 'featured-stats';
        article.append(title, wrap, stats); el('featuredBoards').append(article); boardElements.set(id, { article: article, title: title, canvas: canvas, stats: stats });
      });
      el('featuredBoards').style.setProperty('--boards', String(Math.max(1, selected.length)));
    }
    selected.forEach(function (id) {
      const player = state.players.find(function (item) { return item.id === id; }); const elements = boardElements.get(id);
      if (!player || !elements) return;
      elements.title.replaceChildren(ui.name(player)); elements.canvas.setAttribute('aria-label', player.name + "'s board");
      elements.article.classList.toggle('out', player.alive === false);
      const lines = document.createElement('span'); lines.textContent = (player.lines || 0) + ' lines';
      elements.stats.replaceChildren(lines); SRRender.draw(elements.canvas, player.view);
    });
  }
  function finalRoster() {
    ui.winner(el('winnerTitle'), state);
    el('finalSummary').textContent = state.players.length + ' players · ' + ui.clock(state.elapsedMs);
    el('finalRoster').replaceChildren();
    ui.standings(state.players).forEach(function (player, index) {
      const row = document.createElement('div'); row.className = 'final-row';
      const person = document.createElement('div'); const place = document.createElement('span'); place.className = 'place'; place.textContent = '#' + (player.placement || index + 1); person.append(place, ui.name(player));
      const lines = document.createElement('span'); lines.textContent = player.lines || 0;
      const survived = document.createElement('span'); survived.textContent = ui.clock(player.survivalMs) + ((state.winnerIds || []).includes(player.id) ? '+' : '');
      row.append(person, lines, survived); el('finalRoster').append(row);
    });
  }
  function render() {
    if (!state) return;
    const lobby = state.phase === 'LOBBY'; const final = state.phase === 'FINAL';
    el('view-lobby').hidden = !lobby; el('view-match').hidden = lobby || final; el('view-final').hidden = !final;
    el('startBtn').disabled = !authorized || !socket.connected || state.players.length < minimum;
    el('addBotBtn').disabled = !authorized || !socket.connected || !lobby || state.players.length >= maximum;
    el('diffSeg').querySelectorAll('button').forEach(function (button) {
      button.disabled = !authorized || !socket.connected || !lobby;
      button.setAttribute('aria-pressed', String(button.dataset.diff === state.botDifficulty));
    });
    el('playerCount').textContent = state.players.length; el('playerCap').textContent = maximum;
    fillSelection();
    const signature = JSON.stringify(state.players.map(function (player) { return [player.id, player.name, player.color, player.connected, player.alive, player.placement, player.lines, player.sent]; })) + state.phase + selected.join('|');
    if (signature !== rosterSignature) { rosterSignature = signature; if (lobby) lobbyRoster(); else if (final) finalRoster(); else battleRoster(); }
    el('lobbyRoster').querySelectorAll('.kick').forEach(function (button) { button.disabled = !authorized || !socket.connected || !lobby; });
    if (!lobby && !final) {
      const alive = state.players.filter(function (player) { return player.alive; }).length;
      el('aliveCount').textContent = alive + ' / ' + state.players.length + ' standing'; el('rosterTotal').textContent = state.players.length;
      el('matchClock').textContent = ui.clock(state.elapsedMs);
      el('pauseBtn').disabled = !authorized || !socket.connected || !['COUNTDOWN', 'PLAYING'].includes(state.phase);
      el('pauseBtn').title = state.paused ? 'Resume match' : 'Pause match'; el('pauseBtn').setAttribute('aria-label', el('pauseBtn').title);
      const pauseIcon = state.paused ? 'play' : 'pause';
      if (el('pauseBtn').dataset.icon !== pauseIcon) { el('pauseBtn').dataset.icon = pauseIcon; el('pauseBtn').innerHTML = ui.icon(pauseIcon); ui.icons(); }
      el('matchOverlay').hidden = !state.paused && state.phase !== 'COUNTDOWN';
      el('matchOverlayLabel').textContent = state.paused ? 'Match on hold' : 'Get ready';
      el('matchOverlayTitle').textContent = state.paused ? 'Paused' : String(state.countdown || 'Go');
      featured();
    }
  }
  function applyState(next) {
    if (!next || !Array.isArray(next.players)) return;
    const old = state;
    if (old && next.phase === 'LOBBY' && next.players.length > old.players.length) ui.sound('join');
    if (!old || next.matchId !== old.matchId) { selected = []; boardSignature = ''; rosterSignature = ''; el('battleFeed').replaceChildren(); }
    if (old && next.phase !== old.phase) {
      if (next.phase === 'COUNTDOWN' || next.phase === 'PLAYING') ui.sound('start');
      else if (next.phase === 'FINAL') ui.sound((next.winnerIds || []).length ? 'win' : 'lose');
    } else if (old && next.phase === 'COUNTDOWN' && next.countdown !== old.countdown) ui.sound('tick');
    state = next; render();
  }
  socket.on('connect', function () {
    socket.timeout(6000).emit('host:auth', {}, function (error, response) {
      if (error || !response || !response.ok) { authorized = false; el('network').hidden = false; el('network').textContent = 'Host connection failed. Refresh to retry.'; return; }
      authorized = true; el('network').hidden = true; applyState(response.state);
    });
  });
  socket.on('disconnect', function () { authorized = false; el('network').hidden = false; el('network').textContent = 'Reconnecting... The match continues on the server.'; render(); });
  socket.on('connect_error', function () { authorized = false; el('network').hidden = false; el('network').textContent = 'Connection failed. Retrying...'; render(); });
  socket.on('state:lobby', applyState);
  socket.on('state:match', applyState);
  socket.on('state:reset', applyState);
  socket.on('state:hostPresence', function (event) { if (state) state.hostPresent = event.present; });
  socket.on('battle:event', function (event) {
    if (!state) return;
    const line = document.createElement('p');
    if (event.type === 'elimination') {
      const player = state.players.find(function (item) { return item.id === event.playerId; });
      line.append(ui.name(player), ' topped out'); ui.sound('lose');
    } else if (event.type === 'attack') {
      const from = state.players.find(function (item) { return item.id === event.from; });
      const to = state.players.find(function (item) { return item.id === event.to; });
      line.append(ui.name(from), ' sent ' + (event.rows || 0) + ' to ', ui.name(to)); ui.sound('attack');
    } else return;
    el('battleFeed').prepend(line); while (el('battleFeed').children.length > 8) el('battleFeed').lastChild.remove();
  });
  fetch('/api/stackingroyale/config').then(function (response) { if (!response.ok) throw new Error('config'); return response.json(); }).then(function (config) {
    minimum = config.minPlayers || 1; maximum = config.maxPlayers || 30;
    const url = new URL(config.joinUrl, location.origin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url');
    el('joinUrl').textContent = url.href; el('joinUrl').href = url.href;
    el('qrImage').onload = function () { el('qrImage').hidden = false; el('qrStatus').hidden = true; };
    el('qrImage').onerror = function () { el('qrStatus').textContent = 'Use the join address below'; };
    el('qrImage').src = '/api/stackingroyale/qr?url=' + encodeURIComponent(url.href); render();
  }).catch(function () { el('qrStatus').textContent = 'Could not load join address. Refresh to retry.'; });
}());