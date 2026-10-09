(function () {
  'use strict';

  const socket = io('/nong', { transports: ['websocket', 'polling'], tryAllTransports: true });

  // ---------------- Tunables ----------------
  const FIXED_DT = 1 / 60;
  const MAX_STEPS = 8;
  const COUNTDOWN_FROM = 3;
  const COUNTDOWN_STEP_MS = 700;
  const POINT_MS = 3500;          // banner after an ordinary point / lost life
  const OUT_MS = 4500;            // banner after an elimination
  const WIN_MS = 3500;            // beat on the winning point before the results
  const OVERLAY_FADE_MS = 220;
  const SYNC_MS = 300;

  const POS_LABELS = {
    2: ['Left side', 'Right side'],
    3: ['Bottom side', 'Right side', 'Left side'],
    4: ['Bottom side', 'Right side', 'Top side', 'Left side'],
  };
  const SEAT_COLORS = ['#FF4D8D', '#38E1FF', '#FFD23F', '#7CFF6B'];

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    match: document.getElementById('view-match'),
    final: document.getElementById('view-final'),
  };
  let activeView = 'lobby';
  function show(name) {
    if (name !== 'final') {
      if (window.clearConfetti) window.clearConfetti();
      if (window.stopApplause) window.stopApplause();
    }
    activeView = name;
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('active', k === name); });
  }

  const qrSlot = document.getElementById('qrSlot');
  const joinUrlEl = document.getElementById('joinUrl');
  const playerCountEl = document.getElementById('playerCount');
  const playerCapEl = document.getElementById('playerCap');
  const targetLabel = document.getElementById('targetLabel');
  const targetSeg = document.getElementById('targetSeg');
  const arenaPreview = document.getElementById('arenaPreview');
  const arenaNote = document.getElementById('arenaNote');
  const seatList = document.getElementById('seatList');
  const addBotBtn = document.getElementById('addBotBtn');
  const configHint = document.getElementById('configHint');
  const startBtn = document.getElementById('startBtn');

  const canvas = document.getElementById('pitch');
  const scoreboard = document.getElementById('scoreboard');
  const countOverlay = document.getElementById('countOverlay');
  const coNum = document.getElementById('coNum');
  const coNote = document.getElementById('coNote');
  const pointBanner = document.getElementById('pointBanner');
  const pbText = document.getElementById('pbText');
  const pbSub = document.getElementById('pbSub');
  const pauseBtn = document.getElementById('pauseBtn');
  const pauseOverlay = document.getElementById('pauseOverlay');

  const finalTrophy = document.getElementById('finalTrophy');
  const finalHeading = document.getElementById('finalHeading');
  const finalSub = document.getElementById('finalSub');
  const standingsEl = document.getElementById('standings');
  const playAgainBtn = document.getElementById('playAgainBtn');

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const resetBtn = document.getElementById('resetBtn');
  const supersededOverlay = document.getElementById('supersededOverlay');

  // ---------------- Modal helpers (match other games) ----------------
  function showInlineConfirm(message, onYes, opts) {
    if (typeof window.showConfirm !== 'function') {
      if (window.confirm(message)) onYes && onYes();
      return;
    }
    const okLabel = (opts && opts.okLabel) || 'Yes';
    window.showConfirm(message, okLabel, opts || {}).then(function (ok) { if (ok) onYes && onYes(); });
  }
  function toast(message) {
    if (typeof window.showToast === 'function') { window.showToast(message); return; }
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
  document.addEventListener('click', function once() {
    document.removeEventListener('click', once);
    if (wakeLock === null) acquireWakeLock();
  });

  // ---------------- Fullscreen ----------------
  fullscreenBtn && fullscreenBtn.addEventListener('click', function () {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(function () {});
    else document.exitFullscreen();
  });
  document.addEventListener('fullscreenchange', function () {
    if (!fullscreenBtn) return;
    fullscreenBtn.textContent = document.fullscreenElement ? '⛶ Exit' : '⛶ Fullscreen';
    if (renderer) requestAnimationFrame(function () { renderer && renderer.resize(); });
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
      showInlineConfirm('Leaving will reset the game and kick all players. Go back to the hub?', function () {
        let navigated = false;
        const go = function () {
          if (navigated) return;
          navigated = true;
          if (window.Iris && typeof window.Iris.transitionTo === 'function') {
            window.Iris.transitionTo('/', origin, window.Iris.HUB);
          } else { window.location.href = '/'; }
        };
        socket.emit('host:leave', {}, go);
        setTimeout(go, 600);
      }, { okLabel: 'Leave & Reset', danger: true });
    });
  }

  // ---------------- Audio (WebAudio, no external assets) ----------------
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
    return audioCtx;
  }
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
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, freq, gain) {
    const c = getAudioCtx(); if (!c) return;
    try {
      const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = c.createBufferSource(); src.buffer = buf;
      const g = c.createGain(); g.gain.value = gain;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start();
    } catch (_) {}
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
  // Game start: a rising arcade arpeggio.
  function playStart() {
    const c = getAudioCtx(); if (!c) return;
    [392, 523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.18, 'square', 0.12, c.currentTime + i * 0.08); });
  }
  function playCountBlip(n) { blip(520 + (COUNTDOWN_FROM - Math.min(n, COUNTDOWN_FROM)) * 70, 0.12, 'square', 0.13); }
  // Serve — the "look up!" cue as the ball goes live.
  function playServe() {
    const c = getAudioCtx(); if (!c) return;
    blip(988, 0.1, 'square', 0.14);
    blip(1319, 0.16, 'square', 0.12, c.currentTime + 0.08);
  }
  // The classic paddle "pong", nudged up in pitch as the rally speeds up.
  function playHit(speed) { blip(460 + Math.min(1, (speed || 6) / 15) * 160, 0.07, 'square', 0.16); }
  function playWall() { blip(230, 0.06, 'square', 0.12); }
  function playPoint() {
    const c = getAudioCtx(); if (!c) return;
    [490, 370, 245].forEach(function (f, i) { blip(f, 0.16, 'square', 0.14, c.currentTime + i * 0.11); });
  }
  // Eliminated: a sinking "wah-wah".
  function playOut() {
    const c = getAudioCtx(); if (!c) return;
    [392, 370, 349].forEach(function (f, i) { sweep(f, f * 0.94, 0.3, 'sawtooth', 0.11, c.currentTime + i * 0.3); });
    sweep(330, 140, 0.9, 'sawtooth', 0.12, c.currentTime + 0.9);
  }
  function playWhistle() {
    const c = getAudioCtx(); if (!c) return;
    blip(1650, 0.18, 'square', 0.12);
    blip(2100, 0.18, 'square', 0.09, c.currentTime + 0.05);
  }
  function playApplause() {
    const c = getAudioCtx(); if (!c) return;
    noise(1.6, 1200, 0.11);
    [523, 659, 784, 1047, 1319].forEach(function (f, i) { blip(f, 0.45, 'square', 0.11, c.currentTime + i * 0.12); });
  }
  function playSad() {
    const c = getAudioCtx(); if (!c) return;
    [392, 330, 262, 196].forEach(function (f, i) { blip(f, 0.5, 'triangle', 0.16, c.currentTime + i * 0.26); });
  }

  // ---------------- Lobby ----------------
  let lobby = { capacity: 4, total: 0, players: [], mode: 'points', pointsToWin: 5, lives: 3, pointOptions: [3, 5, 7, 11], lifeOptions: [1, 3, 5, 7], canStart: false };
  let lastLobbyHumanTotal = -1;
  let suppressClick = false; // swallow the click that trails a real drag
  let dragActive = false;    // a seat is mid-drag; defer lobby rebuilds
  let pendingLobby = null;   // latest snapshot to apply once the drag settles

  function renderQR() {
    fetch('/api/nong/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        const url = (cfg && cfg.joinUrl) || (window.location.origin + '/nong/join');
        joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
        return fetch('/api/nong/qr?url=' + encodeURIComponent(url));
      })
      .then(function (r) { return r.text(); })
      .then(function (svg) { qrSlot.innerHTML = svg; })
      .catch(function () {});
  }

  // Tiny outline of the arena the current roster will play in, sides in seat colours.
  function renderArenaPreview(n, players) {
    if (!arenaPreview || !window.Nong) return;
    const L = window.Nong.layoutFor(Math.max(2, Math.min(4, n)));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    L.verts.forEach(function (v) {
      minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]);
      minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]);
    });
    const pad = 40;
    const vb = (minX - pad) + ' ' + (minY - pad) + ' ' + (maxX - minX + pad * 2) + ' ' + (maxY - minY + pad * 2);
    let lines = '';
    L.sides.forEach(function (s) {
      const filled = s.owner !== null && players[s.owner];
      const color = s.owner === null ? '#E9E6FF' : (filled ? SEAT_COLORS[s.owner] : 'rgba(255,255,255,0.25)');
      lines += '<line x1="' + s.ax + '" y1="' + s.ay + '" x2="' + s.bx + '" y2="' + s.by +
        '" stroke="' + color + '" stroke-width="34" stroke-linecap="round"/>';
    });
    arenaPreview.innerHTML = '<svg viewBox="' + vb + '" xmlns="http://www.w3.org/2000/svg">' + lines + '</svg>';
  }

  function renderLobby(l) {
    if (!l) return;
    // Don't rebuild the seats out from under an in-progress drag; apply the
    // latest snapshot once the drag settles.
    if (dragActive) { pendingLobby = l; return; }
    lobby = l;
    const players = l.players || [];
    const humanTotal = players.filter(function (p) { return !p.isBot; }).length;
    if (lastLobbyHumanTotal >= 0 && humanTotal > lastLobbyHumanTotal) playJoinDing();
    lastLobbyHumanTotal = humanTotal;

    playerCountEl.textContent = l.total;
    playerCapEl.textContent = l.capacity;

    // Target: points for a duel, lives for 3–4.
    const isLives = l.mode === 'lives';
    targetLabel.textContent = isLives ? 'Lives' : 'Points to win';
    const opts = isLives ? l.lifeOptions : l.pointOptions;
    const current = isLives ? l.lives : l.pointsToWin;
    targetSeg.innerHTML = '';
    opts.forEach(function (v) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (v === current ? ' active' : '');
      b.textContent = String(v);
      b.setAttribute('aria-pressed', v === current ? 'true' : 'false');
      b.addEventListener('click', function () {
        unlockAudio();
        socket.emit('host:setTarget', { mode: isLives ? 'lives' : 'points', value: v });
      });
      targetSeg.appendChild(b);
    });

    const n = l.total;
    renderArenaPreview(n, players);
    if (n >= 4) arenaNote.textContent = 'Square — 4 sides, ' + l.lives + (l.lives === 1 ? ' life' : ' lives') + ' each';
    else if (n === 3) arenaNote.textContent = 'Triangle — 3 sides, ' + l.lives + (l.lives === 1 ? ' life' : ' lives') + ' each';
    else arenaNote.textContent = 'Classic court — first to ' + l.pointsToWin;

    const labels = POS_LABELS[Math.max(2, Math.min(4, n))];
    seatList.innerHTML = '';
    for (let i = 0; i < l.capacity; i++) {
      const p = players[i];
      const row = document.createElement('div');
      row.className = 'seat' + (p ? ' filled' : ' empty') + (p && p.connected === false && !p.isBot ? ' disconnected' : '');
      row.style.setProperty('--seat', SEAT_COLORS[i]);
      if (p) {
        row.dataset.pid = p.id;
        row.title = 'Drag to change seats';
      }
      const sw = document.createElement('div');
      sw.className = 'seat-swatch';
      const meta = document.createElement('div');
      meta.className = 'seat-meta';
      const num = document.createElement('div');
      num.className = 'seat-num';
      num.textContent = 'P' + (i + 1);
      const pos = document.createElement('div');
      pos.className = 'seat-pos';
      pos.textContent = p && labels[i] ? labels[i] : (p ? '' : '—');
      meta.appendChild(num);
      meta.appendChild(pos);
      const name = document.createElement('div');
      name.className = 'seat-name';
      name.textContent = p ? ((p.isBot ? '🤖 ' : '') + p.name) : 'Open — scan to join';
      row.appendChild(sw);
      row.appendChild(meta);
      row.appendChild(name);
      if (p) {
        const kick = document.createElement('button');
        kick.type = 'button';
        kick.className = 'seat-kick';
        kick.textContent = '✕';
        kick.title = p.isBot ? 'Remove CPU' : 'Remove player';
        kick.addEventListener('click', function (e) {
          e.stopPropagation();
          if (suppressClick) { suppressClick = false; return; }
          socket.emit('host:kick', { playerId: p.id });
        });
        row.appendChild(kick);
      }
      seatList.appendChild(row);
    }

    startBtn.disabled = !l.canStart;
    if (addBotBtn) addBotBtn.disabled = l.total >= l.capacity;
    if (l.canStart) configHint.textContent = '';
    else if (l.total === 0) configHint.textContent = 'Waiting for players…';
    else configHint.textContent = '';
  }

  addBotBtn && addBotBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:addBot', {}, function (res) {
      if (res && !res.ok && res.reason === 'game-full') toast('All four paddles are taken.');
    });
  });
  startBtn && startBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
      if (res && !res.ok) toast('Cannot start yet.');
    });
  });
  playAgainBtn && playAgainBtn.addEventListener('click', function () {
    socket.emit('host:reset', {});
  });

  // ---- Smooth pointer-drag for lobby seats ---------------------------------
  // Lift the grabbed seat so it flies with the pointer while a placeholder holds
  // its drop slot; displaced seats slide via FLIP. Seat colours and side labels
  // follow the order live, so the host sees who will defend which side.
  (function setupSeatDrag() {
    let reduceMotion = false;
    try { reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    let d = null; // active drag: { el, pid, downX, downY, active, offX, offY, ph }

    function filledRows() {
      return Array.prototype.slice.call(seatList.querySelectorAll('.seat.filled'))
        .filter(function (c) { return !d || c !== d.el; });
    }
    function measure() {
      return filledRows().map(function (c) { return [c, c.getBoundingClientRect().top]; });
    }
    function flip(prev) {
      if (reduceMotion || !prev) return;
      const moved = [];
      prev.forEach(function (rec) {
        const c = rec[0];
        if (!c.isConnected) return;
        const delta = rec[1] - c.getBoundingClientRect().top;
        if (delta) { c.style.transition = 'none'; c.style.transform = 'translateY(' + delta + 'px)'; moved.push(c); }
      });
      if (!moved.length) return;
      document.body.getBoundingClientRect(); // one sync reflow to commit offsets
      moved.forEach(function (c) {
        c.style.transition = 'transform 0.2s cubic-bezier(0.2,0.7,0.2,1)';
        c.style.transform = '';
      });
    }
    // Repaint every filled seat (and the lifted one) for the order on screen.
    function relabel() {
      const labels = POS_LABELS[Math.max(2, Math.min(4, lobby.total || 2))] || [];
      let i = 0;
      Array.prototype.forEach.call(seatList.children, function (c) {
        let row = null;
        if (c === d.ph) row = d.el;
        else if (c.classList.contains('filled') && c !== d.el) row = c;
        if (!row) return;
        row.style.setProperty('--seat', SEAT_COLORS[i]);
        const num = row.querySelector('.seat-num');
        const pos = row.querySelector('.seat-pos');
        if (num) num.textContent = 'P' + (i + 1);
        if (pos) pos.textContent = labels[i] || '';
        i++;
      });
    }
    function positionPlaceholder(y) {
      const rows = filledRows();
      let before = null;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) { before = rows[i]; break; }
      }
      // Below every player: sit above the first open seat.
      if (!before) before = seatList.querySelector('.seat.empty');
      if (d.ph.nextElementSibling === before && d.ph.parentNode === seatList) return;
      const prev = measure();
      seatList.insertBefore(d.ph, before); // before === null → append
      flip(prev);
      relabel();
    }
    function beginLift() {
      d.active = true;
      dragActive = true;
      const r = d.el.getBoundingClientRect();
      d.offX = d.downX - r.left;
      d.offY = d.downY - r.top;
      d.ph = document.createElement('div');
      d.ph.className = 'seat-placeholder';
      d.ph.style.height = r.height + 'px';
      d.el.parentNode.insertBefore(d.ph, d.el);
      d.el.style.position = 'fixed';
      d.el.style.left = '0';
      d.el.style.top = '0';
      d.el.style.width = r.width + 'px';
      d.el.style.margin = '0';
      d.el.style.zIndex = '50';
      d.el.style.pointerEvents = 'none';
      d.el.style.transition = 'none';
      d.el.classList.add('dragging');
    }
    function onMove(e) {
      if (!d) return;
      if (e.cancelable) e.preventDefault();
      const x = e.clientX, y = e.clientY;
      if (!d.active) {
        if (Math.abs(x - d.downX) < 5 && Math.abs(y - d.downY) < 5) return; // a tap, so far
        beginLift();
      }
      d.el.style.transform = 'translate(' + (x - d.offX) + 'px,' + (y - d.offY) + 'px) scale(1.02)';
      positionPlaceholder(y);
    }
    function onUp() {
      if (!d) return;
      const cur = d;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!cur.active) { d = null; return; }
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 400);
      let next = cur.ph.nextElementSibling;
      while (next && !(next.classList.contains('filled') && next !== cur.el)) next = next.nextElementSibling;
      const beforeId = next ? next.dataset.pid : null;
      const el = cur.el;
      // Settle: slide the lifted seat from the pointer into the placeholder slot.
      const floatRect = el.getBoundingClientRect();
      cur.ph.parentNode.insertBefore(el, cur.ph);
      cur.ph.remove();
      d = null;
      el.style.position = ''; el.style.left = ''; el.style.top = '';
      el.style.width = ''; el.style.margin = ''; el.style.zIndex = '';
      el.style.pointerEvents = '';
      let cleaned = false;
      const done = function () {
        if (cleaned) return; cleaned = true;
        el.classList.remove('dragging');
        el.style.transition = ''; el.style.transform = '';
        el.removeEventListener('transitionend', done);
      };
      if (reduceMotion) { done(); }
      else {
        const dest = el.getBoundingClientRect();
        el.style.transition = 'none';
        el.style.transform = 'translate(' + (floatRect.left - dest.left) + 'px,' + (floatRect.top - dest.top) + 'px) scale(1.02)';
        document.body.getBoundingClientRect();
        el.style.transition = 'transform 0.2s cubic-bezier(0.2,0.7,0.2,1)';
        el.style.transform = '';
        el.addEventListener('transitionend', done);
        setTimeout(done, 260); // fallback if transitionend never fires
      }
      dragActive = false;
      if (pendingLobby) { const pl = pendingLobby; pendingLobby = null; renderLobby(pl); }
      socket.emit('host:reorder', { playerId: cur.pid, beforeId: beforeId }, function (res) {
        if (res && !res.ok) renderLobby(lobby);
      });
    }
    function onDown(e) {
      if (e.button != null && e.button !== 0) return; // primary button only
      if (!e.target || e.target.closest('.seat-kick')) return; // kick isn't a handle
      const el = e.target.closest('.seat.filled');
      if (!el || d) return;
      d = { el: el, pid: el.dataset.pid, downX: e.clientX, downY: e.clientY, active: false, offX: 0, offY: 0, ph: null };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }
    seatList.addEventListener('pointerdown', onDown);
  }());

  // ---------------- Match ----------------
  let world = null;
  let renderer = null;
  let roster = [];
  let mode = 'points';
  let target = 5;
  let scores = {};
  let out = [];
  let paused = false;
  let matchState = 'idle'; // idle | count | play | point | over
  let superseded = false;
  let rafId = null;
  let lastFrame = 0;
  let acc = 0;
  let lastSync = 0;

  // Pausable timers: driven by the render loop, so a pause really freezes them.
  let timers = [];
  function after(ms, fn) { const t = { left: ms, fn: fn }; timers.push(t); return t; }
  function clearTimers() { timers = []; }
  function runTimers(dtMs) {
    if (!timers.length) return;
    const due = [];
    for (let i = timers.length - 1; i >= 0; i--) {
      timers[i].left -= dtMs;
      if (timers[i].left <= 0) { due.push(timers[i]); timers.splice(i, 1); }
    }
    for (let i = due.length - 1; i >= 0; i--) due[i].fn();
  }

  function rosterById(id) {
    for (let i = 0; i < roster.length; i++) if (roster[i].id === id) return roster[i];
    return null;
  }
  function displayName(r) { return (r.isBot ? '🤖 ' : '') + r.name; }
  function nameSpan(r) {
    const s = document.createElement('span');
    s.className = 'pname';
    s.style.color = r.color;
    s.textContent = displayName(r);
    return s;
  }

  function updateScoreboard() {
    if (renderer) renderer.setScores(mode, scores, target);
    scoreboard.innerHTML = '';
    roster.forEach(function (r, i) {
      if (mode === 'points' && i === 1) {
        const g = document.createElement('div');
        g.className = 'sb-goal';
        g.textContent = 'First to ' + target;
        scoreboard.appendChild(g);
      }
      const isOut = out.indexOf(r.id) >= 0;
      const card = document.createElement('div');
      card.className = 'sb-card' + (isOut ? ' out' : '');
      card.style.setProperty('--seat', r.color);
      const name = document.createElement('div');
      name.className = 'sb-name';
      name.textContent = displayName(r);
      const val = document.createElement('div');
      val.className = 'sb-val';
      if (mode === 'points') {
        val.textContent = String(scores[r.id] || 0);
      } else if (isOut) {
        val.textContent = 'OUT';
      } else {
        const left = scores[r.id] || 0;
        for (let k = 0; k < target; k++) {
          const h = document.createElement('span');
          h.className = 'heart' + (k < left ? '' : ' lost');
          h.textContent = '♥';
          val.appendChild(h);
        }
      }
      if (mode === 'points' && i === 1) { card.appendChild(val); card.appendChild(name); }
      else { card.appendChild(name); card.appendChild(val); }
      scoreboard.appendChild(card);
    });
  }

  function startMatch(meta, resumed) {
    roster = (meta && meta.roster) || [];
    mode = meta.mode === 'lives' ? 'lives' : 'points';
    target = meta.target || 5;
    scores = Object.assign({}, meta.scores || {});
    out = (meta.out || []).slice();

    world = new window.Nong.World({ roster: roster });
    out.forEach(function (id) { world.eliminate(id); });
    world.frozen = true;
    renderer = new window.NongRender.Renderer(canvas, world);
    paused = false;
    clearTimers();
    if (pauseOverlay) pauseOverlay.hidden = true;
    pointBanner.hidden = true;

    show('match');
    requestAnimationFrame(function () { if (renderer) renderer.resize(); });
    updateScoreboard();
    updatePauseBtn();
    startLoop();
    if (!resumed) playStart();
    beginCountdown(COUNTDOWN_FROM, resumed ? 'RESUMING' : 'GET READY', null);
  }

  // ---------------- Transient overlays ----------------
  function showOverlay(el) {
    if (!el) return;
    if (el._fadeTimer) { clearTimeout(el._fadeTimer); el._fadeTimer = null; }
    el.classList.remove('fade-out');
    el.hidden = false;
  }
  function hideOverlay(el, immediate) {
    if (!el) return;
    if (el._fadeTimer) { clearTimeout(el._fadeTimer); el._fadeTimer = null; }
    if (immediate || el.hidden) {
      el.classList.remove('fade-out');
      el.hidden = true;
      return;
    }
    el.classList.add('fade-out');
    el._fadeTimer = setTimeout(function () {
      el._fadeTimer = null;
      el.classList.remove('fade-out');
      el.hidden = true;
    }, OVERLAY_FADE_MS);
  }

  function beginCountdown(from, note, serveSeat) {
    matchState = 'count';
    if (world) { world.frozen = true; world.resetBall(); }
    if (renderer) renderer.clearTrail();
    pointBanner.hidden = true;
    showOverlay(countOverlay);
    coNote.hidden = !note;
    coNote.textContent = note || '';
    updatePauseBtn();
    let n = from || COUNTDOWN_FROM;
    const tick = function () {
      coNum.textContent = n > 0 ? String(n) : 'GO!';
      coNum.style.animation = 'none';
      void coNum.offsetWidth;
      coNum.style.animation = '';
      if (n > 0) playCountBlip(n);
      socket.emit('host:countdown', { n: n, note: note || null });
      if (n <= 0) { after(300, function () { beginPlay(serveSeat); }); return; }
      n--;
      after(COUNTDOWN_STEP_MS, tick);
    };
    tick();
  }

  function beginPlay(serveSeat) {
    if (!world) return;
    matchState = 'play';
    hideOverlay(countOverlay);
    pointBanner.hidden = true;
    world.frozen = false;
    world.serve(serveSeat);
    world.events.length = 0;
    playServe();
    socket.emit('host:play', {});
    updatePauseBtn();
  }

  function showBanner(text, color, subNodes, withHeart) {
    pbText.textContent = text;
    // The retro font has no heart glyph and a very wide space, so the heart is
    // its own element hugging the text instead of a character after a space.
    if (withHeart) {
      const h = document.createElement('span');
      h.className = 'pb-heart';
      h.textContent = '♥';
      pbText.appendChild(h);
    }
    pbText.style.color = color || 'var(--accent)';
    pbSub.innerHTML = '';
    (subNodes || []).forEach(function (n) {
      pbSub.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
    });
    pointBanner.hidden = false;
    pbText.style.animation = 'none';
    void pbText.offsetWidth;
    pbText.style.animation = '';
  }

  function onGoal(seat) {
    matchState = 'point';
    world.frozen = true;
    updatePauseBtn();
    const conceded = roster[seat];
    if (!conceded) return;
    renderer.flashSide(seat, conceded.color);
    renderer.burst(world.ball.x, world.ball.y, conceded.color, 70);
    renderer.burst(world.ball.x, world.ball.y, '#ffffff', 24);

    let scorer = null;
    let eliminated = null;
    let winner = null;
    let nextServe = null;
    if (mode === 'points') {
      scorer = roster[seat === 0 ? 1 : 0];
      scores[scorer.id] = (scores[scorer.id] || 0) + 1;
      if (scores[scorer.id] >= target) winner = scorer;
      nextServe = seat;
      showBanner(winner ? 'GAME!' : 'POINT!', scorer.color, [nameSpan(scorer), winner ? ' wins it!' : ' scores']);
    } else {
      scores[conceded.id] = Math.max(0, (scores[conceded.id] || 0) - 1);
      if (scores[conceded.id] === 0 && out.indexOf(conceded.id) < 0) {
        out.push(conceded.id);
        world.eliminate(conceded.id);
        eliminated = conceded;
        const alive = roster.filter(function (r) { return out.indexOf(r.id) < 0; });
        if (alive.length === 1) winner = alive[0];
        showBanner('OUT!', conceded.color, [nameSpan(conceded), ' is out of the game']);
      } else {
        const left = scores[conceded.id];
        showBanner('−1', conceded.color, [nameSpan(conceded), ' has ' + left + (left === 1 ? ' life' : ' lives') + ' left'], true);
      }
    }
    updateScoreboard();
    if (eliminated) playOut(); else playPoint();

    socket.emit('host:point', {
      concededId: conceded.id,
      scorerId: scorer ? scorer.id : null,
      eliminatedId: eliminated ? eliminated.id : null,
      scores: scores,
      out: out,
    });

    const wait = winner ? WIN_MS + (eliminated ? 600 : 0) : (eliminated ? OUT_MS : POINT_MS);
    after(wait, function () {
      pointBanner.hidden = true;
      if (winner) { endMatch(winner.id, false); return; }
      beginCountdown(COUNTDOWN_FROM, null, nextServe);
    });
  }

  // Nobody has touched the ball for a long while (it is skimming the walls) —
  // whistle it dead and serve a fresh one.
  function onIdle() {
    playWhistle();
    beginCountdown(COUNTDOWN_FROM, 'BALL RESET', null);
  }

  function computePlacings(winnerId) {
    const ids = roster.map(function (r) { return r.id; });
    const byScore = function (a, b) {
      if (a === winnerId) return -1;
      if (b === winnerId) return 1;
      return (scores[b] || 0) - (scores[a] || 0);
    };
    if (mode === 'points') return ids.slice().sort(byScore);
    const alive = ids.filter(function (id) { return out.indexOf(id) < 0; }).sort(byScore);
    return alive.concat(out.slice().reverse());
  }

  function ordinal(n) { return n === 1 ? '1ST' : n === 2 ? '2ND' : n === 3 ? '3RD' : n + 'TH'; }

  function endMatch(winnerId, quiet) {
    matchState = 'over';
    if (world) world.frozen = true;
    stopLoop();
    clearTimers();
    hideOverlay(countOverlay, true);
    pointBanner.hidden = true;
    if (pauseOverlay) pauseOverlay.hidden = true;
    paused = false;
    updatePauseBtn();
    if (!quiet) socket.emit('host:matchEnd', { winnerId: winnerId, scores: scores, out: out });
    renderFinal(winnerId, quiet);
  }

  function renderFinal(winnerId, quiet) {
    const winner = rosterById(winnerId);
    finalTrophy.textContent = winner ? '🏆' : '🏁';
    finalHeading.innerHTML = '';
    if (winner) {
      finalHeading.appendChild(nameSpan(winner));
      finalHeading.appendChild(document.createTextNode(' wins!'));
    } else {
      finalHeading.textContent = 'Game over';
    }
    if (mode === 'points') {
      const a = roster[0], b = roster[1];
      finalSub.textContent = a && b ? ('Final score ' + (scores[a.id] || 0) + ' – ' + (scores[b.id] || 0)) : '';
    } else {
      finalSub.textContent = 'Last paddle standing · ' + target + (target === 1 ? ' life' : ' lives') + ' each';
    }

    standingsEl.innerHTML = '';
    computePlacings(winnerId).forEach(function (id, i) {
      const r = rosterById(id);
      if (!r) return;
      const li = document.createElement('li');
      li.className = 'st-row' + (i === 0 ? ' first' : '');
      li.style.setProperty('--seat', r.color);
      const rank = document.createElement('div');
      rank.className = 'st-rank';
      rank.textContent = ordinal(i + 1);
      const name = document.createElement('div');
      name.className = 'st-name';
      name.textContent = displayName(r);
      const val = document.createElement('div');
      val.className = 'st-val';
      if (mode === 'points') {
        const pts = scores[r.id] || 0;
        val.textContent = pts + (pts === 1 ? ' pt' : ' pts');
      } else if (out.indexOf(r.id) >= 0) {
        val.textContent = 'Out';
      } else {
        const left = scores[r.id] || 0;
        val.textContent = left + ' ♥ left';
      }
      li.appendChild(rank);
      li.appendChild(name);
      li.appendChild(val);
      standingsEl.appendChild(li);
    });

    show('final');
    if (quiet) return;
    if (winner && !winner.isBot) { playApplause(); confetti(winner.color); }
    else playSad();
  }

  function confetti(color) {
    const colors = [color || '#C9A6FF', '#FF4D8D', '#38E1FF', '#FFD23F', '#7CFF6B', '#ffffff'];
    for (let i = 0; i < 70; i++) {
      const el = document.createElement('div');
      el.className = 'confetti-piece';
      el.style.left = Math.random() * 100 + 'vw';
      el.style.background = colors[i % colors.length];
      el.style.animationDelay = (Math.random() * 0.9) + 's';
      el.style.animationDuration = (2.4 + Math.random() * 1.6) + 's';
      document.body.appendChild(el);
      setTimeout(function () { el.remove(); }, 5000);
    }
  }

  // ---------------- Pause ----------------
  let resumeTimer = null;   // running resume 3-2-1, if any
  function updatePauseBtn() {
    if (!pauseBtn) return;
    pauseBtn.hidden = matchState !== 'play' && matchState !== 'count' && matchState !== 'point';
    pauseBtn.textContent = (paused && !resumeTimer) ? '▶ Resume' : '⏸ Pause';
    pauseBtn.classList.toggle('is-paused', paused);
  }
  function pauseMatch() {
    if (paused || matchState === 'idle' || matchState === 'over') return;
    clearResumeCount();
    paused = true;
    if (pauseOverlay) pauseOverlay.hidden = false;
    updatePauseBtn();
    socket.emit('host:pause', {});
  }
  function resumeMatch() {
    if (!paused) return;
    paused = false;
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    lastFrame = performance.now();
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
    const tick = function () { showResumeCount(n); socket.emit('host:resumeCount', { n: n }); playCountBlip(n); };
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

  // ---------------- Loop ----------------
  function startLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    lastFrame = performance.now();
    acc = 0;
    rafId = requestAnimationFrame(loop);
  }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (dt > 0.1) dt = 0.1;

    // Heartbeat: the full snapshot in every state (including paused), so a
    // phone that missed an event re-syncs within a moment.
    if (matchState !== 'idle' && matchState !== 'over' && now - lastSync >= SYNC_MS) {
      lastSync = now;
      socket.emit('host:sync', { scores: scores, out: out, live: matchState === 'play' && !paused, paused: paused });
    }

    if (!paused && world) {
      runTimers(dt * 1000);
      if (world && matchState !== 'over') {
        acc += dt;
        let steps = 0;
        let res = null;
        while (acc >= FIXED_DT && steps < MAX_STEPS) {
          world.stepBots();
          const r = world.step();
          acc -= FIXED_DT;
          steps++;
          if (r && matchState === 'play') { res = r; break; }
        }
        if (steps >= MAX_STEPS) acc = 0;
        drainEvents();
        if (res) {
          acc = 0;
          if (res.idle) onIdle();
          else onGoal(res.seat);
        }
      }
    }

    if (renderer) renderer.render(paused ? 1 : Math.min(1, acc / FIXED_DT), paused ? 0 : dt);
  }

  function drainEvents() {
    if (!world) return;
    const evs = world.events;
    let walls = 0;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.t === 'hit') playHit(e.speed);
      else if (e.t === 'wall' && walls < 2) { playWall(); walls++; }
    }
    evs.length = 0;
  }

  // ---------------- Socket ----------------
  socket.on('in', function (d) {
    if (!world || !d || paused) return;
    world.setInput(d.id, d.p / 1000);
  });

  socket.on('player:dropped', function (d) {
    if (world && d) world.setConnected(d.id, false);
  });
  socket.on('player:rejoined', function (d) {
    if (world && d) world.setConnected(d.id, true);
  });

  let authedOnce = false;
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      superseded = false;
      if (supersededOverlay) supersededOverlay.hidden = true;
      // A dropped-and-restored socket must never restart a match this screen is
      // already simulating — just carry on, the heartbeat re-syncs the players.
      if (authedOnce && matchState !== 'idle') return;
      authedOnce = true;
      renderLobby(res.lobby);
      if (res.phase === 'PLAYING' && res.match) {
        startMatch(res.match, true);
      } else if (res.phase === 'FINAL' && res.match) {
        roster = res.match.roster || [];
        mode = res.match.mode;
        target = res.match.target;
        scores = Object.assign({}, res.match.scores || {});
        out = (res.match.out || []).slice();
        matchState = 'over';
        renderFinal(res.match.winnerId, true);
      } else {
        show('lobby');
      }
    });
  });

  // Another host screen opened: only one may drive the physics, so stand down.
  socket.on('host:superseded', function () {
    superseded = true;
    stopLoop();
    clearTimers();
    world = null;
    renderer = null;
    matchState = 'idle';
    if (supersededOverlay) supersededOverlay.hidden = false;
  });

  socket.on('m:start', function (meta) {
    if (superseded) return;
    startMatch(meta, false);
  });

  socket.on('state:lobby', function (l) {
    if (l && l.phase === 'LOBBY') renderLobby(l);
  });

  socket.on('state:reset', function () {
    stopLoop();
    clearTimers();
    world = null;
    renderer = null;
    roster = [];
    scores = {};
    out = [];
    matchState = 'idle';
    paused = false;
    lastLobbyHumanTotal = -1;
    pointBanner.hidden = true;
    hideOverlay(countOverlay, true);
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    show('lobby');
  });

  window.addEventListener('resize', function () { if (renderer) renderer.resize(); });

  renderQR();
}());
