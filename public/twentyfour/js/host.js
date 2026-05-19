(function () {
  'use strict';

  const socket = io('/twentyfour', { transports: ['polling', 'websocket'] });

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    round: document.getElementById('view-round'),
    final: document.getElementById('view-final'),
  };
  function show(name) {
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle('active', k === name);
    });
  }

  const qrSlot = document.getElementById('qrSlot');
  const joinUrlEl = document.getElementById('joinUrl');
  const playerGrid = document.getElementById('playerGrid');
  const playerCount = document.getElementById('playerCount');
  const startBtn = document.getElementById('startBtn');
  const diffSelect = document.getElementById('diffSelect');
  const durSelect = document.getElementById('durSelect');

  const diffPill = document.getElementById('diffPill');
  const countdownEl = document.getElementById('countdown');
  const barsEl = document.getElementById('bars');

  const podiumEl = document.getElementById('podium');
  const lbRows = document.getElementById('lbRows');

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const resetBtn = document.getElementById('resetBtn');

  const sfxApplause = document.getElementById('sfx-applause');

  // ---------------- Modal helpers ----------------
  function showInlineConfirm(message, onYes, opts) {
    if (typeof window.showConfirm !== 'function') {
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

  // ---------------- Fullscreen ----------------
  fullscreenBtn && fullscreenBtn.addEventListener('click', function () {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function () {});
    } else {
      document.exitFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', function () {
    if (!fullscreenBtn) return;
    fullscreenBtn.textContent = document.fullscreenElement ? '⛶ Exit' : '⛶ Fullscreen';
  });

  // ---------------- Reset + Hub ----------------
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
      showInlineConfirm(
        'Leaving will reset the game and kick all players. Go back to the hub?',
        function () {
          let navigated = false;
          const go = function () {
            if (navigated) return;
            navigated = true;
            if (window.Iris && typeof window.Iris.transitionTo === 'function') {
              window.Iris.transitionTo('/', origin, { emoji: '🎮', name: 'Game Hub', color: '#1b2838' });
            } else {
              window.location.href = '/';
            }
          };
          socket.emit('host:leave', {}, go);
          setTimeout(go, 600); // safety net if ack never arrives
        },
        { okLabel: 'Leave & Reset', danger: true }
      );
    });
  }

  // ---------------- Boot ----------------
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      renderQR();
      renderLobby({ players: res.players });
      if (res.phase === 'LOBBY') show('lobby');
      else if (res.phase === 'ROUND') {
        show('round');
        applyRound(res.round);
        applyScores(res.leaderboard);
      } else if (res.phase === 'FINAL') {
        show('final');
        renderFinal(res.podium, res.fullLeaderboard);
      }
      if (window.Iris && typeof window.Iris.ready === 'function') window.Iris.ready();
    });
  });

  // ---------------- QR ----------------
  function renderQR() {
    fetch('/api/twentyfour/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        const url = (cfg && cfg.joinUrl) || (window.location.origin + '/twentyfour/join');
        joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
        return fetch('/api/twentyfour/qr?url=' + encodeURIComponent(url));
      })
      .then(function (r) { return r.text(); })
      .then(function (svg) { qrSlot.innerHTML = svg; })
      .catch(function () { joinUrlEl.textContent = 'QR unavailable — check server logs.'; });
  }

  // ---------------- Lobby ----------------
  function renderLobby(state) {
    const players = (state && state.players) || [];
    if (lastLobbyPlayerCount >= 0 && players.length > lastLobbyPlayerCount) {
      playDing();
    }
    lastLobbyPlayerCount = players.length;
    playerCount.textContent = players.length;
    startBtn.disabled = players.length === 0;
    if (players.length === 0) {
      playerGrid.innerHTML = '<div class="player-empty">Waiting for players to scan the QR code…</div>';
      return;
    }
    playerGrid.innerHTML = players.map(function (p) {
      return (
        '<div class="player-chip ' + (p.connected ? '' : 'disconnected') + '">' +
          '<span>' + escapeHtml(p.name) + '</span>' +
          '<button class="kick" data-pid="' + p.id + '" title="Kick">×</button>' +
        '</div>'
      );
    }).join('');
  }

  playerGrid.addEventListener('click', function (e) {
    const btn = e.target.closest('.kick');
    if (!btn) return;
    const pid = btn.dataset.pid;
    const name = btn.parentElement.querySelector('span').textContent;
    showInlineConfirm('Remove "' + name + '" from the game?', function () {
      socket.emit('host:kick', { playerId: pid });
    }, { okLabel: 'Kick', danger: true });
  });

  socket.on('state:lobby', function (s) {
    // We may receive lobby events while in round/final too — ignore them
    // visually unless we're actually showing the lobby. The data still
    // updates the underlying player list for when we go back.
    if (views.lobby.classList.contains('active')) renderLobby(s);
  });
  socket.on('state:reset', function () {
    show('lobby');
    barsEl.innerHTML = '';
    podiumEl.innerHTML = '';
    lbRows.innerHTML = '';
    renderLobby({ players: [] });
  });

  // ---------------- Start ----------------
  startBtn.addEventListener('click', function () {
    // First user click is also the audio-context unlock — call it before
    // we kick off the round so the fanfare actually plays.
    unlockAudio();
    startBtn.disabled = true;
    socket.emit('host:start', {
      difficulty: diffSelect.value,
      durationMin: parseFloat(durSelect.value),
    }, function (res) {
      if (!res || !res.ok) {
        startBtn.disabled = false;
        showToast((res && res.reason) || 'Could not start');
        return;
      }
      playStartFanfare();
    });
  });

  // ---------------- Web Audio fanfare (matches Trivia) ----------------
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
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
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
  function playStartFanfare() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function () {});
      if (ctx.state !== 'running') return;
    }
    const t0 = ctx.currentTime;
    const notes = [
      { freq: 523.25, start: 0.00, dur: 0.22 }, // C5
      { freq: 659.25, start: 0.14, dur: 0.22 }, // E5
      { freq: 783.99, start: 0.28, dur: 0.55 }, // G5
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
  // Initialize the audio context on the first user gesture so it's ready
  // when we want to play (browser autoplay policy).
  document.addEventListener('click', function () { try { getAudioCtx(); } catch (_) {} }, { once: true });

  // ---------------- Join ding (matches Trivia/Empire host lobby ding) ----------------
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
  let lastLobbyPlayerCount = -1;

  // ---------------- Round ----------------
  let countdownTimer = null;
  let roundEndsAt = 0;
  let lastTickSec = null;
  let clockOffset = 0;
  function serverNow() { return Date.now() + clockOffset; }
  function applyRound(round) {
    if (!round) return;
    if (typeof round.serverNow === 'number') {
      clockOffset = round.serverNow - Date.now();
    }
    roundEndsAt = round.roundEndsAt;
    lastTickSec = null;
    diffPill.textContent = (round.difficulty || 'any').toUpperCase();
    tickCountdown();
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(tickCountdown, 250);
  }
  function tickCountdown() {
    const ms = Math.max(0, roundEndsAt - serverNow());
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    countdownEl.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    countdownEl.classList.toggle('warn', totalSec <= 10 && totalSec > 0);
    if (totalSec >= 0 && totalSec <= 5 && totalSec !== lastTickSec) {
      lastTickSec = totalSec;
      playTick(totalSec);
    }
    if (ms <= 0 && countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  // Final-5-seconds beep + long timeout beep (matches Trivia).
  function playTick(secLeft) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function () {});
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

  socket.on('state:round', function (r) {
    show('round');
    applyRound(r);
    // Server sends a separate score:update with the initial all-zeros board.
  });

  // ---------------- Scoreboard (bar chart) ----------------
  // Render a bar per player; widths animate via CSS transition. We sort
  // descending by score so the leader floats to the top.
  function applyScores(leaderboard) {
    const lb = (leaderboard || []).slice().sort(function (a, b) { return b.score - a.score; });
    const maxScore = Math.max(1, lb.length ? lb[0].score : 1);
    barsEl.innerHTML = lb.map(function (p) {
      const pct = Math.round((p.score / maxScore) * 100);
      return (
        '<div class="bar-row" data-pid="' + p.id + '">' +
          '<div class="bar-name">' + escapeHtml(p.name) + '</div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="bar-value">' + p.score + '</div>' +
        '</div>'
      );
    }).join('');
  }
  socket.on('score:update', function (p) {
    applyScores(p && p.leaderboard);
  });

  // ---------------- Final ----------------
  socket.on('state:final', function (f) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    showFinalIntro(function () {
      show('final');
      renderFinal(f && f.podium, f && f.fullLeaderboard);
      safePlay(sfxApplause);
      confettiBurst();
    });
  });

  // Two-beat splash: "Time's up!" → "Now for the results…" before podium reveal.
  function showFinalIntro(onDone) {
    const ov = document.getElementById('finalIntroOverlay');
    const txt = document.getElementById('finalIntroText');
    if (!ov || !txt) { onDone && onDone(); return; }
    txt.classList.remove('swap');
    txt.textContent = '⏰ Time\'s up!';
    ov.hidden = false;
    // Force reflow so the opacity transition runs from 0.
    void ov.offsetWidth;
    ov.classList.add('visible');
    // Halfway through, fade the text and swap it.
    setTimeout(function () { txt.classList.add('swap'); }, 1800);
    setTimeout(function () {
      txt.textContent = 'Now for the results…';
      txt.classList.remove('swap');
    }, 2100);
    // Reveal podium just as the overlay starts fading out so the transition feels continuous.
    setTimeout(function () {
      if (onDone) onDone();
      ov.classList.remove('visible');
    }, 3800);
    setTimeout(function () { ov.hidden = true; }, 4400);
  }

  function renderFinal(podium, fullLb) {
    podium = podium || [];
    fullLb = fullLb || [];
    // The server sends a flat list of {rank, name, score} for the top three
    // ranks (ties expanded). Group them here so each medal can show all
    // tied players together.
    const groups = [];
    const byRank = new Map();
    podium.forEach(function (p) {
      if (!byRank.has(p.rank)) {
        const g = { rank: p.rank, score: p.score, players: [] };
        byRank.set(p.rank, g);
        groups.push(g);
      }
      byRank.get(p.rank).players.push({ name: p.name });
    });
    const gold = groups.find(function (g) { return g.rank === 1; });
    const silver = groups.find(function (g) { return g.rank === 2; });
    const bronze = groups.find(function (g) { return g.rank === 3; });
    podiumEl.innerHTML =
      podiumStep('second', '🥈', silver) +
      podiumStep('first', '🥇', gold) +
      podiumStep('third', '🥉', bronze);

    lbRows.innerHTML = fullLb.map(function (p, i) {
      return (
        '<div class="leaderboard-row">' +
          '<div class="lb-rank">' + (i + 1) + '</div>' +
          '<div>' + escapeHtml(p.name) + '</div>' +
          '<div class="lb-score">' + p.score + '</div>' +
        '</div>'
      );
    }).join('');
  }

  function podiumStep(klass, medal, group) {
    if (!group) return '<div class="podium-spot ' + klass + '"></div>';
    const tie = group.players.length > 1;
    const nameHtml = group.players.length === 1
      ? '<div class="name">' + escapeHtml(group.players[0].name) + '</div>'
      : '<div class="name">' +
          group.players.map(function (p) { return escapeHtml(p.name); }).join(' · ') +
        '</div>';
    return (
      '<div class="podium-spot ' + klass + (tie ? ' tie' : '') + '">' +
        '<div class="medal">' + medal + '</div>' +
        '<div class="rank">' + ordinal(group.rank) + (tie ? ' (tie)' : '') + '</div>' +
        nameHtml +
        '<div class="score">' + group.score + (group.score === 1 ? ' solve' : ' solves') + '</div>' +
      '</div>'
    );
  }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ---------------- Confetti + audio helpers ----------------
  function safePlay(el) {
    if (!el) return;
    try { el.currentTime = 0; el.play().catch(function () {}); } catch (e) {}
  }
  function confettiBurst() {
    const colors = ['#F97316', '#FFD200', '#FFFFFF', '#9A3412', '#FDBA74'];
    for (let i = 0; i < 120; i++) {
      const el = document.createElement('div');
      el.className = 'confetti';
      el.style.left = Math.random() * 100 + 'vw';
      el.style.background = colors[i % colors.length];
      el.style.animationDuration = (2.5 + Math.random() * 2) + 's';
      el.style.animationDelay = (Math.random() * 0.8) + 's';
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
})();
