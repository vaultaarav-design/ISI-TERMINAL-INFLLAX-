/**
 * ISI Terminal v6.0 — Session Manager
 * 30-minute inactivity timeout → redirect to index with password gate
 * Shared across ALL pages
 */

(function() {
    const TIMEOUT_MS   = 30 * 60 * 1000; // 30 minutes
    const STORAGE_KEY  = 'isi_last_activity';
    const ACTIVE_KEY   = 'isi_session_active';
    const INDEX_PAGE   = 'index.html';

    // Pages that ARE the auth gate — don't redirect these
    const EXEMPT_PAGES = ['index.html', '/', ''];

    function currentPage() {
        return window.location.pathname.split('/').pop() || 'index.html';
    }

    function isExempt() {
        const p = currentPage();
        return EXEMPT_PAGES.includes(p);
    }

    function markActivity() {
        localStorage.setItem(STORAGE_KEY, Date.now().toString());
    }

    function getLastActivity() {
        return parseInt(localStorage.getItem(STORAGE_KEY) || '0');
    }

    function isSessionActive() {
        return localStorage.getItem(ACTIVE_KEY) === '1';
    }

    function expireSession() {
        localStorage.removeItem(ACTIVE_KEY);
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem('isi_sel_cluster');
        localStorage.removeItem('isi_sel_node');
    }

    function redirectToLogin() {
        expireSession();
        if (!isExempt()) {
            // Show overlay before redirect
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position:fixed;top:0;left:0;width:100%;height:100%;
                background:rgba(0,0,0,0.97);z-index:999999;
                display:flex;align-items:center;justify-content:center;
                flex-direction:column;gap:16px;
            `;
            overlay.innerHTML = `
                <div style="font-size:2.5rem;">🔒</div>
                <div style="color:#c5a059;font-size:1rem;font-weight:bold;letter-spacing:3px;">SESSION EXPIRED</div>
                <div style="color:#555;font-size:0.72rem;letter-spacing:1px;">30 minutes of inactivity detected</div>
                <div style="color:#444;font-size:0.65rem;">Redirecting to Terminal...</div>
            `;
            document.body.appendChild(overlay);
            setTimeout(() => { window.location.href = INDEX_PAGE; }, 1800);
        }
    }

    function checkTimeout() {
        if (isExempt()) return;
        if (!isSessionActive()) {
            redirectToLogin();
            return;
        }
        const elapsed = Date.now() - getLastActivity();
        if (elapsed > TIMEOUT_MS) {
            redirectToLogin();
        }
    }

    function startTimer() {
        // Immediate check on load — don't wait for the first 60s tick
        checkTimeout();
        // Check every 60 seconds
        setInterval(checkTimeout, 60 * 1000);
        // Also check on page focus (user switches tabs)
        window.addEventListener('focus', checkTimeout);
        window.addEventListener('visibilitychange', () => {
            if (!document.hidden) checkTimeout();
        });
    }

    function resetTimer() {
        if (isExempt()) {
            markActivity();
            return;
        }
        markActivity();
    }

    // Activity events — reset timer on any interaction
    const ACTIVITY_EVENTS = ['mousedown','mousemove','keydown','scroll','touchstart','click','wheel'];
    // Throttle: only update storage once every 10 seconds max
    let lastReset = 0;
    function throttledReset() {
        const now = Date.now();
        if (now - lastReset > 10000) {
            lastReset = now;
            resetTimer();
        }
    }
    ACTIVITY_EVENTS.forEach(ev => {
        document.addEventListener(ev, throttledReset, { passive: true });
    });

    // Public API
    window._ISISession = {
        activate: function() {
            localStorage.setItem(ACTIVE_KEY, '1');
            markActivity();
        },
        isActive: isSessionActive,
        reset: resetTimer,
        expire: expireSession,
    };

    // ── SHARED "TODAY" DATE HELPER (UTC-based, BY DESIGN) ──
    // Daybook/trade dates intentionally roll over on the UTC calendar day,
    // not local midnight. For an IST desk whose trading day wraps up by
    // ~9-10 PM, this gives a natural overnight buffer (UTC midnight = 05:30
    // AM IST) to review the full day's data before Daybook resets to zero —
    // instead of cutting the review window off at local 12:00 AM.
    // Centralized here so every file (trade date, pre-entry date, Daybook
    // filter, calendar heatmap, order tracker, settings date-fields) uses
    // the exact same "today" — keeping everything self-consistent.
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function pad2(n) { return String(n).padStart(2, '0'); }
    function utcDateStr(d) {
        d = d || new Date();
        return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    window._ISIDate = {
        todayStr: () => utcDateStr(new Date()),
        dateStr:  (d) => utcDateStr(d),
        // "21 Jul 2026" style label built straight from a YYYY-MM-DD string —
        // no re-parsing through `new Date()`, so it can never drift back to
        // local time and contradict the (UTC-based) data next to it.
        displayDate: (yyyyMmDd) => {
            const [y, m, d] = (yyyyMmDd || utcDateStr(new Date())).split('-').map(Number);
            return `${pad2(d)} ${MONTHS[m - 1]} ${y}`;
        },
    };

    // Init on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            markActivity();
            startTimer();
        });
    } else {
        markActivity();
        startTimer();
    }

})();
