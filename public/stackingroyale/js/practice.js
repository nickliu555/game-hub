(function () {
  'use strict';
  const ui = SRUI;
  const el = ui.el;
  el('playSurface').innerHTML = ui.controllerMarkup();
  el('sessionTools').innerHTML = ui.tool('backBtn', 'arrow-left', 'Back') + ui.tool('pauseBtn', 'pause', 'Pause practice') + ui.tool('restartBtn', 'rotate-ccw', 'Restart practice') + '<div id="controlSettings" class="control-settings">' + ui.tool('controlSettingsBtn', 'settings', 'Control mode', 'aria-expanded="false" aria-controls="controlPopup"') + '<div id="controlPopup" class="control-popup" role="group" aria-label="Control mode" hidden></div></div>';
  SRControls.lockZoom();
  ui.icons();
  let board = null;
  let phase = 'ready';
  let armed = null;
  let previous = 0;
  let accumulator = 0;
  let lastSave = 0;
  let input = null;
  const step = 1000 / 60;
  const getMode = ui.controls(function () { if (input) input.clear(); disarm(); });
  function enabled() { return board && phase === 'playing' && !document.hidden && !ui.overlayOpen(); }
  function disarm() { armed = null; el('confirmStrip').hidden = true; }
  function save() {
    if (!board) return;
    const view = board.view();
    const saved = ui.storage.set('practice.session', JSON.stringify({ version: 1, board: board.snapshot(), counters: { lines: view.lines, level: view.level, elapsedMs: view.elapsedMs }, phase: board.over ? 'final' : 'paused' }));
    if (!saved) { el('practiceNotice').hidden = false; el('practiceNotice').textContent = 'This browser cannot save your session. Keep this tab open to continue.'; }
  }
  function paintState() {
    const view = board && board.view();
    if (view) ui.paint(view); else SRRender.artwork(el('boardCanvas'));
    el('boardOverlay').hidden = phase === 'playing' || phase === 'final';
    el('overlayTitle').textContent = phase === 'ready' ? 'Ready to stack?' : 'Paused';
    el('overlayDetail').textContent = phase === 'ready' ? 'Classic endless' : 'Your board is saved';
    el('resumeBtn').hidden = phase !== 'ready' && phase !== 'paused';
    el('resumeBtn').textContent = phase === 'ready' ? 'Start practice' : 'Resume';
    el('pauseBtn').disabled = phase !== 'playing';
    el('restartBtn').disabled = !board;
    el('controller').hidden = phase === 'final';
    el('results').hidden = phase !== 'final';
    el('controller').querySelectorAll('[data-action]').forEach(function (button) { button.disabled = !enabled(); });
    if (phase === 'final' && view) el('resultSummary').textContent = view.lines + ' lines · Level ' + view.level + ' · ' + ui.clock(view.elapsedMs);
  }
  function pause() {
    if (phase !== 'playing') return;
    phase = 'paused'; accumulator = 0; previous = 0;
    input.clear(); disarm(); save(); paintState();
  }
  function finish() { phase = 'final'; input.clear(); accumulator = 0; ui.sound('lose'); save(); paintState(); }
  function observe(before) {
    const after = board.view();
    if (after.lines > before.lines) ui.sound('clear');
    else if (after.locks > before.locks) ui.sound('drop');
    if (board.over) finish();
  }
  function start() {
    if (!window.StackingRoyale || !window.StackingRoyale.Board) {
      el('practiceNotice').hidden = false; el('practiceNotice').textContent = 'The game engine could not load. Refresh to try again.'; return;
    }
    board = new StackingRoyale.Board(ui.seed()); phase = 'playing'; accumulator = 0; previous = 0; disarm(); ui.unlockAudio(); ui.sound('start'); save(); paintState();
  }
  input = SRControls.bind({ root: el('controller'), canvas: el('boardCanvas'), enabled: enabled, mode: getMode, action: function (action) {
    disarm(); ui.unlockAudio(); const before = board.view(); board.action(action); observe(before); ui.paint(board.view()); save();
  } });
  function confirm(action) {
    if (!board || phase === 'final') { if (action === 'back') location.href = ui.getBackTarget(); else start(); return; }
    if (armed === action) { disarm(); if (action === 'back') { ui.storage.remove('practice.session'); location.href = ui.getBackTarget(); } else start(); return; }
    pause(); armed = action;
    el('confirmText').textContent = action === 'back' ? 'Tap Back again to abandon this session.' : 'Tap Restart again to start a new session.';
    el('confirmStrip').hidden = false;
  }
  ui.activate(el('pauseBtn'), pause);
  ui.activate(el('restartBtn'), function () { confirm('restart'); });
  ui.activate(el('backBtn'), function () { confirm('back'); });
  ui.activate(el('cancelConfirm'), disarm);
  ui.activate(el('againBtn'), start);
  ui.activate(el('resumeBtn'), function () {
    if (phase === 'ready') { start(); return; }
    if (phase !== 'paused' || ui.overlayOpen()) return;
    disarm(); phase = 'playing'; previous = 0; accumulator = 0; ui.unlockAudio(); paintState();
  });
  window.addEventListener('blur', pause);
  document.addEventListener('visibilitychange', function () { if (document.hidden) pause(); });
  window.addEventListener('pagehide', function () { pause(); save(); });
  try {
    const saved = JSON.parse(ui.storage.get('practice.session'));
    if (saved && saved.version === 1 && window.StackingRoyale) {
      board = StackingRoyale.Board.from(saved.board); phase = board.over ? 'final' : 'paused';
    }
  } catch (_) { ui.storage.remove('practice.session'); }
  paintState();
  function frame(now) {
    if (enabled()) {
      if (!previous) previous = now;
      accumulator += Math.min(100, now - previous);
      previous = now;
      const before = board.view();
      let steps = 0;
      while (accumulator >= step && steps < 6 && !board.over) { board.step(step); accumulator -= step; steps++; }
      observe(before);
      ui.paint(board.view());
      if (now - lastSave > 1000) { save(); lastSave = now; }
    } else { previous = 0; accumulator = 0; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}());