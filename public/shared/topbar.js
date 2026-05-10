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
