(function () {
  'use strict';
  const root = '/stackingroyale';
  const role = document.body.dataset.role;
  const storage = {
    get: function (key) { try { return localStorage.getItem('stackingroyale.' + key) || sessionStorage.getItem('stackingroyale.' + key); } catch (_) { try { return sessionStorage.getItem('stackingroyale.' + key); } catch (_) { return null; } } },
    set: function (key, value) { try { localStorage.setItem('stackingroyale.' + key, value); return true; } catch (_) { try { sessionStorage.setItem('stackingroyale.' + key, value); return true; } catch (_) { return false; } } },
    remove: function (key) { try { localStorage.removeItem('stackingroyale.' + key); } catch (_) {} try { sessionStorage.removeItem('stackingroyale.' + key); } catch (_) {} }
  };
  function el(id) { return document.getElementById(id); }
  function icons() { if (window.lucide) window.lucide.createIcons(); }
  function icon(name) { return '<i data-lucide="' + name + '" aria-hidden="true"></i>'; }
  function tool(id, name, label, extra) { return '<button type="button" class="icon-btn" id="' + id + '" title="' + label + '" aria-label="' + label + '" ' + (extra || '') + '>' + icon(name) + '</button>'; }
  function activate(element, handler) {
    element.addEventListener('pointerdown', function (event) { if (event.button !== 0 || element.disabled) return; event.preventDefault(); handler(event); });
    element.addEventListener('click', function (event) { if (event.detail === 0 && !element.disabled) handler(event); });
  }
  function seed() {
    if (window.crypto && window.crypto.getRandomValues) return window.crypto.getRandomValues(new Uint32Array(1))[0];
    return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  }
  function identity() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (letter) { const digit = seed() & 15; return (letter === 'x' ? digit : (digit & 3) | 8).toString(16); });
  }
  function clock(milliseconds) { const seconds = Math.floor(Math.max(0, milliseconds || 0) / 1000); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
  function name(player) { const span = document.createElement('span'); span.className = 'pname'; span.textContent = player ? player.name : 'Player'; span.style.color = player && player.color || '#087765'; return span; }
  function standings(players) { return players.slice().sort(function (first, second) { return (first.placement || 999) - (second.placement || 999) || Number(second.alive) - Number(first.alive) || (second.lines || 0) - (first.lines || 0); }); }
  function winner(container, state) {
    container.replaceChildren();
    const winners = state.players.filter(function (player) { return (state.winnerIds || []).includes(player.id); });
    if (!winners.length) { container.textContent = 'Match complete'; return; }
    winners.slice(0, 2).forEach(function (player, index) { if (index) container.append(' & '); container.append(name(player)); });
    if (winners.length > 2) container.append(' & ' + (winners.length - 2) + ' more');
    container.append(winners.length === 1 ? ' wins!' : ' share the win!');
  }
  function boardMarkup() {
    return '<div class="board-stage"><aside class="board-rail"><span class="rail-label">Hold</span><canvas id="holdCanvas" width="100" height="60" aria-label="Held piece"></canvas><div id="incoming" class="incoming" hidden></div></aside><div class="board-frame"><canvas id="boardCanvas" width="300" height="600" aria-label="Your block board"></canvas><div id="boardOverlay" class="board-overlay" hidden><strong id="overlayTitle"></strong><span id="overlayDetail"></span><button id="resumeBtn" class="primary" hidden>Resume</button></div></div><aside class="board-rail"><span class="rail-label">Next</span><canvas id="nextCanvas" width="100" height="300" aria-label="Next five pieces"></canvas></aside></div>';
  }
  function controllerMarkup() {
    return '<div class="stats"><div><span>Lines</span><strong id="linesStat">0</strong></div><div><span>Level</span><strong id="levelStat">1</strong></div><div><span>Time</span><strong id="timeStat">0:00</strong></div><span id="boardLabel" class="board-label" aria-live="polite"></span></div>' + boardMarkup() +
      '<div id="controller" class="controller"><div id="controlModes" class="seg mode-seg" role="group" aria-label="Control mode"><button data-mode="buttons" aria-pressed="true">Buttons</button><button data-mode="gestures" aria-pressed="false">Gestures</button></div><div class="control-pad"><div class="movement">' + tool('leftBtn', 'arrow-left', 'Move left', 'data-action="left"') + tool('softBtn', 'arrow-down', 'Soft drop', 'data-action="soft"') + tool('rightBtn', 'arrow-right', 'Move right', 'data-action="right"') + '</div><div class="rotation">' + tool('holdBtn', 'archive', 'Hold piece', 'data-action="hold"') + tool('ccwBtn', 'rotate-ccw', 'Rotate counterclockwise', 'data-action="rotateCCW"') + tool('cwBtn', 'rotate-cw', 'Rotate clockwise', 'data-action="rotateCW"') + tool('dropBtn', 'arrow-down-to-line', 'Hard drop', 'data-action="drop"') + '</div></div></div>';
  }
  function paint(view) {
    if (!view) return;
    SRRender.draw(el('boardCanvas'), view);
    SRRender.preview(el('holdCanvas'), view.hold);
    SRRender.preview(el('nextCanvas'), view.next);
    el('linesStat').textContent = view.lines || 0;
    el('levelStat').textContent = view.level || 1;
    el('timeStat').textContent = clock(view.elapsedMs);
    el('boardLabel').textContent = view.label || '';
    el('incoming').hidden = !view.incoming || role === 'practice';
    el('incoming').textContent = '+' + (view.incoming || 0);
  }
  function controls(onChange) {
    const stage = document.querySelector('.board-stage');
    const frame = document.querySelector('.board-frame');
    stage.querySelector('.board-rail').append(el('boardLabel'));
    if (el('controlPopup')) {
      el('controlPopup').append(el('controlModes'));
      function closeControls(returnFocus) {
        el('controlPopup').hidden = true;
        el('controlSettingsBtn').setAttribute('aria-expanded', 'false');
        if (returnFocus) el('controlSettingsBtn').focus();
      }
      activate(el('controlSettingsBtn'), function () {
        const opening = el('controlPopup').hidden;
        el('controlPopup').hidden = !opening;
        el('controlSettingsBtn').setAttribute('aria-expanded', String(opening));
        if (onChange) onChange();
        if (opening) el('controlModes').querySelector('[aria-pressed="true"]').focus();
      });
      document.addEventListener('pointerdown', function (event) { if (!el('controlSettings').contains(event.target)) closeControls(false); });
      document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !el('controlPopup').hidden) { event.preventDefault(); closeControls(true); } });
    }
    function fitBoard() {
      if (!stage.clientHeight || !stage.clientWidth) return;
      const rails = Array.from(stage.querySelectorAll('.board-rail')).reduce(function (total, rail) { return total + rail.getBoundingClientRect().width; }, 0);
      const gap = parseFloat(getComputedStyle(stage).columnGap) || 0;
      const width = Math.floor(Math.min(stage.clientHeight / 2, stage.clientWidth - rails - gap * 2));
      frame.style.width = width + 'px';
      frame.style.height = width * 2 + 'px';
    }
    if ('ResizeObserver' in window) new ResizeObserver(fitBoard).observe(stage);
    window.addEventListener('resize', fitBoard);
    new MutationObserver(fitBoard).observe(document.querySelector('.player-shell'), { subtree: true, attributes: true, attributeFilter: ['hidden'] });
    requestAnimationFrame(fitBoard);
    let mode = storage.get('controls') === 'gestures' ? 'gestures' : 'buttons';
    function update() {
      document.body.dataset.controls = mode;
      el('controlModes').querySelectorAll('button').forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.mode === mode)); });
    }
    el('controlModes').querySelectorAll('button').forEach(function (button) { activate(button, function () { mode = button.dataset.mode; storage.set('controls', mode); update(); if (onChange) onChange(); if (el('controlPopup')) { el('controlPopup').hidden = true; el('controlSettingsBtn').setAttribute('aria-expanded', 'false'); el('controlSettingsBtn').focus(); } }); });
    update();
    return function () { return mode; };
  }
  let audioCtx = null;
  let lastBattleSound = 0;
  let soundOn = storage.get('sound') !== 'off';
  function getAudioCtx() { if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} } return audioCtx; }
  function unlockAudio() { const context = getAudioCtx(); if (context && context.state === 'suspended') context.resume().catch(function () {}); }
  function sound(kind) {
    if (!soundOn) return;
    if (role === 'host' && (kind === 'attack' || kind === 'lose')) {
      if (Date.now() - lastBattleSound < 350) return;
      lastBattleSound = Date.now();
    }
    const context = getAudioCtx();
    if (!context || context.state !== 'running') return;
    const tunes = { join: [660, 880], start: [392, 523, 784], clear: [587, 880], drop: [160], lose: [330, 247, 165], win: [523, 659, 784, 1047], tick: [440], attack: [196, 262] };
    (tunes[kind] || tunes.drop).forEach(function (frequency, index) {
      const oscillator = context.createOscillator(); const gain = context.createGain(); const time = context.currentTime + index * 0.095;
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, time);
      gain.gain.setValueAtTime(0.0001, time); gain.gain.exponentialRampToValueAtTime(0.12, time + 0.008); gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.19);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(time); oscillator.stop(time + 0.2);
    });
  }
  function getBackTarget() { const from = new URLSearchParams(location.search).get('from'); return from === 'join' ? root + '/join' : from === 'play' ? root + '/play' : '/'; }
  function mountTopbar() {
    if (role === 'player') {
      el('topbar').innerHTML = '<div class="gtb-settings-wrapper"><button type="button" class="icon-btn" id="settingsBtn" title="Settings" aria-label="Settings" data-gtb-settings-toggle aria-controls="settingsPanel" aria-expanded="false">' + icon('settings') + '</button><div id="settingsPanel" class="gtb-settings-panel" hidden><button type="button" class="secondary" id="helpBtn" data-gtb-help-open="helpOverlay">' + icon('circle-help') + 'Help</button><div class="setting-row"><span>Sound</span><div id="soundSeg" class="seg" role="group" aria-label="Sound"><button data-sound="on" data-gtb-settings-keep-open>On</button><button data-sound="off" data-gtb-settings-keep-open>Off</button></div></div><button type="button" class="secondary" id="backBtn" title="Back to hub">' + icon('arrow-left') + 'Hub</button><div id="extraSettings"></div></div></div>';
    } else if (!el('settingsBtn')) {
    el('topbar').innerHTML = '<div class="game-topbar"><span class="gtb-brand"><span class="brand-bg">🧱</span> Stacking Royale</span><div class="gtb-controls"><button type="button" class="gtb-btn" id="backBtn" title="Back" aria-label="Back">' + icon('arrow-left') + '<span class="topbar-label">' + (role === 'host' ? 'Hub' : 'Back') + '</span></button><button type="button" class="gtb-btn" id="helpBtn" title="How to play" aria-label="How to play" data-gtb-help-open="helpOverlay">' + icon('circle-help') + '<span class="topbar-label">Help</span></button><div class="gtb-settings-wrapper"><button type="button" class="gtb-btn" id="settingsBtn" title="Settings" aria-label="Settings" data-gtb-settings-toggle aria-controls="settingsPanel" aria-expanded="false">' + icon('settings') + '<span class="topbar-label">Settings</span></button><div id="settingsPanel" class="gtb-settings-panel" hidden><div class="setting-row"><span>Sound</span><div id="soundSeg" class="seg" role="group" aria-label="Sound"><button data-sound="on" data-gtb-settings-keep-open>On</button><button data-sound="off" data-gtb-settings-keep-open>Off</button></div></div><div id="extraSettings"></div></div></div></div></div>';
    }
    const help = document.createElement('div');
    help.id = 'helpOverlay'; help.className = 'gtb-help-overlay'; help.setAttribute('role', 'dialog'); help.setAttribute('aria-modal', 'true'); help.setAttribute('aria-labelledby', 'helpTitle');
    help.innerHTML = '<div class="gtb-help-modal"><div class="help-head"><h2 id="helpTitle">How to play</h2>' + tool('helpCloseBtn', 'x', 'Close help', 'data-gtb-help-close') + '</div><div class="help-body"><p>Complete horizontal rows to clear them. Keep the stack below the top.</p>' + (role === 'practice' ? '<p>Classic endless practice. No opponents or incoming attacks. The pace increases with active play time.</p>' : '<p>1-30 players. With one player, play until you top out. With opponents, attacks cancel queued garbage first and send any remainder to a random surviving rival; the last player standing wins.</p>') + '<h3>Buttons & keyboard</h3><p>Arrows move and soft drop. Up / X rotates clockwise; Z rotates counterclockwise. C holds a piece. Space drops it instantly.</p><h3>Gestures</h3><p>Drag left or right to move, tap to rotate, or drag down slowly to soft drop. A fast, deliberate downward swipe drops the piece instantly. Hold and rotation tools stay available.</p>' + (role !== 'practice' ? '<p>Your board keeps playing on the server if your phone disconnects. Reconnect to return to the same match.</p>' : '<p>Leaving the tab or opening settings pauses your board. Resume when ready. Your session is saved on this device.</p>') + '</div></div>';
    document.body.append(help);
    ['helpBtn', 'settingsBtn', 'helpCloseBtn'].forEach(function (id) {
      const button = el(id);
      button.addEventListener('click', function (event) { if (event.detail > 0) event.stopImmediatePropagation(); }, true);
      button.addEventListener('pointerdown', function (event) { if (event.button !== 0) return; event.preventDefault(); button.click(); });
    });
    if (el('soundSeg')) {
      function paintSound() { el('soundSeg').querySelectorAll('button').forEach(function (button) { button.setAttribute('aria-pressed', String((button.dataset.sound === 'on') === soundOn)); }); }
      el('soundSeg').querySelectorAll('button').forEach(function (button) { activate(button, function () { soundOn = button.dataset.sound === 'on'; storage.set('sound', soundOn ? 'on' : 'off'); unlockAudio(); paintSound(); }); });
      paintSound();
    }
    document.addEventListener('pointerdown', unlockAudio, { once: true });
    icons();
  }
  function overlayOpen() { return !!((el('settingsPanel') && !el('settingsPanel').hidden) || (el('helpOverlay') && el('helpOverlay').classList.contains('is-open'))); }
  function observeOverlays(callback) {
    const observer = new MutationObserver(function () { if (overlayOpen()) callback(); });
    observer.observe(el('settingsPanel'), { attributes: true, attributeFilter: ['hidden'] });
    observer.observe(el('helpOverlay'), { attributes: true, attributeFilter: ['class'] });
  }
  function friendly(reason) { return ({ 'host-absent': 'The host is away. Please wait for them to return.', 'game-full': 'All 30 places are taken.', 'round-in-progress': 'A match is underway. Join the next lobby.', 'game-in-progress': 'A match is underway. Join the next lobby.', 'name-taken': 'That name is already taken.', 'name-too-short': 'Please enter a name.', 'unknown-player': 'Your place is no longer in this lobby.', 'not-in-lobby': 'Wait for the next lobby.' })[reason] || 'Could not complete that request. Please try again.'; }
  window.SRUI = { el: el, storage: storage, seed: seed, identity: identity, icons: icons, icon: icon, tool: tool, activate: activate, clock: clock, name: name, standings: standings, winner: winner, controllerMarkup: controllerMarkup, paint: paint, controls: controls, sound: sound, unlockAudio: unlockAudio, getBackTarget: getBackTarget, overlayOpen: overlayOpen, observeOverlays: observeOverlays, friendly: friendly };
  if (role === 'host') mountTopbar();
}());