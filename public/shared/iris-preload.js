/* iris-preload.js — synchronous head script that eliminates flicker on the
 * destination page of a page transition. Must be loaded in <head> *without*
 * `defer` or `async`, BEFORE iris.css/iris.js, so it runs before first paint.
 *
 * If the previous page initiated a transition (sessionStorage flag), this
 * script:
 *   1) Adds `iris-incoming` to <html> (CSS pre-paint cover kicks in).
 *   2) Builds the actual overlay (cover + spinner + emoji) and appends it
 *      to <html> already in the "covered" state. iris.js later finds this
 *      element and handles the collapse — no handoff between layers, so
 *      nothing flickers.
 */
(function () {
    var raw;
    try {
        raw = sessionStorage.getItem('iris_entering');
    } catch (_) { return; }
    if (!raw) return;

    var rm = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (rm) return;

    var data = {};
    try { data = JSON.parse(raw) || {}; } catch (_) {}

    var html = document.documentElement;
    html.classList.add('iris-incoming');

    // If a destination color was provided, set it on <html> so the CSS
    // pre-paint cover (`html.iris-incoming::before`) uses it too — keeps
    // the cover color continuous from before iris.js runs.
    if (data.color) {
        html.style.setProperty('--iris-bg', data.color);
    }

    var ov = document.createElement('div');
    ov.className = 'iris-overlay no-transition revealing';
    ov.id = 'irisOverlay';
    ov.setAttribute('aria-hidden', 'true');
    if (data.color) ov.style.backgroundColor = data.color;

    ov.innerHTML =
        '<div class="iris-loader">' +
          '<svg class="iris-ring" viewBox="0 0 50 50" aria-hidden="true">' +
            '<circle class="iris-ring-track" cx="25" cy="25" r="22" />' +
            '<circle class="iris-ring-arc"   cx="25" cy="25" r="22" />' +
          '</svg>' +
          '<div class="iris-emoji"></div>' +
        '</div>';
    ov.querySelector('.iris-emoji').textContent = data.emoji || '🎮';

    html.appendChild(ov);
    // Mark that the JS-built overlay exists so the CSS-only pre-paint
    // cover stays hidden (avoids double-paint).
    html.classList.add('iris-active');
})();
