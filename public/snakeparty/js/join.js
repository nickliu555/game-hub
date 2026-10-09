(function () {
  'use strict';

  // ---------------- No zoom / no selection (the name field excepted) ----------------
  (function lockZoom() {
    const stop = function (e) { e.preventDefault(); };
    const inField = function (e) { return !!(e.target && e.target.closest && e.target.closest('input, textarea')); };
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    document.addEventListener('gestureend', stop, { passive: false });
    document.addEventListener('touchmove', function (e) {
      if (!e.cancelable) return;
      if (e.target && e.target.closest && e.target.closest('.scrollable-region')) return;
      e.preventDefault();
    }, { passive: false });
    let lastTouchEnd = 0;
    document.addEventListener('touchend', function (e) {
      const now = Date.now();
      if (now - lastTouchEnd <= 350 && !inField(e)) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    document.addEventListener('dblclick', stop, { passive: false });
    document.addEventListener('contextmenu', function (e) { if (!inField(e)) e.preventDefault(); }, { passive: false });
    document.addEventListener('selectstart', function (e) { if (!inField(e)) e.preventDefault(); }, { passive: false });
    document.addEventListener('dragstart', stop, { passive: false });
  })();


  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  const form = document.getElementById('joinForm');
  const nameInput = document.getElementById('nameInput');
  const errorMsg = document.getElementById('errorMsg');
  const submitBtn = form.querySelector('button[type="submit"]');

  function ensureOverlay(id, title, sub) {
    let ov = document.getElementById(id);
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = id;
    ov.className = 'host-absent-overlay';
    ov.hidden = true;
    ov.innerHTML =
      '<div class="host-absent-card">' +
        '<div class="icon">🐍</div>' +
        '<div class="title">' + title + '</div>' +
        '<div class="sub"><span class="pulse-dot"></span>' + sub + '</div>' +
      '</div>';
    document.body.appendChild(ov);
    return ov;
  }

  let hostPresent = false;
  let roundLocked = false;
  let gameFull = false;
  function refreshLockState() {
    const hostOv = ensureOverlay('hostAbsentOverlay', 'No game in progress',
      'The host isn\'t here right now. This page will unlock automatically when they return.');
    const roundOv = ensureOverlay('roundLockedOverlay', 'Game in progress',
      'You can\'t hop in mid-game. This page will unlock as soon as the host starts a new game.');
    const fullOv = ensureOverlay('gameFullOverlay', 'Game is full',
      'All four spots are taken right now. This page will unlock if a spot opens up.');
    hostOv.hidden = hostPresent;
    roundOv.hidden = !(hostPresent && roundLocked);
    fullOv.hidden = !(hostPresent && !roundLocked && gameFull);
    submitBtn.disabled = !hostPresent || roundLocked || gameFull;
  }
  function setHostPresent(p) { hostPresent = !!p; refreshLockState(); }
  function setRoundLocked(l) { roundLocked = !!l; refreshLockState(); }
  function setGameFull(f) { gameFull = !!f; refreshLockState(); }
  setHostPresent(false);
  setRoundLocked(true);

  const existing = localStorage.getItem('snakeparty.playerId');
  if (existing) { window.location.replace('/snakeparty/play'); return; }

  const rejoinName = localStorage.getItem('snakeparty.rejoinName');
  if (rejoinName) { nameInput.value = rejoinName; localStorage.removeItem('snakeparty.rejoinName'); }

  const socket = io('/snakeparty', { transports: ['polling', 'websocket'] });

  let socketReady = false;
  socket.on('connect', function () {
    socketReady = true;
    errorMsg.textContent = '';
    socket.emit('query:status', {}, function (status) {
      setHostPresent(!!(status && status.hostPresent));
      setRoundLocked(!!(status && status.phase && status.phase !== 'LOBBY'));
    });
  });
  socket.on('state:hostPresence', function (p) { setHostPresent(!(p && p.present === false)); });
  socket.on('state:lobby', function (l) {
    setRoundLocked(!!(l && l.phase && l.phase !== 'LOBBY'));
    setGameFull(!!(l && typeof l.total === 'number' && typeof l.capacity === 'number' && l.total >= l.capacity));
  });
  socket.on('m:start', function () { setRoundLocked(true); });
  socket.on('m:end', function () { setRoundLocked(true); });
  socket.on('state:reset', function () { setRoundLocked(false); setGameFull(false); });
  socket.on('connect_error', function (err) {
    errorMsg.textContent = 'Connection error: ' + (err && err.message ? err.message : err);
  });
  socket.on('disconnect', function () { socketReady = false; });

  function showError(msg) { errorMsg.textContent = msg; submitBtn.disabled = false; }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorMsg.textContent = '';
    const name = nameInput.value.trim();
    if (!name) return showError('Please enter a name.');
    if (!socketReady) return showError('Not connected to server yet — please wait a moment and try again.');
    submitBtn.disabled = true;
    const pid = uuid();
    let acked = false;
    const timeout = setTimeout(function () { if (acked) return; showError('Server did not respond. Check your WiFi and try again.'); }, 5000);
    socket.emit('player:join', { playerId: pid, name: name }, function (res) {
      acked = true;
      clearTimeout(timeout);
      if (!res || !res.ok) {
        const reason = res && res.reason;
        const friendly = {
          'name-too-short': 'Please enter a valid name.',
          'name-taken': (res && res.name ? '"' + res.name + '"' : 'That name') + ' is already taken.',
          'host-absent': 'The host isn\'t here right now. Wait for them to return and try again.',
          'round-in-progress': 'A game is already in progress. Wait for the host to start a new one.',
          'game-full': 'The game is full right now. Wait for a spot to open up.',
          'bad-player-id': 'Something went wrong. Please reload the page.',
        }[reason] || 'Could not join. Please try again.';
        return showError(friendly);
      }
      localStorage.setItem('snakeparty.playerId', pid);
      localStorage.setItem('snakeparty.playerName', res.player.name);
      window.location.replace('/snakeparty/play');
    });
  });
})();
