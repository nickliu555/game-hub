/* ===== Liar's Dice · Join (mobile) ===== */
(function () {
  'use strict';

  var form = document.getElementById('joinForm');
  var nameInput = document.getElementById('nameInput');
  var errorMsg = document.getElementById('errorMsg');
  var submitBtn = form.querySelector('button[type="submit"]');

  // Decorative dice above the title.
  var PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var joinDice = document.getElementById('joinDice');
  [6, 3, 1, 5, 2].forEach(function (f) {
    var d = document.createElement('span');
    d.className = 'die';
    d.dataset.face = f;
    for (var i = 0; i < 9; i++) {
      var p = document.createElement('span');
      p.className = 'pip' + (PIPS[f].indexOf(i) >= 0 ? ' on' : '');
      d.appendChild(p);
    }
    joinDice.appendChild(d);
  });

  // Already seated on this device → go straight to the controller.
  if (localStorage.getItem('liarsdice.playerId')) {
    window.location.replace('/liarsdice/play');
    return;
  }

  // No pinch / double-tap zoom, long-press callout or stray selection — but the name box stays usable.
  (function lockZoom() {
    var isField = function (e) { return e.target && e.target.closest && e.target.closest('input'); };
    var stop = function (e) { if (!isField(e)) e.preventDefault(); };
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('gesturechange', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('gestureend', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('touchmove', function (e) {
      if (!e.cancelable || isField(e)) return;
      e.preventDefault();
    }, { passive: false });
    var lastTouchEnd = 0;
    document.addEventListener('touchend', function (e) {
      var now = Date.now();
      if (now - lastTouchEnd <= 350 && !isField(e)) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    document.addEventListener('dblclick', stop, { passive: false });
    document.addEventListener('contextmenu', stop, { passive: false });
    document.addEventListener('selectstart', stop, { passive: false });
    document.addEventListener('dragstart', stop, { passive: false });
  }());

  // Pre-fill the name after a host reset.
  var rejoinName = localStorage.getItem('liarsdice.rejoinName');
  if (rejoinName) { nameInput.value = rejoinName; localStorage.removeItem('liarsdice.rejoinName'); }

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

  var socket = io('/liarsdice', { transports: ['polling', 'websocket'] });
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
  // already running, or all eight seats taken.
  var hostPresent = true, roundLocked = false, tableFull = false;

  function refreshOverlays() {
    ensureOverlay('hostAbsentOverlay', '🎲', 'No game in progress',
      "The host isn't here right now. This page will unlock automatically when they return.")
      .hidden = hostPresent;
    ensureOverlay('roundLockedOverlay', '🎲', 'Game in progress',
      "You can't join a game that's already underway. This page will unlock when the host starts a new game.")
      .hidden = !(hostPresent && roundLocked);
    ensureOverlay('tableFullOverlay', '🪑', 'The table is full',
      "Liar's Dice seats up to eight players. This page will unlock if someone leaves.")
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
  ['state:table', 'state:final'].forEach(function (ev) {
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
          'game-full': "The table is full — Liar's Dice seats up to eight players.",
          'game-in-progress': "The game has already started — you can't join mid-game.",
          'name-too-short': 'Please enter a valid name.',
          'name-taken': (res && res.name ? '"' + res.name + '"' : 'That name') + ' is already taken.',
          'host-absent': "The host isn't here right now. Wait for them to return and try again.",
          'bad-player-id': 'Something went wrong. Please reload the page.',
        }[reason] || 'Could not join. Please try again.';
        if (reason === 'game-full') { tableFull = true; refreshOverlays(); }
        if (reason === 'game-in-progress') { roundLocked = true; refreshOverlays(); }
        return showError(friendly);
      }
      localStorage.setItem('liarsdice.playerId', pid);
      localStorage.setItem('liarsdice.playerName', res.player.name);
      window.location.replace('/liarsdice/play');
    });
  });
})();
