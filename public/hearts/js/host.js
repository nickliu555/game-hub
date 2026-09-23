(function () {
  'use strict';

  const socket = io('/hearts', { transports: ['polling', 'websocket'] });

  const SEATS = ['N', 'E', 'S', 'W'];

  // ---------------- Card assets ----------------
  // Pips and aces are SVG (crisp on a TV); the court cards are WebP, because
  // their source art is far too heavy to ship as vectors. Same geometry either
  // way, so the two formats line up pixel for pixel.
  function cardSrc(code) {
    const rank = code.slice(0, code.length - 1);
    const ext = (rank === 'J' || rank === 'Q' || rank === 'K') ? '.webp' : '.svg';
    return '/hearts/assets/cards/' + code + ext;
  }
  function cardImg(code, cls) {
    const img = document.createElement('img');
    img.className = 'card' + (cls ? ' ' + cls : '');
    img.src = cardSrc(code);
    img.alt = cardLabel(code);
    img.draggable = false;
    return img;
  }
  const SUIT_WORD = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };
  function cardLabel(code) {
    return code.slice(0, code.length - 1) + ' of ' + SUIT_WORD[code.slice(-1)];
  }

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    deal: document.getElementById('view-deal'),
    pass: document.getElementById('view-pass'),
    table: document.getElementById('view-table'),
    handend: document.getElementById('view-handend'),
    final: document.getElementById('view-final'),
  };

  const qrSlot = document.getElementById('qrSlot');
  const joinUrlEl = document.getElementById('joinUrl');
  const playerCountEl = document.getElementById('playerCount');
  const playerCapEl = document.getElementById('playerCap');
  const seatList = document.getElementById('seatList');
  const addBotBtn = document.getElementById('addBotBtn');
  const startBtn = document.getElementById('startBtn');
  const targetSeg = document.getElementById('targetSeg');
  const autoSeg = document.getElementById('autoSeg');

  const dealHand = document.getElementById('dealHand');
  const dealFan = document.getElementById('dealFan');
  const dealSub = document.getElementById('dealSub');

  const exVerb = document.getElementById('exVerb');
  const exDirBig = document.getElementById('exDirBig');
  const exArrow = document.getElementById('exArrow');
  const exSub = document.getElementById('exSub');
  const exProgress = document.getElementById('exProgress');
  const exFlights = document.getElementById('exFlights');

  const tTrick = document.getElementById('tTrick');
  const tHearts = document.getElementById('tHearts');
  const tHeartsItem = document.getElementById('tHeartsItem');
  const felt = document.getElementById('felt');
  const playArea = document.querySelector('.play-area');
  const trickBadge = document.getElementById('trickBadge');
  const waitingNote = document.getElementById('waitingNote');
  const shatterLayer = document.getElementById('shatterLayer');
  const sparkleLayer = document.getElementById('sparkleLayer');

  const heHand = document.getElementById('heHand');
  const heTarget = document.getElementById('heTarget');
  const heTitle = document.getElementById('heTitle');
  const moonBanner = document.getElementById('moonBanner');
  const moonText = document.getElementById('moonText');
  const moonSky = document.getElementById('moonSky');
  const scoreRows = document.getElementById('scoreRows');
  const nextHandBtn = document.getElementById('nextHandBtn');
  const autoNote = document.getElementById('autoNote');

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
  function unlockAudio() { const c = getAudioCtx(); if (c && c.state === 'suspended') c.resume(); }
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
  /** White-noise burst — the basis of card riffles, applause and glass. */
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
  /** Cards riffling out of the deck. */
  function playDealRiffle() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < 13; i++) noise(0.05, 0.075, 2600 + Math.random() * 1400, b + i * 0.075);
  }
  function playCardFlip() { noise(0.07, 0.09, 3200); }
  /** Every pass is in and the four packets change hands. */
  function playPassSwoosh() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < 4; i++) noise(0.09, 0.1, 2400 + i * 700, b + i * 0.07, 'bandpass');
    [659, 880, 1047].forEach(function (f, i) { blip(f, 0.2, 'sine', 0.15, b + 0.11 + i * 0.07); });
  }
  /** The packets touching down: three cards now sit in front of everyone. */
  function playCardsLanded() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < 3; i++) noise(0.06, 0.085, 3000 + i * 500, b + i * 0.06, 'bandpass');
    [784, 1046.5].forEach(function (f, i) { blip(f, 0.26, 'triangle', 0.17, b + 0.15 + i * 0.09); });
  }
  /** "Look up!" cue when a new trick or a new turn begins. */
  function playTurnCue() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [659, 880].forEach(function (f, i) { blip(f, 0.16, 'sine', 0.16, b + i * 0.075); });
  }
  function playNewTrick() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [523, 659, 784].forEach(function (f, i) { blip(f, 0.2, 'triangle', 0.15, b + i * 0.07); });
  }
  function playTrickWin() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [784, 1047].forEach(function (f, i) { blip(f, 0.22, 'sine', 0.18, b + i * 0.08); });
  }
  /** The Queen of Spades: a nasty low sting. */
  function playQueenSting() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    sweep(340, 62, 0.85, 'sawtooth', 0.3, b);
    blip(110, 0.7, 'square', 0.16, b);
    noise(0.35, 0.16, 420, b, 'lowpass');
  }
  /** Hearts breaking: a glass smash. */
  function playGlassBreak() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    noise(0.1, 0.3, 5200, b, 'highpass');
    for (let i = 0; i < 9; i++) {
      blip(1400 + Math.random() * 3600, 0.16 + Math.random() * 0.2, 'triangle', 0.1, b + 0.03 + Math.random() * 0.3);
    }
    noise(0.55, 0.11, 6500, b + 0.09, 'highpass');
  }
  /** The J♦ bonus: a golden chime that blooms into a shimmer tail. */
  function playJackDiamond() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    sweep(180, 720, 0.3, 'triangle', 0.13, b);
    [1047, 1319, 1568, 2093].forEach(function (f, i) { blip(f, 0.5, 'sine', 0.18, b + 0.06 + i * 0.07); });
    blip(523, 0.95, 'triangle', 0.1, b + 0.34);
    [2093, 2637, 3136].forEach(function (f, i) { blip(f, 0.8, 'sine', 0.085, b + 0.36 + i * 0.09); });
    noise(0.55, 0.05, 7000, b + 0.3, 'highpass');
  }
  function playHandEnd() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [523, 587, 659].forEach(function (f, i) { blip(f, 0.26, 'triangle', 0.16, b + i * 0.1); });
  }
  function playMoon() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [523, 659, 784, 1047, 1319, 1568, 2093].forEach(function (f, i) {
      blip(f, 0.5, 'sine', 0.17, b + i * 0.085);
    });
  }
  function playApplause() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < 34; i++) noise(0.1, 0.05 + Math.random() * 0.05, 1400 + Math.random() * 2600, b + Math.random() * 1.5);
    [523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.42, 'triangle', 0.16, b + i * 0.11); });
  }

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

  // ---------------- Reactions ----------------
  const REACTION_EMOJIS = ['😂', '🔥', '👀', '🎉', '😱', '😡'];
  const REACTION_MAX = 30;
  const reactionLayer = document.getElementById('reactionLayer');
  function spawnReaction(index) {
    const emoji = REACTION_EMOJIS[index];
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
  socket.on('host:reaction', function (p) { if (p && typeof p.index === 'number') spawnReaction(p.index); });

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
  let lobby = { players: [], total: 0, capacity: 4, canStart: false, targetScore: 100, autoAdvance: true };
  let lastHumanTotal = -1;
  let dragActive = false;    // a row is mid-drag; defer lobby rebuilds
  let pendingLobby = null;   // latest snapshot to apply once the drag settles

  function renderQR() {
    fetch('/api/hearts/config').then(function (r) { return r.json(); }).then(function (cfg) {
      const url = (cfg && cfg.joinUrl) || (window.location.origin + '/hearts/join');
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      return fetch('/api/hearts/qr?url=' + encodeURIComponent(url));
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
    setSeg(targetSeg, l.targetScore);
    setSeg(autoSeg, l.autoAdvance ? 'on' : 'off');

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
      e.textContent = SEATS[i] + ' · open seat';
      seatList.appendChild(e);
    }

    startBtn.disabled = !l.canStart;
    addBotBtn.disabled = l.total >= l.capacity;
  }

  // ---- Pointer-drag to reseat (order = N / E / S / W) ----
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
      // containing block for position:fixed — so the row has to leave it or it
      // flies to the wrong coordinates and lands off-screen.
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

      // A rebuild could have wiped the list out from under the drag; the row is
      // parked on <body>, so bail back to the server's ordering rather than
      // leaving it floating.
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
      e.preventDefault();   // no text selection / native drag while reseating
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
  wireSeg(targetSeg, 'host:setTargetScore', function (v) { return { targetScore: Number(v) }; });
  wireSeg(autoSeg, 'host:setAutoAdvance', function (v) { return { on: v === 'on' }; });

  startBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
      if (res && !res.ok) toast('Could not start — the table needs exactly 4 players.');
      else playStartFanfare();
    });
  });

  nextHandBtn.addEventListener('click', function () {
    nextHandBtn.disabled = true;
    socket.emit('host:nextHand', {}, function (res) {
      if (res && !res.ok) nextHandBtn.disabled = false;
    });
  });

  playAgainBtn.addEventListener('click', function () {
    showInlineConfirm('Back to the lobby? Everyone will need to rejoin.', function () {
      socket.emit('host:reset', {});
    }, { okLabel: 'Back to lobby' });
  });

  // ---------------- Shared per-hand header ----------------
  /** Look up a seat letter from a player id, using the latest snapshot. */
  let seatByPlayer = {};
  function indexSeats(seats) {
    seatByPlayer = {};
    (seats || []).forEach(function (s) { seatByPlayer[s.playerId] = s.seat; });
  }

  // ---------------- Deal ----------------
  let dealKey = '';
  function renderDeal(s) {
    indexSeats(s.seats);
    dealHand.textContent = s.handNumber;
    dealSub.textContent = s.passDirection === 'hold'
      ? 'No passing this hand — play starts right away'
      : 'Check your phone for your hand';
    // Idempotent: a presence re-broadcast must not restart the riffle.
    const key = 'h' + s.handNumber;
    if (key !== dealKey) {
      dealKey = key;
      buildDealFan();
      playDealRiffle();
    }
    show('deal');
  }
  function buildDealFan() {
    dealFan.innerHTML = '';
    const targets = [[0, -70, -4], [180, 10, 12], [0, 80, 4], [-180, 10, -12]];
    for (let i = 0; i < 12; i++) {
      const c = document.createElement('div');
      c.className = 'card card-back';
      const t = targets[i % 4];
      c.style.setProperty('--dx', t[0] + 'px');
      c.style.setProperty('--dy', t[1] + 'px');
      c.style.setProperty('--rot', t[2] + 'deg');
      c.style.animationDelay = (i * 0.09) + 's';
      dealFan.appendChild(c);
    }
  }

  // ---------------- Pass / exchange ----------------
  // One screen covers both phases: the seat map is held from "choose 3 cards"
  // straight through the hand-off animation, so nothing cuts away mid-pass.
  // Seat index i passes to (i + offset) % 4 over SEATS, matching the server.
  const PASS_STEP = { left: 1, right: 3, across: 2, hold: 0 };
  // The flight animation's travel time — the cards are dropped in front of the
  // receivers as the packets touch down.
  const DELIVER_MS = 860;
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let passKey = '';
  let exchangeKey = '';
  let exchangeStep = 0;
  let passedSeen = -1;
  let flightMode = '';
  let landTimer = null;

  function bump(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function clearHands() {
    SEATS.forEach(function (l) {
      const el = document.getElementById('ex-seat-' + l);
      el.classList.remove('landed');
      el.querySelector('.ex-hand').innerHTML = '';
    });
  }

  function dropHands() {
    SEATS.forEach(function (l) {
      const el = document.getElementById('ex-seat-' + l);
      const slot = el.querySelector('.ex-hand');
      slot.innerHTML = '';
      for (let k = 0; k < 3; k++) {
        const c = document.createElement('span');
        c.className = 'ex-card';
        c.style.setProperty('--er', ((k - 1) * 7) + 'deg');
        slot.appendChild(c);
      }
      el.classList.add('landed');
    });
  }

  function renderMap(s, status) {
    indexSeats(s.seats);
    exDirBig.textContent = s.passLabel;
    // Across runs its cards straight through the middle, so the glyph gets out
    // of the way rather than being flown over.
    exArrow.hidden = s.passDirection === 'across';
    exArrow.textContent = s.passArrow;
    exchangeStep = PASS_STEP[s.passDirection] || 0;
    const bySeat = {};
    (s.seats || []).forEach(function (p) { bySeat[p.seat] = p; });
    SEATS.forEach(function (letter) {
      const el = document.getElementById('ex-seat-' + letter);
      const p = bySeat[letter];
      el.querySelector('.pname').textContent = p ? p.name : '';
      const ready = status === 'done' || !!(p && p.hasPassed);
      el.querySelector('.ex-status').textContent = ready ? '✓ Passed' : 'Choosing…';
      el.classList.toggle('ready', ready);
    });
  }

  function renderPass(s) {
    renderMap(s, 'wait');
    exVerb.textContent = 'Pass';
    exSub.textContent = 'Choose 3 cards to pass on your phone';
    const key = 'h' + s.handNumber;
    if (key !== passKey) {
      passKey = key;
      exchangeKey = '';
      passedSeen = -1;
      if (landTimer) { clearTimeout(landTimer); landTimer = null; }
      flightMode = 'preview';
      exFlights.innerHTML = '';
      exFlights.classList.remove('is-delivering');
      clearHands();
      playTurnCue();
    }
    const total = s.total || 4;
    const done = s.passed || 0;
    exProgress.textContent = done + ' of ' + total + ' passed';
    exProgress.classList.toggle('all-in', done >= total);
    // Re-renders are idempotent, so the ding only fires on a genuine increase.
    if (passedSeen >= 0 && done > passedSeen) playJoinDing();
    passedSeen = done;
    // The cards fly for the whole phase, not just the hand-off, so the table
    // can see where its pass is headed while everyone is still choosing.
    show('pass', ensureFlights);
  }

  function renderExchange(s) {
    renderMap(s, 'done');
    exVerb.textContent = 'Passed';
    exSub.textContent = 'Check your new hand';
    exProgress.textContent = 'All cards in!';
    exProgress.classList.add('all-in');
    const key = 'h' + s.handNumber;
    const fresh = key !== exchangeKey;
    if (fresh) { exchangeKey = key; passedSeen = -1; }
    show('pass', function () {
      if (fresh) deliver(); else ensureFlights();
    });
  }

  // The hand-off, as one event: the looping preview is replaced by a single
  // synchronised run that lands on the receivers and leaves three cards behind.
  function deliver() {
    if (landTimer) { clearTimeout(landTimer); landTimer = null; }
    clearHands();
    playPassSwoosh();
    bump(exVerb, 'swap');
    if (!exArrow.hidden) bump(exArrow, 'spin');
    const land = function () {
      landTimer = null;
      flightMode = 'landed';
      dropHands();
      playCardsLanded();
    };
    if (reduceMotion && reduceMotion.matches) {
      exFlights.innerHTML = '';
      exFlights.classList.remove('is-delivering');
      land();
      return;
    }
    flightMode = 'deliver';
    buildExchangeFlights(true);
    landTimer = setTimeout(land, DELIVER_MS);
  }

  // The flights are measured from the laid-out map, so they can only be built
  // once the view has actually been swapped in.
  function ensureFlights() {
    if (flightMode !== 'preview') return;
    if (!exFlights.childElementCount) buildExchangeFlights(false);
  }

  function buildExchangeFlights(deliverRun) {
    exFlights.innerHTML = '';
    exFlights.classList.toggle('is-delivering', !!deliverRun);
    if (!exchangeStep) return;
    const seatEl = {};
    SEATS.forEach(function (l) { seatEl[l] = document.getElementById('ex-seat-' + l); });
    // Fit the ring to the hole between the four labels, so a packet can never
    // fly over a name. offsetLeft/Top are used because client rects are skewed
    // by the view's entry transform.
    const left = seatEl.W.offsetLeft + seatEl.W.offsetWidth;
    const right = seatEl.E.offsetLeft;
    // N is the one seat whose card slot faces the middle, and it sits empty
    // until the hand-off — measuring past it would hang the ring a slot's
    // height below the label while everyone is still choosing.
    const top = seatEl.N.querySelector('.ex-hand').offsetTop;
    const bottom = seatEl.S.offsetTop;
    // Inset by the packet's own half-size (rotated) so the card box, not just
    // its centre, stays inside the hole.
    const rx = (right - left) / 2 - 28;
    const ry = (bottom - top) / 2 - 34;
    if (rx <= 0 || ry <= 0) return;
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    // N is at -90°, then E / S / W clockwise; passing advances by 90° a step.
    const at = function (deg) {
      const r = deg * Math.PI / 180;
      return { x: cx + rx * Math.cos(r), y: cy + ry * Math.sin(r) };
    };
    SEATS.forEach(function (_seat, i) {
      const a0 = -90 + i * 90;
      // Take the short way round: passing right is a quarter turn back, not
      // three quarters forward.
      const turn = exchangeStep === 3 ? -90 : exchangeStep * 90;
      let from = at(a0);
      let to = at(a0 + turn);
      if (exchangeStep === 2) {
        // Across would otherwise run both directions down the same line, so each
        // pair is shifted sideways into its own lane.
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        const ox = (dy / len) * (Math.abs(dx) > Math.abs(dy) ? ry * 0.52 : rx * 0.46);
        const oy = (-dx / len) * (Math.abs(dx) > Math.abs(dy) ? ry * 0.52 : rx * 0.46);
        from = { x: from.x + ox, y: from.y + oy };
        to = { x: to.x + ox, y: to.y + oy };
      }
      if (deliverRun) {
        // The real hand-off ends on the receiver's card slot, so the packet
        // becomes the three cards it drops there.
        const slot = seatEl[SEATS[(i + exchangeStep) % 4]].querySelector('.ex-hand');
        to = { x: slot.offsetLeft + slot.offsetWidth / 2, y: slot.offsetTop + slot.offsetHeight / 2 };
      }
      for (let k = 0; k < 3; k++) {
        const c = document.createElement('span');
        c.className = 'ex-flight';
        // The hand-off flies its three cards as one fanned packet, so the count
        // is readable in the air as well as on the table.
        const spread = deliverRun ? (k - 1) * 8 : 0;
        c.style.left = Math.round(from.x + spread) + 'px';
        c.style.top = Math.round(from.y) + 'px';
        c.style.setProperty('--fx', Math.round(to.x - from.x) + 'px');
        c.style.setProperty('--fy', Math.round(to.y - from.y) + 'px');
        c.style.setProperty('--frot', ((k - 1) * 10) + 'deg');
        // All four seats fly in unison — offsetting them made the loop read as a
        // stagger rather than one table-wide pass.
        c.style.animationDelay = deliverRun ? '0s' : (k * 0.12).toFixed(2) + 's';
        exFlights.appendChild(c);
      }
    });
  }

  window.addEventListener('resize', function () {
    // Rebuilding mid-delivery would restart the flight, and the landed cards
    // need no re-measuring, so only the idle preview is re-fitted.
    if (currentView === 'pass' && flightMode === 'preview' && exFlights.childElementCount) {
      buildExchangeFlights(false);
    }
  });

  // ---------------- The table ----------------
  let lastTurnId = null;
  let lastTrickNumber = 0;
  // Set-piece bookkeeping. Keyed by hand/trick so a host that connects or
  // re-renders mid-hand adopts the current state instead of replaying the
  // shatter and the sting.
  let heartsWereBroken = false;
  let fxHandKey = null;
  let fxTrickKey = null;
  let seenQueen = false;
  let seenJack = false;
  let collectTimer = null;
  let collectKey = null;

  let nameProbe = null;
  // The seat box is width-capped, so a name too long for it shrinks its own
  // text down to a readable floor rather than wrapping and stealing height.
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
    name.style.fontSize = Math.max(15, Math.floor(natural * avail / full)) + 'px';
  }

  function fitSeatNames() {
    SEATS.forEach(function (letter) {
      const el = document.getElementById('seat-' + letter);
      const name = el && el.querySelector('.seat-label .pname');
      if (name) fitSeatName(name);
    });
  }
  window.addEventListener('resize', fitSeatNames);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitSeatNames);

  function renderSeats(seats, opts) {
    const o = opts || {};
    SEATS.forEach(function (letter) {
      const el = document.getElementById('seat-' + letter);
      const s = (seats || []).find(function (x) { return x.seat === letter; });
      el.innerHTML = '';
      el.dataset.seat = letter;
      el.classList.remove('turn', 'winner', 'offline');
      if (!s) { el.dataset.pid = ''; return; }
      el.dataset.pid = s.playerId;

      const label = document.createElement('div');
      label.className = 'seat-label';
      const pip = document.createElement('span');
      pip.className = 'seat-pip'; pip.dataset.seat = letter; pip.textContent = letter;
      const name = document.createElement('span');
      name.className = 'pname'; name.textContent = s.name;
      label.appendChild(pip); label.appendChild(name);
      el.appendChild(label);

      const pts = document.createElement('div');
      pts.className = 'seat-points' + (s.handPoints > 0 ? ' scoring' : (s.handPoints < 0 ? ' bonus' : ''));
      pts.textContent = s.handPoints === 0
        ? 'no points yet'
        : (s.handPoints > 0 ? '+' + s.handPoints : String(s.handPoints)) + ' this hand';
      el.appendChild(pts);

      // A CPU is always "present"; only a real phone can be away. Dimming the
      // seat says it on its own, and the glow says whose turn it is, so neither
      // needs a label stealing height from the played cards.
      if (!s.isBot && s.connected === false) el.classList.add('offline');

      if (o.turnPlayerId && s.playerId === o.turnPlayerId) el.classList.add('turn');
      if (o.winnerId && s.playerId === o.winnerId) el.classList.add('winner');
    });
    fitSeatNames();
    // The felt may still be hidden on the first render, where nothing has a
    // width yet to measure against.
    requestAnimationFrame(fitSeatNames);
  }

  function renderTrickCards(trick, opts) {
    const o = opts || {};
    const filled = {};
    (trick || []).forEach(function (t, i) {
      const seat = seatByPlayer[t.playerId];
      if (!seat) return;
      filled[seat] = true;
      const slot = document.getElementById('played-' + seat);
      const extra = ((i === 0 ? 'lead ' : '') + (o.takerId && t.playerId === o.takerId ? 'taker' : '')).trim();
      const existing = slot.firstElementChild;
      // Reuse a card that is already on the felt. Rebuilding the slot restarts
      // the drop animation, so every card re-bounced whenever anyone played.
      if (!existing || existing.dataset.card !== t.card) {
        slot.innerHTML = '';
        const card = cardImg(t.card, extra);
        card.dataset.card = t.card;
        slot.appendChild(card);
      } else if (!existing.classList.contains('collect')) {
        existing.className = ('card ' + extra).trim();
        existing.style.removeProperty('animation-delay');
      }
    });
    SEATS.forEach(function (letter) {
      if (!filled[letter]) document.getElementById('played-' + letter).innerHTML = '';
    });
    playArea.classList.toggle('resolved', !!o.takerId);
  }

  /** Sweep the finished trick into the winner's seat so the pile has an owner. */
  function collectTrick(seat) {
    const target = document.getElementById('seat-' + seat);
    if (!target) return;
    const t = target.getBoundingClientRect();
    const tx = t.left + t.width / 2;
    const ty = t.top + t.height / 2;
    playArea.querySelectorAll('.played .card').forEach(function (card, i) {
      const c = card.getBoundingClientRect();
      card.style.setProperty('--cx', Math.round(tx - (c.left + c.width / 2)) + 'px');
      card.style.setProperty('--cy', Math.round(ty - (c.top + c.height / 2)) + 'px');
      card.style.setProperty('--crot', ((i % 2 ? 1 : -1) * (10 + i * 5)) + 'deg');
      card.style.animationDelay = (i * 50) + 'ms';
      card.classList.add('collect');
    });
  }

  function renderHeader(s) {
    tTrick.textContent = s.trickNumber;
    tHearts.textContent = s.heartsBroken ? 'Broken' : 'Not broken';
    tHeartsItem.classList.toggle('broken', !!s.heartsBroken);
  }

  function renderTable(s) {
    indexSeats(s.seats);
    renderHeader(s);
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
    renderSeats(s.seats, { turnPlayerId: s.turnPlayerId });
    renderTrickCards(s.trick, {});
    trickBadge.hidden = true;

    // A dropped phone never forfeits its turn — the table just waits.
    if (s.waitingOn) {
      waitingNote.textContent = 'Waiting for ' + s.waitingOn + ' to come back…';
      waitingNote.hidden = false;
    } else {
      waitingNote.hidden = true;
    }

    if (s.trickNumber !== lastTrickNumber) {
      lastTrickNumber = s.trickNumber;
      lastTurnId = null;
      if (currentView === 'table') playNewTrick();
    }
    // A fresh turn is the "look up" moment.
    if (s.turnPlayerId && s.turnPlayerId !== lastTurnId) {
      lastTurnId = s.turnPlayerId;
      if (currentView === 'table' && s.trick.length) playTurnCue();
    }

    checkCardFx(s);
    show('table');
  }

  /**
   * Fire the set-pieces the first time each landmark card hits the felt.
   * On a brand-new hand we adopt `heartsBroken` silently, so a host joining a
   * game already in progress doesn't get a shatter it has no context for.
   */
  function checkCardFx(s) {
    const handKey = 'h' + s.handNumber;
    if (handKey !== fxHandKey) {
      fxHandKey = handKey;
      heartsWereBroken = !!s.heartsBroken;
      fxTrickKey = null;
    }
    // Q♠ and J♦ each appear once per hand, so a per-trick reset is safe and
    // keeps the dedupe keyed to the cards currently on the table.
    const trickKey = handKey + 't' + s.trickNumber;
    if (trickKey !== fxTrickKey) { fxTrickKey = trickKey; seenQueen = false; seenJack = false; }

    const cards = (s.trick || []).map(function (t) { return t.card; });

    if (!seenQueen && cards.indexOf('QS') >= 0) {
      seenQueen = true;
      playQueenSting();
      felt.classList.remove('queen-hit');
      void felt.offsetWidth;                 // restart the animation
      felt.classList.add('queen-hit');
      setTimeout(function () { felt.classList.remove('queen-hit'); }, 950);
    }
    if (!seenJack && cards.indexOf('JD') >= 0) {
      seenJack = true;
      playJackDiamond();
      felt.classList.remove('jack-hit');
      void felt.offsetWidth;                 // restart the animation
      felt.classList.add('jack-hit');
      setTimeout(function () { felt.classList.remove('jack-hit'); }, 1300);
      sparkle();
    }
    if (s.heartsBroken && !heartsWereBroken) {
      heartsWereBroken = true;
      playGlassBreak();
      shatter();
    }
  }

  function shatter() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    shatterLayer.innerHTML = '';
    for (let i = 0; i < 26; i++) {
      const s = document.createElement('div');
      s.className = 'shard';
      const size = 8 + Math.random() * 20;
      s.style.borderWidth = '0 ' + (size * 0.45) + 'px ' + size + 'px ' + (size * 0.45) + 'px';
      const angle = Math.random() * Math.PI * 2;
      const dist = 140 + Math.random() * 380;
      s.style.setProperty('--sx', Math.cos(angle) * dist + 'px');
      s.style.setProperty('--sy', Math.sin(angle) * dist * 0.7 + 'px');
      s.style.setProperty('--srot', (Math.random() * 900 - 450) + 'deg');
      s.style.animationDelay = (Math.random() * 0.1) + 's';
      shatterLayer.appendChild(s);
    }
    setTimeout(function () { shatterLayer.innerHTML = ''; }, 1300);
  }

  function sparkle() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    sparkleLayer.innerHTML = '';
    for (let i = 0; i < 22; i++) {
      const s = document.createElement('div');
      s.className = 'spark';
      s.style.setProperty('--ss', (9 + Math.random() * 16).toFixed(1) + 'px');
      const angle = Math.random() * Math.PI * 2;
      const dist = 110 + Math.random() * 230;
      s.style.setProperty('--sx', Math.round(Math.cos(angle) * dist) + 'px');
      // Biased upward, so the bonus lifts away instead of scattering flat.
      s.style.setProperty('--sy', Math.round(Math.sin(angle) * dist * 0.5 - 70) + 'px');
      s.style.setProperty('--srot', Math.round(Math.random() * 360 - 180) + 'deg');
      s.style.animationDelay = (Math.random() * 0.22).toFixed(2) + 's';
      sparkleLayer.appendChild(s);
    }
    setTimeout(function () { sparkleLayer.innerHTML = ''; }, 1700);
  }

  function renderTrickEnd(s) {
    indexSeats(s.seats);
    renderHeader(s);
    const r = s.result || {};
    renderSeats(s.seats, { winnerId: r.winnerId });
    renderTrickCards(s.trick, { takerId: r.winnerId });
    waitingNote.hidden = true;

    trickBadge.innerHTML = '';
    const nameEl = document.createElement('div');
    nameEl.className = 'tb-name';
    const who = document.createElement('span');
    who.className = 'pname';
    who.dataset.seat = seatByPlayer[r.winnerId] || '';
    who.textContent = r.winnerName || '';
    nameEl.appendChild(who);
    nameEl.appendChild(document.createTextNode(' takes it'));
    const ptsEl = document.createElement('div');
    const pts = r.points || 0;
    ptsEl.className = 'tb-pts' + (pts > 0 ? ' scoring' : (pts < 0 ? ' bonus' : ''));
    ptsEl.textContent = pts === 0
      ? 'no points'
      : (pts > 0 ? '+' + pts : String(pts)) + (Math.abs(pts) === 1 ? ' point' : ' points');
    trickBadge.appendChild(nameEl); trickBadge.appendChild(ptsEl);
    trickBadge.hidden = false;

    // Let the winning card sit lit for a beat, then sweep the pile to its
    // owner. Keyed so a re-render mid-pause doesn't restart the sweep.
    const key = s.handNumber + ':' + s.trickNumber;
    if (key !== collectKey) {
      collectKey = key;
      if (collectTimer) clearTimeout(collectTimer);
      collectTimer = setTimeout(function () {
        collectTimer = null;
        collectTrick(seatByPlayer[r.winnerId]);
      }, 1400);
    }

    checkCardFx(s);
    if (currentView === 'table') playTrickWin();
    show('table');
  }

  // ---------------- Hand end ----------------
  let autoTimer = null;
  let moonKey = '';
  function renderHandEnd(s) {
    indexSeats(s.seats);
    heHand.textContent = s.handNumber;
    heTarget.textContent = s.targetScore;
    heTitle.textContent = s.gameOver ? 'Final hand!' : 'Scores';

    if (s.moonShooterName) {
      moonText.textContent = s.moonShooterName + ' shot the moon!';
      moonBanner.hidden = false;
    } else {
      moonBanner.hidden = true;
      moonBanner.classList.remove('shot');
      // A hand with no moon must not inherit the last one's sky.
      if (moonRainTimer) { clearTimeout(moonRainTimer); moonRainTimer = null; }
      moonSky.innerHTML = '';
    }
    const freshMoon = !!s.moonShooterName && moonKey !== 'h' + s.handNumber;
    moonKey = s.moonShooterName ? 'h' + s.handNumber : '';

    scoreRows.innerHTML = '';
    (s.rows || []).slice().sort(function (a, b) { return a.total - b.total; }).forEach(function (r) {
      const row = document.createElement('div');
      row.className = 'score-row' + (r.shotMoon ? ' moon' : '');
      row.dataset.seat = r.seat;

      const pip = document.createElement('span');
      pip.className = 'seat-pip'; pip.dataset.seat = r.seat; pip.textContent = r.seat;

      const name = document.createElement('span');
      name.className = 'sr-name pname'; name.textContent = r.name;

      const who = document.createElement('span');
      who.className = 'sr-who';
      who.appendChild(pip); who.appendChild(name);

      const delta = document.createElement('span');
      delta.className = 'sr-delta ' + (r.delta > 0 ? 'plus' : (r.delta < 0 ? 'minus' : 'zero'));
      delta.textContent = r.delta > 0 ? '+' + r.delta : String(r.delta);

      const total = document.createElement('span');
      total.className = 'sr-total';
      total.textContent = r.total;

      row.appendChild(who);
      // "7 ♥" reads as a card beside the Q♠ / J♦ cells; the × makes it a count.
      row.appendChild(cell(r.hearts ? r.hearts + ' × ♥' : '—', 'hearts', !!r.hearts));
      row.appendChild(cell(r.queen ? 'Q♠' : '—', 'queen', !!r.queen));
      row.appendChild(cell(r.jack ? 'J♦' : '—', 'jack', !!r.jack));
      row.appendChild(delta);
      row.appendChild(total);
      scoreRows.appendChild(row);
    });

    nextHandBtn.disabled = false;
    nextHandBtn.textContent = s.gameOver ? 'See the results' : 'Next hand';

    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (s.autoAdvance && s.endsAt) {
      autoNote.hidden = false;
      const tick = function () {
        const left = Math.max(0, Math.ceil((s.endsAt - (Date.now() + clockOffset)) / 1000));
        autoNote.textContent = 'Next hand in ' + left + 's…';
        if (left <= 0 && autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      };
      tick();
      autoTimer = setInterval(tick, 250);
    } else {
      autoNote.hidden = true;
    }

    if (currentView !== 'handend') {
      if (s.moonShooterName) playMoon(); else playHandEnd();
    }
    lastTrickNumber = 0; lastTurnId = null;
    // Measured after the view is on screen, or the banner has no box to burst from.
    show('handend', function () { if (freshMoon) moonBurst(); });
  }

  const MOON_GLYPHS = ['🌙', '⭐', '🌟', '✨', '🌛', '💫'];
  const MOON_DROPS = 46;
  const MOON_SPAWN_S = 3.2;   // how long new drops keep appearing
  const MOON_FALL_MS = 8400;  // spawn window + the slowest fall, then wipe
  let moonRainTimer = null;

  function moonBurst() {
    bump(moonBanner, 'shot');
    const row = scoreRows.querySelector('.score-row.moon');
    if (row) bump(row, 'shot');
    if (moonRainTimer) { clearTimeout(moonRainTimer); moonRainTimer = null; }
    moonSky.innerHTML = '';
    if (reduceMotion && reduceMotion.matches) return;
    const vb = views.handend.getBoundingClientRect();
    const bb = moonBanner.getBoundingClientRect();
    const ox = bb.left - vb.left + bb.width / 2;
    const oy = bb.top - vb.top + bb.height / 2;
    for (let i = 0; i < 24; i++) {
      const st = document.createElement('span');
      st.className = 'moon-star';
      st.style.setProperty('--ms', (8 + Math.random() * 15).toFixed(1) + 'px');
      st.style.left = Math.round(ox) + 'px';
      st.style.top = Math.round(oy) + 'px';
      const a = Math.random() * Math.PI * 2;
      const d = 90 + Math.random() * 300;
      st.style.setProperty('--mx', Math.round(Math.cos(a) * d) + 'px');
      // Biased upward, so the stars climb away from the scoreboard below.
      st.style.setProperty('--my', Math.round(Math.sin(a) * d * 0.55 - 60) + 'px');
      st.style.setProperty('--mr', Math.round(Math.random() * 360 - 180) + 'deg');
      st.style.animationDelay = (Math.random() * 0.32).toFixed(2) + 's';
      moonSky.appendChild(st);
    }
    moonRain();
    moonRainTimer = setTimeout(function () {
      moonRainTimer = null;
      moonSky.innerHTML = '';
    }, MOON_FALL_MS);
  }

  /** Moons and stars falling the full height of the scoreboard view. */
  function moonRain() {
    // Measured, not assumed: the view stretches, so this is the real drop.
    const fall = moonSky.clientHeight + 140;
    for (let i = 0; i < MOON_DROPS; i++) {
      const d = document.createElement('span');
      d.className = 'moon-drop';
      d.textContent = MOON_GLYPHS[Math.floor(Math.random() * MOON_GLYPHS.length)];
      d.style.left = (Math.random() * 100).toFixed(2) + '%';
      d.style.setProperty('--md', (14 + Math.random() * 26).toFixed(1) + 'px');
      d.style.setProperty('--mf', fall + 'px');
      d.style.setProperty('--mx', Math.round(Math.random() * 140 - 70) + 'px');
      d.style.setProperty('--mr', Math.round(Math.random() * 520 - 260) + 'deg');
      d.style.animationDuration = (2.6 + Math.random() * 2.4).toFixed(2) + 's';
      d.style.animationDelay = (Math.random() * MOON_SPAWN_S).toFixed(2) + 's';
      moonSky.appendChild(d);
    }
  }
  function cell(text, cls, has) {
    const el = document.createElement('span');
    el.className = 'sr-cell ' + cls + (has ? ' has' : '');
    el.textContent = text;
    return el;
  }

  // ---------------- Final ----------------
  function renderFinal(s) {
    const winners = s.winnerNames || [];
    finalTrophy.textContent = '🏆';
    if (winners.length === 1) finalHeading.textContent = winners[0] + ' wins!';
    else if (winners.length > 1) finalHeading.textContent = winners.join(' & ') + ' tie for the win!';
    else finalHeading.textContent = 'Game over';
    finalSub.textContent = 'Lowest score after ' + s.handsPlayed +
      (s.handsPlayed === 1 ? ' hand' : ' hands') + ' · played to ' + s.targetScore;

    finalList.innerHTML = '';
    (s.standings || []).forEach(function (r) {
      const row = document.createElement('div');
      row.className = 'final-row' + (s.winnerIds.indexOf(r.playerId) >= 0 ? ' is-winner' : '');
      row.dataset.seat = r.seat;

      const rank = document.createElement('span');
      rank.className = 'fr-rank';
      rank.textContent = r.rank === 1 ? '🥇' : (r.rank === 2 ? '🥈' : (r.rank === 3 ? '🥉' : '#' + r.rank));

      const pip = document.createElement('span');
      pip.className = 'seat-pip'; pip.dataset.seat = r.seat; pip.textContent = r.seat;

      const name = document.createElement('span');
      name.className = 'fr-name pname';
      name.textContent = r.name + (r.isBot ? ' (CPU)' : '');

      const total = document.createElement('span');
      total.className = 'fr-total';
      total.textContent = r.total;

      row.appendChild(rank); row.appendChild(pip); row.appendChild(name); row.appendChild(total);
      finalList.appendChild(row);
    });

    if (currentView !== 'final') {
      playApplause();
      confetti();
    }
    show('final');
  }

  // ---------------- Clock sync ----------------
  let clockOffset = 0;
  function syncClock(payload) {
    if (payload && typeof payload.serverNow === 'number') clockOffset = payload.serverNow - Date.now();
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

  socket.on('state:lobby', function (l) { renderLobby(l); if (l.phase === 'LOBBY') show('lobby'); });
  socket.on('state:deal', function (s) { syncClock(s); renderDeal(s); });
  socket.on('state:pass', function (s) { syncClock(s); renderPass(s); });
  socket.on('state:exchange', function (s) { syncClock(s); renderExchange(s); });
  socket.on('state:table', function (s) { syncClock(s); renderTable(s); });
  socket.on('state:trickEnd', function (s) { syncClock(s); renderTrickEnd(s); });
  socket.on('state:handEnd', function (s) { syncClock(s); renderHandEnd(s); });
  socket.on('state:final', function (s) { renderFinal(s); });

  socket.on('state:reset', function () {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    dealKey = ''; passKey = ''; exchangeKey = ''; moonKey = '';
    moonSky.innerHTML = '';
    moonBanner.classList.remove('shot');
    flightMode = '';
    if (landTimer) { clearTimeout(landTimer); landTimer = null; }
    exFlights.innerHTML = '';
    exFlights.classList.remove('is-delivering');
    clearHands();
    lastTurnId = null; lastTrickNumber = 0;
    fxHandKey = null; fxTrickKey = null;
    collectKey = null;
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
    seenQueen = false; seenJack = false; heartsWereBroken = false;
    lastHumanTotal = -1;
    show('lobby');
  });

  // ---------------- Boot ----------------
  renderQR();
})();
