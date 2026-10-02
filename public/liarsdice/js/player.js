(function () {
  'use strict';

  // ============================================================
  // Liar's Dice — phone controller.
  //
  // The phone holds the one thing the host screen must never see: this
  // player's dice. They arrive only via `you:state` (unicast) or the
  // `player:reconnect` ack, re-sent after every state change so the legal
  // bids can never go stale. The server validates every action anyway.
  // ============================================================

  const PID = localStorage.getItem('liarsdice.playerId');
  if (!PID) { window.location.replace('/liarsdice/join'); return; }

  // ---------------- Kill all zoom / scroll / selection behaviour ----------------
  // iOS Safari ignores maximum-scale/user-scalable, and a stray long-press or
  // double-tap would eat the input, so block it explicitly: pinch (iOS gesture
  // events + every touch move), double-tap-to-zoom, and the long-press callout.
  (function lockZoom() {
    const stop = function (e) { e.preventDefault(); };
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    document.addEventListener('gestureend', stop, { passive: false });
    document.addEventListener('touchmove', function (e) {
      // Swallow every move, not just multi-touch: once iOS has started a pinch
      // the follow-up events are no longer cancelable, so the first one has to
      // die too. Opt specific regions back in by selector.
      if (!e.cancelable) return;
      if (e.target && e.target.closest && e.target.closest('.scrollable-region, .result-rows')) return;
      e.preventDefault();
    }, { passive: false });
    let lastTouchEnd = 0;
    document.addEventListener('touchend', function (e) {
      const now = Date.now();
      if (now - lastTouchEnd <= 350) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    document.addEventListener('dblclick', stop, { passive: false });
    document.addEventListener('contextmenu', stop, { passive: false });
    document.addEventListener('selectstart', stop, { passive: false });
    document.addEventListener('dragstart', stop, { passive: false });
    window.addEventListener('scroll', function () { window.scrollTo(0, 0); }, { passive: true });
  }());

  // ---------------- Dice ----------------
  const PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function fillDie(d, face) {
    d.innerHTML = '';
    d.classList.toggle('back', !face);
    if (face) d.dataset.face = face; else delete d.dataset.face;
    for (let i = 0; i < 9; i++) {
      const p = document.createElement('span');
      p.className = 'pip' + (face && PIPS[face].indexOf(i) >= 0 ? ' on' : '');
      d.appendChild(p);
    }
  }
  function makeDie(face, cls) {
    const d = document.createElement('span');
    d.className = 'die' + (cls ? ' ' + cls : '');
    fillDie(d, face);
    return d;
  }
  function matches(d, face) { return d === face || (face !== 1 && d === 1); }
  function bidNode(qty, face) {
    const w = document.createElement('span');
    w.className = 'bid-chip';
    const q = document.createElement('span');
    q.className = 'bid-qty';
    q.textContent = qty;
    const x = document.createElement('span');
    x.className = 'bid-x';
    x.textContent = '×';
    w.appendChild(q); w.appendChild(x); w.appendChild(makeDie(face));
    return w;
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function nameSpan(name, seat) {
    const s = document.createElement('span');
    s.className = 'pname turn-name';
    if (seat) s.dataset.seat = seat;
    s.textContent = name;
    return s;
  }

  // ---------------- DOM ----------------
  const el = function (id) { return document.getElementById(id); };
  const views = {
    wait: el('pv-wait'),
    round: el('pv-round'),
    out: el('pv-out'),
    result: el('pv-result'),
  };
  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('active', k === name); });
    // The attribution footer belongs to the lobby only — the waiting view is
    // reused for "Rolling…" once the game is under way.
    if (attribution) attribution.hidden = !(name === 'wait' && publicPhase === 'LOBBY');
    if (name !== 'round') document.body.classList.remove('my-turn');
    updateEmoteState();
    if (name === 'round') fitTray();
  }

  const pSeat = el('pSeat');
  const pName = el('pName');
  const pScore = el('pScore');
  const waitTitle = el('waitTitle');
  const waitSub = el('waitSub');
  const waitDice = el('waitDice');

  const mRound = el('mRound');
  const mDice = el('mDice');
  const roundBanner = el('roundBanner');
  const roundHint = el('roundHint');
  const bidStrip = el('bidStrip');
  const trayArea = el('trayArea');
  const diceTray = el('diceTray');
  const bidBuilder = el('bidBuilder');
  const faceRow = el('faceRow');
  const qtyMinus = el('qtyMinus');
  const qtyPlus = el('qtyPlus');
  const qtyValue = el('qtyValue');
  const bidBtn = el('bidBtn');
  const noRaise = el('noRaise');
  const callRow = el('callRow');
  const bsBtn = el('bsBtn');
  const spotBtn = el('spotBtn');

  const outEmoji = el('outEmoji');
  const outTitle = el('outTitle');
  const outSub = el('outSub');

  const resultEmoji = el('resultEmoji');
  const resultTitle = el('resultTitle');
  const resultSub = el('resultSub');
  const resultRows = el('resultRows');

  const connOverlay = el('pConnOverlay');
  const toastEl = el('pToast');
  const emoteToggle = el('emoteToggle');
  const emotePanel = el('emotePanel');
  const emoteGrid = el('emoteGrid');
  const attribution = el('playerAttribution');

  [6, 3, 1, 5, 2].forEach(function (f) { waitDice.appendChild(makeDie(f)); });

  const faceBtns = {};
  for (let f = 1; f <= 6; f++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'face-btn';
    b.dataset.face = f;
    b.setAttribute('aria-label', f === 1 ? '1s (wild)' : f + 's');
    b.appendChild(makeDie(f));
    faceRow.appendChild(b);
    faceBtns[f] = b;
  }

  const TOAST_FADE_MS = 280;
  let toastTimer = null;
  let toastFadeTimer = null;
  function toast(msg) {
    if (toastTimer) clearTimeout(toastTimer);
    if (toastFadeTimer) clearTimeout(toastFadeTimer);
    toastEl.classList.remove('leaving');
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.style.animation = 'none';
    void toastEl.offsetWidth;
    toastEl.style.animation = '';
    toastTimer = setTimeout(function () {
      toastTimer = null;
      toastEl.classList.add('leaving');
      toastFadeTimer = setTimeout(function () {
        toastFadeTimer = null;
        toastEl.hidden = true;
        toastEl.classList.remove('leaving');
      }, TOAST_FADE_MS);
    }, 2400);
  }

  function buzz(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (_) {} }
  }

  /**
   * Bind to pointerdown, not click: the double-tap-zoom guard swallows a quick
   * second click, which would eat a real tap.
   */
  function onTap(node, fn) {
    node.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      fn(e);
    });
  }

  // ---------------- Sound (best effort: needs a tap on this page first) ----------------
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
    return audioCtx;
  }
  document.addEventListener('pointerdown', function () {
    const c = getAudioCtx(); if (c && c.state === 'suspended') c.resume();
  });
  function playRattle(ms) {
    const c = audioCtx;
    if (!c || c.state !== 'running') return;
    const b = c.currentTime;
    const n = Math.floor(ms / 60);
    for (let i = 0; i < n; i++) {
      const t = b + i * 0.06 + Math.random() * 0.025;
      const frames = Math.floor(c.sampleRate * 0.03);
      const buf = c.createBuffer(1, frames, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let k = 0; k < frames; k++) data[k] = Math.random() * 2 - 1;
      const src = c.createBufferSource();
      src.buffer = buf;
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(2200 + Math.random() * 2400, t);
      const g = c.createGain();
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start(t); src.stop(t + 0.03);
    }
  }
  function playLand() {
    const c = audioCtx;
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220 + Math.random() * 60, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + 0.1);
  }

  // ---------------- State ----------------
  let myName = localStorage.getItem('liarsdice.playerName') || '';
  let mySeat = null;
  let me = null;             // latest `you:state`
  let publicPhase = 'LOBBY';
  let hostPresent = true;
  let reactionsMutedByHost = false;
  let sending = false;
  let clockOffset = 0;
  let covered = false;
  let rolledRound = 0;       // the round whose roll has played (or been skipped on a reconnect)
  let rolling = false;
  let sel = { face: null, qty: null };
  let decisionKey = '';
  let armed = null;          // 'bs' | 'spot' while waiting for the confirming second tap
  let armTimer = null;
  const ARM_TIMEOUT_MS = 3000; // an unconfirmed first tap quietly undoes itself
  let verdictTimer = null;

  pName.textContent = myName;

  function serverNow() { return Date.now() + clockOffset; }
  function syncClock(s) { if (s && typeof s.serverNow === 'number') clockOffset = s.serverNow - Date.now(); }

  // ---------------- Rendering ----------------
  function renderTop() {
    if (mySeat) { pSeat.textContent = mySeat; pSeat.dataset.seat = mySeat; }
    pName.textContent = myName;
    pScore.textContent = '';
    if (me && publicPhase !== 'LOBBY' && !me.busted) {
      pScore.textContent = '🎲 ' + me.diceCount;
      pScore.setAttribute('aria-label', me.diceCount + ' dice');
    } else if (me && me.busted && me.place) {
      pScore.textContent = ordinal(me.place);
    }
  }

  function renderWait(title, sub) {
    waitTitle.textContent = title;
    waitSub.textContent = sub;
    show('wait');
  }

  // ---- Dice tray ----
  let trayKey = '';
  /** The player's own dice, as big as the tray allows; matches light up during a reveal. */
  function renderTray() {
    if (rolling) return;
    const rv = me.reveal;
    const face = rv ? rv.bid.face : null;
    const key = [me.round, (me.dice || []).join(','), covered, face].join('|');
    if (key === trayKey) return;
    trayKey = key;
    diceTray.innerHTML = '';
    (me.dice || []).forEach(function (d) {
      const cls = face && !covered ? (matches(d, face) ? 'match' : 'miss') : '';
      diceTray.appendChild(makeDie(covered ? 0 : d, cls));
    });
    diceTray.classList.toggle('covered', covered);
    fitTray();
  }

  /** One or two rows, whichever lets the dice be biggest. */
  function fitTray() {
    const n = diceTray.children.length;
    if (!n) return;
    const pad = 8;   // the tray's own padding (border-box)
    const w = trayArea.clientWidth - 24 - pad;
    const h = trayArea.clientHeight - 16 - pad;
    if (w <= 0 || h <= 0) return;
    const gap = 12;
    const one = Math.min((w - gap * (n - 1)) / n, h);
    const cols = Math.ceil(n / 2);
    const two = n > 1 ? Math.min((w - gap * (cols - 1)) / cols, (h - gap) / 2) : 0;
    const size = Math.floor(Math.max(24, Math.min(112, Math.max(one, two))));
    diceTray.style.setProperty('--die', size + 'px');
    diceTray.style.maxWidth = (pad + (two > one ? cols * size + (cols - 1) * gap : n * size + (n - 1) * gap)) + 'px';
  }
  window.addEventListener('resize', fitTray);
  if (typeof ResizeObserver === 'function') new ResizeObserver(fitTray).observe(trayArea);

  onTap(diceTray, function () {
    if (!me || !diceTray.firstElementChild) return;
    covered = !covered;
    buzz(8);
    if (rolling) { diceTray.classList.toggle('covered', covered); return; }
    trayKey = '';
    renderTray();
  });

  // ---- The roll ----
  const TUMBLE_MS = 1450;
  const LAND_STEP_MS = 140;
  /** Every die tumbles together, flicking through faces, then lands one by one on its real roll. */
  function playRoll() {
    rolling = true;
    trayKey = '';
    const dice = (me.dice || []).slice();
    diceTray.innerHTML = '';
    diceTray.classList.toggle('covered', covered);
    const els = dice.map(function () {
      const d = makeDie(covered ? 0 : 1 + Math.floor(Math.random() * 6), 'tumbling');
      d.style.animationDelay = (-Math.random() * 0.4) + 's';
      diceTray.appendChild(d);
      return d;
    });
    fitTray();
    playRattle(TUMBLE_MS);
    if (navigator.vibrate) { try { navigator.vibrate([30, 50, 30, 50, 30, 50, 30, 50, 40]); } catch (_) {} }
    const flicker = setInterval(function () {
      els.forEach(function (d) { if (d.classList.contains('tumbling') && !covered) fillDie(d, 1 + Math.floor(Math.random() * 6)); });
    }, 90);
    setTimeout(function () {
      els.forEach(function (d, i) {
        setTimeout(function () {
          d.classList.remove('tumbling');
          d.classList.add('landed');
          fillDie(d, covered ? 0 : dice[i]);
          playLand();
          buzz(12);
          if (i === els.length - 1) {
            clearInterval(flicker);
            setTimeout(function () { rolling = false; route(); }, 260);
          }
        }, i * LAND_STEP_MS);
      });
      if (!els.length) { clearInterval(flicker); rolling = false; route(); }
    }, TUMBLE_MS);
  }

  // ---- Bid strip: the bid to beat ----
  function renderBidStrip() {
    bidStrip.innerHTML = '';
    const b = me.reveal ? me.reveal.bid : me.currentBid;
    if (!b) {
      bidStrip.classList.add('empty');
      bidStrip.appendChild(document.createTextNode(publicPhase === 'ROLL' ? 'New round' : 'No bid yet'));
      return;
    }
    bidStrip.classList.remove('empty');
    const lbl = document.createElement('span');
    lbl.className = 'bs-label';
    lbl.textContent = me.reveal ? 'Called on' : 'Current bid';
    const by = document.createElement('span');
    by.className = 'bs-by';
    by.appendChild(document.createTextNode('by '));
    by.appendChild(nameSpan(b.playerId === PID ? 'you' : b.name, b.seat));
    bidStrip.appendChild(lbl);
    bidStrip.appendChild(bidNode(b.qty, b.face));
    bidStrip.appendChild(by);
  }

  function setBanner(parts, cls) {
    roundBanner.className = 'p-banner' + (cls ? ' ' + cls : '');
    roundBanner.innerHTML = '';
    parts.forEach(function (p) { roundBanner.appendChild(typeof p === 'string' ? document.createTextNode(p) : p); });
  }

  // ---- Bid builder ----
  function legalFace(f) { return me.legal && me.legal[f] != null; }

  function defaultSelection() {
    const prefer = [];
    if (me.currentBid) prefer.push(me.currentBid.face);
    // Otherwise lead with the face this player holds most of.
    const counts = {};
    for (let f = 2; f <= 6; f++) counts[f] = (me.dice || []).filter(function (d) { return matches(d, f); }).length;
    [2, 3, 4, 5, 6].sort(function (a, b) { return counts[b] - counts[a] || b - a; }).forEach(function (f) { prefer.push(f); });
    prefer.push(1);
    const f = prefer.find(legalFace);
    return f ? { face: f, qty: me.legal[f] } : { face: null, qty: null };
  }

  function clampQty(q) {
    if (!sel.face || !legalFace(sel.face)) return null;
    return Math.max(me.legal[sel.face], Math.min(me.totalDice, q));
  }

  function renderBuilder() {
    bidBuilder.hidden = false;
    noRaise.hidden = me.canBid;
    faceRow.hidden = !me.canBid;
    bidBuilder.querySelector('.qty-row').hidden = !me.canBid;
    if (!me.canBid) return;
    for (let f = 1; f <= 6; f++) {
      const ok = legalFace(f);
      faceBtns[f].disabled = !ok;
      faceBtns[f].classList.toggle('on', ok && sel.face === f);
    }
    sel.qty = clampQty(sel.qty);
    qtyValue.textContent = sel.qty;
    qtyMinus.disabled = sel.qty <= me.legal[sel.face];
    qtyPlus.disabled = sel.qty >= me.totalDice;
    bidBtn.innerHTML = '';
    bidBtn.appendChild(document.createTextNode('Bid '));
    bidBtn.appendChild(bidNode(sel.qty, sel.face));
  }

  function renderCalls() {
    callRow.hidden = !me.canCall;
    if (!me.canCall) return;
    bsBtn.classList.toggle('armed', armed === 'bs');
    spotBtn.classList.toggle('armed', armed === 'spot');
    bsBtn.textContent = armed === 'bs' ? 'Tap again to call BS' : 'Call BS';
    spotBtn.textContent = armed === 'spot' ? 'Tap again: Spot On' : 'Spot On';
  }

  function arm(kind) {
    armed = kind;
    if (armTimer) clearTimeout(armTimer);
    armTimer = setTimeout(function () { armTimer = null; disarm(); }, ARM_TIMEOUT_MS);
    buzz(15);
    renderCalls();
  }
  function disarm() {
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    if (!armed) return;
    armed = null;
    if (me) renderCalls();
  }

  onTap(faceRow, function (e) {
    const b = e.target.closest('.face-btn');
    if (!b || !me || !me.yourTurn) return;
    const f = Number(b.dataset.face);
    if (!legalFace(f)) return;
    disarm();
    buzz(8);
    sel.face = f;
    sel.qty = me.legal[f];
    renderBuilder();
  });
  onTap(qtyMinus, function () { if (!me || !me.yourTurn) return; disarm(); buzz(8); sel.qty = clampQty(sel.qty - 1); renderBuilder(); });
  onTap(qtyPlus, function () { if (!me || !me.yourTurn) return; disarm(); buzz(8); sel.qty = clampQty(sel.qty + 1); renderBuilder(); });
  onTap(bidBtn, function () {
    if (!me || !me.yourTurn || !sel.face || !sel.qty) return;
    disarm();
    send({ type: 'bid', qty: sel.qty, face: sel.face });
  });
  onTap(bsBtn, function () {
    if (!me || !me.canCall) return;
    if (armed !== 'bs') { arm('bs'); return; }
    disarm();
    send({ type: 'bs' });
  });
  onTap(spotBtn, function () {
    if (!me || !me.canCall) return;
    if (armed !== 'spot') { arm('spot'); return; }
    disarm();
    send({ type: 'spot' });
  });

  // ---- Sending actions ----
  function send(payload) {
    if (sending) return;
    sending = true;
    socket.emit('player:action', payload, function (res) {
      sending = false;
      if (!res || !res.ok) {
        toast(actionError(res));
        buzz(60);
        // The server re-sends `you:state` on a rejection, which re-renders us.
        return;
      }
      buzz(25);
    });
  }
  function actionError(res) {
    const reason = res && res.reason;
    return {
      'not-your-turn': "It's not your turn yet.",
      'not-yet': 'Hold on — the last bid is still on the big screen.',
      'too-low': 'Bid higher' + (res && res.min ? ' — at least ' + res.min : '') + '.',
      'too-high': 'There aren\'t that many dice on the table.',
      'no-legal-bid': 'No bid on that face is high enough.',
      'no-bid': 'There is no bid to call yet.',
      'not-bidding': 'The round has already moved on.',
    }[reason] || 'Could not do that.';
  }

  // ---- The round view ----
  function renderReveal() {
    const rv = me.reveal;
    const caller = rv.callerId === PID ? 'You' : null;
    const callWord = rv.type === 'bs' ? ' called BS!' : ' called Spot On!';
    const now = serverNow();
    if (verdictTimer) { clearTimeout(verdictTimer); verdictTimer = null; }
    if (now < rv.verdictAt) {
      setBanner([caller || nameSpan(rv.callerName, rv.callerSeat), callWord], 'calling');
      verdictTimer = setTimeout(function () { verdictTimer = null; if (me && me.reveal) renderRound(); }, rv.verdictAt - now + 30);
      return;
    }
    const there = 'There ' + (rv.count === 1 ? 'was ' : 'were ') + rv.count + '.';
    roundHint.textContent = there;
    if (rv.knockedOut) { setBanner(['You\'re out of dice!'], 'lost'); buzzOnce('ko' + rv.verdictAt, [80, 60, 160]); return; }
    if (rv.myDelta < 0) { setBanner(['You lose a die'], 'lost'); buzzOnce('l' + rv.verdictAt, [70, 50, 70]); return; }
    if (rv.myDelta > 0) { setBanner(['Spot on! You win a die back'], 'won'); buzzOnce('w' + rv.verdictAt, [30, 40, 30, 40, 90]); return; }
    if (rv.gainerId === PID) { setBanner(['Spot on!'], 'won'); return; }
    if (rv.loserId) setBanner([nameSpan(rv.loserName, rv.loserSeat), ' loses a die'], '');
    else setBanner([nameSpan(rv.gainerName, null), ' was spot on'], '');
  }
  let lastBuzzKey = '';
  function buzzOnce(key, pattern) {
    if (key === lastBuzzKey) return;
    lastBuzzKey = key;
    buzz(pattern);
  }

  function renderRound() {
    mRound.textContent = me.round;
    mDice.textContent = me.totalDice;
    renderBidStrip();

    const yourTurn = !!me.yourTurn;
    document.body.classList.toggle('my-turn', yourTurn);
    const key = [me.round, me.currentBid ? me.currentBid.qty + 'x' + me.currentBid.face : '-', yourTurn].join(':');
    if (key !== decisionKey) {
      decisionKey = key;
      armed = null;
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
      sel = yourTurn ? defaultSelection() : { face: null, qty: null };
      if (yourTurn) buzz([40, 60, 40]);
    }

    bidBuilder.hidden = true;
    callRow.hidden = true;
    roundHint.textContent = '';

    if (publicPhase === 'ROLL' || rolling) {
      setBanner(['Rolling…'], '');
      if (me.openerName) {
        roundHint.textContent = '';
        roundHint.appendChild(me.openerSeat === mySeat ? document.createTextNode('You open the bidding') : nameSpan(me.openerName, me.openerSeat));
        if (me.openerSeat !== mySeat) roundHint.appendChild(document.createTextNode(' opens the bidding'));
      }
    } else if (me.reveal) {
      renderReveal();
    } else if (yourTurn) {
      setBanner(['Your turn!'], 'your-turn');
      renderBuilder();
      renderCalls();
    } else if (me.upNext) {
      // The last bid is still up on the big screen; the server unlocks the turn once it's gone.
      setBanner(["You're up next…"], '');
    } else if (me.turnName) {
      setBanner(['Waiting for ', nameSpan(me.turnName, me.turnSeat), '…'], '');
    } else {
      setBanner(['…'], '');
    }
    renderTray();
    show('round');
  }

  // ---- Out / final ----
  function renderOut() {
    outEmoji.textContent = '🏴‍☠️';
    outTitle.textContent = me.place ? "You're out in " + ordinal(me.place) : "You're out";
    outSub.textContent = 'Nice game! Keep an eye on the table.';
    show('out');
  }

  function renderFinal(s) {
    const mine = (s.standings || []).find(function (r) { return r.playerId === PID; });
    const won = s.winnerId === PID;
    resultEmoji.textContent = won ? '🏆' : '🏴‍☠️';
    resultSub.textContent = '';
    if (won) {
      resultTitle.textContent = 'You win!';
      resultSub.textContent = 'Last pirate with dice after ' + s.rounds + (s.rounds === 1 ? ' round.' : ' rounds.');
    } else {
      resultTitle.textContent = mine ? 'You finished ' + ordinal(mine.place) : 'Game over';
      if (s.winnerName) {
        const champ = (s.standings || []).find(function (r) { return r.playerId === s.winnerId; });
        resultSub.appendChild(nameSpan(s.winnerName, champ && champ.seat));
        resultSub.appendChild(document.createTextNode(' wins the game.'));
      }
    }
    resultRows.innerHTML = '';
    (s.standings || []).forEach(function (r) {
      const row = document.createElement('div');
      row.className = 'result-row' + (r.playerId === PID ? ' is-me' : '');
      row.dataset.seat = r.seat;
      const place = document.createElement('span');
      place.className = 'rr-seat'; place.textContent = ordinal(r.place);
      const n = document.createElement('span');
      n.className = 'rr-name pname'; n.textContent = r.name;
      const sc = document.createElement('span');
      sc.className = 'rr-score';
      sc.textContent = r.playerId === s.winnerId ? 'Winner' : 'Round ' + r.outRound;
      row.appendChild(place); row.appendChild(n); row.appendChild(sc);
      resultRows.appendChild(row);
    });
    document.body.classList.remove('my-turn');
    show('result');
    if (won) buzz([40, 60, 40, 60, 120]);
  }

  /** Pick the right screen from the private state plus the public phase. */
  function route() {
    renderTop();
    if (publicPhase === 'LOBBY') { renderWait("You're in!", 'Waiting for the host to start…'); return; }
    if (publicPhase === 'FINAL') return;             // renderFinal owns the view
    if (!me) { renderWait('Rolling…', 'Your dice are on the way.'); return; }
    if (me.busted) { renderOut(); return; }
    renderRound();
  }

  /** A fresh round's dice: tumble them, unless this phone is just catching up (reconnect). */
  function adopt(s, fromReconnect) {
    syncClock(s);
    me = s;
    if (s.seat) mySeat = s.seat;
    publicPhase = s.phase;
    if (s.phase === 'ROLL' && s.round !== rolledRound && !s.busted) {
      rolledRound = s.round;
      if (!fromReconnect) {
        show('round');
        renderRound();
        playRoll();
        return;
      }
    } else if (s.round > rolledRound) {
      rolledRound = s.round;
    }
    if (publicPhase === 'FINAL') { renderTop(); return; }
    route();
  }

  // ---------------- Socket ----------------
  const socket = io('/liarsdice', { transports: ['polling', 'websocket'] });

  function goRejoin() {
    localStorage.removeItem('liarsdice.playerId');
    if (myName) localStorage.setItem('liarsdice.rejoinName', myName);
    window.location.replace('/liarsdice/join');
  }

  socket.on('connect', function () {
    sending = false;
    socket.emit('player:reconnect', { playerId: PID }, function (res) {
      if (!res || !res.ok) { goRejoin(); return; }
      connOverlay.hidden = true;
      myName = res.player.name;
      mySeat = res.player.seat;
      hostPresent = res.hostPresent !== false;
      reactionsMutedByHost = !!res.reactionsMuted;
      localStorage.setItem('liarsdice.playerName', myName);
      publicPhase = res.phase;
      if (res.final) { me = res.me || null; renderTop(); renderFinal(res.final); return; }
      if (res.me) { adopt(res.me, true); return; }
      me = null;
      route();
    });
  });

  socket.on('disconnect', function () { connOverlay.hidden = false; });

  // The one event that carries this player's dice — always unicast, never broadcast.
  socket.on('you:state', function (s) {
    if (!s) return;
    adopt(s, false);
  });

  socket.on('state:lobby', function (l) {
    me = null;
    rolledRound = 0;
    trayKey = '';
    // The host can drag players into new seats in the lobby.
    const mine = l && l.players && l.players.filter(function (p) { return p.id === PID; })[0];
    if (mine && mine.seat) mySeat = mine.seat;
    publicPhase = 'LOBBY';
    route();
  });
  socket.on('state:table', function (s) { publicPhase = s.phase; updateEmoteState(); });
  socket.on('state:final', function (s) {
    publicPhase = 'FINAL';
    renderTop();
    renderFinal(s);
  });

  socket.on('state:reset', function () { goRejoin(); });
  socket.on('player:rejected', function () { goRejoin(); });

  socket.on('state:hostPresence', function (p) {
    hostPresent = !!(p && p.present);
    updateEmoteState();
  });
  socket.on('state:reactionsMuted', function (p) {
    reactionsMutedByHost = !!(p && p.muted);
    updateEmoteState();
  });

  // ---------------- Emotes ----------------
  // Must mirror ALLOWED_EMOTES in server/liarsdice/index.js.
  const EMOTES = ['😀', '😂', '😎', '😭', '😡', '👍', '🔥', '💪', '🎉', '😱'];
  // On the table it's a seat bubble; lobby and final float it. The server's ack has the final word.
  const EMOTE_BUBBLE_COOLDOWN_MS = 2500;
  const EMOTE_FLOAT_COOLDOWN_MS = 10 * 1000;
  let emoteUntil = 0;
  let emoteKind = null;     // the kind the running cooldown belongs to
  let emoteCoolTimer = null;

  EMOTES.forEach(function (e) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emote-btn';
    b.textContent = e;
    b.dataset.emote = e;
    emoteGrid.appendChild(b);
  });

  function emotesAllowed() {
    if (!hostPresent || reactionsMutedByHost) return false;
    return !(me && me.busted);
  }
  function setEmotePanel(open) {
    emotePanel.hidden = !open;
    emoteToggle.classList.toggle('open', open);
    emoteToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function emoteKindNow() {
    return publicPhase === 'LOBBY' || publicPhase === 'FINAL' ? 'float' : 'bubble';
  }
  // Mirrors the server: a cooldown only holds within the kind that set it.
  function emoteCooling() {
    return Date.now() < emoteUntil && emoteKind === emoteKindNow();
  }
  function updateEmoteState() {
    const ok = emotesAllowed();
    emoteToggle.hidden = !ok;
    if (!ok) setEmotePanel(false);
    emoteToggle.classList.toggle('cooling', emoteCooling());
  }
  function coolFor(ms, kind) {
    emoteUntil = Date.now() + ms;
    emoteKind = kind;
    if (emoteCoolTimer) clearTimeout(emoteCoolTimer);
    emoteCoolTimer = setTimeout(updateEmoteState, ms);
    updateEmoteState();
  }

  onTap(emoteToggle, function () {
    if (!emotesAllowed() || emoteCooling()) return;
    buzz(8);
    setEmotePanel(emotePanel.hidden);
  });

  onTap(emoteGrid, function (e) {
    const b = e.target.closest('.emote-btn');
    if (!b || !emotesAllowed()) return;
    setEmotePanel(false);
    const kind = emoteKindNow();
    coolFor(kind === 'float' ? EMOTE_FLOAT_COOLDOWN_MS : EMOTE_BUBBLE_COOLDOWN_MS, kind);
    buzz(15);
    socket.emit('player:emote', { e: b.dataset.emote }, function (res) {
      if (res && res.ok && res.cooldownMs) coolFor(res.cooldownMs, res.kind);
      else if (res && res.reason === 'cooldown' && res.retryInMs) coolFor(res.retryInMs, kind);
    });
  });

  // A tap anywhere outside the panel closes it; a tap off the call buttons cancels an armed call.
  document.addEventListener('pointerdown', function (e) {
    if (armed && !e.target.closest('#bsBtn, #spotBtn')) disarm();
    if (emotePanel.hidden) return;
    if (e.target.closest('#emotePanel, #emoteToggle')) return;
    setEmotePanel(false);
  });

  updateEmoteState();
})();
