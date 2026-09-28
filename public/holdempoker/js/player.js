(function () {
  'use strict';

  // ============================================================
  // Hold'em Poker — phone controller.
  //
  // The phone holds the one thing the host screen must never see: this
  // player's two hole cards. They arrive only via `you:state` (unicast) or the
  // `player:reconnect` ack, re-sent after every state change so the legal
  // actions can never go stale. The server validates every action anyway.
  // ============================================================

  const PID = localStorage.getItem('holdempoker.playerId');
  if (!PID) { window.location.replace('/holdempoker/join'); return; }

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

  // ---------------- Card assets ----------------
  function cardSrc(code) {
    const rank = code.slice(0, code.length - 1);
    const ext = (rank === 'J' || rank === 'Q' || rank === 'K') ? '.webp' : '.svg';
    return '/holdempoker/assets/cards/' + code + ext;
  }
  const SUIT_WORD = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };
  function cardLabel(code) { return code.slice(0, code.length - 1) + ' of ' + SUIT_WORD[code.slice(-1)]; }

  function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ---------------- DOM ----------------
  const el = function (id) { return document.getElementById(id); };
  const views = {
    wait: el('pv-wait'),
    hand: el('pv-hand'),
    out: el('pv-out'),
    result: el('pv-result'),
  };
  let currentView = 'wait';
  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('active', k === name); });
    // The attribution footer belongs to the lobby only — the waiting view is
    // reused for "Dealing…" once the game is under way.
    if (attribution) attribution.hidden = !(name === 'wait' && publicPhase === 'LOBBY');
    if (name !== 'hand') document.body.classList.remove('my-turn');
    currentView = name;
    updateEmoteState();
  }

  const pSeat = el('pSeat');
  const pName = el('pName');
  const pScore = el('pScore');
  const waitTitle = el('waitTitle');
  const waitSub = el('waitSub');

  const mBlinds = el('mBlinds');
  const mPot = el('mPot');
  const handBanner = el('handBanner');
  const handHint = el('handHint');
  const holeCards = el('holeCards');
  const actRow = el('actRow');
  const foldBtn = el('foldBtn');
  const callBtn = el('callBtn');
  const raiseBtn = el('raiseBtn');
  const raisePanel = el('raisePanel');
  const raisePresets = el('raisePresets');
  const raiseMinus = el('raiseMinus');
  const raisePlus = el('raisePlus');
  const raiseValue = el('raiseValue');
  const betSlider = el('betSlider');
  const bsFill = el('bsFill');
  const bsThumb = el('bsThumb');
  const raiseCancel = el('raiseCancel');
  const raiseConfirm = el('raiseConfirm');
  const preRow = el('preRow');
  const showBtn = el('showBtn');

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

  // ---------------- State ----------------
  let myName = localStorage.getItem('holdempoker.playerName') || '';
  let mySeat = null;
  let me = null;             // latest `you:state`
  let publicPhase = 'LOBBY';
  let lastHandEnd = null;
  let hostPresent = true;
  let reactionsMutedByHost = false;
  let raiseOpen = false;
  let raiseTo = 0;
  let decisionKey = '';
  let sending = false;

  pName.textContent = myName;

  // ---------------- Rendering ----------------
  function renderTop() {
    if (mySeat) { pSeat.textContent = mySeat; pSeat.dataset.seat = mySeat; }
    pName.textContent = myName;
    if (me && publicPhase !== 'LOBBY' && !me.busted) pScore.textContent = fmt(me.stack) + ' chips';
    else if (me && me.busted && me.place) pScore.textContent = ordinal(me.place);
    else pScore.textContent = '';
  }

  function renderWait(title, sub) {
    waitTitle.textContent = title;
    waitSub.textContent = sub;
    show('wait');
  }

  let holeKey = '';
  let cardsCovered = false;
  function renderHole() {
    const key = (me.hole || []).join(',');
    if (key !== holeKey) {
      holeKey = key;
      holeCards.innerHTML = '';
      (me.hole || []).forEach(function (code) {
        const wrap = document.createElement('div');
        wrap.className = 'hole-card';
        const inner = document.createElement('div');
        inner.className = 'hc-inner';
        const img = document.createElement('img');
        img.className = 'card';
        img.src = cardSrc(code);
        img.alt = cardLabel(code);
        img.draggable = false;
        const back = document.createElement('div');
        back.className = 'card card-back';
        inner.appendChild(img);
        inner.appendChild(back);
        wrap.appendChild(inner);
        holeCards.appendChild(wrap);
      });
    }
    holeCards.classList.toggle('folded', !!me.folded);
    holeCards.classList.toggle('covered', cardsCovered);
    fitHole();
  }

  /** Two cards as big as the area allows, measured like Hearts' fitFan(). */
  function fitHole() {
    const area = holeCards.parentElement;
    const acs = getComputedStyle(area);
    const gap = parseFloat(getComputedStyle(holeCards).columnGap) || 0;
    const availW = area.clientWidth - parseFloat(acs.paddingLeft) - parseFloat(acs.paddingRight);
    const availH = area.clientHeight - parseFloat(acs.paddingTop) - parseFloat(acs.paddingBottom);
    if (availW <= 0 || availH <= 0) return;
    // A little headroom for the cards' tilt so their corners aren't clipped.
    const cardW = Math.floor(Math.min(190, (availW - gap - 16) / 2, (availH - 12) / 1.4));
    if (cardW > 0) holeCards.style.setProperty('--card-w', cardW + 'px');
  }
  window.addEventListener('resize', fitHole);
  // The hand view is often built while hidden; re-fit once the area has a size.
  if (typeof ResizeObserver === 'function') new ResizeObserver(fitHole).observe(holeCards.parentElement);

  onTap(holeCards, function () {
    if (!holeCards.firstElementChild) return;
    cardsCovered = !cardsCovered;
    holeCards.classList.toggle('covered', cardsCovered);
    buzz(8);
  });

  function turnBanner() {
    handBanner.textContent = '';
    if (!me.turnName) {
      if (publicPhase === 'DEAL') handBanner.textContent = 'Dealing…';
      else handBanner.textContent = me.street === 'river' ? 'Showdown…' : 'Next card coming…';
      return;
    }
    const who = document.createElement('span');
    who.className = 'pname turn-name';
    if (me.turnSeat) who.dataset.seat = me.turnSeat;
    who.textContent = me.turnName;
    handBanner.appendChild(document.createTextNode('Waiting for '));
    handBanner.appendChild(who);
    handBanner.appendChild(document.createTextNode('…'));
  }

  function myShown() {
    if (!lastHandEnd || !lastHandEnd.result) return null;
    return (lastHandEnd.result.shown || []).find(function (x) { return x.playerId === PID; }) || null;
  }

  function renderHand() {
    mBlinds.textContent = fmt(me.smallBlind) + ' / ' + fmt(me.bigBlind);
    mPot.textContent = fmt(me.pot);
    renderHole();

    const handEnd = publicPhase === 'HAND_END';
    // A pre-action already answers this turn; the server plays it a beat later, so never offer choices.
    const autoActing = !!me.yourTurn && !!me.preAction;
    const yourTurn = !!me.yourTurn && !autoActing;
    document.body.classList.toggle('my-turn', yourTurn);

    // A change in what's being decided closes a half-set raise.
    const key = [me.handNumber, me.street, me.currentBet, yourTurn, me.minRaiseTo, me.maxRaiseTo].join(':');
    if (key !== decisionKey) {
      decisionKey = key;
      raiseOpen = false;
      raiseTo = me.minRaiseTo;
    }

    handBanner.classList.remove('your-turn', 'won');
    handHint.textContent = '';
    actRow.hidden = true;
    raisePanel.hidden = true;
    preRow.hidden = true;
    showBtn.hidden = true;

    if (handEnd) {
      if (me.won > 0) {
        handBanner.textContent = 'You won ' + fmt(me.collected) + '!';
        handBanner.classList.add('won');
      } else {
        handBanner.textContent = 'Hand over';
      }
      const mine = myShown();
      if (mine && mine.handName) handHint.textContent = mine.handName;
      else if (me.folded) handHint.textContent = 'You folded this hand.';
      showBtn.hidden = !me.canShow;
    } else if (autoActing) {
      if (me.toCall === 0) handBanner.textContent = 'Checking…';
      else if (me.preAction === 'callAny') handBanner.textContent = 'Calling ' + fmt(me.callAmount) + '…';
      else handBanner.textContent = 'Folding…';
    } else if (yourTurn) {
      handBanner.textContent = 'Your turn!';
      handBanner.classList.add('your-turn');
      if (me.toCall === 0) handHint.textContent = me.canRaise ? 'Check or bet' : 'Check';
      if (raiseOpen) renderRaisePanel();
      else renderActRow();
    } else if (me.folded) {
      handBanner.textContent = 'You folded';
      handHint.textContent = 'Sit tight until the next hand.';
    } else if (me.allIn) {
      handBanner.textContent = "You're all-in!";
      handHint.textContent = publicPhase === 'RUNOUT' ? 'Running out the board…' : 'Good luck!';
    } else {
      turnBanner();
      if (publicPhase === 'BETTING' || publicPhase === 'DEAL') renderPreRow();
    }
    show('hand');
  }

  function renderActRow() {
    actRow.hidden = false;
    foldBtn.hidden = !!me.canCheck;
    const allInCall = !me.canCheck && me.callAmount >= me.stack;
    if (me.canCheck) callBtn.textContent = 'Check';
    else callBtn.textContent = (allInCall ? 'Call all-in ' : 'Call ') + fmt(me.callAmount);

    raiseBtn.hidden = !me.canRaise;
    const onlyAllIn = me.canRaise && me.minRaiseTo >= me.maxRaiseTo;
    if (onlyAllIn) raiseBtn.textContent = 'All-in ' + fmt(me.maxRaiseTo);
    else raiseBtn.textContent = me.currentBet === 0 ? 'Bet' : 'Raise';
  }

  function renderPreRow() {
    preRow.hidden = false;
    Array.prototype.forEach.call(preRow.querySelectorAll('.pre-btn'), function (b) {
      b.classList.toggle('on', b.dataset.pre === me.preAction);
    });
  }

  // ---- Raise panel ----
  // ½ Pot / Pot are straight fractions of the pot shown on screen (bets included).
  function presetValue(kind) {
    if (kind === 'min') return me.minRaiseTo;
    if (kind === 'max') return me.maxRaiseTo;
    if (kind === 'half') return Math.round(me.pot / 2);
    return me.pot;
  }
  function clampRaise(v) {
    return Math.max(me.minRaiseTo, Math.min(me.maxRaiseTo, Math.round(v)));
  }

  function renderRaisePanel() {
    raisePanel.hidden = false;
    raiseTo = clampRaise(raiseTo || me.minRaiseTo);
    const isAllIn = raiseTo >= me.maxRaiseTo;
    raiseValue.textContent = fmt(raiseTo);

    Array.prototype.forEach.call(raisePresets.querySelectorAll('.preset-btn'), function (b) {
      const kind = b.dataset.preset;
      const v = presetValue(kind);
      // ½ Pot / Pot only earn a button when they land strictly inside the range.
      b.hidden = (kind === 'half' || kind === 'pot') && (v <= me.minRaiseTo || v >= me.maxRaiseTo);
      b.classList.toggle('on', clampRaise(v) === raiseTo);
    });

    const span = me.maxRaiseTo - me.minRaiseTo;
    const t = span > 0 ? (raiseTo - me.minRaiseTo) / span : 1;
    bsFill.style.width = (t * 100) + '%';
    bsThumb.style.left = (t * 100) + '%';
    betSlider.setAttribute('aria-valuenow', String(raiseTo));

    const verb = me.currentBet === 0 ? 'Bet ' : 'Raise to ';
    raiseConfirm.textContent = isAllIn ? 'All-in ' + fmt(raiseTo) : verb + fmt(raiseTo);
  }

  function setRaise(v) {
    raiseTo = clampRaise(v);
    renderRaisePanel();
  }

  onTap(raisePresets, function (e) {
    const b = e.target.closest('.preset-btn');
    if (!b || !me) return;
    buzz(10);
    setRaise(presetValue(b.dataset.preset));
  });
  onTap(raiseMinus, function () { if (me) { buzz(8); setRaise(raiseTo - me.bigBlind); } });
  onTap(raisePlus, function () { if (me) { buzz(8); setRaise(raiseTo + me.bigBlind); } });
  onTap(raiseCancel, function () { raiseOpen = false; renderHand(); });

  (function setupSlider() {
    let dragging = false;
    // A thumb's width of "magnet" so the ends and the ½ Pot / Pot marks are easy to land on.
    const SNAP_PX = 15;
    function valueAt(clientX) {
      const r = betSlider.getBoundingClientRect();
      const x = Math.max(0, Math.min(r.width, clientX - r.left));
      const span = me.maxRaiseTo - me.minRaiseTo;
      if (span <= 0) return me.maxRaiseTo;
      const posOf = function (v) { return (v - me.minRaiseTo) / span * r.width; };
      const marks = [me.minRaiseTo, me.maxRaiseTo].concat(['half', 'pot'].map(presetValue)
        .filter(function (v) { return v > me.minRaiseTo && v < me.maxRaiseTo; }));
      let snap = null;
      let best = SNAP_PX + 1;
      marks.forEach(function (v) {
        const d = Math.abs(posOf(v) - x);
        if (d < best) { best = d; snap = v; }
      });
      if (snap !== null) return snap;
      const step = me.smallBlind || 1;
      return Math.round((me.minRaiseTo + span * (x / r.width)) / step) * step;
    }
    // Moves are tracked on window, so a thumb that slides off the bar (past the end) still counts.
    function move(e) { if (dragging && me) setRaise(valueAt(e.clientX)); }
    function end() {
      dragging = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    }
    betSlider.addEventListener('pointerdown', function (e) {
      if (!me || !me.yourTurn) return;
      e.preventDefault();
      dragging = true;
      try { betSlider.setPointerCapture(e.pointerId); } catch (_) {}
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      setRaise(valueAt(e.clientX));
    });
  }());

  // ---- Sending actions ----
  function send(type, amount) {
    if (sending) return;
    sending = true;
    raiseOpen = false;
    socket.emit('player:action', { type: type, amount: amount }, function (res) {
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
      'can-check': 'You can check for free.',
      'must-call': 'You need to call or fold.',
      'cannot-raise': "You can't raise right now.",
      'too-little': 'That raise is too small' + (res && res.min ? ' — minimum ' + fmt(res.min) : '') + '.',
      'too-much': "You don't have that many chips.",
      'not-betting': 'The betting has already moved on.',
    }[reason] || 'Could not do that.';
  }

  onTap(foldBtn, function () {
    if (!me || !me.yourTurn || me.canCheck) return;
    send('fold');
  });

  onTap(callBtn, function () {
    if (!me || !me.yourTurn) return;
    send(me.canCheck ? 'check' : 'call');
  });

  onTap(raiseBtn, function () {
    if (!me || !me.yourTurn || !me.canRaise) return;
    if (me.minRaiseTo >= me.maxRaiseTo) { send('raise', me.maxRaiseTo); return; }
    raiseOpen = true;
    raiseTo = me.minRaiseTo;
    buzz(10);
    renderHand();
  });

  onTap(raiseConfirm, function () {
    if (!me || !me.yourTurn || !me.canRaise) return;
    send('raise', raiseTo);
  });

  onTap(preRow, function (e) {
    const b = e.target.closest('.pre-btn');
    if (!b || !me) return;
    const type = me.preAction === b.dataset.pre ? null : b.dataset.pre;
    buzz(10);
    // Optimistic, then the server's `you:state` confirms or corrects it.
    me.preAction = type;
    renderPreRow();
    socket.emit('player:preAction', { type: type }, function (res) {
      if (res && !res.ok && res.reason === 'your-turn') toast("It's your turn — pick an action.");
    });
  });

  onTap(showBtn, function () {
    showBtn.hidden = true;
    socket.emit('player:showCards', {}, function (res) {
      if (!res || !res.ok) showBtn.hidden = !(me && me.canShow);
      else buzz(20);
    });
  });

  // ---- Out / final ----
  function renderOut() {
    outEmoji.textContent = '🫡';
    outTitle.textContent = me.place ? "You're out in " + ordinal(me.place) : "You're out";
    outSub.textContent = 'Nice game! Keep an eye on the table.';
    show('out');
  }

  function renderFinal(s) {
    const mine = (s.standings || []).find(function (r) { return r.playerId === PID; });
    const won = s.winnerId === PID;
    resultEmoji.textContent = won ? '🏆' : '🫡';
    if (won) {
      resultTitle.textContent = 'You win the tournament!';
      resultSub.textContent = 'Last player standing after ' + s.handsPlayed + ' hands.';
    } else {
      resultTitle.textContent = mine ? 'You finished ' + ordinal(mine.place) : 'Game over';
      resultSub.textContent = '';
      if (s.winnerName) {
        const champ = (s.standings || []).find(function (r) { return r.playerId === s.winnerId; });
        const who = document.createElement('span');
        who.className = 'pname turn-name';
        if (champ) who.dataset.seat = champ.seat;
        who.textContent = s.winnerName;
        resultSub.appendChild(who);
        resultSub.appendChild(document.createTextNode(' won the tournament.'));
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
      sc.textContent = r.playerId === s.winnerId ? 'Winner' : 'Hand ' + r.bustHand;
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
    if (publicPhase === 'LOBBY') { renderWait("You're in!", 'Waiting for the host to deal…'); return; }
    if (publicPhase === 'FINAL') return;             // renderFinal owns the view
    if (!me) { renderWait('Dealing…', 'Your cards are on the way.'); return; }
    if (me.busted) { renderOut(); return; }
    renderHand();
  }

  // ---------------- Socket ----------------
  const socket = io('/holdempoker', { transports: ['polling', 'websocket'] });

  function goRejoin() {
    localStorage.removeItem('holdempoker.playerId');
    if (myName) localStorage.setItem('holdempoker.rejoinName', myName);
    window.location.replace('/holdempoker/join');
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
      localStorage.setItem('holdempoker.playerName', myName);
      publicPhase = res.phase;
      me = res.me || null;
      if (res.handEnd) lastHandEnd = res.handEnd;
      if (res.final) { renderTop(); renderFinal(res.final); return; }
      route();
    });
  });

  socket.on('disconnect', function () { connOverlay.hidden = false; });

  // The one event that carries hole cards — always unicast, never broadcast.
  socket.on('you:state', function (s) {
    if (!s) return;
    me = s;
    if (s.seat) mySeat = s.seat;
    publicPhase = s.phase;
    if (publicPhase === 'FINAL') { renderTop(); return; }
    route();
  });

  socket.on('state:lobby', function (l) {
    me = null;
    lastHandEnd = null;
    // The host can drag players into new seats in the lobby.
    const mine = l && l.players && l.players.filter(function (p) { return p.id === PID; })[0];
    if (mine && mine.seat) mySeat = mine.seat;
    publicPhase = 'LOBBY';
    route();
  });
  socket.on('state:table', function (s) { publicPhase = s.phase; });
  socket.on('state:handEnd', function (s) { publicPhase = 'HAND_END'; lastHandEnd = s; });
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
  // Soccer Head's set minus the ball. Must mirror ALLOWED_EMOTES in server/holdempoker/index.js.
  const EMOTES = ['😀', '😂', '😎', '😭', '😡', '👍', '🔥', '💪', '🎉', '😱'];
  const EMOTE_COOLDOWN_MS = 2500;
  let emoteUntil = 0;
  let emoteCoolTimer = null;

  EMOTES.forEach(function (e) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emote-btn';
    b.textContent = e;
    b.dataset.emote = e;
    emoteGrid.appendChild(b);
  });

  // Anyone still in the tournament may emote, live hand or not; busted players can't.
  function emotesAllowed() {
    if (!hostPresent || reactionsMutedByHost) return false;
    if (publicPhase === 'FINAL') return false;
    return !(me && me.busted);
  }
  function setEmotePanel(open) {
    emotePanel.hidden = !open;
    emoteToggle.classList.toggle('open', open);
    emoteToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function updateEmoteState() {
    const ok = emotesAllowed();
    emoteToggle.hidden = !ok;
    if (!ok) setEmotePanel(false);
    emoteToggle.classList.toggle('cooling', Date.now() < emoteUntil);
  }

  onTap(emoteToggle, function () {
    if (!emotesAllowed() || Date.now() < emoteUntil) return;
    buzz(8);
    setEmotePanel(emotePanel.hidden);
  });

  onTap(emoteGrid, function (e) {
    const b = e.target.closest('.emote-btn');
    if (!b || !emotesAllowed()) return;
    setEmotePanel(false);
    emoteUntil = Date.now() + EMOTE_COOLDOWN_MS;
    if (emoteCoolTimer) clearTimeout(emoteCoolTimer);
    emoteCoolTimer = setTimeout(updateEmoteState, EMOTE_COOLDOWN_MS);
    updateEmoteState();
    buzz(15);
    socket.emit('player:emote', { e: b.dataset.emote }, function (res) {
      if (res && !res.ok && res.reason === 'cooldown' && res.retryInMs) {
        emoteUntil = Date.now() + res.retryInMs;
        if (emoteCoolTimer) clearTimeout(emoteCoolTimer);
        emoteCoolTimer = setTimeout(updateEmoteState, res.retryInMs);
        updateEmoteState();
      }
    });
  });

  // A tap anywhere outside the panel closes it.
  document.addEventListener('pointerdown', function (e) {
    if (emotePanel.hidden) return;
    if (e.target.closest('#emotePanel, #emoteToggle')) return;
    setEmotePanel(false);
  });

  updateEmoteState();
})();
