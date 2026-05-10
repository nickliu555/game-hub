(function () {
  'use strict';

  const socket = io('/trivia', { transports: ['polling', 'websocket'] });

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    intro: document.getElementById('view-intro'),
    question: document.getElementById('view-question'),
    reveal: document.getElementById('view-reveal'),
    final: document.getElementById('view-final'),
  };
  function show(name) {
    const currentName = Object.keys(views).find(function (k) {
      return views[k].classList.contains('active');
    });
    if (currentName === name) return;
    const incoming = views[name];
    if (!incoming) return;
    const outgoing = currentName ? views[currentName] : null;
    if (outgoing) {
      outgoing.classList.add('fading-out');
      setTimeout(function () {
        outgoing.classList.remove('active');
        outgoing.classList.remove('fading-out');
        incoming.classList.add('active');
      }, 350);
    } else {
      incoming.classList.add('active');
    }
  }

  // ---------------- Inline modal / toast ----------------
  // Shared shape: window.showAlert / window.showConfirm provided by /shared/modal.js.
  function showInlineConfirm(message, onYes, opts) {
    if (typeof window.showConfirm !== 'function') {
      // Fallback if the shared script failed to load.
      if (window.confirm(message)) onYes && onYes();
      return;
    }
    const okLabel = (opts && opts.okLabel) || 'Yes';
    window.showConfirm(message, okLabel, opts || {}).then(function (ok) {
      if (ok) onYes && onYes();
    });
  }

  function showToast(message) {
    if (typeof window.showToast === 'function' && window.showToast !== showToast) {
      window.showToast(message);
      return;
    }
    const t = document.createElement('div');
    t.className = 'inline-toast';
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('visible'); }, 10);
    setTimeout(function () { t.classList.remove('visible'); setTimeout(function () { t.remove(); }, 300); }, 3000);
  }

  const joinUrlEl = document.getElementById('joinUrl');
  const qrImg = document.getElementById('qrImg');
  const playerList = document.getElementById('playerList');
  const playerCount = document.getElementById('playerCount');
  const startBtn = document.getElementById('startBtn');
  const startErrorEl = document.getElementById('startError');
  const catSelect = document.getElementById('catSelect');
  const diffSelect = document.getElementById('diffSelect');
  const countSelect = document.getElementById('countSelect');
  const timeSelect = document.getElementById('timeSelect');
  const loadingOverlay = document.getElementById('loadingOverlay');

  const qIndex = document.getElementById('qIndex');
  const qTotal = document.getElementById('qTotal');
  const qCat = document.getElementById('qCat');
  const qCatChip = document.getElementById('qCatChip');
  const qPrompt = document.getElementById('qPrompt');
  const answerGrid = document.getElementById('answerGrid');
  const answersReceived = document.getElementById('answersReceived');
  const answersTotal = document.getElementById('answersTotal');
  const timerRing = document.getElementById('timerRing');
  const timerText = document.getElementById('timerText');

  const introCountdown = document.getElementById('introCountdown');

  const rIndex = document.getElementById('rIndex');
  const rTotal = document.getElementById('rTotal');
  const rPrompt = document.getElementById('rPrompt');
  const barRows = document.getElementById('barRows');
  const leaderboard = document.getElementById('leaderboard');
  const nextBtn = document.getElementById('nextBtn');

  const podium = document.getElementById('podium');
  const fullLb = document.getElementById('fullLb');

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const muteReactionsBtn = document.getElementById('muteReactionsBtn');
  const resetBtn = document.getElementById('resetBtn');

  const sfxApplause = document.getElementById('sfx-applause');
  const sfxDrumroll = document.getElementById('sfx-drumroll');

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

  // ---------------- Fullscreen ----------------
  fullscreenBtn.addEventListener('click', function () {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function(){});
    } else {
      document.exitFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', function () {
    fullscreenBtn.textContent = document.fullscreenElement ? '⛶ Exit' : '⛶ Fullscreen';
  });

  resetBtn.addEventListener('click', function () {
    showInlineConfirm('Reset the entire game? All players will be kicked.', function () {
      socket.emit('host:reset', {});
    }, { okLabel: 'Reset', danger: true });
  });

  // Hub button: confirm + reset before navigating so the next visit is fresh.
  var hubBtn = document.getElementById('hubBtn');
  if (hubBtn) {
    hubBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var origin = { clientX: e.clientX, clientY: e.clientY, currentTarget: hubBtn };
      showInlineConfirm(
        'Leaving will reset the game and kick all players. Go back to the hub?',
        function () {
          var navigated = false;
          var go = function () {
            if (navigated) return;
            navigated = true;
            if (window.Iris && typeof window.Iris.transitionTo === 'function') {
              window.Iris.transitionTo('/', origin, { emoji: '🎮', name: 'Game Hub' });
            } else {
              window.location.href = '/';
            }
          };
          socket.emit('host:leave', {}, go);
          // Fallback in case the ack never comes (e.g. socket disconnected).
          setTimeout(go, 600);
        },
        { okLabel: 'Leave & Reset', danger: true }
      );
    });
  }

  // ---------------- Mute player reactions ----------------
  let reactionsMuted = false;
  function updateMuteReactionsBtn() {
    if (!muteReactionsBtn) return;
    if (reactionsMuted) {
      muteReactionsBtn.textContent = '🔕 Reactions: Off';
      muteReactionsBtn.classList.add('is-muted');
      muteReactionsBtn.title = 'Player reactions are muted — click to allow';
    } else {
      muteReactionsBtn.textContent = '🔔 Reactions: On';
      muteReactionsBtn.classList.remove('is-muted');
      muteReactionsBtn.title = 'Click to mute all player reactions';
    }
  }
  updateMuteReactionsBtn();
  if (muteReactionsBtn) {
    muteReactionsBtn.addEventListener('click', function () {
      const next = !reactionsMuted;
      socket.emit('host:setReactionsMuted', { muted: next }, function (res) {
        if (res && res.ok) {
          reactionsMuted = !!res.reactionsMuted;
          updateMuteReactionsBtn();
        }
      });
    });
  }
  socket.on('state:reactionsMuted', function (p) {
    reactionsMuted = !!(p && p.muted);
    updateMuteReactionsBtn();
  });

  // ---------------- Auto-enter on load ----------------
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      qTotal.textContent = res.questionsTotal || '—';
      rTotal.textContent = res.questionsTotal || '—';
      reactionsMuted = !!res.reactionsMuted;
      updateMuteReactionsBtn();
      if (res.phase === 'LOBBY') enterLobby(res);
      // Signal to the iris transition (if any) that the page is ready.
      if (window.Iris && typeof window.Iris.ready === 'function') {
        window.Iris.ready();
      }
    });
  });

  function enterLobby(initial) {
    show('lobby');
    qTotal.textContent = initial.questionsTotal || '—';
    rTotal.textContent = initial.questionsTotal || '—';
    renderQR();
    renderLobby({ players: initial.players });
  }

  // ---------------- QR ----------------
  function renderQR() {
    fetch('/api/trivia/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        const url = (cfg && cfg.joinUrl) || (window.location.origin + '/trivia/join');
        joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
        qrImg.src = '/api/trivia/qr?url=' + encodeURIComponent(url);
      })
      .catch(function () {
        const url = window.location.origin + '/trivia/join';
        joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
        qrImg.src = '/api/trivia/qr?url=' + encodeURIComponent(url);
      });
  }

  // ---------------- Categories ----------------
  fetch('/api/trivia/categories')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || !Array.isArray(data.categories)) return;
      data.categories.forEach(function (c) {
        const opt = document.createElement('option');
        opt.value = String(c.id);
        opt.textContent = c.name;
        catSelect.appendChild(opt);
      });
    })
    .catch(function () {
      // categories optional — Any-category still works
    });

  // ---------------- Join ding (matches Empire host lobby ding) ----------------
  // Reuses the existing getAudioCtx() defined later in this file via closure
  // hoisting (function declarations are hoisted).
  function playDing() {
    const ctx = getAudioCtx();
    if (!ctx || ctx.state === 'suspended') return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  }
  document.addEventListener('click', function () { try { getAudioCtx(); } catch (_) {} }, { once: true });
  let lastLobbyPlayerCount = -1;

  // ---------------- Lobby ----------------
  function renderLobby(s) {
    const players = s.players || [];
    if (lastLobbyPlayerCount >= 0 && players.length > lastLobbyPlayerCount) {
      playDing();
    }
    lastLobbyPlayerCount = players.length;
    playerCount.textContent = players.length;
    playerList.innerHTML = players.map(function (p) {
      const cls = 'player-chip' + (p.connected ? '' : ' disconnected');
      return '<div class="' + cls + '" data-pid="' + p.id + '" title="Click to remove">' + escapeHtml(p.name) + '</div>';
    }).join('');
    startBtn.disabled = players.length === 0;
  }

  playerList.addEventListener('click', function (e) {
    const chip = e.target.closest('.player-chip');
    if (!chip) return;
    const pid = chip.dataset.pid;
    const name = chip.textContent;
    showInlineConfirm('Remove "' + name + '" from the game?', function () {
      socket.emit('host:kick', { playerId: pid });
    }, { okLabel: 'Kick', danger: true });
  });

  function setLoading(on) {
    if (!loadingOverlay) return;
    loadingOverlay.hidden = !on;
    startBtn.disabled = on;
  }

  startBtn.addEventListener('click', function () {
    startErrorEl.hidden = true;
    startErrorEl.textContent = '';
    const opts = {
      category: catSelect.value || null,
      difficulty: diffSelect.value || null,
      amount: parseInt(countSelect.value, 10) || 10,
      timeLimitSec: parseInt(timeSelect.value, 10) || 20,
    };
    setLoading(true);
    socket.emit('host:start', opts, function (res) {
      setLoading(false);
      if (!res || !res.ok) {
        const msg = (res && (res.message || res.reason)) || 'Could not start the game.';
        startErrorEl.textContent = msg;
        startErrorEl.hidden = false;
      }
    });
  });

  socket.on('host:startLoading', function () { setLoading(true); });
  socket.on('host:startError', function (p) {
    setLoading(false);
    startErrorEl.textContent = (p && p.message) || 'Could not start.';
    startErrorEl.hidden = false;
  });

  const CHOICE_LETTERS = ['A', 'B', 'C', 'D'];
  function shapeHTML(i) { return '<span class="choice-letter">' + (CHOICE_LETTERS[i] || '') + '</span>'; }
  let currentQ = null;
  let qTimer = null;
  let lastTickSec = null;

  // ---------------- Server clock sync ----------------
  let clockOffset = 0;
  function serverNow() { return Date.now() + clockOffset; }

  // ---------------- Synth tick (Web Audio API) ----------------
  let audioCtx = null;
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    return audioCtx;
  }
  function unlockAudio() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(function(){});
    try {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.001);
    } catch (e) {}
  }
  ['click', 'keydown', 'touchstart'].forEach(function (evt) {
    window.addEventListener(evt, unlockAudio, { once: false, capture: true });
  });

  function playTick(secLeft) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function(){});
      if (ctx.state !== 'running') return;
    }
    const t = ctx.currentTime;
    const isFinal = secLeft === 0;
    const vol = isFinal ? 1.0 : 0.4 + (5 - secLeft) * 0.14;
    const freq = isFinal ? 1320 : 880;
    const dur = isFinal ? 0.55 : 0.12;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.01);
    gain.gain.setValueAtTime(vol, t + dur - 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // ---------------- Celebration sound ----------------
  // Uses /trivia/assets/sounds/applause.mp3 (shipped). Synth fallback if missing.
  let applauseFileAvailable = null;
  if (sfxApplause) {
    sfxApplause.addEventListener('canplaythrough', function () { applauseFileAvailable = true; });
    sfxApplause.addEventListener('error', function () { applauseFileAvailable = false; });
  }
  function playApplause(durationSec) {
    if (sfxApplause && applauseFileAvailable === true) {
      try { sfxApplause.currentTime = 0; sfxApplause.play().catch(function(){}); } catch (e) {}
      return;
    }
    playApplauseSynth(durationSec || 4);
  }
  function playApplauseSynth(durationSec) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function(){});
      if (ctx.state !== 'running') return;
    }
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
    const peakDensity = 24;
    const totalClaps = Math.floor(peakDensity * dur);
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

  function playCheerChord(tier) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function(){});
      if (ctx.state !== 'running') return;
    }
    const t = ctx.currentTime;
    const chords = {
      3: { freqs: [261.63, 329.63, 392.00],          dur: 0.9, vol: 0.45 },
      2: { freqs: [329.63, 415.30, 493.88],          dur: 1.1, vol: 0.55 },
      1: { freqs: [392.00, 493.88, 587.33, 783.99],  dur: 1.6, vol: 0.7  },
    };
    const c = chords[tier] || chords[3];
    c.freqs.forEach(function (f, i) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const startGain = c.vol / c.freqs.length;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(startGain, t + 0.02 + i * 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + c.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + c.dur + 0.05);
    });
  }

  function playStartFanfare() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function(){});
      if (ctx.state !== 'running') return;
    }
    const t0 = ctx.currentTime;
    const notes = [
      { freq: 523.25, start: 0.00, dur: 0.22 },
      { freq: 659.25, start: 0.14, dur: 0.22 },
      { freq: 783.99, start: 0.28, dur: 0.55 },
    ];
    notes.forEach(function (n) {
      [
        { type: 'triangle', freq: n.freq,       vol: 0.45 },
        { type: 'sine',     freq: n.freq * 0.5, vol: 0.18 },
      ].forEach(function (layer) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = layer.type;
        osc.frequency.value = layer.freq;
        const t = t0 + n.start;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(layer.vol, t + 0.015);
        gain.gain.setValueAtTime(layer.vol, t + n.dur - 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + n.dur + 0.05);
      });
    });
  }

  // ---------------- Sting overlay ----------------
  var STING_VISIBLE_MS = 2200;
  var STING_FADE_MS = 350;
  function playSting(reason, done) {
    var overlay = document.getElementById('stingOverlay');
    var textEl = document.getElementById('stingText');
    if (!overlay || !textEl) {
      if (typeof done === 'function') done();
      return;
    }
    var copy =
      reason === 'timeout' ? "Time's up!" :
      reason === 'all-answered' ? "Let's see the answers!" :
      'Results';
    textEl.textContent = copy;
    overlay.classList.remove('timeout', 'all-answered');
    overlay.classList.add(reason);
    requestAnimationFrame(function () { overlay.classList.add('visible'); });
    if (reason === 'all-answered') playRevealChime();
    if (typeof done === 'function') {
      setTimeout(done, STING_VISIBLE_MS - STING_FADE_MS);
    }
    setTimeout(function () { overlay.classList.remove('visible'); }, STING_VISIBLE_MS);
  }

  function playRevealChime() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function(){});
      if (ctx.state !== 'running') return;
    }
    const t0 = ctx.currentTime;
    const notes = [
      { freq: 783.99, start: 0.00, dur: 0.32 },
      { freq: 1046.50, start: 0.13, dur: 0.45 },
    ];
    notes.forEach(function (n) {
      [
        { type: 'triangle', freq: n.freq,       vol: 0.30 },
        { type: 'sine',     freq: n.freq * 2,   vol: 0.10 },
      ].forEach(function (layer) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = layer.type;
        osc.frequency.value = layer.freq;
        const t = t0 + n.start;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(layer.vol, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + n.dur + 0.05);
      });
    });
  }

  // Drumroll for podium suspense. Prefers /trivia/assets/sounds/drumroll.mp3
  // (capped to `durationSec` so the file's "tada" tail is never heard).
  // Falls back to a lightweight synth if the file is unavailable.
  let drumrollFileAvailable = null;
  if (sfxDrumroll) {
    sfxDrumroll.volume = 0.85;
    // `loadeddata` fires earlier than `canplaythrough` and is enough for our clip.
    sfxDrumroll.addEventListener('loadeddata',     function () { drumrollFileAvailable = true; });
    sfxDrumroll.addEventListener('canplaythrough', function () { drumrollFileAvailable = true; });
    sfxDrumroll.addEventListener('error',          function () { drumrollFileAvailable = false; });
    try { sfxDrumroll.load(); } catch (_) {}
  }

  function playDrumroll(durationSec) {
    var dur = Math.max(0.4, durationSec || 1.2);
    var fileReady = sfxDrumroll &&
      (drumrollFileAvailable === true || sfxDrumroll.readyState >= 2);
    if (fileReady && drumrollFileAvailable !== false) {
      var stopped = false;
      var cutoffTimer = null;
      try {
        sfxDrumroll.currentTime = 0;
        var p = sfxDrumroll.play();
        if (p && typeof p.catch === 'function') {
          p.catch(function (err) {
            // Transient errors (e.g. play() interrupted by pause()) are
            // common when reusing one <audio> across reveals. Don't blacklist
            // the file permanently — the next reveal can try again.
            console.warn('[drumroll] file play failed for this beat:', err);
          });
        }
      } catch (e) {
        // Hard error: fall back to synth this time only.
        return playDrumrollSynth(dur);
      }
      // Hard-stop after `dur` seconds so the trailing "tada" never plays.
      cutoffTimer = setTimeout(function () {
        try { sfxDrumroll.pause(); sfxDrumroll.currentTime = 0; } catch (_) {}
      }, dur * 1000);
      return function stop() {
        if (stopped) return;
        stopped = true;
        if (cutoffTimer) { clearTimeout(cutoffTimer); cutoffTimer = null; }
        try { sfxDrumroll.pause(); sfxDrumroll.currentTime = 0; } catch (_) {}
      };
    }
    return playDrumrollSynth(dur);
  }

  // Lightweight synth drumroll (fallback if drumroll.mp3 is unavailable).
  function playDrumrollSynth(durationSec) {
    var dur = Math.max(0.4, durationSec || 1.2);
    var stoppers = [];
    var stopped = false;
    var ctx = getAudioCtx();
    if (!ctx) return function () {};
    if (ctx.state !== 'running') ctx.resume().catch(function () {});
    var t0 = ctx.currentTime;
    var hitsPerSec = 22;
    var totalHits = Math.floor(dur * hitsPerSec);
    for (var i = 0; i < totalHits; i++) {
      var when = t0 + (i / hitsPerSec);
      var progress = i / totalHits;
      var vol = 0.08 + progress * 0.35;
      var bufferSize = Math.floor(ctx.sampleRate * 0.04);
      var buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      var data = buffer.getChannelData(0);
      for (var s = 0; s < bufferSize; s++) data[s] = (Math.random() * 2 - 1) * (1 - s / bufferSize);
      var src = ctx.createBufferSource();
      src.buffer = buffer;
      var filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 220;
      var gain = ctx.createGain();
      gain.gain.value = vol;
      src.connect(filt).connect(gain).connect(ctx.destination);
      src.start(when);
      src.stop(when + 0.05);
      stoppers.push(src);
    }
    return function stop() {
      if (stopped) return;
      stopped = true;
      stoppers.forEach(function (s) { try { s.stop(); } catch (_) {} });
    };
  }

  // ---------------- Question rendering ----------------
  function renderQuestion(q) {
    currentQ = q;
    lastTickSec = null;
    const wasPromptOnly = document.body.classList.contains('host-prompt-only');
    show('question');
    qIndex.textContent = q.index + 1;
    qTotal.textContent = q.total;
    qPrompt.textContent = q.prompt;
    if (qCat && qCatChip) {
      var catText = q.category || '';
      qCat.textContent = catText;
      qCatChip.hidden = !catText;
    }

    const needsTiles =
      !wasPromptOnly ||
      answerGrid.children.length !== q.choices.length ||
      Array.from(answerGrid.children).some(function (c, i) {
        const txt = c.querySelector('.text');
        return !txt || txt.textContent !== q.choices[i];
      });
    if (needsTiles) {
      answerGrid.innerHTML = q.choices.map(function (c, i) {
        return (
          '<div class="answer-card tile-color-' + i + '" data-idx="' + i + '">' +
            '<div class="shape">' + shapeHTML(i) + '</div>' +
            '<div class="text">' + escapeHtml(c) + '</div>' +
          '</div>'
        );
      }).join('');
    }

    answersReceived.textContent = '0';

    if (wasPromptOnly) {
      requestAnimationFrame(function () {
        document.body.classList.remove('host-prompt-only');
        startQTimer(q);
      });
    } else {
      document.body.classList.remove('host-prompt-only');
      startQTimer(q);
    }
  }

  // ---------------- Intro ----------------
  let introTimer = null;
  function stopIntroTimer() {
    if (introTimer) { clearInterval(introTimer); introTimer = null; }
  }
  function renderIntro(payload) {
    stopQTimer();
    stopIntroTimer();
    show('intro');
    if (payload && typeof payload.serverNow === 'number') {
      clockOffset = payload.serverNow - Date.now();
    }
    const endsAt = (payload && payload.endsAt) || (Date.now() + 5000);
    function tick() {
      const left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      if (introCountdown) introCountdown.textContent = left <= 0 ? 'Go!' : String(left);
      if (left <= 0) stopIntroTimer();
    }
    tick();
    introTimer = setInterval(tick, 200);
    playStartFanfare();
  }

  // ---------------- Prompt (read-the-question lead-in) ----------------
  function renderPrompt(p) {
    stopQTimer();
    stopIntroTimer();
    show('question');
    // For the very last question, briefly show a "🏆 Final Question!" splash
    // before the prompt content becomes readable. The server has padded this
    // prompt phase with extra time so the regular cadence is preserved.
    if (p && p.isLastQuestion) {
      showFinalQuestionSting();
    }
    qIndex.textContent = (p.index + 1);
    qTotal.textContent = p.total;
    qPrompt.textContent = p.prompt;
    if (qCat && qCatChip) {
      var catText = p.category || '';
      qCat.textContent = catText;
      qCatChip.hidden = !catText;
    }
    if (Array.isArray(p.choices) && p.choices.length === 4) {
      answerGrid.innerHTML = p.choices.map(function (c, i) {
        return (
          '<div class="answer-card tile-color-' + i + '" data-idx="' + i + '">' +
            '<div class="shape">' + shapeHTML(i) + '</div>' +
            '<div class="text">' + escapeHtml(c) + '</div>' +
          '</div>'
        );
      }).join('');
    } else {
      answerGrid.innerHTML = '';
    }
    answersReceived.textContent = '0';
    if (timerText && p.timeLimitSec) timerText.textContent = String(p.timeLimitSec);
    if (timerRing) timerRing.style.setProperty('--pct', '100');
    document.body.classList.add('host-prompt-only', 'host-prompt-instant');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.body.classList.remove('host-prompt-instant');
      });
    });
    if (p && typeof p.serverNow === 'number') {
      clockOffset = p.serverNow - Date.now();
    }
  }

  function startQTimer(q) {
    stopQTimer();
    if (typeof q.serverNow === 'number') clockOffset = q.serverNow - Date.now();
    const update = function () {
      const msLeft = Math.max(0, q.endsAt - serverNow());
      const secLeft = Math.ceil(msLeft / 1000);
      const pct = Math.max(0, (msLeft / (q.timeLimitSec * 1000)) * 100);
      timerText.textContent = String(secLeft);
      timerRing.style.setProperty('--pct', pct.toFixed(1));
      if (secLeft <= 5 && msLeft > 0) timerRing.classList.add('urgent');
      else timerRing.classList.remove('urgent');
      if (secLeft >= 0 && secLeft <= 5 && secLeft !== lastTickSec) {
        lastTickSec = secLeft;
        playTick(secLeft);
      }
      if (msLeft <= 0) stopQTimer();
    };
    update();
    qTimer = setInterval(update, 100);
  }
  function stopQTimer() {
    if (qTimer) { clearInterval(qTimer); qTimer = null; }
    if (timerRing) timerRing.classList.remove('urgent');
  }

  function showFinalQuestionSting() {
    const ov = document.getElementById('stingOverlay');
    const txt = document.getElementById('stingText');
    if (!ov || !txt) return;
    txt.textContent = '🏆 Final Question!';
    ov.classList.remove('timeout', 'all-answered');
    // Hide the question content underneath so the splash doesn't compete with it.
    document.body.classList.add('host-final-intro');
    document.body.classList.remove('host-final-intro-fading');
    // Show the splash.
    ov.classList.add('visible', 'final-question');
    // After the hold, start the splash leaving AND fade the prompt content in
    // at the same moment so it feels like one continuous transition.
    setTimeout(function () {
      ov.classList.remove('visible');
      document.body.classList.add('host-final-intro-fading');
    }, 3700);
    // Once the leave transition is done, clean up classes.
    setTimeout(function () {
      ov.classList.remove('final-question');
      document.body.classList.remove('host-final-intro', 'host-final-intro-fading');
    }, 5200);
  }

  // ---------------- Reveal ----------------
  function renderReveal(r) {
    stopQTimer();
    show('reveal');

    const q = currentQ || { prompt: '', choices: ['', '', '', ''] };
    rIndex.textContent = r.index + 1;
    rTotal.textContent = r.total;
    rPrompt.textContent = q.prompt;

    Array.from(answerGrid.children).forEach(function (card) {
      const idx = parseInt(card.dataset.idx, 10);
      card.classList.toggle('correct', idx === r.correctIndex);
      card.classList.toggle('dim', idx !== r.correctIndex);
    });

    const total = r.distribution.reduce(function (a, b) { return a + b; }, 0) || 1;
    barRows.innerHTML = [0,1,2,3].map(function (i) {
      const count = r.distribution[i];
      const pct = (count / total) * 100;
      const isCorrect = i === r.correctIndex;
      const colorVar = ['--ans-a','--ans-b','--ans-c','--ans-d'][i];
      const choiceText = (q.choices && q.choices[i]) || '';
      return (
        '<div class="bar-row ' + (isCorrect ? 'correct' : '') + '">' +
          '<div class="shape" style="color: var(' + colorVar + ')">' + shapeHTML(i) + '</div>' +
          '<div class="choice-text">' + escapeHtml(choiceText) + '</div>' +
          '<div class="bar"><div class="bar-fill" style="width:' + pct.toFixed(1) + '%; background: var(' + colorVar + ')"></div></div>' +
          '<div class="count">' + count + '</div>' +
        '</div>'
      );
    }).join('');

    leaderboard.innerHTML = r.leaderboardTop5.map(function (e) {
      return (
        '<div class="lb-row">' +
          '<div class="rank">' + e.rank + '</div>' +
          '<div class="name">' + escapeHtml(e.name) + '</div>' +
          '<div class="score">' + e.score + '</div>' +
        '</div>'
      );
    }).join('');

    var lbPanel = document.getElementById('leaderboardPanel');
    var revealGrid = document.getElementById('revealGrid');
    if (lbPanel) lbPanel.style.display = r.isLastQuestion ? 'none' : '';
    if (revealGrid) revealGrid.classList.toggle('solo', !!r.isLastQuestion);

    if (r.isLastQuestion) {
      nextBtn.textContent = '🏆 Show final results →';
      nextBtn.classList.remove('btn-primary');
      nextBtn.classList.add('btn-accent');
    } else {
      nextBtn.textContent = 'Next question →';
      nextBtn.classList.remove('btn-accent');
      nextBtn.classList.add('btn-primary');
    }
  }

  nextBtn.addEventListener('click', function () {
    socket.emit('host:next', {}, function () {});
  });

  // ---------------- Final ----------------
  var SUSPENSE_MS = 3000;
  var REVEAL_HOLD_MS = 1700;
  var SCORE_ROLL_MS = 900;

  function renderFinal(f) {
    show('final');
    var congratsEl = document.getElementById('finalCongrats');
    if (congratsEl) congratsEl.classList.remove('visible');

    var INTRO_MS = 3000;
    var intro = document.getElementById('resultsIntro');
    var finalView = document.querySelector('.final-view');
    if (finalView) finalView.classList.add('pre-reveal');
    if (intro) {
      intro.classList.remove('hide');
      requestAnimationFrame(function () { intro.classList.add('show'); });
    }
    setTimeout(function () {
      if (intro) { intro.classList.remove('show'); intro.classList.add('hide'); }
      setTimeout(function () {
        if (finalView) finalView.classList.remove('pre-reveal');
        runPodiumReveal(f);
      }, 650);
    }, INTRO_MS);
  }

  function runPodiumReveal(f) {
    var p = f.podium || [];
    var p1 = p[0], p2 = p[1], p3 = p[2];

    podium.innerHTML =
      podiumCell('place-2', '🥈', p2) +
      podiumCell('place-1', '🥇', p1) +
      podiumCell('place-3', '🥉', p3);

    fullLb.innerHTML =
      '<h3 style="margin-top:0;">Full scores</h3>' +
      (f.fullLeaderboard || []).map(function (e) {
        return (
          '<div class="lb-row">' +
            '<div class="rank">' + e.rank + '</div>' +
            '<div class="name">' + escapeHtml(e.name) + '</div>' +
            '<div class="score">' + e.score + '</div>' +
          '</div>'
        );
      }).join('');
    fullLb.classList.remove('visible');

    var steps = podium.querySelectorAll('.podium-step');
    var revealQueue = [
      { el: steps[2], entry: p3, tier: 3, label: 'Third place is…',  isWinner: false },
      { el: steps[0], entry: p2, tier: 2, label: 'Second place is…', isWinner: false },
      { el: steps[1], entry: p1, tier: 1, label: 'And the winner is…', isWinner: true  },
    ];

    revealQueue.forEach(function (slot) {
      if (!slot.el) return;
      slot.el.classList.add('suspense');
      var nameEl = slot.el.querySelector('.name');
      var scoreEl = slot.el.querySelector('.score');
      if (nameEl) {
        nameEl.dataset.finalName = nameEl.textContent;
        nameEl.innerHTML = '<span class="suspense-label">' + slot.label + '</span><span class="suspense-dots"><span></span><span></span><span></span></span>';
      }
      if (scoreEl) {
        scoreEl.dataset.finalScore = (slot.entry && slot.entry.score) || 0;
        scoreEl.textContent = '';
      }
    });

    var cursor = 400;
    revealQueue.forEach(function (slot) {
      if (!slot.el || !slot.entry) return;

      var WINNER_SCORE_MS = 700;
      var WINNER_HOLD_MS  = 300;
      var rollDur = slot.isWinner
        ? (SUSPENSE_MS + WINNER_SCORE_MS + WINNER_HOLD_MS) / 1000
        : SUSPENSE_MS / 1000;
      setTimeout(function () {
        slot.el.classList.add('visible');
        var stopRoll = playDrumroll(rollDur);
        setTimeout(function () {
          var nameEl = slot.el.querySelector('.name');
          var scoreEl = slot.el.querySelector('.score');
          var finalScore = scoreEl ? parseInt(scoreEl.dataset.finalScore || '0', 10) : 0;

          if (slot.isWinner) {
            // Reveal the name immediately (same as other tiers) so it
            // doesn't feel like lag — the drama is the score count-up.
            if (nameEl) {
              nameEl.textContent = nameEl.dataset.finalName || (slot.entry.name || '');
              nameEl.classList.add('revealed');
            }
            slot.el.classList.remove('suspense');
            slot.el.classList.add('revealed');
            if (scoreEl) {
              scoreEl.classList.add('rolling');
              animateScoreCount(scoreEl, finalScore, WINNER_SCORE_MS);
            }
            setTimeout(function () {
              if (scoreEl) scoreEl.classList.remove('rolling');
              if (typeof stopRoll === 'function') stopRoll();
              playCheerChord(slot.tier);
              confettiBurst();
              playApplause(4);
              var congrats = document.getElementById('finalCongrats');
              if (congrats) {
                setTimeout(function () { congrats.classList.add('visible'); }, 250);
              }
              setTimeout(function () { fullLb.classList.add('visible'); }, 1100);
            }, WINNER_SCORE_MS + WINNER_HOLD_MS);
          } else {
            if (typeof stopRoll === 'function') stopRoll();
            if (nameEl) {
              nameEl.textContent = nameEl.dataset.finalName || (slot.entry.name || '');
              nameEl.classList.add('revealed');
            }
            slot.el.classList.remove('suspense');
            slot.el.classList.add('revealed');
            playCheerChord(slot.tier);
            if (scoreEl) animateScoreCount(scoreEl, finalScore, SCORE_ROLL_MS);
          }
        }, SUSPENSE_MS);
      }, cursor);

      cursor += SUSPENSE_MS + REVEAL_HOLD_MS;
      if (slot.isWinner) cursor += WINNER_SCORE_MS + WINNER_HOLD_MS;
    });
  }

  function animateScoreCount(el, to, durationMs) {
    var start = performance.now();
    function step(now) {
      var t = Math.min(1, (now - start) / durationMs);
      var eased = 1 - Math.pow(1 - t, 3);
      var v = Math.round(eased * to);
      el.textContent = v + ' pts';
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function podiumCell(klass, medal, entry) {
    if (!entry) return '<div class="podium-step ' + klass + '"></div>';
    return (
      '<div class="podium-step ' + klass + '">' +
        '<div class="medal">' + medal + '</div>' +
        '<div class="name">' + escapeHtml(entry.name) + '</div>' +
        '<div class="score">' + entry.score + ' pts</div>' +
      '</div>'
    );
  }

  function confettiBurst() {
    const colors = ['#E21B3C', '#1368CE', '#D89E00', '#26890C', '#FFC700', '#46178F'];
    for (let i = 0; i < 120; i++) {
      const el = document.createElement('div');
      el.className = 'confetti';
      el.style.left = Math.random() * 100 + 'vw';
      el.style.background = colors[i % colors.length];
      el.style.animationDuration = 2.5 + Math.random() * 2 + 's';
      el.style.animationDelay = Math.random() * 0.8 + 's';
      el.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
      document.body.appendChild(el);
      setTimeout(function () { el.remove(); }, 6000);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------- Socket wiring ----------------
  socket.on('state:lobby', function (s) {
    renderLobby(s);
    answersTotal.textContent = s.total;
  });
  socket.on('state:question', renderQuestion);
  socket.on('state:reveal', function (r) {
    var reason = r && r.endReason;
    stopQTimer();
    if (reason === 'timeout' || reason === 'all-answered') {
      Object.keys(views).forEach(function (k) {
        views[k].classList.remove('active', 'fading-out');
      });
      setTimeout(function () { playSting(reason); }, 120);
      setTimeout(function () { renderReveal(r); }, 120 + STING_VISIBLE_MS + 350);
    } else {
      renderReveal(r);
    }
  });
  socket.on('state:final', renderFinal);
  socket.on('state:intro', renderIntro);
  socket.on('state:prompt', renderPrompt);

  // ---------------- Floating reactions ----------------
  const REACTION_EMOJIS = ['😂', '🔥', '👀', '🎉', '😱', '😡'];
  const REACTION_MAX_ON_SCREEN = 30;
  const reactionLayer = document.getElementById('reactionLayer');
  function spawnReaction(index) {
    if (!reactionLayer) return;
    const emoji = REACTION_EMOJIS[index];
    if (!emoji) return;
    while (reactionLayer.children.length >= REACTION_MAX_ON_SCREEN) {
      reactionLayer.removeChild(reactionLayer.firstChild);
    }
    const el = document.createElement('div');
    el.className = 'reaction-emoji';
    el.textContent = emoji;
    el.style.left = (5 + Math.random() * 90) + '%';
    const scale = 0.85 + Math.random() * 0.5;
    el.style.fontSize = (44 * scale) + 'px';
    el.style.animationDuration = (3.0 + Math.random() * 1.2) + 's';
    el.addEventListener('animationend', function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    reactionLayer.appendChild(el);
  }
  socket.on('host:reaction', function (payload) {
    if (!payload || typeof payload.index !== 'number') return;
    spawnReaction(payload.index);
  });

  socket.on('state:reset', function () {
    socket.emit('host:auth', {}, function (res) {
      if (res && res.ok) {
        currentQ = null;
        stopQTimer();
        stopIntroTimer();
        document.body.classList.remove('host-prompt-only');
        reactionsMuted = !!res.reactionsMuted;
        updateMuteReactionsBtn();
        if (startErrorEl) { startErrorEl.hidden = true; startErrorEl.textContent = ''; }
        enterLobby(res);
      }
    });
  });
  socket.on('host:answerCount', function (c) {
    answersReceived.textContent = c.answered;
    answersTotal.textContent = c.total;
  });
})();
