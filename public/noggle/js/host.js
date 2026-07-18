(function () {
  'use strict';

  const socket = io('/noggle', { transports: ['polling', 'websocket'] });

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    intro: document.getElementById('view-intro'),
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
  const sizeToggle = document.getElementById('sizeToggle');
  const timeSelect = document.getElementById('timeSelect');
  const configHint = document.getElementById('configHint');

  const sizePill = document.getElementById('sizePill');
  const countdownEl = document.getElementById('countdown');
  const introCountdownEl = document.getElementById('introCountdown');
  const hostBoard = document.getElementById('hostBoard');
  const countsList = document.getElementById('countsList');

  const podiumEl = document.getElementById('podium');
  const lbRows = document.getElementById('lbRows');
  const recapBoard = document.getElementById('recapBoard');
  const recapStats = document.getElementById('recapStats');
  const revealWordsBtn = document.getElementById('revealWordsBtn');
  const revealOverlay = document.getElementById('revealOverlay');
  const revealSummary = document.getElementById('revealSummary');
  const revealList = document.getElementById('revealList');
  const revealCloseBtn = document.getElementById('revealCloseBtn');

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const resetBtn = document.getElementById('resetBtn');
  const muteReactionsBtn = document.getElementById('muteReactionsBtn');
  const reactionLayer = document.getElementById('reactionLayer');
  const sfxApplause = document.getElementById('sfx-applause');

  const MIN_WORD_LEN = { 4: 3, 5: 4, 6: 4 };
  let selectedSize = 5;

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
          setTimeout(go, 600);
        },
        { okLabel: 'Leave & Reset', danger: true }
      );
    });
  }

  // ---------------- Reactions ----------------
  const REACTION_EMOJIS = ['😂', '🔥', '👀', '🎉', '😱', '😡'];
  const REACTION_MAX_ON_SCREEN = 30;
  let reactionsMuted = false;
  function updateMuteReactionsBtn() {
    if (!muteReactionsBtn) return;
    if (reactionsMuted) {
      muteReactionsBtn.textContent = '🔕 Reactions: Off';
      muteReactionsBtn.classList.add('is-muted');
    } else {
      muteReactionsBtn.textContent = '🔔 Reactions: On';
      muteReactionsBtn.classList.remove('is-muted');
    }
  }
  updateMuteReactionsBtn();
  if (muteReactionsBtn) {
    muteReactionsBtn.addEventListener('click', function () {
      const next = !reactionsMuted;
      socket.emit('host:setReactionsMuted', { muted: next }, function (res) {
        if (res && res.ok) { reactionsMuted = !!res.reactionsMuted; updateMuteReactionsBtn(); }
      });
    });
  }
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
    el.addEventListener('animationend', function () { if (el.parentNode) el.parentNode.removeChild(el); });
    reactionLayer.appendChild(el);
  }
  socket.on('host:reaction', function (p) { if (p && typeof p.index === 'number') spawnReaction(p.index); });
  socket.on('state:reactionsMuted', function (p) { reactionsMuted = !!(p && p.muted); updateMuteReactionsBtn(); });

  // ---------------- Boot ----------------
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      reactionsMuted = !!res.reactionsMuted;
      updateMuteReactionsBtn();
      renderQR();
      renderLobby({ players: res.players });
      if (res.phase === 'LOBBY') show('lobby');
      else if (res.phase === 'INTRO') renderIntro(res.intro);
      else if (res.phase === 'ROUND') { show('round'); applyRound(res.round); renderCounts(res.counts); }
      else if (res.phase === 'FINAL') { show('final'); renderFinal(res); }
      if (window.Iris && typeof window.Iris.ready === 'function') window.Iris.ready();
    });
  });

  // ---------------- QR ----------------
  function renderQR() {
    fetch('/api/noggle/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        const url = (cfg && cfg.joinUrl) || (window.location.origin + '/noggle/join');
        joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
        return fetch('/api/noggle/qr?url=' + encodeURIComponent(url));
      })
      .then(function (r) { return r.text(); })
      .then(function (svg) { qrSlot.innerHTML = svg; })
      .catch(function () { joinUrlEl.textContent = 'QR unavailable — check server logs.'; });
  }

  // ---------------- Lobby ----------------
  let lastLobbyPlayerCount = -1;
  function renderLobby(state) {
    const players = (state && state.players) || [];
    if (lastLobbyPlayerCount >= 0 && players.length > lastLobbyPlayerCount) playDing();
    lastLobbyPlayerCount = players.length;
    playerCount.textContent = players.length;
    startBtn.disabled = players.length === 0;
    if (players.length === 0) {
      playerGrid.innerHTML = '<div class="player-empty">Waiting for players to join…</div>';
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
    if (views.lobby.classList.contains('active')) renderLobby(s);
  });
  socket.on('state:reset', function () {
    stopIntroTimer();
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    cancelFinalBeeps();
    roundEndsAt = 0; lastTickSec = null;
    show('lobby');
    countsList.innerHTML = '';
    podiumEl.innerHTML = ''; lbRows.innerHTML = '';
    renderLobby({ players: [] });
  });

  // ---------------- Size + time config ----------------
  // Default round length per board size (2 min for 4x4, 3 min for 5x5/6x6).
  const DEFAULT_TIME_SEC = { 4: 120, 5: 180, 6: 180 };
  let timeManuallySet = false;
  if (timeSelect) {
    timeSelect.addEventListener('change', function () { timeManuallySet = true; });
  }
  function setSize(n) {
    selectedSize = Number(n) || 4;
    if (sizeToggle) {
      sizeToggle.querySelectorAll('.size-opt').forEach(function (b) {
        b.classList.toggle('active', Number(b.getAttribute('data-size')) === selectedSize);
      });
    }
    if (configHint) {
      configHint.textContent = 'Minimum word length: ' + MIN_WORD_LEN[selectedSize] + ' letters';
    }
    // Apply the board's default time unless the host has hand-picked one.
    if (timeSelect && !timeManuallySet) {
      timeSelect.value = String(DEFAULT_TIME_SEC[selectedSize]);
    }
  }
  if (sizeToggle) {
    sizeToggle.addEventListener('click', function (e) {
      const b = e.target.closest('.size-opt');
      if (b) setSize(b.getAttribute('data-size'));
    });
  }
  setSize(5);

  // ---------------- Start ----------------
  startBtn.addEventListener('click', function () {
    unlockAudio();
    primeApplause();
    startBtn.disabled = true;
    socket.emit('host:start', {
      boardSize: selectedSize,
      timeLimitSec: parseInt(timeSelect.value, 10),
    }, function (res) {
      if (!res || !res.ok) {
        startBtn.disabled = false;
        showToast((res && res.reason) || 'Could not start');
        return;
      }
      playStartFanfare();
    });
  });

  // ---------------- Intro ----------------
  let introTimer = null;
  function stopIntroTimer() { if (introTimer) { clearInterval(introTimer); introTimer = null; } }
  function renderIntro(payload) {
    stopIntroTimer();
    show('intro');
    if (payload && typeof payload.serverNow === 'number') clockOffset = payload.serverNow - Date.now();
    const endsAt = (payload && payload.endsAt) || (Date.now() + 4000);
    function tick() {
      const left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      if (introCountdownEl) introCountdownEl.textContent = left <= 0 ? 'Go!' : String(left);
      if (left <= 0) stopIntroTimer();
    }
    tick();
    introTimer = setInterval(tick, 200);
  }
  socket.on('state:intro', function (p) { renderIntro(p); });

  // ---------------- Round ----------------
  let countdownTimer = null;
  let roundEndsAt = 0;
  let lastTickSec = null;
  let clockOffset = 0;
  // Final-countdown beeps are pre-scheduled on the AudioContext clock (below)
  // rather than fired from the 250ms display poll — the first beep after a long
  // audio-idle stretch was arriving late (audio graph cold-start), which made
  // the 5->4 gap noticeably shorter than the rest.
  let beepArmTimer = null;
  let scheduledBeepNodes = [];
  const BEEP_LEAD_MS = 250; // arm the schedule this long before the 5s mark
  function serverNow() { return Date.now() + clockOffset; }

  function renderBoard(el, board) {
    if (!board || !board.grid) return;
    const size = board.size;
    el.style.setProperty('--n', size);
    el.innerHTML = board.grid.map(function (row, r) {
      return row.map(function (cell, c) {
        const disp = cell === 'QU' ? 'Qu' : cell;
        return '<div class="b-tile" data-r="' + r + '" data-c="' + c + '">' + escapeHtml(disp) + '</div>';
      }).join('');
    }).join('');
  }

  function applyRound(round) {
    if (!round) return;
    if (typeof round.serverNow === 'number') clockOffset = round.serverNow - Date.now();
    roundEndsAt = round.roundEndsAt;
    lastTickSec = null;
    const size = round.board && round.board.size;
    if (sizePill && size) sizePill.textContent = size + '×' + size;
    renderBoard(hostBoard, round.board);
    tickCountdown();
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(tickCountdown, 250);
    scheduleFinalBeeps();
  }
  function tickCountdown() {
    const ms = Math.max(0, roundEndsAt - serverNow());
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    countdownEl.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    countdownEl.classList.toggle('warn', totalSec <= 10 && totalSec > 0);
    if (ms <= 0 && countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  // Pre-schedule the final 5->0 beeps on the sample-accurate audio clock so
  // they land at perfectly even 1s intervals regardless of setInterval jitter
  // or audio cold-start latency.
  function cancelFinalBeeps() {
    if (beepArmTimer) { clearTimeout(beepArmTimer); beepArmTimer = null; }
    scheduledBeepNodes.forEach(function (o) { try { o.stop(0); o.disconnect(); } catch (_) {} });
    scheduledBeepNodes = [];
  }
  function scheduleFinalBeeps() {
    cancelFinalBeeps();
    const msLeft = roundEndsAt - serverNow();
    if (msLeft <= 0) return;
    // Arm a hair before the 5s-left mark; if we're already inside it (host
    // joined mid-round), arm immediately and only the remaining beeps fire.
    const msUntilArm = msLeft - 5000 - BEEP_LEAD_MS;
    beepArmTimer = setTimeout(armFinalBeeps, Math.max(0, msUntilArm));
  }
  function armFinalBeeps() {
    beepArmTimer = null;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') ctx.resume().catch(function () {});
    const now = ctx.currentTime;
    // Audio-clock instant of the "5 seconds left" moment (may be slightly in
    // the past if we armed late / joined mid-round).
    const secLeftNow = (roundEndsAt - serverNow()) / 1000;
    const t5 = now + (secLeftNow - 5);
    for (let s = 5; s >= 1; s--) {
      const at = t5 + (5 - s);
      if (at >= now - 0.03) playTick(s, Math.max(now, at));
    }
    const atFinal = t5 + 5;
    if (atFinal >= now - 0.03) playTick(0, Math.max(now, atFinal));
  }
  socket.on('state:round', function (r) { stopIntroTimer(); show('round'); applyRound(r); });

  function renderCounts(counts) {
    counts = counts || [];
    // Live leaderboard: highest score first, ties broken by more words found.
    const sorted = counts.slice().sort(function (a, b) {
      return (b.score - a.score) || (b.wordCount - a.wordCount);
    });
    if (!sorted.length) {
      countsList.innerHTML = '<div class="counts-note">No players.</div>';
      return;
    }
    countsList.innerHTML = sorted.map(function (p) {
      return (
        '<div class="count-row ' + (p.connected ? '' : 'disconnected') + '">' +
          '<span class="cr-name">' + escapeHtml(p.name) + '</span>' +
          '<span class="cr-count">' + (p.score || 0) + '</span>' +
        '</div>'
      );
    }).join('');
  }
  socket.on('state:counts', function (p) { if (p) renderCounts(p.counts); });

  // ---------------- Final ----------------
  socket.on('state:final', function (f) {
    stopIntroTimer();
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    showFinalIntro(function () {
      show('final');
      renderFinal(f);
      confettiBurst();
      playApplause();
    });
  });

  function showFinalIntro(onDone) {
    const ov = document.getElementById('finalIntroOverlay');
    const txt = document.getElementById('finalIntroText');
    if (!ov || !txt) { onDone && onDone(); return; }
    txt.classList.remove('swap');
    ov.hidden = false;
    void ov.offsetWidth;
    ov.classList.add('visible');
    txt.textContent = '⏰ Time\'s up!';
    setTimeout(function () { txt.classList.add('swap'); }, 1800);
    setTimeout(function () { txt.textContent = 'Now for the results…'; txt.classList.remove('swap'); }, 2100);
    setTimeout(function () { if (onDone) onDone(); ov.classList.remove('visible'); }, 3800);
    setTimeout(function () { ov.hidden = true; }, 4400);
  }

  function renderFinal(f) {
    const podium = (f && f.podium) || [];
    const fullLb = (f && f.fullLeaderboard) || [];
    const board = f && f.board;
    const stats = (f && f.stats) || {};

    // Group podium entries by rank so ties share a medal.
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

    const headerRow = fullLb.length
      ? '<div class="leaderboard-row leaderboard-header"><div class="lb-rank">#</div><div>Name</div><div class="lb-longest">Longest</div><div class="lb-score">Score</div></div>'
      : '';
    lbRows.innerHTML = headerRow + fullLb.map(function (p, i) {
      const rank = (typeof p.rank === 'number') ? p.rank : (i + 1);
      const prevRank = i > 0 ? fullLb[i - 1].rank : null;
      const rankLabel = (rank === prevRank) ? '' : rank;
      const longest = p.longestWord ? escapeHtml(wordDisplay(p.longestWord)) : '—';
      return (
        '<div class="leaderboard-row">' +
          '<div class="lb-rank">' + rankLabel + '</div>' +
          '<div class="lb-name">' + escapeHtml(p.name) + '</div>' +
          '<div class="lb-longest">' + longest + '</div>' +
          '<div class="lb-score">' + (p.score || 0) + '</div>' +
        '</div>'
      );
    }).join('');

    if (board) renderBoard(recapBoard, board);
    const best = stats.bestWord ? (escapeHtml(stats.bestWord) + ' (' + stats.bestPoints + ')') : '—';
    recapStats.innerHTML =
      '<div class="rs-row"><span class="rs-label">Best possible word</span><span class="rs-value rs-best">' + best + '</span></div>' +
      '<div class="rs-row"><span class="rs-label">Words on the board</span><span class="rs-value">' + (stats.totalWords || 0) + '</span></div>' +
      '<div class="rs-row"><span class="rs-label">Max possible score</span><span class="rs-value">' + (stats.maxScore || 0) + '</span></div>';

    // Reset the reveal control for this fresh set of results.
    revealedWords = null;
    if (revealWordsBtn) {
      revealWordsBtn.disabled = false;
      revealWordsBtn.textContent = '🔍 See all words';
    }
    if (revealOverlay) revealOverlay.hidden = true;
  }

  // ---------------- Reveal all words (host) ----------------
  let revealedWords = null; // cached { words, totalWords, maxScore } once fetched

  if (revealWordsBtn) {
    revealWordsBtn.addEventListener('click', function () {
      if (revealedWords) { openRevealOverlay(revealedWords); return; }
      revealWordsBtn.disabled = true;
      revealWordsBtn.textContent = 'Solving…';
      socket.emit('host:solveBoard', {}, function (res) {
        if (!res || !res.ok) {
          revealWordsBtn.disabled = false;
          revealWordsBtn.textContent = '🔍 See all words';
          return;
        }
        revealedWords = res;
        revealWordsBtn.disabled = false;
        revealWordsBtn.textContent = '🔍 See all words';
        openRevealOverlay(res);
      });
    });
  }
  if (revealCloseBtn) {
    revealCloseBtn.addEventListener('click', function () {
      if (revealOverlay) revealOverlay.hidden = true;
    });
  }
  if (revealOverlay) {
    revealOverlay.addEventListener('click', function (e) {
      if (e.target === revealOverlay) revealOverlay.hidden = true;
    });
  }

  function openRevealOverlay(data) {
    const words = (data && data.words) || {};
    const all = Object.keys(words).sort(function (a, b) {
      return (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0);
    });
    revealSummary.textContent = (data.totalWords || all.length) + ' words  ·  ' +
      (data.maxScore || 0) + ' max points';
    revealList.innerHTML = all.map(function (w) {
      return '<span class="reveal-chip">' + escapeHtml(wordDisplay(w)) +
        '<span class="rc-pts">' + words[w] + '</span></span>';
    }).join('');
    if (revealOverlay) revealOverlay.hidden = false;
  }

  function podiumStep(klass, medal, group) {
    if (!group) return '<div class="podium-spot ' + klass + '"></div>';
    const tie = group.players.length > 1;
    let nameHtml;
    if (!tie) {
      nameHtml = '<div class="name">' + escapeHtml(group.players[0].name) + '</div>';
    } else {
      const VISIBLE_MAX = 2;
      const visible = group.players.slice(0, VISIBLE_MAX);
      const overflow = group.players.length - visible.length;
      nameHtml =
        '<div class="names">' +
          visible.map(function (p) { return '<div class="name">' + escapeHtml(p.name) + '</div>'; }).join('') +
          (overflow > 0 ? '<div class="more">…and ' + overflow + ' more</div>' : '') +
        '</div>';
    }
    const scoreLabel = (group.score || 0) + (group.score === 1 ? ' point' : ' points');
    return (
      '<div class="podium-spot ' + klass + (tie ? ' tie' : '') + '">' +
        '<div class="medal">' + medal + '</div>' +
        '<div class="rank">' + ordinal(group.rank) + (tie ? ' (tie)' : '') + '</div>' +
        nameHtml +
        '<div class="score">' + scoreLabel + '</div>' +
      '</div>'
    );
  }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ---------------- Web Audio ----------------
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
    if (!ctx || ctx.state !== 'running') { ctx && ctx.resume().catch(function () {}); if (!ctx || ctx.state !== 'running') return; }
    const t0 = ctx.currentTime;
    [{ freq: 523.25, start: 0.00, dur: 0.22 }, { freq: 659.25, start: 0.14, dur: 0.22 }, { freq: 783.99, start: 0.28, dur: 0.55 }]
      .forEach(function (n) {
        [{ type: 'triangle', freq: n.freq, vol: 0.45 }, { type: 'sine', freq: n.freq * 0.5, vol: 0.18 }].forEach(function (layer) {
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
  function playTick(secLeft, atTime) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') ctx.resume().catch(function () {});
    const t = (typeof atTime === 'number') ? atTime : ctx.currentTime;
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
    scheduledBeepNodes.push(osc);
  }
  function playDing() {
    const ctx = getAudioCtx();
    if (!ctx || ctx.state === 'suspended') return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  }
  document.addEventListener('click', function () { try { getAudioCtx(); } catch (_) {} }, { once: true });

  // ---------------- Celebration sound ----------------
  // Uses /noggle/assets/sounds/applause.mp3 (shipped). Synth fallback if missing
  // or not yet loaded — matches Trivia's behaviour.
  let applauseFileAvailable = null;
  if (sfxApplause) {
    sfxApplause.addEventListener('canplaythrough', function () { applauseFileAvailable = true; });
    sfxApplause.addEventListener('error', function () { applauseFileAvailable = false; });
  }
  function playApplause(durationSec) {
    if (sfxApplause && applauseFileAvailable === true) {
      try {
        sfxApplause.muted = false;
        sfxApplause.currentTime = 0;
        const pr = sfxApplause.play();
        // If the browser blocks the delayed media play (autoplay policy),
        // fall back to the Web Audio synth claps, which are already unlocked.
        if (pr && pr.catch) pr.catch(function () { playApplauseSynth(durationSec || 4); });
        return;
      } catch (e) { /* fall through to synth */ }
    }
    playApplauseSynth(durationSec || 4);
  }
  // Prime the media element during a user gesture (the Start click) so the
  // later, timer-driven play() call is permitted by the autoplay policy.
  function primeApplause() {
    if (!sfxApplause) return;
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
    } catch (e) { sfxApplause.muted = false; }
  }
  function playApplauseSynth(durationSec) {
    const ctx = getAudioCtx();
    if (!ctx || ctx.state !== 'running') { ctx && ctx.resume().catch(function () {}); if (!ctx || ctx.state !== 'running') return; }
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

  // ---------------- Confetti ----------------
  function confettiBurst() {
    const colors = ['#E6A93A', '#2E9E5B', '#FFFFFF', '#B47A17', '#8FD3B0'];
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
  // Render the two-letter "QU" tile as "Qu" within an uppercase board word.
  function wordDisplay(w) {
    return String(w).replace(/QU/g, 'Qu');
  }
})();
