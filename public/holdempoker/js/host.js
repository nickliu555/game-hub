(function () {
  'use strict';

  const socket = io('/holdempoker', { transports: ['polling', 'websocket'] });

  // ---------------- Card assets ----------------
  // Pips and aces are SVG (crisp on a TV); the court cards are WebP. Same
  // geometry either way, so the two formats line up pixel for pixel.
  function cardSrc(code) {
    const rank = code.slice(0, code.length - 1);
    const ext = (rank === 'J' || rank === 'Q' || rank === 'K') ? '.webp' : '.svg';
    return '/holdempoker/assets/cards/' + code + ext;
  }
  function cardImg(code, cls) {
    const img = document.createElement('img');
    img.className = 'card' + (cls ? ' ' + cls : '');
    img.src = cardSrc(code);
    img.alt = cardLabel(code);
    img.draggable = false;
    img.dataset.card = code;
    return img;
  }
  function cardBack() {
    const d = document.createElement('div');
    d.className = 'card card-back';
    d.dataset.card = 'back';
    return d;
  }
  const SUIT_WORD = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };
  function cardLabel(code) {
    return code.slice(0, code.length - 1) + ' of ' + SUIT_WORD[code.slice(-1)];
  }

  function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
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
  const levelSeg = document.getElementById('levelSeg');
  const startNote = document.getElementById('startNote');

  const tLevel = document.getElementById('tLevel');
  const tBlinds = document.getElementById('tBlinds');
  const tBlindsItem = document.getElementById('tBlindsItem');
  const tNext = document.getElementById('tNext');
  const tNextWhen = document.getElementById('tNextWhen');
  const statsDock = document.getElementById('statsDock');
  const statsBtn = document.getElementById('statsBtn');
  const statsPop = document.getElementById('statsPop');
  const statsRows = document.getElementById('statsRows');
  const statsClose = document.getElementById('statsClose');
  const stage = document.getElementById('pokerStage');
  const felt = document.getElementById('felt');
  const boardEl = document.getElementById('board');
  const potTotalEl = document.getElementById('potTotal');
  const potLineEl = document.getElementById('potLine');
  const sidePotsEl = document.getElementById('sidePots');
  const seatLayer = document.getElementById('seatLayer');
  const handLineEl = document.getElementById('handLine');
  const levelBanner = document.getElementById('levelBanner');
  const levelDim = document.getElementById('levelDim');
  const levelBannerValue = document.getElementById('levelBannerValue');
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
    if (name !== 'final') {
      if (window.clearConfetti) window.clearConfetti();
      if (window.stopApplause) window.stopApplause();
    }
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
  /** White-noise burst — the basis of card riffles, chips and applause. */
  function noise(dur, gain, filterHz, when, filterType) {
    const c = getAudioCtx(); if (!c) return;
    const t = (when || c.currentTime);
    const frames = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
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
  /** Cards riffling out to every seat. */
  function playDealRiffle() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < 10; i++) noise(0.05, 0.075, 2600 + Math.random() * 1400, b + i * 0.075);
  }
  function playCardFlip(when) { noise(0.07, 0.09, 3200, when); }
  function playBoardCards(n) {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < n; i++) playCardFlip(b + i * 0.14);
  }
  /** "Look up!" cue when the action moves to a new player. */
  function playTurnCue() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [659, 880].forEach(function (f, i) { blip(f, 0.16, 'sine', 0.16, b + i * 0.075); });
  }
  /** Two knuckle taps on the felt. */
  function playCheck() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [0, 0.11].forEach(function (d) { blip(170, 0.08, 'triangle', 0.26, b + d); noise(0.04, 0.08, 500, b + d, 'lowpass'); });
  }
  /** Clay chips clicking into a stack. */
  function playChips() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < 4; i++) {
      noise(0.035, 0.11, 4200 + Math.random() * 1800, b + i * 0.045 + Math.random() * 0.015);
      blip(2600 + Math.random() * 900, 0.04, 'triangle', 0.05, b + i * 0.045);
    }
  }
  function playFold() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    noise(0.16, 0.08, 1800, b, 'bandpass');
    noise(0.1, 0.05, 900, b + 0.06, 'lowpass');
  }
  /** All-in: a rising sting with a shove of chips. */
  function playAllIn() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    sweep(180, 720, 0.45, 'sawtooth', 0.16, b);
    [523, 659, 784].forEach(function (f, i) { blip(f, 0.28, 'square', 0.08, b + 0.3 + i * 0.07); });
    for (let i = 0; i < 9; i++) noise(0.035, 0.1, 4000 + Math.random() * 2000, b + 0.05 + i * 0.035);
  }
  /** Bets swept into the middle at the end of a street. */
  function playCollect() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < 6; i++) noise(0.04, 0.07, 3600 + Math.random() * 1500, b + i * 0.03);
  }
  function playBlindsUp() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [523, 659, 784, 1047, 1319].forEach(function (f, i) { blip(f, 0.26, 'triangle', 0.18, b + i * 0.08); });
  }
  /** Showdown: every hand turns over. */
  function playShowdown() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < 4; i++) playCardFlip(b + i * 0.09);
    [392, 523, 659].forEach(function (f, i) { blip(f, 0.24, 'triangle', 0.14, b + 0.3 + i * 0.09); });
  }
  /** Pot pushed to the winner. */
  function playPotWin() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [784, 988, 1175, 1568].forEach(function (f, i) { blip(f, 0.34, 'sine', 0.17, b + i * 0.08); });
    for (let i = 0; i < 8; i++) noise(0.035, 0.08, 4200 + Math.random() * 1600, b + 0.08 + i * 0.04);
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
    if (window.trackApplause) window.trackApplause(master);
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
    if (currentView === 'final') playApplause();
  });

  // ---------------- Confetti ----------------
  function confetti() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#E8B83A', '#C62B45', '#4FA9D8', '#E8734A', '#A97BD8', '#86E6A4', '#ffffff'];
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
  // Seat bubbles while the felt is up; the lobby and the final standings float them.
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
  const seatBubbles = {};   // playerId → { el, timer }

  function makeBubble(e) {
    const b = document.createElement('div');
    b.className = 'emote-bubble';
    b.textContent = e;
    return b;
  }

  /** Park the bubble beside the seat's name, on the side facing the middle of the table. */
  function placeBubble(pid) {
    const rec = seatBubbles[pid];
    const e = seatEls[pid];
    if (!rec || !e) return;
    const root = e.root;
    const box = e.box;
    const label = box.firstElementChild;
    const boxLeft = root.offsetLeft - root.offsetWidth / 2 + box.offsetLeft;
    const y = root.offsetTop - root.offsetHeight / 2 + box.offsetTop + label.offsetTop + label.offsetHeight / 2;
    const onRight = root.offsetLeft > felt.offsetLeft + felt.offsetWidth * 0.58;
    rec.el.classList.toggle('eb-left', onRight);
    rec.el.style.left = Math.round(onRight ? boxLeft - 10 : boxLeft + box.offsetWidth + 10) + 'px';
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
    const el = makeBubble(e);
    el.classList.add('on-seat');
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
  let lobby = { players: [], total: 0, capacity: 8, canStart: false, handsPerLevel: 3 };
  let lastHumanTotal = -1;
  let dragActive = false;    // a row is mid-drag; defer lobby rebuilds
  let pendingLobby = null;   // latest snapshot to apply once the drag settles

  function renderQR() {
    fetch('/api/holdempoker/config').then(function (r) { return r.json(); }).then(function (cfg) {
      const url = (cfg && cfg.joinUrl) || (window.location.origin + '/holdempoker/join');
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      return fetch('/api/holdempoker/qr?url=' + encodeURIComponent(url));
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
    setSeg(levelSeg, l.handsPerLevel);
    if (l.startBlinds) {
      startNote.textContent = fmt(l.startStack) + ' · blinds ' + l.startBlinds.sb + ' / ' + l.startBlinds.bb;
    }

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
  function wireSeg(seg, event, toPayload) {
    if (!seg) return;
    seg.addEventListener('click', function (e) {
      const btn = e.target.closest('.seg-btn');
      if (!btn || btn.classList.contains('on')) return;
      setSeg(seg, btn.dataset.value);
      socket.emit(event, toPayload(btn.dataset.value), function (res) {
        if (res && !res.ok) renderLobby(lobby);   // rejected — resync from truth
      });
    });
  }
  wireSeg(levelSeg, 'host:setHandsPerLevel', function (v) { return { handsPerLevel: Number(v) }; });

  startBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
      if (res && !res.ok) toast('Could not start — the table needs at least 2 players.');
      else { lastEventSeq = 0; lastActedSeq = 0; lastCollectSeq = 0; playStartFanfare(); }
    });
  });

  playAgainBtn.addEventListener('click', function () {
    showInlineConfirm('Back to the lobby? Everyone will need to rejoin.', function () {
      socket.emit('host:reset', {});
    }, { okLabel: 'Back to lobby' });
  });

  // ---------------- The table ----------------
  let seatEls = {};          // playerId → element refs
  let seatOrderIds = [];
  let seatByPlayer = {};
  let lastEventSeq = -1;     // -1 until the first render adopts the current event silently
  let lastTurnId = null;
  let lastHandSeen = 0;
  let bannerTimer = null;
  let clockOffset = 0;

  function syncClock(payload) {
    if (payload && typeof payload.serverNow === 'number') clockOffset = payload.serverNow - Date.now();
  }

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
      const cards = document.createElement('div');
      cards.className = 'seat-cards';
      const box = document.createElement('div');
      box.className = 'seat-box';
      const label = document.createElement('div');
      label.className = 'seat-label';
      const pip = document.createElement('span');
      pip.className = 'seat-pip'; pip.dataset.seat = s.seat; pip.textContent = s.seat;
      const name = document.createElement('span');
      name.className = 'pname';
      label.appendChild(pip); label.appendChild(name);
      const stack = document.createElement('div');
      stack.className = 'seat-stack';
      box.appendChild(label); box.appendChild(stack);
      const action = document.createElement('div');
      action.className = 'seat-action';
      root.appendChild(cards); root.appendChild(box); root.appendChild(action);

      const bet = document.createElement('div');
      bet.className = 'bet-chip'; bet.dataset.seat = s.seat; bet.hidden = true;
      const icon = document.createElement('span'); icon.className = 'chip-icon';
      const amt = document.createElement('span'); amt.className = 'bet-amt';
      bet.appendChild(icon); bet.appendChild(amt);

      const dealer = document.createElement('div');
      dealer.className = 'dealer-btn'; dealer.textContent = 'D'; dealer.hidden = true;

      seatLayer.appendChild(bet); seatLayer.appendChild(dealer); seatLayer.appendChild(root);
      seatEls[s.playerId] = { root: root, box: box, cards: cards, name: name, stack: stack, action: action, bet: bet, amt: amt, dealer: dealer, cardKey: '', actionKey: '', stackGoal: null, stackShown: null };
    });
    layoutSeats();
  }

  /**
   * Place every seat on the rail of the oval, clockwise from the bottom
   * centre; its bet and the dealer button are then parked right beside it.
   * offset* (not client rects) because the view's entry transform skews rects.
   */
  function layoutSeats() {
    const n = seatOrderIds.length;
    if (!n || !stage.offsetWidth) return;
    // Each name plate sits on the rail, just overlapping it from outside, so the felt
    // is as big as the stage allows with a whole seat fitting beyond every edge.
    const sample = seatEls[seatOrderIds[0]];
    const rootW = sample.root.offsetWidth;
    const rootH = sample.root.offsetHeight;
    const boxTop = sample.box.offsetTop;
    const boxH = sample.box.offsetHeight;
    const over = 14;   // how far a plate reaches in over the rail
    const margin = 8;
    const insetX = Math.min(rootW - over + margin, stage.offsetWidth * 0.3);
    const insetTop = Math.min(boxTop + boxH - over + margin, stage.offsetHeight * 0.35);
    const insetBottom = Math.min(rootH - boxTop - over + margin, stage.offsetHeight * 0.35);
    felt.style.left = felt.style.right = insetX + 'px';
    felt.style.top = insetTop + 'px';
    felt.style.bottom = insetBottom + 'px';
    if (!felt.offsetWidth) return;
    const cx = felt.offsetLeft + felt.offsetWidth / 2;
    const cy = felt.offsetTop + felt.offsetHeight / 2;
    const ex = felt.offsetWidth / 2 - over;    // the plates may reach in this far over the rail
    const ey = felt.offsetHeight / 2 - over;
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
    // The bottom-centre seat sits a little lower: into the stage's bottom margin and the page's bottom
    // padding (only its empty "Wins" strip reaches there, so nothing is clipped or scrolls).
    const main = stage.closest('.host-main');
    const bottomDrop = Math.min(20, margin + (main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0));
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
      const py = cy + uy * hi + (i === 0 ? bottomDrop : 0);
      e.root.style.left = Math.round(px) + 'px';
      e.root.style.top = Math.round(py - boxOffset) + 'px';
    });
    fitSeatNames();
    measureChipMax();
    placeSeatExtras();
    placeBubbles();
    fitCenter();
  }

  const feltCenter = felt.querySelector('.felt-center');
  // Footprint of the biggest bet chip ("88,888"), so bets have a fixed spot and the board never has to dodge a growing one.
  let chipMax = { w: 120, h: 40 };
  let cardDownH = 50;
  function measureChipMax() {
    const probe = document.createElement('div');
    probe.className = 'bet-chip';
    probe.style.visibility = 'hidden';
    probe.style.animation = 'none';
    probe.innerHTML = '<span class="chip-icon"></span><span class="bet-amt">88,888</span>';
    seatLayer.appendChild(probe);
    chipMax = { w: probe.offsetWidth, h: probe.offsetHeight };
    probe.remove();
    const sample = seatEls[seatOrderIds[0]];
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'position:absolute;visibility:hidden;width:var(--card-w-down);height:calc(var(--card-w-down) * 1.4);';
    sample.root.appendChild(card);
    cardDownH = card.offsetHeight;
    card.remove();
  }

  /** Stage-coordinate rect of a centred (translate -50%) absolutely placed element. */
  function centredRect(x, y, w, h) { return { l: x - w / 2, t: y - h / 2, r: x + w / 2, b: y + h / 2 }; }
  function overlaps(a, b) { return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t; }

  /**
   * Find the biggest board (+ pot line and side pots) that fits on the felt without
   * touching any seat, its face-up card slot, its bet (at its largest) or the dealer
   * chip — so a bet can never sit on the community cards or the pot.
   */
  function fitCenter() {
    if (!felt.offsetWidth || !seatOrderIds.length) return;
    feltCenter.style.removeProperty('--card-w');
    feltCenter.style.removeProperty('top');
    feltCenter.style.removeProperty('transform');
    const cssCardW = boardEl.firstElementChild.offsetWidth;
    const gap = 10;
    const sideShown = !sidePotsEl.hidden;
    // The hand name only takes space at hand end, but its line is always reserved so the pot never has to move up into the board.
    const handH = Math.max(handLineEl.offsetHeight, parseFloat(getComputedStyle(handLineEl).fontSize) * 1.25);
    const extraH = potLineEl.offsetHeight + gap + handH + gap + (sideShown ? sidePotsEl.offsetHeight + gap : 0);
    const extraW = Math.max(potLineEl.offsetWidth, handLineEl.offsetWidth, sideShown ? sidePotsEl.offsetWidth : 0);

    const pad = 10;
    const obstacles = [];   // seats and live bets: never covered if avoidable
    const reserved = [];    // every seat's largest-bet and D spots: kept clear so the board doesn't jump
    Object.keys(seatEls).forEach(function (pid) {
      const e = seatEls[pid];
      const root = e.root;
      obstacles.push(centredRect(root.offsetLeft, root.offsetTop, root.offsetWidth + pad * 2, root.offsetHeight + pad * 2));
      // A bet always lies inside the seat's box or this far box, whatever its size or the cards showing.
      if (!root.classList.contains('busted') && e.betFar) {
        reserved.push(centredRect(e.betFar.x, e.betFar.y, chipMax.w + pad * 2, chipMax.h + pad * 2));
      }
      if (!e.bet.hidden) {
        obstacles.push(centredRect(parseFloat(e.bet.style.left), parseFloat(e.bet.style.top), e.bet.offsetWidth + pad * 2, e.bet.offsetHeight + pad * 2));
      }
      // Every seat's D spot, not just the current button's, so the board doesn't resize as the button moves.
      reserved.push(centredRect(parseFloat(e.dealer.style.left), parseFloat(e.dealer.style.top), 40 + pad * 2, 40 + pad * 2));
    });

    const fx = felt.offsetLeft + felt.clientLeft;
    const fy = felt.offsetTop + felt.clientTop;
    const cx = fx + felt.clientWidth / 2;
    const cy = fy + felt.clientHeight / 2;
    const rx = felt.clientWidth / 2 - 6;
    const ry = felt.clientHeight / 2 - 6;
    const insideFelt = function (r) {
      return [[r.l, r.t], [r.r, r.t], [r.l, r.b], [r.r, r.b]].every(function (p) {
        const dx = (p[0] - cx) / rx;
        const dy = (p[1] - cy) / ry;
        return dx * dx + dy * dy <= 1;
      });
    };

    // Pinned by its top edge, so whatever appears or collapses under the board never moves the board.
    const place = function (cw, y) {
      feltCenter.style.setProperty('--card-w', cw + 'px');
      feltCenter.style.top = Math.round(y - sizeOf(cw).h / 2 - fy) + 'px';
      feltCenter.style.transform = 'translateX(-50%)';
    };
    const sizeOf = function (cw) { return { w: Math.max(cw * 5.48 + 4, extraW), h: cw * 1.4 + 4 + extraH }; };
    const passes = [obstacles.concat(reserved), obstacles];
    for (let p = 0; p < passes.length; p++) {
      for (let cw = cssCardW; cw >= 24; cw -= 2) {
        const sz = sizeOf(cw);
        // Nearest the middle first, alternating up and down.
        for (let k = 0; k * 4 <= felt.clientHeight / 2; k++) {
          const offs = k === 0 ? [0] : [-k * 4, k * 4];
          for (let i = 0; i < offs.length; i++) {
            const y = cy + offs[i];
            const rect = centredRect(cx, y, sz.w, sz.h);
            if (!insideFelt(rect)) continue;
            if (passes[p].some(function (o) { return overlaps(rect, o); })) continue;
            place(cw, y);
            return;
          }
        }
      }
    }
    // Nothing clear (a very small window): smallest board where it covers the least of any seat.
    const sz = sizeOf(24);
    const area = function (a, b) { return Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t)); };
    let bestY = cy;
    let best = Infinity;
    for (let y = fy + sz.h / 2; y <= fy + felt.clientHeight - sz.h / 2; y += 4) {
      const rect = centredRect(cx, y, sz.w, sz.h);
      const cover = obstacles.reduce(function (sum, o) { return sum + area(rect, o); }, 0) + Math.abs(y - cy) * 0.01;
      if (cover < best) { best = cover; bestY = y; }
    }
    place(24, bestY);
  }

  /**
   * The bet sits just clear of the seat, on the line to the middle of the table;
   * the D chip sits on the felt right beside it, so it never ends up under a neighbour.
   */
  function placeSeatExtras() {
    const r = 20;
    const cx = felt.offsetLeft + felt.offsetWidth / 2;
    const cy = felt.offsetTop + felt.offsetHeight / 2;
    Object.keys(seatEls).forEach(function (pid) {
      const e = seatEls[pid];
      const root = e.root;
      const box = e.box;

      const sx = root.offsetLeft;
      const sy = root.offsetTop;
      const len = Math.hypot(cx - sx, cy - sy) || 1;
      const ux = (cx - sx) / len;
      const uy = (cy - sy) / len;
      // How far along (ux, uy) a centred box of half-size (hw, hh) reaches.
      const reach = function (hw, hh) {
        return Math.min(Math.abs(ux) > 0.001 ? hw / Math.abs(ux) : Infinity, Math.abs(uy) > 0.001 ? hh / Math.abs(uy) : Infinity);
      };
      // Bets only happen while hole cards are face down, so measure from the plate plus the
      // face-down cards: a fixed spot per seat that the board can always keep clear of.
      const ox = sx - root.offsetWidth / 2;
      const oy = sy - root.offsetHeight / 2;
      const l = ox;
      const rr = ox + root.offsetWidth;
      const t = oy + e.cards.offsetTop + e.cards.offsetHeight - cardDownH;
      const b = oy + box.offsetTop + box.offsetHeight;
      const fx = (l + rr) / 2;
      const fy = (t + b) / 2;
      const base = reach((rr - l) / 2, (b - t) / 2) + 10;
      const d = base + reach(e.bet.offsetWidth / 2, e.bet.offsetHeight / 2);
      e.bet.style.left = Math.round(fx + ux * d) + 'px';
      e.bet.style.top = Math.round(fy + uy * d) + 'px';
      // Where the biggest possible chip would sit: every real bet fits inside this box.
      const far = base + reach(chipMax.w / 2, chipMax.h / 2);
      e.betFar = { x: fx + ux * far, y: fy + uy * far };
      // D chip: on the felt beside the bet's spot (clockwise side), measured from the plate so it never shifts.
      const bcx = sx - root.offsetWidth / 2 + box.offsetLeft + box.offsetWidth / 2;
      const bcy = sy - root.offsetHeight / 2 + box.offsetTop + box.offsetHeight / 2;
      const dd = reach(box.offsetWidth / 2, box.offsetHeight / 2) + r + 10;
      const side = chipMax.w / 2 + r + 8;
      e.dealer.style.left = Math.round(bcx + ux * dd - uy * side) + 'px';
      e.dealer.style.top = Math.round(bcy + uy * dd + ux * side) + 'px';
    });
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(layoutSeats).observe(stage);
  window.addEventListener('resize', layoutSeats);

  let nameProbe = null;
  // The seat box is width-capped, so a long name shrinks its own text down to
  // a readable floor rather than wrapping and pushing the stack off the plate.
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
   * Swap a seat's cards only when they actually change, so a re-render doesn't
   * restart the deal animation on every action.
   */
  function setSeatCards(e, s, highlight) {
    let codes = [];
    if (s.cards) codes = s.cards.slice();
    else if (s.hasCards) codes = ['back', 'back'];
    const key = codes.join(',');
    if (key !== e.cardKey) {
      e.cardKey = key;
      e.cards.innerHTML = '';
      codes.forEach(function (c) { e.cards.appendChild(c === 'back' ? cardBack() : cardImg(c, s.cards ? 'deal-in' : '')); });
    }
    Array.prototype.forEach.call(e.cards.children, function (el) {
      const code = el.dataset.card;
      el.classList.toggle('taker', !!highlight && highlight.best.indexOf(code) >= 0);
      el.classList.toggle('dim', !!highlight && s.cards && highlight.best.indexOf(code) < 0);
    });
  }

  const KO_FADE_MS = 2600;   // matches .seat.just-busted's knockout animation
  function renderSeats(s, ctx) {
    // A busted seat stays only for the hand that knocked it out, then the table closes up.
    const outNow = {};
    if (ctx.handEnd && s.result && s.result.busted) s.result.busted.forEach(function (b) { outNow[b.playerId] = true; });
    const seats = s.seats.filter(function (seat) { return !seat.busted || outNow[seat.playerId]; });
    ensureSeats(seats);
    seats.forEach(function (seat) {
      const e = seatEls[seat.playerId];
      if (!e) return;
      e.root.dataset.seat = seat.seat;
      e.root.classList.toggle('turn', seat.playerId === s.turnPlayerId);
      e.root.classList.toggle('folded', !!seat.folded);
      e.root.classList.toggle('allin', !!seat.allIn);
      // Knocked out on this very hand (not a refresh or a later hand): the seat looks as it was
      // through the showdown pause, then plays the knockout.
      if (seat.busted && e.wasBusted === false && ctx.handEnd) {
        e.koPending = true;
        setTimeout(function () {
          e.koPending = false;
          e.root.classList.add('busted', 'just-busted');
          if (seat.place) setStackText(e, 'Out · ' + ordinal(seat.place));
          // The skull is its own element, so it can appear once the whole seat has faded.
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
        }, ctx.koDelay || 0);
      }
      e.wasBusted = !!seat.busted;
      if (!e.koPending) e.root.classList.toggle('busted', !!seat.busted);
      e.root.classList.toggle('offline', !seat.isBot && seat.connected === false);
      e.root.classList.toggle('winner', !!(ctx.wonBy && ctx.wonBy[seat.playerId]));
      e.root.classList.toggle('shown', !!seat.cards);

      if (e.name.textContent !== seat.name) { e.name.textContent = seat.name; fitSeatName(e.name); }
      if (e.stackShown != null) showStack(e, e.stackShown);
      else if (seat.busted && seat.place && !e.koPending) setStackText(e, 'Out · ' + ordinal(seat.place));
      else if (seat.allIn && seat.stack === 0) setStackText(e, 'All-in');
      else setStackText(e, fmt(seat.stack));

      setSeatCards(e, seat, ctx.highlight && ctx.highlight.ids[seat.playerId] ? ctx.highlight : null);

      // Actions show as a brief flash on the name plate; the only lasting tag is the win: every chip coming back.
      const won = ctx.wonBy && ctx.wonBy[seat.playerId];
      const a = won ? { text: 'Wins ' + fmt(won + ((ctx.refundBy && ctx.refundBy[seat.playerId]) || 0)), cls: 'a-win' } : { text: '', cls: '' };
      const akey = a.cls + '|' + a.text;
      if (akey !== e.actionKey) {
        e.actionKey = akey;
        e.action.className = 'seat-action' + (a.cls ? ' ' + a.cls : '');
        e.action.textContent = a.text;
      }

      e.bet.hidden = !(seat.bet > 0);
      e.amt.textContent = fmt(seat.bet);
      e.dealer.hidden = seat.playerId !== s.buttonId;
    });
    placeSeatExtras();
    placeBubbles();
  }

  function renderBoard(board, highlight) {
    const slots = boardEl.querySelectorAll('.board-slot');
    for (let i = 0; i < 5; i++) {
      const slot = slots[i];
      const code = board[i];
      const cur = slot.firstElementChild;
      if (!code) { if (cur) slot.innerHTML = ''; continue; }
      if (!cur || cur.dataset.card !== code) {
        slot.innerHTML = '';
        const img = cardImg(code, 'deal-in');
        img.style.animationDelay = (i < 3 && board.length === 3 ? i * 0.12 : 0) + 's';
        slot.appendChild(img);
      }
      const el = slot.firstElementChild;
      el.classList.toggle('taker', !!highlight && highlight.best.indexOf(code) >= 0);
      el.classList.toggle('dim', !!highlight && highlight.best.indexOf(code) < 0);
    }
  }

  function potName(n, i) { return i === 0 ? 'Main' : (n > 2 ? 'Side ' + i : 'Side'); }

  let sidePotsKey = '';
  function renderPot(s, handEnd, payout) {
    let total = s.totalPot;
    if (handEnd && s.result) total = s.result.pots.reduce(function (a, p) { return a + p.amount; }, 0) + refundTotal(s.result);
    potTotalEl.textContent = fmt(total);
    const pots = handEnd && s.result ? s.result.pots : s.pots;
    if (pots && pots.length > 1) {
      const order = payout ? awardOrder(s.result) : [];
      const states = pots.map(function (p, i) {
        if (!payout) return '';
        const k = order.indexOf(i);
        return payout.done || k < payout.step ? 'paid' : (k === payout.step ? 'paying' : '');
      });
      const key = s.handNumber + '#' + pots.map(function (p, i) { return p.amount + ':' + states[i]; }).join('|');
      if (key !== sidePotsKey) {
        sidePotsKey = key;
        sidePotsEl.innerHTML = '';
        pots.forEach(function (p, i) {
          const pill = document.createElement('span');
          pill.className = 'side-pot' + (states[i] ? ' ' + states[i] : '');
          pill.dataset.pot = i;
          const stack = document.createElement('span');
          stack.className = 'sp-stack';
          for (let c = 0; c < 3; c++) { const chip = document.createElement('span'); chip.className = 'chip-icon'; stack.appendChild(chip); }
          const label = document.createElement('span');
          label.className = 'sp-label';
          label.textContent = potName(pots.length, i);
          const amt = document.createElement('span');
          amt.className = 'sp-amt';
          amt.textContent = fmt(p.amount);
          pill.appendChild(stack); pill.appendChild(label); pill.appendChild(amt);
          sidePotsEl.appendChild(pill);
        });
      }
      sidePotsEl.hidden = false;
    } else {
      sidePotsKey = '';
      sidePotsEl.innerHTML = '';
      sidePotsEl.hidden = true;
    }
    // With side pots the Main/Side stacks stand in for the total.
    potLineEl.hidden = !sidePotsEl.hidden;
    sidePotsEl.style.visibility = handEnd && !(payout && !payout.done) ? 'hidden' : '';
  }

  function renderStrip(s) {
    tLevel.textContent = s.level;
    tBlinds.textContent = fmt(s.smallBlind) + ' / ' + fmt(s.bigBlind);
    const n = s.handsToNextLevel;
    tNext.textContent = fmt(s.nextSmallBlind) + ' / ' + fmt(s.nextBigBlind);
    tNextWhen.textContent = ' · ' + (n <= 1 ? 'after this hand' : 'in ' + n + ' hands');
    tNextWhen.classList.toggle('soon', n <= 1);
  }

  function renderWaiting(s) {
    waitingNote.innerHTML = '';
    if (!s.waitingOn) { waitingNote.hidden = true; return; }
    waitingNote.appendChild(document.createTextNode('Waiting for '));
    waitingNote.appendChild(nameSpan(s.waitingOn, seatByPlayer[s.turnPlayerId]));
    waitingNote.appendChild(document.createTextNode(' to come back…'));
    waitingNote.hidden = false;
  }

  function hideLevelBanner() {
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    levelBanner.hidden = true;
    levelDim.hidden = true;
  }

  /** Up for exactly as long as the server holds the deal, so it lifts as betting opens. */
  function showLevelBanner(s) {
    levelBannerValue.textContent = fmt(s.smallBlind) + ' / ' + fmt(s.bigBlind);
    levelBanner.hidden = false;
    levelDim.hidden = false;
    tBlindsItem.classList.remove('bump');
    void tBlindsItem.offsetWidth;
    tBlindsItem.classList.add('bump');
    if (bannerTimer) clearTimeout(bannerTimer);
    const ms = Math.max(1200, (s.endsAt || 0) - (Date.now() + clockOffset));
    bannerTimer = setTimeout(hideLevelBanner, ms);
  }

  /** Sounds and set-pieces for whatever just happened, once per event. `sweepMs`: when the bet sweep ends. */
  function playEvent(s, sweepMs) {
    const ev = s.lastEvent;
    if (!ev) return;
    if (lastEventSeq < 0) { lastEventSeq = ev.seq; return; }
    if (ev.seq === lastEventSeq) return;
    lastEventSeq = ev.seq;
    const swept = sweepMs || 0;
    switch (ev.type) {
      case 'deal':
        playDealRiffle();
        if (ev.levelUp) { playBlindsUp(); showLevelBanner(s); }
        break;
      case 'check': playCheck(); break;
      case 'call': case 'bet': case 'raise': playChips(); break;
      case 'allin': playAllIn(); break;
      case 'fold': playFold(); break;
      case 'collect': setTimeout(playCollect, Math.max(0, swept - SWEEP_MS)); break;
      case 'street': playBoardCards(ev.street === 'flop' ? 3 : 1); break;
      case 'runout': playShowdown(); break;
      case 'show': playCardFlip(); break;
      case 'handEnd': {
        if (ev.resultType === 'showdown') playShowdown();
        const r = s.result;
        if (ev.busted) setTimeout(playSad, knockoutDelay(r) + 300);
        if (r && motionOk()) holdStacks(s, r);
        // The pot-by-pot payout plays its own chips and sounds.
        if (r && r.awardFrom) break;
        const potDelay = Math.max(ev.resultType === 'showdown' ? 500 : 0, swept);
        setTimeout(playPotWin, potDelay);
        // Measured once the pot has settled, since it only updates after the sweep.
        later(function () { flyPotToWinners(r, 0); }, potDelay);
        break;
      }
      default: break;
    }
  }

  function motionOk() {
    if (typeof Element.prototype.animate !== 'function') return false;
    return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /** Slide `n` chips from one element's centre to another's, on the stage. */
  function flyChips(fromEl, toEl, n, opts) {
    const sr = stage.getBoundingClientRect();
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const fromX = a.left + a.width / 2 - sr.left;
    const fromY = a.top + a.height / 2 - sr.top;
    const dx = b.left + b.width / 2 - sr.left - fromX;
    const dy = b.top + b.height / 2 - sr.top - fromY;
    const at = function (x, y, sc) { return 'translate(-50%, -50%) translate(' + x + 'px, ' + y + 'px) scale(' + sc + ')'; };
    for (let i = 0; i < n; i++) {
      const c = document.createElement('div');
      c.className = 'fly-chip';
      if (opts.seat) c.dataset.seat = opts.seat;
      c.style.left = fromX + 'px';
      c.style.top = fromY + 'px';
      stage.appendChild(c);
      const jx = (Math.random() - 0.5) * 30;
      const jy = (Math.random() - 0.5) * 12;
      const anim = c.animate([
        { transform: at(jx, jy, 0.5), opacity: 0 },
        { transform: at(jx, jy, 1), opacity: 1, offset: 0.15 },
        { transform: at(dx + jx * 0.3, dy + jy * 0.3, 0.9), opacity: 1, offset: 0.88 },
        { transform: at(dx, dy, 0.5), opacity: 0 },
      ], { duration: opts.duration, delay: (opts.delay || 0) + i * 70, easing: 'cubic-bezier(0.45, 0, 0.25, 1)', fill: 'both' });
      anim.onfinish = function () { c.remove(); };
      anim.oncancel = function () { c.remove(); };
    }
  }
  const POT_FLY_MS = 1400;
  // Bigger pots send a few more chips: 20 → 9, 400 → 11, 4,000 → 13, capped at 14.
  function potChipCount(amount) { return Math.min(14, 7 + 2 * Math.floor(Math.log10(Math.max(1, amount)))); }

  /**
   * Chips from the pot to a winner, whose stack counts up from the first chip landing to the last.
   * Returns that landing window, so the pot can count down over the same time.
   */
  function payWinner(fromEl, w, delay) {
    const e = seatEls[w.playerId];
    if (!e) return null;
    const n = potChipCount(w.amount);
    flyChips(fromEl, e.box, n, { delay: delay, duration: POT_FLY_MS });
    // flyChips staggers chips 70ms apart; each reaches the plate ~88% of the way through its flight.
    const land = { start: delay + POT_FLY_MS * 0.88, end: delay + (n - 1) * 70 + POT_FLY_MS };
    countStackUp(e, w.amount, land.start, land.end - land.start);
    return land;
  }

  /** Pay every winner of one pot; the pot fades out over the same time their chips land. */
  function payOutPot(potEl, pot, delay) {
    let first = null;
    let last = null;
    pot.winners.forEach(function (w, j) {
      const land = payWinner(potEl, w, delay + j * 160);
      if (!land) return;
      if (!first) first = land;
      last = land;
    });
    if (first) {
      later(function () {
        potEl.style.transitionDuration = Math.round(last.end - first.start) + 'ms';
        potEl.classList.add('emptied');
      }, first.start);
    }
    return delay + pot.winners.length * 160;
  }

  function later(fn, ms) { tweens.push({ timer: setTimeout(fn, ms), raf: null }); }

  const tweens = [];
  /** Count a number from `from` to `to` over `dur` ms, starting in `startIn` ms. */
  function tween(from, to, startIn, dur, apply, done) {
    const rec = { timer: null, raf: null };
    rec.timer = setTimeout(function () {
      const t0 = performance.now();
      const step = function (now) {
        const k = Math.min(1, Math.max(0, (now - t0) / Math.max(1, dur)));
        apply(Math.round(from + (to - from) * k));
        if (k < 1) { rec.raf = requestAnimationFrame(step); return; }
        rec.raf = null;
        if (done) done();
      };
      rec.raf = requestAnimationFrame(step);
    }, startIn);
    tweens.push(rec);
  }

  function showStack(e, v) {
    e.stackShown = v;
    setStackText(e, v === 0 ? 'All-in' : fmt(v));
  }

  function setStackText(e, text) {
    e.stack.textContent = text;
    e.stack.classList.toggle('is-allin', text === 'All-in');
  }

  /**
   * The unmatched bet a fold-winner gets back with the pot. Only a fold win returns it at hand end;
   * an all-in's uncovered excess goes back when betting closes, and never passes through the pot.
   */
  function refundsOf(r) {
    const out = {};
    if (!r || r.type !== 'fold') return out;
    (r.uncalled || []).forEach(function (u) { out[u.playerId] = (out[u.playerId] || 0) + u.amount; });
    return out;
  }
  function refundTotal(r) {
    const f = refundsOf(r);
    return Object.keys(f).reduce(function (a, k) { return a + f[k]; }, 0);
  }

  /** What the pot bubble pays each winner: their winnings plus (fold wins) their own unmatched bet, the whole amount coming back. */
  function potPayouts(r) {
    if (r.awardFrom || r.pots.length !== 1) return r.pots;
    const f = refundsOf(r);
    const pot = r.pots[0];
    const winners = pot.winners.map(function (w) { return { playerId: w.playerId, amount: w.amount + (f[w.playerId] || 0) }; });
    return [{ amount: pot.amount + refundTotal(r), winners: winners }];
  }

  /** Everyone paid from the pot shows their stack from before the payout, so it can count up as their chips arrive. */
  function holdStacks(s, r) {
    const back = {};
    potPayouts(r).forEach(function (p) { p.winners.forEach(function (w) { back[w.playerId] = (back[w.playerId] || 0) + w.amount; }); });
    s.seats.forEach(function (seat) {
      const e = seatEls[seat.playerId];
      if (!e || !back[seat.playerId]) return;
      e.stackGoal = seat.stack - back[seat.playerId];
      showStack(e, e.stackGoal);
    });
  }

  function countStackUp(e, amount, startIn, dur) {
    if (e.stackGoal == null) return;
    const from = e.stackGoal;
    e.stackGoal = from + amount;
    tween(from, from + amount, startIn, dur, function (v) { showStack(e, v); });
  }

  function clearStackCounts() {
    tweens.forEach(function (rec) {
      clearTimeout(rec.timer);
      if (rec.raf) cancelAnimationFrame(rec.raf);
    });
    tweens.length = 0;
    Object.keys(seatEls).forEach(function (pid) {
      seatEls[pid].stackGoal = null;
      seatEls[pid].stackShown = null;
    });
    potLineEl.style.transitionDuration = '';
    potLineEl.classList.remove('emptied');
  }

  /** A little stream of chips slides from the pot to each winner, pot by pot. */
  function flyPotToWinners(r, delay) {
    if (!r || !r.pots || !motionOk()) return;
    let t = delay;
    potPayouts(r).forEach(function (pot) {
      t = payOutPot(potLineEl, pot, t) + 260;
    });
  }

  // ---------------- Player actions ----------------
  const ACTION_LABEL = { check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise to', allin: 'All-in', fold: 'Fold' };
  const CHIP_ACTIONS = { call: true, bet: true, raise: true, allin: true };
  const ACTION_FLASH_MS = 2800;
  const BET_FLY_MS = 560;
  const SWEEP_HOLD_MS = 250;   // closing bets sit a beat before they're swept in
  const SWEEP_MS = 520;
  let lastActedSeq = -1;     // -1 until the first render adopts the current action silently
  let lastCollectSeq = -1;

  /** Dim the actor's name plate for a moment with what they just did. */
  function flashAction(a) {
    const e = seatEls[a.playerId];
    if (!e || !ACTION_LABEL[a.type]) return;
    const old = e.box.querySelector('.action-flash');
    if (old) old.remove();
    const f = document.createElement('div');
    f.className = 'action-flash af-' + a.type;
    f.textContent = ACTION_LABEL[a.type] + (CHIP_ACTIONS[a.type] && a.amount ? ' ' + fmt(a.amount) : '');
    e.box.appendChild(f);
    // Restart the seat's own hold-then-dim (see .seat.folded.flashing) in step with this flash.
    e.root.classList.remove('flashing');
    void e.root.offsetWidth;
    e.root.classList.add('flashing');
    setTimeout(function () {
      if (e.box.lastElementChild === f) e.root.classList.remove('flashing');
      f.remove();
    }, ACTION_FLASH_MS);
  }

  /** Chips slide off the player into the bet in front of them. */
  function flyChipsToBet(a, target, delay) {
    const e = seatEls[a.playerId];
    const n = Math.min(6, 3 + Math.floor(Math.log10(Math.max(1, a.amount))));
    flyChips(e.box, target, n, { duration: BET_FLY_MS, delay: delay || 0, seat: e.root.dataset.seat });
    // The bet chip "lands" as the flying chips reach it.
    target.animate([{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: BET_FLY_MS + n * 70, fill: 'backwards' });
    return BET_FLY_MS + n * 70;
  }

  /** A stand-in for a seat's (already collected) bet chip, parked where the real one sits. */
  function betStandIn(pid, amount) {
    const e = seatEls[pid];
    if (!e) return null;
    e.amt.textContent = fmt(amount);
    e.bet.hidden = false;
    placeSeatExtras();
    const c = e.bet.cloneNode(true);
    c.classList.add('bet-standin');
    c.style.animation = 'none';
    e.bet.hidden = true;
    seatLayer.appendChild(c);
    return c;
  }

  /**
   * Flash the latest action and move its chips. When the action closed the street,
   * the closer's chips land in front of them first, then every bet sweeps into the
   * pot together. Returns when that sweep ends, so a pot-to-winner slide can follow.
   */
  function playActed(s) {
    const a = s.lastActed;
    const c = s.lastCollect;
    if (lastActedSeq < 0 || lastCollectSeq < 0) {
      lastActedSeq = a ? a.seq : 0;
      lastCollectSeq = c ? c.seq : 0;
      return 0;
    }
    const newAct = !!a && a.seq !== lastActedSeq;
    const newCollect = !!c && c.seq !== lastCollectSeq;
    if (a) lastActedSeq = a.seq;
    if (c) lastCollectSeq = c.seq;
    if (newAct) flashAction(a);
    const chipsMoved = newAct && CHIP_ACTIONS[a.type] && seatEls[a.playerId];
    if (!motionOk()) return 0;

    if (!newCollect) {
      if (chipsMoved && !seatEls[a.playerId].bet.hidden) flyChipsToBet(a, seatEls[a.playerId].bet);
      return 0;
    }

    const standIns = [];
    let land = 0;
    Object.keys(c.bets).forEach(function (pid) {
      const chip = betStandIn(pid, c.bets[pid]);
      if (!chip) return;
      standIns.push(chip);
      if (chipsMoved && pid === a.playerId) land = flyChipsToBet(a, chip);
    });
    const sweepAt = land + SWEEP_HOLD_MS;
    const pr = (potLineEl.hidden ? sidePotsEl : potLineEl).getBoundingClientRect();
    standIns.forEach(function (chip, i) {
      const r = chip.getBoundingClientRect();
      const dx = pr.left + pr.width / 2 - (r.left + r.width / 2);
      const dy = pr.top + pr.height / 2 - (r.top + r.height / 2);
      const anim = chip.animate([
        { transform: 'translate(-50%, -50%)', opacity: 1 },
        { transform: 'translate(-50%, -50%) translate(' + dx + 'px, ' + dy + 'px) scale(0.55)', opacity: 0 },
      ], { duration: SWEEP_MS, delay: sweepAt + i * 40, easing: 'cubic-bezier(0.45, 0, 0.25, 1)', fill: 'forwards' });
      anim.onfinish = function () { chip.remove(); };
      anim.oncancel = function () { chip.remove(); };
    });
    return standIns.length ? sweepAt + SWEEP_MS + standIns.length * 40 : 0;
  }

  function renderTable(s) {
    syncClock(s);
    clearAward();
    clearStackCounts();
    if (s.phase !== 'DEAL') hideLevelBanner();
    indexSeats(s.seats);
    renderStrip(s);
    setStats(s.stats);
    renderSeats(s, {});
    renderBoard(s.board, null);
    handLineEl.textContent = '';
    renderWaiting(s);

    const wasTable = currentView === 'table';
    show('table', layoutSeats);
    const swept = playActed(s);
    showPots(function () { renderPot(s, false); fitCenter(); }, swept);
    playEvent(s, swept);
    // A fresh turn is the "look up" moment.
    if (s.turnPlayerId && s.turnPlayerId !== lastTurnId && wasTable && lastHandSeen === s.handNumber) {
      setTimeout(playTurnCue, 260);
    }
    lastTurnId = s.turnPlayerId;
    lastHandSeen = s.handNumber;
  }

  function indexSeats(seats) {
    seatByPlayer = {};
    (seats || []).forEach(function (x) { seatByPlayer[x.playerId] = x.seat; });
  }

  // The pots only update once the bets sweeping into the middle have landed; later renders during the sweep wait too.
  let potHold = null;
  function showPots(apply, holdMs) {
    if (holdMs > 0) {
      if (potHold) clearTimeout(potHold.timer);
      potHold = { apply: apply, timer: setTimeout(function () { const a = potHold.apply; potHold = null; a(); }, holdMs) };
      return;
    }
    if (potHold) { potHold.apply = apply; return; }
    apply();
  }
  function clearPotHold() {
    if (potHold) clearTimeout(potHold.timer);
    potHold = null;
  }

  // ---------------- Pot-by-pot payout ----------------
  let award = null;          // { hand, timers } for the hand whose pots are being paid one by one
  let lastHandEndState = null;

  function clearAward() {
    if (award) award.timers.forEach(clearTimeout);
    award = null;
  }

  /** Side pots first, the main pot last. */
  function awardOrder(r) { return r.pots.map(function (p, i) { return i; }).reverse(); }

  /** Where the payout is, from the server clock (so a refresh rejoins it); null when every pot pays at once. */
  function awardStage(r) {
    if (!r || !r.awardFrom || !r.awardMs || r.pots.length < 2) return null;
    const t = Date.now() + clockOffset - r.awardFrom;
    if (t < 0) return { step: -1, done: false };
    const k = Math.floor(t / r.awardMs);
    return k >= r.pots.length ? { step: r.pots.length - 1, done: true } : { step: k, done: false };
  }

  /** ms from now until the knockout should start: when the showdown pause is over. */
  function knockoutDelay(r) {
    if (!r || !r.knockoutAt) return 0;
    return Math.max(0, r.knockoutAt - (Date.now() + clockOffset));
  }

  function scheduleAward(s) {
    if (award && award.hand === s.handNumber) return;
    clearAward();
    const r = s.result;
    const order = awardOrder(r);
    award = { hand: s.handNumber, timers: [] };
    for (let k = 0; k <= order.length; k++) {
      const wait = r.awardFrom + k * r.awardMs - (Date.now() + clockOffset);
      if (wait <= 0) continue;
      award.timers.push(setTimeout(function () {
        if (!lastHandEndState || lastHandEndState.handNumber !== s.handNumber) return;
        renderHandEnd(lastHandEndState, true);
        if (k < order.length) payPot(r, order[k]);
      }, wait + 20));
    }
  }

  function payPot(r, i) {
    playPotWin();
    if (!motionOk()) return;
    const pill = sidePotsEl.querySelector('.side-pot[data-pot="' + i + '"]');
    if (pill) payOutPot(pill, r.pots[i], 0);
    else r.pots[i].winners.forEach(function (w, j) { payWinner(sidePotsEl, w, j * 160); });
  }

  /** The winning five of pot `i`, lit on the board and in its winners' hands. */
  function potHighlight(r, i) {
    if (r.type !== 'showdown' || i == null || !r.pots[i]) return null;
    const winners = r.pots[i].winners.map(function (w) { return w.playerId; });
    const best = [];
    const ids = {};
    r.shown.forEach(function (x) {
      if (winners.indexOf(x.playerId) < 0) return;
      ids[x.playerId] = true;
      (x.best || []).forEach(function (c) { if (best.indexOf(c) < 0) best.push(c); });
    });
    return best.length ? { best: best, ids: ids } : null;
  }

  // ---------------- Hand end ----------------
  function renderHandEnd(s, replay) {
    // A replayed payload's serverNow is stale; resyncing from it would rewind the clock.
    if (!replay) syncClock(s);
    lastHandEndState = s;
    hideLevelBanner();
    indexSeats(s.seats);
    renderStrip(s);
    setStats(s.stats);
    const r = s.result || { pots: [], shown: [], busted: [] };
    const payout = awardStage(r);
    const order = payout ? awardOrder(r) : [];
    const paid = payout ? order.slice(0, payout.step + 1) : r.pots.map(function (p, i) { return i; });

    const wonBy = {};
    paid.forEach(function (i) { r.pots[i].winners.forEach(function (w) { wonBy[w.playerId] = (wonBy[w.playerId] || 0) + w.amount; }); });

    // Light the winning five of the pot being paid (the main pot once they're all paid).
    const focus = payout && !payout.done ? (payout.step >= 0 ? order[payout.step] : null) : 0;
    const highlight = potHighlight(r, focus);

    renderSeats(s, { handEnd: true, wonBy: wonBy, refundBy: refundsOf(r), highlight: highlight, koDelay: knockoutDelay(r) });
    renderBoard(s.board, highlight);
    renderHandLine(r, payout);
    waitingNote.hidden = true;
    if (payout) scheduleAward(s); else clearAward();

    show('table', layoutSeats);
    const swept = playActed(s);
    showPots(function () { renderPot(s, true, payout); fitCenter(); }, swept);
    playEvent(s, swept);
    lastTurnId = null;
    lastHandSeen = s.handNumber;
  }

  /** The winning hand's name under the pot: the pot being paid during a side-pot payout, else the main pot. */
  function renderHandLine(r, payout) {
    let label = '';
    let name = '';
    if (r.type === 'showdown' && r.pots.length) {
      const paying = payout && !payout.done;
      const i = paying ? (payout.step >= 0 ? awardOrder(r)[payout.step] : null) : 0;
      if (i != null) {
        name = r.pots[i].handName || '';
        if (paying) label = potName(r.pots.length, i);
      }
    } else if (r.type === 'fold' && r.shown && r.shown[0]) {
      name = r.shown[0].handName || '';
    }
    handLineEl.textContent = '';
    if (!name) return;
    if (label) {
      const l = document.createElement('span');
      l.className = 'hl-pot';
      l.textContent = label + ' · ';
      handLineEl.appendChild(l);
    }
    handLineEl.appendChild(document.createTextNode(name));
  }

  // ---------------- Player stats ----------------
  const STAT_COLS = [
    { key: 'hands', label: 'Hands', title: 'Hands dealt in' },
    { key: 'wonPct', label: 'Won', title: 'Share of hands where they won a pot', pct: true },
    { key: 'vpip', label: 'VPIP', title: 'Put chips in voluntarily before the flop', pct: true },
    { key: 'pfr', label: 'PFR', title: 'Raised before the flop', pct: true },
    { key: 'foldPct', label: 'Fold', title: 'Share of decisions that were folds', pct: true },
    { key: 'checkPct', label: 'Check', title: 'Share of decisions that were checks', pct: true },
    { key: 'callPct', label: 'Call', title: 'Share of decisions that were calls', pct: true },
    { key: 'raisePct', label: 'Bet/Raise', title: 'Share of decisions that were bets or raises', pct: true },
    { key: 'biggestPot', label: 'Best pot', title: 'Biggest pot won', chips: true },
  ];

  function statText(r, c) {
    const v = r[c.key];
    if (v == null) return '–';
    if (c.pct) return v + '%';
    if (c.chips) return v ? fmt(v) : '–';
    return String(v);
  }

  /** One table for both the mid-game peek and the final screen. */
  function buildStatsTable(rows, opts) {
    const table = document.createElement('table');
    table.className = 'stats-table';
    const head = document.createElement('tr');
    [['', 'st-rank'], ['Player', 'st-player'], [opts.chipsLabel, 'st-chips']].forEach(function (h) {
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

      const chips = document.createElement('td');
      chips.className = 'st-chips'; chips.textContent = opts.chips(r);

      tr.appendChild(rank); tr.appendChild(who); tr.appendChild(chips);
      STAT_COLS.forEach(function (c) {
        const td = document.createElement('td');
        td.textContent = c.key === 'hands' && opts.hands ? opts.hands(r) : statText(r, c);
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

  /** Chip leaders first; anyone already out drops below in finishing order. */
  function setStats(stats) {
    if (!stats) { hideStatsDock(); return; }
    statsDock.hidden = false;
    const key = JSON.stringify(stats);
    if (key === statsKey) return;   // don't rebuild under the host's eyes
    statsKey = key;
    const rows = stats.slice().sort(function (a, b) {
      if (a.busted !== b.busted) return a.busted ? 1 : -1;
      if (a.busted) return a.place - b.place;
      return b.stack - a.stack || a.name.localeCompare(b.name);
    });
    statsRows.innerHTML = '';
    statsRows.appendChild(buildStatsTable(rows, {
      chipsLabel: 'Chips',
      dimOut: true,
      rank: function (r, i) { return r.busted ? ordinal(r.place) : '#' + (i + 1); },
      chips: function (r) { return r.busted ? 'Out' : fmt(r.stack); },
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
    clearAward();
    clearStackCounts();
    hideStatsDock();
    finalTrophy.textContent = '🏆';
    finalHeading.innerHTML = '';
    const champ = (s.standings || []).find(function (r) { return r.playerId === s.winnerId; });
    if (champ) {
      finalHeading.appendChild(nameSpan(champ.name, champ.seat));
      finalHeading.appendChild(document.createTextNode(' wins!'));
    } else {
      finalHeading.textContent = 'Game over';
    }
    finalSub.textContent = 'Last player standing after ' + s.handsPlayed + (s.handsPlayed === 1 ? ' hand' : ' hands');

    finalList.innerHTML = '';
    const rows = (s.stats || []).slice().sort(function (a, b) {
      return (a.place || 1) - (b.place || 1) || a.name.localeCompare(b.name);
    });
    finalList.appendChild(buildStatsTable(rows, {
      chipsLabel: 'Result',
      winnerId: s.winnerId,
      rank: function (r) {
        const p = r.place || 1;
        return p === 1 ? '🥇' : (p === 2 ? '🥈' : (p === 3 ? '🥉' : ordinal(p)));
      },
      chips: function (r) { return r.playerId === s.winnerId ? fmt(r.stack) + ' chips' : 'Out on hand ' + r.bustHand; },
      hands: function (r) { return r.playerId === s.winnerId ? s.handsPlayed + '+' : String(r.hands); },
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
  socket.on('state:handEnd', renderHandEnd);
  socket.on('state:final', renderFinal);

  socket.on('state:reset', function () {
    clearAward();
    clearStackCounts();
    clearPotHold();
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    hideLevelBanner();
    handLineEl.textContent = '';
    hideStatsDock();
    seatOrderIds = [];
    clearSeatBubbles();
    seatEls = {};
    seatLayer.innerHTML = '';
    renderBoard([], null);
    lastEventSeq = -1;
    lastActedSeq = -1;
    lastCollectSeq = -1;
    lastTurnId = null;
    lastHandSeen = 0;
    lastHumanTotal = -1;
    show('lobby');
  });

  // ---------------- Boot ----------------
  renderQR();
})();
