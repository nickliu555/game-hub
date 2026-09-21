/* ===== Hearts · Join (mobile) ===== */
(function () {
  'use strict';

  var form = document.getElementById('joinForm');
  var nameInput = document.getElementById('nameInput');
  var errorMsg = document.getElementById('errorMsg');
  var submitBtn = form.querySelector('button[type="submit"]');

  // Already seated on this device → go straight to the controller.
  if (localStorage.getItem('hearts.playerId')) {
    window.location.replace('/hearts/play');
    return;
  }

  // Pre-fill the name after a host reset.
  var rejoinName = localStorage.getItem('hearts.rejoinName');
  if (rejoinName) { nameInput.value = rejoinName; localStorage.removeItem('hearts.rejoinName'); }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  function showError(msg) {
    errorMsg.textContent = msg;
    submitBtn.disabled = false;
  }

  var socket = io('/hearts', { transports: ['polling', 'websocket'] });
  var socketReady = false;

  function ensureOverlay(id, icon, title, sub) {
    var ov = document.getElementById(id);
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = id;
    ov.className = 'host-absent-overlay';
    ov.hidden = true;
    ov.innerHTML =
      '<div class="host-absent-card">' +
        '<div class="icon">' + icon + '</div>' +
        '<div class="title">' + title + '</div>' +
        '<div class="sub"><span class="pulse-dot"></span>' + sub + '</div>' +
      '</div>';
    document.body.appendChild(ov);
    return ov;
  }

  // Three reasons the door can be shut, in priority order: no host, a game
  // already running, or all four seats taken.
  var hostPresent = true, roundLocked = false, tableFull = false;

  function refreshOverlays() {
    ensureOverlay('hostAbsentOverlay', '♥️', 'No game in progress',
      "The host isn't here right now. This page will unlock automatically when they return.")
      .hidden = hostPresent;
    ensureOverlay('roundLockedOverlay', '🃏', 'Game in progress',
      "You can't join a hand that's already underway. This page will unlock when the host starts a new game.")
      .hidden = !(hostPresent && roundLocked);
    ensureOverlay('tableFullOverlay', '🪑', 'The table is full',
      'Hearts seats exactly four players. This page will unlock if someone leaves.')
      .hidden = !(hostPresent && !roundLocked && tableFull);
  }
  function setStatus(s) {
    if (!s) return;
    if (typeof s.hostPresent === 'boolean') hostPresent = s.hostPresent;
    if (typeof s.phase === 'string') roundLocked = s.phase !== 'LOBBY';
    if (typeof s.full === 'boolean') tableFull = s.full;
    refreshOverlays();
  }

  socket.on('connect', function () {
    socketReady = true;
    errorMsg.textContent = '';
    socket.emit('query:status', {}, setStatus);
  });

  socket.on('state:lobby', function (l) {
    roundLocked = !!(l && l.phase && l.phase !== 'LOBBY');
    tableFull = !!(l && l.total >= l.capacity);
    refreshOverlays();
  });
  socket.on('state:reset', function () { roundLocked = false; tableFull = false; refreshOverlays(); });
  ['state:deal', 'state:pass', 'state:exchange', 'state:table', 'state:trickEnd', 'state:handEnd', 'state:final']
    .forEach(function (ev) {
      socket.on(ev, function () { roundLocked = true; refreshOverlays(); });
    });
  socket.on('state:hostPresence', function (p) {
    hostPresent = !(p && p.present === false);
    refreshOverlays();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorMsg.textContent = '';
    var name = nameInput.value.trim();
    if (!name) return showError('Please enter a name.');
    if (!socketReady) return showError('Not connected yet — please wait a moment and try again.');
    submitBtn.disabled = true;
    var pid = uuid();
    var acked = false;
    var timeout = setTimeout(function () {
      if (!acked) showError('Server did not respond. Check your WiFi and try again.');
    }, 5000);
    socket.emit('player:join', { playerId: pid, name: name }, function (res) {
      acked = true;
      clearTimeout(timeout);
      if (!res || !res.ok) {
        var reason = res && res.reason;
        var friendly = {
          'game-full': 'The table is full — Hearts seats exactly four players.',
          'game-in-progress': "The game has already started — you can't join mid-hand.",
          'name-too-short': 'Please enter a valid name.',
          'name-taken': (res && res.name ? '"' + res.name + '"' : 'That name') + ' is already taken.',
          'host-absent': "The host isn't here right now. Wait for them to return and try again.",
          'bad-player-id': 'Something went wrong. Please reload the page.',
        }[reason] || 'Could not join. Please try again.';
        if (reason === 'game-full') { tableFull = true; refreshOverlays(); }
        if (reason === 'game-in-progress') { roundLocked = true; refreshOverlays(); }
        return showError(friendly);
      }
      localStorage.setItem('hearts.playerId', pid);
      localStorage.setItem('hearts.playerName', res.player.name);
      window.location.replace('/hearts/play');
    });
  });
})();
