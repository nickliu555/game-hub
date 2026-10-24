(function () {
  'use strict';

  const socket = io('/blobball', { transports: ['websocket', 'polling'], tryAllTransports: true });
  const BB = window.BlobBall;

  // ---------------- Tunables ----------------
  const FIXED_DT = 1 / BB.TICK_HZ;
  const MAX_STEPS = 8;
  const COUNTDOWN_FROM = 3;
  const COUNTDOWN_STEP_MS = 700;
  const SERVE_HOLD_MS = 900;      // ball hangs over the server before it drops
  const POINT_MS = 2000;          // the dead ball keeps bouncing this long
  const MISS_MS = 1300;           // a whiffed serve bounces briefly, then re-serve
  const WIN_EXTRA_MS = 1400;      // extra beat on the winning point
  const OVERLAY_FADE_MS = 220;
  const SYNC_MS = 300;

  // [side][slot]: a team shares a colour family (matches server/blobball/game.js).
  const SLOT_COLORS = [
    [{ hex: '#5BE06B', name: 'Green' }, { hex: '#C8F04B', name: 'Lime' }],
    [{ hex: '#FF5C8D', name: 'Pink' }, { hex: '#FFA0C8', name: 'Rose' }],
  ];
  const SIDE_LABELS = ['Left side', 'Right side'];
  const REACTION_EMOJIS = ['😂', '🔥', '🎉', '😱', '😭', '😡'];
  const REACTION_MAX = 30;

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    match: document.getElementById('view-match'),
    final: document.getElementById('view-final'),
  };
  function show(name) {
    if (window.screenChange) window.screenChange(Object.keys(views).find(function (k) { return views[k].classList.contains('active'); }), name);
    if (name !== 'final') clearConfetti();
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('active', k === name); });
  }

  const qrSlot = document.getElementById('qrSlot');
  const joinUrlEl = document.getElementById('joinUrl');
  const playerCountEl = document.getElementById('playerCount');
  const playerCapEl = document.getElementById('playerCap');
  const targetSeg = document.getElementById('targetSeg');
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
  const serveTag = document.getElementById('serveTag');
  const matchPointTag = document.getElementById('matchPointTag');
  const pauseBtn = document.getElementById('pauseBtn');
  const pauseOverlay = document.getElementById('pauseOverlay');

  const finalTrophy = document.getElementById('finalTrophy');
  const finalHeading = document.getElementById('finalHeading');
  const finalSub = document.getElementById('finalSub');
  const standingsEl = document.getElementById('standings');
  const playAgainBtn = document.getElementById('playAgainBtn');
  const backToLobbyBtn = document.getElementById('backToLobbyBtn');

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const resetBtn = document.getElementById('resetBtn');
  const muteBtn = document.getElementById('muteReactionsBtn');
  const reactionLayer = document.getElementById('reactionLayer');
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
    if (fullscreenBtn) fullscreenBtn.textContent = document.fullscreenElement ? '⛶ Exit' : '⛶ Fullscreen';
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
  // Game start: a bouncy rising arpeggio.
  function playStart() {
    const c = getAudioCtx(); if (!c) return;
    [392, 523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.2, 'triangle', 0.18, c.currentTime + i * 0.08); });
  }
  function playCountBlip(n) { blip(520 + (COUNTDOWN_FROM - Math.min(n, COUNTDOWN_FROM)) * 70, 0.12, 'triangle', 0.2); }
  // Serve — the "look up!" cue as the ball appears over the server.
  function playServe() {
    const c = getAudioCtx(); if (!c) return;
    blip(784, 0.12, 'triangle', 0.2);
    blip(1175, 0.2, 'triangle', 0.18, c.currentTime + 0.1);
  }
  // A squishy "boing", higher for harder hits.
  function playBoing(speed) {
    const k = Math.min(1, (speed || 10) / 26);
    const f = 260 + k * 240;
    sweep(f, f * 1.9, 0.13, 'sine', 0.22);
    blip(f * 0.5, 0.08, 'triangle', 0.1);
  }
  function playTick() { blip(420, 0.05, 'triangle', 0.1); }
  // Goal-post ping — the same sound as Nockey's post. Rapid repeats (a ball
  // skittering on the cap) are throttled so it never rattles.
  let lastPostAt = 0;
  function playPostSfx() {
    const c = getAudioCtx(); if (!c) return;
    if (c.currentTime - lastPostAt < 0.09) return;
    lastPostAt = c.currentTime;
    blip(1200, 0.22, 'triangle', 0.16); blip(1800, 0.16, 'sine', 0.08);
  }
  function playThud(v) { noise(0.22, 320, Math.min(0.3, 0.08 + (v || 10) * 0.01)); sweep(170, 60, 0.18, 'sine', 0.22); }
  function playPlop(v) { noise(0.07, 500, Math.min(0.08, 0.02 + (v || 0) * 0.004)); }
  // Whiffed serve: a light "whoops", nothing like the point fanfare.
  function playMiss() {
    const c = getAudioCtx(); if (!c) return;
    blip(660, 0.12, 'triangle', 0.14);
    blip(494, 0.18, 'triangle', 0.14, c.currentTime + 0.11);
  }
  function playPoint() {
    const c = getAudioCtx(); if (!c) return;
    [523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.16, 'square', 0.1, c.currentTime + 0.05 + i * 0.08); });
  }
  function playApplause() {
    const c = getAudioCtx(); if (!c) return;
    noise(1.6, 1200, 0.11);
    [523, 659, 784, 1047, 1319].forEach(function (f, i) { blip(f, 0.45, 'triangle', 0.16, c.currentTime + i * 0.12); });
  }
  function playSad() {
    const c = getAudioCtx(); if (!c) return;
    [392, 330, 262, 196].forEach(function (f, i) { blip(f, 0.5, 'triangle', 0.18, c.currentTime + i * 0.26); });
  }

  // ---------------- Lobby ----------------
  let lobby = { capacity: 2, total: 0, players: [], pointsToWin: 10, pointOptions: [5, 7, 10, 12, 15], canStart: false };
  let lastLobbyHumanTotal = -1;

  function renderQR() {
    fetch('/api/blobball/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        const url = (cfg && cfg.joinUrl) || (window.location.origin + '/blobball/join');
        joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
        return fetch('/api/blobball/qr?url=' + encodeURIComponent(url));
      })
      .then(function (r) { return r.text(); })
      .then(function (svg) { qrSlot.innerHTML = svg; })
      .catch(function () {});
  }

  function renderLobby(l) {
    if (!l) return;
    // Never rebuild the seats out from under a drag; apply once it settles.
    if (dragActive) { pendingLobby = l; return; }
    lobby = l;
    const players = l.players || [];
    const humanTotal = players.filter(function (p) { return !p.isBot; }).length;
    if (lastLobbyHumanTotal >= 0 && humanTotal > lastLobbyHumanTotal) playJoinDing();
    lastLobbyHumanTotal = humanTotal;

    playerCountEl.textContent = l.total;
    playerCapEl.textContent = l.capacity;

    targetSeg.innerHTML = '';
    (l.pointOptions || []).forEach(function (v) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (v === l.pointsToWin ? ' active' : '');
      b.textContent = String(v);
      b.setAttribute('aria-pressed', v === l.pointsToWin ? 'true' : 'false');
      b.addEventListener('click', function () {
        unlockAudio();
        socket.emit('host:setTarget', { value: v });
      });
      targetSeg.appendChild(b);
    });

    seatList.innerHTML = '';
    const canMove = players.length >= 2;
    const teamSize = l.teamSize || 2;
    for (let i = 0; i < 2 * teamSize; i++) {
      const side = i < teamSize ? 0 : 1;
      const slot = i % teamSize;
      if (i === teamSize) {
        const vs = document.createElement('div');
        vs.className = 'seat-vs';
        vs.textContent = 'VS';
        seatList.appendChild(vs);
      }
      const p = players.find(function (q) { return q.seat === side && q.slot === slot; });
      const row = document.createElement('div');
      row.className = 'seat' + (p ? ' filled' : ' empty') + (p && canMove ? ' draggable' : '') + (p && p.connected === false && !p.isBot ? ' disconnected' : '');
      row.dataset.side = String(side);
      row.dataset.slot = String(slot);
      if (p && canMove) {
        row.dataset.pid = p.id;
        row.title = 'Drag onto another spot to move or swap';
      }
      const grip = document.createElement('div');
      grip.className = 'seat-grip';
      grip.setAttribute('aria-hidden', 'true');
      grip.textContent = '⠿';
      const blob = document.createElement('div');
      blob.className = 'seat-blob';
      const meta = document.createElement('div');
      meta.className = 'seat-meta';
      const sideEl = document.createElement('div');
      sideEl.className = 'seat-side';
      const col = document.createElement('div');
      col.className = 'seat-color';
      meta.appendChild(sideEl);
      meta.appendChild(col);
      const name = document.createElement('div');
      name.className = 'seat-name';
      name.textContent = p ? ((p.isBot ? '🤖 ' : '') + p.name) : 'Open — scan to join';
      row.appendChild(grip);
      row.appendChild(blob);
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
      applySeat(row, side, slot);
      seatList.appendChild(row);
    }

    startBtn.disabled = !l.canStart;
    if (addBotBtn) addBotBtn.disabled = l.total >= l.capacity;
    if (l.canStart && l.teams) configHint.textContent = l.mode + ' teams — drag players to rearrange';
    else if (l.canStart) configHint.textContent = '1v1 — drag to swap sides. 3+ players makes it teams!';
    else if (l.total === 0) configHint.textContent = 'Waiting for players…';
    else configHint.textContent = 'Waiting for an opponent — or add a CPU';
  }

  addBotBtn && addBotBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:addBot', {}, function (res) {
      if (res && !res.ok && res.reason === 'game-full') toast('All four blobs are taken.');
    });
  });
  startBtn && startBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
      if (res && !res.ok) toast('Cannot start yet.');
    });
  });
  // Rematch: same players, sides and target. The server broadcasts m:start,
  // which drops everyone (this screen included) straight into the countdown.
  playAgainBtn && playAgainBtn.addEventListener('click', function () {
    unlockAudio();
    playAgainBtn.disabled = true;
    socket.emit('host:rematch', {}, function (res) {
      playAgainBtn.disabled = false;
      if (!res || !res.ok) toast('Could not start a new game.');
    });
  });
  backToLobbyBtn && backToLobbyBtn.addEventListener('click', function () {
    socket.emit('host:reset', {});
  });

  // Paint a seat tile as its side of the net and its shade.
  function applySeat(row, side, slot) {
    const c = SLOT_COLORS[side][slot] || SLOT_COLORS[side][0];
    row.classList.toggle('left', side === 0);
    row.classList.toggle('right', side === 1);
    row.style.setProperty('--seat', c.hex);
    const sideEl = row.querySelector('.seat-side');
    const col = row.querySelector('.seat-color');
    if (sideEl) sideEl.textContent = SIDE_LABELS[side];
    if (col) col.textContent = c.name + ' blob';
  }

  // ---- Drag a player onto any spot to move there (or swap) ------------------
  // The grabbed tile follows the pointer and the spot under it lights up.
  // Dropping on a player swaps the two; dropping on an open spot moves there.
  // The server re-applies the seating rules and broadcasts the new lobby.
  let dragActive = false;    // a seat is mid-drag; lobby rebuilds wait
  let pendingLobby = null;   // latest snapshot to apply once the drag settles
  let suppressClick = false; // swallow the click that trails a real drag
  (function setupSeatDrag() {
    let d = null;

    function targetAt(x, y) {
      const hit = document.elementFromPoint(x, y);
      const t = hit && hit.closest ? hit.closest('.seat') : null;
      return t && t !== d.el && seatList.contains(t) ? t : null;
    }
    function setTarget(t) {
      if (d.target === t) return;
      if (d.target) d.target.classList.remove('drop-target');
      d.target = t;
      if (t) t.classList.add('drop-target');
    }
    function onMove(e) {
      if (!d) return;
      if (e.cancelable) e.preventDefault();
      const dx = e.clientX - d.downX, dy = e.clientY - d.downY;
      if (!d.active) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return; // a tap, so far
        d.active = true;
        dragActive = true;
        d.el.classList.add('dragging');
        d.el.style.transition = 'none';
        d.el.style.pointerEvents = 'none';
      }
      d.el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.02)';
      setTarget(targetAt(e.clientX, e.clientY));
    }
    function onUp() {
      if (!d) return;
      const cur = d;
      d = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!cur.active) return;
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 400);
      const target = cur.target;
      if (target) target.classList.remove('drop-target');
      dragActive = false;
      const next = pendingLobby;
      pendingLobby = null;
      if (target) {
        // The tile stays where it was dropped until the server's new lobby lands.
        socket.emit('host:move', {
          playerId: cur.el.dataset.pid,
          side: Number(target.dataset.side),
          slot: Number(target.dataset.slot),
        }, function (res) { if (res && !res.ok && !dragActive) renderLobby(lobby); });
        return;
      }
      renderLobby(next || lobby);
    }
    function onDown(e) {
      if (e.button != null && e.button !== 0) return; // primary button only
      if (!e.target || e.target.closest('.seat-kick')) return; // kick isn't a handle
      const el = e.target.closest('.seat.draggable');
      if (!el || d) return;
      d = { el: el, downX: e.clientX, downY: e.clientY, active: false, target: null };
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
  let teams = false;
  let target = 7;
  let scores = {};
  let paused = false;
  let matchState = 'idle'; // idle | count | serve | play | point | over
  let superseded = false;
  let rafId = null;
  let lastFrame = 0;
  let acc = 0;
  let lastSync = 0;
  let deadBounces = 0;

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
  function setRich(el, parts) {
    el.innerHTML = '';
    parts.forEach(function (p) { el.appendChild(typeof p === 'string' ? document.createTextNode(p) : p); });
  }

  // Sides of the net: one blob each in 1v1, up to two in team play. Teammates
  // share a score (kept per player id, mirrored across the team).
  function teamOf(side) { return roster.filter(function (r) { return r.seat === side; }); }
  function sideScore(side) {
    const t = teamOf(side);
    return t.length ? (scores[t[0].id] || 0) : 0;
  }
  function teamColor(side) {
    const t = teamOf(side);
    return t.length ? t[0].color : '#ffffff';
  }
  // "Ann" or "Ann & Bob", each name in its own colour.
  function teamNodes(side) {
    const parts = [];
    teamOf(side).forEach(function (r, i) {
      if (i) parts.push(' & ');
      parts.push(nameSpan(r));
    });
    return parts;
  }
  function verb(side, one, many) { return teamOf(side).length > 1 ? many : one; }

  function updateScoreboard(bumpSide) {
    scoreboard.innerHTML = '';
    [0, 1].forEach(function (i) {
      const team = teamOf(i);
      if (!team.length) return;
      if (i === 1) {
        const g = document.createElement('div');
        g.className = 'sb-goal';
        g.textContent = 'First to ' + target;
        scoreboard.appendChild(g);
      }
      const card = document.createElement('div');
      card.className = 'sb-card' + (i === 1 ? ' right' : '');
      card.style.setProperty('--seat', team[0].color);
      const main = document.createElement('div');
      main.className = 'sb-main';
      const name = document.createElement('div');
      name.className = 'sb-name';
      if (team.length > 1) {
        // One teammate per line, so a long name never breaks across the other.
        team.forEach(function (r, k) {
          const line = document.createElement('div');
          line.appendChild(nameSpan(r));
          if (k < team.length - 1) line.appendChild(document.createTextNode(' &'));
          name.appendChild(line);
        });
      } else setRich(name, teamNodes(i));
      const pips = document.createElement('div');
      pips.className = 'sb-pips';
      const pts = sideScore(i);
      for (let k = 0; k < target; k++) {
        const pip = document.createElement('span');
        pip.className = 'sb-pip' + (k < pts ? ' on' : '');
        pips.appendChild(pip);
      }
      main.appendChild(name);
      main.appendChild(pips);
      const val = document.createElement('div');
      val.className = 'sb-val' + (bumpSide === i ? ' bump' : '');
      val.textContent = String(pts);
      card.appendChild(main);
      card.appendChild(val);
      scoreboard.appendChild(card);
    });
  }

  function startMatch(meta, resumed) {
    roster = (meta && meta.roster) || [];
    teams = !!(meta && meta.teams);
    target = meta.target || 7;
    scores = Object.assign({}, meta.scores || {});

    world = new BB.World({ roster: roster, teams: teams });
    renderer = new window.BlobBallRender.Renderer(canvas, world);
    paused = false;
    clearTimers();
    if (pauseOverlay) pauseOverlay.hidden = true;
    pointBanner.hidden = true;
    serveTag.hidden = true;
    setMatchPoint(false);

    show('match');
    requestAnimationFrame(function () { if (renderer) renderer.resize(); });
    updateScoreboard(null);
    updatePauseBtn();
    world.setupServe(Math.random() < 0.5 ? 0 : 1);
    startLoop();
    if (!resumed) playStart();
    beginCountdown(resumed ? 'RESUMING' : 'GET READY');
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

  // Kick-off / resume countdown. The ball already hangs over the first server.
  function beginCountdown(note) {
    matchState = 'count';
    pointBanner.hidden = true;
    serveTag.hidden = true;
    setMatchPoint(false);
    showOverlay(countOverlay);
    coNote.hidden = !note;
    coNote.textContent = note || '';
    updatePauseBtn();
    let n = COUNTDOWN_FROM;
    const tick = function () {
      coNum.textContent = n > 0 ? String(n) : 'GO!';
      coNum.style.animation = 'none';
      void coNum.offsetWidth;
      coNum.style.animation = '';
      if (n > 0) playCountBlip(n);
      socket.emit('host:countdown', { n: n, note: note || null });
      if (n <= 0) {
        after(350, function () {
          hideOverlay(countOverlay);
          beginServe(world.serveSeat, true);
        });
        return;
      }
      n--;
      after(COUNTDOWN_STEP_MS, tick);
    };
    tick();
  }

  // Pops in with the serve and stays up for the whole match-point rally.
  function setMatchPoint(on) {
    if (!matchPointTag) return;
    if (on && matchPointTag.hidden) {
      matchPointTag.style.animation = 'none';
      void matchPointTag.offsetWidth;
      matchPointTag.style.animation = '';
    }
    matchPointTag.hidden = !on;
  }

  function isMatchPoint() {
    return roster.some(function (r) { return (scores[r.id] || 0) === target - 1; });
  }

  // `again`: the same player serves (kick-off, or a whiffed serve); otherwise
  // the serve passes to the team's next player.
  function beginServe(seat, again) {
    if (!world) return;
    matchState = 'serve';
    world.setupServe(seat, again);
    deadBounces = 0;
    if (renderer) { renderer.clearMoods(); renderer.clearTrail(); }
    pointBanner.hidden = true;
    const server = rosterById(world.server().id);
    if (server) {
      setRich(serveTag, [nameSpan(server), ' serves']);
      serveTag.style.animation = 'none';
      void serveTag.offsetWidth;
      serveTag.style.animation = '';
      serveTag.hidden = false;
    }
    setMatchPoint(isMatchPoint());
    playServe();
    socket.emit('host:serve', { serverId: server ? server.id : null });
    updatePauseBtn();
    after(SERVE_HOLD_MS, beginPlay);
  }

  function beginPlay() {
    if (!world) return;
    matchState = 'play';
    world.release();
    serveTag.hidden = true;
    socket.emit('host:play', {});
    updatePauseBtn();
  }

  function showBanner(text, color, subNodes) {
    pbText.textContent = text;
    pbText.style.color = color || 'var(--accent)';
    setRich(pbSub, subNodes || []);
    pointBanner.hidden = false;
    pbText.style.animation = 'none';
    void pbText.offsetWidth;
    pbText.style.animation = '';
  }

  // The server whiffed the serve completely (nobody touched it): no point —
  // the ball bounces briefly and the same player serves again, as often as it
  // takes.
  function onMissedServe(res) {
    matchState = 'point';
    updatePauseBtn();
    const server = rosterById(world.server().id);
    // REDO! takes the match-point bubble's spot; it comes back with the re-serve.
    setMatchPoint(false);
    showBanner('REDO!', '#ffffff', server ? [nameSpan(server), ' serves again'] : []);
    playMiss();
    socket.emit('host:miss', { serverId: server ? server.id : null });
    after(MISS_MS, function () {
      pointBanner.hidden = true;
      beginServe(res.serverSeat, true);
    });
  }

  // The ball landed. It plays on (dead) while the blobs stand still, then the
  // side that lost the point serves.
  function onPoint(res) {
    matchState = 'point';
    updatePauseBtn();
    const side = res.scorerSeat;
    const team = teamOf(side);
    if (!team.length) return;
    const pts = sideScore(side) + 1;
    team.forEach(function (r) { scores[r.id] = pts; });
    const won = pts >= target;
    const color = teamColor(side);
    if (renderer) {
      renderer.setMood(side, 'happy');
      renderer.setMood(res.loserSeat, 'sad');
      renderer.celebrate(side, color);
    }
    setMatchPoint(false);
    showBanner(won ? 'GAME!' : 'POINT!', color,
      teamNodes(side).concat([won ? verb(side, ' wins it!', ' win it!') : verb(side, ' scores', ' score')]));
    updateScoreboard(side);
    playPoint();

    socket.emit('host:point', { scorerId: team[0].id, scores: scores });

    after(POINT_MS + (won ? WIN_EXTRA_MS : 0), function () {
      pointBanner.hidden = true;
      if (won) { endMatch(team[0].id, false); return; }
      beginServe(teamOf(res.loserSeat).length ? res.loserSeat : 0, false);
    });
  }

  function endMatch(winnerId, quiet) {
    matchState = 'over';
    stopLoop();
    clearTimers();
    hideOverlay(countOverlay, true);
    pointBanner.hidden = true;
    serveTag.hidden = true;
    setMatchPoint(false);
    if (pauseOverlay) pauseOverlay.hidden = true;
    paused = false;
    updatePauseBtn();
    if (!quiet) socket.emit('host:matchEnd', { winnerId: winnerId, scores: scores });
    renderFinal(winnerId, quiet);
  }

  function renderFinal(winnerId, quiet) {
    const winner = rosterById(winnerId);
    const winSide = winner ? winner.seat : -1;
    finalTrophy.textContent = winner ? '🏆' : '🏁';
    finalHeading.innerHTML = '';
    if (winner) setRich(finalHeading, teamNodes(winSide).concat([verb(winSide, ' wins!', ' win!')]));
    else finalHeading.textContent = 'Game over';
    finalSub.textContent = teamOf(0).length && teamOf(1).length ? ('Final score ' + sideScore(0) + ' – ' + sideScore(1)) : '';

    standingsEl.innerHTML = '';
    [0, 1].filter(function (side) { return teamOf(side).length; }).sort(function (x, y) {
      if (x === winSide) return -1;
      if (y === winSide) return 1;
      return sideScore(y) - sideScore(x);
    }).forEach(function (side, i) {
      const li = document.createElement('li');
      li.className = 'st-row' + (i === 0 ? ' first' : '');
      li.style.setProperty('--seat', teamColor(side));
      const rank = document.createElement('div');
      rank.className = 'st-rank';
      rank.textContent = side === winSide ? 'Winner' : (winner ? 'Runner-up' : '');
      const name = document.createElement('div');
      name.className = 'st-name';
      setRich(name, teamNodes(side));
      const val = document.createElement('div');
      val.className = 'st-val';
      const pts = sideScore(side);
      val.textContent = pts + (pts === 1 ? ' pt' : ' pts');
      li.appendChild(rank);
      li.appendChild(name);
      li.appendChild(val);
      standingsEl.appendChild(li);
    });

    show('final');
    if (quiet) return;
    const humanLost = winner && teamOf(winSide).every(function (r) { return r.isBot; }) && roster.some(function (r) { return !r.isBot; });
    if (winner && !humanLost) { playApplause(); confetti(teamColor(winSide)); }
    else playSad();
  }

  let confettiEls = [];
  function confetti(color) {
    const colors = [color || '#FFC857', '#5BE06B', '#FF5C8D', '#FFC857', '#38C9FF', '#ffffff'];
    for (let i = 0; i < 80; i++) {
      const el = document.createElement('div');
      el.className = 'confetti-piece';
      el.style.left = Math.random() * 100 + 'vw';
      el.style.background = colors[i % colors.length];
      el.style.animationDelay = (Math.random() * 0.9) + 's';
      el.style.animationDuration = (2.4 + Math.random() * 1.6) + 's';
      document.body.appendChild(el);
      confettiEls.push(el);
      setTimeout(function () { el.remove(); }, 5000);
    }
  }
  function clearConfetti() {
    confettiEls.forEach(function (el) { el.remove(); });
    confettiEls = [];
  }

  // ---------------- Pause ----------------
  let resumeTimer = null;   // running resume 3-2-1, if any
  function updatePauseBtn() {
    if (!pauseBtn) return;
    pauseBtn.hidden = matchState === 'idle' || matchState === 'over';
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
  // Resuming into live play runs a 3-2-1 first. The game stays paused the whole
  // time, so the countdown never counts as play time. Pressing Pause again
  // cancels it; resuming anywhere else (countdown, serve, between points) is
  // instant.
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
      socket.emit('host:sync', { scores: scores, live: matchState === 'play' && !paused, paused: paused });
    }

    if (!paused && world) {
      runTimers(dt * 1000);
      if (world && matchState !== 'over' && matchState !== 'idle') {
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
        if (res && res.missedServe) onMissedServe(res);
        else if (res) onPoint(res);
      }
    }

    if (renderer) renderer.render(paused ? 1 : Math.min(1, acc / FIXED_DT), paused ? 0 : dt);
  }

  function drainEvents() {
    if (!world) return;
    const evs = world.events;
    let ticks = 0;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (renderer) renderer.handleEvent(e);
      if (e.t === 'hit') { if (!e.cont) playBoing(e.speed); }
      else if ((e.t === 'wall' || e.t === 'ceil') && ticks < 2) { playTick(); ticks++; }
      else if (e.t === 'net') playPostSfx();
      else if (e.t === 'ground') {
        if (e.point) playThud(e.v);
        else if (deadBounces++ < 4) playPlop(e.v);
      }
    }
    evs.length = 0;
  }

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

  // ---------------- Socket ----------------
  socket.on('in', function (d) {
    if (!world || !d) return;
    world.setInput(d.id, d.c, d.d);
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
      reactionsMuted = !!res.reactionsMuted;
      updateMuteBtn();
      // A dropped-and-restored socket must never restart a match this screen is
      // already simulating — just carry on, the heartbeat re-syncs the players.
      if (authedOnce && matchState !== 'idle') return;
      authedOnce = true;
      renderLobby(res.lobby);
      if (res.phase === 'PLAYING' && res.match) {
        startMatch(res.match, true);
      } else if (res.phase === 'FINAL' && res.match) {
        roster = res.match.roster || [];
        teams = !!res.match.teams;
        target = res.match.target;
        scores = Object.assign({}, res.match.scores || {});
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
    matchState = 'idle';
    paused = false;
    lastLobbyHumanTotal = -1;
    pointBanner.hidden = true;
    serveTag.hidden = true;
    setMatchPoint(false);
    hideOverlay(countOverlay, true);
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    show('lobby');
  });

  window.addEventListener('resize', function () { if (renderer) renderer.resize(); });

  renderQR();
}());
