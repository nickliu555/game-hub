(function () {
  'use strict';

  const socket = io('/spades', { transports: ['polling', 'websocket'] });

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

  const TEAM_LABEL = { red: 'Red', blue: 'Blue' };
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    deal: document.getElementById('view-deal'),
    table: document.getElementById('view-table'),
    handend: document.getElementById('view-handend'),
    final: document.getElementById('view-final'),
  };

  const qrSlot = document.getElementById('qrSlot');
  const joinUrlEl = document.getElementById('joinUrl');
  const playerCountEl = document.getElementById('playerCount');
  const playerCapEl = document.getElementById('playerCap');
  const slotsRed = document.getElementById('slotsRed');
  const slotsBlue = document.getElementById('slotsBlue');
  const colRed = document.getElementById('colRed');
  const colBlue = document.getElementById('colBlue');
  const startBtn = document.getElementById('startBtn');
  const addBotBtn = document.getElementById('addBotBtn');
  const targetSeg = document.getElementById('targetSeg');
  const autoSeg = document.getElementById('autoSeg');

  const dealHand = document.getElementById('dealHand');
  const dealFan = document.getElementById('dealFan');
  const dealSub = document.getElementById('dealSub');

  const tRed = document.getElementById('tRed');
  const tBlue = document.getElementById('tBlue');
  const tPhaseLabel = document.getElementById('tPhaseLabel');
  const tPhaseValue = document.getElementById('tPhaseValue');
  const tSpades = document.getElementById('tSpades');
  const tSpadesItem = document.getElementById('tSpadesItem');
  const playArea = document.querySelector('.play-area');
  const trickBadge = document.getElementById('trickBadge');
  const waitingNote = document.getElementById('waitingNote');
  const shatterLayer = document.getElementById('shatterLayer');

  const heHand = document.getElementById('heHand');
  const heTarget = document.getElementById('heTarget');
  const heTitle = document.getElementById('heTitle');
  const scoreRows = document.getElementById('scoreRows');
  const nextHandBtn = document.getElementById('nextHandBtn');
  const autoNote = document.getElementById('autoNote');

  const finalTrophy = document.getElementById('finalTrophy');
  const finalHeading = document.getElementById('finalHeading');
  const finalSub = document.getElementById('finalSub');
  const finalList = document.getElementById('finalList');
  const playAgainBtn = document.getElementById('playAgainBtn');

  const standingsDock = document.getElementById('standingsDock');
  const standingsBtn = document.getElementById('standingsBtn');
  const standingsPop = document.getElementById('standingsPop');
  const standingsRows = document.getElementById('standingsRows');
  const standingsFoot = document.getElementById('standingsFoot');
  const standingsClose = document.getElementById('standingsClose');

  const lastTrickDock = document.getElementById('lastTrickDock');
  const lastTrickBtn = document.getElementById('lastTrickBtn');
  const lastTrickPop = document.getElementById('lastTrickPop');
  const lastTrickNote = document.getElementById('lastTrickNote');
  const lastTrickCards = document.getElementById('lastTrickCards');
  const lastTrickClose = document.getElementById('lastTrickClose');

  const connOverlay = document.getElementById('connOverlay');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const resetBtn = document.getElementById('resetBtn');

  // ---------------- View stack ----------------
  let currentView = 'lobby';
  let showTimer = null;
  function forceSingle(name) {
    if (name !== 'table') clearSeatBubbles();
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle('active', k === name);
      views[k].classList.remove('fading-out');
    });
    currentView = name;
    // The seats had no size to measure while the table was hidden; fit them now it's up.
    if (name === 'table') { fitSeatNames(); placeBubbles(); }
  }
  function show(name, done) {
    if (currentView === name) { if (done) done(); return; }
    if (name !== 'table') clearSeatBubbles();
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
  /** A bid lands on the table. */
  function playBidPlaced() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    noise(0.05, 0.08, 3000, b);
    [587, 784].forEach(function (f, i) { blip(f, 0.18, 'triangle', 0.15, b + 0.03 + i * 0.07); });
  }
  /** Somebody bids Nil — a bright shimmer; Blind Nil gets a dramatic run up. */
  function playNilBid(blind) {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    if (blind) sweep(140, 620, 0.45, 'sawtooth', 0.12, b);
    const off = blind ? 0.32 : 0;
    [1047, 1319, 1568, 2093].forEach(function (f, i) { blip(f, 0.45, 'sine', 0.16, b + off + i * 0.07); });
    noise(0.45, 0.05, 7000, b + off + 0.2, 'highpass');
  }
  /** Spades breaking: the same glass smash Hearts plays when hearts break. */
  function playGlassBreak() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    noise(0.1, 0.3, 5200, b, 'highpass');
    for (let i = 0; i < 9; i++) {
      blip(1400 + Math.random() * 3600, 0.16 + Math.random() * 0.2, 'triangle', 0.1, b + 0.03 + Math.random() * 0.3);
    }
    noise(0.55, 0.11, 6500, b + 0.09, 'highpass');
  }
  /** A nil bidder just took a trick. */
  function playNilBusted() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [392, 330, 262].forEach(function (f, i) { blip(f, 0.32, 'square', 0.1, b + i * 0.14); });
    sweep(300, 90, 0.6, 'sawtooth', 0.12, b + 0.38);
  }
  function playHandEnd() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [523, 587, 659, 784].forEach(function (f, i) { blip(f, 0.26, 'triangle', 0.16, b + i * 0.1); });
  }
  /** Both teams were set — nothing to cheer. */
  function playSad() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [392, 370, 349, 294].forEach(function (f, i) { blip(f, 0.38, 'triangle', 0.15, b + i * 0.2); });
  }
  // Real crowd applause on the final scoreboard — the same recording Trivia
  // uses. Falls back to the synth if the file can't load or play.
  const sfxApplause = document.getElementById('sfx-applause');
  let applauseFileBroken = false;
  let applausePending = false;
  if (sfxApplause) {
    sfxApplause.addEventListener('error', function () { applauseFileBroken = true; });
  }
  function playApplause() {
    if (sfxApplause && !applauseFileBroken) {
      try {
        sfxApplause.currentTime = 0;
        const p = sfxApplause.play();
        // Blocked by the autoplay policy — a reload lands on the scoreboard with
        // no gesture yet. Wait for one instead of falling back: the synth would
        // be scheduled on the suspended AudioContext and then blare out the
        // moment the page is next touched.
        if (p && p.catch) p.catch(function () { applausePending = true; });
        return;
      } catch (_) { applausePending = true; return; }
    }
    playApplauseSynth();
  }
  function playApplauseSynth() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    for (let i = 0; i < 34; i++) noise(0.1, 0.05 + Math.random() * 0.05, 1400 + Math.random() * 2600, b + Math.random() * 1.5);
    [523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.42, 'triangle', 0.16, b + i * 0.11); });
  }
  // Prime the media element during a user gesture so the later, state-driven
  // play() call is permitted by the autoplay policy.
  function primeApplause() {
    // Nothing to prime if the recording is already blocked-and-queued or
    // mid-playback — muting and pausing it here would cut the cheer off.
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
  // A reload lands on the scoreboard with no gesture yet, so the applause is
  // blocked; replay the recording on the next one.
  document.addEventListener('pointerdown', function () {
    if (!applausePending) return;
    applausePending = false;
    playApplause();
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
  // The bubble's tail juts 9px out of it, so this leaves ~13px of clear space by the seat box.
  const BUBBLE_GAP = 22;
  const emoteLayer = document.getElementById('emoteLayer');
  const seatBubbles = {};   // playerId → { el, timer }

  /** Park the bubble off the seat box, clear of that seat's played card. */
  function placeBubble(pid) {
    const rec = seatBubbles[pid];
    const seat = seatByPlayer[pid];
    const seatEl = seat && document.getElementById('seat-' + seat);
    if (!rec) return;
    if (!seatEl || !seatEl.firstChild) { clearSeatBubble(pid); return; }
    const origin = emoteLayer.getBoundingClientRect();
    const box = seatEl.getBoundingClientRect();
    // West's and East's cards land level with their seats, so those bubbles go above the box.
    const above = seat === 'W' || seat === 'E';
    rec.el.classList.toggle('eb-up', above);
    const x = above ? box.left + box.width / 2 : box.right + BUBBLE_GAP;
    const y = above ? box.top - BUBBLE_GAP : box.top + box.height / 2;
    rec.el.style.left = Math.round(x - origin.left) + 'px';
    rec.el.style.top = Math.round(y - origin.top) + 'px';
  }
  function placeBubbles() { Object.keys(seatBubbles).forEach(placeBubble); }
  function clearSeatBubble(pid) {
    const rec = seatBubbles[pid];
    if (!rec) return;
    clearTimeout(rec.timer);
    rec.el.remove();
    delete seatBubbles[pid];
  }
  function clearSeatBubbles() { Object.keys(seatBubbles).forEach(clearSeatBubble); }

  function showSeatEmote(pid, e) {
    clearSeatBubble(pid);
    const el = document.createElement('div');
    el.className = 'emote-bubble';
    el.textContent = e;
    emoteLayer.appendChild(el);
    const rec = { el: el, timer: null };
    seatBubbles[pid] = rec;
    placeBubble(pid);
    rec.timer = setTimeout(function () {
      if (seatBubbles[pid] === rec) clearSeatBubble(pid);
    }, EMOTE_SHOW_MS);
  }
  window.addEventListener('resize', placeBubbles);

  socket.on('host:emote', function (p) {
    if (!p || typeof p.id !== 'string' || typeof p.e !== 'string') return;
    if (p.kind === 'bubble' && currentView === 'table' && seatByPlayer[p.id]) showSeatEmote(p.id, p.e);
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
  let lobby = { teams: { red: [], blue: [] }, players: [], total: 0, capacity: 4, perTeam: 2, canStart: false, targetScore: 500, autoAdvance: true };
  let lastHumanTotal = -1;
  let dragActive = false;    // a row is mid-drag; defer lobby rebuilds
  let pendingLobby = null;   // latest snapshot to apply once the drag settles
  let suppressClick = false; // swallow the click that trails a real drag

  function renderQR() {
    fetch('/api/spades/config').then(function (r) { return r.json(); }).then(function (cfg) {
      const url = (cfg && cfg.joinUrl) || (window.location.origin + '/spades/join');
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      return fetch('/api/spades/qr?url=' + encodeURIComponent(url));
    }).then(function (r) { return r.text(); }).then(function (svg) { qrSlot.innerHTML = svg; }).catch(function () {});
  }

  function setSeg(seg, value) {
    if (!seg) return;
    Array.prototype.forEach.call(seg.querySelectorAll('.seg-btn'), function (b) {
      b.classList.toggle('on', b.dataset.value === String(value));
    });
  }

  function seatRow(p, team) {
    const row = document.createElement('div');
    row.className = 'seat-row' + (p.connected === false ? ' disconnected' : '');
    row.dataset.pid = p.id;
    row.dataset.team = team;

    const grip = document.createElement('span');
    grip.className = 'seat-grip'; grip.textContent = '⠿'; grip.title = 'Drag to move';

    const badge = document.createElement('span');
    badge.className = 'seat-badge'; badge.dataset.seat = p.seat || ''; badge.textContent = p.seat || '';

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

    // Click-to-switch (touch-host fallback): moves to the other team, swapping
    // with its last player when that team is already full.
    row.addEventListener('click', function () {
      if (suppressClick) { suppressClick = false; return; }
      socket.emit('host:assign', { playerId: p.id, team: team === 'red' ? 'blue' : 'red' });
    });
    return row;
  }

  function emptySlot(seat) {
    const e = document.createElement('div');
    e.className = 'seat-empty';
    e.textContent = seat + ' · open seat';
    return e;
  }

  // Joins the emptier team, like a newcomer does; drag to move it.
  addBotBtn.addEventListener('click', function () {
    socket.emit('host:addBot', {}, function (res) { if (res && !res.ok) toast('Could not add a CPU.'); });
  });

  const TEAM_SEAT_LETTERS = { red: ['N', 'S'], blue: ['E', 'W'] };

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

    [['red', slotsRed], ['blue', slotsBlue]].forEach(function (pair) {
      const team = pair[0];
      const slots = pair[1];
      const list = (l.teams && l.teams[team]) || [];
      slots.innerHTML = '';
      list.forEach(function (p) { slots.appendChild(seatRow(p, team)); });
      for (let i = list.length; i < (l.perTeam || 2); i++) slots.appendChild(emptySlot(TEAM_SEAT_LETTERS[team][i]));
    });

    startBtn.disabled = !l.canStart;
    addBotBtn.disabled = l.total >= l.capacity;
  }

  // ---- Pointer-drag between / within teams ----
  // The grabbed row flies with the pointer while a placeholder holds its drop
  // slot. Dropping onto a full team swaps places with the row it lands on.
  (function setupLobbyDrag() {
    const slotEls = { red: slotsRed, blue: slotsBlue };
    const colEls = { red: colRed, blue: colBlue };
    let d = null;

    function rowsIn(team) {
      return Array.prototype.slice.call(slotEls[team].querySelectorAll('.seat-row'))
        .filter(function (c) { return !d || c !== d.el; });
    }
    function measure() {
      const m = [];
      ['red', 'blue'].forEach(function (t) {
        rowsIn(t).forEach(function (c) { m.push([c, c.getBoundingClientRect().top]); });
      });
      return m;
    }
    function flip(prev) {
      if ((reduceMotion && reduceMotion.matches) || !prev) return;
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
    function teamAt(x, y) {
      const rr = colEls.red.getBoundingClientRect();
      const br = colEls.blue.getBoundingClientRect();
      function inside(r) { return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
      const inR = inside(rr), inB = inside(br);
      if (inR && !inB) return 'red';
      if (inB && !inR) return 'blue';
      function dist2(r) { const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2; return (x - cx) * (x - cx) + (y - cy) * (y - cy); }
      return dist2(rr) <= dist2(br) ? 'red' : 'blue';
    }
    function positionPlaceholder(team, y) {
      const slots = slotEls[team];
      const rows = rowsIn(team);
      let before = null;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) { before = rows[i]; break; }
      }
      if (!before) before = slots.querySelector('.seat-empty');
      if (d.team === team && d.ph.nextElementSibling === before) return;
      const prev = measure();
      slots.insertBefore(d.ph, before);
      d.team = team;
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
      const team = teamAt(x, y);
      colEls.red.classList.toggle('drag-over', team === 'red');
      colEls.blue.classList.toggle('drag-over', team === 'blue');
      positionPlaceholder(team, y);
    }
    function onUp() {
      if (!d) return;
      const cur = d; d = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!cur.active) return;   // never crossed the threshold → it was a tap
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 400);
      colEls.red.classList.remove('drag-over');
      colEls.blue.classList.remove('drag-over');

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
      const team = cur.team || cur.from;

      const el = cur.el;
      cur.ph.parentNode.insertBefore(el, cur.ph); cur.ph.remove();
      el.style.position = ''; el.style.left = ''; el.style.top = ''; el.style.width = '';
      el.style.margin = ''; el.style.zIndex = ''; el.style.pointerEvents = '';
      el.classList.remove('dragging'); el.style.transition = ''; el.style.transform = '';
      dragActive = false;
      pendingLobby = null;
      // The server's snapshot (which may include a swap) re-renders the list.
      socket.emit('host:assign', { playerId: cur.pid, team: team, beforeId: beforeId }, function (res) {
        if (res && !res.ok) renderLobby(lobby);
      });
    }
    function onDown(e) {
      if (e.button != null && e.button !== 0) return;
      if (!e.target || e.target.closest('.seat-kick')) return;
      const el = e.target.closest('.seat-row');
      if (!el || d) return;
      e.preventDefault();
      d = { el: el, pid: el.dataset.pid, from: el.dataset.team, team: null, downX: e.clientX, downY: e.clientY, active: false, offX: 0, offY: 0, ph: null };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }
    slotsRed.addEventListener('pointerdown', onDown);
    slotsBlue.addEventListener('pointerdown', onDown);
  })();

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
      if (res && !res.ok) toast('Could not start — it must be exactly 2 v 2.');
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
  /** Look up a seat letter / team from a player id, using the latest snapshot. */
  let seatByPlayer = {};
  let teamByPlayer = {};
  function indexSeats(seats) {
    seatByPlayer = {};
    teamByPlayer = {};
    (seats || []).forEach(function (s) { seatByPlayer[s.playerId] = s.seat; teamByPlayer[s.playerId] = s.team; });
  }

  function nameSpan(name, seat) {
    const who = document.createElement('span');
    who.className = 'pname';
    who.dataset.seat = seat || '';
    who.textContent = name || '';
    return who;
  }

  // ---------------- Deal ----------------
  let dealKey = '';
  function renderDeal(s) {
    indexSeats(s.seats);
    dealHand.textContent = s.handNumber;
    dealSub.textContent = 'Cards arrive face down on your phone';
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

  // ---------------- The table ----------------
  let lastTurnId = null;
  let lastTrickNumber = 0;
  let lastBidTurnId = null;
  // Set-piece bookkeeping. Keyed by hand so a host that connects or re-renders
  // mid-hand adopts the current state instead of replaying the slam.
  let spadesWereBroken = false;
  let fxHandKey = null;
  let collectTimer = null;
  let collectKey = null;

  let nameProbe = null;
  // The seat box is width-capped, so a name too long for it shrinks its own
  // text down to a readable floor rather than wrapping and stealing height.
  function fitSeatName(name) {
    name.style.removeProperty('font-size');
    name.classList.remove('wrap');
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
    const fitted = Math.floor(natural * avail / full);
    name.style.fontSize = Math.max(15, fitted) + 'px';
    // Still too wide at the readable floor: let it wrap rather than spill out of the seat.
    if (fitted < 15) name.classList.add('wrap');
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

  function bidLabel(s) {
    if (s.bid === null || s.bid === undefined) return null;
    if (s.nil) return s.blind ? 'Blind Nil' : 'Nil';
    return 'Bid ' + s.bid;
  }

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
      el.dataset.team = s.team;

      const label = document.createElement('div');
      label.className = 'seat-label';
      const pip = document.createElement('span');
      pip.className = 'seat-pip'; pip.dataset.seat = letter; pip.textContent = letter;
      const name = document.createElement('span');
      name.className = 'pname'; name.textContent = s.name;
      label.appendChild(pip); label.appendChild(name);
      el.appendChild(label);

      const info = document.createElement('div');
      info.className = 'seat-points';
      const bid = bidLabel(s);
      if (o.bidding) {
        if (bid) {
          info.classList.add(s.nil ? 'nil' : 'bid-in');
          if (s.nil) info.textContent = bid;
          else {
            info.appendChild(document.createTextNode('Bid '));
            const num = document.createElement('span');
            num.className = 'bid-num';
            num.textContent = s.bid;
            info.appendChild(num);
          }
        } else {
          info.textContent = s.playerId === o.turnPlayerId ? 'Bidding…' : 'Yet to bid';
        }
      } else {
        // Tricks taken against the bid; a nil has no target, so it keeps its label.
        info.textContent = s.nil
          ? bid + ' · ' + s.tricks + (s.tricks === 1 ? ' trick' : ' tricks')
          : s.tricks + ' / ' + (s.bid || 0) + ' tricks';
        if (s.nil) info.classList.add(s.tricks > 0 ? 'busted' : 'nil');
        else if (s.tricks >= s.bid) info.classList.add('made');
      }
      el.appendChild(info);

      // A CPU is always "present"; only a real phone can be away.
      if (!s.isBot && s.connected === false) el.classList.add('offline');

      if (o.turnPlayerId && s.playerId === o.turnPlayerId) el.classList.add('turn');
      if (o.winnerId && s.playerId === o.winnerId) el.classList.add('winner');
    });
    fitSeatNames();
    placeBubbles();
    // The felt may still be hidden on the first render, where nothing has a
    // width yet to measure against.
    requestAnimationFrame(function () { fitSeatNames(); placeBubbles(); });
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

  function renderStripTeam(node, t, bidding) {
    node.querySelector('.st-score').textContent = t.score;
    const bid = node.querySelector('.st-bid');
    if (bidding && !t.allBid) bid.textContent = '';
    else bid.textContent = t.tricks + ' / ' + t.bid;
    bid.classList.toggle('made', !bidding && t.bid > 0 && t.tricks >= t.bid);
    node.title = 'Team ' + t.label + ': ' + t.score + ' points, ' + t.bags + ' bags';
  }

  function renderHeader(s, bidding) {
    if (bidding) {
      tPhaseLabel.textContent = 'Bidding';
      tPhaseValue.textContent = (s.bidsIn || 0) + ' / 4';
    } else {
      tPhaseLabel.textContent = 'Trick';
      tPhaseValue.textContent = s.trickNumber + ' / 13';
    }
    tSpades.textContent = s.spadesBroken ? 'Broken' : 'Not broken';
    tSpadesItem.classList.toggle('broken', !!s.spadesBroken);
    if (s.teams) {
      renderStripTeam(tRed, s.teams.red, bidding);
      renderStripTeam(tBlue, s.teams.blue, bidding);
    }
  }

  function setWaiting(name) {
    // A dropped phone never forfeits its turn — the table just waits.
    if (name) {
      waitingNote.textContent = 'Waiting for ' + name + ' to come back…';
      waitingNote.hidden = false;
    } else {
      waitingNote.hidden = true;
    }
  }

  function renderBidTable(s) {
    indexSeats(s.seats);
    renderHeader(s, true);
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
    renderSeats(s.seats, { bidding: true, turnPlayerId: s.bidTurnPlayerId });
    renderTrickCards([], {});
    setWaiting(s.waitingOn);

    trickBadge.innerHTML = '';
    const turn = (s.seats || []).find(function (x) { return x.playerId === s.bidTurnPlayerId; });
    const nameEl = document.createElement('div');
    nameEl.className = 'tb-name';
    if (turn) {
      nameEl.appendChild(nameSpan(turn.name, turn.seat));
      nameEl.appendChild(document.createTextNode(' is bidding…'));
    } else {
      nameEl.textContent = 'Bidding';
    }
    const sub = document.createElement('div');
    sub.className = 'tb-pts';
    sub.textContent = 'Hand ' + s.handNumber;
    trickBadge.appendChild(nameEl);
    trickBadge.appendChild(sub);
    trickBadge.hidden = false;

    if (s.bidTurnPlayerId && s.bidTurnPlayerId !== lastBidTurnId) {
      lastBidTurnId = s.bidTurnPlayerId;
      if (currentView === 'table' || currentView === 'deal') playTurnCue();
    }
    adoptFx(s);
    show('table');
  }

  function renderTable(s) {
    indexSeats(s.seats);
    renderHeader(s, false);
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
    renderSeats(s.seats, { turnPlayerId: s.turnPlayerId });
    renderTrickCards(s.trick, {});
    trickBadge.hidden = true;
    setWaiting(s.waitingOn);
    lastBidTurnId = null;

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

  /** On a brand-new hand, adopt `spadesBroken` silently. */
  function adoptFx(s) {
    const handKey = 'h' + s.handNumber;
    if (handKey !== fxHandKey) {
      fxHandKey = handKey;
      spadesWereBroken = !!s.spadesBroken;
    }
  }

  /** Shatter the table the first time a spade hits the felt this hand. */
  function checkCardFx(s) {
    adoptFx(s);
    if (s.spadesBroken && !spadesWereBroken) {
      spadesWereBroken = true;
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

  let bustedKey = '';
  function renderTrickEnd(s) {
    indexSeats(s.seats);
    renderHeader(s, false);
    const r = s.result || {};
    renderSeats(s.seats, { winnerId: r.winnerId });
    renderTrickCards(s.trick, { takerId: r.winnerId });
    waitingNote.hidden = true;

    trickBadge.innerHTML = '';
    const nameEl = document.createElement('div');
    nameEl.className = 'tb-name';
    nameEl.appendChild(nameSpan(r.winnerName, seatByPlayer[r.winnerId]));
    nameEl.appendChild(document.createTextNode(' takes it'));
    const ptsEl = document.createElement('div');
    const team = r.winnerTeam && s.teams ? s.teams[r.winnerTeam] : null;
    if (r.bustedNil) {
      ptsEl.className = 'tb-pts busted';
      ptsEl.textContent = 'Nil busted!';
    } else if (team) {
      ptsEl.className = 'tb-pts' + (team.bid > 0 && team.tricks >= team.bid ? ' made' : '');
      ptsEl.dataset.team = r.winnerTeam;
      ptsEl.textContent = 'Team ' + team.label + ' · ' + team.tricks + ' / ' + team.bid;
    }
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
      }, 2000);
      if (currentView === 'table') {
        if (r.bustedNil && key !== bustedKey) { bustedKey = key; playNilBusted(); }
        else playTrickWin();
      }
    }

    checkCardFx(s);
    show('table');
  }

  // ---------------- Hand end ----------------
  let autoTimer = null;

  function signed(n) { return n > 0 ? '+' + n : (n < 0 ? '−' + (-n) : '0'); }

  function cell(text, cls) {
    const el = document.createElement('span');
    el.className = 'sr-cell' + (cls ? ' ' + cls : '');
    el.textContent = text;
    return el;
  }

  function renderHandEnd(s) {
    indexSeats(s.seats);
    heHand.textContent = s.handNumber;
    heTarget.textContent = s.targetScore;
    heTitle.textContent = '';
    if (s.gameOver && s.winnerTeam) {
      heTitle.appendChild(document.createTextNode('Team '));
      const t = document.createElement('span');
      t.className = 'team-word'; t.dataset.team = s.winnerTeam; t.textContent = TEAM_LABEL[s.winnerTeam];
      heTitle.appendChild(t);
      heTitle.appendChild(document.createTextNode(' wins!'));
    } else {
      heTitle.textContent = 'Scores';
    }

    const results = s.results || {};
    scoreRows.innerHTML = '';
    ['red', 'blue'].map(function (t) { return results[t]; }).filter(Boolean)
      .sort(function (a, b) { return b.total - a.total; })
      .forEach(function (r) {
        const row = document.createElement('div');
        row.className = 'score-row' + (r.made ? ' made' : ' set');
        row.dataset.team = r.team;

        const who = document.createElement('span');
        who.className = 'sr-who';
        const label = document.createElement('span');
        label.className = 'sr-team'; label.dataset.team = r.team; label.textContent = 'Team ' + r.label;
        who.appendChild(label);
        r.players.forEach(function (p) {
          const line = document.createElement('span');
          line.className = 'sr-player';
          const pip = document.createElement('span');
          pip.className = 'seat-pip'; pip.dataset.seat = p.seat; pip.textContent = p.seat;
          const name = document.createElement('span');
          name.className = 'sr-name pname'; name.dataset.seat = p.seat; name.textContent = p.name;
          const detail = document.createElement('span');
          detail.className = 'sr-pdetail';
          detail.textContent = p.nil
            ? (p.blind ? 'Blind Nil' : 'Nil') + ' · took ' + p.tricks
            : p.tricks + ' / ' + p.bid + ' tricks won';
          line.appendChild(pip); line.appendChild(name); line.appendChild(detail);
          who.appendChild(line);
        });

        const allNil = r.players.every(function (p) { return p.nil; });
        const bidCell = cell(allNil ? '—' : String(r.contract));
        const tookCell = cell(allNil ? '—' : String(r.won), r.made ? 'good' : 'bad');
        const nils = r.players.filter(function (p) { return p.nil; });
        const nilCell = cell(nils.length ? nils.map(function (p) { return (p.nilMade ? '✓ ' : '✗ ') + signed(p.nilPoints); }).join('\n') : '—',
          nils.length ? (nils.every(function (p) { return p.nilMade; }) ? 'good' : 'bad') : '');
        const bagCell = cell(r.bagsThisHand ? '+' + r.bagsThisHand : '0', r.bagPenalty ? 'bad' : '');
        if (r.bagPenalty) bagCell.textContent += ' (' + signed(r.bagPenalty) + ')';
        bagCell.title = r.bags + ' bags carried';
        const bagsTotal = document.createElement('span');
        bagsTotal.className = 'sr-bagtotal';
        bagsTotal.textContent = r.bags + '/10';
        bagCell.appendChild(bagsTotal);

        const delta = document.createElement('span');
        delta.className = 'sr-delta ' + (r.delta > 0 ? 'plus' : (r.delta < 0 ? 'minus' : 'zero'));
        delta.textContent = signed(r.delta);

        const total = document.createElement('span');
        total.className = 'sr-total';
        total.textContent = r.total;

        row.appendChild(who);
        row.appendChild(bidCell);
        row.appendChild(tookCell);
        row.appendChild(nilCell);
        row.appendChild(bagCell);
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
      const anyMade = ['red', 'blue'].some(function (t) { return results[t] && results[t].made; });
      if (anyMade || s.gameOver) playHandEnd(); else playSad();
    }
    lastTrickNumber = 0; lastTurnId = null; lastBidTurnId = null;
    show('handend');
  }

  // ---------------- Final ----------------
  function renderFinal(s) {
    finalTrophy.textContent = '🏆';
    finalHeading.textContent = '';
    if (s.winnerTeam) {
      finalHeading.appendChild(document.createTextNode('Team '));
      const t = document.createElement('span');
      t.className = 'team-word'; t.dataset.team = s.winnerTeam; t.textContent = s.winnerLabel;
      finalHeading.appendChild(t);
      finalHeading.appendChild(document.createTextNode(' wins!'));
    } else {
      finalHeading.textContent = 'Game over';
    }
    const why = s.reason === 'floor'
      ? 'The other team sank to ' + s.losingScore
      : 'First to ' + s.targetScore;
    finalSub.textContent = why + ' · ' + s.handsPlayed + (s.handsPlayed === 1 ? ' hand' : ' hands');

    finalList.innerHTML = '';
    (s.standings || []).forEach(function (r, i) {
      const row = document.createElement('div');
      row.className = 'final-row' + (r.team === s.winnerTeam ? ' is-winner' : '');
      row.dataset.team = r.team;

      const rank = document.createElement('span');
      rank.className = 'fr-rank';
      rank.textContent = i === 0 ? '🥇' : '🥈';

      const who = document.createElement('span');
      who.className = 'fr-who';
      const label = document.createElement('span');
      label.className = 'fr-team'; label.dataset.team = r.team; label.textContent = 'Team ' + r.label;
      const names = document.createElement('span');
      names.className = 'fr-name';
      r.players.forEach(function (p, k) {
        if (k) names.appendChild(document.createTextNode(' & '));
        const n = nameSpan(p.name + (p.isBot && !/^CPU\b/.test(p.name) ? ' (CPU)' : ''), p.seat);
        names.appendChild(n);
      });
      who.appendChild(label); who.appendChild(names);

      const total = document.createElement('span');
      total.className = 'fr-total';
      total.textContent = r.score;

      row.appendChild(rank); row.appendChild(who); row.appendChild(total);
      finalList.appendChild(row);
    });

    if (currentView !== 'final') {
      playApplause();
      confetti();
    }
    show('final');
  }

  // ---------------- Standings peek ----------------
  // Team totals only move at hand end, so mid-hand they are already the
  // "not counting this hand" figure the popup promises.
  let standingsKey = '';

  function closeStandings() {
    standingsPop.hidden = true;
    standingsBtn.setAttribute('aria-expanded', 'false');
  }

  /** Offer the peek during live play only — the scoreboards already show totals. */
  function setStandings(s) {
    if (!s || !s.teams) { closeStandings(); standingsDock.hidden = true; standingsKey = ''; return; }
    standingsDock.hidden = false;

    const rows = ['red', 'blue'].map(function (t) { return s.teams[t]; })
      .sort(function (a, b) { return b.score - a.score; });
    const key = rows.map(function (r) { return r.team + '\u0001' + r.names.join('\u0002') + '\u0001' + r.score + '\u0001' + r.bags; })
      .join('|') + '@' + s.targetScore;
    if (key === standingsKey) return;   // don't rebuild under the host's eyes
    standingsKey = key;

    standingsRows.innerHTML = '';
    rows.forEach(function (r) {
      const row = document.createElement('div');
      row.className = 'sp-row';
      row.dataset.team = r.team;

      const dot = document.createElement('span');
      dot.className = 'sp-dot'; dot.dataset.team = r.team;

      const name = document.createElement('span');
      name.className = 'sp-name';
      const label = document.createElement('span');
      label.className = 'sp-team'; label.dataset.team = r.team; label.textContent = 'Team ' + r.label;
      const names = document.createElement('span');
      names.className = 'sp-names pname';
      names.textContent = r.names.join(' & ');
      const bags = document.createElement('span');
      bags.className = 'sp-bags';
      bags.textContent = r.bags + (r.bags === 1 ? ' bag' : ' bags');
      name.appendChild(label); name.appendChild(names); name.appendChild(bags);

      const total = document.createElement('span');
      total.className = 'sp-total'; total.textContent = r.score;

      row.appendChild(dot); row.appendChild(name); row.appendChild(total);
      standingsRows.appendChild(row);
    });
    standingsFoot.textContent = 'Playing to ' + s.targetScore + ' · −200 loses';
  }

  standingsBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (standingsPop.hidden) {
      closeLastTrick();
      standingsPop.hidden = false;
      standingsBtn.setAttribute('aria-expanded', 'true');
    } else closeStandings();
  });
  standingsClose.addEventListener('click', closeStandings);
  document.addEventListener('click', function (e) {
    if (standingsPop.hidden) return;
    if (!standingsDock.contains(e.target)) closeStandings();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !standingsPop.hidden) closeStandings();
  });

  // ---------------- Last-trick peek ----------------
  let lastTrickKey = '';

  function closeLastTrick() {
    lastTrickPop.hidden = true;
    lastTrickBtn.setAttribute('aria-expanded', 'false');
  }

  /** Offered on the table only, once this hand has a finished trick to show. */
  function setLastTrick(s) {
    const t = s && s.lastTrick;
    if (!t || !t.cards || !t.cards.length) {
      closeLastTrick(); lastTrickDock.hidden = true; lastTrickKey = ''; return;
    }
    lastTrickDock.hidden = false;

    const key = s.handNumber + ':' + t.number;
    if (key === lastTrickKey) return;
    lastTrickKey = key;

    const byId = {};
    (s.seats || []).forEach(function (p) { byId[p.playerId] = p; });

    lastTrickNote.textContent = 'Trick ' + t.number + ' of ' + (s.tricksPerHand || 13);
    lastTrickCards.innerHTML = '';
    t.cards.forEach(function (c, i) {
      const who = byId[c.playerId] || {};
      const led = i === 0;
      const took = c.playerId === t.winnerId;

      const cellEl = document.createElement('div');
      cellEl.className = 'lt-play' + (led ? ' is-lead' : '') + (took ? ' is-taker' : '');
      cellEl.dataset.seat = who.seat || '';
      cellEl.appendChild(cardImg(c.card));

      const name = document.createElement('span');
      name.className = 'lt-name pname';
      name.dataset.seat = who.seat || '';
      name.textContent = who.name || '';
      cellEl.appendChild(name);

      if (led) {
        const tag = document.createElement('span');
        tag.className = 'lt-tag';
        tag.textContent = 'Led';
        cellEl.appendChild(tag);
      }

      lastTrickCards.appendChild(cellEl);
    });

    const badge = document.createElement('div');
    badge.className = 'lt-badge';
    const nameEl = document.createElement('div');
    nameEl.className = 'lt-badge-name';
    nameEl.appendChild(nameSpan(t.winnerName, (byId[t.winnerId] || {}).seat));
    nameEl.appendChild(document.createTextNode(' took it'));
    const teamEl = document.createElement('div');
    teamEl.className = 'lt-pts' + (t.bustedNil ? ' busted' : '');
    teamEl.dataset.team = t.winnerTeam || '';
    teamEl.textContent = t.bustedNil ? 'Nil busted!' : 'Team ' + (TEAM_LABEL[t.winnerTeam] || '');
    badge.appendChild(nameEl);
    badge.appendChild(teamEl);
    lastTrickCards.appendChild(badge);
  }

  lastTrickBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (lastTrickPop.hidden) {
      closeStandings();
      lastTrickPop.hidden = false;
      lastTrickBtn.setAttribute('aria-expanded', 'true');
    } else closeLastTrick();
  });
  lastTrickClose.addEventListener('click', closeLastTrick);
  document.addEventListener('click', function (e) {
    if (lastTrickPop.hidden) return;
    if (!lastTrickDock.contains(e.target)) closeLastTrick();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !lastTrickPop.hidden) closeLastTrick();
  });

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

  socket.on('state:lobby', function (l) { renderLobby(l); if (l.phase === 'LOBBY') show('lobby'); setStandings(null); setLastTrick(null); });
  socket.on('state:deal', function (s) { syncClock(s); renderDeal(s); setStandings(s); setLastTrick(null); });
  socket.on('state:bid', function (s) { syncClock(s); renderBidTable(s); setStandings(s); setLastTrick(null); });
  socket.on('state:table', function (s) { syncClock(s); renderTable(s); setStandings(s); setLastTrick(s); });
  socket.on('state:trickEnd', function (s) { syncClock(s); renderTrickEnd(s); setStandings(s); setLastTrick(s); });
  socket.on('state:handEnd', function (s) { syncClock(s); renderHandEnd(s); setStandings(null); setLastTrick(null); });
  socket.on('state:final', function (s) { renderFinal(s); setStandings(null); setLastTrick(null); });

  // Each bid gets its own cue; Nil and Blind Nil get a flourish of their own.
  socket.on('state:bidPlaced', function (b) {
    if (!b) return;
    if (b.nil) playNilBid(!!b.blind); else playBidPlaced();
    const seat = seatByPlayer[b.playerId];
    const seatEl = seat && document.getElementById('seat-' + seat);
    if (seatEl) {
      seatEl.classList.remove('bid-flash');
      void seatEl.offsetWidth;
      seatEl.classList.add('bid-flash');
      // Drop the class once the pop finishes, or its one-shot animation keeps
      // overriding the turn pulse on this seat for the rest of the hand.
      seatEl.addEventListener('animationend', function done(e) {
        if (e.animationName !== 'bidFlash') return;
        seatEl.removeEventListener('animationend', done);
        seatEl.classList.remove('bid-flash');
      });
    }
  });

  socket.on('state:reset', function () {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    dealKey = '';
    lastTurnId = null; lastTrickNumber = 0; lastBidTurnId = null;
    fxHandKey = null;
    collectKey = null; bustedKey = '';
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
    spadesWereBroken = false;
    lastHumanTotal = -1;
    setStandings(null);
    setLastTrick(null);
    show('lobby');
  });

  // ---------------- Boot ----------------
  renderQR();
})();
