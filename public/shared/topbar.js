/* Shared topbar behaviors: settings popover + help modal.
 *
 * Markup contracts:
 *   • Settings button:  data-gtb-settings-toggle  aria-controls="<panelId>"
 *   • Settings panel:   id="<panelId>"  class="gtb-settings-panel"  hidden
 *   • Help open btn:    data-gtb-help-open="<overlayId>"
 *   • Help overlay:     id="<overlayId>"  class="gtb-help-overlay"
 *   • Help close btn:   data-gtb-help-close (any descendant of the overlay)
 */
(function () {
  function closeAllSettings() {
    document.querySelectorAll('.gtb-settings-panel:not([hidden])').forEach(function (panel) {
      panel.hidden = true;
      var ctrl = document.querySelector('[aria-controls="' + panel.id + '"]');
      if (ctrl) ctrl.setAttribute('aria-expanded', 'false');
    });
  }

  function closeAllHelp() {
    document.querySelectorAll('.gtb-help-overlay.is-open').forEach(function (ov) {
      ov.classList.remove('is-open');
    });
  }

  document.addEventListener('click', function (e) {
    // Toggle settings popover.
    var settingsBtn = e.target.closest('[data-gtb-settings-toggle]');
    if (settingsBtn) {
      var panelId = settingsBtn.getAttribute('aria-controls');
      var panel = panelId && document.getElementById(panelId);
      if (panel) {
        var willOpen = !!panel.hidden;
        // Close any other panels first.
        closeAllSettings();
        if (willOpen) {
          panel.hidden = false;
          settingsBtn.setAttribute('aria-expanded', 'true');
        }
      }
      e.stopPropagation();
      return;
    }

    // Open help.
    var helpOpen = e.target.closest('[data-gtb-help-open]');
    if (helpOpen) {
      var ovId = helpOpen.getAttribute('data-gtb-help-open');
      var ov = ovId && document.getElementById(ovId);
      if (ov) ov.classList.add('is-open');
      // Close settings if it was open (since user clicked Help from inside).
      closeAllSettings();
      return;
    }

    // Close help (button or backdrop).
    var helpClose = e.target.closest('[data-gtb-help-close]');
    if (helpClose) {
      var ovParent = helpClose.closest('.gtb-help-overlay');
      if (ovParent) ovParent.classList.remove('is-open');
      return;
    }
    var helpBackdrop = e.target.closest('.gtb-help-overlay');
    if (helpBackdrop && e.target === helpBackdrop) {
      helpBackdrop.classList.remove('is-open');
      return;
    }

    // Click outside any open settings panel → close.
    var insidePanel = e.target.closest('.gtb-settings-panel');
    var onSettingsBtn = e.target.closest('[data-gtb-settings-toggle]');
    if (!insidePanel && !onSettingsBtn) {
      closeAllSettings();
      return;
    }

    // Click on an action button inside the panel → close after the action,
    // unless the button opts out (e.g. a toggle the user may flip multiple
    // times) by setting data-gtb-settings-keep-open.
    if (insidePanel) {
      var actionBtn = e.target.closest('button, a');
      if (actionBtn && !actionBtn.hasAttribute('data-gtb-settings-keep-open')) {
        // Defer so the button's own click handler runs first.
        setTimeout(closeAllSettings, 0);
      }
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeAllHelp();
      closeAllSettings();
    }
  });
})();

/* "F" toggles fullscreen on every host screen (ignored while typing or with a modifier,
 * so Cmd/Ctrl+F still opens the browser's find bar).
 */
(function () {
  function isTyping(t) {
    if (!t || !t.tagName) return false;
    var tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'f' && e.key !== 'F') return;
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if (isTyping(e.target)) return;
    var root = document.documentElement;
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    e.preventDefault();
    try {
      if (fsEl) {
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        var p = exit && exit.call(document);
        if (p && p.catch) p.catch(function () {});
      } else {
        var req = root.requestFullscreen || root.webkitRequestFullscreen;
        var q = req && req.call(root);
        if (q && q.catch) q.catch(function () {});
      }
    } catch (err) { /* unsupported — ignore */ }
  });
})();

