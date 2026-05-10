(function () {
  'use strict';

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

  // Host-absent overlay (created on demand, covers the join form).
  function ensureHostAbsentOverlay() {
    let ov = document.getElementById('hostAbsentOverlay');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'hostAbsentOverlay';
    ov.className = 'host-absent-overlay';
    ov.hidden = true;
    ov.innerHTML =
      '<div class="host-absent-card">' +
        '<div class="icon">🧠</div>' +
        '<div class="title">No game in progress</div>' +
        '<div class="sub">' +
          '<span class="pulse-dot"></span>' +
          'The host isn\'t here right now. This page will unlock automatically when they return.' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    return ov;
  }
  function setHostPresent(present) {
    const ov = ensureHostAbsentOverlay();
    ov.hidden = !!present;
    submitBtn.disabled = !present;
    if (present) {
      // Clear any stale "host absent" error message
      if (errorMsg.textContent && /host/i.test(errorMsg.textContent)) {
        errorMsg.textContent = '';
      }
    }
  }
  // Default to absent until the server confirms otherwise so we never flash
  // the join form when there's no host.
  setHostPresent(false);

  // If we already have a playerId, go straight to /trivia/play
  const existing = localStorage.getItem('trivia.playerId');
  if (existing) {
    window.location.replace('/trivia/play');
    return;
  }

  // Pre-fill name if the host just reset the game.
  const rejoinName = localStorage.getItem('trivia.rejoinName');
  if (rejoinName) {
    nameInput.value = rejoinName;
    localStorage.removeItem('trivia.rejoinName');
  }

  const socket = io('/trivia', { transports: ['polling', 'websocket'] });

  let socketReady = false;
  socket.on('connect', function () {
    socketReady = true;
    errorMsg.textContent = '';
    // Ask the server whether a host is currently present. Until we hear back,
    // the form stays disabled (default state set above).
    socket.emit('query:status', {}, function (status) {
      setHostPresent(!!(status && status.hostPresent));
    });
  });
  socket.on('state:hostPresence', function (p) {
    setHostPresent(!(p && p.present === false));
  });
  socket.on('connect_error', function (err) {
    errorMsg.textContent = 'Connection error: ' + (err && err.message ? err.message : err);
  });
  socket.on('disconnect', function () {
    socketReady = false;
  });

  function showError(msg) {
    errorMsg.textContent = msg;
    submitBtn.disabled = false;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorMsg.textContent = '';
    const name = nameInput.value.trim();
    if (!name) return showError('Please enter a name.');
    if (!socketReady) {
      return showError('Not connected to server yet — please wait a moment and try again.');
    }
    submitBtn.disabled = true;
    const pid = uuid();
    let acked = false;
    const timeout = setTimeout(function () {
      if (acked) return;
      showError('Server did not respond. Check your WiFi and try again.');
    }, 5000);
    socket.emit('player:join', { playerId: pid, name: name }, function (res) {
      acked = true;
      clearTimeout(timeout);
      if (!res || !res.ok) {
        const reason = res && res.reason;
        const friendly = {
          'lobby-closed': 'The quiz has already started — sorry, you cannot join now.',
          'name-blocked': 'Please choose a different name.',
          'name-too-short': 'Please enter a valid name.',
          'name-taken': (res && res.name ? '"' + res.name + '"' : 'That name') + ' is already another player\'s name.',
          'host-absent': 'The host isn\'t here right now. Wait for them to return and try again.',
          'bad-player-id': 'Something went wrong. Please reload the page.',
        }[reason] || 'Could not join. Please try again.';
        return showError(friendly);
      }
      localStorage.setItem('trivia.playerId', pid);
      localStorage.setItem('trivia.playerName', res.player.name);
      window.location.replace('/trivia/play');
    });
  });
})();
