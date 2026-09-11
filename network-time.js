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
import { getDatabase, ref, onValue, set } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};
const ntApp = getApps().find(a => a.name === 'isiNetTime') || initializeApp(firebaseConfig, 'isiNetTime');
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
    // ── FIXED-IST clock for session-window / weekday comparisons ──
    // CRITICAL: .getHours()/.getMinutes()/.getDay() on ANY JS Date object
    // — even one built from a network-corrected epoch — always report
    // the BROWSER/OS's CURRENT LOCAL TIMEZONE, not a fixed reference. So
    // changing the device's timezone (Settings → Time & Language, or
    // physically traveling) silently shifts every session countdown even
    // though the real-world instant hasn't changed at all. Session
    // windows like "19:30–20:30" are configured assuming a FIXED IST
    // reference (same principle as the Daybook UTC-rollover reset) — so
    // reading them out requires UTC accessors + a fixed +5:30 offset,
    // which are immune to whatever the local OS timezone happens to be.
    nowIST: () => {
        const ms = window.ISI_NetTime.nowMs() + 5.5 * 3600 * 1000;
        const d = new Date(ms);
        return { hours: d.getUTCHours(), minutes: d.getUTCMinutes(), day: d.getUTCDay() };
    },
};

// ══════════════════════════════════════════════════════════════
// USER TIMEZONE PREFERENCE — manual, dropdown-selected (Windows-style)
// ══════════════════════════════════════════════════════════════
// Network time (above) answers "what time is it, really" — immune to a
// wrong device clock. This layer answers a SEPARATE question: "which
// timezone should the app DISPLAY that time in" — because the trader
// travels abroad and the DEVICE's own timezone can't be trusted to
// auto-follow that (phone/laptop timezone often stays on home-zone, or
// gets manually fumbled while traveling — same root problem as the
// device clock itself). So exactly like Windows' own Date & Time page,
// this is a manual dropdown the trader sets themselves, NOT an
// auto-detected value — persisted in Firebase so it's the same on every
// device/tab, not just localStorage.
//
// IMPORTANT DISTINCTION: this ONLY affects DISPLAY (what the clock on
// screen shows). Daybook's day-rollover boundary intentionally stays
// fixed to the UTC/IST business rule regardless of this setting — "which
// trading day a trade belongs to" is a fixed rule, not a personal
// display preference, so it does NOT change just because the trader is
// physically standing in a different timezone that day.
window.ISI_TIMEZONES = [
    { offsetMin: -720, label: '(UTC-12:00) International Date Line West' },
    { offsetMin: -660, label: '(UTC-11:00) Midway Island' },
    { offsetMin: -600, label: '(UTC-10:00) Hawaii' },
    { offsetMin: -540, label: '(UTC-09:00) Alaska' },
    { offsetMin: -480, label: '(UTC-08:00) Los Angeles, Vancouver' },
    { offsetMin: -420, label: '(UTC-07:00) Denver, Phoenix' },
    { offsetMin: -360, label: '(UTC-06:00) Chicago, Mexico City' },
    { offsetMin: -300, label: '(UTC-05:00) New York, Toronto' },
    { offsetMin: -240, label: '(UTC-04:00) Halifax, Santiago' },
    { offsetMin: -210, label: '(UTC-03:30) Newfoundland' },
    { offsetMin: -180, label: '(UTC-03:00) Buenos Aires, Sao Paulo' },
    { offsetMin: -120, label: '(UTC-02:00) Mid-Atlantic' },
    { offsetMin: -60,  label: '(UTC-01:00) Azores' },
    { offsetMin: 0,    label: '(UTC+00:00) London, Lisbon' },
    { offsetMin: 60,   label: '(UTC+01:00) Paris, Berlin, Lagos' },
    { offsetMin: 120,  label: '(UTC+02:00) Cairo, Athens, Johannesburg' },
    { offsetMin: 180,  label: '(UTC+03:00) Moscow, Nairobi, Riyadh' },
    { offsetMin: 210,  label: '(UTC+03:30) Tehran' },
    { offsetMin: 240,  label: '(UTC+04:00) Dubai, Tbilisi, Yerevan' },
    { offsetMin: 270,  label: '(UTC+04:30) Kabul' },
    { offsetMin: 300,  label: '(UTC+05:00) Ashgabat, Tashkent, Islamabad, Karachi' },
    { offsetMin: 330,  label: '(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi', isDefault: true },
    { offsetMin: 345,  label: '(UTC+05:45) Kathmandu' },
    { offsetMin: 360,  label: '(UTC+06:00) Dhaka, Bishkek, Omsk' },
    { offsetMin: 390,  label: '(UTC+06:30) Yangon (Rangoon)' },
    { offsetMin: 420,  label: '(UTC+07:00) Bangkok, Hanoi, Jakarta' },
    { offsetMin: 480,  label: '(UTC+08:00) Singapore, Beijing, Hong Kong' },
    { offsetMin: 540,  label: '(UTC+09:00) Tokyo, Seoul' },
    { offsetMin: 570,  label: '(UTC+09:30) Adelaide, Darwin' },
    { offsetMin: 600,  label: '(UTC+10:00) Sydney, Melbourne, Guam' },
    { offsetMin: 660,  label: '(UTC+11:00) Solomon Islands' },
    { offsetMin: 720,  label: '(UTC+12:00) Auckland, Fiji' },
];

const TZ_STORAGE_KEY = 'isi_user_timezone_offset_min';
window._ISIUserTZOffsetMin = parseInt(localStorage.getItem(TZ_STORAGE_KEY));
if (Number.isNaN(window._ISIUserTZOffsetMin)) window._ISIUserTZOffsetMin = 330; // default IST

// Cross-device sync — Firebase is the source of truth once it answers;
// localStorage above is just the instant-available fallback so the
// first render isn't stuck at a hardcoded default while Firebase loads.
onValue(ref(db, 'isi_v6/settings/user_timezone_offset_min'), snap => {
    const v = snap.val();
    if (typeof v === 'number') {
        window._ISIUserTZOffsetMin = v;
        localStorage.setItem(TZ_STORAGE_KEY, String(v));
        window.dispatchEvent(new CustomEvent('isi-timezone-change', { detail: { offsetMin: v } }));
    }
});

window.ISI_UserTZ = {
    getOffsetMin: () => window._ISIUserTZOffsetMin,
    getLabel: () => (window.ISI_TIMEZONES.find(t => t.offsetMin === window._ISIUserTZOffsetMin) || {}).label || 'Custom',
    // The network-corrected time, shifted into the trader's SELECTED
    // display timezone — combines both systems described above.
    now: () => {
        const netMs = window.ISI_NetTime.nowMs();
        return new Date(netMs + (window._ISIUserTZOffsetMin || 0) * 60000);
    },
    format: (d) => {
        d = d || window.ISI_UserTZ.now();
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    },
    formatDate: (d) => {
        d = d || window.ISI_UserTZ.now();
        return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth()+1)}-${d.getUTCFullYear()}`;
        function pad2(n) { return String(n).padStart(2, '0'); }
    },
    async setOffsetMin(offsetMin) {
        window._ISIUserTZOffsetMin = offsetMin;
        localStorage.setItem(TZ_STORAGE_KEY, String(offsetMin));
        try { await set(ref(db, 'isi_v6/settings/user_timezone_offset_min'), offsetMin); }
        catch (e) { console.warn('Timezone preference save failed (kept locally):', e); }
        window.dispatchEvent(new CustomEvent('isi-timezone-change', { detail: { offsetMin } }));
    },
};