/* Hide the mouse pointer on a fullscreen host screen once it has sat still for a
 * while, so it doesn't linger on the TV. Windowed pages keep their cursor.
 */
(function () {
  var IDLE_MS = 5000;
  var timer = null;

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function hide() {
    timer = null;
    document.documentElement.classList.add('gtb-cursor-hidden');
  }

  function show() {
    document.documentElement.classList.remove('gtb-cursor-hidden');
  }

  function poke() {
    show();
    if (timer) clearTimeout(timer);
    timer = isFullscreen() ? setTimeout(hide, IDLE_MS) : null;
  }

  document.addEventListener('mousemove', function (e) {
    // Animation moving under a stationary pointer emits a zero-delta mousemove,
    // which would un-hide the cursor the instant it hides.
    if (e.movementX === 0 && e.movementY === 0) return;
    poke();
  }, { passive: true });

  document.addEventListener('mousedown', poke, { passive: true });
  document.addEventListener('wheel', poke, { passive: true });
  document.addEventListener('keydown', poke, { passive: true });

  function onFullscreenChange() {
    if (isFullscreen()) poke();
    else {
      if (timer) clearTimeout(timer);
      timer = null;
      show();
    }
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') {
      if (timer) clearTimeout(timer);
      timer = null;
      show();
    }
  });
})();

/* Fullscreen host screens: the topbar slides out of the way so the game gets the
 * whole screen, and floats back over it while the mouse is at the top edge or on
 * the bar (or a tap lands there / keyboard focus enters it). It stays out while
 * its settings menu or help is open. Windowed pages keep the bar as-is.
 */
(function () {
  var HOT_PX = 10;
  var TOUCH_HOT_PX = 28;
  var LEAVE_MS = 800;
  var IDLE_MS = 5000;
  var TOUCH_MS = 4000;
  var root = document.documentElement;
  var timer = null;
  var leaving = false;

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function getBar() {
    if (!document.body || !document.body.classList.contains('host')) return null;
    return document.querySelector('.game-topbar');
  }

  function active() {
    return root.classList.contains('gtb-fs-autohide');
  }

  function isPinned(bar) {
    if (bar.querySelector('.gtb-settings-panel:not([hidden])')) return true;
    if (document.querySelector('.gtb-help-overlay.is-open')) return true;
    try { if (bar.querySelector(':focus-visible')) return true; } catch (_) {}
    return false;
  }

  function hideLater(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      var bar = getBar();
      if (!bar || !active()) return;
      if (isPinned(bar)) { hideLater(LEAVE_MS); return; }
      leaving = false;
      root.classList.remove('gtb-topbar-shown');
    }, ms);
  }

  function reveal(ms) {
    leaving = false;
    root.classList.add('gtb-topbar-shown');
    hideLater(ms);
  }

  document.addEventListener('mousemove', function (e) {
    if (!active()) return;
    if (e.movementX === 0 && e.movementY === 0) return;
    var bar = getBar();
    if (!bar) return;
    if (e.clientY <= HOT_PX || bar.contains(e.target)) reveal(IDLE_MS);
    else if (!leaving && root.classList.contains('gtb-topbar-shown')) {
      leaving = true;
      hideLater(LEAVE_MS);
    }
  }, { passive: true });

  document.addEventListener('pointerdown', function (e) {
    if (!active() || e.pointerType === 'mouse') return;
    var bar = getBar();
    if (bar && (e.clientY <= TOUCH_HOT_PX || bar.contains(e.target))) reveal(TOUCH_MS);
  }, { passive: true });

  document.addEventListener('focusin', function (e) {
    var bar = getBar();
    if (!active() || !bar || !bar.contains(e.target)) return;
    try { if (!e.target.matches(':focus-visible')) return; } catch (_) {}
    reveal(IDLE_MS);
  });

  function sync() {
    if (timer) clearTimeout(timer);
    timer = null;
    leaving = false;
    var on = isFullscreen() && !!getBar();
    if (on === active()) return;
    root.classList.toggle('gtb-fs-autohide', on);
    root.classList.remove('gtb-topbar-shown');
    // The bar just left (or rejoined) the layout — let games that size their
    // stage from the window re-measure.
    requestAnimationFrame(function () {
      try { window.dispatchEvent(new Event('resize')); } catch (_) {}
    });
  }
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
})();

