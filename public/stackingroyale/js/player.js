(function () {
  'use strict';
  const ui = SRUI;
  const el = ui.el;
  const playerId = ui.storage.get('playerId');
  if (!playerId) { location.replace('/stackingroyale/join'); return; }
  el('playSurface').innerHTML = ui.controllerMarkup();
  SRControls.lockZoom();
  ui.icons();
  const socket = io('/stackingroyale');
  let state = null;
  let board = null;
  let boardMatch = null;
  let ready = false;
  let pending = [];
  let sequence = 0;
  let snapshotSeq = -1;
  let previous = 0;
  let accumulator = 0;
  let input = null;
  let resyncing = false;
  let spectateSignature = '';
  let listSignature = '';
  const fixedStep = 1000 / 60;
  const getMode = ui.controls(function () { if (input) input.clear(); });
  function me() { return state && state.players.find(function (player) { return player.id === playerId; }); }
  function enabled() { const player = me(); return ready && socket.connected && state.hostPresent && board && boardMatch === state.matchId && state.phase === 'PLAYING' && !state.paused && player && player.alive && !board.over && !document.hidden && !ui.overlayOpen(); }
  function clearPrediction() { pending = []; accumulator = 0; previous = 0; if (input) input.clear(); }
  function notice(text) { el('playerNotice').hidden = !text; el('playerNotice').textContent = text; }
  function row(player, rank) {
    const item = document.createElement('div'); item.className = 'roster-row';
    const place = document.createElement('span'); place.className = 'place'; place.textContent = player.placement ? '#' + player.placement : rank ? String(rank) : '';
    const detail = document.createElement('small'); detail.textContent = state.phase === 'LOBBY' ? player.connected ? 'Ready' : 'Offline' : 'Survived ' + ui.clock(player.survivalMs) + ((state.winnerIds || []).includes(player.id) ? '+' : '');
    item.append(place, ui.name(player), detail); return item;
  }
  function applyState(next) {
    if (!next || !Array.isArray(next.players)) return;
    const old = state;
    if (!old || old.matchId !== next.matchId) { board = null; boardMatch = null; snapshotSeq = -1; sequence = 0; clearPrediction(); }
    state = next;
    const player = me();
    if (old && old.phase !== next.phase) input.clear();
    if (old && !old.paused && next.paused) input.clear();
    if (old && old.phase !== 'FINAL' && next.phase === 'FINAL') ui.sound((next.winnerIds || []).includes(playerId) ? 'win' : 'lose');
    if (!player && ready) { lostIdentity(); return; }
    render();
  }
  function render() {
    if (!state) return;
    const player = me();
    if (!player) return;
    const hostAvailable = ready && socket.connected && state.hostPresent;
    el('hostAbsentOverlay').hidden = !!hostAvailable;
    document.querySelector('.player-shell').inert = !hostAvailable;
    if (!hostAvailable && input) input.clear();
    document.body.dataset.phase = state.phase;
    el('playerName').replaceChildren(ui.name(player));
    const lobby = state.phase === 'LOBBY';
    const ended = state.phase === 'FINAL';
    const eliminated = !lobby && player.alive === false;
    el('waiting').hidden = !lobby;
    el('playSurface').hidden = lobby || ended || eliminated;
    el('attribution').hidden = !lobby;
    el('playerFooter').hidden = !lobby && !ended && !eliminated;
    el('controller').hidden = lobby || ended || eliminated;
    el('controlSettings').hidden = lobby || ended || eliminated;
    if (el('controlSettings').hidden || !hostAvailable) {
      el('controlPopup').hidden = true;
      el('controlSettingsBtn').setAttribute('aria-expanded', 'false');
    }
    el('playerPlace').hidden = lobby;
    el('playerPlace').textContent = lobby ? '' : player.placement ? '#' + player.placement : state.players.filter(function (item) { return item.alive; }).length + ' left';
    el('lobbyCount').textContent = state.players.length;
    el('lobbyCountLabel').textContent = (state.players.length === 1 ? 'player' : 'players') + ' in the lobby';
    el('waitTitle').textContent = state.hostPresent ? "You're in!" : 'Host is away';
    el('waitStatus').textContent = state.hostPresent ? 'Waiting for the host to start...' : 'The lobby will resume when the host returns. Solo practice is available below.';
    const nextListSignature = state.phase + JSON.stringify(state.players.map(function (item) { return [item.id, item.name, item.color, item.connected, item.alive, item.placement, item.lines]; }));
    const listChanged = listSignature !== nextListSignature;
    listSignature = nextListSignature;
    el('results').hidden = !eliminated && !ended;
    if (eliminated || ended) {
      el('resultEyebrow').textContent = ended ? 'Final standings' : 'Eliminated' + (player.placement ? ' · #' + player.placement : '');
      if (ended) ui.winner(el('resultTitle'), state); else el('resultTitle').textContent = 'Your stack topped out.';
      if (listChanged) {
        const scrollTop = el('standings').scrollTop;
        el('standings').replaceChildren.apply(el('standings'), ui.standings(state.players).map(function (item, index) { return row(item, index + 1); }));
        el('standings').scrollTop = scrollTop;
      }
      el('spectateTools').hidden = ended;
      if (ended) el('spectateCanvas').hidden = true;
      const choices = state.players.filter(function (item) { return item.id !== playerId && item.alive; });
      const nextSpectateSignature = JSON.stringify(choices.map(function (item) { return [item.id, item.name]; }));
      if (nextSpectateSignature !== spectateSignature) {
        spectateSignature = nextSpectateSignature;
        const selected = el('spectateSelect').value;
        const options = [new Option('Choose a player', '')].concat(choices.map(function (item) { return new Option(item.name, item.id); }));
        el('spectateSelect').replaceChildren.apply(el('spectateSelect'), options);
        el('spectateSelect').value = selected;
      }
      if (!el('spectateSelect').value) el('spectateCanvas').hidden = true;
    }
    const blocked = !ready || !socket.connected || !board || state.paused || state.phase === 'COUNTDOWN' || ui.overlayOpen();
    el('boardOverlay').hidden = lobby || ended || eliminated || !blocked;
    el('overlayTitle').textContent = !ready || !socket.connected ? 'Reconnecting' : !board ? 'Syncing board' : state.paused ? 'Paused' : state.phase === 'COUNTDOWN' ? String(state.countdown || 'Ready') : 'Controls paused';
    el('overlayDetail').textContent = !ready ? 'Your match continues on the server' : state.paused ? 'Waiting for the host' : state.phase === 'COUNTDOWN' ? 'Get ready' : ui.overlayOpen() ? 'Close settings or help to play' : '';
    el('resumeBtn').hidden = true;
    el('controller').querySelectorAll('[data-action]').forEach(function (button) { button.disabled = !enabled(); });
  }
  function restore(payload) {
    if (!state || !payload || payload.matchId !== state.matchId || !Number.isSafeInteger(payload.seq) || payload.seq < snapshotSeq) return;
    try {
      const restored = StackingRoyale.Board.from(payload.board);
      pending = pending.filter(function (item) { return item.seq > payload.seq; });
      pending.forEach(function (item) { restored.action(item.action); });
      board = restored; boardMatch = payload.matchId; snapshotSeq = payload.seq; sequence = Math.max(sequence, payload.seq); accumulator = 0; previous = 0;
      ui.paint(board.view()); render();
    } catch (_) { ready = false; clearPrediction(); notice('Your board could not sync. Reconnecting...'); reconnect(); }
  }
  function lostIdentity() { ready = false; clearPrediction(); ui.storage.remove('playerId'); location.replace('/stackingroyale/join'); }
  function reconnect() {
    if (!socket.connected || resyncing) return;
    resyncing = true; ready = false; clearPrediction();
    socket.timeout(6000).emit('player:reconnect', { playerId: playerId }, function (error, response) {
      resyncing = false;
      if (error || !response) { notice('Could not reconnect. Retrying...'); setTimeout(reconnect, 1500); return; }
      if (!response.ok) {
        if (['unknown-player', 'player-not-found', 'not-found', 'bad-player-id', 'not-joined'].includes(response.reason)) { lostIdentity(); return; }
        notice(ui.friendly(response.reason)); setTimeout(reconnect, 1500); return;
      }
      sequence = Number.isSafeInteger(response.seq) ? response.seq : 0; snapshotSeq = -1;
      ready = true; notice(''); el('network').hidden = true;
      applyState(response.state);
      if (response.board) restore({ matchId: response.state.matchId, seq: sequence, board: response.board });
      if (el('spectateSelect').value) socket.emit('player:spectate', { playerId: el('spectateSelect').value });
      render();
    });
  }
  input = SRControls.bind({ root: el('controller'), canvas: el('boardCanvas'), enabled: enabled, mode: getMode, action: function (action) {
    if (pending.length >= 128) { ready = false; clearPrediction(); reconnect(); return; }
    ui.unlockAudio();
    const before = board.view();
    board.action(action);
    const after = board.view();
    if (after.lines > before.lines) ui.sound('clear'); else if (after.locks > before.locks) ui.sound('drop');
    const item = { matchId: state.matchId, seq: ++sequence, action: action }; pending.push(item);
    socket.emit('player:action', item, function (response) { if (response && !response.ok && socket.connected) { notice(ui.friendly(response.reason)); reconnect(); } });
    ui.paint(after);
  } });
  el('spectateSelect').addEventListener('change', function () { el('spectateCanvas').hidden = true; if (el('spectateSelect').value) socket.emit('player:spectate', { playerId: el('spectateSelect').value }); });
  socket.on('state:spectate', function (payload) { if (payload.playerId !== el('spectateSelect').value || !payload.view || state.phase === 'FINAL') return; el('spectateCanvas').hidden = false; SRRender.draw(el('spectateCanvas'), payload.view); });
  socket.on('connect', reconnect);
  socket.on('disconnect', function () { ready = false; resyncing = false; clearPrediction(); el('network').textContent = 'Reconnecting... Your match continues.'; el('network').hidden = false; render(); });
  socket.on('connect_error', function () { ready = false; clearPrediction(); el('network').textContent = 'Connection lost. Retrying...'; el('network').hidden = false; render(); });
  socket.on('state:lobby', applyState);
  socket.on('state:match', applyState);
  socket.on('state:board', restore);
  socket.on('state:reset', function (next) {
    clearPrediction(); board = null; boardMatch = null; snapshotSeq = -1;
    if (!next || !next.players || !next.players.some(function (player) { return player.id === playerId; })) { lostIdentity(); return; }
    applyState(next);
  });
  socket.on('state:hostPresence', function (event) { if (state) { state.hostPresent = event.present; render(); } });
  socket.on('battle:event', function (event) { if (event.type === 'elimination' && event.playerId === playerId) ui.sound('lose'); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { input.clear(); previous = 0; accumulator = 0; } else if (socket.connected) reconnect(); });
  function frame(now) {
    if (enabled()) {
      if (!previous) previous = now;
      accumulator += Math.min(100, now - previous); previous = now;
      let steps = 0;
      while (accumulator >= fixedStep && steps < 6 && !board.over) { board.step(fixedStep); accumulator -= fixedStep; steps++; }
      ui.paint(board.view());
    } else { previous = 0; accumulator = 0; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}());