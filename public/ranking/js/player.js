/* ===== Ranking · Player ===== */
(function () {
  'use strict';

  var playerId = localStorage.getItem('ranking.playerId');
  if (!playerId) { window.location.replace('/ranking/join'); return; }

  var socket = io('/ranking', { transports: ['polling', 'websocket'] });
  var rejected = false;

  var elName = document.getElementById('playerName');
  var elScore = document.getElementById('playerScore');
  var elView = document.getElementById('playerView');
  var reactionBar = document.getElementById('reactionBar');
  var attribution = document.getElementById('playerAttribution');

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function render(html) { elView.innerHTML = '<div class="state-card">' + html + '</div>'; }
  function tryVibrate(p) { if (navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} } }

  var clockOffset = 0;
  function serverNow() { return Date.now() + clockOffset; }
  function syncClock(p) { if (p && typeof p.serverNow === 'number') clockOffset = p.serverNow - Date.now(); }

  // ---- Session state ----
  var cachedName = '—';
  var hostPresent = true;
  var lobbyTotal = 0;
  var myRole = null;          // 'ranker-active' | 'ranker-quiet' | 'submitter' | 'watch'
  var lastRankItems = null;   // { round, items } for the ranker
  var lastDiscuss = null;     // last DISCUSS payload (for re-renders)
  var mySecret = null;        // ranker's locked order (ids) during discuss
  var watchSortable = null;   // read-only mirror for non-ranker/non-submitter
  var rankSortable = null;
  var discussSortable = null;

  function setName(name) { elName.textContent = name; }
  function updateCoop(group, game) {
    if (typeof group !== 'number' || typeof game !== 'number') { elScore.innerHTML = ''; return; }
    elScore.innerHTML = '<span class="g">🤝 ' + group + '</span> · <span class="m">🤖 ' + game + '</span>';
  }
  function setAttribution(v) { if (attribution) attribution.hidden = !v; }

  // ---- Reactions gating ----
  var reactionsAllowed = false;
  var reactionsMutedByHost = false;
  function setReactionsAllowed(v) { reactionsAllowed = !!v; updateReactionState(); }
  function updateReactionState() {
    reactionBar.hidden = !(reactionsAllowed && !reactionsMutedByHost && hostPresent);
  }

  // ---- Sortable list (touch + mouse via Pointer Events) ----
  function makeSortable(host, opts) {
    var order = opts.order.slice();
    var editable = !!opts.editable;
    var dragId = null;

    function rowHtml(id, i) {
      var updown = editable
        ? '<div class="rk-updown">'
          + '<button type="button" class="rk-up" data-id="' + id + '"' + (i === 0 ? ' disabled' : '') + '>▲</button>'
          + '<button type="button" class="rk-down" data-id="' + id + '"' + (i === order.length - 1 ? ' disabled' : '') + '>▼</button>'
          + '</div>'
        : '';
      var handle = editable ? '<span class="rk-handle" data-id="' + id + '">⋮⋮</span>' : '';
      var cls = 'rk-row' + (editable ? '' : ' readonly') + (dragId === id ? ' dragging' : '');
      return '<div class="' + cls + '" data-id="' + id + '">'
        + '<span class="rk-rank">' + (i + 1) + '</span>'
        + '<span class="rk-text">' + escapeHtml(opts.map[id]) + '</span>'
        + updown + handle
        + '</div>';
    }
    function paint() { host.innerHTML = order.map(rowHtml).join(''); }
    function emitChange() { if (opts.onChange) opts.onChange(order.slice()); }

    function onMove(e) {
      if (dragId == null) return;
      if (e.cancelable) e.preventDefault();
      var rows = host.querySelectorAll('.rk-row');
      var y = e.clientY != null ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      var target = order.length - 1;
      for (var i = 0; i < rows.length; i++) {
        var rect = rows[i].getBoundingClientRect();
        if (y < rect.top + rect.height / 2) { target = i; break; }
      }
      var cur = order.indexOf(dragId);
      if (cur !== -1 && target !== cur) {
        order.splice(cur, 1);
        order.splice(target, 0, dragId);
        paint();
        emitChange();
      }
    }
    function onUp() {
      if (dragId == null) return;
      dragId = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      paint();
    }
    if (editable) {
      host.addEventListener('pointerdown', function (e) {
        var handle = e.target.closest('.rk-handle');
        if (!handle) return;
        if (e.cancelable) e.preventDefault();
        dragId = parseInt(handle.getAttribute('data-id'), 10);
        paint();
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
      host.addEventListener('click', function (e) {
        var up = e.target.closest('.rk-up');
        var down = e.target.closest('.rk-down');
        if (!up && !down) return;
        var id = parseInt((up || down).getAttribute('data-id'), 10);
        var i = order.indexOf(id);
        if (up && i > 0) { var a = order[i - 1]; order[i - 1] = order[i]; order[i] = a; }
        else if (down && i >= 0 && i < order.length - 1) { var b = order[i + 1]; order[i + 1] = order[i]; order[i] = b; }
        else return;
        paint();
        emitChange();
        tryVibrate(15);
      });
    }
    paint();
    return {
      getOrder: function () { return order.slice(); },
      setOrder: function (o) { if (dragId != null) return; order = o.slice(); paint(); },
    };
  }

  function mapOf(items) { var m = {}; (items || []).forEach(function (it) { m[it.id] = it.text; }); return m; }

  // ---- Views ----
  function renderLobby() {
    myRole = null; watchSortable = null;
    setReactionsAllowed(true);
    updateCoop();
    var label = lobbyTotal === 1 ? 'player' : 'players';
    var countLine = lobbyTotal > 0
      ? '<div class="lobby-player-count"><span class="pulse-dot"></span><span><strong>' + lobbyTotal + '</strong> ' + label + ' in the lobby</span></div>'
      : '';
    render(
      '<div class="lobby-hero" data-lobby-screen="1" aria-hidden="true"><span>🥇</span></div>' +
      '<h2>You\'re in!</h2>' +
      '<p>Look up at the big screen. The game will start soon.</p>' + countLine
    );
    setAttribution(true);
  }

  // ---- Collect (Custom Words: this player submits their phrases) ----
  var collectCfg = { wordsPerPlayer: 5, maxWordLen: 50 };
  var lastWords = null;
  function renderCollectForm(prefill) {
    myRole = null; watchSortable = null;
    setReactionsAllowed(false);
    setAttribution(false);
    var n = collectCfg.wordsPerPlayer || 5;
    var pre = Array.isArray(prefill) ? prefill : [];
    var inputs = '';
    for (var i = 0; i < n; i++) {
      var v = pre[i] != null ? escapeHtml(pre[i]) : '';
      inputs += '<input class="cw-input" id="cw' + i + '" type="text" maxlength="' + (collectCfg.maxWordLen || 50) + '" ' +
        'value="' + v + '" ' +
        'autocapitalize="sentences" autocorrect="on" spellcheck="false" enterkeyhint="next" ' +
        'placeholder="Word or phrase ' + (i + 1) + '" />';
    }
    elView.innerHTML =
      '<div class="state-card">' +
        '<div class="round-tag">Custom words</div>' +
        '<h2>Write ' + n + ' words or phrases</h2>' +
        '<p class="rk-note">Anything interesting to rank — foods, activities, opinions… They all go into the pool.</p>' +
        '<div class="cw-form">' + inputs + '</div>' +
        '<div class="cw-error" id="cwError" hidden></div>' +
        '<div class="rk-actions"><button class="btn-accent" id="cwSubmit">Submit my words</button></div>' +
      '</div>';
    var cwForm = elView.querySelector('.cw-form');
    if (cwForm) cwForm.addEventListener('input', function (e) {
      if (e.target && e.target.classList) e.target.classList.remove('cw-dupe');
      var errEl = document.getElementById('cwError'); if (errEl) errEl.hidden = true;
    });
    document.getElementById('cwSubmit').addEventListener('click', submitWords);
  }
  // Tier-A normalization (mirrors the server) for the instant own-duplicate check.
  function normalizeWord(w) {
    var s = String(w == null ? '' : w).toLowerCase();
    s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^(the|a|an)\s+/, '');
    return s;
  }
  function clearDupeFields(indexes, msg) {
    var err = document.getElementById('cwError');
    (indexes || []).forEach(function (i) {
      var el = document.getElementById('cw' + i);
      if (el) { el.value = ''; el.classList.add('cw-dupe'); }
    });
    if (indexes && indexes.length) {
      var f = document.getElementById('cw' + indexes[0]);
      if (f) { try { f.focus(); } catch (e) {} }
    }
    if (err) { err.textContent = msg; err.hidden = false; }
  }
  var DUP_MSG = 'Duplicate cleared — please pick another and resubmit.';
  var TAKEN_MSG = 'Someone already used one of your words — it was cleared. Please pick another and resubmit.';
  function submitWords() {
    var n = collectCfg.wordsPerPlayer || 5;
    var vals = [];
    for (var i = 0; i < n; i++) {
      var el = document.getElementById('cw' + i);
      vals.push(el ? el.value.trim() : '');
    }
    var err = document.getElementById('cwError');
    if (vals.some(function (v) { return !v; })) {
      if (err) { err.textContent = 'Please fill in all ' + n + ' before submitting.'; err.hidden = false; }
      return;
    }
    // Instant own-duplicate check: keep the first, clear the later repeats.
    var norm = vals.map(normalizeWord);
    var seen = {}; var ownDup = [];
    for (var j = 0; j < norm.length; j++) {
      if (Object.prototype.hasOwnProperty.call(seen, norm[j])) ownDup.push(j);
      else seen[norm[j]] = true;
    }
    if (ownDup.length) { clearDupeFields(ownDup, DUP_MSG); return; }

    var btn = document.getElementById('cwSubmit');
    if (btn) btn.disabled = true;
    socket.emit('player:words', { words: vals }, function (res) {
      if (res && res.ok) { lastWords = (res.words || vals).slice(); renderCollectWaiting(); return; }
      if (btn) btn.disabled = false;
      var reason = res && res.reason;
      if (reason === 'duplicate-taken') clearDupeFields(res.dupIndexes, TAKEN_MSG);
      else if (reason === 'duplicate-own') clearDupeFields(res.dupIndexes, DUP_MSG);
      else if (err) { err.textContent = 'Could not submit — please try again.'; err.hidden = false; }
    });
  }
  function renderCollectWaiting() {
    myRole = null;
    setReactionsAllowed(false);
    setAttribution(true);
    elView.innerHTML =
      '<div class="state-card">' +
        '<div class="lobby-hero" aria-hidden="true"><span>✍️</span></div>' +
        '<h2>Words submitted!</h2>' +
        '<p>Waiting for everyone else. You can still change your words until the game starts.</p>' +
        '<div class="rk-actions"><button class="btn-edit" id="cwEdit">Edit my words</button></div>' +
      '</div>';
    var editBtn = document.getElementById('cwEdit');
    if (editBtn) editBtn.addEventListener('click', function () {
      editBtn.disabled = true;
      socket.emit('player:editWords', {}, function (res) {
        if (res && res.ok) { renderCollectForm(res.words || lastWords); return; }
        editBtn.disabled = false;
      });
    });
  }
  function renderCollect(personal) {
    if (personal) collectCfg = { wordsPerPlayer: personal.wordsPerPlayer || 5, maxWordLen: personal.maxWordLen || 50 };
    if (personal && personal.words) lastWords = personal.words.slice();
    if (personal && personal.submitted) renderCollectWaiting();
    else renderCollectForm(personal ? personal.words : lastWords);
  }

  var introTimer = null;
  function stopIntroTimer() { if (introTimer) { clearInterval(introTimer); introTimer = null; } }
  function renderIntro(p) {
    myRole = null;
    setReactionsAllowed(false);
    setAttribution(false);
    stopIntroTimer();
    syncClock(p);
    var endsAt = (p && p.endsAt) || (serverNow() + 4000);
    elView.innerHTML =
      '<div class="state-card intro-card">' +
        '<div class="intro-hint">Get ready…</div>' +
        '<h2 class="intro-title">Ranking!</h2>' +
        '<div class="intro-countdown" id="pIntro">5</div>' +
        '<p>First round coming up.</p>' +
      '</div>';
    var el = document.getElementById('pIntro');
    function tick() {
      var left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      if (el) el.textContent = left <= 0 ? 'Go!' : String(left);
      if (left <= 0) stopIntroTimer();
    }
    tick();
    introTimer = setInterval(tick, 200);
  }

  // Ranker's turn to secretly rank.
  function showRankerRankUI(data) {
    myRole = 'ranker-active';
    lastRankItems = data;
    setReactionsAllowed(false);
    setAttribution(false);
    var items = data.items || [];
    var map = mapOf(items);
    var order = items.map(function (it) { return it.id; });
    elView.innerHTML =
      '<div class="state-card">' +
        '<div class="round-tag">Round ' + data.round + ' of ' + data.totalRounds + '</div>' +
        '<span class="role-pill ranker">You\'re the Ranker</span>' +
        '<h2>Rank these 1 → 5</h2>' +
        '<p class="rk-note">Order them however you like — the group will try to read your mind. Drag ⋮⋮ or tap ▲▼.</p>' +
        '<div class="rk-list" id="rkList"></div>' +
        '<div class="rk-actions"><button class="btn-primary" id="rankSubmit">Lock in my ranking</button></div>' +
      '</div>';
    var rankBtn = document.getElementById('rankSubmit');
    var rankArmed = false;
    function disarmRank() {
      if (!rankArmed) return;
      rankArmed = false;
      rankBtn.textContent = 'Lock in my ranking';
      rankBtn.classList.remove('btn-accent');
    }
    // Reordering cancels a pending confirm, so it's always a clean two-tap:
    // tap to arm ("Tap again to lock it in"), tap again to lock in. No timeout,
    // so taking your time reviewing the order never costs an extra press.
    rankSortable = makeSortable(document.getElementById('rkList'), {
      map: map, order: order, editable: true, onChange: disarmRank,
    });
    rankBtn.addEventListener('click', function () {
      if (!rankArmed) {
        rankArmed = true;
        rankBtn.textContent = 'Tap again to lock it in';
        rankBtn.classList.add('btn-accent');
        return;
      }
      rankBtn.disabled = true;
      socket.emit('player:rank', { order: rankSortable.getOrder() }, function (res) {
        if (!res || !res.ok) { rankBtn.disabled = false; disarmRank(); }
      });
    });
  }

  function renderRank(p) {
    updateCoop(p.groupScore, p.gameScore);
    if (p.rankerId === playerId) {
      if (lastRankItems && lastRankItems.round === p.round) { showRankerRankUI(lastRankItems); return; }
      myRole = 'ranker-active';
      setReactionsAllowed(false);
      render('<div class="round-tag">Round ' + p.round + ' of ' + p.totalRounds + '</div>' +
        '<span class="role-pill ranker">You\'re the Ranker</span>' +
        '<h2>Your turn to rank…</h2><p>Loading your 5 things.</p>');
      return;
    }
    myRole = 'watch';
    setReactionsAllowed(false);
    render(
      '<div class="round-tag">Round ' + p.round + ' of ' + p.totalRounds + '</div>' +
      '<h2>🤫 <span class="hl-name">' + escapeHtml(p.rankerName || 'Someone') + '</span> is ranking</h2>' +
      '<p>They\'re secretly ordering 5 things. Get ready to guess their ranking!</p>'
    );
  }

  // Submitter drags the group's consensus.
  function showSubmitterUI(p) {
    myRole = 'submitter';
    setReactionsAllowed(false);
    setAttribution(false);
    var map = mapOf(p.items);
    elView.innerHTML =
      '<div class="state-card">' +
        '<div class="round-tag">Round ' + p.round + ' of ' + p.totalRounds + '</div>' +
        '<span class="role-pill submitter">You\'re the Submitter</span>' +
        '<h2>Set the group\'s order</h2>' +
        '<p class="rk-note">Listen to everyone and drag this into the order you think ' + escapeHtml(p.rankerName || 'the ranker') + ' chose. The big screen updates live.</p>' +
        '<div class="rk-list" id="dsList"></div>' +
        '<div class="rk-actions"><button class="btn-primary" id="submitBtn">Submit the group\'s answer</button></div>' +
      '</div>';
    discussSortable = makeSortable(document.getElementById('dsList'), {
      map: map, order: p.consensusOrder, editable: true,
      onChange: function (order) { socket.emit('player:consensus', { order: order }); },
    });
    var submitArmed = false;
    document.getElementById('submitBtn').addEventListener('click', function () {
      var btn = this;
      // Two-tap guard against an accidental submit (no modal on the player page).
      if (!submitArmed) {
        submitArmed = true;
        btn.textContent = 'Tap again to lock it in';
        btn.classList.add('btn-accent');
        setTimeout(function () {
          if (!submitArmed) return;
          submitArmed = false;
          btn.textContent = 'Submit the group\'s answer';
          btn.classList.remove('btn-accent');
        }, 3000);
        return;
      }
      btn.disabled = true;
      socket.emit('player:submit', { order: discussSortable.getOrder() }, function (res) {
        if (!res || !res.ok) {
          btn.disabled = false; submitArmed = false;
          btn.textContent = 'Submit the group\'s answer';
          btn.classList.remove('btn-accent');
        }
      });
    });
  }

  // Ranker sits back during discussion. Their own order is kept HIDDEN behind a
  // blur (tap to peek, auto-hides) so a nearby player can't accidentally see it.
  function showRankerQuiet(p) {
    myRole = 'ranker-quiet';
    setReactionsAllowed(false);
    setAttribution(false);
    clearSecretPeek();
    var map = mapOf(p.items);
    var hasSecret = mySecret && mySecret.length;
    var secretHtml = hasSecret
      ? '<div class="secret-note">Your ranking — kept hidden</div>' +
        '<div class="rk-secret" id="rkSecret">' +
          '<div class="rk-list" id="secretList"></div>' +
          '<div class="rk-secret-hint"><span>👁️ Tap to peek</span></div>' +
          '<div class="rk-secret-timer"></div>' +
        '</div>' +
        '<p class="rk-note">Only peek if no one can see your screen — it hides itself again automatically.</p>'
      : '<p class="rk-note">The group is trying to guess your order right now.</p>';
    elView.innerHTML =
      '<div class="state-card">' +
        '<div class="round-tag">Round ' + p.round + ' of ' + p.totalRounds + '</div>' +
        '<span class="role-pill ranker">You\'re the Ranker</span>' +
        '<h2>Stay quiet! 🤫</h2>' +
        '<p>No hints, no faces! Let the group figure out your ranking.</p>' +
        secretHtml +
      '</div>';
    if (hasSecret) {
      makeSortable(document.getElementById('secretList'), { map: map, order: mySecret, editable: false });
      setupSecretPeek();
    }
  }

  // Tap-to-reveal for the ranker's secret list (mirrors Empire's secret card).
  var SECRET_PEEK_MS = 4000;
  var secretPeekTimer = null;
  function clearSecretPeek() { if (secretPeekTimer) { clearTimeout(secretPeekTimer); secretPeekTimer = null; } }
  function setupSecretPeek() {
    var card = document.getElementById('rkSecret');
    if (!card) return;
    card.style.setProperty('--secret-reveal-ms', SECRET_PEEK_MS + 'ms');
    card.addEventListener('click', function () {
      if (card.classList.contains('is-revealed')) {
        card.classList.remove('is-revealed');
        clearSecretPeek();
      } else {
        card.classList.add('is-revealed');
        clearSecretPeek();
        secretPeekTimer = setTimeout(function () {
          card.classList.remove('is-revealed');
          secretPeekTimer = null;
        }, SECRET_PEEK_MS);
      }
    });
  }

  // Everyone else watches the live consensus and discusses out loud.
  function showWatchUI(p) {
    myRole = 'watch';
    setReactionsAllowed(false);
    setAttribution(false);
    var map = mapOf(p.items);
    elView.innerHTML =
      '<div class="state-card">' +
        '<div class="round-tag">Round ' + p.round + ' of ' + p.totalRounds + '</div>' +
        '<div class="discuss-live-tag"><span class="live-dot"></span>' + escapeHtml(p.submitterName || 'The submitter') + ' is dragging the order</div>' +
        '<h2>Discuss out loud!</h2>' +
        '<p class="rk-note">Talk it through — what order did ' + escapeHtml(p.rankerName || 'the ranker') + ' pick? Only the submitter can move things.</p>' +
        '<div class="rk-list" id="watchList"></div>' +
      '</div>';
    watchSortable = makeSortable(document.getElementById('watchList'), { map: map, order: p.consensusOrder, editable: false });
  }

  function renderDiscuss(p) {
    lastDiscuss = p;
    updateCoop(p.groupScore, p.gameScore);
    watchSortable = null; discussSortable = null;
    if (p.submitterId === playerId) showSubmitterUI(p);
    else if (p.rankerId === playerId) showRankerQuiet(p);
    else showWatchUI(p);
  }

  function renderReveal(r) {
    myRole = null; watchSortable = null;
    clearSecretPeek();
    setReactionsAllowed(true);
    setAttribution(false);
    updateCoop(r.groupScore, r.gameScore);
    var matches = r.groupPts;
    var head = matches === 5 ? 'Perfect read! 5 / 5 🎯'
      : matches === 0 ? 'No matches this round 😬'
      : 'The group matched ' + matches + ' / 5';
    render(
      '<div class="round-tag">Round ' + r.round + ' of ' + r.totalRounds + '</div>' +
      '<h2><span class="g">' + escapeHtml(head) + '</span></h2>' +
      '<div class="result-points-row">' +
        '<span class="chip group">+' + r.groupPts + ' Group</span>' +
        '<span class="chip game">+' + r.gamePts + ' Game</span>' +
      '</div>' +
      '<p class="result-sub">Look up at the big screen for the full reveal.</p>'
    );
  }

  function renderFinal(f) {
    myRole = null; watchSortable = null;
    clearSecretPeek();
    setReactionsAllowed(true);
    if (f) updateCoop(f.groupScore, f.gameScore);
    var win = f && f.playersWin;
    render(
      '<h2>' + (win ? '🏆 We beat the game!' : '🤖 The game wins this time') + '</h2>' +
      '<div class="result-big"><span class="g">' + (f ? f.groupScore : 0) + '</span> – ' + (f ? f.gameScore : 0) + '</div>' +
      '<p class="result-sub">' + (win ? 'Great minds! Check the big screen.' : 'So close — run it back!') + '</p>'
    );
    setAttribution(true);
  }

  // ---- Host presence ----
  function updateHostPresence(present) {
    var was = hostPresent;
    hostPresent = !!present;
    var ov = document.getElementById('hostAbsentOverlay');
    if (ov) ov.hidden = hostPresent;
    updateReactionState();
    if (was && !hostPresent) {
      stopIntroTimer();
      localStorage.removeItem('ranking.playerId');
      localStorage.removeItem('ranking.playerName');
    } else if (!was && hostPresent) {
      window.location.replace('/ranking/join');
    }
  }
  socket.on('state:hostPresence', function (p) { updateHostPresence(!(p && p.present === false)); });

  // ---- Socket ----
  socket.on('connect', function () {
    if (rejected) return;
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (rejected) return;
      if (!res || !res.ok) {
        localStorage.removeItem('ranking.playerId');
        localStorage.removeItem('ranking.playerName');
        window.location.replace('/ranking/join');
        return;
      }
      cachedName = res.player.name;
      setName(cachedName);
      reactionsMutedByHost = !!res.reactionsMuted;
      hostPresent = res.hostPresent !== false;
      var ov = document.getElementById('hostAbsentOverlay');
      if (ov) ov.hidden = hostPresent;

      if (res.phase === 'LOBBY') { lobbyTotal = res.total || 0; renderLobby(); }
      else if (res.phase === 'COLLECT') { renderCollect(res.collect); }
      else if (res.phase === 'INTRO') renderIntro(res.intro);
      else if (res.phase === 'RANK') {
        if (res.rankItems) showRankerRankUI(res.rankItems);
        else if (res.rank) renderRank(res.rank);
      } else if (res.phase === 'DISCUSS') {
        if (res.rankerSecret) mySecret = res.rankerSecret.rankerOrder;
        if (res.discuss) renderDiscuss(res.discuss);
      } else if (res.phase === 'REVEAL') { if (res.reveal) renderReveal(res.reveal); }
      else if (res.phase === 'FINAL') { if (res.final) renderFinal(res.final); }
      updateReactionState();
    });
  });

  socket.on('state:lobby', function (s) {
    if (typeof s.total === 'number') lobbyTotal = s.total;
    // Only refresh the actual lobby screen — never clobber the collect-waiting
    // screen (which also uses a .lobby-hero) and lose its Edit button.
    if (elView.querySelector('[data-lobby-screen]')) renderLobby();
  });
  socket.on('state:intro', renderIntro);
  socket.on('state:collect', function (s) {
    if (!s) return;
    collectCfg = { wordsPerPlayer: s.wordsPerPlayer || 5, maxWordLen: s.maxWordLen || 50 };
    var me = (s.players || []).find(function (p) { return p.id === playerId; });
    if (me && me.submitted) { renderCollectWaiting(); return; }
    // Don't clobber an in-progress form (guard against a repeat broadcast).
    if (!document.getElementById('cwSubmit')) renderCollectForm();
  });
  socket.on('state:rank', function (p) { lastRankItems = null; lastDiscuss = null; mySecret = null; renderRank(p); });
  socket.on('you:rankItems', function (p) { if (p) showRankerRankUI(p); });
  socket.on('state:discuss', function (p) { if (p) renderDiscuss(p); });
  socket.on('you:rankerSecret', function (s) {
    if (!s) return;
    mySecret = s.rankerOrder;
    // If the quiet view is already showing, re-render it now to reveal the
    // ranker's own locked-in order (the secret arrives just after DISCUSS).
    if (myRole === 'ranker-quiet' && lastDiscuss) showRankerQuiet(lastDiscuss);
  });
  socket.on('state:consensus', function (p) {
    if (!p) return;
    if (myRole === 'watch' && watchSortable) watchSortable.setOrder(p.consensusOrder);
  });
  socket.on('state:reveal', function (r) { if (r) renderReveal(r); });
  socket.on('state:final', function (f) { renderFinal(f); });
  socket.on('state:reset', function () {
    var name = localStorage.getItem('ranking.playerName') || '';
    if (name) localStorage.setItem('ranking.rejoinName', name);
    localStorage.removeItem('ranking.playerId');
    localStorage.removeItem('ranking.playerName');
    window.location.replace('/ranking/join');
  });

  socket.on('player:rejected', function (payload) {
    rejected = true;
    setReactionsAllowed(false);
    var reason = payload && payload.reason;
    var savedName = localStorage.getItem('ranking.playerName') || '';
    if (reason === 'kicked' || reason === 'reset') {
      if (savedName) localStorage.setItem('ranking.rejoinName', savedName);
    }
    localStorage.removeItem('ranking.playerId');
    localStorage.removeItem('ranking.playerName');
    var msg = {
      'kicked': 'You were removed by the host.',
      'reset': 'The host has reset the game.',
    }[reason] || 'Disconnected.';
    reactionBar.hidden = true;
    elView.innerHTML =
      '<div class="state-card">' +
        '<h2>' + msg + '</h2>' +
        '<button class="btn-accent" onclick="window.location.replace(\'/ranking/join\')">Rejoin</button>' +
      '</div>';
  });

  socket.on('state:reactionsMuted', function (p) { reactionsMutedByHost = !!(p && p.muted); updateReactionState(); });

  // ---- Reaction bar ----
  var REACTION_COOLDOWN_MS = 10 * 1000;
  var REACTION_LS_KEY = 'ranking.lastReactionAt';
  var reactionCooldown = document.getElementById('reactionCooldown');
  var reactionUntil = 0, cooldownRaf = null;
  var reactionBtns = Array.prototype.slice.call(reactionBar.querySelectorAll('.reaction-btn'));

  var storedLast = parseInt(localStorage.getItem(REACTION_LS_KEY) || '0', 10);
  if (storedLast && Date.now() - storedLast < REACTION_COOLDOWN_MS) {
    reactionUntil = storedLast + REACTION_COOLDOWN_MS;
    startCooldown();
  }
  function startCooldown() {
    if (cooldownRaf) cancelAnimationFrame(cooldownRaf);
    function tick() {
      var left = reactionUntil - Date.now();
      if (left <= 0) {
        reactionBtns.forEach(function (b) { b.disabled = false; });
        reactionCooldown.hidden = true;
        cooldownRaf = null;
        return;
      }
      reactionBtns.forEach(function (b) { b.disabled = true; });
      reactionCooldown.hidden = false;
      reactionCooldown.textContent = Math.ceil(left / 1000) + 's';
      cooldownRaf = requestAnimationFrame(tick);
    }
    tick();
  }
  reactionBar.addEventListener('click', function (e) {
    var btn = e.target.closest('.reaction-btn');
    if (!btn || btn.disabled) return;
    var idx = parseInt(btn.dataset.reaction, 10);
    if (isNaN(idx)) return;
    var now = Date.now();
    reactionUntil = now + REACTION_COOLDOWN_MS;
    localStorage.setItem(REACTION_LS_KEY, String(now));
    startCooldown();
    socket.emit('player:reaction', { index: idx }, function (res) {
      if (res && !res.ok && res.reason === 'cooldown' && res.retryInMs) {
        reactionUntil = Date.now() + res.retryInMs;
        localStorage.setItem(REACTION_LS_KEY, String(Date.now() + res.retryInMs - REACTION_COOLDOWN_MS));
        startCooldown();
      }
    });
  });
})();
