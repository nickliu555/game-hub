(function () {
  'use strict';

  const socket = io('/liarsdice', { transports: ['polling', 'websocket'] });

  // ---------------- Dice ----------------
  // Pip slots in a 3×3 grid, read left→right, top→bottom.
  const PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  const FACE_WORD = { 1: '1s', 2: '2s', 3: '3s', 4: '4s', 5: '5s', 6: '6s' };

  function fillDie(d, face) {
    d.innerHTML = '';
    if (face) d.dataset.face = face; else delete d.dataset.face;
    for (let i = 0; i < 9; i++) {
      const p = document.createElement('span');
      p.className = 'pip' + (face && PIPS[face].indexOf(i) >= 0 ? ' on' : '');
      d.appendChild(p);
    }
  }
  /** A die showing `face`, or a face-down die when `face` is falsy. */
  function makeDie(face, cls) {
    const d = document.createElement('span');
    d.className = 'die' + (face ? '' : ' back') + (cls ? ' ' + cls : '');
    d.setAttribute('aria-label', face ? 'Die showing ' + face : 'Hidden die');
    fillDie(d, face);
    return d;
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function nameSpan(name, seat, cls) {
    const s = document.createElement('span');
    s.className = 'pname' + (cls ? ' ' + cls : '');
    if (seat) s.dataset.seat = seat;
    s.textContent = name;
    return s;
  }
  /** "4 × ⚃" as a quantity plus a real die. */
  function bidNode(qty, face, cls) {
    const w = document.createElement('span');
    w.className = 'bid-chip' + (cls ? ' ' + cls : '');
    const q = document.createElement('span');
    q.className = 'bid-qty';
    q.textContent = qty;
    const x = document.createElement('span');
    x.className = 'bid-x';
    x.textContent = '×';
    w.appendChild(q); w.appendChild(x); w.appendChild(makeDie(face, 'bid-die'));
    w.setAttribute('aria-label', qty + ' × ' + FACE_WORD[face]);
    return w;
  }

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    table: document.getElementById('view-table'),
    final: document.getElementById('view-final'),
  };

  const qrSlot = document.getElementById('qrSlot');
  const joinUrlEl = document.getElementById('joinUrl');
  const playerCountEl = document.getElementById('playerCount');
  const playerCapEl = document.getElementById('playerCap');
  const seatList = document.getElementById('seatList');
  const addBotBtn = document.getElementById('addBotBtn');
  const startBtn = document.getElementById('startBtn');
  const diceSeg = document.getElementById('diceSeg');

  const tRound = document.getElementById('tRound');
  const tDice = document.getElementById('tDice');
  const statsDock = document.getElementById('statsDock');
  const statsBtn = document.getElementById('statsBtn');
  const statsPop = document.getElementById('statsPop');
  const statsRows = document.getElementById('statsRows');
  const statsClose = document.getElementById('statsClose');
  const stage = document.getElementById('diceStage');
  const tableTop = document.getElementById('tableTop');
  const tcLabel = document.getElementById('tcLabel');
  const tcBid = document.getElementById('tcBid');
  const tcSub = document.getElementById('tcSub');
  const tcVerdict = document.getElementById('tcVerdict');
  const seatLayer = document.getElementById('seatLayer');
  const announceLayer = document.getElementById('announceLayer');
  const waitingNote = document.getElementById('waitingNote');

  const finalTrophy = document.getElementById('finalTrophy');
  const finalHeading = document.getElementById('finalHeading');
  const finalSub = document.getElementById('finalSub');
  const finalList = document.getElementById('finalList');
  const playAgainBtn = document.getElementById('playAgainBtn');

  const connOverlay = document.getElementById('connOverlay');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const resetBtn = document.getElementById('resetBtn');

  // ---------------- View stack ----------------
  let currentView = 'lobby';
  let showTimer = null;
  function forceSingle(name) {
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle('active', k === name);
      views[k].classList.remove('fading-out');
    });
    currentView = name;
  }
  function show(name, done) {
    if (currentView === name) { if (done) done(); return; }
    // Clear any in-flight transition first, or two views can end up .active.
    if (showTimer) { clearTimeout(showTimer); showTimer = null; forceSingle(currentView); }
    const from = views[currentView];
    currentView = name;
    if (!from) { forceSingle(name); if (done) done(); return; }
    from.classList.add('fading-out');
    showTimer = setTimeout(function () {
      showTimer = null;
      forceSingle(name);
      if (done) done();
    }, 300);
  }

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
  // The host screen sits across the room for a whole game; it must never dim.
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

  // ---------------- Audio ----------------
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
    return audioCtx;
  }
  function unlockAudio() {
    const c = getAudioCtx(); if (c && c.state === 'suspended') c.resume();
    primeApplause();
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  function blip(freq, dur, type, gain, when) {
    const c = getAudioCtx(); if (!c) return;
    const t = (when || c.currentTime);
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.2, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function sweep(from, to, dur, type, gain, when) {
    const c = getAudioCtx(); if (!c) return;
    const t = (when || c.currentTime);
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type || 'sawtooth';
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  /** White-noise burst — the basis of the dice rattle, cup lifts and applause. */
  function noise(dur, gain, filterHz, when, filterType) {
    const c = getAudioCtx(); if (!c) return;
    const t = (when || c.currentTime);
    const frames = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = filterType || 'bandpass';
    f.frequency.setValueAtTime(filterHz || 2000, t);
    const g = c.createGain();
    g.gain.setValueAtTime(gain || 0.14, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(c.destination);
    src.start(t); src.stop(t + dur);
  }

  function playJoinDing() {
    const c = getAudioCtx(); if (!c || c.state === 'suspended') return;
    blip(880, 0.12, 'sine', 0.26);
    blip(1174.66, 0.3, 'sine', 0.22, c.currentTime + 0.08);
  }
  function playStartFanfare() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [392, 523, 659, 784].forEach(function (f, i) { blip(f, 0.32, 'triangle', 0.2, b + i * 0.11); });
  }
  /** Dice clattering in a cup, then spilling: the "new round, look up!" cue. */
  function playDiceRattle() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < 22; i++) {
      const t = b + i * 0.055 + Math.random() * 0.03;
      noise(0.03, 0.09 + Math.random() * 0.05, 2400 + Math.random() * 2200, t);
      if (i % 3 === 0) blip(260 + Math.random() * 140, 0.05, 'triangle', 0.07, t);
    }
    for (let i = 0; i < 5; i++) {
      const t = b + 1.3 + i * 0.09 + Math.random() * 0.04;
      blip(190 + Math.random() * 80, 0.07, 'triangle', 0.16, t);
      noise(0.04, 0.1, 900, t, 'lowpass');
    }
    [523, 659, 784].forEach(function (f, i) { blip(f, 0.22, 'sine', 0.12, b + 1.75 + i * 0.08); });
  }
  /** "Look up!" cue when the action moves to a new player. */
  function playTurnCue() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [659, 880].forEach(function (f, i) { blip(f, 0.16, 'sine', 0.16, b + i * 0.075); });
  }
  /** A bid: a knuckle rap on the table. */
  function playBid() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [0, 0.1].forEach(function (d) { blip(160, 0.09, 'triangle', 0.28, b + d); noise(0.05, 0.08, 500, b + d, 'lowpass'); });
    blip(587, 0.18, 'sine', 0.1, b + 0.2);
  }
  /** "BS!": a dramatic descending brass stab. */
  function playBsSting() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    sweep(520, 120, 0.7, 'sawtooth', 0.18, b);
    [311, 294, 277].forEach(function (f, i) { blip(f, 0.34, 'square', 0.09, b + 0.08 + i * 0.16); });
    noise(0.25, 0.12, 300, b, 'lowpass');
  }
  /** "Spot on!": a rising shimmer. */
  function playSpotSting() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    sweep(220, 880, 0.55, 'triangle', 0.16, b);
    [659, 880, 1109, 1319].forEach(function (f, i) { blip(f, 0.3, 'sine', 0.12, b + 0.35 + i * 0.07); });
  }
  /** One cup lifting; the pitch climbs as the count does. */
  function playCupLift(step, matches) {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    noise(0.14, 0.07, 1400, b, 'bandpass');
    blip(330 + step * 40, 0.12, 'triangle', 0.14, b + 0.05);
    for (let i = 0; i < Math.min(matches, 6); i++) blip(880 + step * 30 + i * 60, 0.09, 'sine', 0.08, b + 0.14 + i * 0.06);
  }
  /** The count settles it: a triumphant gotcha. */
  function playVerdictWin() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.34, 'triangle', 0.18, b + i * 0.09); });
  }
  /** …or a sad trombone for whoever called it wrong. */
  function playVerdictLose() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [392, 370, 349].forEach(function (f, i) { sweep(f, f * 0.94, 0.3, 'sawtooth', 0.1, b + i * 0.28); });
    sweep(330, 262, 0.7, 'sawtooth', 0.11, b + 0.84);
  }
  function playDieLost() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    blip(140, 0.18, 'triangle', 0.3, b);
    noise(0.12, 0.12, 600, b, 'lowpass');
    blip(110, 0.22, 'triangle', 0.18, b + 0.14);
  }
  function playDieGained() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [1047, 1319, 1568, 2093].forEach(function (f, i) { blip(f, 0.2, 'sine', 0.12, b + i * 0.06); });
  }
  /** Someone is out. */
  function playSad() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [392, 370, 349, 294].forEach(function (f, i) { blip(f, i === 3 ? 0.7 : 0.3, 'triangle', 0.18, b + i * 0.26); });
  }
  // Trivia's winner celebration: its applause recording (or its crowd-clap synth if the file
  // can't load) over its cheer chord.
  const sfxApplause = document.getElementById('sfx-applause');
  let applauseFileAvailable = null;
  let applausePending = false;
  if (sfxApplause) {
    sfxApplause.addEventListener('canplaythrough', function () { applauseFileAvailable = true; });
    sfxApplause.addEventListener('error', function () { applauseFileAvailable = false; });
  }
  function playApplause(durationSec) {
    if (sfxApplause && applauseFileAvailable !== false) {
      try {
        sfxApplause.currentTime = 0;
        const p = sfxApplause.play();
        // Blocked by the autoplay policy: replay on the next gesture.
        if (p && p.catch) p.catch(function () { applausePending = true; });
        return;
      } catch (_) { applausePending = true; return; }
    }
    playApplauseSynth(durationSec || 4);
  }
  function playApplauseSynth(durationSec) {
    const ctx = getAudioCtx();
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    const dur = Math.max(1.0, durationSec || 4);
    const sampleRate = ctx.sampleRate;
    const clapLen = Math.floor(sampleRate * 0.05);
    const clapBuf = ctx.createBuffer(1, clapLen, sampleRate);
    const clapData = clapBuf.getChannelData(0);
    for (let i = 0; i < clapLen; i++) clapData[i] = (Math.random() * 2 - 1);
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    const totalClaps = Math.floor(24 * dur);
    for (let i = 0; i < totalClaps; i++) {
      const when = Math.random() * dur;
      let densityScale;
      if (when < 0.4) densityScale = when / 0.4;
      else if (when < dur - 0.6) densityScale = 1.0;
      else densityScale = Math.max(0, (dur - when) / 0.6);
      if (Math.random() > densityScale) continue;
      const t = t0 + when;
      const src = ctx.createBufferSource();
      src.buffer = clapBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1700 + Math.random() * 1500;
      bp.Q.value = 1.0 + Math.random() * 0.6;
      const env = ctx.createGain();
      const peakVol = 0.2 + Math.random() * 0.25;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peakVol, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05 + Math.random() * 0.03);
      let lastNode = env;
      if (ctx.createStereoPanner) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = (Math.random() * 2 - 1) * 0.7;
        env.connect(pan);
        lastNode = pan;
      }
      src.connect(bp).connect(env);
      lastNode.connect(master);
      src.start(t);
      src.stop(t + 0.06);
    }
  }
  /** Trivia's first-place cheer chord. */
  function playCheerChord() {
    const ctx = getAudioCtx();
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const freqs = [392.00, 493.88, 587.33, 783.99];
    const dur = 1.6;
    const vol = 0.7;
    freqs.forEach(function (f, i) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(vol / freqs.length, t + 0.02 + i * 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    });
  }
  // Prime the media element during a user gesture so the later, state-driven
  // play() call is permitted by the autoplay policy.
  function primeApplause() {
    if (!sfxApplause || applausePending || !sfxApplause.paused) return;
    try {
      sfxApplause.muted = true;
      const p = sfxApplause.play();
      if (p && p.then) {
        p.then(function () {
          sfxApplause.pause();
          sfxApplause.currentTime = 0;
          sfxApplause.muted = false;
        }).catch(function () { sfxApplause.muted = false; });
      } else {
        sfxApplause.muted = false;
      }
    } catch (_) { sfxApplause.muted = false; }
  }
  document.addEventListener('pointerdown', function () {
    if (!applausePending) return;
    applausePending = false;
    playApplause();
  });

  // ---------------- Confetti ----------------
  function confetti() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#D9A84A', '#C0392B', '#4FA9D8', '#E8734A', '#A97BD8', '#86E6A4', '#F7EEDC'];
    for (let i = 0; i < 110; i++) {
      const p = document.createElement('div');
      p.className = 'confetti-piece';
      p.style.left = Math.random() * 100 + 'vw';
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.animationDuration = (2.4 + Math.random() * 2.2) + 's';
      p.style.animationDelay = (Math.random() * 0.7) + 's';
      p.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
      document.body.appendChild(p);
      setTimeout(function () { p.remove(); }, 5600);
    }
  }

  // ---------------- Topbar chrome ----------------
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

  // ---------------- Emotes ----------------
  // Seat bubbles while the table is up; the lobby and the final standings float them.
  const REACTION_MAX = 30;
  const reactionLayer = document.getElementById('reactionLayer');
  function spawnReaction(emoji) {
    if (!emoji || !reactionLayer) return;
    while (reactionLayer.children.length >= REACTION_MAX) reactionLayer.removeChild(reactionLayer.firstChild);
    const e = document.createElement('div');
    e.className = 'reaction-emoji';
    e.textContent = emoji;
    e.style.left = (5 + Math.random() * 90) + '%';
    e.style.fontSize = (44 * (0.85 + Math.random() * 0.5)) + 'px';
    e.style.animationDuration = (3.0 + Math.random() * 1.2) + 's';
    e.addEventListener('animationend', function () { if (e.parentNode) e.parentNode.removeChild(e); });
    reactionLayer.appendChild(e);
  }

  const EMOTE_SHOW_MS = 3500;
  const BUBBLE_GAP = 22;   // same breathing room off the seat as Hearts
  const seatBubbles = {};   // playerId → { el, timer }

  /** Park the bubble beside the seat's box, centred on it, on the side facing the middle of the table. */
  function placeBubble(pid) {
    const rec = seatBubbles[pid];
    const e = seatEls[pid];
    if (!rec || !e) return;
    const root = e.root;
    const box = e.box;
    const boxLeft = root.offsetLeft - root.offsetWidth / 2 + box.offsetLeft;
    const y = root.offsetTop - root.offsetHeight / 2 + box.offsetTop + box.offsetHeight / 2;
    const onRight = root.offsetLeft > tableTop.offsetLeft + tableTop.offsetWidth * 0.58;
    rec.el.classList.toggle('eb-left', onRight);
    rec.el.style.left = Math.round(onRight ? boxLeft - BUBBLE_GAP : boxLeft + box.offsetWidth + BUBBLE_GAP) + 'px';
    rec.el.style.top = Math.round(y) + 'px';
  }
  function placeBubbles() { Object.keys(seatBubbles).forEach(placeBubble); }

  function clearSeatBubbles() {
    Object.keys(seatBubbles).forEach(function (pid) {
      clearTimeout(seatBubbles[pid].timer);
      seatBubbles[pid].el.remove();
      delete seatBubbles[pid];
    });
  }

  function showSeatEmote(pid, e) {
    if (!seatEls[pid]) return;
    const old = seatBubbles[pid];
    if (old) { clearTimeout(old.timer); old.el.remove(); }
    const el = document.createElement('div');
    el.className = 'emote-bubble on-seat';
    el.textContent = e;
    seatLayer.appendChild(el);
    const rec = { el: el, timer: null };
    seatBubbles[pid] = rec;
    placeBubble(pid);
    rec.timer = setTimeout(function () {
      if (seatBubbles[pid] !== rec) return;
      el.remove();
      delete seatBubbles[pid];
    }, EMOTE_SHOW_MS);
  }

  socket.on('host:emote', function (p) {
    if (!p || typeof p.id !== 'string' || typeof p.e !== 'string') return;
    if (p.kind === 'bubble' && currentView === 'table' && seatEls[p.id]) showSeatEmote(p.id, p.e);
    else spawnReaction(p.e);
  });

  let reactionsMuted = false;
  const muteBtn = document.getElementById('muteReactionsBtn');
  function updateMuteBtn() {
    if (!muteBtn) return;
    if (reactionsMuted) { muteBtn.textContent = '🔕 Reactions: Off'; muteBtn.classList.add('is-muted'); }
    else { muteBtn.textContent = '🔔 Reactions: On'; muteBtn.classList.remove('is-muted'); }
  }
  if (muteBtn) muteBtn.addEventListener('click', function () {
    socket.emit('host:setReactionsMuted', { muted: !reactionsMuted }, function (res) {
      if (res && res.ok) { reactionsMuted = !!res.reactionsMuted; updateMuteBtn(); }
    });
  });
  socket.on('state:reactionsMuted', function (p) { reactionsMuted = !!(p && p.muted); updateMuteBtn(); });
  updateMuteBtn();

  const hubBtn = document.getElementById('hubBtn');
  if (hubBtn) {
    hubBtn.addEventListener('click', function (e) {
      e.preventDefault();
      const origin = { clientX: e.clientX, clientY: e.clientY, currentTarget: hubBtn };
      showInlineConfirm('Leaving will reset the game and kick all players. Go back to the hub?', function () {
        let navigated = false;
        const go = function () {
          if (navigated) return; navigated = true;
          if (window.Iris && typeof window.Iris.transitionTo === 'function') {
            window.Iris.transitionTo('/', origin, window.Iris.HUB);
          } else window.location.href = '/';
        };
        socket.emit('host:leave', {}, go);
        setTimeout(go, 600);
      }, { okLabel: 'Leave & Reset', danger: true });
    });
  }

  // ---------------- Lobby ----------------
  let lobby = { players: [], total: 0, capacity: 8, canStart: false, startDice: 5 };
  let lastHumanTotal = -1;
  let dragActive = false;    // a row is mid-drag; defer lobby rebuilds
  let pendingLobby = null;   // latest snapshot to apply once the drag settles

  function renderQR() {
    fetch('/api/liarsdice/config').then(function (r) { return r.json(); }).then(function (cfg) {
      const url = (cfg && cfg.joinUrl) || (window.location.origin + '/liarsdice/join');
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      return fetch('/api/liarsdice/qr?url=' + encodeURIComponent(url));
    }).then(function (r) { return r.text(); }).then(function (svg) { qrSlot.innerHTML = svg; }).catch(function () {});
  }

  function setSeg(seg, value) {
    if (!seg) return;
    Array.prototype.forEach.call(seg.querySelectorAll('.seg-btn'), function (b) {
      b.classList.toggle('on', b.dataset.value === String(value));
    });
  }

  function renderLobby(l) {
    if (!l) return;
    if (dragActive) { pendingLobby = l; return; }   // don't rebuild under a drag
    lobby = l;

    const humanTotal = l.players.filter(function (p) { return !p.isBot; }).length;
    if (lastHumanTotal >= 0 && humanTotal > lastHumanTotal) playJoinDing();
    lastHumanTotal = humanTotal;

    playerCountEl.textContent = l.total;
    playerCapEl.textContent = l.capacity;
    setSeg(diceSeg, l.startDice);

    seatList.innerHTML = '';
    l.players.forEach(function (p) {
      const row = document.createElement('div');
      row.className = 'seat-row' + (p.connected === false ? ' disconnected' : '');
      row.dataset.pid = p.id;

      const grip = document.createElement('span');
      grip.className = 'seat-grip'; grip.textContent = '⠿'; grip.title = 'Drag to reseat';

      const badge = document.createElement('span');
      badge.className = 'seat-badge'; badge.dataset.seat = p.seat; badge.textContent = p.seat;

      const name = document.createElement('span');
      name.className = 'seat-name pname'; name.textContent = p.name;

      row.appendChild(grip); row.appendChild(badge); row.appendChild(name);

      if (p.isBot) {
        const tag = document.createElement('span');
        tag.className = 'seat-tag'; tag.textContent = 'CPU';
        row.appendChild(tag);
      } else if (p.connected === false) {
        const tag = document.createElement('span');
        tag.className = 'seat-tag'; tag.textContent = 'Away';
        row.appendChild(tag);
      }

      const kick = document.createElement('button');
      kick.className = 'seat-kick'; kick.type = 'button'; kick.textContent = '✕';
      kick.title = p.isBot ? 'Remove CPU' : 'Remove player';
      kick.addEventListener('click', function (e) {
        e.stopPropagation();
        if (p.isBot) { socket.emit('host:kick', { playerId: p.id }); return; }
        showInlineConfirm('Remove ' + p.name + ' from the table?', function () {
          socket.emit('host:kick', { playerId: p.id });
        }, { okLabel: 'Remove', danger: true });
      });
      row.appendChild(kick);
      seatList.appendChild(row);
    });

    for (let i = l.players.length; i < l.capacity; i++) {
      const e = document.createElement('div');
      e.className = 'seat-empty';
      e.textContent = 'Seat ' + (i + 1) + ' · open';
      seatList.appendChild(e);
    }

    startBtn.disabled = !l.canStart;
    addBotBtn.disabled = l.total >= l.capacity;
  }

  // ---- Pointer-drag to reseat (order = seat 1, 2, 3 … clockwise) ----
  (function setupLobbyDrag() {
    let reduceMotion = false;
    try { reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    let d = null;

    function rows() {
      return Array.prototype.slice.call(seatList.querySelectorAll('.seat-row'))
        .filter(function (c) { return !d || c !== d.el; });
    }
    function measure() { return rows().map(function (c) { return [c, c.getBoundingClientRect().top]; }); }
    function flip(prev) {
      if (reduceMotion || !prev) return;
      const moved = [];
      prev.forEach(function (rec) {
        const c = rec[0]; if (!c.isConnected) return;
        const delta = rec[1] - c.getBoundingClientRect().top;
        if (delta) { c.style.transition = 'none'; c.style.transform = 'translateY(' + delta + 'px)'; moved.push(c); }
      });
      if (!moved.length) return;
      document.body.getBoundingClientRect();   // force reflow before releasing
      moved.forEach(function (c) { c.style.transition = 'transform 0.2s cubic-bezier(0.2,0.7,0.2,1)'; c.style.transform = ''; });
    }
    function positionPlaceholder(y) {
      const cs = rows();
      let before = null;
      for (let i = 0; i < cs.length; i++) {
        const r = cs[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) { before = cs[i]; break; }
      }
      if (!before) before = seatList.querySelector('.seat-empty');
      if (d.ph.nextElementSibling === before) return;
      const prev = measure();
      seatList.insertBefore(d.ph, before);
      flip(prev);
    }
    function beginLift() {
      d.active = true; dragActive = true;
      const r = d.el.getBoundingClientRect();
      d.offX = d.downX - r.left; d.offY = d.downY - r.top;
      d.ph = document.createElement('div');
      d.ph.className = 'chip-placeholder';
      d.ph.style.height = r.height + 'px';
      d.el.parentNode.insertBefore(d.ph, d.el);
      // The active .view keeps a filling transform animation, which makes it the
      // containing block for position:fixed — so the row has to leave it.
      document.body.appendChild(d.el);
      d.el.style.position = 'fixed'; d.el.style.left = '0'; d.el.style.top = '0';
      d.el.style.width = r.width + 'px'; d.el.style.margin = '0'; d.el.style.zIndex = '120';
      d.el.style.pointerEvents = 'none'; d.el.style.transition = 'none';
      d.el.classList.add('dragging');
    }
    function onMove(e) {
      if (!d) return;
      if (e.cancelable) e.preventDefault();
      const x = e.clientX, y = e.clientY;
      if (!d.active) {
        if (Math.abs(x - d.downX) < 5 && Math.abs(y - d.downY) < 5) return;
        beginLift();
      }
      d.el.style.transform = 'translate(' + (x - d.offX) + 'px,' + (y - d.offY) + 'px) scale(1.03)';
      positionPlaceholder(y);
    }
    function onUp() {
      if (!d) return;
      const cur = d; d = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!cur.active) return;   // never crossed the threshold → it was a tap

      if (!cur.ph.parentNode) {
        cur.el.remove();
        dragActive = false;
        renderLobby(pendingLobby || lobby);
        pendingLobby = null;
        return;
      }

      let next = cur.ph.nextElementSibling;
      while (next && !next.classList.contains('seat-row')) next = next.nextElementSibling;
      const beforeId = next ? next.dataset.pid : null;

      const el = cur.el;
      const floatRect = el.getBoundingClientRect();
      cur.ph.parentNode.insertBefore(el, cur.ph); cur.ph.remove();
      el.style.position = ''; el.style.left = ''; el.style.top = ''; el.style.width = '';
      el.style.margin = ''; el.style.zIndex = ''; el.style.pointerEvents = '';
      let cleaned = false;
      const done = function () {
        if (cleaned) return; cleaned = true;
        el.classList.remove('dragging'); el.style.transition = ''; el.style.transform = '';
        el.removeEventListener('transitionend', done);
      };
      if (reduceMotion) done();
      else {
        const dest = el.getBoundingClientRect();
        el.style.transition = 'none';
        el.style.transform = 'translate(' + (floatRect.left - dest.left) + 'px,' + (floatRect.top - dest.top) + 'px) scale(1.03)';
        document.body.getBoundingClientRect();
        el.style.transition = 'transform 0.2s cubic-bezier(0.2,0.7,0.2,1)';
        el.style.transform = '';
        el.addEventListener('transitionend', done);
        setTimeout(done, 260);
      }
      dragActive = false;
      if (pendingLobby) { const pl = pendingLobby; pendingLobby = null; renderLobby(pl); }
      socket.emit('host:reorder', { playerId: cur.pid, beforeId: beforeId }, function (res) {
        if (res && !res.ok) renderLobby(lobby);   // server said no — snap back
      });
    }
    function onDown(e) {
      if (e.button != null && e.button !== 0) return;
      if (!e.target || e.target.closest('.seat-kick')) return;   // kick isn't a handle
      const el = e.target.closest('.seat-row');
      if (!el || d) return;
      e.preventDefault();
      d = { el: el, pid: el.dataset.pid, downX: e.clientX, downY: e.clientY, active: false, offX: 0, offY: 0, ph: null };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }
    seatList.addEventListener('pointerdown', onDown);
  })();

  addBotBtn.addEventListener('click', function () {
    socket.emit('host:addBot', {}, function (res) { if (res && !res.ok) toast('Could not add a CPU.'); });
  });

  // Segmented config — update locally for snap, then confirm with the server.
  diceSeg.addEventListener('click', function (e) {
    const btn = e.target.closest('.seg-btn');
    if (!btn || btn.classList.contains('on')) return;
    setSeg(diceSeg, btn.dataset.value);
    socket.emit('host:setStartDice', { startDice: Number(btn.dataset.value) }, function (res) {
      if (res && !res.ok) renderLobby(lobby);   // rejected — resync from truth
    });
  });

  startBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
      if (res && !res.ok) toast('Could not start — the table needs at least 2 players.');
      else { lastEventSeq = 0; lastActedSeq = 0; playStartFanfare(); }
    });
  });

  playAgainBtn.addEventListener('click', function () {
    showInlineConfirm('Back to the lobby? Everyone will need to rejoin.', function () {
      socket.emit('host:reset', {});
    }, { okLabel: 'Back to lobby' });
  });

  // ---------------- Clock ----------------
  let clockOffset = 0;
  function syncClock(payload) {
    if (payload && typeof payload.serverNow === 'number') clockOffset = payload.serverNow - Date.now();
  }
  function serverNow() { return Date.now() + clockOffset; }

  // ---------------- The table ----------------
  let seatEls = {};          // playerId → element refs
  let seatOrderIds = [];
  let seatByPlayer = {};
  let lastEventSeq = -1;     // -1 until the first render adopts the current event silently
  let lastActedSeq = -1;
  let lastTurnId = null;
  let lastRoundSeen = 0;
  let lastTable = null;

  function ensureSeats(seats) {
    const ids = seats.map(function (s) { return s.playerId; });
    if (ids.join('|') === seatOrderIds.join('|')) return;
    seatOrderIds = ids;
    clearSeatBubbles();
    seatEls = {};
    seatLayer.innerHTML = '';
    seats.forEach(function (s) {
      const root = document.createElement('div');
      root.className = 'seat';
      root.dataset.seat = s.seat;
      const box = document.createElement('div');
      box.className = 'seat-box';
      const label = document.createElement('div');
      label.className = 'seat-label';
      const pip = document.createElement('span');
      pip.className = 'seat-pip'; pip.dataset.seat = s.seat; pip.textContent = s.seat;
      const name = document.createElement('span');
      name.className = 'pname';
      label.appendChild(pip); label.appendChild(name);
      const dice = document.createElement('div');
      dice.className = 'seat-dice';
      box.appendChild(label); box.appendChild(dice);
      const action = document.createElement('div');
      action.className = 'seat-action';
      root.appendChild(box); root.appendChild(action);
      seatLayer.appendChild(root);
      seatEls[s.playerId] = { root: root, box: box, name: name, dice: dice, action: action, diceKey: '', actionKey: '' };
    });
    layoutSeats();
  }

  /**
   * Place every seat on the rail of the oval, clockwise from the bottom
   * centre, each name plate just overlapping the rail from outside.
   * offset* (not client rects) because the view's entry transform skews rects.
   */
  function layoutSeats() {
    const n = seatOrderIds.length;
    if (!n || !stage.offsetWidth) return;
    const sample = seatEls[seatOrderIds[0]];
    const rootW = sample.root.offsetWidth;
    const rootH = sample.root.offsetHeight;
    const boxTop = sample.box.offsetTop;
    const boxH = sample.box.offsetHeight;
    const over = 16;   // how far a plate reaches in over the rail
    const margin = 8;
    const insetX = Math.min(rootW - over + margin, stage.offsetWidth * 0.3);
    const insetTop = Math.min(boxTop + boxH - over + margin, stage.offsetHeight * 0.35);
    const insetBottom = Math.min(rootH - boxTop - over + margin, stage.offsetHeight * 0.35);
    tableTop.style.left = tableTop.style.right = insetX + 'px';
    tableTop.style.top = insetTop + 'px';
    tableTop.style.bottom = insetBottom + 'px';
    if (!tableTop.offsetWidth) return;
    const cx = tableTop.offsetLeft + tableTop.offsetWidth / 2;
    const cy = tableTop.offsetTop + tableTop.offsetHeight / 2;
    const ex = tableTop.offsetWidth / 2 - over;
    const ey = tableTop.offsetHeight / 2 - over;
    const hw = rootW / 2;
    const hh = boxH / 2;
    const boxOffset = boxTop + boxH / 2 - rootH / 2;   // plate centre, relative to the seat's centre
    // Does a plate centred at (x, y) poke inside the (shrunk) rail ellipse anywhere along its edges?
    const intrudes = function (x, y) {
      for (let k = 0; k <= 8; k++) {
        const f = k / 8;
        const pts = [[x - hw + f * 2 * hw, y - hh], [x - hw + f * 2 * hw, y + hh], [x - hw, y - hh + f * 2 * hh], [x + hw, y - hh + f * 2 * hh]];
        for (let j = 0; j < 4; j++) {
          const dx = (pts[j][0] - cx) / ex;
          const dy = (pts[j][1] - cy) / ey;
          if (dx * dx + dy * dy < 1) return true;
        }
      }
      return false;
    };
    seatOrderIds.forEach(function (pid, i) {
      const e = seatEls[pid];
      const a = (90 + i * 360 / n) * Math.PI / 180;
      // Slide the plate out along its ray until it just clears the rail — corners included.
      const ux = Math.cos(a) * ex;
      const uy = Math.sin(a) * ey;
      let lo = 1;
      let hi = 3;
      for (let it = 0; it < 22; it++) {
        const mid = (lo + hi) / 2;
        if (intrudes(cx + ux * mid, cy + uy * mid)) lo = mid; else hi = mid;
      }
      const px = Math.max(hw, Math.min(stage.offsetWidth - hw, cx + ux * hi));
      const py = cy + uy * hi;
      e.root.style.left = Math.round(px) + 'px';
      e.root.style.top = Math.round(py - boxOffset) + 'px';
    });
    fitSeatNames();
    placeBubbles();
    placeAnnounce();
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(layoutSeats).observe(stage);
  window.addEventListener('resize', layoutSeats);

  let nameProbe = null;
  // The seat box is width-capped, so a long name shrinks its own text down to
  // a readable floor rather than wrapping and pushing the dice off the plate.
  function fitSeatName(name) {
    name.style.removeProperty('font-size');
    if (!name.textContent) return;
    const label = name.parentElement;
    const pip = label.firstElementChild;
    const labelCs = getComputedStyle(label);
    const avail = label.clientWidth - pip.offsetWidth - (parseFloat(labelCs.columnGap) || 0);
    if (avail <= 0) return;
    const cs = getComputedStyle(name);
    const natural = parseFloat(cs.fontSize) || 20;
    if (!nameProbe) {
      nameProbe = document.createElement('span');
      nameProbe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:pre;visibility:hidden;pointer-events:none;';
      document.body.appendChild(nameProbe);
    }
    nameProbe.style.font = cs.fontWeight + ' ' + natural + 'px ' + cs.fontFamily;
    nameProbe.style.letterSpacing = cs.letterSpacing;
    nameProbe.textContent = name.textContent;
    const full = nameProbe.offsetWidth;
    if (full <= avail) return;
    name.style.fontSize = Math.max(13, Math.floor(natural * avail / full)) + 'px';
  }
  function fitSeatNames() {
    Object.keys(seatEls).forEach(function (pid) { fitSeatName(seatEls[pid].name); });
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitSeatNames);

  /**
   * Swap a seat's dice only when what they show actually changes, so a
   * re-render doesn't restart their animations.
   * spec: { faces: number[]|null, count, match: bool[], lost: bool, gained: bool }
   */
  function setSeatDice(e, spec) {
    const key = JSON.stringify(spec);
    if (key === e.diceKey) return;
    const wasFaces = e.diceKey && JSON.parse(e.diceKey).faces;
    e.diceKey = key;
    e.dice.innerHTML = '';
    const n = spec.faces ? spec.faces.length : spec.count;
    for (let i = 0; i < n; i++) {
      const face = spec.faces ? spec.faces[i] : 0;
      const cls = [];
      if (spec.faces && !wasFaces) cls.push('flip-in');
      if (spec.faces) cls.push(spec.match[i] ? (face === 1 ? 'match wild' : 'match') : 'miss');
      if (spec.lost && i === n - 1) cls.push('lost');
      const d = makeDie(face, cls.join(' '));
      if (spec.faces && !wasFaces) d.style.animationDelay = (i * 0.07) + 's';
      e.dice.appendChild(d);
    }
    if (spec.gained) e.dice.appendChild(makeDie(0, 'gained'));
  }

  function setSeatAction(e, a) {
    const key = a ? JSON.stringify(a) : '';
    if (key === e.actionKey) return;
    e.actionKey = key;
    e.action.innerHTML = '';
    e.action.className = 'seat-action';
    if (!a) return;
    if (a.type === 'bid') {
      e.action.classList.add('a-bid');
      e.action.appendChild(bidNode(a.qty, a.face));
    } else if (a.type === 'bs') {
      e.action.classList.add('a-bs');
      e.action.textContent = 'Called BS!';
    } else if (a.type === 'spot') {
      e.action.classList.add('a-spot');
      e.action.textContent = 'Spot on!';
    }
  }

  function renderSeats(s, rv) {
    const seats = s.seats.filter(function (seat) { return !seat.busted; });
    ensureSeats(seats);
    const prog = rv ? revealProgress(rv) : null;
    seats.forEach(function (seat) {
      const e = seatEls[seat.playerId];
      if (!e) return;
      e.root.dataset.seat = seat.seat;
      e.root.classList.toggle('turn', seat.playerId === s.turnPlayerId && !s.turnLocked);
      e.root.classList.toggle('offline', !seat.isBot && seat.connected === false);
      e.root.classList.toggle('rolling', s.phase === 'ROLL');
      if (e.name.textContent !== seat.name) { e.name.textContent = seat.name; fitSeatName(e.name); }

      if (prog) {
        const idx = rv.order.indexOf(seat.playerId);
        const shown = idx >= 0 && idx < prog.revealed;
        const faces = shown ? rv.dice[seat.playerId] : null;
        const delta = prog.fx ? (rv.delta[seat.playerId] || 0) : 0;
        e.root.classList.toggle('revealed', shown);
        e.root.classList.toggle('caller', seat.playerId === rv.callerId);
        e.root.classList.toggle('bidder', seat.playerId === rv.bid.playerId);
        e.root.classList.toggle('loser', prog.verdict && seat.playerId === rv.loserId);
        e.root.classList.toggle('gainer', prog.verdict && seat.playerId === rv.gainerId);
        setSeatDice(e, {
          faces: faces,
          count: seat.diceCount,
          match: faces ? faces.map(function (d) { return d === rv.bid.face || (rv.bid.face !== 1 && d === 1); }) : [],
          lost: delta < 0,
          gained: delta > 0,
        });
        if (prog.ko && rv.knockedOut.indexOf(seat.playerId) >= 0) knockOut(e);
      } else {
        ['revealed', 'caller', 'bidder', 'loser', 'gainer', 'busted', 'just-busted'].forEach(function (c) { e.root.classList.remove(c); });
        e.koDone = false;
        setSeatDice(e, { faces: null, count: seat.diceCount, match: [], lost: false, gained: false });
      }
      setSeatAction(e, seat.lastAction);
    });
    placeBubbles();
  }

  /** The seat shudders, flashes red and fades out; a skull rises where it sat. */
  function knockOut(e) {
    if (e.koDone) return;
    e.koDone = true;
    e.root.classList.add('busted', 'just-busted');
    setTimeout(function () {
      if (!e.root.isConnected) return;
      const skull = document.createElement('div');
      skull.className = 'ko-skull';
      skull.textContent = '💀';
      skull.style.left = e.root.style.left;
      skull.style.top = e.root.style.top;
      seatLayer.appendChild(skull);
      skull.addEventListener('animationend', function () { skull.remove(); });
    }, KO_FADE_MS);
  }
  const KO_FADE_MS = 2200;   // matches .seat.just-busted's knockout animation

  function renderStrip(s) {
    tRound.textContent = s.round;
    tDice.textContent = s.totalDice;
  }

  function renderWaiting(s) {
    waitingNote.innerHTML = '';
    if (!s.waitingOn) { waitingNote.hidden = true; return; }
    waitingNote.appendChild(document.createTextNode('Waiting for '));
    waitingNote.appendChild(nameSpan(s.waitingOn, seatByPlayer[s.turnPlayerId]));
    waitingNote.appendChild(document.createTextNode(' to come back…'));
    waitingNote.hidden = false;
  }

  /** The middle of the table: the bid to beat, the roll, or the count during a reveal. */
  function renderCenter(s, rv) {
    tableTop.classList.toggle('is-rolling', s.phase === 'ROLL');
    tableTop.classList.toggle('is-reveal', !!rv);
    tcBid.innerHTML = '';
    tcSub.innerHTML = '';
    if (!rv) { tcVerdict.hidden = true; tcVerdict.innerHTML = ''; }

    if (s.phase === 'ROLL') {
      tcLabel.textContent = 'Round ' + s.round;
      const cup = document.createElement('span');
      cup.className = 'tc-rolling';
      for (let i = 0; i < 3; i++) cup.appendChild(makeDie(1 + Math.floor(Math.random() * 6), 'tumble'));
      tcBid.appendChild(cup);
      tcSub.appendChild(document.createTextNode('Everyone rolls… '));
      if (s.openerName) {
        tcSub.appendChild(nameSpan(s.openerName, seatByPlayer[s.openerId]));
        tcSub.appendChild(document.createTextNode(' opens'));
      }
      return;
    }

    if (rv) {
      renderRevealCenter(rv);
      return;
    }

    if (s.currentBid) {
      tcLabel.textContent = 'Current bid';
      tcBid.appendChild(bidNode(s.currentBid.qty, s.currentBid.face, 'big'));
      tcSub.appendChild(document.createTextNode('by '));
      tcSub.appendChild(nameSpan(s.currentBid.name, s.currentBid.seat));
    } else {
      tcLabel.textContent = 'Opening bid';
      const q = document.createElement('span');
      q.className = 'tc-question';
      q.textContent = '?';
      tcBid.appendChild(q);
      const turn = s.seats.find(function (x) { return x.playerId === s.turnPlayerId; });
      if (turn) {
        tcSub.appendChild(nameSpan(turn.name, turn.seat));
        tcSub.appendChild(document.createTextNode(' opens the bidding'));
      }
    }
  }

  // ---------------- Announcements ----------------
  const ANNOUNCE_MS = 3000;   // must match BID_ANNOUNCE_MS in server/liarsdice/game.js
  /** Big text over the table for whatever just happened, fading away after a moment. */
  function announce(a) {
    const seat = seatByPlayer[a.playerId];
    const who = lastTable && lastTable.seats.find(function (x) { return x.playerId === a.playerId; });
    if (!who) return;
    announceLayer.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'announce an-' + a.type;
    const name = document.createElement('div');
    name.className = 'an-name';
    name.appendChild(nameSpan(who.name, seat));
    const what = document.createElement('div');
    what.className = 'an-what';
    if (a.type === 'bid') {
      name.appendChild(document.createTextNode(' bids'));
      what.appendChild(bidNode(a.qty, a.face, 'huge'));
    } else {
      what.classList.add('pirate');
      what.textContent = a.type === 'bs' ? 'calls BS!' : 'calls Spot On!';
    }
    el.appendChild(name);
    el.appendChild(what);
    const ms = ANNOUNCE_MS;
    el.style.animationDuration = ms + 'ms';
    announceLayer.appendChild(el);
    placeAnnounce();
    setTimeout(function () { if (el.parentNode) el.remove(); }, ms + 50);
  }

  /** Centre the pop-up on the middle of the table, right over the bid it leaves behind. */
  function placeAnnounce() {
    const el = announceLayer.firstElementChild;
    if (!el || !tableTop.offsetWidth) return;
    el.style.left = Math.round(tableTop.offsetLeft + tableTop.offsetWidth / 2) + 'px';
    el.style.top = Math.round(tableTop.offsetTop + tableTop.offsetHeight / 2) + 'px';
  }

  function playActed(s) {
    const a = s.lastActed;
    if (lastActedSeq < 0) { lastActedSeq = a ? a.seq : 0; return false; }
    if (!a || a.seq === lastActedSeq) return false;
    lastActedSeq = a.seq;
    announce(a);
    if (a.type === 'bid') playBid();
    else if (a.type === 'bs') playBsSting();
    else playSpotSting();
    return true;
  }

  function playEvent(s) {
    const ev = s.lastEvent;
    if (!ev) return;
    if (lastEventSeq < 0) { lastEventSeq = ev.seq; return; }
    if (ev.seq === lastEventSeq) return;
    lastEventSeq = ev.seq;
    if (ev.type === 'roll') playDiceRattle();
  }

  // ---------------- The reveal ----------------
  // Everything is placed on the server's clock, so a refresh mid-reveal picks
  // up exactly where the table is (without replaying the sounds already heard).
  const DIE_FX_DELAY_MS = 1300;
  const KO_DELAY_MS = 1500;
  let revealRun = null;     // { key, rv, timers }

  function revealProgress(rv) {
    const t = serverNow();
    const revealed = t < rv.startAt ? 0 : Math.min(rv.order.length, Math.floor((t - rv.startAt) / rv.stepMs) + 1);
    let tally = 0;
    for (let i = 0; i < revealed; i++) {
      (rv.dice[rv.order[i]] || []).forEach(function (d) { if (d === rv.bid.face || (rv.bid.face !== 1 && d === 1)) tally++; });
    }
    return {
      revealed: revealed,
      tally: tally,
      verdict: t >= rv.verdictAt,
      fx: t >= rv.verdictAt + DIE_FX_DELAY_MS,
      ko: t >= rv.verdictAt + DIE_FX_DELAY_MS + KO_DELAY_MS,
    };
  }

  function stopRevealRun() {
    if (revealRun) revealRun.timers.forEach(clearTimeout);
    revealRun = null;
  }

  function startRevealRun(rv) {
    const key = rv.startAt + ':' + rv.callerId;
    if (revealRun && revealRun.key === key) return;
    stopRevealRun();
    revealRun = { key: key, rv: rv, timers: [] };
    const at = function (when, fn) {
      const wait = when - serverNow();
      if (wait < 0) return;
      revealRun.timers.push(setTimeout(function () {
        if (!revealRun || revealRun.key !== key) return;
        fn();
        refreshReveal();
      }, wait + 15));
    };
    rv.order.forEach(function (pid, i) {
      at(rv.startAt + i * rv.stepMs, function () {
        const matches = (rv.dice[pid] || []).filter(function (d) { return d === rv.bid.face || (rv.bid.face !== 1 && d === 1); }).length;
        playCupLift(i, matches);
      });
    });
    at(rv.verdictAt, function () { if (rv.correct) playVerdictWin(); else playVerdictLose(); });
    at(rv.verdictAt + DIE_FX_DELAY_MS, function () {
      if (rv.loserId) playDieLost();
      else if (rv.gainerId && !rv.capped) playDieGained();
    });
    if (rv.knockedOut.length) at(rv.verdictAt + DIE_FX_DELAY_MS + KO_DELAY_MS, function () { setTimeout(playSad, 300); });
  }

  /** Re-render the table at the reveal's current moment. */
  function refreshReveal() {
    if (!lastTable || lastTable.phase !== 'REVEAL' || !lastTable.reveal) return;
    renderSeats(lastTable, lastTable.reveal);
    renderCenter(lastTable, lastTable.reveal);
  }

  function face(n) { return makeDie(n, 'inline-die'); }

  function renderRevealCenter(rv) {
    const prog = revealProgress(rv);
    tcLabel.innerHTML = '';
    tcLabel.appendChild(nameSpan(rv.callerName, seatByPlayer[rv.callerId]));
    tcLabel.appendChild(document.createTextNode(rv.type === 'bs' ? ' called BS on' : ' called Spot On on'));
    tcBid.appendChild(bidNode(rv.bid.qty, rv.bid.face, 'big'));

    const tally = document.createElement('div');
    tally.className = 'tc-tally';
    const num = document.createElement('span');
    num.className = 'tally-num';
    num.textContent = prog.tally;
    if (revealRun && revealRun.lastTally !== prog.tally) {
      revealRun.lastTally = prog.tally;
      num.classList.add('bump');
    }
    const lbl = document.createElement('span');
    lbl.className = 'tally-label';
    lbl.appendChild(document.createTextNode('counted'));
    if (rv.bid.face !== 1) {
      lbl.appendChild(document.createTextNode(' · '));
      lbl.appendChild(face(1));
      lbl.appendChild(document.createTextNode(' wild'));
    }
    tally.appendChild(num);
    tally.appendChild(lbl);
    tcSub.appendChild(tally);

    if (!prog.verdict) { tcVerdict.hidden = true; tcVerdict.innerHTML = ''; return; }
    const key = 'v:' + rv.startAt;
    if (tcVerdict.dataset.key === key && !tcVerdict.hidden) return;
    tcVerdict.dataset.key = key;
    tcVerdict.innerHTML = '';
    tcVerdict.className = 'tc-verdict ' + (rv.correct ? 'v-right' : 'v-wrong');
    const head = document.createElement('div');
    head.className = 'v-head pirate';
    const body = document.createElement('div');
    body.className = 'v-body';
    const exactly = rv.count === 1 ? 'one' : String(rv.count);
    if (rv.type === 'bs') {
      if (rv.correct) {
        head.textContent = 'Only ' + exactly + '! A bluff!';
        body.appendChild(nameSpan(rv.bid.name, seatByPlayer[rv.bid.playerId]));
        body.appendChild(document.createTextNode(' loses a die'));
      } else {
        head.textContent = rv.count + '! The bid stands';
        body.appendChild(nameSpan(rv.callerName, seatByPlayer[rv.callerId]));
        body.appendChild(document.createTextNode(' loses a die'));
      }
    } else if (rv.correct) {
      head.textContent = 'Exactly ' + exactly + '! Spot on!';
      body.appendChild(nameSpan(rv.callerName, seatByPlayer[rv.callerId]));
      body.appendChild(document.createTextNode(rv.capped ? ' already has a full hand of dice' : ' wins a die back'));
    } else {
      head.textContent = rv.count + ', not ' + rv.bid.qty + '. Not quite!';
      body.appendChild(nameSpan(rv.callerName, seatByPlayer[rv.callerId]));
      body.appendChild(document.createTextNode(' loses a die'));
    }
    tcVerdict.appendChild(head);
    tcVerdict.appendChild(body);
    tcVerdict.hidden = false;
  }

  // ---------------- Render the table ----------------
  function renderTable(s) {
    syncClock(s);
    lastTable = s;
    seatLayer.style.setProperty('--n', s.startDice || 6);
    indexSeats(s.seats);
    renderStrip(s);
    setStats(s.stats);
    const rv = s.phase === 'REVEAL' ? s.reveal : null;
    if (rv) startRevealRun(rv); else stopRevealRun();
    renderSeats(s, rv);
    renderCenter(s, rv);
    renderWaiting(s);

    const wasTable = currentView === 'table';
    show('table', layoutSeats);
    playActed(s);
    playEvent(s);
    // A turn opening is the "look up" moment (after a bid, that's once its pop-up has gone).
    const openTurn = s.phase === 'BIDDING' && !s.turnLocked ? s.turnPlayerId : null;
    if (openTurn && openTurn !== lastTurnId && wasTable && lastRoundSeen === s.round) {
      setTimeout(playTurnCue, 120);
    }
    lastTurnId = openTurn;
    lastRoundSeen = s.round;
  }

  function indexSeats(seats) {
    seatByPlayer = {};
    (seats || []).forEach(function (x) { seatByPlayer[x.playerId] = x.seat; });
  }

  // ---------------- Player stats ----------------
  const STAT_COLS = [
    { key: 'rounds', label: 'Rounds', title: 'Rounds played' },
    { key: 'bids', label: 'Bids', title: 'Bids made' },
    { key: 'bs', label: 'BS calls', title: 'BS calls that were right / BS calls made', ratio: ['bsRight', 'bsCalls'] },
    { key: 'spot', label: 'Spot On', title: 'Spot On calls that were right / Spot On calls made', ratio: ['spotRight', 'spotCalls'] },
    { key: 'caught', label: 'Caught', title: 'Bids exposed as a bluff by a BS call' },
    { key: 'diceLost', label: 'Lost', title: 'Dice lost' },
    { key: 'diceWon', label: 'Won', title: 'Dice won back with Spot On' },
  ];

  function statText(r, c) {
    if (c.ratio) return r[c.ratio[1]] ? r[c.ratio[0]] + ' / ' + r[c.ratio[1]] : '–';
    const v = r[c.key];
    return v == null ? '–' : String(v);
  }

  /** One table for both the mid-game peek and the final screen. */
  function buildStatsTable(rows, opts) {
    const table = document.createElement('table');
    table.className = 'stats-table';
    const head = document.createElement('tr');
    [['', 'st-rank'], ['Player', 'st-player'], [opts.diceLabel, 'st-dice']].forEach(function (h) {
      const th = document.createElement('th');
      th.textContent = h[0]; th.className = h[1];
      head.appendChild(th);
    });
    STAT_COLS.forEach(function (c) {
      const th = document.createElement('th');
      th.textContent = c.label; th.title = c.title;
      head.appendChild(th);
    });
    const thead = document.createElement('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    const body = document.createElement('tbody');
    rows.forEach(function (r, i) {
      const tr = document.createElement('tr');
      tr.dataset.seat = r.seat;
      if (r.playerId === opts.winnerId) tr.classList.add('is-winner');
      if (opts.dimOut && r.busted) tr.classList.add('is-out');

      const rank = document.createElement('td');
      rank.className = 'st-rank'; rank.textContent = opts.rank(r, i);

      const who = document.createElement('td');
      who.className = 'st-player';
      const inner = document.createElement('div');
      inner.className = 'st-player-inner';
      const pip = document.createElement('span');
      pip.className = 'seat-pip'; pip.dataset.seat = r.seat; pip.textContent = r.seat;
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = r.name + (r.isBot && !/^CPU\b/.test(r.name) ? ' (CPU)' : '');
      inner.appendChild(pip); inner.appendChild(name);
      who.appendChild(inner);

      const dice = document.createElement('td');
      dice.className = 'st-dice'; dice.textContent = opts.dice(r);

      tr.appendChild(rank); tr.appendChild(who); tr.appendChild(dice);
      STAT_COLS.forEach(function (c) {
        const td = document.createElement('td');
        td.textContent = statText(r, c);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    return table;
  }

  let statsKey = '';
  function closeStats() {
    statsPop.hidden = true;
    statsBtn.setAttribute('aria-expanded', 'false');
  }
  function hideStatsDock() {
    closeStats();
    statsDock.hidden = true;
    statsKey = '';
  }

  /** Most dice first; anyone already out drops below in finishing order. */
  function setStats(stats) {
    if (!stats) { hideStatsDock(); return; }
    statsDock.hidden = false;
    const key = JSON.stringify(stats);
    if (key === statsKey) return;   // don't rebuild under the host's eyes
    statsKey = key;
    const rows = stats.slice().sort(function (a, b) {
      if (a.busted !== b.busted) return a.busted ? 1 : -1;
      if (a.busted) return a.place - b.place;
      return b.diceCount - a.diceCount || a.name.localeCompare(b.name);
    });
    statsRows.innerHTML = '';
    statsRows.appendChild(buildStatsTable(rows, {
      diceLabel: 'Dice',
      dimOut: true,
      rank: function (r, i) { return r.busted ? ordinal(r.place) : '#' + (i + 1); },
      dice: function (r) { return r.busted ? 'Out' : String(r.diceCount); },
    }));
  }

  statsBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (statsPop.hidden) {
      statsPop.hidden = false;
      statsBtn.setAttribute('aria-expanded', 'true');
    } else closeStats();
  });
  statsClose.addEventListener('click', closeStats);
  document.addEventListener('click', function (e) {
    if (statsPop.hidden) return;
    if (!statsDock.contains(e.target)) closeStats();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !statsPop.hidden) closeStats();
  });

  // ---------------- Final ----------------
  function renderFinal(s) {
    stopRevealRun();
    hideStatsDock();
    announceLayer.innerHTML = '';
    finalTrophy.textContent = '🏆';
    finalHeading.innerHTML = '';
    const champ = (s.standings || []).find(function (r) { return r.playerId === s.winnerId; });
    if (champ) {
      finalHeading.appendChild(nameSpan(champ.name, champ.seat));
      finalHeading.appendChild(document.createTextNode(' wins!'));
    } else {
      finalHeading.textContent = 'Game over';
    }
    finalSub.textContent = 'Last pirate with dice after ' + s.rounds + (s.rounds === 1 ? ' round' : ' rounds');

    finalList.innerHTML = '';
    const rows = (s.stats || []).slice().sort(function (a, b) {
      return (a.place || 1) - (b.place || 1) || a.name.localeCompare(b.name);
    });
    finalList.appendChild(buildStatsTable(rows, {
      diceLabel: 'Result',
      winnerId: s.winnerId,
      rank: function (r) {
        const p = r.place || 1;
        return p === 1 ? '🥇' : (p === 2 ? '🥈' : (p === 3 ? '🥉' : ordinal(p)));
      },
      dice: function (r) {
        if (r.playerId === s.winnerId) return r.diceCount + (r.diceCount === 1 ? ' die left' : ' dice left');
        return 'Out in round ' + r.outRound;
      },
    }));

    if (currentView !== 'final') {
      playCheerChord();
      playApplause(4);
      confetti();
    }
    show('final');
  }

  // ---------------- Socket wiring ----------------
  function authenticate() {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      connOverlay.hidden = true;
      if (res.lobby) renderLobby(res.lobby);
      if (res.phase === 'LOBBY') forceSingle('lobby');
      if (window.Iris && typeof window.Iris.ready === 'function') window.Iris.ready();
    });
  }

  socket.on('connect', function () { connOverlay.hidden = true; authenticate(); });
  socket.on('disconnect', function () { connOverlay.hidden = false; });

  socket.on('state:lobby', function (l) {
    renderLobby(l);
    if (l.phase === 'LOBBY') { hideStatsDock(); show('lobby'); }
  });
  socket.on('state:table', renderTable);
  socket.on('state:final', renderFinal);

  socket.on('state:reset', function () {
    stopRevealRun();
    hideStatsDock();
    seatOrderIds = [];
    clearSeatBubbles();
    seatEls = {};
    seatLayer.innerHTML = '';
    announceLayer.innerHTML = '';
    lastEventSeq = -1;
    lastActedSeq = -1;
    lastTurnId = null;
    lastRoundSeen = 0;
    lastTable = null;
    lastHumanTotal = -1;
    show('lobby');
  });

  // ---------------- Boot ----------------
  renderQR();
})();
