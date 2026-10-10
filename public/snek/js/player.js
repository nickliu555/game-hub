(function () {
  'use strict';

  const playerId = localStorage.getItem('snek.playerId');
  const playerName = localStorage.getItem('snek.playerName') || 'Player';
  if (!playerId) { window.location.replace('/snek/join'); return; }

  // Direction codes shared with the server relay + host engine.
  const UP = 0, DOWN = 1, LEFT = 2, RIGHT = 3;
  const START_LEN = 3;

  // ---------------- Kill all zoom / gesture / selection behaviour ----------------
  // A fixed fullscreen gamepad — it must NEVER zoom, pan or select text. iOS
  // Safari ignores maximum-scale/user-scalable, so belt-and-suspenders in JS.
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

  const socket = io('/snek', { transports: ['polling', 'websocket'] });

  // ---------------- Element refs ----------------
  const body = document.body;
  const views = {
    lobby: document.getElementById('view-lobby'),
    controller: document.getElementById('view-controller'),
    eliminated: document.getElementById('view-eliminated'),
    results: document.getElementById('view-results'),
    final: document.getElementById('view-final'),
    kicked: document.getElementById('view-kicked'),
  };
  const lobbyName = document.getElementById('lobbyName');
  const hudName = document.getElementById('hudName');
  const hudScore = document.getElementById('hudScore');
  const hudUnit = document.getElementById('hudUnit');
  const hudPips = document.getElementById('hudPips');
  const ctrlOverlay = document.getElementById('ctrlOverlay');
  const coCount = document.getElementById('coCount');
  const coText = document.getElementById('coText');
  const pad = document.getElementById('pad');
  const elimLen = document.getElementById('elimLen');
  const elimSub = document.getElementById('elimSub');
  const resIcon = document.getElementById('resIcon');
  const resTitle = document.getElementById('resTitle');
  const resWins = document.getElementById('resWins');
  const resSub = document.getElementById('resSub');
  const finalEmoji = document.getElementById('finalEmoji');
  const finalTitle = document.getElementById('finalTitle');
  const finalBig = document.getElementById('finalBig');
  const finalSub = document.getElementById('finalSub');
  const kickRejoinBtn = document.getElementById('kickRejoinBtn');
  const hostAbsentOverlay = document.getElementById('hostAbsentOverlay');
  const pauseCover = document.getElementById('pauseCover');
  const playerAttribution = document.getElementById('playerAttribution');
  const reactionBar = document.getElementById('reactionBar');
  const reactionCooldown = document.getElementById('reactionCooldown');
  const swipeArrow = document.getElementById('swipeArrow');
  const gamepadBadge = document.getElementById('gamepadBadge');
  const gearBtn = document.getElementById('gearBtn');
  const ctrlPopover = document.getElementById('ctrlPopover');
  const modeToggle = document.getElementById('modeToggle');
  const ctrlSettings = document.getElementById('ctrlSettings');
  const dpad = document.getElementById('dpad');
  const swipeHint = document.getElementById('swipeHint');
  const stickLayer = document.getElementById('stickLayer');
  const stickBase = document.getElementById('stickBase');
  const stickKnob = document.getElementById('stickKnob');

  // ---------------- State ----------------
  let currentPhase = 'LOBBY';
  let stage = 'countdown';        // countdown | play | roundover (within PLAYING)
  let currentView = 'lobby';
  let mode = 'multi';
  let controlsEnabled = false;
  let eliminated = false;
  let roundsToWin = 3;
  let myGamePoints = 0;
  let myLength = START_LEN;
  let roster = [];
  let kicked = false;
  let hostPresent = true;
  let reactionsMuted = false;

  function showView(name) {
    if (kicked && name !== 'kicked') return;
    currentView = name;
    Object.keys(views).forEach(function (k) { if (views[k]) views[k].style.display = (k === name) ? '' : 'none'; });
    body.classList.toggle('playing', name === 'controller');
    if (ctrlSettings) {
      const showSettings = (name === 'controller' || name === 'eliminated');
      ctrlSettings.style.display = showSettings ? '' : 'none';
      if (!showSettings && ctrlPopover) {
        ctrlPopover.hidden = true;
        if (gearBtn) gearBtn.setAttribute('aria-expanded', 'false');
      }
    }
    updateChrome();
  }

  // Footer + reactions are gated on the PHASE (views get reused), never just the view.
  function reactionsOpen() {
    if (kicked) return false;
    if (currentPhase === 'LOBBY') return currentView === 'lobby';
    if (currentPhase === 'FINAL') return currentView === 'final';
    return currentPhase === 'PLAYING' && stage === 'roundover' && currentView === 'results';
  }
  function updateChrome() {
    if (playerAttribution) playerAttribution.hidden = !(currentPhase === 'LOBBY' && currentView === 'lobby' && !kicked);
    if (reactionBar) reactionBar.hidden = !(reactionsOpen() && !reactionsMuted && hostPresent);
  }

  if (lobbyName) lobbyName.textContent = playerName;
  if (hudName) hudName.textContent = playerName;

  function nameSpan(name, color) {
    const s = document.createElement('span');
    s.className = 'pname';
    s.textContent = name;
    if (color) s.style.color = color;
    return s;
  }
  function setRich(el, parts) {
    el.textContent = '';
    parts.forEach(function (p) { el.appendChild(typeof p === 'string' ? document.createTextNode(p) : p); });
  }
  function rosterEntry(id) { return roster.find(function (r) { return r.id === id; }) || null; }
  function applyRoster(list) {
    if (Array.isArray(list) && list.length) roster = list;
    const me = rosterEntry(playerId);
    if (me && me.color) body.style.setProperty('--me', me.color);
  }

  // ---------------- Host presence ----------------
  function setHostPresent(present) {
    hostPresent = !!present;
    if (hostAbsentOverlay) hostAbsentOverlay.hidden = hostPresent;
    updateChrome();
  }
  socket.on('state:hostPresence', function (p) { setHostPresent(!(p && p.present === false)); });
  socket.on('state:reactionsMuted', function (p) { reactionsMuted = !!(p && p.muted); updateChrome(); });

  // ---------------- Boot / reconnect ----------------
  socket.on('connect', function () {
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (!res || !res.ok) {
        localStorage.setItem('snek.rejoinName', playerName);
        localStorage.removeItem('snek.playerId');
        window.location.replace('/snek/join');
        return;
      }
      reactionsMuted = !!res.reactionsMuted;
      setHostPresent(res.hostPresent !== false);
      applyPhase(res);
    });
  });

  // ---------------- Power-up badges ----------------
  const powerBadges = document.getElementById('powerBadges');
  const POWER_LABEL = { magnet: '🧲 MAGNET', phantom: '👻 PHANTOM' };
  let powerUntil = {};      // power -> Date.now() ms it ends
  let powerTimer = null;
  function renderPowers() {
    if (!powerBadges) return;
    const now = Date.now();
    const parts = [];
    Object.keys(powerUntil).forEach(function (k) {
      const left = Math.ceil((powerUntil[k] - now) / 1000);
      if (left <= 0) { delete powerUntil[k]; return; }
      parts.push({ k: k, left: left });
    });
    powerBadges.textContent = '';
    parts.forEach(function (x) {
      const b = document.createElement('div');
      b.className = 'power-badge pb-' + x.k + (x.left <= 2 ? ' ending' : '');
      b.textContent = POWER_LABEL[x.k] + ' · ' + x.left;
      powerBadges.appendChild(b);
    });
    if (!parts.length && powerTimer) { clearInterval(powerTimer); powerTimer = null; }
  }
  function setPower(power, sec) {
    if (sec > 0) {
      powerUntil[power] = Date.now() + sec * 1000;
      if (!powerTimer) powerTimer = setInterval(renderPowers, 250);
      vibrate([60, 40, 60]);
    } else delete powerUntil[power];
    renderPowers();
  }
  function clearPowers() { powerUntil = {}; renderPowers(); }
  socket.on('m:power', function (d) {
    if (!d || d.id !== playerId) return;
    setPower(d.power, Number(d.sec) || 0);
  });

  function applyPhase(res) {
    currentPhase = res.phase;
    const m = res.match;
    if (res.lobby) renderLobbyInfo(res.lobby);
    if (m) {
      mode = m.mode === 'solo' ? 'solo' : 'multi';
      roundsToWin = m.roundsToWin || roundsToWin;
      myGamePoints = (m.gamePoints || {})[playerId] || 0;
      applyRoster(m.roster);
      const L = (m.lengths || {})[playerId];
      if (L) myLength = L;
    }
    if (res.phase === 'LOBBY') {
      eliminated = false;
      showView('lobby');
    } else if (res.phase === 'PLAYING' && m) {
      stage = m.stage || 'countdown';
      clearPowers();
      const mine = m.powers && m.powers[playerId];
      if (mine && stage === 'play') setPower(mine.power, mine.sec);
      eliminated = !!(m.alive && m.alive[playerId] === false);
      if (pauseCover) pauseCover.hidden = !m.paused;
      if (stage === 'roundover') { renderResults(m.lastRound || {}); }
      else if (eliminated) { showEliminated(); }
      else {
        showView('controller');
        updateHud();
        if (m.paused) setControls(false);
        else if (m.live) { setControls(true); hideOverlay(); }
        else { setControls(false); showOverlay('', 'Get ready…'); }
      }
    } else if (res.phase === 'FINAL' && m) {
      renderFinal(m);
    }
  }

  function renderLobbyInfo(l) {
    if (!l) return;
    applyRoster(l.players);
  }

  socket.on('state:lobby', function (l) {
    if (!l) return;
    if (l.phase === 'LOBBY') {
      renderLobbyInfo(l);
      if (currentPhase === 'LOBBY') showView('lobby');
    }
  });
  socket.on('state:reset', function () {
    localStorage.setItem('snek.rejoinName', playerName);
    localStorage.removeItem('snek.playerId');
    window.location.replace('/snek/join');
  });
  socket.on('player:rejected', function (p) {
    if (p && p.reason === 'kicked') { kicked = true; localStorage.removeItem('snek.playerId'); showView('kicked'); }
  });

  // ---------------- Match events ----------------
  socket.on('m:start', function (d) {
    clearPowers();
    currentPhase = 'PLAYING';
    stage = 'countdown';
    if (d) {
      mode = d.mode === 'solo' ? 'solo' : 'multi';
      roundsToWin = d.roundsToWin || roundsToWin;
      applyRoster(d.roster);
    }
    myGamePoints = 0; eliminated = false; myLength = START_LEN;
    if (pauseCover) pauseCover.hidden = true;
    showView('controller');
    updateHud();
    setControls(false);
    showOverlay('', 'Get ready…');
  });
  socket.on('m:roundStart', function (d) {
    clearPowers();
    currentPhase = 'PLAYING';
    stage = 'countdown';
    eliminated = false;
    myLength = START_LEN;
    if (d) { roundsToWin = d.roundsToWin || roundsToWin; if (d.mode) mode = d.mode === 'solo' ? 'solo' : 'multi'; }
    if (pauseCover) pauseCover.hidden = true;
    showView('controller');
    updateHud();
    setControls(false);
    showOverlay('', mode === 'solo' ? 'Get ready…' : 'Round ' + (d && d.round ? d.round : '') + '…');
  });
  socket.on('m:countdown', function (d) {
    stage = 'countdown';
    if (eliminated) return;
    setControls(false);
    showOverlay(d && d.n != null ? String(d.n) : '', 'Get ready…');
  });
  socket.on('m:play', function () {
    stage = 'play';
    if (eliminated) return;
    hideOverlay();
    setControls(true);
    setAwaitingStart(true);
    vibrate([120, 60, 120]);
  });
  socket.on('m:clock', function (d) {
    if (d && d.lengths && typeof d.lengths[playerId] === 'number' && !eliminated) { myLength = d.lengths[playerId]; updateHud(); }
  });
  socket.on('m:eliminated', function (d) {
    if (!d || d.id !== playerId) return;
    clearPowers();
    eliminated = true;
    if (typeof d.length === 'number') myLength = d.length;
    setControls(false);
    showEliminated();
  });
  socket.on('m:decided', function () { setControls(false); });
  socket.on('m:roundOver', function (d) {
    clearPowers();
    stage = 'roundover';
    setControls(false);
    if (d && d.gamePoints) myGamePoints = d.gamePoints[playerId] || 0;
    if (d && d.lengths && typeof d.lengths[playerId] === 'number') myLength = d.lengths[playerId];
    renderResults(d || {});
  });
  socket.on('m:pause', function () {
    setControls(false);
    if (pauseCover) pauseCover.hidden = false;
  });
  socket.on('m:resume', function (d) {
    if (pauseCover) pauseCover.hidden = true;
    setControls(!!(d && d.live) && !eliminated);
  });
  socket.on('m:end', function (d) {
    clearPowers();
    currentPhase = 'FINAL';
    setControls(false);
    if (pauseCover) pauseCover.hidden = true;
    renderFinal(d || {});
  });

  // ---------------- HUD / views ----------------
  function updateHud() {
    if (mode === 'solo') {
      if (hudScore) hudScore.textContent = myLength;
      if (hudUnit) hudUnit.textContent = 'length';
      if (hudPips) hudPips.innerHTML = '';
      return;
    }
    if (hudScore) hudScore.textContent = myLength;
    if (hudUnit) hudUnit.textContent = 'length';
    if (!hudPips) return;
    if (hudPips.children.length !== roundsToWin) {
      hudPips.innerHTML = '';
      for (let k = 0; k < roundsToWin; k++) { const d = document.createElement('span'); d.className = 'pip'; hudPips.appendChild(d); }
    }
    for (let k = 0; k < hudPips.children.length; k++) hudPips.children[k].classList.toggle('on', k < myGamePoints);
  }

  function showOverlay(count, text) {
    if (!ctrlOverlay) return;
    ctrlOverlay.hidden = false;
    if (count && count.length) { coCount.style.display = ''; coCount.textContent = count; coCount.style.animation = 'none'; void coCount.offsetWidth; coCount.style.animation = ''; }
    else coCount.style.display = 'none';
    coText.textContent = text || '';
  }
  function hideOverlay() { if (ctrlOverlay) ctrlOverlay.hidden = true; }

  function showEliminated() {
    hideOverlay();
    if (elimLen) elimLen.textContent = myLength;
    if (elimSub) elimSub.textContent = mode === 'solo'
      ? 'Look up at the big screen for your score.'
      : 'Your length is locked in — it can still win the round!';
    showView('eliminated');
  }

  function renderResults(d) {
    const winnerId = d.winnerId || null;
    const won = winnerId === playerId;
    const w = winnerId ? rosterEntry(winnerId) : null;
    if (resIcon) resIcon.textContent = won ? '🏆' : (winnerId ? '🐍' : '🤝');
    if (won) resTitle.textContent = 'You won the round!';
    else if (w) setRich(resTitle, [nameSpan(w.name, w.color), ' wins the round']);
    else resTitle.textContent = 'Draw — nobody scores';
    resTitle.style.color = won ? 'var(--good)' : '';
    if (resWins) resWins.textContent = '🏆 ' + myGamePoints + ' / ' + roundsToWin;
    if (resSub) resSub.textContent = 'Next round starting soon…';
    showView('results');
  }

  function renderFinal(d) {
    const solo = (d.mode || mode) === 'solo';
    if (window.__setAgain) window.__setAgain(solo);
    if (solo) {
      const s = d.solo || { score: myLength, newBest: false };
      finalEmoji.textContent = s.newBest ? '🏆' : '🐍';
      finalTitle.textContent = s.newBest ? 'New session best!' : 'Game over';
      finalBig.textContent = 'Length ' + s.score;
      finalBig.classList.add('solo-len');
      const best = d.soloBest;
      if (best && !s.newBest) {
        const num = document.createElement('span'); num.className = 'best-num'; num.textContent = best.score;
        setRich(finalSub, ['Session best: ', num]);
      }
      else finalSub.textContent = 'Look up at the host screen.';
    } else {
      const champs = d.winnerIds || [];
      const iWon = champs.indexOf(playerId) >= 0;
      const gp = (d.gamePoints || {})[playerId];
      if (typeof gp === 'number') myGamePoints = gp;
      finalEmoji.textContent = iWon ? '🏆' : '🐍';
      if (iWon) finalTitle.textContent = 'You win!';
      else if (champs.length) {
        const w = rosterEntry(champs[0]);
        setRich(finalTitle, [nameSpan(w ? w.name : '?', w ? w.color : ''), ' wins!']);
      } else finalTitle.textContent = 'Game over';
      finalBig.classList.remove('solo-len');
      finalBig.textContent = '🏆 ' + myGamePoints + (myGamePoints === 1 ? ' round won' : ' rounds won');
      finalSub.textContent = 'Look up at the host screen for the results.';
    }
    showView('final');
  }

  // ---------------- Reactions ----------------
  const REACTION_COOLDOWN_MS = 5000;
  let reactionUntil = 0, cooldownRaf = null;
  const reactionBtns = reactionBar ? Array.prototype.slice.call(reactionBar.querySelectorAll('.reaction-btn')) : [];
  function startCooldown() {
    if (cooldownRaf) cancelAnimationFrame(cooldownRaf);
    function tick() {
      const left = reactionUntil - Date.now();
      if (left <= 0) {
        reactionBtns.forEach(function (b) { b.disabled = false; });
        if (reactionCooldown) reactionCooldown.hidden = true;
        cooldownRaf = null;
        return;
      }
      reactionBtns.forEach(function (b) { b.disabled = true; });
      if (reactionCooldown) { reactionCooldown.hidden = false; reactionCooldown.textContent = Math.ceil(left / 1000) + 's'; }
      cooldownRaf = requestAnimationFrame(tick);
    }
    tick();
  }
  if (reactionBar) {
    reactionBar.addEventListener('pointerdown', function (e) {
      const btn = e.target.closest('.reaction-btn');
      if (!btn || btn.disabled) return;
      e.preventDefault();
      const idx = parseInt(btn.dataset.reaction, 10);
      if (isNaN(idx)) return;
      reactionUntil = Date.now() + REACTION_COOLDOWN_MS;
      startCooldown();
      socket.emit('player:reaction', { index: idx }, function (res) {
        if (res && !res.ok && res.reason === 'cooldown' && res.retryInMs) {
          reactionUntil = Date.now() + res.retryInMs;
          startCooldown();
        }
      });
    });
  }

  // ---------------- Controls ----------------
  // Three control schemes, switchable via the ⚙️ gear:
  //   • Joystick (default): a thumbstick appears wherever the thumb lands;
  //     pushing it past a small deadzone turns, and letting go keeps heading.
  //   • Swipe: flick a direction anywhere on the screen.
  //   • Tap zones: the screen splits along its diagonals into 4 triangles.
  // Every distinct turn is sent at once (so quick "up, left" taps both land);
  // a repeat of the same direction is only re-sent after a short gap.
  const SWIPE_THRESHOLD = 22;
  const ARROW_DEG = { 0: 0, 1: 180, 2: 270, 3: 90 };
  const RESEND_MS = 160;
  let currentDir = -1;
  let lastSentAt = 0;
  let touch = null;
  const controllerView = views.controller;

  const savedMode = localStorage.getItem('snek.controlMode');
  let controlMode = (savedMode === 'tap' || savedMode === 'swipe') ? savedMode : 'stick';
  const dpadZones = dpad ? Array.prototype.slice.call(dpad.querySelectorAll('.dpad-zone')) : [];

  function send(dir) { lastSentAt = Date.now(); socket.emit('in', { dir: dir }); }
  function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {} }
  function highlightZone(dir) {
    dpadZones.forEach(function (z) { z.classList.toggle('active', Number(z.getAttribute('data-dir')) === dir); });
  }
  function showDir(dir) {
    highlightZone(dir);
    if (!swipeArrow) return;
    if (dir < 0) { swipeArrow.style.opacity = '0.25'; return; }
    swipeArrow.style.opacity = '1';
    swipeArrow.style.transform = 'rotate(' + (ARROW_DEG[dir] - 90) + 'deg)';
  }
  function setDir(dir) {
    if (!controlsEnabled || eliminated || dir < 0) return;
    if (awaitingStart) setAwaitingStart(false);
    if (dir !== currentDir) { currentDir = dir; vibrate(14); showDir(dir); send(dir); return; }
    if (Date.now() - lastSentAt >= RESEND_MS) send(dir);
  }
  // Snakes hold still at the start of a round until their player steers (the
  // host releases them anyway after WAIT_LIMIT_MS), so prompt for that first move.
  const WAIT_LIMIT_MS = 10000;
  let awaitingStart = false, awaitTimer = null;
  function setAwaitingStart(on) {
    awaitingStart = !!on;
    if (awaitTimer) { clearTimeout(awaitTimer); awaitTimer = null; }
    if (awaitingStart) awaitTimer = setTimeout(function () { setAwaitingStart(false); }, WAIT_LIMIT_MS);
    updateHint();
  }
  function updateHint() {
    if (!swipeHint) return;
    swipeHint.classList.toggle('go', awaitingStart);
    swipeHint.textContent = awaitingStart ? '👆 Steer to start your snake!'
      : controlMode === 'tap' ? 'Tap a zone to turn'
      : controlMode === 'swipe' ? 'Swipe anywhere to turn'
      : 'Drag the stick to steer';
  }
  function setControls(enabled) {
    controlsEnabled = enabled && !eliminated;
    if (!controlsEnabled && awaitingStart) setAwaitingStart(false);
    if (pad) pad.style.opacity = controlsEnabled ? '1' : '0.5';
    if (!controlsEnabled) { currentDir = -1; showDir(-1); touch = null; releaseStick(true); }
  }

  function zoneDirFromPoint(x, y) {
    const r = (pad || controllerView).getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    if (dx === 0 && dy === 0) return -1;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : (dy > 0 ? DOWN : UP);
  }

  // ---------------- Joystick mode ----------------
  const STICK_DEADZONE = 0.34;
  let stickId = null;
  let stickOriginX = 0, stickOriginY = 0;
  let stickRadius = 70;

  function measureStickRadius() {
    if (!stickBase) return;
    const r = stickBase.getBoundingClientRect();
    if (r.width) stickRadius = r.width * 0.42;
  }
  window.addEventListener('resize', measureStickRadius);
  window.addEventListener('orientationchange', measureStickRadius);

  function setKnob(px, py) {
    if (stickKnob) stickKnob.style.transform = 'translate(-50%, -50%) translate(' + px + 'px, ' + py + 'px)';
  }
  function updateStick(clientX, clientY) {
    let dx = clientX - stickOriginX;
    let dy = clientY - stickOriginY;
    const dist = Math.hypot(dx, dy);
    if (dist > stickRadius) { dx = (dx / dist) * stickRadius; dy = (dy / dist) * stickRadius; }
    setKnob(dx, dy);
    if (dist < stickRadius * STICK_DEADZONE) return;
    setDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : (dy > 0 ? DOWN : UP));
  }
  function grabStick(e) {
    if (stickId !== null || !stickBase || !stickLayer) return;
    stickId = e.pointerId;
    measureStickRadius();
    const zone = stickLayer.getBoundingClientRect();
    const half = stickBase.getBoundingClientRect().width / 2;
    const x = Math.min(Math.max(e.clientX, zone.left + half), zone.right - half);
    const y = Math.min(Math.max(e.clientY, zone.top + half), zone.bottom - half);
    stickBase.style.position = 'absolute';
    stickBase.style.left = (x - zone.left - half) + 'px';
    stickBase.style.top = (y - zone.top - half) + 'px';
    stickOriginX = e.clientX; stickOriginY = e.clientY;
    stickBase.classList.add('active');
    try { controllerView.setPointerCapture(e.pointerId); } catch (_) {}
    updateStick(e.clientX, e.clientY);
  }
  function moveStick(e) {
    if (stickId === null || e.pointerId !== stickId) return;
    updateStick(e.clientX, e.clientY);
  }
  function releaseStick(force, e) {
    if (!force && (stickId === null || !e || e.pointerId !== stickId)) return;
    stickId = null;
    if (!stickBase) return;
    stickBase.classList.remove('active');
    stickBase.style.position = '';
    stickBase.style.left = '';
    stickBase.style.top = '';
    setKnob(0, 0);
  }
  window.addEventListener('blur', function () { releaseStick(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') releaseStick(true);
  });

  function applyControlMode(m) {
    controlMode = (m === 'tap' || m === 'swipe') ? m : 'stick';
    localStorage.setItem('snek.controlMode', controlMode);
    body.classList.toggle('mode-tap', controlMode === 'tap');
    body.classList.toggle('mode-swipe', controlMode === 'swipe');
    body.classList.toggle('mode-stick', controlMode === 'stick');
    updateHint();
    if (modeToggle) {
      modeToggle.querySelectorAll('.mode-opt').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === controlMode);
      });
    }
    touch = null;
    releaseStick(true);
    measureStickRadius();
  }
  applyControlMode(controlMode);

  // Gear + popover taps must never steer the snake.
  function stopControl(e) { e.stopPropagation(); }
  if (gearBtn && ctrlPopover) {
    gearBtn.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      e.preventDefault();
      const open = ctrlPopover.hidden;
      ctrlPopover.hidden = !open;
      gearBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    ctrlPopover.addEventListener('pointerdown', stopControl);
  }
  if (modeToggle) {
    modeToggle.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      const btn = e.target.closest('.mode-opt');
      if (!btn) return;
      e.preventDefault();
      applyControlMode(btn.getAttribute('data-mode'));
    });
  }
  document.addEventListener('pointerdown', function () {
    if (ctrlPopover && !ctrlPopover.hidden) { ctrlPopover.hidden = true; if (gearBtn) gearBtn.setAttribute('aria-expanded', 'false'); }
  });

  if (controllerView) {
    controllerView.addEventListener('pointerdown', function (e) {
      if (!controlsEnabled || eliminated) return;
      e.preventDefault();
      if (controlMode === 'tap') { setDir(zoneDirFromPoint(e.clientX, e.clientY)); return; }
      if (controlMode === 'stick') { grabStick(e); return; }
      try { controllerView.setPointerCapture(e.pointerId); } catch (_) {}
      touch = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    controllerView.addEventListener('pointermove', function (e) {
      if (controlMode === 'tap') return;
      if (controlMode === 'stick') { moveStick(e); return; }
      if (!touch || e.pointerId !== touch.id) return;
      const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (Math.max(adx, ady) < SWIPE_THRESHOLD) return;
      setDir(adx > ady ? (dx > 0 ? RIGHT : LEFT) : (dy > 0 ? DOWN : UP));
      touch.x = e.clientX; touch.y = e.clientY;
    });
    const endTouch = function (e) {
      releaseStick(false, e);
      if (!touch || (e && e.pointerId !== touch.id)) return;
      touch = null;
    };
    controllerView.addEventListener('pointerup', endTouch);
    controllerView.addEventListener('pointercancel', endTouch);
    controllerView.addEventListener('lostpointercapture', endTouch);
  }

  // Keyboard support (arrows / WASD) for desktop testing.
  document.addEventListener('keydown', function (e) {
    let dir = -1;
    if (e.key === 'ArrowUp' || e.key === 'w') dir = UP;
    else if (e.key === 'ArrowDown' || e.key === 's') dir = DOWN;
    else if (e.key === 'ArrowLeft' || e.key === 'a') dir = LEFT;
    else if (e.key === 'ArrowRight' || e.key === 'd') dir = RIGHT;
    if (dir >= 0 && controlsEnabled && !eliminated) { e.preventDefault(); setDir(dir); }
  });

  // ---------------- Gamepad (Bluetooth controller) support ----------------
  const GP_DEADZONE = 0.35;
  let gpIndex = null;
  function anyGamepad() {
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    for (let i = 0; i < pads.length; i++) { if (pads[i]) return true; }
    return false;
  }
  function activeGamepad() {
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    if (gpIndex !== null && pads[gpIndex]) return pads[gpIndex];
    for (let i = 0; i < pads.length; i++) { if (pads[i]) { gpIndex = i; return pads[i]; } }
    return null;
  }
  function gpDown(gp, i) { const b = gp.buttons && gp.buttons[i]; return !!(b && (b.pressed || b.value > 0.5)); }
  function mapGamepad(gp) {
    const a = gp.axes || [];
    const ax = a.length > 0 ? (a[0] || 0) : 0;
    const ay = a.length > 1 ? (a[1] || 0) : 0;
    if (Math.abs(ax) > GP_DEADZONE || Math.abs(ay) > GP_DEADZONE) {
      return Math.abs(ax) > Math.abs(ay) ? (ax < 0 ? LEFT : RIGHT) : (ay < 0 ? UP : DOWN);
    }
    if (gpDown(gp, 12)) return UP;
    if (gpDown(gp, 13)) return DOWN;
    if (gpDown(gp, 14)) return LEFT;
    if (gpDown(gp, 15)) return RIGHT;
    return -1;
  }
  function pollGamepad() {
    requestAnimationFrame(pollGamepad);
    if (!controlsEnabled || eliminated) return;
    const gp = activeGamepad();
    if (!gp) return;
    const dir = mapGamepad(gp);
    if (dir >= 0) setDir(dir);
  }
  function setGamepadBadge(on) {
    if (gamepadBadge) gamepadBadge.hidden = !on;
    body.classList.toggle('has-gamepad', !!on);
  }
  window.addEventListener('gamepadconnected', function (e) { gpIndex = e.gamepad.index; setGamepadBadge(true); });
  window.addEventListener('gamepaddisconnected', function (e) {
    if (gpIndex === e.gamepad.index) gpIndex = null;
    setGamepadBadge(anyGamepad());
  });
  if (anyGamepad()) setGamepadBadge(true);
  pollGamepad();

  kickRejoinBtn && kickRejoinBtn.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    localStorage.setItem('snek.rejoinName', playerName);
    localStorage.removeItem('snek.playerId');
    window.location.replace('/snek/join');
  });
  // Resume countdown from the host: the pause cover shows the 3-2-1.
  (function () {
    const cover = document.getElementById('pauseCover');
    if (!cover) return;
    const title = cover.querySelector('.pc-title, .pc-note');
    const sub = cover.querySelector('.pc-sub');
    const titleText = title ? title.textContent : '';
    const subText = sub ? sub.textContent : '';
    function reset() {
      cover.classList.remove('resuming');
      if (title) title.textContent = titleText;
      if (sub) sub.textContent = subText;
    }
    socket.on('m:resumeCount', function (d) {
      const n = d && Number(d.n);
      if (!(n > 0)) { reset(); return; }
      cover.classList.add('resuming');
      if (title) { title.textContent = n; title.style.animation = 'none'; void title.offsetWidth; title.style.animation = ''; }
      if (sub) sub.textContent = 'Get ready…';
    });
    socket.on('m:resume', reset);
    socket.on('m:pause', reset);
  })();
  // ---------------- Solo "Play again" ----------------
  // Shown only on the solo Game Over screen; one tap restarts the game.
  (function () {
    const btn = document.getElementById('againBtn');
    if (!btn) return;
    let busy = false;
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (busy) return;
      busy = true; btn.disabled = true;
      const done = function () { busy = false; btn.disabled = false; };
      socket.emit('player:playAgain', {}, done);
      setTimeout(done, 3000);
    });
    window.__setAgain = function (show) { btn.hidden = !show; };
  })();
})();
