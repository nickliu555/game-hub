(function () {
  'use strict';
  let zoomLocked = false;
  // iOS ignores user-scalable=no, and decides a touch is a pinch on its first
  // move, so every touchmove is swallowed unless it is a single finger inside a
  // region that can actually scroll.
  function scroller(target) {
    for (let node = target && target.nodeType === 1 ? target : target && target.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (node.tagName === 'SELECT') return node;
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
      if (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) return node;
    }
    return null;
  }
  function lockZoom() {
    if (zoomLocked) return;
    zoomLocked = true;
    const stop = function (event) { if (event.cancelable) event.preventDefault(); };
    const editable = function (target) { return target && target.closest && target.closest('input,textarea,select,[contenteditable="true"]'); };
    const stopSelection = function (event) { if (!editable(event.target)) stop(event); };
    const capture = { capture: true, passive: false };
    document.addEventListener('selectstart', stopSelection, capture);
    document.addEventListener('contextmenu', stopSelection, capture);
    document.addEventListener('dragstart', stopSelection, capture);
    document.addEventListener('dblclick', stopSelection, capture);
    document.addEventListener('gesturestart', stop, capture);
    document.addEventListener('gesturechange', stop, capture);
    document.addEventListener('gestureend', stop, capture);
    document.addEventListener('touchstart', function (event) {
      if (event.touches && event.touches.length > 1) stop(event);
    }, capture);
    document.addEventListener('touchmove', function (event) {
      if (event.touches && event.touches.length > 1) return stop(event);
      if (event.scale !== undefined && event.scale !== 1) return stop(event);
      if (scroller(event.target)) return;
      stop(event);
    }, capture);
    let lastTouchEnd = 0;
    document.addEventListener('touchend', function (event) {
      const now = Date.now();
      if (now - lastTouchEnd <= 350) stop(event);
      lastTouchEnd = now;
    }, capture);
    document.addEventListener('wheel', function (event) { if (event.ctrlKey || event.metaKey) stop(event); }, capture);
    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && ['+', '=', '-', '_', '0'].includes(event.key)) stop(event);
    }, capture);
    document.addEventListener('selectionchange', function () {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && !editable(document.activeElement)) selection.removeAllRanges();
    });
    window.addEventListener('scroll', function () {
      if (!editable(document.activeElement) && (window.scrollX || window.scrollY)) window.scrollTo(0, 0);
    }, { passive: true });
    // Last resort: if a zoom slips through anyway, re-apply the viewport meta,
    // which makes iOS/Android snap back to scale 1.
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && window.visualViewport) {
      const content = meta.getAttribute('content');
      let resetting = false;
      window.visualViewport.addEventListener('resize', function () {
        if (resetting || window.visualViewport.scale <= 1.01) return;
        resetting = true;
        meta.setAttribute('content', content + ', width=device-width');
        requestAnimationFrame(function () { meta.setAttribute('content', content); resetting = false; });
      });
    }
  }
  function bind(options) {
    const held = new Map();
    const keyActions = { ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'soft', ArrowUp: 'rotateCW', z: 'rotateCCW', x: 'rotateCW', c: 'hold', ' ': 'drop' };
    let gesture = null;
    function fire(action) { if (options.enabled()) options.action(action); }
    function release(token) {
      const timers = held.get(token);
      if (timers) { clearTimeout(timers.delay); clearInterval(timers.repeat); }
      held.delete(token);
    }
    function clear() { held.forEach(function (_, token) { release(token); }); gesture = null; }
    function press(token, action) {
      if (held.has(token) || !options.enabled()) return;
      const timers = { delay: null, repeat: null };
      held.set(token, timers);
      fire(action);
      if (!held.has(token)) return;
      if (['left', 'right', 'soft'].includes(action)) {
        timers.delay = setTimeout(function () {
          fire(action);
          if (held.has(token)) timers.repeat = setInterval(function () { fire(action); }, 80);
        }, 150);
      }
    }
    options.root.querySelectorAll('[data-action]').forEach(function (button) {
      button.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        if (button.setPointerCapture) button.setPointerCapture(event.pointerId);
        press('pointer:' + event.pointerId, button.dataset.action);
      });
      button.addEventListener('lostpointercapture', function (event) { release('pointer:' + event.pointerId); });
    });
    document.addEventListener('pointerup', function (event) { release('pointer:' + event.pointerId); });
    document.addEventListener('pointercancel', clear);
    document.addEventListener('keydown', function (event) {
      if (event.target.closest('input,textarea,select,[contenteditable="true"]') || event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const action = keyActions[key];
      if (!action || !options.enabled()) return;
      event.preventDefault();
      if (!event.repeat) press('key:' + key, action);
    });
    document.addEventListener('keyup', function (event) { release('key:' + (event.key.length === 1 ? event.key.toLowerCase() : event.key)); });
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', function () { if (document.hidden) clear(); });
    options.canvas.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || options.mode() !== 'gestures' || !options.enabled() || gesture) return;
      event.preventDefault();
      options.canvas.setPointerCapture(event.pointerId);
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, time: performance.now(), moved: false, horizontal: false };
    });
    options.canvas.addEventListener('pointermove', function (event) {
      if (!gesture || gesture.id !== event.pointerId) return;
      event.preventDefault();
      const unit = Math.max(14, options.canvas.getBoundingClientRect().width / 10);
      const horizontal = event.clientX - gesture.lastX;
      const vertical = event.clientY - gesture.lastY;
      if (Math.abs(event.clientX - gesture.x) > 10 || Math.abs(event.clientY - gesture.y) > 10) gesture.moved = true;
      if (Math.abs(horizontal) >= unit) {
        for (let step = 0; step < Math.min(10, Math.floor(Math.abs(horizontal) / unit)); step++) fire(horizontal > 0 ? 'right' : 'left');
        gesture.lastX = event.clientX; gesture.horizontal = true;
      }
      if (vertical >= unit && performance.now() - gesture.time > 180) {
        for (let step = 0; step < Math.min(20, Math.floor(vertical / unit)); step++) fire('soft');
        gesture.lastY = event.clientY;
      }
    });
    options.canvas.addEventListener('pointerup', function (event) {
      if (!gesture || gesture.id !== event.pointerId) return;
      event.preventDefault();
      const distance = event.clientY - gesture.y;
      const duration = performance.now() - gesture.time;
      if (!gesture.horizontal && distance > Math.max(65, options.canvas.getBoundingClientRect().height * 0.18) && duration < 280 && distance / Math.max(1, duration) > 0.6) fire('drop');
      else if (!gesture.moved && duration < 350) fire('rotateCW');
      gesture = null;
    });
    options.canvas.addEventListener('lostpointercapture', function () { gesture = null; });
    return { clear: clear };
  }
  window.SRControls = { bind: bind, lockZoom: lockZoom };
  lockZoom();
}());