/* Clear every confetti piece on the page at once. Games call this when they
   leave their results screen, so a quick "Play again" doesn't carry falling
   confetti into the next game. Covers each game's confetti class names. */
(function () {
  var SEL = '.confetti, .confetti-piece, .confetti-bit';
  window.clearConfetti = function () {
    var bits = document.querySelectorAll(SEL);
    for (var i = 0; i < bits.length; i++) if (bits[i].parentNode) bits[i].parentNode.removeChild(bits[i]);
  };
})();

/* Stop any applause still playing. Games call this together with
   clearConfetti() when they leave their results screen. Covers the recorded
   applause (<audio id="…applause…"> elements and Audio objects registered with
   trackApplause) and synth claps whose output gain was registered. */
(function () {
  var tracked = [];
  window.trackApplause = function (x) {
    if (x && tracked.indexOf(x) < 0) tracked.push(x);
    return x;
  };
  function silence(x) {
    try {
      if (typeof x.pause === 'function') { x.pause(); x.currentTime = 0; return true; }
      if (x.gain) { x.gain.cancelScheduledValues(0); x.gain.value = 0; x.disconnect(); }
    } catch (_) {}
    return false;
  }
  window.stopApplause = function () {
    var els = document.querySelectorAll('audio[id*="applause"]');
    for (var i = 0; i < els.length; i++) silence(els[i]);
    // Media elements stay registered (they're reused); synth gains are done.
    tracked = tracked.filter(function (x) { return silence(x); });
  };
})();

/* Leaving a screen tidies up after it, so nothing carries over:
   - clearReactions(): floating player reactions and seat emote bubbles.
   - stopScreenSounds(): cuts every Web Audio sound still ringing (applause,
     fanfares, stings…). Each node a game connects to the speakers is
     remembered; sounds started in the last moment are spared, so a sound for
     the screen being entered (e.g. a start jingle) is never cut.
   - screenChange(from, to, downtime): call on every view change. Reactions
     always go; sounds go when leaving a lobby/results screen (`downtime`,
     default lobby + final) — but not when heading into the final results,
     whose fanfare may already be playing. */
(function () {
  var REACTION_SEL = '.reaction-emoji, .reaction-float, .emote-bubble';
  window.clearReactions = function () {
    var els = document.querySelectorAll(REACTION_SEL);
    for (var i = 0; i < els.length; i++) if (els[i].parentNode) els[i].parentNode.removeChild(els[i]);
  };

  var GRACE_MS = 500;
  var MAX_AGE_MS = 30000;
  var live = [];
  var Node = window.AudioNode;
  if (Node && Node.prototype && Node.prototype.connect && !Node.prototype.__screenFxPatched) {
    var connect = Node.prototype.connect;
    Node.prototype.connect = function (dest) {
      var out = connect.apply(this, arguments);
      try {
        if (dest && this.context && dest === this.context.destination) {
          var now = Date.now();
          if (live.length > 200) live = live.filter(function (r) { return now - r.at < MAX_AGE_MS; });
          live.push({ node: this, at: now });
        }
      } catch (_) {}
      return out;
    };
    Node.prototype.__screenFxPatched = true;
  }
  window.stopScreenSounds = function () {
    var now = Date.now();
    live = live.filter(function (r) {
      if (now - r.at < GRACE_MS) return true;
      try { r.node.disconnect(r.node.context.destination); } catch (_) {}
      return false;
    });
  };

  window.screenChange = function (from, to, downtime) {
    if (!from || from === to) return;
    window.clearReactions();
    var leaving = downtime || ['lobby', 'final'];
    if (leaving.indexOf(from) >= 0 && String(to).toLowerCase() !== 'final') {
      window.stopScreenSounds();
      if (window.stopApplause) window.stopApplause();
      if (window.clearConfetti) window.clearConfetti();
    }
  };
})();
