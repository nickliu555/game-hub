(function () {
  'use strict';
  const ui = SRUI;
  const el = ui.el;
  const socket = io('/stackingroyale');
  let state = null;
  let busy = false;
  let capacity = 30;
  let playerId = ui.storage.get('playerId');
  el('nameInput').value = ui.storage.get('playerName') || '';
  function render() {
    const connected = socket.connected && state;
    const present = connected && state.hostPresent;
    const locked = connected && state.phase !== 'LOBBY';
    const full = connected && state.players.length >= capacity;
    const blocked = !present || locked;
    el('hostAbsentOverlay').hidden = !!present;
    el('roundLockedOverlay').hidden = !present || !locked;
    document.querySelector('.join-hero').inert = blocked;
    document.querySelector('.join-brand').inert = blocked;
    document.querySelector('.player-attribution').inert = blocked;
    el('nameInput').disabled = blocked;
    el('joinGate').hidden = !!present && !locked && !full;
    el('gateTitle').textContent = !connected ? 'Reconnecting' : locked ? 'Match in progress' : !present ? 'Waiting for a host' : 'Lobby full';
    el('gateDetail').textContent = !connected ? 'Checking your connection...' : locked ? 'The next lobby will open when the host resets.' : !present ? 'This lobby opens automatically when the host returns.' : 'All places are taken. You can play solo while you wait.';
    el('joinBtn').disabled = busy || !present || locked || full;
    el('reconnectBtn').hidden = !playerId;
    el('reconnectBtn').disabled = !present || busy;
  }
  function apply(next) { if (!next || !Array.isArray(next.players)) return; state = next; render(); }
  function reconnect() {
    if (!playerId || !socket.connected || busy) return;
    busy = true; render();
    socket.timeout(6000).emit('player:reconnect', { playerId: playerId }, function (error, response) {
      busy = false;
      if (!error && response && response.ok) { location.replace('/stackingroyale/play'); return; }
      if (!error && response && ['unknown-player', 'player-not-found', 'not-found', 'bad-player-id', 'not-joined'].includes(response.reason)) { ui.storage.remove('playerId'); playerId = null; }
      if (response && response.state) apply(response.state);
      render();
    });
  }
  socket.on('connect', function () { socket.emit('query:status', {}, function (response) { apply(response && (response.state || response)); reconnect(); }); });
  socket.on('disconnect', function () { busy = false; state = null; render(); });
  socket.on('connect_error', function () { state = null; render(); });
  socket.on('state:lobby', apply);
  socket.on('state:match', apply);
  socket.on('state:reset', function (next) { ui.storage.remove('playerId'); playerId = null; apply(next); });
  socket.on('state:hostPresence', function (event) { if (state) { state.hostPresent = event.present; render(); } });
  ui.activate(el('reconnectBtn'), reconnect);
  ui.activate(el('joinBtn'), function () {
    const form = el('joinForm');
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else if (form.reportValidity()) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  el('joinForm').addEventListener('submit', function (event) {
    event.preventDefault();
    if (el('joinBtn').disabled) return;
    const name = el('nameInput').value.trim();
    if (!name) { el('joinError').textContent = 'Please enter a name.'; return; }
    if (!playerId) playerId = ui.identity();
    if (!ui.storage.set('playerId', playerId)) { el('joinError').textContent = 'Please allow browser storage to join this game.'; return; }
    busy = true; render(); el('joinError').textContent = '';
    socket.timeout(6000).emit('player:join', { playerId: playerId, name: name }, function (error, response) {
      busy = false;
      if (error) el('joinError').textContent = 'The server did not respond. Try joining again.';
      else if (!response || !response.ok) el('joinError').textContent = ui.friendly(response && response.reason);
      else { ui.storage.set('playerName', response.player.name); location.replace('/stackingroyale/play'); return; }
      if (response && response.state) apply(response.state);
      render();
    });
  });
  fetch('/api/stackingroyale/config').then(function (response) { return response.json(); }).then(function (config) { capacity = config.maxPlayers || 30; render(); }).catch(function () {});
  render();
}());