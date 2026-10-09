(function () {
  'use strict';

  const socket = io('/snakeparty', { transports: ['polling', 'websocket'] });

  // ---------------- Tunables ----------------
  const COUNTDOWN_FROM = 3;
  const COUNTDOWN_STEP_MS = 800;
  const CLOCK_EMIT_MS = 250;
  const ROUNDOVER_MS = 6500;
  const SLOWMO_SCALE = 0.4;          // sim/animation speed once the round is decided
  const DECIDED_HOLD_SEC = 3.0;      // frozen beat (with the result banner) before the round card…
  const DECIDED_MAX_SEC = 4.5;       // …stretched (up to this) so a long death animation can finish
  const MAX_STEPS_PER_FRAME = 4;     // full moves; the loop runs SUB sub-ticks per move
  // Multiplayer power-ups: one on the board at a time, alternating Magnet / Phantom.
  const POWER_FIRST_SEC = [10, 14];  // first one appears this far into the round (random in range)
  const POWER_EVERY_SEC = [12, 15];  // then this long after the last one is picked up
  const MAGNET_SEC = 6;
  const PHANTOM_SEC = 6;
  const PHANTOM_GRACE_SEC = 2;       // max extra ghost time to get the head clear when Phantom ends
  const POWER_WARN_SEC = 1.5;        // blink for the last moments of an effect
  // Seconds per cell. Multiplayer ramps from START to END over the round length;
  // solo speeds up with every apple eaten.
  const START_INTERVAL = 0.15;
  const END_INTERVAL = 0.075;
  const SOLO_MIN_INTERVAL = 0.07;
  const SOLO_PER_APPLE = 0.0025;
  const WAIT_LIMIT_SEC = 10;         // a snake whose player hasn't steered yet starts on its own after this
  const FINAL_BEEP_FROM = 5;         // beep on each of the last five seconds (as in Nockey)
  const REACTION_EMOJIS = ['😂', '🔥', '🎉', '😱', '😭', '😡'];
  const REACTION_MAX = 30;

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    match: document.getElementById('view-match'),
    final: document.getElementById('view-final'),
  };
  function show(name) {
    if (name !== 'final') {
      if (window.clearConfetti) window.clearConfetti();
      if (window.stopApplause) window.stopApplause();
    }
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('active', k === name); });
  }

  const qrSlot = document.getElementById('qrSlot');
  const joinUrlEl = document.getElementById('joinUrl');
  const playerCountEl = document.getElementById('playerCount');
  const playerCapEl = document.getElementById('playerCap');
  const addBotBtn = document.getElementById('addBotBtn');
  const configBlock = document.getElementById('configBlock');
  const powerSeg = document.getElementById('powerSeg');
  const roundsRange = document.getElementById('roundsRange');
  const roundsVal = document.getElementById('roundsVal');
  const durRange = document.getElementById('durRange');
  const durVal = document.getElementById('durVal');
  const slotList = document.getElementById('slotList');
  const configHint = document.getElementById('configHint');
  const startBtn = document.getElementById('startBtn');

  const canvas = document.getElementById('board');
  const scoreStrip = document.getElementById('scoreStrip');
  const sbRound = document.getElementById('sbRound');
  const sbClock = document.getElementById('sbClock');
  const sbMap = document.getElementById('sbMap');
  const countOverlay = document.getElementById('countOverlay');
  const coNum = document.getElementById('coNum');
  const coNote = document.getElementById('coNote');
  const reasonOverlay = document.getElementById('reasonOverlay');
  const reasonText = document.getElementById('reasonText');
  const roundOverlay = document.getElementById('roundOverlay');
  const roTitle = document.getElementById('roTitle');
  const roList = document.getElementById('roList');
  const roNext = document.getElementById('roNext');

  const finalTrophy = document.getElementById('finalTrophy');
  const finalHeading = document.getElementById('finalHeading');
  const finalScroll = document.getElementById('finalScroll');
  const finalList = document.getElementById('finalList');
  const finalAwardsEl = document.getElementById('finalAwards');
  const finalAwardsSection = document.getElementById('finalAwardsSection');
  const soloResult = document.getElementById('soloResult');
  const soloScoreEl = document.getElementById('soloScore');
  const soloUnitEl = document.getElementById('soloUnit');
  const soloBestEl = document.getElementById('soloBest');
  const playAgainBtn = document.getElementById('playAgainBtn');
  const backToLobbyBtn = document.getElementById('backToLobbyBtn');

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const resetBtn = document.getElementById('resetBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const pauseOverlay = document.getElementById('pauseOverlay');
  const muteBtn = document.getElementById('muteReactionsBtn');
  const reactionLayer = document.getElementById('reactionLayer');

  // ---------------- Modal helpers ----------------
  function showInlineConfirm(message, onYes, opts) {
    if (typeof window.showConfirm !== 'function') { if (window.confirm(message)) onYes && onYes(); return; }
    const okLabel = (opts && opts.okLabel) || 'Yes';
    window.showConfirm(message, okLabel, opts || {}).then(function (ok) { if (ok) onYes && onYes(); });
  }
  function toast(message) {
    if (typeof window.showToast === 'function') window.showToast(message);
  }

  // ---------------- Wake Lock ----------------
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', function () { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wakeLock === null) acquireWakeLock();
  });
  acquireWakeLock();
  document.addEventListener('click', function once() {
    document.removeEventListener('click', once);
    if (wakeLock === null) acquireWakeLock();
  });

  // ---------------- Fullscreen / reset / hub ----------------
  fullscreenBtn && fullscreenBtn.addEventListener('click', function () {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(function () {});
    else document.exitFullscreen();
  });
  document.addEventListener('fullscreenchange', function () {
    if (fullscreenBtn) fullscreenBtn.textContent = document.fullscreenElement ? '⛶ Exit' : '⛶ Fullscreen';
  });
  resetBtn && resetBtn.addEventListener('click', function () {
    showInlineConfirm('Reset the entire game? All players will be kicked.', function () {
      socket.emit('host:reset', {});
    }, { okLabel: 'Reset', danger: true });
  });
  const hubBtn = document.getElementById('hubBtn');
  if (hubBtn) {
    hubBtn.addEventListener('click', function (e) {
      e.preventDefault();
      const origin = { clientX: e.clientX, clientY: e.clientY, currentTarget: hubBtn };
      showInlineConfirm('Leaving will reset the game and kick all players. Go back to the hub?', function () {
        let navigated = false;
        const go = function () {
          if (navigated) return; navigated = true;
          if (window.Iris && typeof window.Iris.transitionTo === 'function') window.Iris.transitionTo('/', origin, window.Iris.HUB);
          else window.location.href = '/';
        };
        socket.emit('host:leave', {}, go);
        setTimeout(go, 600);
      }, { okLabel: 'Leave & Reset', danger: true });
    });
  }

  // ---------------- Audio ----------------
  let audioCtx = null;
  function getAudioCtx() { if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} } return audioCtx; }
  function unlockAudio() { const c = getAudioCtx(); if (c && c.state === 'suspended') c.resume(); }
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  // Round-end banner impact: a low thump under a short noise hit.
  function playSlam(kind) {
    const c = getAudioCtx(); if (!c) return; const t = c.currentTime;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(kind === 'down' ? 120 : 150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.3);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.45, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.37);
    try {
      const len = Math.floor(c.sampleRate * 0.18);
      const buf = c.createBuffer(1, len, c.sampleRate); const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      const src = c.createBufferSource(); src.buffer = buf;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      const ng = c.createGain(); ng.gain.value = 0.35;
      src.connect(lp); lp.connect(ng); ng.connect(c.destination); src.start(t); src.stop(t + 0.19);
    } catch (_) {}
    if (kind === 'win') [784, 1047, 1319].forEach(function (f, i) { blip(f, 0.18, 'triangle', 0.1, t + 0.08 + i * 0.06); });
  }
  function blip(freq, dur, type, gain, when) {
    const c = getAudioCtx(); if (!c) return;
    const t = when || c.currentTime;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.2, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function playJoinDing() {
    const c = getAudioCtx(); if (!c || c.state === 'suspended') return;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, c.currentTime);
    o.frequency.setValueAtTime(1174.66, c.currentTime + 0.08);
    g.gain.setValueAtTime(0.3, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.4);
    o.connect(g); g.connect(c.destination);
    o.start(c.currentTime); o.stop(c.currentTime + 0.4);
  }
  // Runs-out-of-time ticks. One flat pitch, set above the rising start count
  // so the two countdowns never sound alike from across the room.
  function playFinalTick() { blip(860, 0.12, 'square', 0.16); }
  function beep(n) { blip(440 + (COUNTDOWN_FROM - n) * 120, 0.12, 'square', 0.14); }
  function playGo() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime; blip(880, 0.1, 'square', 0.14, b); blip(1320, 0.22, 'square', 0.14, b + 0.08); }
  function playLookUp() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime;[523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.16, 'triangle', 0.16, b + i * 0.09); }); }
  let lastEatSound = 0;
  function playEat(kind, len) {
    const c = getAudioCtx(); if (!c) return;
    const now = c.currentTime; if (now - lastEatSound < 0.05) return; lastEatSound = now;
    if (kind === 'apple') {
      const f = 520 + Math.min(len || 0, 60) * 8;
      blip(f, 0.07, 'square', 0.1, now);
      blip(f * 1.5, 0.09, 'square', 0.09, now + 0.06);
    } else {
      // Special apple: a bright rising sparkle, clearly bigger than a normal bite.
      [784, 988, 1175, 1568].forEach(function (f, i) { blip(f, 0.12, 'triangle', 0.13, now + i * 0.06); });
    }
  }
  function playCrash() {
    const c = getAudioCtx(); if (!c) return;
    const t = c.currentTime;
    try {
      const len = Math.floor(c.sampleRate * 0.35);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      const src = c.createBufferSource(); src.buffer = buf;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1800, t); lp.frequency.exponentialRampToValueAtTime(200, t + 0.35);
      const g = c.createGain(); g.gain.setValueAtTime(0.5, t);
      src.connect(lp); lp.connect(g); g.connect(c.destination);
      src.start(t); src.stop(t + 0.36);
    } catch (_) {}
    [400, 300, 200, 120].forEach(function (f, i) { blip(f, 0.12, 'sawtooth', 0.1, t + 0.05 + i * 0.07); });
  }
  function playPowerSpawn() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime;[784, 988, 1175].forEach(function (f, i) { blip(f, 0.12, 'triangle', 0.12, b + i * 0.07); }); }
  function playMagnet() {
    const c = getAudioCtx(); if (!c) return; const t = c.currentTime;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = 'square'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(880, t + 0.35);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.14, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.42);
  }
  function playPhantom() {
    const c = getAudioCtx(); if (!c) return; const t = c.currentTime;
    try {
      const len = Math.floor(c.sampleRate * 0.5);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * i / len);
      const src = c.createBufferSource(); src.buffer = buf;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2;
      bp.frequency.setValueAtTime(400, t); bp.frequency.exponentialRampToValueAtTime(2400, t + 0.45);
      const g = c.createGain(); g.gain.setValueAtTime(0.5, t);
      src.connect(bp); bp.connect(g); g.connect(c.destination);
      src.start(t); src.stop(t + 0.5);
    } catch (_) {}
    blip(660, 0.25, 'sine', 0.08, t + 0.1);
  }
  function playRoundWin() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime;[523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.24, 'sawtooth', 0.14, b + i * 0.08); }); }
  function playSad() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime;[392, 370, 349, 294].forEach(function (f, i) { blip(f, i === 3 ? 0.7 : 0.3, 'triangle', 0.18, b + i * 0.26); }); }
  function playGameWin() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [523, 659, 784, 1047, 1319, 1568].forEach(function (f, i) { blip(f, 0.3, 'sawtooth', 0.15, b + i * 0.1); });
    playApplause();
  }
  // The real crowd applause shipped with Trivia (shared asset, not a synth).
  const sfxApplause = new Audio('/trivia/assets/sounds/applause.mp3');
  sfxApplause.preload = 'auto';
  function playApplause() {
    // Registered at play time: the shared helper (topbar.js) loads after this file.
    if (window.trackApplause) window.trackApplause(sfxApplause);
    try { sfxApplause.currentTime = 0; sfxApplause.play().catch(function () {}); } catch (_) {}
  }

  // ---------------- Helpers ----------------
  function fmtClock(ms) { const t = Math.max(0, Math.ceil(ms / 1000)); const m = Math.floor(t / 60), s = t % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function fmtElapsed(sec) { const t = Math.max(0, Math.floor(sec)); const m = Math.floor(t / 60), s = t % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function nameOf(id) { const r = roster.find(function (x) { return x.id === id; }); return r ? r.name : '?'; }
  function colorOf(id) { const r = roster.find(function (x) { return x.id === id; }); return r ? r.color : '#fff'; }
  /** A player's name as its own coloured span (never innerHTML — names are user input). */
  function nameSpan(id, name, color) {
    const s = document.createElement('span');
    s.className = 'pname';
    s.textContent = name != null ? name : nameOf(id);
    s.style.color = color || colorOf(id);
    return s;
  }
  function setRich(el, parts) {
    el.textContent = '';
    parts.forEach(function (p) { el.appendChild(typeof p === 'string' ? document.createTextNode(p) : p); });
  }
  function joinNames(ids) {
    const parts = [];
    ids.forEach(function (id, i) { if (i) parts.push(' & '); parts.push(nameSpan(id)); });
    return parts;
  }

  // ---------------- Lobby ----------------
  let lobby = { players: [], total: 0, capacity: 4, mode: 'multi', canStart: false };
  let lastHumanTotal = -1;
  let dragActive = false;
  let pendingLobby = null;

  function renderQR() {
    fetch('/api/snakeparty/config').then(function (r) { return r.json(); }).then(function (cfg) {
      const url = (cfg && cfg.joinUrl) || (window.location.origin + '/snakeparty/join');
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      return fetch('/api/snakeparty/qr?url=' + encodeURIComponent(url));
    }).then(function (r) { return r.text(); }).then(function (svg) { qrSlot.innerHTML = svg; }).catch(function () {});
  }

  function renderLobby(l) {
    if (!l) return;
    if (dragActive) { pendingLobby = l; return; }
    lobby = l;
    const humanTotal = l.players.filter(function (p) { return !p.isBot; }).length;
    if (lastHumanTotal >= 0 && humanTotal > lastHumanTotal) playJoinDing();
    lastHumanTotal = humanTotal;
    playerCountEl.textContent = l.total;
    playerCapEl.textContent = l.capacity;
    // Don't yank a slider back while its own debounced change is still in flight.
    if (!roundsTimer) { roundsRange.value = l.roundsToWin; roundsVal.textContent = l.roundsToWin; }
    if (!durTimer) { durRange.value = l.roundLengthSec; durVal.textContent = fmtElapsed(l.roundLengthSec); }
    setSeg(powerSeg, l.powerups !== false);

    const solo = l.total > 0 && l.mode === 'solo';
    if (configBlock) configBlock.hidden = solo;

    slotList.innerHTML = '';
    l.players.forEach(function (p) {
      const el = document.createElement('div');
      el.className = 'player-chip' + (p.connected === false ? ' disconnected' : '') + (p.isBot ? ' is-bot' : '');
      el.dataset.pid = p.id;
      const grip = document.createElement('span'); grip.className = 'chip-grip'; grip.textContent = '⠿';
      const dot = document.createElement('span'); dot.className = 'chip-dot'; dot.style.background = p.color;
      const label = document.createElement('span'); label.className = 'chip-name'; label.textContent = p.name;
      const kick = document.createElement('button'); kick.className = 'chip-kick'; kick.type = 'button'; kick.textContent = '✕';
      kick.title = p.isBot ? 'Remove CPU' : 'Remove player';
      kick.addEventListener('click', function (e) { e.stopPropagation(); socket.emit('host:kick', { playerId: p.id }); });
      el.appendChild(grip); el.appendChild(dot); el.appendChild(label); el.appendChild(kick);
      slotList.appendChild(el);
    });
    for (let i = l.players.length; i < l.capacity; i++) {
      const e = document.createElement('div'); e.className = 'slot-empty'; e.textContent = 'Open spot'; slotList.appendChild(e);
    }
    startBtn.disabled = !l.canStart;
    startBtn.textContent = solo ? 'Start solo!' : 'Start!';
    if (addBotBtn) addBotBtn.disabled = l.total >= l.capacity;
    configHint.textContent = l.canStart ? '' : 'Waiting for a player to join…';
  }

  // ---- Smooth pointer-drag to reorder the lobby (order = seat/colour/spawn) --
  (function setupLobbyDrag() {
    let reduceMotion = false;
    try { reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    let d = null;

    function chips() {
      return Array.prototype.slice.call(slotList.querySelectorAll('.player-chip'))
        .filter(function (c) { return !d || c !== d.el; });
    }
    function measure() { return chips().map(function (c) { return [c, c.getBoundingClientRect().top]; }); }
    function flip(prev) {
      if (reduceMotion || !prev) return;
      const moved = [];
      prev.forEach(function (rec) {
        const c = rec[0]; if (!c.isConnected) return;
        const delta = rec[1] - c.getBoundingClientRect().top;
        if (delta) { c.style.transition = 'none'; c.style.transform = 'translateY(' + delta + 'px)'; moved.push(c); }
      });
      if (!moved.length) return;
      document.body.getBoundingClientRect();
      moved.forEach(function (c) { c.style.transition = 'transform 0.2s cubic-bezier(0.2,0.7,0.2,1)'; c.style.transform = ''; });
    }
    function positionPlaceholder(y) {
      const cs = chips();
      let before = null;
      for (let i = 0; i < cs.length; i++) { const r = cs[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { before = cs[i]; break; } }
      if (!before) before = slotList.querySelector('.slot-empty');
      if (d.ph.nextElementSibling === before) return;
      const prev = measure();
      slotList.insertBefore(d.ph, before);
      flip(prev);
    }
    function beginLift() {
      d.active = true; dragActive = true;
      const r = d.el.getBoundingClientRect();
      d.offX = d.downX - r.left; d.offY = d.downY - r.top;
      d.ph = document.createElement('div'); d.ph.className = 'chip-placeholder'; d.ph.style.height = r.height + 'px';
      d.el.parentNode.insertBefore(d.ph, d.el);
      d.el.style.position = 'fixed'; d.el.style.left = '0'; d.el.style.top = '0'; d.el.style.width = r.width + 'px';
      d.el.style.margin = '0'; d.el.style.zIndex = '50'; d.el.style.pointerEvents = 'none'; d.el.style.transition = 'none';
      d.el.classList.add('dragging');
    }
    function onMove(e) {
      if (!d) return;
      if (e.cancelable) e.preventDefault();
      const x = e.clientX, y = e.clientY;
      if (!d.active) { if (Math.abs(x - d.downX) < 5 && Math.abs(y - d.downY) < 5) return; beginLift(); }
      d.el.style.transform = 'translate(' + (x - d.offX) + 'px,' + (y - d.offY) + 'px) scale(1.03)';
      positionPlaceholder(y);
    }
    function onUp() {
      if (!d) return;
      const cur = d; d = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!cur.active) return;
      let next = cur.ph.nextElementSibling;
      while (next && !next.classList.contains('player-chip')) next = next.nextElementSibling;
      const beforeId = next ? next.dataset.pid : null;
      const el = cur.el;
      const floatRect = el.getBoundingClientRect();
      cur.ph.parentNode.insertBefore(el, cur.ph); cur.ph.remove();
      el.style.position = ''; el.style.left = ''; el.style.top = ''; el.style.width = ''; el.style.margin = ''; el.style.zIndex = ''; el.style.pointerEvents = '';
      let cleaned = false;
      const done = function () { if (cleaned) return; cleaned = true; el.classList.remove('dragging'); el.style.transition = ''; el.style.transform = ''; el.removeEventListener('transitionend', done); };
      if (reduceMotion) { done(); }
      else {
        const dest = el.getBoundingClientRect();
        el.style.transition = 'none';
        el.style.transform = 'translate(' + (floatRect.left - dest.left) + 'px,' + (floatRect.top - dest.top) + 'px) scale(1.03)';
        document.body.getBoundingClientRect();
        el.style.transition = 'transform 0.2s cubic-bezier(0.2,0.7,0.2,1)'; el.style.transform = '';
        el.addEventListener('transitionend', done);
        setTimeout(done, 260);
      }
      dragActive = false;
      if (pendingLobby) { const pl = pendingLobby; pendingLobby = null; renderLobby(pl); }
      socket.emit('host:reorder', { playerId: cur.pid, beforeId: beforeId }, function (res) {
        if (res && !res.ok) renderLobby(lobby);
      });
    }
    function onDown(e) {
      if (e.button != null && e.button !== 0) return;
      if (!e.target || e.target.closest('.chip-kick')) return;
      const el = e.target.closest('.player-chip');
      if (!el || d) return;
      d = { el: el, pid: el.dataset.pid, downX: e.clientX, downY: e.clientY, active: false, offX: 0, offY: 0, ph: null };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }
    slotList.addEventListener('pointerdown', onDown);
  })();

  addBotBtn && addBotBtn.addEventListener('click', function () {
    socket.emit('host:addBot', {}, function (res) { if (res && !res.ok) toast('Could not add a CPU.'); });
  });
  let roundsTimer = null;
  roundsRange.addEventListener('input', function () {
    const v = Number(roundsRange.value);
    roundsVal.textContent = v;
    if (roundsTimer) clearTimeout(roundsTimer);
    roundsTimer = setTimeout(function () {
      roundsTimer = null;
      socket.emit('host:setRoundsToWin', { roundsToWin: v });
    }, 120);
  });
  let durTimer = null;
  durRange.addEventListener('input', function () {
    const v = Number(durRange.value);
    durVal.textContent = fmtElapsed(v);
    if (durTimer) clearTimeout(durTimer);
    durTimer = setTimeout(function () {
      durTimer = null;
      socket.emit('host:setRoundLength', { roundLengthSec: v });
    }, 120);
  });

  function setSeg(seg, on) {
    if (!seg) return;
    seg.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('on', (b.dataset.value === 'on') === !!on); });
  }
  powerSeg && powerSeg.addEventListener('click', function (e) {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    const on = btn.dataset.value === 'on';
    setSeg(powerSeg, on);
    socket.emit('host:setPowerups', { on: on }, function (res) { if (res && res.ok) setSeg(powerSeg, res.powerups); });
  });

  startBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
      if (!res || !res.ok) { toast('Need at least 1 player to start.'); return; }
      startMatch(res.roster, res, null);
    });
  });
  playAgainBtn && playAgainBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:rematch', {}, function (res) {
      if (!res || !res.ok) { toast('Could not start a new game.'); return; }
      startMatch(res.roster, res, null);
    });
  });
  backToLobbyBtn && backToLobbyBtn.addEventListener('click', function () {
    socket.emit('host:reset', {});
  });

  // ---------------- Match state ----------------
  let world = null, renderer = null, rafId = null, lastFrame = 0, acc = 0;
  let matchState = 'idle'; // idle | countdown | play | decided | roundover | ended
  let mode = 'multi';
  let roster = [];
  let roundLengthSec = 90, roundsToWin = 3;
  let round = 1, mapIndex = 0, mapOrder = [];
  let clockMs = 0, elapsed = 0, lastClockEmit = 0;
  let soloSec = 0;          // solo clock: only runs once the snake is actually moving
  let powerupsOn = true;    // match setting (multiplayer only)
  let nextPowerAt = 0;      // play-time second the next power-up appears
  let nextPowerKind = 'magnet';
  let effects = {};         // id -> { magnetUntil, phantomUntil, graceUntil } in play-time seconds
  let lastTickSec = -1;     // last whole second announced, so a beep fires once
  let gamePoints = {};
  let decision = null;      // { winnerId, draw, reason } once the round is decided
  let decidedT = 0;         // real seconds spent in the decided slow-mo
  let countdownTimer = null, roundOverTimer = null;
  let botIds = [];
  let soloBest = null;
  const inputQueue = [];
  let stats = {};           // id -> { apples, maxLen, kills, survived, roundsWon }
  let fastestDeath = null;  // { id, sec, round }
  let finalAwards = null;

  // ---------------- Pause ----------------
  // The whole game runs on this browser, so pausing means: stop stepping the
  // world/clock in loop(), and freeze every wall-clock timer so the sequence
  // picks up exactly where it left off. Phones are covered via m:pause.
  let paused = false;
  const pausableTimers = new Set();
  function pTimeout(fn, ms) {
    const rec = { fn: fn, remaining: ms, startedAt: performance.now(), handle: null, repeat: false, interval: 0 };
    rec.handle = setTimeout(function () { pausableTimers.delete(rec); fn(); }, ms);
    pausableTimers.add(rec); return rec;
  }
  function pInterval(fn, ms) {
    const rec = { fn: fn, remaining: ms, startedAt: performance.now(), handle: null, repeat: true, interval: ms };
    rec.handle = setInterval(function () { rec.startedAt = performance.now(); rec.remaining = ms; fn(); }, ms);
    pausableTimers.add(rec); return rec;
  }
  function pClear(rec) { if (!rec) return; if (rec.repeat) clearInterval(rec.handle); else clearTimeout(rec.handle); pausableTimers.delete(rec); }
  function pClearAll() { pausableTimers.forEach(function (rec) { if (rec.repeat) clearInterval(rec.handle); else clearTimeout(rec.handle); }); pausableTimers.clear(); }
  function freezeTimers() {
    const now = performance.now();
    pausableTimers.forEach(function (rec) {
      rec.remaining = Math.max(0, rec.remaining - (now - rec.startedAt));
      if (rec.repeat) clearInterval(rec.handle); else clearTimeout(rec.handle);
      rec.handle = null;
    });
  }
  function thawTimers() {
    pausableTimers.forEach(function (rec) {
      rec.startedAt = performance.now();
      if (rec.repeat) {
        rec.handle = setTimeout(function () {
          rec.fn();
          if (!pausableTimers.has(rec)) return;
          rec.startedAt = performance.now(); rec.remaining = rec.interval;
          rec.handle = setInterval(function () { rec.startedAt = performance.now(); rec.remaining = rec.interval; rec.fn(); }, rec.interval);
        }, rec.remaining);
      } else {
        rec.handle = setTimeout(function () { pausableTimers.delete(rec); rec.fn(); }, rec.remaining);
      }
    });
  }
  function isOngoing() { return matchState === 'countdown' || matchState === 'play' || matchState === 'decided' || matchState === 'roundover'; }
  let resumeTimer = null;   // running resume 3-2-1, if any
  function updatePauseBtn() {
    if (!pauseBtn) return;
    pauseBtn.hidden = !isOngoing();
    pauseBtn.textContent = (paused && !resumeTimer) ? '▶ Resume' : '⏸ Pause';
  }
  function pauseMatch() {
    if (paused || !isOngoing()) return;
    clearResumeCount();
    paused = true;
    if (world) for (const p of world.players) world.clearInputs(p.id);
    inputQueue.length = 0;
    freezeTimers();
    if (pauseOverlay) pauseOverlay.hidden = false;
    updatePauseBtn();
    socket.emit('host:pause', {});
  }
  function resumeMatch() {
    if (!paused) return;
    paused = false;
    lastFrame = performance.now(); lastClockEmit = 0;
    thawTimers();
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    socket.emit('host:resume', { live: matchState === 'play' });
  }
  // ---- Resume countdown ----
  // Resuming into live play runs a 3-2-1 first. The game stays paused the whole
  // time (clock, movement and timers frozen), so the countdown never counts as
  // play time. Pressing Pause again cancels it; resuming anywhere else (pre-round
  // countdown, between points/rounds) is instant.
  const poTitle = pauseOverlay && pauseOverlay.querySelector('.po-title');
  const poSub = pauseOverlay && pauseOverlay.querySelector('.po-sub');
  const poTitleText = poTitle ? poTitle.textContent : '';
  const poSubText = poSub ? poSub.textContent : '';
  function showResumeCount(n) {
    if (!pauseOverlay) return;
    pauseOverlay.classList.add('resuming');
    if (poTitle) { poTitle.textContent = n; poTitle.style.animation = 'none'; void poTitle.offsetWidth; poTitle.style.animation = ''; }
    if (poSub) poSub.textContent = 'Get ready…';
  }
  function clearResumeCount() {
    if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
    if (pauseOverlay) pauseOverlay.classList.remove('resuming');
    if (poTitle) poTitle.textContent = poTitleText;
    if (poSub) poSub.textContent = poSubText;
  }
  function requestResume() {
    if (!paused || resumeTimer) return;
    if (!(matchState === 'play')) { resumeMatch(); return; }
    let n = COUNTDOWN_FROM;
    const tick = function () { showResumeCount(n); socket.emit('host:resumeCount', { n: n }); beep(n); };
    tick();
    resumeTimer = setInterval(function () {
      if (!paused) { clearResumeCount(); return; }
      n--;
      if (n >= 1) { tick(); return; }
      clearResumeCount();
      resumeMatch();
    }, COUNTDOWN_STEP_MS);
    updatePauseBtn();
  }
  function cancelResume() {
    clearResumeCount();
    socket.emit('host:resumeCount', { n: 0 });
    updatePauseBtn();
  }
  pauseBtn && pauseBtn.addEventListener('click', function () {
    if (!paused) pauseMatch();
    else if (resumeTimer) cancelResume();
    else requestResume();
  });

  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; }

  function startMatch(rost, cfg, initial) {
    roster = rost || [];
    mode = (cfg && cfg.mode) === 'solo' ? 'solo' : 'multi';
    roundLengthSec = (cfg && cfg.roundLengthSec) || 90;
    roundsToWin = (cfg && cfg.roundsToWin) || 3;
    soloBest = (cfg && cfg.soloBest) || null;
    powerupsOn = !(cfg && cfg.powerups === false);
    gamePoints = {};
    stats = {}; fastestDeath = null; finalAwards = null;
    roster.forEach(function (r) {
      gamePoints[r.id] = 0;
      stats[r.id] = { apples: 0, maxLen: 0, kills: 0, survived: 0, roundsWon: 0, powers: 0 };
    });
    botIds = roster.filter(function (r) { return r.isBot; }).map(function (r) { return r.id; });
    mapOrder = shuffle(Array.from({ length: window.SnakePartyMaps.count }, function (_, i) { return i; }));
    if (initial && initial.gamePoints) { for (const id in initial.gamePoints) if (id in gamePoints) gamePoints[id] = initial.gamePoints[id]; }
    round = (initial && initial.round) || 1;
    if (reactionLayer) reactionLayer.innerHTML = '';
    show('match');
    buildScoreStrip();
    startLoop();
    beginRound(round);
  }

  function beginRound(r) {
    round = r;
    mapIndex = mapOrder[(r - 1) % mapOrder.length];
    world = new window.SnakeParty.World({ maps: window.SnakePartyMaps });
    world.setRoster(roster);
    world.reset(mapIndex, { mode: mode });
    renderer = new window.SnakePartyRender.Renderer(canvas, world);
    renderer.showHeadings = true;
    clockMs = roundLengthSec * 1000;
    elapsed = 0; soloSec = 0; acc = 0;
    effects = {};
    nextPowerKind = Math.random() < 0.5 ? 'magnet' : 'phantom';
    nextPowerAt = randIn(POWER_FIRST_SEC);
    lastTickSec = -1;
    decision = null; decidedT = 0;
    inputQueue.length = 0;
    paused = false; pClearAll();
    countdownTimer = null; roundOverTimer = null;
    hideReason();
    if (pauseOverlay) pauseOverlay.hidden = true;
    if (roundOverlay) roundOverlay.hidden = true;
    if (sbMap) sbMap.textContent = world.board.name;
    updateScoreStrip();
    requestAnimationFrame(function () { if (renderer) renderer.resize(); });
    socket.emit('host:roundStart', { round: round, mapIndex: mapIndex, durationSec: roundLengthSec });
    playLookUp();
    beginCountdown();
  }

  function beginCountdown() {
    matchState = 'countdown';
    updatePauseBtn();
    if (countdownTimer) pClear(countdownTimer);
    let n = COUNTDOWN_FROM;
    function showN(v) {
      countOverlay.hidden = false;
      coNum.textContent = v;
      coNum.style.animation = 'none'; void coNum.offsetWidth; coNum.style.animation = '';
      if (coNote) coNote.textContent = mode === 'solo' ? 'Get ready!' : 'Round ' + round + ' · ' + world.board.name;
      socket.emit('host:countdown', { n: v });
      beep(v);
    }
    showN(n);
    countdownTimer = pInterval(function () {
      n--;
      if (n >= 1) showN(n);
      else { pClear(countdownTimer); countdownTimer = null; beginPlay(); }
    }, COUNTDOWN_STEP_MS);
  }

  function beginPlay() {
    countOverlay.hidden = true;
    matchState = 'play';
    updatePauseBtn();
    if (renderer) renderer.showHeadings = false;
    acc = 0; lastFrame = performance.now(); lastClockEmit = 0;
    socket.emit('host:play', {});
    playGo();
  }

  function startLoop() { if (rafId) cancelAnimationFrame(rafId); lastFrame = performance.now(); rafId = requestAnimationFrame(loop); }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  function stepInterval() {
    if (mode === 'solo') {
      const p = world && world.players[0];
      return Math.max(SOLO_MIN_INTERVAL, START_INTERVAL - (p ? p.apples : 0) * SOLO_PER_APPLE);
    }
    const k = Math.min(1, elapsed / Math.max(1, roundLengthSec));
    return START_INTERVAL + (END_INTERVAL - START_INTERVAL) * k;
  }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    let dt = (now - lastFrame) / 1000; lastFrame = now;
    if (dt > 0.1) dt = 0.1;
    if (paused) { if (renderer) renderer.render(0); return; }

    let simDt = dt;
    let alpha;
    if (matchState === 'play' && world) {
      // A brief hit-stop on a crash makes the death land harder.
      if (renderer && renderer.hitStop > 0) {
        renderer.hitStop = Math.max(0, renderer.hitStop - dt);
      } else {
        while (inputQueue.length) { const q = inputQueue.shift(); world.queueDir(q.id, q.dir); }
        acc += dt;
        if (mode === 'multi') {
          clockMs = Math.max(0, clockMs - dt * 1000);
          const secLeft = Math.ceil(clockMs / 1000);
          if (secLeft !== lastTickSec) {
            if (lastTickSec >= 0 && secLeft >= 1 && secLeft <= FINAL_BEEP_FROM) playFinalTick();
            lastTickSec = secLeft;
          }
        }
        elapsed += dt;
        if (elapsed >= WAIT_LIMIT_SEC && world.anyWaiting()) world.releaseWaiting();
        if (mode === 'solo' && !world.anyWaiting()) soloSec += dt;
        tickPowers();
        const SUB = window.SnakeParty.SUB;
        const subInt = stepInterval() / SUB;
        let steps = 0;
        while (matchState === 'play' && acc >= subInt && steps < MAX_STEPS_PER_FRAME * SUB && !(renderer && renderer.hitStop > 0)) {
          acc -= subInt;
          driveBots();
          handleEvents(world.substep());
          steps++;
          checkDecision();
        }
        if (steps >= MAX_STEPS_PER_FRAME * SUB) acc = Math.min(acc, subInt);
        if (matchState === 'play') {
          checkDecision();
          alpha = acc / subInt;
        }
        updateScoreStrip();
        if (now - lastClockEmit >= CLOCK_EMIT_MS) { lastClockEmit = now; emitClock(); }
      }
    } else if (matchState === 'decided') {
      // Time stops: snakes freeze, the clock holds, and the final crash plays
      // out in slow motion before the round card.
      simDt = dt * SLOWMO_SCALE;
      decidedT += dt;
      if (decidedT >= DECIDED_HOLD_SEC && (!(renderer && renderer.busy()) || decidedT >= DECIDED_MAX_SEC)) endRound();
    }

    if (renderer) renderer.render(simDt, alpha);
  }

  function emitClock() {
    if (!world) return;
    socket.emit('host:clock', { ms: mode === 'multi' ? Math.max(0, clockMs) : Math.round(soloSec * 1000), lengths: world.lengths() });
  }

  function driveBots() {
    if (!world || !botIds.length) return;
    for (const id of botIds) {
      const p = world.byId.get(id);
      if (p && world.willMove(p)) world.setBotDir(id, window.SnakePartyBot.think(world, p));
    }
  }

  function handleEvents(events) {
    if (!events || !events.length) return;
    let crashed = false;
    for (const ev of events) {
      if (renderer) renderer.onEvent(ev);
      if (ev.type === 'eat') {
        const p = world.byId.get(ev.id);
        playEat(ev.kind, p ? p.body.length : 0);
        if (stats[ev.id] && ev.kind === 'apple') stats[ev.id].apples++;
      } else if (ev.type === 'power') {
        grantPower(ev.id, ev.power);
      } else if (ev.type === 'death') {
        crashed = true;
        clearEffects(ev.id);
        socket.emit('host:eliminated', { id: ev.id, length: ev.length });
        if (stats[ev.id]) stats[ev.id].maxLen = Math.max(stats[ev.id].maxLen, ev.length);
        if (ev.cause === 'snake' && ev.killer && stats[ev.killer]) stats[ev.killer].kills++;
        if (mode === 'multi' && (!fastestDeath || elapsed < fastestDeath.sec)) fastestDeath = { id: ev.id, sec: elapsed, round: round };
      }
    }
    if (crashed) playCrash();
    for (const p of world.players) {
      if (p.alive && stats[p.id]) stats[p.id].maxLen = Math.max(stats[p.id].maxLen, p.body.length);
    }
  }

  function randIn(r) { return r[0] + Math.random() * (r[1] - r[0]); }

  // ---------------- Power-ups ----------------
  // Spawning and effect timers run on play time (elapsed), so pauses and the
  // resume countdown never eat into them.
  function tickPowers() {
    if (!world || mode !== 'multi') return;
    if (powerupsOn && elapsed >= nextPowerAt && world.powerCount() === 0) {
      if (world.spawnPower(nextPowerKind)) {
        nextPowerKind = nextPowerKind === 'magnet' ? 'phantom' : 'magnet';
        nextPowerAt = Infinity;               // rescheduled when it's picked up
        playPowerSpawn();
      } else nextPowerAt = elapsed + 1;       // board too crowded — try again shortly
    }
    for (const id in effects) {
      const e = effects[id], p = world.byId.get(id);
      if (!p || !p.alive) { delete effects[id]; continue; }
      if (e.magnetUntil && elapsed >= e.magnetUntil) {
        e.magnetUntil = 0; world.setMagnet(id, false);
        socket.emit('host:power', { id: id, power: 'magnet', sec: 0 });
      }
      if (e.phantomUntil && elapsed >= e.phantomUntil) {
        e.phantomUntil = 0; world.endPhantom(id);
        if (p.phantom) e.graceUntil = elapsed + PHANTOM_GRACE_SEC;
        socket.emit('host:power', { id: id, power: 'phantom', sec: 0 });
      }
      if (e.graceUntil && (!p.phantom || elapsed >= e.graceUntil)) {
        e.graceUntil = 0;
        if (p.phantom) world.forceSolid(id);
      }
      // What the renderer needs: seconds left (blink near the end).
      p.fxMagnetLeft = e.magnetUntil ? e.magnetUntil - elapsed : 0;
      p.fxPhantomLeft = e.phantomUntil ? e.phantomUntil - elapsed : (p.phantom ? 0.01 : 0);
      if (!e.magnetUntil && !e.phantomUntil && !e.graceUntil) delete effects[id];
    }
  }
  function grantPower(id, power) {
    const p = world && world.byId.get(id);
    if (!p || !p.alive) return;
    const e = effects[id] || (effects[id] = { magnetUntil: 0, phantomUntil: 0, graceUntil: 0 });
    if (power === 'magnet') {
      e.magnetUntil = elapsed + MAGNET_SEC;
      world.setMagnet(id, true);
      p.fxMagnetLeft = MAGNET_SEC;
      playMagnet();
      socket.emit('host:power', { id: id, power: 'magnet', sec: MAGNET_SEC });
    } else if (power === 'phantom') {
      e.phantomUntil = elapsed + PHANTOM_SEC;
      e.graceUntil = 0;
      world.startPhantom(id);
      p.fxPhantomLeft = PHANTOM_SEC;
      playPhantom();
      socket.emit('host:power', { id: id, power: 'phantom', sec: PHANTOM_SEC });
    }
    if (stats[id]) stats[id].powers++;
    nextPowerAt = elapsed + randIn(POWER_EVERY_SEC);
  }
  function clearEffects(id) {
    delete effects[id];
    const p = world && world.byId.get(id);
    if (p) { p.fxMagnetLeft = 0; p.fxPhantomLeft = 0; }
  }

  function checkDecision() {
    if (matchState !== 'play' || !world) return;
    if (mode === 'solo') {
      if (world.aliveCount() === 0) decide({ reason: 'crash' });
      return;
    }
    // The longest snake wins the round — crashed snakes keep the length they
    // crashed at, so dying early just stops you growing.
    const alive = world.alivePlayers();
    const lead = leaders();
    if (alive.length === 0) {
      decide(lead.length === 1 ? { winnerId: lead[0], reason: 'wipeout' } : { draw: true, reason: 'wipeout-tie' });
    } else if (clockMs <= 0) {
      decide(lead.length === 1 ? { winnerId: lead[0], reason: 'time' } : { draw: true, reason: 'time-tie' });
    } else if (alive.length === 1) {
      // A lone survivor can only grow and every crashed length is frozen, so
      // once it's strictly the longest the round is locked in.
      const s = alive[0];
      let maxDead = 0;
      for (const p of world.players) if (!p.alive) maxDead = Math.max(maxDead, p.finalLength);
      if (s.body.length > maxDead) decide({ winnerId: s.id, reason: 'clinch' });
    }
  }

  /** Id(s) currently on top: longest first, and a living snake beats a crashed one at equal length. */
  function leaders() {
    let ids = [], bestLen = -1, bestAlive = -1;
    if (!world) return ids;
    for (const p of world.players) {
      const L = world.lengthOf(p), A = p.alive ? 1 : 0;
      if (L > bestLen || (L === bestLen && A > bestAlive)) { bestLen = L; bestAlive = A; ids = [p.id]; }
      else if (L === bestLen && A === bestAlive) ids.push(p.id);
    }
    return ids;
  }

  function decide(d) {
    matchState = 'decided';
    decision = d;
    decidedT = 0;
    acc = 0;
    world.settle();
    inputQueue.length = 0;
    socket.emit('host:decided', {});
    emitClock();
    updateScoreStrip();
    showEndReason(d);
  }

  function showEndReason(d) {
    if (!reasonOverlay || !reasonText) return;
    // Short, name-free banners in the same voice as Maze Chomp; the round card
    // that follows says who won.
    const kind = d.reason === 'crash' ? 'over'
      : d.reason === 'clinch' ? 'win'
      : (d.reason === 'wipeout' || d.reason === 'wipeout-tie') ? 'down'
      : 'time';
    const text = kind === 'over' ? 'Game over!'
      : kind === 'win' ? 'Longest one standing!'
      : kind === 'down' ? "Everyone's down!"
      : "Time's up!";
    let spot = null, color = null;
    if (kind === 'win' && d.winnerId && world && renderer) {
      const p = world.byId.get(d.winnerId);
      if (p && p.body.length) {
        const m = renderer._metrics();
        spot = { x: m.ox + (p.body[0].x + 0.5) * m.ts, y: m.oy + (p.body[0].y + 0.5) * m.ts };
      }
      color = colorOf(d.winnerId);
    }
    if (window.EndBanner) {
      window.EndBanner.show({ overlay: reasonOverlay, board: canvas, clock: sbClock, text: text, kind: kind, color: color, spot: spot, sound: playSlam });
    } else {
      reasonText.textContent = text;
      reasonOverlay.hidden = false;
    }
  }

  function hideReason() {
    if (reasonOverlay) reasonOverlay.hidden = true;
    if (window.EndBanner) window.EndBanner.reset(reasonOverlay, canvas, sbClock);
  }

  function aliveMap() { const o = {}; if (world) for (const p of world.players) o[p.id] = p.alive; return o; }

  function endRound() {
    if (matchState !== 'decided') return;
    hideReason();
    if (mode === 'solo') { finishSolo(); return; }
    matchState = 'roundover';
    updatePauseBtn();
    const d = decision || { draw: true };
    if (d.winnerId) {
      gamePoints[d.winnerId] = (gamePoints[d.winnerId] || 0) + 1;
      if (stats[d.winnerId]) stats[d.winnerId].roundsWon++;
    }
    world.players.forEach(function (p) { if (p.alive && stats[p.id]) stats[p.id].survived++; });
    const lengths = world.lengths();
    const champs = roster.filter(function (r) { return (gamePoints[r.id] || 0) >= roundsToWin; }).map(function (r) { return r.id; });
    socket.emit('host:roundOver', {
      round: round, winnerId: d.winnerId || null, draw: !d.winnerId, reason: d.reason,
      lengths: lengths, gamePoints: gamePoints, alive: aliveMap(),
    });
    updateScoreStrip();
    renderRoundOverlay(d, lengths, champs.length > 0);
    if (d.winnerId) playRoundWin(); else playSad();

    if (roundOverTimer) pClear(roundOverTimer);
    roundOverTimer = pTimeout(function () {
      roundOverTimer = null;
      roundOverlay.hidden = true;
      if (champs.length) endMatch(champs);
      else beginRound(round + 1);
    }, ROUNDOVER_MS);
  }

  function endMatch(champs) {
    matchState = 'ended';
    paused = false;
    pClearAll();
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    stopLoop();
    finalAwards = computeAwards();
    socket.emit('host:matchEnd', { winnerIds: champs, gamePoints: gamePoints, awards: finalAwards });
    playGameWin();
    launchConfetti();
    renderFinal(champs);
  }

  function finishSolo() {
    matchState = 'ended';
    paused = false;
    pClearAll();
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    stopLoop();
    const p = world.players[0];
    // Solo is scored by final length, like multiplayer.
    const length = p ? world.lengthOf(p) : 0;
    const score = length;
    let shown = false;
    const fallback = setTimeout(function () {
      if (shown) return; shown = true;
      renderSoloFinal({ score: score, length: length, newBest: false }, soloBest);
      playSad();
    }, 1500);
    socket.emit('host:matchEnd', { soloScore: score, soloLength: length }, function (res) {
      if (shown) return; shown = true;
      clearTimeout(fallback);
      const solo = (res && res.solo) || { score: score, length: length, newBest: false };
      soloBest = (res && res.soloBest) || soloBest;
      renderSoloFinal(solo, soloBest);
      if (solo.newBest) { playGameWin(); launchConfetti(); } else playSad();
    });
  }

  // ---------------- Awards ----------------
  function topStat(key) {
    let best = -1, ids = [];
    roster.forEach(function (r) {
      const v = (stats[r.id] || {})[key] || 0;
      if (v > best) { best = v; ids = [r.id]; } else if (v === best) ids.push(r.id);
    });
    return { value: best, ids: ids };
  }
  function makeAward(emoji, title, top, value, minValue) {
    if (!top.ids.length || top.value < (minValue == null ? 1 : minValue)) return null;
    return {
      emoji: emoji, title: title,
      names: top.ids.map(nameOf).join(' & '),
      color: top.ids.length === 1 ? colorOf(top.ids[0]) : '#A3E635',
      value: value,
    };
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function computeAwards() {
    const out = [];
    const len = topStat('maxLen');
    const a1 = makeAward('📏', 'Longest Snake', len, 'length ' + len.value, 0);
    if (a1) out.push(a1);
    const ap = topStat('apples');
    const a2 = makeAward('🍎', 'Apple Muncher', ap, plural(ap.value, 'apple', 'apples'));
    if (a2) out.push(a2);
    const k = topStat('kills');
    const a3 = makeAward('😈', 'Trap Setter', k, plural(k.value, 'snake trapped', 'snakes trapped'));
    if (a3) out.push(a3);
    const pu = topStat('powers');
    const a5 = makeAward('⚡', 'Power Hungry', pu, plural(pu.value, 'power-up', 'power-ups'));
    if (a5) out.push(a5);
    const sv = topStat('survived');
    const a4 = makeAward('🛡️', 'Survivor', sv, plural(sv.value, 'round survived', 'rounds survived'));
    if (a4) out.push(a4);
    if (fastestDeath) {
      out.push({ emoji: '💀', title: 'First to Fall', names: nameOf(fastestDeath.id), color: colorOf(fastestDeath.id),
        value: 'crashed in ' + Math.max(1, Math.round(fastestDeath.sec)) + 's · R' + fastestDeath.round });
    }
    return out;
  }

  // ---------------- Scoreboard ----------------
  function buildScoreStrip() {
    scoreStrip.innerHTML = '';
    roster.forEach(function (r) {
      const card = document.createElement('div'); card.className = 'sc-card'; card.dataset.pid = r.id;
      card.style.setProperty('--pc', r.color);
      const crown = document.createElement('div'); crown.className = 'sc-crown'; crown.textContent = '👑';
      const top = document.createElement('div'); top.className = 'sc-top';
      const dot = document.createElement('span'); dot.className = 'sc-dot'; dot.style.background = r.color;
      const name = document.createElement('span'); name.className = 'sc-name'; name.textContent = r.name; name.title = r.name;
      const pw = document.createElement('span'); pw.className = 'sc-pw';
      top.appendChild(dot); top.appendChild(name); top.appendChild(pw);
      const score = document.createElement('div'); score.className = 'sc-score'; score.textContent = '3';
      const pips = document.createElement('div'); pips.className = 'sc-pips';
      card.appendChild(crown); card.appendChild(top); card.appendChild(score);
      // Multiplayer cards stay compact: name, length (or 💀), round pips.
      if (mode === 'solo') { const sub = document.createElement('div'); sub.className = 'sc-sub'; sub.textContent = 'length'; card.appendChild(sub); }
      card.appendChild(pips);
      scoreStrip.appendChild(card);
    });
  }
  function updateScoreStrip() {
    if (sbRound) sbRound.textContent = mode === 'solo' ? 'Solo' : 'Round ' + round;
    if (sbClock) {
      if (mode === 'solo') { sbClock.textContent = fmtElapsed(soloSec); sbClock.classList.remove('urgent'); }
      else { sbClock.textContent = fmtClock(clockMs); sbClock.classList.toggle('urgent', clockMs <= 10000 && matchState !== 'decided'); }
    }
    if (!world) return;
    const top = mode === 'multi' ? leaders() : [];
    const crown = top.length < world.players.length;   // nobody is crowned while everyone is level
    const cards = scoreStrip.children;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]; const pid = card.dataset.pid;
      const p = world.byId.get(pid);
      if (!p) continue;
      const scoreEl = card.querySelector('.sc-score');
      const subEl = card.querySelector('.sc-sub');
      if (mode === 'solo') {
        scoreEl.textContent = world.lengthOf(p);
        if (subEl) subEl.textContent = soloBest ? ('length · best ' + soloBest.score) : 'length';
      } else {
        // A crashed snake's length is frozen but still counts.
        scoreEl.textContent = p.alive ? p.body.length : '💀 ' + p.finalLength;
      }
      card.classList.toggle('dead', !p.alive);
      card.classList.toggle('leader', crown && top.indexOf(pid) >= 0);
      const pwEl = card.querySelector('.sc-pw');
      if (pwEl) {
        const icons = (p.alive && p.magnet ? '🧲' : '') + (p.alive && p.phantom ? '👻' : '');
        if (pwEl.textContent !== icons) pwEl.textContent = icons;
      }
      const pipsEl = card.querySelector('.sc-pips');
      if (mode === 'solo') { pipsEl.innerHTML = ''; continue; }
      const have = gamePoints[pid] || 0;
      if (pipsEl.children.length !== roundsToWin) {
        pipsEl.innerHTML = '';
        for (let k = 0; k < roundsToWin; k++) { const d = document.createElement('span'); d.className = 'pip'; pipsEl.appendChild(d); }
      }
      for (let k = 0; k < pipsEl.children.length; k++) pipsEl.children[k].classList.toggle('on', k < have);
    }
  }

  function renderRoundOverlay(d, lengths, matchOver) {
    if (d.winnerId) setRich(roTitle, ['🐍 ', nameSpan(d.winnerId), ' wins the round!']);
    else roTitle.textContent = 'Draw — nobody scores';
    roList.innerHTML = '';
    const alive = aliveMap();
    const sorted = roster.slice().sort(function (a, b) {
      const g = (gamePoints[b.id] || 0) - (gamePoints[a.id] || 0);
      return g || ((lengths[b.id] || 0) - (lengths[a.id] || 0));
    });
    sorted.forEach(function (r) {
      const row = document.createElement('div'); row.className = 'ro-row' + (r.id === d.winnerId ? ' win' : '') + (alive[r.id] ? '' : ' dead');
      const dot = document.createElement('span'); dot.className = 'ro-dot'; dot.style.background = r.color;
      const nm = document.createElement('span'); nm.className = 'ro-name'; nm.textContent = r.name; nm.style.color = r.color;
      const ln = document.createElement('span'); ln.className = 'ro-len'; ln.textContent = (alive[r.id] ? '🐍 ' : '💀 ') + (lengths[r.id] || 0);
      const gp = document.createElement('span'); gp.className = 'ro-gp'; gp.textContent = '🏆 ' + (gamePoints[r.id] || 0) + ' / ' + roundsToWin;
      row.appendChild(dot); row.appendChild(nm); row.appendChild(ln); row.appendChild(gp);
      roList.appendChild(row);
    });
    roNext.textContent = matchOver ? 'Final results coming up…' : 'Round ' + (round + 1) + ' starting soon…';
    roundOverlay.hidden = false;
  }

  function renderFinal(champs) {
    soloResult.hidden = true;
    finalScroll.hidden = false;
    finalTrophy.textContent = '🏆';
    if (champs.length) setRich(finalHeading, joinNames(champs).concat([champs.length > 1 ? ' win!' : ' wins!']));
    else finalHeading.textContent = 'Game over';
    finalList.innerHTML = '';
    const sorted = roster.slice().sort(function (a, b) {
      const g = (gamePoints[b.id] || 0) - (gamePoints[a.id] || 0);
      return g || (((stats[b.id] || {}).maxLen || 0) - ((stats[a.id] || {}).maxLen || 0));
    });
    sorted.forEach(function (r) {
      const row = document.createElement('div'); row.className = 'fn-row' + (champs.indexOf(r.id) >= 0 ? ' win' : '');
      const dot = document.createElement('span'); dot.className = 'fn-dot'; dot.style.background = r.color;
      const nm = document.createElement('span'); nm.className = 'fn-name'; nm.textContent = r.name; nm.style.color = r.color;
      const gp = document.createElement('span'); gp.className = 'fn-gp'; gp.textContent = '🏆 ' + (gamePoints[r.id] || 0);
      row.appendChild(dot); row.appendChild(nm); row.appendChild(gp);
      finalList.appendChild(row);
    });
    renderAwards(finalAwards);
    show('final');
  }

  function renderSoloFinal(solo, best) {
    solo = solo || { score: 0, length: 0, newBest: false };
    finalScroll.hidden = true;
    soloResult.hidden = false;
    finalTrophy.textContent = solo.newBest ? '🏆' : '🐍';
    finalHeading.textContent = solo.newBest ? 'New session best!' : 'Game over!';
    soloScoreEl.textContent = solo.score;
    soloUnitEl.textContent = 'length';
    const parts = [];
    if (solo.newBest) { const b = document.createElement('span'); b.className = 'new-best'; b.textContent = 'NEW BEST'; parts.push(b); }
    if (best) {
      const num = document.createElement('span'); num.className = 'best-num'; num.textContent = best.score;
      parts.push('Session best: ', num);
    }
    setRich(soloBestEl, parts);
    show('final');
  }

  function renderAwards(awards) {
    if (!finalAwardsEl) return;
    finalAwardsEl.innerHTML = '';
    const list = awards || [];
    if (finalAwardsSection) finalAwardsSection.hidden = list.length === 0;
    list.forEach(function (a) {
      const card = document.createElement('div'); card.className = 'award-card';
      const emoji = document.createElement('div'); emoji.className = 'aw-emoji'; emoji.textContent = a.emoji;
      const title = document.createElement('div'); title.className = 'aw-title'; title.textContent = a.title;
      const who = document.createElement('div'); who.className = 'aw-name'; who.textContent = a.names; who.style.color = a.color;
      const val = document.createElement('div'); val.className = 'aw-value'; val.textContent = a.value;
      card.appendChild(emoji); card.appendChild(title); card.appendChild(who); card.appendChild(val);
      finalAwardsEl.appendChild(card);
    });
  }

  // ---------------- Confetti ----------------
  function launchConfetti() {
    const colors = ['#A3E635', '#4ADE80', '#FACC15', '#60A5FA', '#F472B6', '#EF4444'];
    for (let i = 0; i < 80; i++) {
      const d = document.createElement('div');
      d.className = 'confetti';
      d.style.left = (Math.random() * 100) + 'vw';
      d.style.background = colors[(Math.random() * colors.length) | 0];
      d.style.animationDelay = (Math.random() * 0.6) + 's';
      d.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
      document.body.appendChild(d);
      setTimeout(function () { d.remove(); }, 3200);
    }
  }

  // ---------------- Reactions ----------------
  function spawnReaction(index) {
    const emoji = REACTION_EMOJIS[index];
    if (!emoji || !reactionLayer) return;
    while (reactionLayer.children.length >= REACTION_MAX) reactionLayer.removeChild(reactionLayer.firstChild);
    const el = document.createElement('div');
    el.className = 'reaction-emoji';
    el.textContent = emoji;
    el.style.left = (5 + Math.random() * 90) + '%';
    const scale = 0.85 + Math.random() * 0.5;
    el.style.fontSize = (44 * scale) + 'px';
    el.style.animationDuration = (3.0 + Math.random() * 1.2) + 's';
    el.addEventListener('animationend', function () { if (el.parentNode) el.parentNode.removeChild(el); });
    reactionLayer.appendChild(el);
  }
  socket.on('host:reaction', function (p) { if (p && typeof p.index === 'number') spawnReaction(p.index); });

  let reactionsMuted = false;
  function updateMuteBtn() {
    if (!muteBtn) return;
    muteBtn.textContent = reactionsMuted ? '🔕 Reactions: Off' : '🔔 Reactions: On';
    muteBtn.classList.toggle('is-muted', reactionsMuted);
  }
  muteBtn && muteBtn.addEventListener('click', function () {
    socket.emit('host:setReactionsMuted', { muted: !reactionsMuted }, function (res) {
      if (res && res.ok) { reactionsMuted = !!res.reactionsMuted; updateMuteBtn(); }
    });
  });
  socket.on('state:reactionsMuted', function (p) { reactionsMuted = !!(p && p.muted); updateMuteBtn(); });

  // ---------------- Input + presence relays ----------------
  socket.on('in', function (d) { if (d && world && matchState === 'play') inputQueue.push(d); });
  socket.on('player:dropped', function (d) { if (world && d) { const p = world.byId.get(d.id); if (p) { p.connected = false; world.clearInputs(d.id); } } });
  socket.on('player:rejoined', function (d) { if (world && d) { const p = world.byId.get(d.id); if (p) p.connected = true; } });

  // ---------------- Boot ----------------
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      renderQR();
      renderLobby(res.lobby);
      reactionsMuted = !!res.reactionsMuted; updateMuteBtn();
      roundsToWin = res.lobby.roundsToWin; roundLengthSec = res.lobby.roundLengthSec;
      if (res.phase === 'LOBBY') {
        if (matchState !== 'idle') resetLocal();
        show('lobby');
      } else if (res.phase === 'PLAYING' && res.match) {
        // Host (re)connected mid-match. If this page is still running the
        // match (a brief socket blip), carry on; after a refresh, restart the
        // CURRENT round fresh, keeping round wins + the round number.
        if (matchState === 'idle') {
          startMatch(res.match.roster, res.match, { gamePoints: res.match.gamePoints, round: res.match.round });
        }
      } else if (res.phase === 'FINAL' && res.match) {
        if (matchState === 'ended') { /* already showing the final screen */ }
        else {
          roster = res.match.roster || [];
          mode = res.match.mode === 'solo' ? 'solo' : 'multi';
          gamePoints = res.match.gamePoints || {};
          roundsToWin = res.match.roundsToWin;
          finalAwards = res.match.awards || null;
          matchState = 'ended';
          if (mode === 'solo') renderSoloFinal(res.match.solo, res.match.soloBest);
          else renderFinal(res.match.winnerIds || []);
        }
      }
      if (window.Iris && typeof window.Iris.ready === 'function') window.Iris.ready();
    });
  });

  socket.on('state:lobby', function (l) {
    if (l && l.phase === 'LOBBY') { renderLobby(l); if (!views.match.classList.contains('active') && !views.final.classList.contains('active')) show('lobby'); }
  });

  function resetLocal() {
    stopLoop();
    pClearAll();
    countdownTimer = null; roundOverTimer = null;
    paused = false;
    matchState = 'idle'; world = null; renderer = null; lastHumanTotal = -1;
    stats = {}; fastestDeath = null; finalAwards = null; decision = null;
    inputQueue.length = 0;
    if (roundOverlay) roundOverlay.hidden = true;
    if (countOverlay) countOverlay.hidden = true;
    hideReason();
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
  }
  socket.on('state:reset', function () {
    resetLocal();
    show('lobby');
  });

  window.addEventListener('resize', function () { if (renderer) renderer.resize(); });
})();
