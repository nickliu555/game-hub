(function () {
  'use strict';

  const socket = io('/ratscrew', { transports: ['polling', 'websocket'] });

  // ---------------- Card assets ----------------
  // The faces are Hold'em's (pips/aces SVG, court cards WebP); the back is Ratscrew's own.
  function cardSrc(code) {
    const rank = code.slice(0, code.length - 1);
    const ext = (rank === 'J' || rank === 'Q' || rank === 'K') ? '.webp' : '.svg';
    return '/holdempoker/assets/cards/' + code + ext;
  }
  const SUIT_WORD = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };
  const FACE_WORD = { J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };
  const PATTERN_WORD = { double: 'Double!', sandwich: 'Sandwich!', flush: 'Flush!' };
  function cardLabel(code) { return code.slice(0, code.length - 1) + ' of ' + SUIT_WORD[code.slice(-1)]; }
  function cardImg(code, cls) {
    const img = document.createElement('img');
    img.className = 'card' + (cls ? ' ' + cls : '');
    img.src = cardSrc(code);
    img.alt = cardLabel(code);
    img.draggable = false;
    img.dataset.card = code;
    return img;
  }
  function cardBack(cls) {
    const d = document.createElement('div');
    d.className = 'card card-back' + (cls ? ' ' + cls : '');
    return d;
  }
  // Preload every face so a flipped card never pops in blank.
  (function preload() {
    ['C', 'D', 'H', 'S'].forEach(function (s) {
      ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].forEach(function (r) { new Image().src = cardSrc(r + s); });
    });
  }());

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function nameSpan(name, seat) {
    const s = document.createElement('span');
    s.className = 'pname';
    if (seat) s.dataset.seat = seat;
    s.textContent = name;
    return s;
  }
  /** Fill `el` with text and name spans: parts are strings or { name, seat }. */
  function fillLine(el, parts) {
    el.textContent = '';
    parts.forEach(function (p) {
      if (p == null) return;
      if (typeof p === 'string') el.appendChild(document.createTextNode(p));
      else if (p.nodeType) el.appendChild(p);
      else el.appendChild(nameSpan(p.name, p.seat));
    });
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
  const flushSeg = document.getElementById('flushSeg');

  const stage = document.getElementById('stage');
  const felt = document.getElementById('felt');
  const feltCenter = document.getElementById('feltCenter');
  const turnText = document.getElementById('turnText');
  const lockBar = document.getElementById('lockBar');
  const lockFill = document.getElementById('lockFill');
  const pileArea = document.getElementById('pileArea');
  const pileEmpty = document.getElementById('pileEmpty');
  const pileUnder = document.getElementById('pileUnder');
  const pileFan = document.getElementById('pileFan');
  const pileCountEl = document.getElementById('pileCount');
  const challengeLine = document.getElementById('challengeLine');
  const seatLayer = document.getElementById('seatLayer');
  const fxLayer = document.getElementById('fxLayer');
  const callBanner = document.getElementById('callBanner');
  const cbTitle = document.getElementById('cbTitle');
  const cbSub = document.getElementById('cbSub');
  const waitingNote = document.getElementById('waitingNote');

  const finalHeading = document.getElementById('finalHeading');
  const finalSub = document.getElementById('finalSub');
  const finalList = document.getElementById('finalList');
  const playAgainBtn = document.getElementById('playAgainBtn');
  const rematchBtn = document.getElementById('rematchBtn');

  const connOverlay = document.getElementById('connOverlay');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const resetBtn = document.getElementById('resetBtn');

  // ---------------- View stack ----------------
  let currentView = 'lobby';
  let showTimer = null;
  let afterShow = [];
  function forceSingle(name) {
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle('active', k === name);
      views[k].classList.remove('fading-out');
    });
    currentView = name;
  }
  function flushAfterShow() {
    const q = afterShow;
    afterShow = [];
    q.forEach(function (fn) { fn(); });
  }
  /** Switch views; `done` runs once the new view is laid out (now, if it already is). */
  function show(name, done) {
    if (window.screenChange) window.screenChange(currentView, name, ['lobby', 'final']);
    if (done) afterShow.push(done);
    if (currentView === name) { if (!showTimer) flushAfterShow(); return; }
    // Clear any in-flight transition first, or two views can end up .active.
    if (showTimer) { clearTimeout(showTimer); showTimer = null; forceSingle(currentView); }
    const from = views[currentView];
    currentView = name;
    if (!from) { forceSingle(name); flushAfterShow(); return; }
    from.classList.add('fading-out');
    showTimer = setTimeout(function () {
      showTimer = null;
      forceSingle(name);
      flushAfterShow();
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
  /** White-noise burst — the basis of card flicks, slaps and riffles. */
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
  /** The deck riffling out round the table. */
  function playDealRiffle() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < 22; i++) noise(0.05, 0.07, 2600 + Math.random() * 1400, b + i * 0.07);
  }
  /** A card flicked onto the pile — the "look up" cue for every play. */
  function playFlick() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    noise(0.06, 0.16, 3400, b);
    noise(0.05, 0.12, 700, b + 0.03, 'lowpass');
  }
  /** A face card: a bright two-note call so the table looks up for the challenge. */
  function playFaceCall() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime + 0.08;
    blip(784, 0.16, 'square', 0.07, b);
    blip(1175, 0.3, 'square', 0.07, b + 0.11);
  }
  /** A palm smacking the pile. */
  function playSmack() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    noise(0.14, 0.55, 900, b, 'lowpass');
    noise(0.05, 0.3, 2600, b);
    blip(95, 0.18, 'triangle', 0.45, b);
  }
  function playGoodSlap() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime + 0.12;
    [659, 880, 1175].forEach(function (f, i) { blip(f, 0.22, 'triangle', 0.17, b + i * 0.07); });
  }
  function playBadSlap() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime + 0.1;
    sweep(320, 110, 0.42, 'square', 0.11, b);
    blip(140, 0.38, 'sawtooth', 0.06, b);
  }
  /** The pile swept off to its new owner. */
  function playCollect() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < 9; i++) noise(0.045, 0.075, 2400 + Math.random() * 1600, b + i * 0.035);
  }
  /** A challenge won: the pile is theirs. */
  function playChallengeWon() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [523, 784, 1047].forEach(function (f, i) { blip(f, 0.3, 'sine', 0.17, b + i * 0.09); });
  }
  function playSad() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [392, 370, 349, 294].forEach(function (f, i) { blip(f, i === 3 ? 0.7 : 0.3, 'triangle', 0.18, b + i * 0.26); });
  }
  function playWinSting() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [523, 659, 784, 1047, 1319].forEach(function (f, i) { blip(f, 0.3, 'triangle', 0.18, b + i * 0.09); });
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

  function confetti() {
    if (window.Confetti) window.Confetti.burst(['#F2C14E', '#FF5A4E', '#5AB8F0', '#FF9A5A', '#B892FF', '#5FD39A', '#ffffff']);
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

  // ---------------- Reactions (lobby and final standings only) ----------------
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
  const BUBBLE_GAP = 18;
  const seatBubbles = {};   // playerId → { el, timer }

  /** Park the bubble beside the seat's plate, on the side facing the middle of the table. */
  function placeBubble(pid) {
    const rec = seatBubbles[pid];
    const e = seatEls[pid];
    if (!rec || !e) return;
    const root = e.root;
    const box = e.box;
    const boxLeft = root.offsetLeft - root.offsetWidth / 2 + box.offsetLeft;
    const y = root.offsetTop - root.offsetHeight / 2 + box.offsetTop + box.offsetHeight / 2;
    const onRight = root.offsetLeft > felt.offsetLeft + felt.offsetWidth * 0.58;
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
  let lobby = { players: [], total: 0, capacity: 8, canStart: false, flush: true };
  let lastHumanTotal = -1;
  let dragActive = false;    // a row is mid-drag; defer lobby rebuilds
  let pendingLobby = null;   // latest snapshot to apply once the drag settles

  function renderQR() {
    fetch('/api/ratscrew/config').then(function (r) { return r.json(); }).then(function (cfg) {
      const url = (cfg && cfg.joinUrl) || (window.location.origin + '/ratscrew/join');
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      return fetch('/api/ratscrew/qr?url=' + encodeURIComponent(url));
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
    setSeg(flushSeg, l.flush ? 'on' : 'off');

    seatList.innerHTML = '';
    l.players.forEach(function (p) {
      const row = document.createElement('div');
      row.className = 'seat-row' + (p.connected === false ? ' disconnected' : '');
      row.dataset.pid = p.id;

      const grip = document.createElement('span');
      grip.className = 'seat-grip'; grip.textContent = '⠿'; grip.title = 'Drag to reseat';

      const badge = document.createElement('span');
      badge.className = 'seat-badge'; badge.dataset.seat = p.seat;

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
      e.textContent = 'Open seat';
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
  flushSeg.addEventListener('click', function (e) {
    const btn = e.target.closest('.seg-btn');
    if (!btn || btn.classList.contains('on')) return;
    setSeg(flushSeg, btn.dataset.value);
    socket.emit('host:setFlush', { flush: btn.dataset.value === 'on' }, function (res) {
      if (res && !res.ok) renderLobby(lobby);   // rejected — resync from truth
    });
  });

  startBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
      if (res && !res.ok) toast('Could not start — the table needs at least 2 players.');
      else playStartFanfare();
    });
  });

  playAgainBtn.addEventListener('click', function () {
    showInlineConfirm('Back to the lobby? Everyone will need to rejoin.', function () {
      socket.emit('host:reset', {});
    }, { okLabel: 'Back to lobby' });
  });

  // Same seats, same settings, a fresh deal.
  rematchBtn.addEventListener('click', function () {
    if (rematchBtn.disabled) return;
    unlockAudio();
    rematchBtn.disabled = true;
    socket.emit('host:rematch', {}, function (res) {
      rematchBtn.disabled = false;
      if (!res || !res.ok) { toast('Could not start a new game.'); return; }
      playStartFanfare();
    });
  });

  // ---------------- The table ----------------
  let seatEls = {};          // playerId → element refs
  let seatOrderIds = [];
  let seatByPlayer = {};     // playerId → seat number
  let nameByPlayer = {};
  let lastState = null;
  let lastSeq = -1;          // -1 until the first render adopts the current events silently
  let clockOffset = 0;
  let fxTimers = [];
  let countHolds = {};       // playerId → shown count while cards are still flying

  function serverNow() { return Date.now() + clockOffset; }
  function syncClock(payload) {
    if (payload && typeof payload.serverNow === 'number') clockOffset = payload.serverNow - Date.now();
  }
  function later(fn, ms) {
    const t = setTimeout(function () { fxTimers = fxTimers.filter(function (x) { return x !== t; }); fn(); }, Math.max(0, ms));
    fxTimers.push(t);
    return t;
  }
  function motionOk() {
    if (typeof Element.prototype.animate !== 'function') return false;
    return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function who(pid) { return { name: nameByPlayer[pid] || '?', seat: seatByPlayer[pid] }; }

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

      const deck = document.createElement('div');
      deck.className = 'seat-deck';
      deck.appendChild(cardBack('deck-layer'));
      deck.appendChild(cardBack('deck-layer'));
      const top = cardBack('deck-top');
      deck.appendChild(top);
      const count = document.createElement('span');
      count.className = 'deck-count';
      deck.appendChild(count);

      const box = document.createElement('div');
      box.className = 'seat-box';
      const label = document.createElement('div');
      label.className = 'seat-label';
      const pip = document.createElement('span');
      pip.className = 'seat-pip'; pip.dataset.seat = s.seat;
      const name = document.createElement('span');
      name.className = 'pname';
      label.appendChild(pip); label.appendChild(name);
      const sub = document.createElement('div');
      sub.className = 'seat-sub';
      const ch = document.createElement('span');
      ch.className = 'seat-ch'; ch.hidden = true;
      deck.appendChild(ch);
      box.appendChild(label); box.appendChild(sub);

      root.appendChild(deck); root.appendChild(box);
      seatLayer.appendChild(root);
      seatEls[s.playerId] = { root: root, deck: deck, deckTop: top, count: count, box: box, name: name, sub: sub, ch: ch, shown: null, chKey: '' };
    });
    layoutSeats();
  }

  /**
   * Place every seat on the rail of the oval, clockwise from the bottom centre.
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
    const ex = felt.offsetWidth / 2 - over;
    const ey = felt.offsetHeight / 2 - over;
    const hw = rootW / 2;
    const hh = boxH / 2;
    const boxOffset = boxTop + boxH / 2 - rootH / 2;   // plate centre, relative to the seat's centre
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
    fitCenter();
    placeBubbles();
  }

  /** Stage-coordinate rect of a centred (translate -50%) absolutely placed element. */
  function centredRect(x, y, w, h) { return { l: x - w / 2, t: y - h / 2, r: x + w / 2, b: y + h / 2 }; }
  function overlaps(a, b) { return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t; }

  /**
   * The biggest pile (with the turn line, pile count and challenge line) that fits on
   * the felt without touching any seat. Every line has a reserved height, so the
   * pile never moves as the text under it changes.
   */
  function fitCenter() {
    if (!felt.offsetWidth || !seatOrderIds.length) return;
    const pad = 10;
    const obstacles = Object.keys(seatEls).map(function (pid) {
      const r = seatEls[pid].root;
      return centredRect(r.offsetLeft, r.offsetTop, r.offsetWidth + pad * 2, r.offsetHeight + pad * 2);
    });
    const fx = felt.offsetLeft + felt.clientLeft;
    const fy = felt.offsetTop + felt.clientTop;
    const cx = fx + felt.clientWidth / 2;
    const cy = fy + felt.clientHeight / 2;
    const rx = felt.clientWidth / 2 - 8;
    const ry = felt.clientHeight / 2 - 8;
    const insideFelt = function (r) {
      return [[r.l, r.t], [r.r, r.t], [r.l, r.b], [r.r, r.b]].every(function (p) {
        const dx = (p[0] - cx) / rx;
        const dy = (p[1] - cy) / ry;
        return dx * dx + dy * dy <= 1;
      });
    };
    const place = function (y) {
      feltCenter.style.left = Math.round(cx - fx) + 'px';
      feltCenter.style.top = Math.round(y - fy) + 'px';
    };
    for (let cw = 220; cw >= 40; cw -= 4) {
      for (let mode = 0; mode < 2; mode++) {
        feltCenter.classList.toggle('row', mode === 0);
        feltCenter.style.setProperty('--card-w', cw + 'px');
        const w = feltCenter.offsetWidth;
        const h = feltCenter.offsetHeight;
        for (let k = 0; k * 4 <= felt.clientHeight / 3; k++) {
          const offs = k === 0 ? [0] : [-k * 4, k * 4];
          for (let i = 0; i < offs.length; i++) {
            const y = cy + offs[i];
            const rect = centredRect(cx, y, w, h);
            if (!insideFelt(rect)) continue;
            if (obstacles.some(function (o) { return overlaps(rect, o); })) continue;
            place(y);
            positionPileCards(true);
            return;
          }
        }
      }
    }
    feltCenter.classList.remove('row');
    feltCenter.style.setProperty('--card-w', '40px');
    place(cy);
    positionPileCards(true);
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(layoutSeats).observe(stage);
  window.addEventListener('resize', layoutSeats);

  let nameProbe = null;
  // The seat box is width-capped, so a long name shrinks its own text down to
  // a readable floor rather than wrapping; the full name shows in the turn line and final table.
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

  function setSeatCount(pid, n, pop) {
    const e = seatEls[pid];
    if (!e) return;
    e.count.textContent = n;
    e.deck.classList.toggle('empty', n === 0);
    e.deck.classList.toggle('thick-2', n >= 6 && n < 20);
    e.deck.classList.toggle('thick-3', n >= 20);
    if (pop && motionOk()) {
      e.count.classList.remove('pop');
      void e.count.offsetWidth;
      e.count.classList.add('pop');
    }
  }

  function renderSeats(s) {
    ensureSeats(s.seats);
    s.seats.forEach(function (seat) {
      const e = seatEls[seat.playerId];
      if (!e) return;
      e.root.dataset.seat = seat.seat;
      e.root.classList.toggle('turn', seat.playerId === s.turnPlayerId && !s.claim && !s.ending);
      e.root.classList.toggle('offline', !seat.isBot && seat.connected === false && !seat.out);
      e.root.classList.toggle('winner', seat.playerId === s.winnerId);
      if (!e.koPending) e.root.classList.toggle('out', !!seat.out);
      if (e.name.textContent !== seat.name) { e.name.textContent = seat.name; fitSeatName(e.name); }

      const hold = countHolds[seat.playerId];
      setSeatCount(seat.playerId, hold ? hold.value : seat.count, false);

      let sub;
      if (seat.playerId === s.winnerId) sub = '🏆 Winner';
      else if (seat.out) sub = 'Out · ' + ordinal(seat.place);
      else if (!seat.isBot && seat.connected === false) sub = 'Away';
      else sub = '';
      e.sub.textContent = sub;

      const ch = s.challenge && s.challenge.byId === seat.playerId ? s.challenge : null;
      const chKey = ch ? ch.rank : '';
      if (chKey !== e.chKey) {
        e.chKey = chKey;
        e.ch.hidden = !ch;
        if (ch) e.ch.textContent = '👑 ' + ch.rank;
      }
    });
  }

  // ---- The pile ----
  const FAN_STEP = 0;       // only the top card shows; anything under it sits exactly beneath
  const FAN_W = 1.3;        // pile-area width, in card widths
  let fanEls = {};          // card code → element in the fan
  let pileCards = [];       // the codes shown, oldest first
  let heldCard = null;      // a card still in flight to the pile

  function cardTilt(code) {
    let h = 0;
    for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 997;
    return ((h % 7) - 3) * 0.9;
  }

  function positionPileCards(instant) {
    const k = pileCards.length;
    const startX = (FAN_W - (1 + (k - 1) * FAN_STEP)) / 2;
    pileCards.forEach(function (code, i) {
      const el = fanEls[code];
      if (!el) return;
      if (instant) el.style.transition = 'none';
      el.style.left = 'calc(var(--card-w) * ' + (startX + i * FAN_STEP).toFixed(3) + ')';
      el.style.zIndex = String(i + 1);
      el.classList.toggle('is-top', i === k - 1);
      if (instant) { void el.offsetWidth; el.style.transition = ''; }
    });
  }

  function renderPile(s) {
    // Only the top card is face up. While a new card is still flying in, the one it
    // will cover stays put underneath, so the pile never blinks empty.
    const all = s.pile || [];
    const codes = all.slice(heldCard && all[all.length - 1] === heldCard ? -2 : -1);
    const keep = {};
    codes.forEach(function (c) { keep[c] = true; });
    Object.keys(fanEls).forEach(function (c) {
      if (!keep[c]) { fanEls[c].remove(); delete fanEls[c]; }
    });
    const fresh = [];
    codes.forEach(function (c) {
      if (fanEls[c]) return;
      const img = cardImg(c, 'pile-card');
      img.style.rotate = cardTilt(c) + 'deg';
      pileFan.appendChild(img);
      fanEls[c] = img;
      fresh.push(c);
    });
    pileCards = codes;
    // New cards appear in place; the older ones slide left to make room.
    fresh.forEach(function (c) { fanEls[c].style.transition = 'none'; });
    positionPileCards(false);
    fresh.forEach(function (c) { void fanEls[c].offsetWidth; fanEls[c].style.transition = ''; });
    Object.keys(fanEls).forEach(function (c) { fanEls[c].classList.toggle('hold', c === heldCard); });

    // Older cards show as a face-down stack peeking out under the top one.
    const under = Math.min(3, Math.max(0, s.pileCount - codes.length));
    while (pileUnder.children.length > under) pileUnder.lastElementChild.remove();
    while (pileUnder.children.length < under) {
      const i = pileUnder.children.length;
      const b = cardBack();
      b.style.left = 'calc(var(--card-w) * ' + [0.08, 0.22, 0.15][i] + ')';
      b.style.rotate = [-9, 7, -2][i] + 'deg';
      pileUnder.appendChild(b);
    }
    pileEmpty.hidden = s.pileCount > 0;

    const prevCount = lastState ? lastState.pileCount : null;
    pileCountEl.textContent = '';
    const lbl = document.createElement('span');
    lbl.className = 'pc-label';
    lbl.textContent = 'Pile';
    pileCountEl.appendChild(lbl);
    pileCountEl.appendChild(document.createTextNode(s.pileCount ? plural(s.pileCount, 'card') : 'empty'));
    if (prevCount != null && prevCount !== s.pileCount && s.pileCount > 0 && motionOk()) {
      pileCountEl.classList.remove('bump');
      void pileCountEl.offsetWidth;
      pileCountEl.classList.add('bump');
    }
    pileArea.classList.toggle('won', !!s.claim && s.pileCount > 0);
  }

  // ---- Turn line + play lock ----
  let turnTimer = null;
  function setLockBar(remaining, total, claim) {
    lockBar.classList.toggle('claim', !!claim);
    if (remaining <= 0 || !total) {
      lockBar.classList.remove('on');
      lockFill.style.transition = 'none';
      lockFill.style.width = '0%';
      return;
    }
    lockBar.classList.add('on');
    lockFill.style.transition = 'none';
    lockFill.style.width = Math.min(100, 100 * remaining / total) + '%';
    void lockFill.offsetWidth;
    lockFill.style.transition = 'width ' + remaining + 'ms linear';
    lockFill.style.width = '0%';
  }

  function renderTurn(s) {
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
    turnText.classList.remove('ready');
    const now = serverNow();
    if (s.ending) {
      fillLine(turnText, s.winnerId ? [who(s.winnerId), ' wins!'] : ['Game over']);
      setLockBar(0);
      return;
    }
    if (s.claim) {
      const c = s.claim;
      const remaining = c.until - now;
      if (c.reason === 'slap') fillLine(turnText, [who(c.byId), ' slapped it!']);
      else fillLine(turnText, [who(c.byId), ' takes the pile…']);
      setLockBar(remaining, c.reason === 'slap' ? remaining : s.playLockMs, true);
      return;
    }
    if (!s.turnPlayerId) { fillLine(turnText, ['\u00a0']); setLockBar(0); return; }
    const remaining = s.nextPlayAt - now;
    const turn = who(s.turnPlayerId);
    const ready = function () {
      fillLine(turnText, [turn, s.cardsPlayed === 0 ? ' starts — play a card!' : ', play a card!']);
      turnText.classList.add('ready');
      setLockBar(0);
    };
    if (remaining > 40) {
      if (s.cardsPlayed === 0) fillLine(turnText, ['Dealing…']);
      else fillLine(turnText, [turn, ' plays next']);
      setLockBar(remaining, s.cardsPlayed === 0 ? remaining : s.playLockMs);
      turnTimer = setTimeout(ready, remaining);
    } else ready();
  }

  // ---- Challenge line ----
  let challengeKey = '';
  function renderChallenge(s) {
    let key = '';
    let parts = null;
    let pips = null;
    if (s.challenge && !s.ending) {
      const ch = s.challenge;
      key = 'ch|' + ch.byId + '|' + ch.rank + '|' + ch.left + '|' + s.turnPlayerId;
      const face = document.createElement('span');
      face.className = 'ch-face';
      face.textContent = FACE_WORD[ch.rank] + '!';
      parts = [face, ' ', who(s.turnPlayerId), ' has ' + plural(ch.left, 'try', 'tries') + ' to play a face card'];
      pips = document.createElement('span');
      pips.className = 'ch-pips';
      for (let i = 0; i < ch.total; i++) {
        const p = document.createElement('span');
        p.className = 'ch-pip' + (i < ch.left ? ' left' : '');
        pips.appendChild(p);
      }
    } else if (s.claim && s.claim.reason !== 'slap' && !s.ending) {
      key = 'claim|' + s.claim.byId + '|' + s.claim.until;
      const face = document.createElement('span');
      face.className = 'ch-face';
      face.textContent = s.claim.reason === 'runout' ? 'Out of cards!' : 'No face card!';
      parts = [face, ' ', who(s.claim.byId), ' wins the pile'];
    }
    if (key === challengeKey) return;
    const sameChallenge = key.split('|').slice(0, 3).join('|') === challengeKey.split('|').slice(0, 3).join('|');
    challengeKey = key;
    if (!parts) { challengeLine.textContent = ''; return; }
    fillLine(challengeLine, parts);
    if (pips) challengeLine.appendChild(pips);
    if (!sameChallenge && motionOk()) {
      challengeLine.classList.remove('fresh');
      void challengeLine.offsetWidth;
      challengeLine.classList.add('fresh');
    }
  }

  function renderWaiting(s) {
    if (!s.waitingOn || s.claim || s.ending) { waitingNote.hidden = true; return; }
    fillLine(waitingNote, ['Waiting for ', who(s.turnPlayerId), ' to come back…']);
    waitingNote.hidden = false;
  }

  // ---------------- Effects ----------------
  const FLY_MS = 440;
  const SLAP_IN_MS = 400;
  const COLLECT_MS = 640;
  let landAt = 0;            // when the card in flight lands (ms epoch)
  let bannerTimer = null;

  /** An element's rect in stage coordinates. */
  function rel(el) {
    const sr = stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height, cx: r.left - sr.left + r.width / 2, cy: r.top - sr.top + r.height / 2 };
  }
  /** Like rel(), but the element's own (unrotated) size around its on-screen centre. */
  function relBox(el) {
    const r = rel(el);
    const w = el.offsetWidth || r.w;
    const h = el.offsetHeight || r.h;
    return { x: r.cx - w / 2, y: r.cy - h / 2, w: w, h: h, cx: r.cx, cy: r.cy };
  }
  function cardW() { return parseFloat(getComputedStyle(feltCenter).getPropertyValue('--card-w')) || 120; }
  /** Where the newest card sits on the pile (the top of the fan, or the middle when empty). */
  function pileTopRect() {
    const top = pileCards.length ? fanEls[pileCards[pileCards.length - 1]] : null;
    if (top) return relBox(top);
    const r = rel(pileArea);
    const w = cardW();
    return { x: r.cx - w / 2, y: r.cy - w * 0.7, w: w, h: w * 1.4, cx: r.cx, cy: r.cy };
  }
  function tf(x, y, s, r) { return 'translate(' + x + 'px, ' + y + 'px) scale(' + s + ') rotate(' + (r || 0) + 'deg)'; }

  /** A card flies from a seat's deck onto the pile, flipping face up on the way. */
  function flyPlay(ev) {
    const e = seatEls[ev.playerId];
    const target = fanEls[ev.card];
    if (!e || !motionOk()) { if (target) target.classList.remove('hold'); heldCard = null; return; }
    const from = relBox(e.deckTop);
    const to = target ? relBox(target) : pileTopRect();
    const el = document.createElement('div');
    el.className = 'fly-card';
    el.style.width = to.w + 'px';
    el.style.height = to.h + 'px';
    el.style.setProperty('--card-w', to.w + 'px');
    const inner = document.createElement('div');
    inner.className = 'fc-inner';
    inner.appendChild(cardImg(ev.card));
    inner.appendChild(cardBack('fc-back'));
    el.appendChild(inner);
    fxLayer.appendChild(el);
    const s0 = from.w / to.w;
    const tilt = target ? cardTilt(ev.card) : 0;
    const midX = (from.cx + to.cx) / 2 - to.w / 2;
    const midY = (from.cy + to.cy) / 2 - to.h / 2 - Math.min(80, Math.hypot(to.cx - from.cx, to.cy - from.cy) * 0.12);
    const a = el.animate([
      { transform: tf(from.cx - to.w / 2, from.cy - to.h / 2, s0, -8) },
      { transform: tf(midX, midY, 1.12, tilt / 2), offset: 0.6 },
      { transform: tf(to.x, to.y, 1, tilt) },
    ], { duration: FLY_MS, easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)', fill: 'forwards' });
    inner.animate([{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(180deg)', offset: 0.2 }, { transform: 'rotateY(0deg)' }],
      { duration: FLY_MS, easing: 'ease-out', fill: 'forwards' });
    landAt = Date.now() + FLY_MS;
    const land = function () {
      if (heldCard === ev.card) heldCard = null;
      if (fanEls[ev.card]) {
        fanEls[ev.card].classList.remove('hold');
        el.remove();
        // The card it landed on is now covered: drop it.
        pileCards.slice(0, -1).forEach(function (c) { if (fanEls[c]) { fanEls[c].remove(); delete fanEls[c]; } });
        pileCards = pileCards.slice(-1);
      }
      else later(function () { el.remove(); }, COLLECT_MS + 400);   // collected mid-flight: it rides along
    };
    a.onfinish = land;
    a.oncancel = function () { el.remove(); };
    if (!target) el.dataset.orphan = '1';
  }

  /** The deal: backs spin out from the middle to every seat while the counts climb. */
  function animateDeal(s) {
    const seats = s.seats;
    const DEAL_ANIM = 1700;
    seats.forEach(function (seat) {
      countHolds[seat.playerId] = { value: 0 };
      setSeatCount(seat.playerId, 0, false);
    });
    const start = Date.now();
    const tick = function () {
      const f = Math.min(1, (Date.now() - start) / DEAL_ANIM);
      seats.forEach(function (seat) {
        const v = Math.round(seat.count * f);
        if (countHolds[seat.playerId]) countHolds[seat.playerId].value = v;
        setSeatCount(seat.playerId, v, false);
      });
      if (f < 1) later(tick, 60);
      else seats.forEach(function (seat) { delete countHolds[seat.playerId]; setSeatCount(seat.playerId, seat.count, true); });
    };
    tick();
    if (!motionOk()) return;
    const mid = pileTopRect();
    const rounds = 3;
    for (let r = 0; r < rounds; r++) {
      seats.forEach(function (seat, i) {
        const e = seatEls[seat.playerId];
        if (!e) return;
        later(function () {
          const to = relBox(e.deckTop);
          const el = document.createElement('div');
          el.className = 'fly-card';
          el.style.width = to.w + 'px';
          el.style.height = to.h + 'px';
          el.style.setProperty('--card-w', to.w + 'px');
          el.appendChild(cardBack());
          fxLayer.appendChild(el);
          const a = el.animate([
            { transform: tf(mid.cx - to.w / 2, mid.cy - to.h / 2, 1, 0), opacity: 1 },
            { transform: tf(to.x, to.y, 1, 180), opacity: 1, offset: 0.85 },
            { transform: tf(to.x, to.y, 1, 180), opacity: 0 },
          ], { duration: 520, easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)', fill: 'forwards' });
          a.onfinish = a.oncancel = function () { el.remove(); };
        }, (r * seats.length + i) * Math.min(110, DEAL_ANIM / (rounds * seats.length)));
      });
    }
  }

  /** A hand flies from the slapper's plate and smacks the pile. Returns the impact delay. */
  function flyHand(pid, bad) {
    const e = seatEls[pid];
    if (!e) return 0;
    const from = rel(e.box);
    const to = pileTopRect();
    const size = Math.max(70, cardW() * 0.95);
    const el = document.createElement('div');
    el.className = 'slap-hand';
    el.dataset.seat = seatByPlayer[pid];
    el.style.setProperty('--hand-size', size + 'px');
    const g = document.createElement('span');
    g.className = 'sh-glyph';
    g.textContent = '🖐️';
    el.appendChild(g);
    fxLayer.appendChild(el);
    const angle = Math.atan2(to.cy - from.cy, to.cx - from.cx) * 180 / Math.PI + 90;
    const h = size / 2;
    const end = { x: to.cx - h, y: to.cy - h * 1.05 };
    const a = el.animate([
      { transform: tf(from.cx - h, from.cy - h, 0.5, angle), opacity: 0 },
      { transform: tf(from.cx - h, from.cy - h, 0.9, angle), opacity: 1, offset: 0.14 },
      { transform: tf(end.x, end.y, 1.45, angle), opacity: 1, offset: 0.72 },
      { transform: tf(end.x, end.y, 0.92, angle), opacity: 1, offset: 0.86 },
      { transform: tf(end.x, end.y, 1, angle), opacity: 1 },
    ], { duration: SLAP_IN_MS + 60, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards' });
    a.oncancel = function () { el.remove(); };
    later(function () {
      const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, fill: 'forwards' });
      fade.onfinish = fade.oncancel = function () { el.remove(); };
    }, bad ? 1250 : 1050);

    later(function () {
      const ring = document.createElement('div');
      ring.className = 'slap-ring' + (bad ? ' bad' : '');
      ring.dataset.seat = seatByPlayer[pid];
      const rs = size * 1.7;
      ring.style.setProperty('--ring-size', rs + 'px');
      fxLayer.appendChild(ring);
      const ra = ring.animate([
        { transform: tf(to.cx - rs / 2, to.cy - rs / 2, 0.3), opacity: 1 },
        { transform: tf(to.cx - rs / 2, to.cy - rs / 2, 1.6), opacity: 0 },
      ], { duration: 560, easing: 'ease-out', fill: 'forwards' });
      ra.onfinish = ra.oncancel = function () { ring.remove(); };
      if (bad) {
        const x = document.createElement('div');
        x.className = 'slap-x';
        x.textContent = '✕';
        x.style.setProperty('--hand-size', size * 1.1 + 'px');
        fxLayer.appendChild(x);
        const xs = size * 1.1;
        const xa = x.animate([
          { transform: tf(to.cx - xs * 0.3, to.cy - xs * 0.55, 0.4), opacity: 0 },
          { transform: tf(to.cx - xs * 0.3, to.cy - xs * 0.55, 1.15), opacity: 1, offset: 0.3 },
          { transform: tf(to.cx - xs * 0.3, to.cy - xs * 0.55, 1), opacity: 1, offset: 0.75 },
          { transform: tf(to.cx - xs * 0.3, to.cy - xs * 0.55, 1), opacity: 0 },
        ], { duration: 1100, fill: 'forwards' });
        xa.onfinish = xa.oncancel = function () { x.remove(); };
        pileArea.classList.remove('shake');
        void pileArea.offsetWidth;
        pileArea.classList.add('shake');
      }
    }, SLAP_IN_MS * 0.86);
    return SLAP_IN_MS * 0.86;
  }

  /**
   * The penalty: the slapper's cards fly across to the player they pay, whose
   * count ticks up as they land.
   */
  function flyBurn(fromId, toId, n, delay, newCount) {
    const e = seatEls[fromId];
    const t = seatEls[toId];
    const done = function () { delete countHolds[toId]; setSeatCount(toId, newCount, true); };
    if (!e || !t || !motionOk()) { done(); return; }
    later(function () {
      const from = relBox(e.deckTop);
      const to = relBox(t.deckTop);
      for (let i = 0; i < n; i++) {
        const el = document.createElement('div');
        el.className = 'fly-card';
        el.style.width = to.w + 'px';
        el.style.height = to.h + 'px';
        el.style.setProperty('--card-w', to.w + 'px');
        el.appendChild(cardBack());
        fxLayer.appendChild(el);
        const midX = (from.cx + to.cx) / 2 - to.w / 2;
        const midY = (from.cy + to.cy) / 2 - to.h / 2 - 40;
        const a = el.animate([
          { transform: tf(from.x, from.y, from.w / to.w, 0), opacity: 1 },
          { transform: tf(midX, midY, 1.25, i ? 200 : 160), opacity: 1, offset: 0.55 },
          { transform: tf(to.x, to.y, 1, 360), opacity: 1, offset: 0.92 },
          { transform: tf(to.x, to.y, 1, 360), opacity: 0 },
        ], { duration: 760, delay: i * 140, easing: 'cubic-bezier(0.4, 0, 0.3, 1)', fill: 'both' });
        a.onfinish = a.oncancel = function () { el.remove(); };
      }
      later(done, 700 + (n - 1) * 140);
    }, delay);
  }

  /** The name plate briefly shows what the player just did. */
  function flashSeat(pid, text, cls) {
    const e = seatEls[pid];
    if (!e) return;
    const old = e.box.querySelector('.action-flash');
    if (old) old.remove();
    const f = document.createElement('div');
    f.className = 'action-flash ' + cls;
    f.textContent = text;
    e.box.appendChild(f);
    later(function () { f.remove(); }, 2400);
  }

  function showBanner(title, parts, opts) {
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    const area = rel(pileArea);
    callBanner.style.left = area.cx + 'px';
    callBanner.style.top = area.cy + 'px';
    callBanner.classList.remove('leaving');
    callBanner.classList.toggle('win', !!(opts && opts.win));
    cbTitle.textContent = title;
    fillLine(cbSub, parts);
    callBanner.hidden = false;
    callBanner.style.animation = 'none';
    void callBanner.offsetWidth;
    callBanner.style.animation = '';
    bannerTimer = setTimeout(hideBanner, (opts && opts.ms) || 1500);
  }
  function hideBanner() {
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    if (callBanner.hidden) return;
    if (!motionOk()) { callBanner.hidden = true; return; }
    callBanner.classList.add('leaving');
    bannerTimer = setTimeout(function () { bannerTimer = null; callBanner.hidden = true; callBanner.classList.remove('leaving'); }, 300);
  }

  /**
   * Clones of every card on the pile, parked over the real ones, taken before a
   * render empties it — so the collected pile can visibly slide to its new owner.
   */
  function snapshotPile() {
    const out = [];
    const take = function (el) {
      const r = relBox(el);
      const c = el.cloneNode(true);
      c.classList.remove('hold', 'is-top');
      c.style.position = 'absolute';
      c.style.left = '0';
      c.style.top = '0';
      c.style.width = r.w + 'px';
      c.style.height = r.h + 'px';
      c.style.setProperty('--card-w', cardW() + 'px');
      c.style.rotate = el.style.rotate || '0deg';
      c.style.transform = tf(r.x, r.y, 1);
      c.style.transition = 'none';
      c.style.margin = '0';
      fxLayer.appendChild(c);
      out.push({ el: c, r: r });
    };
    Array.prototype.forEach.call(pileUnder.children, take);
    pileCards.forEach(function (code) { if (fanEls[code] && !fanEls[code].classList.contains('hold')) take(fanEls[code]); });
    return out;
  }

  /** The pile slides off to `pid`'s deck; their count ticks up as it lands. */
  function flyCollect(pid, clones, delay, newCount) {
    const e = seatEls[pid];
    const orphans = Array.prototype.slice.call(fxLayer.querySelectorAll('.fly-card[data-orphan]'));
    if (!e || !motionOk()) {
      clones.forEach(function (c) { c.el.remove(); });
      return;
    }
    later(function () {
      const to = relBox(e.deckTop);
      orphans.forEach(function (o) {
        if (!o.isConnected) return;
        const r = o.getBoundingClientRect();
        const sr = stage.getBoundingClientRect();
        // Freeze it where it landed (no cancel handler, or it would remove itself).
        o.getAnimations({ subtree: true }).forEach(function (an) { an.oncancel = null; an.onfinish = null; an.cancel(); });
        o.style.transform = 'none';
        clones.push({ el: o, r: { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height } });
      });
      playCollect();
      clones.forEach(function (c, i) {
        const s = to.w / c.r.w;
        const a = c.el.animate([
          { transform: tf(c.r.x, c.r.y, 1), opacity: 1 },
          { transform: tf(to.cx - c.r.w / 2, to.cy - c.r.h / 2, s), opacity: 1, offset: 0.85 },
          { transform: tf(to.cx - c.r.w / 2, to.cy - c.r.h / 2, s), opacity: 0 },
        ], { duration: COLLECT_MS, delay: i * 45, easing: 'cubic-bezier(0.45, 0, 0.25, 1)', fill: 'both' });
        a.onfinish = a.oncancel = function () { c.el.remove(); };
      });
      later(function () {
        delete countHolds[pid];
        setSeatCount(pid, newCount, true);
      }, COLLECT_MS + clones.length * 45 - 120);
    }, delay);
  }

  function knockout(pid, delay) {
    const e = seatEls[pid];
    if (!e) return;
    e.koPending = true;
    later(function () {
      e.koPending = false;
      playSad();
      e.root.classList.add('out', 'just-out');
      later(function () { e.root.classList.remove('just-out'); }, 1900);
      if (!motionOk()) return;
      later(function () {
        if (!e.root.isConnected) return;
        const skull = document.createElement('div');
        skull.className = 'ko-skull';
        skull.textContent = '💀';
        skull.style.left = e.root.style.left;
        skull.style.top = e.root.style.top;
        seatLayer.appendChild(skull);
        skull.addEventListener('animationend', function () { skull.remove(); });
      }, 900);
    }, delay);
  }

  /** Sounds and set-pieces for every event since the last render, in order. */
  function playEvents(fresh, s, leaving) {
    const now = serverNow();
    let cursor = 0;   // ms from now when the next set-piece may start
    fresh.forEach(function (ev) {
      // A long-backgrounded tab: skip straight past stale set-pieces.
      const stale = now - ev.at > 3500;
      switch (ev.type) {
        case 'deal':
          if (stale) break;
          playDealRiffle();
          animateDeal(s);
          break;
        case 'play':
          if (stale) { if (heldCard === ev.card) heldCard = null; break; }
          playFlick();
          if (ev.challenge) {
            playFaceCall();
          }
          flyPlay(ev);
          cursor = Math.max(cursor, FLY_MS);
          break;
        case 'slap': {
          if (stale) break;
          playSmack();
          const impact = motionOk() ? flyHand(ev.playerId, false) : 0;
          later(function () {
            playGoodSlap();
            showBanner(PATTERN_WORD[ev.pattern] || 'Slap!', [who(ev.playerId), ' takes ' + plural(ev.count, 'card')], { ms: 1500 });
          }, impact + 80);
          flashSeat(ev.playerId, 'Slap!', 'af-good');
          break;
        }
        case 'burn': {
          if (stale) break;
          playSmack();
          playBadSlap();
          const impact = motionOk() ? flyHand(ev.playerId, true) : 0;
          flyBurn(ev.playerId, ev.toId, ev.burned, impact + 250, ev.toCount);
          flashSeat(ev.playerId, 'Bad slap · −' + ev.burned, 'af-bad');
          later(function () { flashSeat(ev.toId, '+' + ev.burned + ' cards', 'af-good'); }, impact + 900);
          break;
        }
        case 'claim':
          if (stale || ev.reason === 'slap') break;
          later(playChallengeWon, cursor);
          break;
        case 'collect': {
          hideBanner();
          const clones = leaving || [];
          leaving = null;
          const prev = lastState && lastState.seats.find(function (x) { return x.playerId === ev.playerId; });
          if (!stale && motionOk() && prev) {
            countHolds[ev.playerId] = { value: prev.count };
            setSeatCount(ev.playerId, prev.count, false);
            const delay = Math.max(cursor, landAt - Date.now() + 120);
            flyCollect(ev.playerId, clones, delay, ev.total);
            cursor = Math.max(cursor, delay + COLLECT_MS);
          } else {
            clones.forEach(function (c) { c.el.remove(); });
            if (!stale) playCollect();
          }
          break;
        }
        case 'out':
          if (stale) break;
          knockout(ev.playerId, cursor + 200);
          cursor += 400;
          break;
        case 'win':
          if (stale) break;
          later(function () {
            playWinSting();
            showBanner('🏆 Winner!', [who(ev.playerId), ' has all the cards'], { win: true, ms: 8000 });
          }, cursor + 300);
          break;
        default: break;
      }
    });
    if (leaving) leaving.forEach(function (c) { c.el.remove(); });
  }

  /** Counts and knockouts that are about to animate start from where they were, not where they end. */
  function prepareSeats(fresh, s) {
    const now = serverNow();
    fresh.forEach(function (ev) {
      if (now - ev.at > 3500 || !motionOk()) return;
      if (ev.type === 'deal') s.seats.forEach(function (seat) { countHolds[seat.playerId] = { value: 0 }; });
      else if (ev.type === 'out' && seatEls[ev.playerId]) seatEls[ev.playerId].koPending = true;
      else if (ev.type === 'burn' && lastState && ev.toId) {
        const prev = lastState.seats.find(function (x) { return x.playerId === ev.toId; });
        if (prev) countHolds[ev.toId] = { value: prev.count };
      }
      else if (ev.type === 'collect' && lastState) {
        const prev = lastState.seats.find(function (x) { return x.playerId === ev.playerId; });
        if (prev) countHolds[ev.playerId] = { value: prev.count };
      }
    });
  }

  function newEvents(s) {
    const evs = s.events || [];
    const top = evs.length ? evs[evs.length - 1].seq : 0;
    if (lastSeq < 0) { lastSeq = top; return []; }
    const fresh = evs.filter(function (e) { return e.seq > lastSeq; });
    if (fresh.length) lastSeq = fresh[fresh.length - 1].seq;
    return fresh;
  }

  function indexSeats(seats) {
    seatByPlayer = {};
    nameByPlayer = {};
    (seats || []).forEach(function (x) { seatByPlayer[x.playerId] = x.seat; nameByPlayer[x.playerId] = x.name; });
  }

  function renderTable(s) {
    syncClock(s);
    // A rematch this screen didn't start (another host tab), or a fresh deal: clear the old game.
    const fresh = newEvents(s);
    if (fresh.some(function (e) { return e.type === 'deal'; })) resetTableFx();
    indexSeats(s.seats);

    const apply = function () {
      const collecting = fresh.some(function (e) { return e.type === 'collect'; });
      const leaving = collecting && motionOk() ? snapshotPile() : null;
      const play = fresh.filter(function (e) { return e.type === 'play' && (serverNow() - e.at) < 3500; }).pop();
      if (play && motionOk()) heldCard = play.card;
      ensureSeats(s.seats);
      prepareSeats(fresh, s);
      renderSeats(s);
      renderPile(s);
      renderTurn(s);
      renderChallenge(s);
      renderWaiting(s);
      playEvents(fresh, s, leaving);
      lastState = s;
    };
    if (currentView !== 'table' || showTimer) show('table', function () { layoutSeats(); apply(); });
    else apply();
  }

  /** Wipe everything the last game left on the felt. */
  function resetTableFx() {
    fxTimers.forEach(clearTimeout);
    fxTimers = [];
    fxLayer.innerHTML = '';
    countHolds = {};
    heldCard = null;
    landAt = 0;
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    callBanner.hidden = true;
    pileArea.classList.remove('shake', 'won');
    Object.keys(seatEls).forEach(function (pid) {
      const e = seatEls[pid];
      e.koPending = false;
      e.root.classList.remove('out', 'just-out', 'winner');
    });
    lastState = null;
  }

  function resetTableState() {
    resetTableFx();
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
    seatOrderIds = [];
    clearSeatBubbles();
    seatEls = {};
    seatLayer.innerHTML = '';
    fanEls = {};
    pileCards = [];
    pileFan.innerHTML = '';
    pileUnder.innerHTML = '';
    challengeKey = '';
    challengeLine.textContent = '';
    waitingNote.hidden = true;
  }

  // ---------------- Final ----------------
  const STAT_COLS = [
    { key: 'played', label: 'Played', title: 'Cards played onto the pile' },
    { key: 'piles', label: 'Piles won', title: 'Piles taken by a slap or a challenge' },
    { key: 'goodSlaps', label: 'Good slaps', title: 'Slaps that took the pile' },
    { key: 'badSlaps', label: 'Bad slaps', title: 'Wrong slaps — each paid 2 cards to another player' },
    { key: 'peak', label: 'Most cards', title: 'The most cards they ever held' },
  ];

  function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    return m ? m + 'm ' + (s % 60) + 's' : s + 's';
  }

  function renderFinal(s) {
    resetTableFx();
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
    finalHeading.innerHTML = '';
    const champ = (s.standings || []).find(function (r) { return r.playerId === s.winnerId; });
    if (champ) {
      finalHeading.appendChild(nameSpan(champ.name, champ.seat));
      finalHeading.appendChild(document.createTextNode(' wins!'));
    } else {
      finalHeading.textContent = 'Game over';
    }
    finalSub.textContent = 'Took all 52 cards · ' + plural(s.cardsPlayed, 'card') + ' played · ' + formatDuration(s.durationMs);

    const table = document.createElement('table');
    table.className = 'stats-table';
    const head = document.createElement('tr');
    [['', 'st-rank'], ['Player', 'st-player'], ['Result', 'st-chips']].concat(STAT_COLS.map(function (c) { return [c.label, '', c.title]; })).forEach(function (h) {
      const th = document.createElement('th');
      th.textContent = h[0];
      if (h[1]) th.className = h[1];
      if (h[2]) th.title = h[2];
      head.appendChild(th);
    });
    const thead = document.createElement('thead');
    thead.appendChild(head);
    table.appendChild(thead);
    const body = document.createElement('tbody');
    (s.standings || []).forEach(function (r) {
      const tr = document.createElement('tr');
      tr.dataset.seat = r.seat;
      if (r.playerId === s.winnerId) tr.classList.add('is-winner');
      const rank = document.createElement('td');
      rank.className = 'st-rank';
      const p = r.place || 1;
      rank.textContent = p === 1 ? '🥇' : (p === 2 ? '🥈' : (p === 3 ? '🥉' : ordinal(p)));
      const whoTd = document.createElement('td');
      whoTd.className = 'st-player';
      const inner = document.createElement('div');
      inner.className = 'st-player-inner';
      const pip = document.createElement('span');
      pip.className = 'seat-pip'; pip.dataset.seat = r.seat;
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = r.name + (r.isBot && !/^CPU\b/.test(r.name) ? ' (CPU)' : '');
      inner.appendChild(pip); inner.appendChild(name);
      whoTd.appendChild(inner);
      const res = document.createElement('td');
      res.className = 'st-chips';
      res.textContent = r.playerId === s.winnerId ? 'All 52 cards' : 'Out after ' + plural(r.outAfter, 'card');
      tr.appendChild(rank); tr.appendChild(whoTd); tr.appendChild(res);
      STAT_COLS.forEach(function (c) {
        const td = document.createElement('td');
        td.textContent = String(r[c.key] || 0);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    finalList.innerHTML = '';
    finalList.appendChild(table);

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
      if (typeof res.reactionsMuted === 'boolean') { reactionsMuted = res.reactionsMuted; updateMuteBtn(); }
      if (res.lobby) renderLobby(res.lobby);
      lastSeq = res.phase === 'LOBBY' ? 0 : -1;
      if (res.phase === 'LOBBY') {
        if (window.screenChange) window.screenChange(currentView, 'lobby', ['lobby', 'final']);
        forceSingle('lobby');
      }
      if (window.Iris && typeof window.Iris.ready === 'function') window.Iris.ready();
    });
  }

  socket.on('connect', function () { connOverlay.hidden = true; authenticate(); });
  socket.on('disconnect', function () { connOverlay.hidden = false; });

  socket.on('state:lobby', function (l) {
    renderLobby(l);
    if (l.phase === 'LOBBY') { resetTableState(); lastSeq = 0; show('lobby'); }
  });
  socket.on('state:table', renderTable);
  socket.on('state:final', renderFinal);

  socket.on('state:reset', function () {
    resetTableState();
    lastSeq = 0;
    lastHumanTotal = -1;
    show('lobby');
  });

  // ---------------- Boot ----------------
  renderQR();
})();
