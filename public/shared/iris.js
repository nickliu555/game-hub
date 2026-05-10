/* Shared iris-reveal page transition.
 *
 * Public API:
 *   Iris.transitionTo(href, originEvent, { emoji, name })
 *     - href: URL to navigate to.
 *     - originEvent: kept for API compatibility (origin is currently always
 *       the screen center).
 *     - opts.emoji / opts.name: optional content shown inside the overlay.
 *
 *   Iris.ready()
 *     Call this once the destination page is finished initializing
 *     (e.g. after socket connects, fonts load, etc.). The iris will then
 *     collapse open, revealing the page. If never called, the iris auto-
 *     collapses on `window.load` or after a max-wait fallback.
 *
 * Auto-binding:
 *   Any <a data-iris href="..."> element will trigger the transition on click.
 *   Optional attributes: data-iris-emoji, data-iris-name.
 *
 * Pair with /shared/iris.css.
 */
(function () {
    var FALLBACK_MS = 2400;     // Source page: navigate even if transitionend never fires.
    var HOLD_MS = 500;          // Destination: minimum time fully covered before collapsing.
    var MAX_WAIT_MS = 1500;     // Destination: collapse no later than this even if not ready.
    var overlay = null;

    function ensureOverlay() {
        if (overlay) return overlay;
        overlay = document.getElementById('irisOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'iris-overlay';
            overlay.id = 'irisOverlay';
            overlay.setAttribute('aria-hidden', 'true');
            var emoji = document.createElement('div');
            emoji.className = 'iris-emoji';
            var name = document.createElement('div');
            name.className = 'iris-name';
            overlay.appendChild(emoji);
            overlay.appendChild(name);
            // Append to <html> rather than <body> so transforms on <body>
            // (used for the scale+blur effect) don't affect the overlay's
            // fixed positioning.
            (document.documentElement || document.body).appendChild(overlay);
        }
        return overlay;
    }

    function setBodyDimmed(on) {
        if (!document.body) return;
        document.body.classList.toggle('iris-page-active', !!on);
    }

    function getOrigin(_originEvent) {
        // Always reveal from screen center for a consistent, predictable feel.
        return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    }

    function reduceMotion() {
        return !!(window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    // ─── Source page: leaving via transition ─────────────────────────────
    function transitionTo(href, originEvent, opts) {
        opts = opts || {};
        if (reduceMotion()) {
            window.location.href = href;
            return;
        }

        var ov = ensureOverlay();
        var origin = getOrigin(originEvent);
        ov.style.setProperty('--iris-x', origin.x + 'px');
        ov.style.setProperty('--iris-y', origin.y + 'px');

        var emojiEl = ov.querySelector('.iris-emoji');
        var nameEl = ov.querySelector('.iris-name');
        if (emojiEl) emojiEl.textContent = opts.emoji || '';
        if (nameEl) nameEl.textContent = opts.name || '';

        // Stash content so the destination page can show the overlay covered
        // and collapse it open — making one continuous motion.
        try {
            sessionStorage.setItem('iris_entering', JSON.stringify({
                emoji: opts.emoji || '',
                name: opts.name || '',
            }));
        } catch (_) { /* sessionStorage may be unavailable */ }

        ov.classList.remove('no-transition');
        ov.classList.remove('revealing');
        void ov.offsetWidth;
        ov.classList.add('revealing');
        setBodyDimmed(true);

        var navigated = false;
        var go = function () {
            if (navigated) return;
            navigated = true;
            window.location.href = href;
        };
        ov.addEventListener('transitionend', go, { once: true });
        setTimeout(go, FALLBACK_MS);
    }

    // ─── Destination page: arriving via transition ──────────────────────
    var enteringStart = 0;
    var entering = false;
    var collapseRequested = false;

    function requestCollapse() {
        if (!entering || collapseRequested) return;
        collapseRequested = true;
        var elapsed = Date.now() - enteringStart;
        var wait = Math.max(0, HOLD_MS - elapsed);
        setTimeout(doCollapse, wait);
    }

    function doCollapse() {
        var ov = ensureOverlay();
        // Re-enable transitions (we showed it covered with no-transition).
        ov.classList.remove('no-transition');
        // Next frame: trigger collapse + body un-dim simultaneously.
        requestAnimationFrame(function () {
            ov.classList.remove('revealing');
            setBodyDimmed(false);
        });
        entering = false;
        // Strip the pre-paint marker classes once the collapse animation is
        // done, so the page is in a fully clean state.
        var cleanup = function () {
            document.documentElement.classList.remove('iris-incoming');
            document.documentElement.classList.remove('iris-active');
        };
        ov.addEventListener('transitionend', cleanup, { once: true });
        // Fallback in case transitionend doesn't fire.
        setTimeout(cleanup, 3000);
    }

    function checkEntering() {
        var raw = null;
        try { raw = sessionStorage.getItem('iris_entering'); } catch (_) {}
        if (!raw) return;
        try { sessionStorage.removeItem('iris_entering'); } catch (_) {}

        if (reduceMotion()) return;

        // The preload script (iris-preload.js) may have already built the
        // overlay synchronously in <head>. If so, just adopt it and we don't
        // need to set content again — no flicker.
        var ov = ensureOverlay();
        var preloaded = ov.classList.contains('revealing') &&
                        ov.classList.contains('no-transition');
        if (!preloaded) {
            // Fallback path (preload script wasn't included or didn't run).
            var data = {};
            try { data = JSON.parse(raw) || {}; } catch (_) {}
            var emojiEl = ov.querySelector('.iris-emoji');
            var nameEl = ov.querySelector('.iris-name');
            if (emojiEl) emojiEl.textContent = data.emoji || '';
            if (nameEl) nameEl.textContent = data.name || '';
            ov.style.setProperty('--iris-x', '50%');
            ov.style.setProperty('--iris-y', '50%');
            ov.classList.add('no-transition');
            ov.classList.add('revealing');
            document.documentElement.classList.add('iris-active');
            void ov.offsetWidth;
        }

        // Body wasn't available when the preload ran, so apply dim now.
        setBodyDimmed(true);

        entering = true;
        enteringStart = Date.now();

        // Auto-ready: on window 'load' event, the page's resources are done.
        if (document.readyState === 'complete') {
            requestCollapse();
        } else {
            window.addEventListener('load', requestCollapse, { once: true });
        }
        // Hard fallback so we never get stuck covered.
        setTimeout(requestCollapse, MAX_WAIT_MS);
    }

    // iris.js is loaded with `defer`, so this runs after parsing.
    if (document.body) {
        checkEntering();
    } else {
        document.addEventListener('DOMContentLoaded', checkEntering, { once: true });
    }

    // Auto-bind <a data-iris> links.
    document.addEventListener('click', function (e) {
        if (e.defaultPrevented) return;
        var link = e.target.closest && e.target.closest('a[data-iris]');
        if (!link) return;
        if (e.button !== 0 || e.metaKey || e.ctrlKey ||
            e.shiftKey || e.altKey) return;
        var href = link.getAttribute('href');
        if (!href) return;
        e.preventDefault();
        transitionTo(href, e, {
            emoji: link.getAttribute('data-iris-emoji') || '',
            name: link.getAttribute('data-iris-name') || '',
        });
    });

    window.Iris = {
        transitionTo: transitionTo,
        ready: requestCollapse,
    };
})();
