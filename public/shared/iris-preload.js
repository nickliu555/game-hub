/* iris-preload.js — synchronous head script that eliminates flicker on the
 * destination page of an iris transition. Must be loaded in <head> *without*
 * `defer` or `async`, BEFORE iris.css/iris.js, so it runs before the first
 * paint.
 *
 * If the previous page initiated an iris transition (sessionStorage flag),
 * this script:
 *   1) Adds `iris-incoming` to <html> (CSS pre-paint cover kicks in).
 *   2) Builds the actual iris-overlay element with the emoji + name and
 *      appends it to <html> already in the "covered" state. iris.js will
 *      later find this element and handle the collapse — there is no
 *      handoff between layers, so nothing flickers in.
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

    // Build the overlay synchronously. iris.css will style it (it loads
    // immediately after this script in <head>, and CSS is render-blocking,
    // so it'll be applied before first paint).
    var ov = document.createElement('div');
    ov.className = 'iris-overlay no-transition revealing iris-active';
    ov.id = 'irisOverlay';
    ov.setAttribute('aria-hidden', 'true');
    ov.style.setProperty('--iris-x', '50%');
    ov.style.setProperty('--iris-y', '50%');

    var emoji = document.createElement('div');
    emoji.className = 'iris-emoji';
    emoji.textContent = data.emoji || '';

    var name = document.createElement('div');
    name.className = 'iris-name';
    name.textContent = data.name || '';

    ov.appendChild(emoji);
    ov.appendChild(name);
    html.appendChild(ov);
    // Mark that the JS-built overlay exists so the CSS-only pre-paint
    // cover stays hidden (avoids double-paint).
    html.classList.add('iris-active');
})();
