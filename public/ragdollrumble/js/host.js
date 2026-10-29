(function () {
  'use strict';

  const socket = io('/ragdollrumble', { transports: ['polling', 'websocket'] });
  const NM = window.RagdollRumble;

  // ---------------- Tunables ----------------
  const FIXED_DT = 1 / 120;
  const MAX_STEPS = 8;
  const COUNTDOWN_FROM = 3;
  const COUNTDOWN_STEP_MS = 800;
  const CLOCK_EMIT_MS = 250;
  const ROUNDOVER_MS = 7000;
  const ROUND_END_HOLD_MS = 1800;   // let the final KO play out before the card
  const SLOWMO_SCALE = 0.35;        // sim speed from the deciding KO to the round card
  // Lobby, round results and final are downtime: leaving them cuts lingering sounds/confetti.
  const DOWNTIME = ['lobby', 'roundEnd', 'final'];

  const STAGE_NAMES = {};
  NM.STAGE_IDS.forEach(function (id) { STAGE_NAMES[id] = NM.STAGES[id].name; });
  const ITEM_ICONS = { bat: '🏏', bomb: '💣', rock: '🪨' };

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    match: document.getElementById('view-match'),
    final: document.getElementById('view-final'),
  };
  let currentScreen = 'lobby';
  function screenTo(name) {
    if (window.screenChange) window.screenChange(currentScreen, name, DOWNTIME);
    currentScreen = name;
  }
  function show(name) {
    screenTo(name);
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('active', k === name); });
  }

  const qrSlot = document.getElementById('qrSlot');
  const joinUrlEl = document.getElementById('joinUrl');
  const playerCountEl = document.getElementById('playerCount');
  const playerCapEl = document.getElementById('playerCap');
  const addBotBtn = document.getElementById('addBotBtn');
  const roundsRange = document.getElementById('roundsRange');
  const roundsVal = document.getElementById('roundsVal');
  const durRange = document.getElementById('durRange');
  const durVal = document.getElementById('durVal');
  const itemSeg = document.getElementById('itemSeg');
  const stageSeg = document.getElementById('stageSeg');
  const diffSeg = document.getElementById('diffSeg');
  const slotList = document.getElementById('slotList');
  const configHint = document.getElementById('configHint');
  const startBtn = document.getElementById('startBtn');

  const canvas = document.getElementById('arena');
  const scoreStrip = document.getElementById('scoreStrip');
  const sbRound = document.getElementById('sbRound');
  const sbStage = document.getElementById('sbStage');
  const sbTarget = document.getElementById('sbTarget');
  const sbClock = document.getElementById('sbClock');
  const countOverlay = document.getElementById('countOverlay');
  const coNum = document.getElementById('coNum');
  const coNote = document.getElementById('coNote');
  const roundOverlay = document.getElementById('roundOverlay');
  const roBadge = document.getElementById('roBadge');
  const roTitle = document.getElementById('roTitle');
  const roSub = document.getElementById('roSub');
  const roList = document.getElementById('roList');

  const finalHeading = document.getElementById('finalHeading');
  const finalList = document.getElementById('finalList');
  const backToLobbyBtn = document.getElementById('backToLobbyBtn');
  const playAgainBtn = document.getElementById('playAgainBtn');

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const resetBtn = document.getElementById('resetBtn');
  const muteBtn = document.getElementById('muteReactionsBtn');
  const reactionLayer = document.getElementById('reactionLayer');
  const REACTION_EMOJIS = ['😂', '🔥', '🎉', '😱', '😭', '😡'];
  const REACTION_MAX = 30;
  const pauseBtn = document.getElementById('pauseBtn');
  const pauseOverlay = document.getElementById('pauseOverlay');

  let reduceMotion = false;
  try { reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}

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
  backToLobbyBtn && backToLobbyBtn.addEventListener('click', function () {
    socket.emit('host:reset', {});
  });
  // Rematch: same players and settings, straight into a new match.
  playAgainBtn && playAgainBtn.addEventListener('click', function () {
    unlockAudio();
    playAgainBtn.disabled = true;
    socket.emit('host:rematch', {}, function (res) {
      playAgainBtn.disabled = false;
      if (!res || !res.ok) { toast('Could not start a new game.'); return; }
      startMatch(res.roster, res, null);
    });
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
  function sweep(f0, f1, dur, type, gain, when) {
    const c = getAudioCtx(); if (!c) return;
    const t = when || c.currentTime;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.2, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  let noiseBuf = null;
  function getNoise(c) {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(c.sampleRate * 1.2);
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }
  /** Filtered noise burst — the backbone of every whack, thud and boom. */
  function noise(dur, f0, f1, gain, type) {
    const c = getAudioCtx(); if (!c) return;
    const t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = getNoise(c);
    const flt = c.createBiquadFilter(); flt.type = type || 'lowpass';
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt); flt.connect(g); g.connect(c.destination);
    src.start(t); src.stop(t + dur + 0.02);
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
  function playLookUp() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime; [392, 523, 659, 784].forEach(function (f, i) { blip(f, 0.16, 'triangle', 0.14, b + i * 0.08); }); }
  function beep(n) { blip(440 + (COUNTDOWN_FROM - n) * 120, 0.1, 'square', 0.14); }
  function playGo() { blip(880, 0.22, 'square', 0.18); sweep(440, 1320, 0.18, 'triangle', 0.1); }
  let lastHit = 0;
  function playHit(kb) {
    const c = getAudioCtx(); if (!c) return;
    if (c.currentTime - lastHit < 0.035) return;
    lastHit = c.currentTime;
    const k = Math.min(1, kb / 40);
    noise(0.08 + k * 0.18, 2600 - k * 1200, 200, 0.22 + k * 0.25);
    sweep(260 - k * 120, 60, 0.1 + k * 0.15, 'sine', 0.2 + k * 0.2);
  }
  function playWhoosh() { noise(0.18, 600, 3200, 0.08, 'bandpass'); }
  let lastSwish = 0;
  function playSwish() {
    const c = getAudioCtx(); if (!c) return;
    if (c.currentTime - lastSwish < 0.04) return;
    lastSwish = c.currentTime;
    noise(0.09, 1800, 5200, 0.05, 'bandpass');
  }
  function playKO() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    noise(0.6, 1800, 60, 0.45);
    sweep(140, 40, 0.5, 'sine', 0.35);
    sweep(500, 1800, 0.45, 'sawtooth', 0.08, b + 0.05);
    blip(1568, 0.25, 'triangle', 0.12, b + 0.4);
  }
  function playGrab() { blip(330, 0.07, 'square', 0.1); blip(220, 0.08, 'square', 0.08, (getAudioCtx() || {}).currentTime + 0.05); }
  // A throw is a fling, not a hit: a rising airy whoosh as they sail away.
  function playThrow() { sweep(260, 820, 0.32, 'triangle', 0.09); noise(0.35, 700, 4200, 0.11, 'bandpass'); }
  // A slam is a body hitting the floor: a dull, low thump with a dusty tail.
  function playSlam() { sweep(120, 42, 0.32, 'sine', 0.32); noise(0.28, 500, 70, 0.22); }
  function playPickup() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime; [784, 988, 1319].forEach(function (f, i) { blip(f, 0.11, 'square', 0.1, b + i * 0.055); }); }
  function playExplosion() { noise(0.7, 1400, 50, 0.5); sweep(150, 35, 0.4, 'sine', 0.32); }
  function playCrack() { noise(0.12, 3000, 800, 0.14, 'highpass'); }
  function playCrumble() { noise(0.45, 900, 80, 0.3); }
  function playGustWarn() { noise(1.2, 300, 1600, 0.12, 'bandpass'); }
  function playAlarm() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime; [0, 0.25, 0.5].forEach(function (o) { blip(880, 0.12, 'square', 0.1, b + o); blip(660, 0.12, 'square', 0.1, b + o + 0.12); }); }
  function playSizzle() { noise(0.35, 5000, 2000, 0.1, 'highpass'); }
  // Charging: quick blips that climb in pitch as the charge builds (one shared
  // stream however many are charging), plus a bright ding the moment one is full.
  let lastChargeBlip = 0;
  const chargeFull = {};
  function chargeSounds(now) {
    if (!world) return;
    let k = -1;
    for (let i = 0; i < world.players.length; i++) {
      const p = world.players[i];
      if (!p.alive || p.charge < 0) { chargeFull[p.id] = false; continue; }
      const c = Math.min(1, p.charge / NM.CHARGE_FULL);
      if (c >= 1 && !chargeFull[p.id]) { chargeFull[p.id] = true; blip(1568, 0.2, 'sine', 0.16); blip(2093, 0.16, 'sine', 0.08); }
      k = Math.max(k, c);
    }
    if (k < 0 || now - lastChargeBlip < 95) return;
    lastChargeBlip = now;
    blip(280 + 760 * k, 0.08, 'triangle', 0.05 + 0.05 * k);
  }
  function playSuddenDeath() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [0, 0.22, 0.44].forEach(function (o) { sweep(220, 110, 0.2, 'sawtooth', 0.2, b + o); });
    noise(0.6, 900, 60, 0.3);
  }
  function playRoundWin() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime; [523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.24, 'sawtooth', 0.14, b + i * 0.08); }); }
  function playGameWin() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [523, 659, 784, 1047, 1319, 1568].forEach(function (f, i) { blip(f, 0.3, 'sawtooth', 0.15, b + i * 0.1); });
    playApplause(b + 0.5);
  }
  // Recorded applause (the same clip as Trivia's results screen); the synth
  // crackle below only plays if the file can't be loaded.
  const sfxApplause = document.getElementById('sfx-applause');
  let applauseFileOk = null;
  if (sfxApplause) {
    sfxApplause.addEventListener('canplaythrough', function () { applauseFileOk = true; });
    sfxApplause.addEventListener('error', function () { applauseFileOk = false; });
  }
  function playApplause(when) {
    if (sfxApplause && applauseFileOk !== false) {
      const c = getAudioCtx();
      const delayMs = c && when ? Math.max(0, (when - c.currentTime) * 1000) : 0;
      setTimeout(function () {
        if (!views.final.classList.contains('active')) return;
        try { sfxApplause.currentTime = 0; sfxApplause.play().catch(function () { playApplauseSynth(); }); }
        catch (e) { playApplauseSynth(); }
      }, delayMs);
      return;
    }
    playApplauseSynth(when);
  }
  /** Synth fallback — a long crackle of filtered noise; registered so the shared cleanup can stop it. */
  function playApplauseSynth(when) {
    const c = getAudioCtx(); if (!c) return;
    const t = when || c.currentTime;
    const src = c.createBufferSource(); src.buffer = getNoise(c); src.loop = true;
    const flt = c.createBiquadFilter(); flt.type = 'bandpass'; flt.frequency.value = 2200; flt.Q.value = 0.6;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.3);
    g.gain.setValueAtTime(0.16, t + 2.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
    src.connect(flt); flt.connect(g); g.connect(c.destination);
    src.start(t); src.stop(t + 3.7);
    if (window.trackApplause) window.trackApplause(g);
  }

  // ---------------- Lobby ----------------
  let lobby = { players: [], total: 0, capacity: 6, minPlayers: 2, roundLengthSec: 90, roundsToWin: 3, items: true, stageSet: 'mixed', botDifficulty: 'normal', canStart: false };
  let lastHumanTotal = -1;
  let dragActive = false;
  let pendingLobby = null;

  function fmtClock(ms) { const t = Math.max(0, Math.ceil(ms / 1000)); const m = Math.floor(t / 60), s = t % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function fmtDur(sec) { const m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }

  function renderQR() {
    fetch('/api/ragdollrumble/config').then(function (r) { return r.json(); }).then(function (cfg) {
      const url = (cfg && cfg.joinUrl) || (window.location.origin + '/ragdollrumble/join');
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      return fetch('/api/ragdollrumble/qr?url=' + encodeURIComponent(url));
    }).then(function (r) { return r.text(); }).then(function (svg) { qrSlot.innerHTML = svg; }).catch(function () {});
  }

  function renderLobby(l) {
    if (!l) return;
    // Don't rebuild the chip list out from under an in-progress drag.
    if (dragActive) { pendingLobby = l; return; }
    lobby = l;
    const humanTotal = l.players.filter(function (p) { return !p.isBot; }).length;
    if (lastHumanTotal >= 0 && humanTotal > lastHumanTotal) playJoinDing();
    lastHumanTotal = humanTotal;
    playerCountEl.textContent = l.total;
    playerCapEl.textContent = l.capacity;
    roundsRange.value = l.roundsToWin; roundsVal.textContent = l.roundsToWin;
    durRange.value = l.roundLengthSec; durVal.textContent = fmtDur(l.roundLengthSec);
    setSeg(itemSeg, 'items', l.items ? '1' : '0');
    setSeg(stageSeg, 'stage', l.stageSet);
    setSeg(diffSeg, 'diff', l.botDifficulty);

    slotList.innerHTML = '';
    l.players.forEach(function (p, i) {
      const el = document.createElement('div');
      el.className = 'player-chip' + (p.connected === false ? ' disconnected' : '') + (p.isBot ? ' is-bot' : '');
      el.dataset.pid = p.id;
      el.style.setProperty('--pc', p.color);
      const grip = document.createElement('span'); grip.className = 'chip-grip'; grip.textContent = '⠿';
      const seat = document.createElement('span'); seat.className = 'chip-seat';
      const label = document.createElement('span'); label.className = 'chip-name'; label.textContent = p.name;
      const kick = document.createElement('button'); kick.className = 'chip-kick'; kick.type = 'button'; kick.textContent = '✕';
      kick.title = p.isBot ? 'Remove CPU' : 'Remove player';
      kick.addEventListener('click', function (e) { e.stopPropagation(); socket.emit('host:kick', { playerId: p.id }); });
      el.appendChild(grip); el.appendChild(seat); el.appendChild(label); el.appendChild(kick);
      slotList.appendChild(el);
    });
    for (let i = l.players.length; i < l.capacity; i++) {
      const e = document.createElement('div'); e.className = 'slot-empty'; e.textContent = 'Open spot'; slotList.appendChild(e);
    }
    startBtn.disabled = !l.canStart;
    if (addBotBtn) addBotBtn.disabled = l.total >= l.capacity;
    configHint.textContent = l.canStart ? '' : ('Need at least ' + l.minPlayers + ' fighters (add a CPU to fill in).');
  }

  function setSeg(seg, attr, value) {
    if (!seg) return;
    Array.prototype.forEach.call(seg.querySelectorAll('.seg-btn'), function (b) {
      b.classList.toggle('on', b.dataset[attr] === String(value));
    });
  }

  // ---- Smooth pointer-drag to reorder the lobby (order = seat = color = spawn) --
  (function setupLobbyDrag() {
    let d = null; // { el, pid, downX, downY, active, offX, offY, ph }

    function chips() {
      return Array.prototype.slice.call(slotList.querySelectorAll('.player-chip'))
        .filter(function (c) { return !d || c !== d.el; });
    }
    function measure() { return chips().map(function (c) { return [c, c.getBoundingClientRect().top]; }); }
    function flip(prev) {
      if (reduceMotion) return;
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
      previewOrder();
    }
    /** Live-update the color while a chip is being dragged. */
    function previewOrder() {
      let seat = 0;
      Array.prototype.forEach.call(slotList.children, function (n) {
        if (n === d.el) return;
        const chip = n === d.ph ? d.el : n;
        if (!chip.classList || !chip.classList.contains('player-chip')) return;
        // Seat and color belong to the slot, not the player.
        const slot = lobby.players[seat];
        seat++;
        if (slot) chip.style.setProperty('--pc', slot.color);
      });
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
      if (!cur.active) return; // never crossed the threshold → a tap
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
      if (e.button != null && e.button !== 0) return; // primary only
      if (!e.target || e.target.closest('.chip-kick')) return; // kick isn't a handle
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
    roundsVal.textContent = roundsRange.value;
    if (roundsTimer) clearTimeout(roundsTimer);
    roundsTimer = setTimeout(function () { socket.emit('host:setRoundsToWin', { roundsToWin: Number(roundsRange.value) }); }, 120);
  });
  let durTimer = null;
  durRange.addEventListener('input', function () {
    durVal.textContent = fmtDur(Number(durRange.value));
    if (durTimer) clearTimeout(durTimer);
    durTimer = setTimeout(function () { socket.emit('host:setRoundLength', { roundLengthSec: Number(durRange.value) }); }, 120);
  });
  itemSeg && itemSeg.addEventListener('click', function (e) {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    setSeg(itemSeg, 'items', b.dataset.items);
    socket.emit('host:setItems', { on: b.dataset.items === '1' });
  });
  stageSeg && stageSeg.addEventListener('click', function (e) {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    setSeg(stageSeg, 'stage', b.dataset.stage);
    socket.emit('host:setStageSet', { set: b.dataset.stage });
  });
  diffSeg && diffSeg.addEventListener('click', function (e) {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    setSeg(diffSeg, 'diff', b.dataset.diff);
    socket.emit('host:setBotDifficulty', { level: b.dataset.diff });
  });

  startBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
      if (!res || !res.ok) { toast('Need at least 2 fighters to start.'); return; }
      startMatch(res.roster, res, null);
    });
  });

  // ---------------- Match state ----------------
  let world = null, renderer = null, rafId = null, lastFrame = 0, acc = 0;
  let matchState = 'idle'; // idle | countdown | play | roundover | ended
  let roster = [];
  let roundLengthSec = 90, roundsToWin = 3, items = true, stageSet = 'mixed', botDifficulty = 'normal';
  let round = 1;
  let stageOrder = [];
  let stageId = 'rooftop';
  let clockMs = 0, lastClockEmit = 0;
  let gamePoints = {};
  let roundEndAt = null;
  let countdownTimer = null, roundOverTimer = null;
  let bots = [];
  let sdStarted = false;
  let prevHud = {};

  // ---------------- Pause ----------------
  // The whole simulation runs in this browser, so pausing means: stop stepping
  // the world/clock in loop(), and freeze every wall-clock timer so the
  // sequence resumes exactly where it left off.
  let paused = false;
  const pausableTimers = new Set();
  function pTimeout(fn, ms) {
    const rec = { fn: fn, remaining: ms, startedAt: performance.now(), handle: null, repeat: false, interval: 0 };
    rec.handle = setTimeout(function () { pausableTimers.delete(rec); fn(); }, ms);
    pausableTimers.add(rec); return rec;
  }
  function pInterval(fn, ms) {
    const rec = { fn: fn, remaining: ms, startedAt: performance.now(), handle: null, repeat: true, interval: ms };
    rec.handle = setInterval(function () { rec.startedAt = performance.now(); rec.remaining = rec.interval; fn(); }, ms);
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
          if (!pausableTimers.has(rec)) return; // fn() may have cleared it
          rec.startedAt = performance.now(); rec.remaining = rec.interval;
          rec.handle = setInterval(function () { rec.startedAt = performance.now(); rec.remaining = rec.interval; rec.fn(); }, rec.interval);
        }, rec.remaining);
      } else {
        rec.handle = setTimeout(function () { pausableTimers.delete(rec); rec.fn(); }, rec.remaining);
      }
    });
  }
  let resumeTimer = null;   // running resume 3-2-1, if any
  function updatePauseBtn() {
    if (!pauseBtn) return;
    const ongoing = matchState === 'countdown' || matchState === 'play' || matchState === 'roundover';
    pauseBtn.hidden = !ongoing;
    pauseBtn.textContent = (paused && !resumeTimer) ? '▶ Resume' : '⏸ Pause';
  }
  function pauseMatch() {
    if (paused) return;
    clearResumeCount();
    const ongoing = matchState === 'countdown' || matchState === 'play' || matchState === 'roundover';
    if (!ongoing) return;
    paused = true;
    if (world) { world.frozen = true; world.clearInputs(); }
    freezeTimers();
    if (pauseOverlay) pauseOverlay.hidden = false;
    updatePauseBtn();
    socket.emit('host:pause', {});
  }
  function resumeMatch() {
    if (!paused) return;
    paused = false;
    if (world && matchState === 'play') world.frozen = false;
    lastFrame = performance.now(); acc = 0; lastClockEmit = 0;
    thawTimers();
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    socket.emit('host:resume', { live: matchState === 'play' });
  }
  // ---- Resume countdown ----
  // Resuming into live play runs a 3-2-1 first. The game stays paused the whole
  // time, so the countdown never counts as play time. Pressing Pause again
  // cancels it; resuming anywhere else (countdown, round results) is instant.
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
    if (matchState !== 'play') { resumeMatch(); return; }
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

  // ---------------- Match flow ----------------
  function shuffledStages() {
    const ids = NM.STAGE_IDS.slice();
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
    return ids;
  }
  function stageForRound(r) {
    if (stageSet === 'classic') return 'rooftop';
    if (!stageOrder.length) stageOrder = shuffledStages();
    return stageOrder[(r - 1) % stageOrder.length];
  }

  function startMatch(rost, cfg, initial) {
    roster = rost || [];
    roundLengthSec = (cfg && cfg.roundLengthSec) || 90;
    roundsToWin = (cfg && cfg.roundsToWin) || 3;
    items = cfg && cfg.items !== undefined ? !!cfg.items : true;
    stageSet = (cfg && cfg.stageSet) || 'mixed';
    botDifficulty = (cfg && cfg.botDifficulty) || 'normal';
    gamePoints = {};
    roster.forEach(function (r) { gamePoints[r.id] = 0; });
    if (initial && initial.gamePoints) { for (const id in initial.gamePoints) if (id in gamePoints) gamePoints[id] = initial.gamePoints[id]; }
    round = (initial && initial.round) || 1;
    stageOrder = shuffledStages();
    // A refreshed host replays the round on the stage it was already on.
    if (initial && initial.stage && NM.STAGES[initial.stage] && stageSet !== 'classic') {
      const idx = stageOrder.indexOf(initial.stage);
      const want = (round - 1) % stageOrder.length;
      stageOrder[idx] = stageOrder[want]; stageOrder[want] = initial.stage;
    }
    show('match');
    buildScoreStrip();
    startLoop();
    beginRound(round);
  }

  function beginRound(r) {
    round = r;
    const seed = (Math.random() * 2147483647) | 0;
    stageId = stageForRound(round);
    world = new NM.World({ items: items, stage: stageId });
    world.reset(seed, roster);
    world.frozen = true;
    if (!renderer) renderer = new window.RagdollRumbleRender.Renderer(canvas, world);
    else { renderer.setWorld(world); renderer.clearFx(); }
    bots = roster.filter(function (x) { return x.isBot; })
      .map(function (x) { return new window.RagdollRumbleBot.Bot(x.id, botDifficulty); });
    prevHud = {};
    sdStarted = false;
    clockMs = roundLengthSec * 1000;
    roundEndAt = null;
    paused = false; pClearAll();
    if (pauseOverlay) pauseOverlay.hidden = true;
    if (roundOverlay && !roundOverlay.hidden) { roundOverlay.hidden = true; screenTo('match'); }
    updateScoreStrip();
    requestAnimationFrame(function () { if (renderer) renderer.resize(); });
    socket.emit('host:roundStart', { round: round, seed: seed, stage: stageId, durationSec: roundLengthSec });
    playLookUp();
    beginCountdown();
  }

  function beginCountdown() {
    matchState = 'countdown';
    updatePauseBtn();
    if (world) world.frozen = true;
    if (countdownTimer) pClear(countdownTimer);
    let n = COUNTDOWN_FROM;
    const note = 'Round ' + round + ' · ' + STAGE_NAMES[stageId];
    function showN(v) {
      countOverlay.hidden = false;
      coNum.textContent = v;
      coNum.style.animation = 'none'; void coNum.offsetWidth; coNum.style.animation = '';
      if (coNote) coNote.textContent = note;
      socket.emit('host:countdown', { n: v, note: note });
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
    if (world) world.frozen = false;
    acc = 0; lastFrame = performance.now(); lastClockEmit = 0;
    playGo();
    socket.emit('host:play', {});
  }

  function startLoop() { if (rafId) cancelAnimationFrame(rafId); lastFrame = performance.now(); acc = 0; rafId = requestAnimationFrame(loop); }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    let dt = (now - lastFrame) / 1000; lastFrame = now;
    if (dt > 0.1) dt = 0.1;

    // Once the round is decided the last KO plays out in slow motion until the
    // round card drops.
    const simDt = (matchState === 'play' && roundEndAt !== null) ? dt * SLOWMO_SCALE : dt;

    if (matchState === 'play' && !paused && world) {
      // A brief hit-stop on big hits and KOs makes them land harder.
      if (renderer && renderer.hitStop > 0) {
        renderer.hitStop = Math.max(0, renderer.hitStop - dt);
        acc = 0;
      } else {
        for (let i = 0; i < bots.length; i++) bots[i].update(world, simDt);
        acc += simDt;
        let steps = 0;
        while (acc >= FIXED_DT && steps < MAX_STEPS) {
          handleEvents(world.step(FIXED_DT));
          acc -= FIXED_DT; steps++;
        }
        // After a long hitch, drop the backlog rather than fast-forwarding through it.
        if (acc >= FIXED_DT) acc = 0;
        emitHudChanges();
        chargeSounds(now);

        if (roundEndAt === null) {
          clockMs -= dt * 1000;
          if (clockMs < 0) clockMs = 0;
          if (!sdStarted && clockMs <= 0) {
            sdStarted = true;
            world.startSuddenDeath();
            playSuddenDeath();
          }
        }
        updateScoreStrip();
        if (now - lastClockEmit >= CLOCK_EMIT_MS) {
          lastClockEmit = now;
          socket.emit('host:clock', { ms: Math.max(0, clockMs), suddenDeath: sdStarted });
        }

        // The round is decided the moment one fighter (or nobody) is left.
        if (roundEndAt === null && world.alivePlayers().length <= 1) roundEndAt = now;
        if (roundEndAt !== null && (now - roundEndAt) >= ROUND_END_HOLD_MS) endRound();
      }
    }

    if (renderer) renderer.render(matchState === 'play' && !paused ? simDt : (paused ? 0 : dt));
  }

  function handleEvents(events) {
    if (!events || !events.length) return;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (renderer) renderer.onEvent(ev);
      switch (ev.type) {
        case 'hit':
          if (ev.kind === 'throw') break;   // the 'throw' event plays the fling
          if (ev.kind === 'slam') { playSlam(); break; }
          playHit(ev.kb || 0); if (ev.kind === 'lava') playSizzle(); break;
        case 'swing': if (ev.kind === 'smash' || ev.kind === 'bat') playWhoosh(); else playSwish(); break;
        case 'throwStart': playWhoosh(); break;
        case 'ko':
          playKO();
          socket.emit('host:eliminated', { id: ev.id, by: ev.by });
          break;
        case 'grab': playGrab(); break;
        case 'throw': case 'toss': playThrow(); break;
        case 'pickup': playPickup(); break;
        case 'explode': playExplosion(); break;
        case 'crack': playCrack(); break;
        case 'crumble': playCrumble(); break;
        case 'gustWarn': playGustWarn(); break;
        case 'rollerWarn': playAlarm(); break;
        case 'sizzle': playSizzle(); break;
        default: break;
      }
    }
  }

  /** Push damage % / held-item changes to the phones so their HUD stays in sync. */
  function emitHudChanges() {
    if (!world) return;
    for (let i = 0; i < world.players.length; i++) {
      const p = world.players[i];
      if (p.isBot) continue;
      const h = world.hudOf(p);
      const prev = prevHud[p.id];
      if (!prev || prev.dmg !== h.dmg || prev.item !== h.item || prev.glove !== h.glove) {
        prevHud[p.id] = h;
        socket.emit('host:hud', { id: p.id, dmg: h.dmg, item: h.item, glove: h.glove });
      }
    }
  }

  function endRound() {
    if (matchState !== 'play') return;
    matchState = 'roundover';
    updatePauseBtn();
    if (world) world.frozen = true;
    const alive = world.alivePlayers();
    const wipeout = alive.length === 0;
    const winnerId = wipeout ? lastToFall() : alive[0].id;
    if (winnerId) gamePoints[winnerId] = (gamePoints[winnerId] || 0) + 1;

    socket.emit('host:roundEnd', { round: round, winnerId: winnerId, gamePoints: gamePoints });
    updateScoreStrip();
    renderRoundOverlay(winnerId, wipeout);
    screenTo('roundEnd');
    playRoundWin();

    const champs = roster.filter(function (r) { return (gamePoints[r.id] || 0) >= roundsToWin; }).map(function (r) { return r.id; });
    if (roundOverTimer) pClear(roundOverTimer);
    roundOverTimer = pTimeout(function () {
      if (champs.length) endMatch(champs);
      else beginRound(round + 1);
    }, ROUNDOVER_MS);
  }

  /**
   * Nobody left standing still has a winner: whoever went out last. Ties in
   * the same tick go to whoever is further behind on round wins, then seat —
   * so a round never ends undecided.
   */
  function lastToFall() {
    const ps = world.players.slice().sort(function (a, b) {
      if (b.diedAt !== a.diedAt) return b.diedAt - a.diedAt;
      const gpA = gamePoints[a.id] || 0, gpB = gamePoints[b.id] || 0;
      if (gpA !== gpB) return gpA - gpB;
      return a.seat - b.seat;
    });
    return ps.length ? ps[0].id : null;
  }

  function endMatch(champs) {
    matchState = 'ended';
    paused = false;
    pClearAll();
    if (pauseOverlay) pauseOverlay.hidden = true;
    if (roundOverlay) roundOverlay.hidden = true;
    updatePauseBtn();
    stopLoop();
    socket.emit('host:matchEnd', { winnerIds: champs, gamePoints: gamePoints });
    renderFinal(champs);
    playGameWin();
    launchConfetti(colorOf(champs[0]));
  }

  function nameOf(id) { const r = roster.find(function (x) { return x.id === id; }); return r ? r.name : '?'; }
  function colorOf(id) { const r = roster.find(function (x) { return x.id === id; }); return r ? r.color : '#FFC93C'; }

  // ---------------- Scoreboard ----------------
  function buildScoreStrip() {
    scoreStrip.innerHTML = '';
    roster.forEach(function (r) {
      const card = document.createElement('div'); card.className = 'sc-card'; card.dataset.pid = r.id;
      card.style.setProperty('--pc', r.color);
      const top = document.createElement('div'); top.className = 'sc-top';
      const dot = document.createElement('span'); dot.className = 'sc-dot'; dot.style.background = r.color;
      const name = document.createElement('span'); name.className = 'sc-name'; name.textContent = r.name;
      const item = document.createElement('span'); item.className = 'sc-item';
      top.appendChild(dot); top.appendChild(name); top.appendChild(item);
      const dmg = document.createElement('div'); dmg.className = 'sc-dmg'; dmg.textContent = '0%';
      const out = document.createElement('div'); out.className = 'sc-out'; out.textContent = 'OUT';
      const pips = document.createElement('div'); pips.className = 'sc-pips';
      card.appendChild(top); card.appendChild(dmg); card.appendChild(out); card.appendChild(pips);
      scoreStrip.appendChild(card);
    });
  }

  /** Damage % turns from white through yellow and orange to red as it climbs. */
  function dmgColor(d) {
    if (d < 40) return '#ffffff';
    if (d < 80) return '#ffe14f';
    if (d < 120) return '#ff9a3d';
    return '#ff3b30';
  }

  function updateScoreStrip() {
    if (sbRound) sbRound.textContent = 'Round ' + round;
    if (sbStage) sbStage.textContent = STAGE_NAMES[stageId] || '';
    if (sbTarget) sbTarget.textContent = 'First to ' + roundsToWin;
    if (sbClock) {
      sbClock.textContent = sdStarted ? 'SUDDEN DEATH' : fmtClock(clockMs);
      sbClock.classList.toggle('urgent', sdStarted || clockMs <= 15000);
    }
    const cards = scoreStrip.children;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]; const pid = card.dataset.pid;
      const p = world ? world.playerById(pid) : null;
      card.classList.toggle('dead', !!(p && !p.alive));
      const h = p ? world.hudOf(p) : { dmg: 0, item: '', glove: false };
      const dmgEl = card.querySelector('.sc-dmg');
      const txt = h.dmg + '%';
      if (dmgEl.textContent !== txt) {
        dmgEl.textContent = txt;
        dmgEl.style.color = dmgColor(h.dmg);
        if (!reduceMotion) { dmgEl.classList.remove('bump'); void dmgEl.offsetWidth; dmgEl.classList.add('bump'); }
      }
      const itemEl = card.querySelector('.sc-item');
      const icon = (h.glove ? '🥊' : '') + (ITEM_ICONS[h.item] || '');
      if (itemEl.textContent !== icon) itemEl.textContent = icon;
      const pipsEl = card.querySelector('.sc-pips');
      const want = roundsToWin, have = gamePoints[pid] || 0;
      if (pipsEl.children.length !== want) {
        pipsEl.innerHTML = '';
        for (let k = 0; k < want; k++) { const d = document.createElement('span'); d.className = 'pip'; pipsEl.appendChild(d); }
      }
      for (let k = 0; k < pipsEl.children.length; k++) pipsEl.children[k].classList.toggle('on', k < have);
    }
  }

  function standingsRow(r, cls, winIds) {
    const row = document.createElement('div'); row.className = cls + '-row' + (winIds.indexOf(r.id) >= 0 ? ' win' : '');
    const dot = document.createElement('span'); dot.className = cls + '-dot'; dot.style.background = r.color;
    const nm = document.createElement('span'); nm.className = cls + '-name pname'; nm.textContent = r.name + (r.isBot ? ' 🤖' : ''); nm.style.color = r.color;
    const pips = document.createElement('span'); pips.className = cls + '-pips';
    for (let k = 0; k < roundsToWin; k++) {
      const d = document.createElement('span'); d.className = 'pip' + (k < (gamePoints[r.id] || 0) ? ' on' : '');
      pips.appendChild(d);
    }
    row.appendChild(dot); row.appendChild(nm); row.appendChild(pips);
    return row;
  }

  function sortedRoster() {
    return roster.slice().sort(function (a, b) { return (gamePoints[b.id] || 0) - (gamePoints[a.id] || 0) || a.seat - b.seat; });
  }

  function renderRoundOverlay(winnerId, wipeout) {
    roBadge.textContent = '🏆';
    roTitle.innerHTML = '';
    const nm = document.createElement('span'); nm.className = 'pname'; nm.textContent = nameOf(winnerId); nm.style.color = colorOf(winnerId);
    roTitle.appendChild(nm);
    roTitle.appendChild(document.createTextNode(' wins the round!'));
    roSub.textContent = wipeout ? 'Everyone went flying — they lasted longest.' : 'Last ragdoll standing.';
    roList.innerHTML = '';
    sortedRoster().forEach(function (r) { roList.appendChild(standingsRow(r, 'ro', [winnerId])); });
    roundOverlay.hidden = false;
  }

  function renderFinal(champs) {
    finalHeading.innerHTML = '';
    // A big tie is summarised ("A, B & 6 more win!") — the full list is right below.
    const shown = champs.length > 3 ? champs.slice(0, 2) : champs;
    const more = champs.length - shown.length;
    shown.forEach(function (id, i) {
      if (i > 0) finalHeading.appendChild(document.createTextNode(i === shown.length - 1 && !more ? ' & ' : ', '));
      const s = document.createElement('span'); s.className = 'pname'; s.textContent = nameOf(id); s.style.color = colorOf(id);
      finalHeading.appendChild(s);
    });
    if (more) finalHeading.appendChild(document.createTextNode(' & ' + more + ' more'));
    finalHeading.appendChild(document.createTextNode(champs.length > 1 ? ' win!' : (champs.length ? ' wins!' : 'Game over')));
    finalList.innerHTML = '';
    sortedRoster().forEach(function (r) { finalList.appendChild(standingsRow(r, 'fn', champs)); });
    show('final');
  }

  // ---------------- Confetti ----------------
  function launchConfetti(tint) {
    if (reduceMotion) return;
    const colors = [tint || '#FFC93C', '#FF4757', '#FFFFFF', '#3DDC84', '#3DA5FF'];
    for (let i = 0; i < 90; i++) {
      const d = document.createElement('div');
      d.className = 'confetti';
      d.style.left = (Math.random() * 100) + 'vw';
      d.style.background = colors[(Math.random() * colors.length) | 0];
      d.style.animationDelay = (Math.random() * 0.6) + 's';
      d.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
      document.body.appendChild(d);
      setTimeout(function () { d.remove(); }, 3400);
    }
  }

  // ---------------- Input + presence relays ----------------
  socket.on('in', function (d) {
    if (!world || !d || matchState !== 'play' || paused) return;
    world.setInput(d.id, d.x, d.y, d.b, d.jp, d.ap);
  });
  // A dropped phone just lets go of the controls — the fighter stays in the fight.
  socket.on('player:dropped', function (d) {
    if (!world || !d) return;
    world.setInput(d.id, 0, 0, 0);
  });

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

  // ---------------- Boot ----------------
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      reactionsMuted = !!res.reactionsMuted; updateMuteBtn();
      renderQR();
      renderLobby(res.lobby);
      roundsToWin = res.lobby.roundsToWin;
      roundLengthSec = res.lobby.roundLengthSec;
      items = res.lobby.items;
      stageSet = res.lobby.stageSet;
      botDifficulty = res.lobby.botDifficulty;
      if (res.phase === 'LOBBY') {
        if (matchState !== 'idle') resetLocal();
        show('lobby');
      } else if (res.phase === 'PLAYING' && res.match) {
        // Host refreshed mid-match: replay the CURRENT round fresh, keeping the
        // round number, its stage and the rounds won (physics can't be restored).
        if (matchState === 'idle') startMatch(res.match.roster, res.match, { gamePoints: res.match.gamePoints, round: res.match.round, stage: res.match.stage });
      } else if (res.phase === 'FINAL' && res.match) {
        roster = res.match.roster || [];
        gamePoints = res.match.gamePoints || {};
        roundsToWin = res.match.roundsToWin;
        renderFinal(res.match.winnerIds || []);
      }
      if (window.Iris && typeof window.Iris.ready === 'function') window.Iris.ready();
    });
  });

  socket.on('state:lobby', function (l) {
    if (l && l.phase === 'LOBBY') {
      renderLobby(l);
      if (!views.match.classList.contains('active') && !views.final.classList.contains('active')) show('lobby');
    }
  });

  function resetLocal() {
    stopLoop();
    pClearAll();
    clearResumeCount();
    countdownTimer = null; roundOverTimer = null;
    paused = false;
    matchState = 'idle'; world = null; renderer = null; lastHumanTotal = -1;
    bots = []; sdStarted = false; prevHud = {};
    if (roundOverlay) roundOverlay.hidden = true;
    if (countOverlay) countOverlay.hidden = true;
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
  }
  socket.on('state:reset', function () {
    resetLocal();
    show('lobby');
  });

  window.addEventListener('resize', function () { if (renderer) renderer.resize(); });
})();
