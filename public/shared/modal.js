/* ============================================================
 * Shared Modal API
 * ------------------------------------------------------------
 * Exposes:
 *   window.showAlert(message, { okLabel? }) -> Promise<void>
 *   window.showConfirm(message, okLabel?, { danger? }) -> Promise<boolean>
 *   window.showToast(message, durationMs?) -> void
 *
 * The DOM is created lazily and reused. Esc closes (cancel for
 * confirm, ok for alert). Backdrop click cancels confirm or
 * resolves alert.
 * ============================================================ */
(function () {
  if (window.showAlert && window.showConfirm) return; // already loaded

  let overlay = null;
  let modal = null;
  let msgEl = null;
  let okBtn = null;
  let cancelBtn = null;
  let activeResolver = null;
  let activeKind = null; // 'alert' | 'confirm'

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'gm-overlay';
    overlay.hidden = true;
    overlay.innerHTML = [
      '<div class="gm-modal" role="dialog" aria-modal="true" aria-live="polite">',
        '<div class="gm-msg"></div>',
        '<div class="gm-actions">',
          '<button type="button" class="gm-btn gm-btn-secondary" data-act="cancel">Cancel</button>',
          '<button type="button" class="gm-btn gm-btn-primary" data-act="ok">OK</button>',
        '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(overlay);
    modal = overlay.querySelector('.gm-modal');
    msgEl = overlay.querySelector('.gm-msg');
    okBtn = overlay.querySelector('[data-act="ok"]');
    cancelBtn = overlay.querySelector('[data-act="cancel"]');

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close(activeKind === 'alert');
    });
    okBtn.addEventListener('click', function () { close(true); });
    cancelBtn.addEventListener('click', function () { close(false); });
    document.addEventListener('keydown', function (e) {
      if (overlay.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); close(activeKind === 'alert'); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    });
  }

  function open(kind, message, opts) {
    ensureDom();
    activeKind = kind;
    msgEl.textContent = message == null ? '' : String(message);
    okBtn.textContent = (opts && opts.okLabel) || (kind === 'alert' ? 'OK' : 'Confirm');
    cancelBtn.textContent = (opts && opts.cancelLabel) || 'Cancel';
    modal.classList.toggle('is-alert', kind === 'alert');
    modal.classList.toggle('is-danger', !!(opts && opts.danger));
    overlay.hidden = false;
    overlay.classList.add('is-open');
    // Focus the primary action so Enter works immediately.
    setTimeout(function () { try { okBtn.focus(); } catch (_) {} }, 0);
    return new Promise(function (resolve) { activeResolver = resolve; });
  }

  function close(result) {
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.hidden = true;
    const r = activeResolver;
    activeResolver = null;
    const wasKind = activeKind;
    activeKind = null;
    if (r) r(wasKind === 'alert' ? undefined : !!result);
  }

  window.showAlert = function (message, opts) {
    return open('alert', message, opts || {});
  };
  window.showConfirm = function (message, okLabel, opts) {
    const o = Object.assign({}, opts || {});
    if (okLabel) o.okLabel = okLabel;
    return open('confirm', message, o);
  };

  window.showToast = function (message, durationMs) {
    const dur = typeof durationMs === 'number' ? durationMs : 3000;
    const t = document.createElement('div');
    t.className = 'gm-toast';
    t.textContent = message;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('is-visible'); });
    setTimeout(function () {
      t.classList.remove('is-visible');
      setTimeout(function () { try { t.remove(); } catch (_) {} }, 250);
    }, dur);
  };
})();
