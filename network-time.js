/**
 * ISI Terminal v6 — NETWORK TIME SYNC
 * ══════════════════════════════════════════════════════════════
 * Fixes: a wrong LOCAL DEVICE CLOCK (wrong date/time in Windows/phone
 * settings — e.g. after travel across timezones) silently corrupting
 * every timestamp the app writes: Daybook's "today", trade dates,
 * Terminal entry/exit timestamps, Pre-Entry savedAt times — all of it
 * previously came straight from `new Date()`, which ALWAYS reflects
 * whatever the device's OS clock says, right or wrong.
 *
 * FIX: Firebase Realtime Database exposes a special reserved path,
 * `.info/serverTimeOffset`, that continuously reports the difference
 * (in ms) between THIS DEVICE's clock and Google's Firebase SERVER
 * clock — without needing any round-trip request of our own. Once
 * synced, `Date.now() + offset` gives the TRUE current time regardless
 * of whether the local device clock is right, wrong, or in the wrong
 * timezone entirely.
 *
 * TWO SEPARATE, INDEPENDENTLY-MANAGEABLE USES (per requirement — kept
 * as two distinct named APIs even though both read the same synced
 * offset under the hood, since there's only one "true time"; separating
 * them is about giving Settings independent visibility/control, not
 * about needing two different sync mechanisms):
 *
 *   1. DAYBOOK RESET / "TODAY" DATE — window._ISIDate (session.js)
 *      now reads this offset for every todayStr()/dateStr() call, so
 *      the UTC-rollover Daybook reset (~05:30 AM IST) fires at the
 *      correct real-world moment, not whenever the device THINKS it is.
 *
 *   2. TERMINAL / PRE-ENTRY TIMESTAMPS — window.ISI_NetTime.now() is
 *      used at the specific points that stamp an ENTRY/EXIT time or a
 *      Pre-Entry savedAt time, so those timestamps are correct even if
 *      the device clock was off by hours (wrong timezone after travel,
 *      clock drift, manually-mis-set clock, etc).
 *
 * Loaded on every page (alongside session.js) so window._ISIDate is
 * correct everywhere without having to touch every individual file.
 * ══════════════════════════════════════════════════════════════
 */
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};
const ntApp = getApps().find(a => a.name === '[DEFAULT]') || getApps()[0] || initializeApp(firebaseConfig, 'isiNetTime');
const db = getDatabase(ntApp);

// Starts at 0 (= trust local clock) until the first server offset
// arrives — typically within a second of page load. Self-corrects
// silently the moment it does; nothing downstream needs to wait for it.
window._ISINetOffsetMs   = 0;
window._ISINetTimeSynced = false;
window._ISINetLastSyncAt = null;

onValue(ref(db, '.info/serverTimeOffset'), snap => {
    const offset = snap.val();
    if (typeof offset === 'number') {
        window._ISINetOffsetMs   = offset;
        window._ISINetTimeSynced = true;
        window._ISINetLastSyncAt = Date.now();
        window.dispatchEvent(new CustomEvent('isi-nettime-sync', { detail: { offsetMs: offset } }));
    }
}, err => {
    console.warn('Network time sync failed — falling back to local device clock:', err);
});

window.ISI_NetTime = {
    // Corrected Date object — use for anything that gets WRITTEN as an
    // absolute timestamp (entry/exit time, savedAt, etc).
    now: () => new Date(Date.now() + (window._ISINetOffsetMs || 0)),
    nowMs: () => Date.now() + (window._ISINetOffsetMs || 0),
    getOffsetMs: () => window._ISINetOffsetMs || 0,
    isSynced: () => !!window._ISINetTimeSynced,
    // How far off the device clock actually is, human-readable — for
    // the Settings diagnostics panel.
    describeOffset: () => {
        const ms = window._ISINetOffsetMs || 0;
        const absSec = Math.round(Math.abs(ms) / 1000);
        if (absSec < 2) return 'Device clock accurate (within 2s)';
        const mins = Math.floor(absSec / 60);
        const secs = absSec % 60;
        const dir = ms > 0 ? 'peeche hai (slow)' : 'aage hai (fast)';
        return `Device clock ${mins > 0 ? mins + 'm ' : ''}${secs}s ${dir}`;
    },
};
