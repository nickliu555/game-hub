(function () {
  'use strict';

  const playerId = localStorage.getItem('nong.playerId');
  const playerName = localStorage.getItem('nong.playerName') || 'Player';
  if (!playerId) { window.location.replace('/nong/join'); return; }

  const SEND_MIN_MS = 30;          // don't flood the relay
  const POS_LABELS = {
    2: ['Left side', 'Right side'],
    3: ['Bottom side', 'Right side', 'Left side'],
    4: ['Top-left side', 'Top-right side', 'Bottom-right side', 'Bottom-left side'],
  };

  // ---------------- Kill all zoom / scroll / selection behaviour ----------------
  // iOS Safari ignores maximum-scale/user-scalable — so lock it in JS too. The
  // page never scrolls, so every touch move is swallowed outright.
  (function lockZoom() {
    const stop = function (e) { e.preventDefault(); };
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
      if (now - lastTouchEnd <= 350) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    document.addEventListener('dblclick', stop, { passive: false });
    document.addEventListener('contextmenu', stop, { passive: false });
    document.addEventListener('selectstart', stop, { passive: false });
    document.addEventListener('dragstart', stop, { passive: false });
    window.addEventListener('scroll', function () { window.scrollTo(0, 0); }, { passive: true });
  })();

  const socket = io('/nong', { transports: ['polling', 'websocket'] });

  // ---------------- Element refs ----------------
  const body = document.body;
  const views = {
    lobby: document.getElementById('view-lobby'),
    controller: document.getElementById('view-controller'),
    out: document.getElementById('view-out'),
    final: document.getElementById('view-final'),
    kicked: document.getElementById('view-kicked'),
  };
  const lobbyName = document.getElementById('lobbyName');
  const lobbySeat = document.getElementById('lobbySeat');
  const hudName = document.getElementById('hudName');
  const hudSide = document.getElementById('hudSide');
  const hudStatus = document.getElementById('hudStatus');
  const track = document.getElementById('track');
  const trackRail = document.getElementById('trackRail');
  const trackHint = document.getElementById('trackHint');
  const ctrlOverlay = document.getElementById('ctrlOverlay');
  const coNote = document.getElementById('coNote');
  const coCount = document.getElementById('coCount');
  const outSub = document.getElementById('outSub');
  const finalEmoji = document.getElementById('finalEmoji');
  const finalTitle = document.getElementById('finalTitle');
  const finalSub = document.getElementById('finalSub');
  const kickRejoinBtn = document.getElementById('kickRejoinBtn');
  const hostAbsentOverlay = document.getElementById('hostAbsentOverlay');
  const reconnectOverlay = document.getElementById('reconnectOverlay');
  const pauseCover = document.getElementById('pauseCover');
  const playerAttribution = document.getElementById('playerAttribution');

  // ---------------- State ----------------
  let phase = 'LOBBY';
  let view = 'lobby';
  let kicked = false;
  let paused = false;
  let hostPresent = true;
  let armed = false;
  let roster = [];
  let mode = 'points';
  let target = 5;
  let scores = {};
  let out = [];

  if (lobbyName) lobbyName.textContent = playerName;
  if (hudName) hudName.textContent = playerName;

  function me() {
    for (let i = 0; i < roster.length; i++) if (roster[i].id === playerId) return roster[i];
    return null;
  }
  function rosterById(id) {
    for (let i = 0; i < roster.length; i++) if (roster[i].id === id) return roster[i];
    return null;
  }
  function amOut() { return out.indexOf(playerId) >= 0; }

  function vibrate(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {}
  }

  function nameSpan(r) {
    const s = document.createElement('span');
    s.className = 'pname';
    s.style.color = r.color;
    s.textContent = (r.isBot ? '🤖 ' : '') + r.name;
    return s;
  }
  function setRich(el, parts) {
    el.innerHTML = '';
    parts.forEach(function (p) { el.appendChild(typeof p === 'string' ? document.createTextNode(p) : p); });
  }

  // ---------------- Views + downtime chrome ----------------
  function showView(name) {
    if (kicked && name !== 'kicked') return;
    view = name;
    Object.keys(views).forEach(function (k) {
      if (views[k]) views[k].style.display = (k === name) ? '' : 'none';
    });
    armed = name === 'controller';
    if (!armed) endDrag();
    updateChrome();
  }

  // The attribution belongs to the lobby only. Gated on the phase, not just the view.
  function updateChrome() {
    if (playerAttribution) playerAttribution.hidden = !(phase === 'LOBBY' && view === 'lobby');
  }

  function setSeatColor(color) {
    if (color) body.style.setProperty('--seat', color);
  }

  // ---------------- Host presence / pause ----------------
  function setHostPresent(present) {
    hostPresent = !!present;
    if (hostAbsentOverlay) hostAbsentOverlay.hidden = hostPresent;
    updateChrome();
  }
  socket.on('state:hostPresence', function (p) { setHostPresent(!(p && p.present === false)); });
  function setPaused(on) {
    paused = !!on;
    if (pauseCover) pauseCover.hidden = !paused || view !== 'controller';
    if (paused) endDrag();
  }

  // ---------------- Slider input ----------------
  // The thumb's position along the rail (0..1, left→right or top→bottom) is sent
  // as an integer 0..1000, only when it changes.
  let u = 0.5;
  let touched = false;
  let dragId = null;
  let lastSent = -1, lastSendAt = 0, sendTimer = null;

  function flush() {
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    const p = Math.round(u * 1000);
    if (p === lastSent) return;
    lastSent = p;
    lastSendAt = Date.now();
    socket.emit('in', { p: p });
  }
  function queueSend() {
    if (!armed || paused) return;
    const since = Date.now() - lastSendAt;
    if (since >= SEND_MIN_MS) { flush(); return; }
    if (sendTimer) return;
    sendTimer = setTimeout(function () { sendTimer = null; flush(); }, SEND_MIN_MS - since);
  }
  // A fresh countdown / host refresh loses the paddle target — push it again.
  function resendInput() {
    if (!touched) return;
    lastSent = -1;
    queueSend();
  }

  function setU(v) {
    u = Math.max(0, Math.min(1, v));
    body.style.setProperty('--u', u.toFixed(4));
    queueSend();
  }
  setU(0.5);

  function uFromPoint(x, y) {
    const r = trackRail.getBoundingClientRect();
    if (body.classList.contains('axis-v')) {
      const kh = r.height * 0.26;
      return (y - r.top - kh / 2) / Math.max(1, r.height - kh);
    }
    const kw = r.width * 0.28;
    return (x - r.left - kw / 2) / Math.max(1, r.width - kw);
  }

  function endDrag() {
    dragId = null;
    if (track) track.classList.remove('held');
  }

  track.addEventListener('pointerdown', function (e) {
    if (!armed || paused) return;
    e.preventDefault();
    dragId = e.pointerId;
    touched = true;
    try { track.setPointerCapture(e.pointerId); } catch (_) {}
    track.classList.add('held');
    if (trackHint) trackHint.classList.add('faded');
    setU(uFromPoint(e.clientX, e.clientY));
  });
  track.addEventListener('pointermove', function (e) {
    if (dragId !== e.pointerId) return;
    e.preventDefault();
    setU(uFromPoint(e.clientX, e.clientY));
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
    track.addEventListener(t, function (e) { if (dragId === e.pointerId) endDrag(); });
  });

  // ---------------- Match state ----------------
  function renderStatus() {
    if (!hudStatus) return;
    hudStatus.innerHTML = '';
    const mine = me();
    if (!mine) return;
    if (mode === 'points') {
      const opp = roster.filter(function (r) { return r.id !== playerId; })[0];
      const a = document.createElement('span');
      a.className = 'heart';
      a.textContent = String(scores[playerId] || 0);
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '–';
      const b = document.createElement('span');
      b.className = 'opp';
      if (opp) b.style.setProperty('--opp', opp.color);
      b.textContent = String(opp ? (scores[opp.id] || 0) : 0);
      hudStatus.appendChild(a);
      hudStatus.appendChild(sep);
      hudStatus.appendChild(b);
    } else {
      const left = scores[playerId] || 0;
      for (let k = 0; k < target; k++) {
        const h = document.createElement('span');
        h.className = 'heart' + (k < left ? '' : ' lost');
        h.textContent = '♥';
        hudStatus.appendChild(h);
      }
    }
  }

  function aliveCount() {
    return roster.filter(function (r) { return out.indexOf(r.id) < 0; }).length;
  }

  function renderOut() {
    const n = aliveCount();
    if (outSub) outSub.textContent = n + (n === 1 ? ' paddle' : ' paddles') + ' still in — keep watching the screen.';
  }

  function setLive(on) {
    if (ctrlOverlay) ctrlOverlay.hidden = !!on;
  }

  function applyMatch(m) {
    if (!m) return;
    roster = m.roster || roster;
    mode = m.mode === 'lives' ? 'lives' : 'points';
    target = m.target || target;
    scores = Object.assign({}, m.scores || {});
    out = (m.out || []).slice();
    const mine = me();
    if (mine) {
      setSeatColor(mine.color);
      body.classList.toggle('axis-v', mine.axis === 'v');
      body.classList.toggle('axis-h', mine.axis !== 'v');
      const labels = POS_LABELS[Math.max(2, Math.min(4, roster.length))] || [];
      if (hudSide) hudSide.textContent = mine.colorName + ' · ' + (labels[mine.seat] || '');
    }
    renderStatus();
  }

  function enterPlaying() {
    if (amOut()) { renderOut(); showView('out'); }
    else showView('controller');
  }

  function syncScores(d) {
    if (d.scores) scores = Object.assign({}, d.scores);
    if (Array.isArray(d.out)) out = d.out.slice();
    renderStatus();
    if (phase === 'PLAYING') {
      if (amOut() && view !== 'out') { renderOut(); showView('out'); }
      else if (view === 'out') renderOut();
    }
  }

  socket.on('m:start', function (m) {
    phase = 'PLAYING';
    applyMatch(m);
    setPaused(false);
    lastSent = -1;
    if (coNote) { coNote.textContent = 'Get ready'; coNote.hidden = false; }
    if (coCount) coCount.textContent = '';
    setLive(false);
    if (trackHint) trackHint.classList.remove('faded');
    enterPlaying();
    vibrate(30);
  });

  socket.on('m:countdown', function (d) {
    setLive(false);
    resendInput();
    if (coCount) coCount.textContent = (d && d.n > 0) ? String(d.n) : 'GO!';
    if (coNote) {
      coNote.textContent = (d && d.note) || '';
      coNote.hidden = !(d && d.note);
    }
  });
  socket.on('m:play', function () { setLive(true); resendInput(); vibrate(15); });
  socket.on('m:sync', function (d) {
    if (!d || phase !== 'PLAYING') return;
    syncScores(d);
    if (typeof d.paused === 'boolean') setPaused(d.paused);
    if (typeof d.live === 'boolean' && d.live && !paused) setLive(true);
  });
  socket.on('m:point', function (d) {
    if (!d) return;
    setLive(false);
    syncScores(d);
    const conceded = rosterById(d.concededId);
    const scorer = rosterById(d.scorerId);
    const elim = rosterById(d.eliminatedId);
    if (coCount) coCount.textContent = '';
    if (coNote) {
      coNote.hidden = false;
      if (d.eliminatedId === playerId) setRich(coNote, ['You\'re out!']);
      else if (d.scorerId === playerId) setRich(coNote, ['You scored! 🎉']);
      else if (d.concededId === playerId) setRich(coNote, [mode === 'lives' ? 'You lost a life' : 'Missed it!']);
      else if (elim) setRich(coNote, [nameSpan(elim), ' is out!']);
      else if (scorer) setRich(coNote, [nameSpan(scorer), ' scores']);
      else if (conceded) setRich(coNote, [nameSpan(conceded), ' lost a life']);
    }
    if (d.concededId === playerId) vibrate(d.eliminatedId === playerId ? [80, 60, 160] : 90);
    else if (d.scorerId === playerId) vibrate([30, 50, 30]);
  });
  socket.on('m:pause', function () { setPaused(true); });
  socket.on('m:resume', function (d) { setPaused(false); setLive(!!(d && d.live)); });

  function renderFinal(winnerId, finalScores, placings) {
    if (finalScores) scores = Object.assign({}, finalScores);
    const won = winnerId === playerId;
    const winner = rosterById(winnerId);
    if (finalEmoji) finalEmoji.textContent = won ? '🏆' : '🏁';
    if (won) setRich(finalTitle, ['You win!']);
    else if (winner) setRich(finalTitle, [nameSpan(winner), ' wins!']);
    else setRich(finalTitle, ['Game over']);
    let sub = '';
    if (mode === 'points') {
      const opp = roster.filter(function (r) { return r.id !== playerId; })[0];
      const mineScore = scores[playerId] || 0;
      const oppScore = opp ? (scores[opp.id] || 0) : 0;
      sub = (won ? 'You won ' : 'You lost ') + mineScore + ' – ' + oppScore;
    } else {
      const idx = (placings || []).indexOf(playerId);
      if (idx >= 0) {
        const n = idx + 1;
        sub = 'You placed ' + n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
      }
    }
    if (finalSub) finalSub.textContent = sub;
  }

  socket.on('m:end', function (d) {
    phase = 'FINAL';
    setLive(false);
    setPaused(false);
    if (d && Array.isArray(d.out)) out = d.out.slice();
    renderFinal(d && d.winnerId, d && d.scores, d && d.placings);
    showView('final');
    vibrate(d && d.winnerId === playerId ? [40, 80, 40] : 120);
  });

  function applyLobby(l) {
    if (!l || l.phase !== 'LOBBY') return;
    const mine = (l.players || []).filter(function (p) { return p.id === playerId; })[0];
    if (!mine) return;
    phase = 'LOBBY';
    setSeatColor(mine.color);
    if (lobbySeat) lobbySeat.textContent = 'P' + (mine.seat + 1) + ' · ' + mine.colorName + ' paddle';
    showView('lobby');
  }
  socket.on('state:lobby', applyLobby);

  socket.on('state:reset', function () {
    setLive(false);
    setPaused(false);
    localStorage.removeItem('nong.playerId');
    localStorage.setItem('nong.rejoinName', playerName);
    window.location.replace('/nong/join');
  });

  socket.on('player:rejected', function () {
    kicked = true;
    setLive(false);
    localStorage.removeItem('nong.playerId');
    showView('kicked');
  });

  kickRejoinBtn && kickRejoinBtn.addEventListener('click', function () {
    localStorage.setItem('nong.rejoinName', playerName);
    window.location.replace('/nong/join');
  });

  // ---------------- Boot / reconnect ----------------
  // A dropped phone is never a forfeit: if the server can't place us we keep
  // retrying behind a "Reconnecting" cover instead of throwing the player back
  // to the join page, which would lock them out for the rest of the match.
  let reconnectTries = 0;
  function setReconnecting(on) { if (reconnectOverlay) reconnectOverlay.hidden = !on; }

  function backToJoin() {
    localStorage.setItem('nong.rejoinName', playerName);
    localStorage.removeItem('nong.playerId');
    window.location.replace('/nong/join');
  }

  function attemptReconnect() {
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (!res || !res.ok) {
        reconnectTries++;
        // Only give up once the server is clearly in a fresh lobby (restarted or
        // reset) — then rejoining is possible and is the right thing to do.
        if (res && res.reason === 'unknown-player' && reconnectTries >= 3) return backToJoin();
        setReconnecting(true);
        setTimeout(function () { if (socket.connected) attemptReconnect(); }, 1500);
        return;
      }
      reconnectTries = 0;
      setReconnecting(false);
      kicked = false;
      setHostPresent(res.hostPresent !== false);
      lastSent = -1;
      if (res.phase === 'PLAYING' && res.match) {
        phase = 'PLAYING';
        applyMatch(res.match);
        // Clear any stale countdown text; the heartbeat repaints within moments.
        if (coNote) { coNote.textContent = 'Get ready…'; coNote.hidden = false; }
        if (coCount) coCount.textContent = '';
        setLive(!!res.match.live && !res.match.paused);
        enterPlaying();
        setPaused(!!res.match.paused);
      } else if (res.phase === 'FINAL' && res.match) {
        phase = 'FINAL';
        applyMatch(res.match);
        renderFinal(res.match.winnerId, res.match.scores, res.match.placings);
        showView('final');
      } else {
        phase = 'LOBBY';
        applyLobby(res.lobby);
        showView('lobby');
      }
    });
  }

  socket.on('connect', function () { attemptReconnect(); });
  socket.on('disconnect', function () { setReconnecting(true); endDrag(); });

  body.classList.add('axis-h');
  showView('lobby');
})();
