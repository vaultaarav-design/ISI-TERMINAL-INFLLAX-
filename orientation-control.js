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
    function applyAutoRotate() {
        const mode = localStorage.getItem('isi_autoRotate') || 'on';
        try {
            if (mode === 'off') {
                if (screen.orientation && screen.orientation.lock) {
                    screen.orientation.lock('portrait').catch(function () {});
                }
            } else {
                if (screen.orientation && screen.orientation.unlock) {
                    screen.orientation.unlock();
                } else if (screen.orientation && screen.orientation.lock) {
                    screen.orientation.lock('any').catch(function () {});
                }
            }
        } catch (e) {
            // Not supported in this context (e.g. plain browser tab, not standalone) — ignore silently
        }
    }

    // Applies the preference and saves it (called from the Settings toggle)
    window.__isiSetAutoRotate = function (mode) {
        localStorage.setItem('isi_autoRotate', mode);
        applyAutoRotate();
    };

    // Lets other pages (e.g. Settings.html) read current preference to reflect it in the UI
    window.__isiGetAutoRotate = function () {
        return localStorage.getItem('isi_autoRotate') || 'on';
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyAutoRotate);
    } else {
        applyAutoRotate();
    }
})();
