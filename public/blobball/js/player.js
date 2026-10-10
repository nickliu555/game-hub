(function () {
  'use strict';

  const playerId = localStorage.getItem('blobball.playerId');
  const playerName = localStorage.getItem('blobball.playerName') || 'Player';
  if (!playerId) { window.location.replace('/blobball/join'); return; }

  const LEFT = 0, RIGHT = 1, JUMP = 2;
  const REACTION_COOLDOWN_MS = 5000;

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

  // WebSocket straight away (no long-polling warm-up adding lag to the first
  // inputs), falling back to polling on networks that block it.
  const socket = io('/blobball', { transports: ['websocket', 'polling'], tryAllTransports: true });

  // ---------------- Element refs ----------------
  const body = document.body;
  const views = {
    lobby: document.getElementById('view-lobby'),
    controller: document.getElementById('view-controller'),
    final: document.getElementById('view-final'),
    kicked: document.getElementById('view-kicked'),
  };
  const lobbyName = document.getElementById('lobbyName');
  const lobbySeat = document.getElementById('lobbySeat');
  const hudName = document.getElementById('hudName');
  const hudSide = document.getElementById('hudSide');
  const hudStatus = document.getElementById('hudStatus');
  const padMove = document.getElementById('padMove');
  const btnLeft = document.getElementById('btnLeft');
  const btnRight = document.getElementById('btnRight');
  const btnJump = document.getElementById('btnJump');
  const stickBase = document.getElementById('stickBase');
  const stickKnob = document.getElementById('stickKnob');
  const stickArrowL = document.getElementById('stickArrowL');
  const stickArrowR = document.getElementById('stickArrowR');
  const gearBtn = document.getElementById('gearBtn');
  const ctrlPopover = document.getElementById('ctrlPopover');
  const modeToggle = document.getElementById('modeToggle');
  const ctrlOverlay = document.getElementById('ctrlOverlay');
  const coNote = document.getElementById('coNote');
  const coCount = document.getElementById('coCount');
  const finalEmoji = document.getElementById('finalEmoji');
  const finalTitle = document.getElementById('finalTitle');
  const finalSub = document.getElementById('finalSub');
  const kickRejoinBtn = document.getElementById('kickRejoinBtn');
  const hostAbsentOverlay = document.getElementById('hostAbsentOverlay');
  const reconnectOverlay = document.getElementById('reconnectOverlay');
  const pauseCover = document.getElementById('pauseCover');
  const playerAttribution = document.getElementById('playerAttribution');
  const reactionBar = document.getElementById('reactionBar');
  const reactionCooldown = document.getElementById('reactionCooldown');

  // ---------------- State ----------------
  let phase = 'LOBBY';
  let view = 'lobby';
  let kicked = false;
  let paused = false;
  let hostPresent = true;
  let reactionsMuted = false;
  let roster = [];
  let target = 7;
  let scores = {};

  if (lobbyName) lobbyName.textContent = playerName;
  if (hudName) hudName.textContent = playerName;

  function me() {
    for (let i = 0; i < roster.length; i++) if (roster[i].id === playerId) return roster[i];
    return null;
  }
  function opponent() {
    for (let i = 0; i < roster.length; i++) if (roster[i].id !== playerId) return roster[i];
    return null;
  }
  function rosterById(id) {
    for (let i = 0; i < roster.length; i++) if (roster[i].id === id) return roster[i];
    return null;
  }

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
    if (name !== 'controller') { releaseAll(); closeSettings(); }
    if (pauseCover) pauseCover.hidden = !paused || view !== 'controller';
    updateChrome();
  }

  // Footer + reactions are gated on the PHASE (views get reused), never just the view.
  function reactionsOpen() {
    if (kicked) return false;
    if (phase === 'LOBBY') return view === 'lobby';
    if (phase === 'FINAL') return view === 'final';
    return false;
  }
  function updateChrome() {
    if (playerAttribution) playerAttribution.hidden = !(phase === 'LOBBY' && view === 'lobby' && !kicked);
    if (reactionBar) reactionBar.hidden = !(reactionsOpen() && !reactionsMuted && hostPresent);
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
  socket.on('state:reactionsMuted', function (p) { reactionsMuted = !!(p && p.muted); updateChrome(); });
  function setPaused(on) {
    paused = !!on;
    if (pauseCover) pauseCover.hidden = !paused || view !== 'controller';
    if (paused) closeSettings();
  }

  // ---------------- Controls ----------------
  // Three input sources feed the same three buttons (left / right / jump):
  //   • touch ◀ ▶ buttons OR the floating joystick (picked via the ⚙️ gear,
  //     buttons by default), plus the JUMP button;
  //   • a paired Bluetooth / USB controller (Gamepad API).
  // Whatever is held across all of them is what the blob does. Button state is
  // sent on every change while a match is on; the host only acts on it while
  // play is live, so a direction held through the serve moves on the very
  // first tick.
  const held = { 0: false, 1: false, 2: false };
  const btnFor = { 0: btnLeft, 1: btnRight, 2: btnJump };
  const movePointers = new Map(); // pointerId -> LEFT | RIGHT (◀ ▶ buttons)
  const jumpPointers = new Set();
  const gp = { l: false, r: false, j: false };
  let stickDir = null;            // LEFT | RIGHT | null

  function canSend() { return phase === 'PLAYING' && view === 'controller'; }
  function send(code, down) {
    if (!canSend()) return;
    socket.emit('in', { c: code, d: down ? 1 : 0 });
  }
  function setHeld(code, on) {
    if (held[code] === on) return;
    held[code] = on;
    if (btnFor[code]) btnFor[code].classList.toggle('pressed', on);
    send(code, on);
  }
  function recompute() {
    let l = stickDir === LEFT || gp.l;
    let r = stickDir === RIGHT || gp.r;
    movePointers.forEach(function (dir) { if (dir === LEFT) l = true; else r = true; });
    setHeld(LEFT, l);
    setHeld(RIGHT, r);
    setHeld(JUMP, jumpPointers.size > 0 || gp.j);
  }
  function releaseAll() {
    movePointers.clear();
    jumpPointers.clear();
    gp.l = gp.r = gp.j = false;
    releaseStick();
    recompute();
  }
  // A fresh countdown / host refresh may have lost what we hold — push it again.
  function resendHeld() {
    [LEFT, RIGHT, JUMP].forEach(function (c) { if (held[c]) send(c, true); });
  }

  // ---- Control mode (⚙️) ----
  // Only an explicit pick is saved, so the default can change later without
  // every phone being stuck on whatever it first loaded with.
  const MODE_KEY = 'blobball.moveControls';
  let controlMode = 'buttons';
  try { if (localStorage.getItem(MODE_KEY) === 'stick') controlMode = 'stick'; } catch (_) {}

  // ---- ◀ ▶ buttons ----
  // ◀ ▶ share one zone: the side under the thumb decides the direction, so
  // rolling a thumb from ◀ to ▶ turns without lifting it.
  function dirAt(x) {
    const r = padMove.getBoundingClientRect();
    return x < r.left + r.width / 2 ? LEFT : RIGHT;
  }

  // ---- Joystick ----
  // The stick appears wherever the thumb lands on the left side; pushing it
  // past a small deadzone left or right moves the blob. Only the sideways
  // push matters — jumping stays on the JUMP button.
  const STICK_DEADZONE = 0.22;
  let stickId = null;
  let stickOX = 0, stickOY = 0, stickR = 60;
  function setKnob(px, py) {
    if (stickKnob) stickKnob.style.transform = 'translate(-50%, -50%) translate(' + px + 'px, ' + py + 'px)';
  }
  function setStickDir(dir) {
    if (stickDir === dir) return;
    stickDir = dir;
    if (stickArrowL) stickArrowL.classList.toggle('on', dir === LEFT);
    if (stickArrowR) stickArrowR.classList.toggle('on', dir === RIGHT);
    if (dir !== null) vibrate(6);
    recompute();
  }
  function updateStick(x, y) {
    let dx = x - stickOX, dy = y - stickOY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > stickR) { dx = dx / dist * stickR; dy = dy / dist * stickR; }
    setKnob(dx, dy);
    setStickDir(Math.abs(dx) < stickR * STICK_DEADZONE ? null : (dx < 0 ? LEFT : RIGHT));
  }
  function grabStick(e) {
    if (stickId !== null || !stickBase) return;
    stickId = e.pointerId;
    const zone = padMove.getBoundingClientRect();
    const half = stickBase.getBoundingClientRect().width / 2;
    stickR = half * 0.62;
    // Centre the stick under the thumb, kept fully inside the zone.
    const cx = Math.min(Math.max(e.clientX, zone.left + half), zone.right - half);
    const cy = Math.min(Math.max(e.clientY, zone.top + half), zone.bottom - half);
    stickBase.style.left = (cx - zone.left) + 'px';
    stickBase.style.top = (cy - zone.top) + 'px';
    stickBase.classList.add('active');
    stickOX = e.clientX;
    stickOY = e.clientY;
    updateStick(e.clientX, e.clientY);
  }
  function releaseStick() {
    stickId = null;
    if (stickBase) {
      stickBase.classList.remove('active');
      stickBase.style.left = '';
      stickBase.style.top = '';
    }
    setKnob(0, 0);
    setStickDir(null);
  }

  padMove.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    try { padMove.setPointerCapture(e.pointerId); } catch (_) {}
    if (controlMode === 'stick') { grabStick(e); return; }
    movePointers.set(e.pointerId, dirAt(e.clientX));
    vibrate(6);
    recompute();
  });
  padMove.addEventListener('pointermove', function (e) {
    if (controlMode === 'stick') {
      if (e.pointerId === stickId) updateStick(e.clientX, e.clientY);
      return;
    }
    if (!movePointers.has(e.pointerId)) return;
    const d = dirAt(e.clientX);
    if (movePointers.get(e.pointerId) !== d) { movePointers.set(e.pointerId, d); recompute(); }
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
    padMove.addEventListener(t, function (e) {
      if (e.pointerId === stickId) { releaseStick(); return; }
      if (!movePointers.has(e.pointerId)) return;
      movePointers.delete(e.pointerId);
      recompute();
    });
  });
  btnJump.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    try { btnJump.setPointerCapture(e.pointerId); } catch (_) {}
    jumpPointers.add(e.pointerId);
    vibrate(12);
    recompute();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
    btnJump.addEventListener(t, function (e) {
      if (!jumpPointers.has(e.pointerId)) return;
      jumpPointers.delete(e.pointerId);
      recompute();
    });
  });
  // The finger-lift never arrives once the tab is hidden: let go of everything.
  document.addEventListener('visibilitychange', function () { if (document.hidden) releaseAll(); });
  window.addEventListener('blur', releaseAll);

  // ---- ⚙️ gear + popover ----
  function closeSettings() {
    if (!ctrlPopover || ctrlPopover.hidden) return;
    ctrlPopover.hidden = true;
    if (gearBtn) gearBtn.setAttribute('aria-expanded', 'false');
  }
  function applyControlMode(m, save) {
    controlMode = m === 'stick' ? 'stick' : 'buttons';
    if (save) { try { localStorage.setItem(MODE_KEY, controlMode); } catch (_) {} }
    body.classList.toggle('mode-stick', controlMode === 'stick');
    body.classList.toggle('mode-buttons', controlMode === 'buttons');
    if (modeToggle) {
      modeToggle.querySelectorAll('.mode-opt').forEach(function (b) {
        const on = b.getAttribute('data-mode') === controlMode;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    movePointers.clear();
    releaseStick();
    recompute();
  }
  applyControlMode(controlMode);
  if (gearBtn && ctrlPopover) {
    // Taps on the gear / popover must never move the blob or close it again.
    gearBtn.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      e.preventDefault();
      const open = ctrlPopover.hidden;
      ctrlPopover.hidden = !open;
      gearBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    ctrlPopover.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
  }
  if (modeToggle) {
    modeToggle.addEventListener('pointerdown', function (e) {
      const btn = e.target.closest('.mode-opt');
      if (!btn) return;
      e.preventDefault();
      applyControlMode(btn.getAttribute('data-mode'), true);
    });
  }
  // A tap anywhere else closes it (the tap still counts as normal input).
  document.addEventListener('pointerdown', closeSettings);

  // ---- Bluetooth / USB controller (Gamepad API) ----
  // Read the standard Gamepad API and feed the same held buttons the touch
  // controls use — no server/engine changes. Move = left stick X or D-pad
  // left/right; jump = A, B, X, Y or D-pad up. Raw indices are read, so pads
  // the browser doesn't map to the "standard" layout still work.
  const GP_DEADZONE = 0.35;
  let gpIndex = null;
  function mapGamepad(pad) {
    const out = { l: false, r: false, j: false };
    if (!pad) return out;
    const b = pad.buttons || [];
    const a = pad.axes || [];
    const down = function (i) { const btn = b[i]; return !!(btn && (btn.pressed || btn.value > 0.5)); };
    const ax = a.length > 0 ? (a[0] || 0) : 0;
    out.l = ax < -GP_DEADZONE || down(14);
    out.r = ax > GP_DEADZONE || down(15);
    out.j = down(0) || down(1) || down(2) || down(3) || down(12);
    return out;
  }
  function gamepads() {
    try { return navigator.getGamepads ? navigator.getGamepads() : []; } catch (_) { return []; }
  }
  function activeGamepad() {
    const pads = gamepads();
    if (gpIndex != null && pads[gpIndex]) return pads[gpIndex];
    for (let i = 0; i < pads.length; i++) if (pads[i]) { gpIndex = i; return pads[i]; }
    return null;
  }
  function setGamepadConnected(on) {
    body.classList.toggle('has-gamepad', !!on);
  }
  function pollGamepad() {
    requestAnimationFrame(pollGamepad);
    const pad = activeGamepad();
    // Only steer from the controller screen; anywhere else everything is up.
    const m = (pad && view === 'controller' && !paused) ? mapGamepad(pad) : { l: false, r: false, j: false };
    if (m.l === gp.l && m.r === gp.r && m.j === gp.j) return;
    gp.l = m.l; gp.r = m.r; gp.j = m.j;
    recompute();
  }
  window.addEventListener('gamepadconnected', function (e) {
    gpIndex = e.gamepad.index;
    setGamepadConnected(true);
  });
  window.addEventListener('gamepaddisconnected', function (e) {
    if (gpIndex === e.gamepad.index) gpIndex = null;
    const any = gamepads();
    let still = false;
    for (let i = 0; i < any.length; i++) if (any[i]) still = true;
    setGamepadConnected(still);
  });
  // A controller paired before load won't fire 'gamepadconnected' until its
  // first input, so reflect the current state on boot too.
  if (activeGamepad()) setGamepadConnected(true);
  if ('getGamepads' in navigator) requestAnimationFrame(pollGamepad);

  // ---------------- Match state ----------------
  function renderStatus() {
    if (!hudStatus) return;
    hudStatus.innerHTML = '';
    const opp = opponent();
    const a = document.createElement('span');
    a.className = 'mine';
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
  }

  function setOverlay(noteParts, count) {
    if (!ctrlOverlay) return;
    if (!noteParts && !count) { ctrlOverlay.hidden = true; return; }
    setRich(coNote, noteParts || []);
    coNote.hidden = !noteParts;
    coCount.textContent = count || '';
    ctrlOverlay.hidden = false;
  }

  function applyMatch(m) {
    if (!m) return;
    roster = m.roster || roster;
    target = m.target || target;
    scores = Object.assign({}, m.scores || {});
    const mine = me();
    if (mine) {
      setSeatColor(mine.color);
      body.classList.toggle('seat-right', mine.seat === 1);
      if (hudSide) hudSide.textContent = mine.colorName + ' · ' + mine.side + ' · first to ' + target;
    }
    renderStatus();
  }

  socket.on('m:start', function (m) {
    phase = 'PLAYING';
    applyMatch(m);
    setPaused(false);
    setOverlay(['Get ready'], '');
    showView('controller');
    vibrate(30);
  });

  socket.on('m:countdown', function (d) {
    resendHeld();
    const note = d && d.note ? [d.note === 'RESUMING' ? 'Resuming' : 'Get ready'] : null;
    setOverlay(note, (d && d.n > 0) ? String(d.n) : 'GO!');
  });
  socket.on('m:serve', function (d) {
    resendHeld();
    const server = rosterById(d && d.serverId);
    if (!server) setOverlay(['Serve!'], '');
    else if (server.id === playerId) setOverlay(['Your serve!'], '');
    else setOverlay([nameSpan(server), ' serves'], '');
  });
  socket.on('m:play', function () { setOverlay(null, ''); resendHeld(); vibrate(15); });
  socket.on('m:sync', function (d) {
    if (!d || phase !== 'PLAYING') return;
    if (d.scores) { scores = Object.assign({}, d.scores); renderStatus(); }
    if (typeof d.paused === 'boolean') setPaused(d.paused);
    if (d.live && !paused && ctrlOverlay && !ctrlOverlay.hidden) setOverlay(null, '');
  });
  socket.on('m:point', function (d) {
    if (!d) return;
    if (d.scores) scores = Object.assign({}, d.scores);
    renderStatus();
    const scorer = rosterById(d.scorerId);
    if (d.scorerId === playerId) { setOverlay(['You scored! 🎉'], ''); vibrate([30, 50, 30]); }
    else if (scorer) { setOverlay([nameSpan(scorer), ' scores'], ''); vibrate(90); }
  });
  socket.on('m:pause', function () { setPaused(true); });
  socket.on('m:resume', function (d) { setPaused(false); if (d && d.live) setOverlay(null, ''); });

  function renderFinal(winnerId, finalScores) {
    if (finalScores) scores = Object.assign({}, finalScores);
    const won = winnerId === playerId;
    const winner = rosterById(winnerId);
    if (finalEmoji) finalEmoji.textContent = won ? '🏆' : '🏐';
    if (won) setRich(finalTitle, ['You win!']);
    else if (winner) setRich(finalTitle, [nameSpan(winner), ' wins!']);
    else setRich(finalTitle, ['Game over']);
    const opp = opponent();
    const mineScore = scores[playerId] || 0;
    const oppScore = opp ? (scores[opp.id] || 0) : 0;
    if (finalSub) finalSub.textContent = (won ? 'You won ' : 'You lost ') + mineScore + ' – ' + oppScore;
  }

  socket.on('m:end', function (d) {
    phase = 'FINAL';
    setPaused(false);
    setOverlay(null, '');
    renderFinal(d && d.winnerId, d && d.scores);
    showView('final');
    vibrate(d && d.winnerId === playerId ? [40, 80, 40] : 120);
  });

  function applyLobby(l) {
    if (!l || l.phase !== 'LOBBY') return;
    const mine = (l.players || []).filter(function (p) { return p.id === playerId; })[0];
    if (!mine) return;
    phase = 'LOBBY';
    setSeatColor(mine.color);
    body.classList.toggle('seat-right', mine.seat === 1);
    if (lobbySeat) lobbySeat.textContent = mine.colorName + ' blob · ' + mine.side;
    showView('lobby');
  }
  socket.on('state:lobby', applyLobby);

  socket.on('state:reset', function () {
    releaseAll();
    setPaused(false);
    localStorage.removeItem('blobball.playerId');
    localStorage.setItem('blobball.rejoinName', playerName);
    window.location.replace('/blobball/join');
  });

  socket.on('player:rejected', function () {
    releaseAll();
    kicked = true;
    localStorage.removeItem('blobball.playerId');
    showView('kicked');
  });

  kickRejoinBtn && kickRejoinBtn.addEventListener('click', function () {
    localStorage.setItem('blobball.rejoinName', playerName);
    window.location.replace('/blobball/join');
  });

  // ---------------- Reactions ----------------
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

  // ---------------- Boot / reconnect ----------------
  // A dropped phone is never a forfeit: if the server can't place us we keep
  // retrying behind a "Reconnecting" cover instead of throwing the player back
  // to the join page, which would lock them out for the rest of the match.
  let reconnectTries = 0;
  function setReconnecting(on) { if (reconnectOverlay) reconnectOverlay.hidden = !on; }

  function backToJoin() {
    localStorage.setItem('blobball.rejoinName', playerName);
    localStorage.removeItem('blobball.playerId');
    window.location.replace('/blobball/join');
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
      reactionsMuted = !!res.reactionsMuted;
      setHostPresent(res.hostPresent !== false);
      if (res.phase === 'PLAYING' && res.match) {
        phase = 'PLAYING';
        applyMatch(res.match);
        // Clear any stale overlay text; the heartbeat repaints within moments.
        setOverlay(res.match.live && !res.match.paused ? null : ['Get ready…'], '');
        showView('controller');
        setPaused(!!res.match.paused);
      } else if (res.phase === 'FINAL' && res.match) {
        phase = 'FINAL';
        applyMatch(res.match);
        renderFinal(res.match.winnerId, res.match.scores);
        showView('final');
      } else {
        phase = 'LOBBY';
        applyLobby(res.lobby);
        showView('lobby');
      }
    });
  }

  socket.on('connect', function () { attemptReconnect(); });
  socket.on('disconnect', function () { setReconnecting(true); releaseAll(); });

  showView('lobby');
  // Resume countdown from the host: the pause cover shows the 3-2-1.
  (function () {
    const cover = document.getElementById('pauseCover');
    if (!cover) return;
    const title = cover.querySelector('.pc-title');
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
})();
