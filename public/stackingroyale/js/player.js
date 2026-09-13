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
  let outro = null;
  let outroTimer = 0;
  const reduceMotion = (function () { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; } })();
  const fixedStep = 1000 / 60;
  const getMode = ui.controls(function () { if (input) input.clear(); });
  function me() { return state && state.players.find(function (player) { return player.id === playerId; }); }
  function playerIn(source) { return source && Array.isArray(source.players) ? source.players.find(function (item) { return item.id === playerId; }) : null; }
  function enabled() { const player = me(); return ready && socket.connected && state.hostPresent && board && boardMatch === state.matchId && state.phase === 'PLAYING' && !state.paused && player && player.alive && !board.over && !document.hidden && !ui.overlayOpen(); }
  function clearPrediction() { pending = []; accumulator = 0; previous = 0; if (input) input.clear(); }
  function notice(text) { el('playerNotice').hidden = !text; el('playerNotice').textContent = text; }
  function cancelOutro() {
    if (outroTimer) clearTimeout(outroTimer);
    outroTimer = 0; outro = null;
    delete document.body.dataset.outro;
    el('results').classList.remove('is-entering', 'is-win', 'is-swapping');
  }
  // The board has to survive the top-out long enough to die on screen, so the
  // swap to the results card is held until the outro finishes.
  function startOutro(kind) {
    if (reduceMotion) return;
    cancelOutro();
    outro = kind;
    document.body.dataset.outro = kind;
    outroTimer = setTimeout(function () {
      outroTimer = 0; outro = null;
      delete document.body.dataset.outro;
      enterResults(kind);
      render();
    }, kind === 'topout' ? 850 : 500);
  }
  function replay(node, className) {
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
  }
  function enterResults(kind) {
    const card = el('results');
    card.classList.toggle('is-win', kind === 'win');
    replay(card, 'is-entering');
    if (kind === 'win') { const player = me(); launchConfetti(player && player.color); }
  }
  // Players eliminated earlier are already on the card, so the match ending is a
  // content change rather than a view change.
  function swapCard() {
    if (reduceMotion) return;
    replay(el('results'), 'is-swapping');
  }
  function launchConfetti(tint) {
    if (reduceMotion) return;
    const colors = [tint || '#E6A93A', '#E6A93A', '#FFFFFF', '#3DDC84', '#57C8FF'];
    for (let i = 0; i < 50; i++) {
      const bit = document.createElement('div');
      bit.className = 'confetti';
      bit.style.left = (Math.random() * 100) + 'vw';
      bit.style.background = colors[(Math.random() * colors.length) | 0];
      bit.style.animationDelay = (Math.random() * 0.6) + 's';
      document.body.appendChild(bit);
      setTimeout(function () { bit.remove(); }, 3200);
    }
  }
  function row(player, rank) {
    const item = document.createElement('div'); item.className = 'roster-row';
    const place = document.createElement('span'); place.className = 'place'; place.textContent = player.placement ? '#' + player.placement : rank ? String(rank) : '';
    const detail = document.createElement('small'); detail.textContent = state.phase === 'LOBBY' ? player.connected ? 'Ready' : 'Offline' : 'Survived ' + ui.clock(player.survivalMs) + ((state.winnerIds || []).includes(player.id) ? '+' : '');
    item.append(place, ui.name(player), detail); return item;
  }
  function applyState(next) {
    if (!next || !Array.isArray(next.players)) return;
    const old = state;
    const before = playerIn(old);
    if (!old || old.matchId !== next.matchId) { board = null; boardMatch = null; snapshotSeq = -1; sequence = 0; clearPrediction(); cancelOutro(); }
    state = next;
    const player = me();
    if (old && old.phase !== next.phase) input.clear();
    if (old && !old.paused && next.paused) input.clear();
    if (old && old.phase !== 'FINAL' && next.phase === 'FINAL') ui.sound((next.winnerIds || []).includes(playerId) ? 'win' : 'lose');
    if (!player && ready) { lostIdentity(); return; }
    // Edge-triggered, and only when there is a previous state — a phone that
    // reconnects into a finished match must not replay the ending.
    if (old && player && old.matchId === next.matchId) {
      const wasOut = !!(before && before.alive === false);
      const ending = old.phase !== 'FINAL' && next.phase === 'FINAL';
      if (!wasOut && player.alive === false && old.phase !== 'LOBBY') startOutro('topout');
      else if (ending && !wasOut && (next.winnerIds || []).includes(playerId)) startOutro('win');
      else if (ending && wasOut) swapCard();
    }
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
    el('playSurface').hidden = lobby || ((ended || eliminated) && !outro);
    el('playSurface').classList.toggle('is-topout', outro === 'topout');
    el('playSurface').classList.toggle('is-winout', outro === 'win');
    el('attribution').hidden = !lobby;
    el('playerFooter').hidden = (!lobby && !ended && !eliminated) || !!outro;
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
    el('results').hidden = (!eliminated && !ended) || !!outro;
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
    } else el('results').classList.remove('is-entering', 'is-win', 'is-swapping');
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
    clearPrediction(); cancelOutro(); board = null; boardMatch = null; snapshotSeq = -1;
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