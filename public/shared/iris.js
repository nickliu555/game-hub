/* Shared page transition.
 *
 * Public API:
 *   Iris.transitionTo(href, originEvent, { emoji, name, color })
 *     - href: URL to navigate to.
 *     - originEvent: kept for back-compat (unused by the new visuals).
 *     - opts.emoji: shown centered inside the spinner ring.
 *     - opts.name:  accepted for back-compat (no longer rendered).
 *     - opts.color: optional CSS color for the cover (defaults to #1b2838).
 *
 *   Iris.ready()
 *     Call once the destination page is finished initializing. The cover
 *     fades out and the page is revealed. If never called, auto-collapses
 *     on `window.load` or after a max-wait fallback.
 *
 * Auto-binding:
 *   <a data-iris href="..." data-iris-emoji="🧠" data-iris-color="#46178F">
 */
(function () {
    var FALLBACK_MS = 1500;     // Source page: navigate even if no transitionend.
    var HOLD_MS = 350;          // Destination: minimum cover time before fading out.
    var MAX_WAIT_MS = 2500;     // Destination: collapse no later than this.
    var DEFAULT_COLOR = '#1b2838';
    var overlay = null;

    function buildLoader(emojiText) {
        var loader = document.createElement('div');
        loader.className = 'iris-loader';
        loader.innerHTML =
            '<svg class="iris-ring" viewBox="0 0 50 50" aria-hidden="true">' +
              '<circle class="iris-ring-track" cx="25" cy="25" r="22" />' +
              '<circle class="iris-ring-arc"   cx="25" cy="25" r="22" />' +
            '</svg>' +
            '<div class="iris-emoji"></div>';
        loader.querySelector('.iris-emoji').textContent = emojiText || '🎮';
        return loader;
    }

    function ensureOverlay() {
        if (overlay) return overlay;
        overlay = document.getElementById('irisOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'iris-overlay';
            overlay.id = 'irisOverlay';
            overlay.setAttribute('aria-hidden', 'true');
            overlay.appendChild(buildLoader(''));
            (document.documentElement || document.body).appendChild(overlay);
        }
        return overlay;
    }

    function setEmoji(ov, emojiText) {
        var em = ov.querySelector('.iris-emoji');
        if (em) em.textContent = emojiText || '🎮';
    }

    function setColor(ov, color) {
        ov.style.backgroundColor = color || DEFAULT_COLOR;
    }

    function reduceMotion() {
        return !!(window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    // ─── Source page: leaving via transition ─────────────────────────────
    function transitionTo(href, _originEvent, opts) {
        opts = opts || {};
        if (reduceMotion()) {
            window.location.href = href;
            return;
        }

        var ov = ensureOverlay();
        setEmoji(ov, opts.emoji);
        setColor(ov, opts.color);

        // Stash for the destination's preload script so the cover stays
        // continuous across the navigation.
        try {
            sessionStorage.setItem('iris_entering', JSON.stringify({
                emoji: opts.emoji || '',
                color: opts.color || '',
            }));
        } catch (_) { /* sessionStorage may be unavailable */ }

        ov.classList.remove('no-transition');
        ov.classList.remove('revealing');
        void ov.offsetWidth;
        ov.classList.add('revealing');

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
        ov.classList.remove('no-transition');
        requestAnimationFrame(function () {
            ov.classList.remove('revealing');
        });
        entering = false;
        var cleanup = function () {
            document.documentElement.classList.remove('iris-incoming');
            document.documentElement.classList.remove('iris-active');
        };
        ov.addEventListener('transitionend', cleanup, { once: true });
        setTimeout(cleanup, 1500);
    }

    function checkEntering() {
        var raw = null;
        try { raw = sessionStorage.getItem('iris_entering'); } catch (_) {}
        if (!raw) return;
        try { sessionStorage.removeItem('iris_entering'); } catch (_) {}

        if (reduceMotion()) return;

        var ov = ensureOverlay();
        var preloaded = ov.classList.contains('revealing') &&
                        ov.classList.contains('no-transition');
        if (!preloaded) {
            // Fallback path: preload script wasn't included or didn't run.
            var data = {};
            try { data = JSON.parse(raw) || {}; } catch (_) {}
            setEmoji(ov, data.emoji);
            setColor(ov, data.color);
            ov.classList.add('no-transition');
            ov.classList.add('revealing');
            document.documentElement.classList.add('iris-active');
            void ov.offsetWidth;
        }

        entering = true;
        enteringStart = Date.now();

        if (document.readyState === 'complete') {
            requestCollapse();
        } else {
            window.addEventListener('load', requestCollapse, { once: true });
        }
        setTimeout(requestCollapse, MAX_WAIT_MS);
    }

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
            name:  link.getAttribute('data-iris-name')  || '',
            color: link.getAttribute('data-iris-color') || '',
        });
    });

    window.Iris = {
        transitionTo: transitionTo,
        ready: requestCollapse,
    };
})();
