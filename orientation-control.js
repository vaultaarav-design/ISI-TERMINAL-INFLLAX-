// ══════════════════════════════════════════════════════════════════
// PWA AUTO-ROTATE CONTROL — shared across all pages
// Lets the trader choose, from Settings, whether the installed PWA
// (standalone display mode) free-rotates with the phone, or stays
// locked to Portrait — independent of the phone's own OS-level
// Auto-Rotate toggle (which some devices/Chrome builds ignore for
// installed WebAPKs). Uses the Screen Orientation API, which works
// inside an installed standalone PWA without needing Fullscreen.
// Preference is stored in localStorage under 'isi_autoRotate':
//   'on'  → free rotate (default, matches original behavior)
//   'off' → locked to Portrait
// ══════════════════════════════════════════════════════════════════
(function () {
    function lockPortrait(callback) {
        if (!(window.screen && screen.orientation && screen.orientation.lock)) {
            if (callback) callback(false, 'not-supported');
            return;
        }
        screen.orientation.lock('portrait').then(function () {
            if (callback) callback(true);
        }).catch(function () {
            // Some Android/Chrome builds only allow lock() while in Fullscreen — try that as a fallback
            try {
                const el = document.documentElement;
                const reqFS = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
                if (!reqFS) { if (callback) callback(false, 'no-fullscreen-api'); return; }
                reqFS.call(el).then(function () {
                    return screen.orientation.lock('portrait');
                }).then(function () {
                    if (callback) callback(true);
                }).catch(function () {
                    if (callback) callback(false, 'lock-rejected');
                });
            } catch (e2) {
                if (callback) callback(false, 'exception');
            }
        });
    }

    function applyAutoRotate(callback) {
        const mode = localStorage.getItem('isi_autoRotate') || 'on';
        if (mode === 'off') {
            lockPortrait(callback);
        } else {
            try {
                if (screen.orientation && screen.orientation.unlock) {
                    screen.orientation.unlock();
                } else if (screen.orientation && screen.orientation.lock) {
                    screen.orientation.lock('any').catch(function () {});
                }
            } catch (e) { /* not supported in this context — ignore */ }
            if (callback) callback(true);
        }
    }

    // Applies the preference and saves it (called from the Settings toggle).
    // callback(success, reason?) reports whether the lock/unlock actually took effect.
    window.__isiSetAutoRotate = function (mode, callback) {
        localStorage.setItem('isi_autoRotate', mode);
        applyAutoRotate(callback);
    };

    // Lets other pages (e.g. Settings.html) read current preference to reflect it in the UI
    window.__isiGetAutoRotate = function () {
        return localStorage.getItem('isi_autoRotate') || 'on';
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { applyAutoRotate(); });
    } else {
        applyAutoRotate();
    }
})();
