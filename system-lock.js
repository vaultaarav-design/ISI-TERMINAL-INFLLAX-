/**
 * ISI Terminal v6 — SYSTEM LOCK ENGINE (SMI Discipline Guard)
 * ══════════════════════════════════════════════════════════════
 * Loaded on EVERY page. Two jobs:
 *
 *  1) WATCHER (all pages): watches Firebase for an active lock on the
 *     currently selected cluster/node and, while it's active, freezes
 *     the entire page (full-screen frost + no clicks get through) and
 *     shows a warning strip with a live countdown.
 *
 *  2) TRIGGER API (called by preentry.js / terminal.js): exposes
 *     window.ISI_triggerLock(level, minutes, reason, source) which
 *     writes the lock to Firebase so it applies system-wide, on every
 *     open page/device for that account — not just the tab that
 *     tripped it.
 *
 * Rules encoded here (per trading-discipline spec):
 *   Pre-Entry SMI  < 60  → Level 1 lock, 15 min
 *   Pre-Entry SMI  < 40  → Level 2 lock, 30 min + hard reset Pre-Entry
 *   Terminal  SMI  < 70  → Level 1 lock, 15 min
 *   Terminal  SMI  < 50  → Level 2 lock, 30 min + hard reset Pre-Entry
 *
 * A lock only ever ESCALATES (longer/stronger wins) — a weaker trigger
 * can never shorten or downgrade an already-active lock.
 * ══════════════════════════════════════════════════════════════
 */
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, set, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};

// Use a distinctly-named app instance so this module never collides
// with the default Firebase app some pages (preentry.js / terminal.js)
// already initialize on the same page.
const lockApp = getApps().find(a => a.name === 'isiSystemLock') || initializeApp(firebaseConfig, 'isiSystemLock');
const db = getDatabase(lockApp);

const LOCK_LABEL = { 1: 'SYSTEM LOCK — 15 MIN', 2: 'HARD LOCK — 30 MIN', 3: 'DAILY RISK LOCK — UNTIL RESET' };

function selectedClusterId() { return localStorage.getItem('isi_sel_cluster') || null; }
function selectedNodeIdx()   { return localStorage.getItem('isi_sel_node')    || null; }

function lockPath() {
    const c = selectedClusterId();
    const n = selectedNodeIdx();
    if (!c || n === null || n === '') return 'isi_v6/system_lock/_unassigned';
    return `isi_v6/system_lock/${c}/${n}`;
}

// ── DOM: overlay (freezes clicks) + warning strip (always readable) ──
let overlayEl = null, stripEl = null, tickTimer = null, currentLock = null;

function ensureDom() {
    if (overlayEl) return;

    const style = document.createElement('style');
    style.textContent = `
        #isiLockOverlay {
            position: fixed; inset: 0; z-index: 2147483000;
            background: rgba(2,2,2,0.72);
            backdrop-filter: blur(6px) saturate(60%);
            -webkit-backdrop-filter: blur(6px) saturate(60%);
            display: none; align-items: center; justify-content: center;
            flex-direction: column; gap: 14px; text-align: center;
            font-family: 'Courier New', monospace; padding: 24px;
            cursor: not-allowed;
        }
        #isiLockOverlay .isi-lock-icon { font-size: 2.6rem; filter: grayscale(0.2); }
        #isiLockOverlay .isi-lock-title {
            color: #d32f2f; font-size: 1.05rem; font-weight: 700;
            letter-spacing: 3px;
        }
        #isiLockOverlay .isi-lock-reason {
            color: #e0e0e0; font-size: 0.75rem; max-width: 520px;
            line-height: 1.5; opacity: 0.85;
        }
        #isiLockOverlay .isi-lock-timer {
            color: #fbc02d; font-size: 1.6rem; font-weight: 700;
            letter-spacing: 2px; margin-top: 4px;
        }
        #isiLockOverlay .isi-lock-source {
            color: #555; font-size: 0.62rem; letter-spacing: 1px; margin-top: 6px;
        }
        #isiLockStrip {
            position: fixed; top: 0; left: 0; right: 0; z-index: 2147483001;
            display: none; align-items: center; justify-content: center;
            gap: 10px; padding: 7px 10px; font-family: 'Courier New', monospace;
            font-size: 0.72rem; font-weight: 700; letter-spacing: 1px;
            color: #050505; text-align: center;
            box-shadow: 0 2px 12px rgba(0,0,0,0.6);
        }
        #isiLockStrip.isi-lvl-1 { background: #fbc02d; }
        #isiLockStrip.isi-lvl-2 { background: #d32f2f; color: #fff; }
        #isiLockStrip.isi-lvl-3 { background: #7a0000; color: #fff; }
        body.isi-locked { overflow: hidden; }
    `;
    document.head.appendChild(style);

    stripEl = document.createElement('div');
    stripEl.id = 'isiLockStrip';
    document.body.appendChild(stripEl);

    overlayEl = document.createElement('div');
    overlayEl.id = 'isiLockOverlay';
    overlayEl.innerHTML = `
        <div class="isi-lock-icon">🔒</div>
        <div class="isi-lock-title" id="isiLockTitle">SYSTEM LOCKED</div>
        <div class="isi-lock-reason" id="isiLockReason"></div>
        <div class="isi-lock-timer" id="isiLockTimer">--:--</div>
        <div class="isi-lock-source" id="isiLockSource"></div>
    `;
    document.body.appendChild(overlayEl);

    // Swallow all interaction with the page underneath while locked.
    ['click', 'keydown', 'touchstart', 'wheel'].forEach(evt => {
        document.addEventListener(evt, blockIfLocked, true);
    });
}

function blockIfLocked(e) {
    if (!currentLock) return;
    if (overlayEl && overlayEl.contains(e.target)) return; // overlay itself is fine
    if (Date.now() < currentLock.until) {
        e.stopPropagation();
        e.preventDefault();
    }
}

function fmtMMSS(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function showLock(lock) {
    ensureDom();
    document.body.classList.add('isi-locked');
    overlayEl.style.display = 'flex';
    stripEl.style.display = 'flex';
    stripEl.classList.remove('isi-lvl-1', 'isi-lvl-2', 'isi-lvl-3');
    stripEl.classList.add(lock.level === 3 ? 'isi-lvl-3' : lock.level === 2 ? 'isi-lvl-2' : 'isi-lvl-1');

    document.getElementById('isiLockTitle').textContent = LOCK_LABEL[lock.level] || 'SYSTEM LOCKED';
    document.getElementById('isiLockReason').textContent = lock.reason || 'Discipline threshold breached.';
    document.getElementById('isiLockSource').textContent = `Triggered by: ${lock.source || 'SMI Guard'}`;

    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
        const remain = lock.until - Date.now();
        if (remain <= 0) { hideLock(); return; }
        const mmss = fmtMMSS(remain);
        document.getElementById('isiLockTimer').textContent = mmss;
        stripEl.textContent = `🔒 ${LOCK_LABEL[lock.level] || 'LOCKED'} — ${lock.reason || ''} — Unlocks in ${mmss}`;
    }, 1000);
    // fire once immediately so there's no 1s blank flash
    tickTimer && document.getElementById('isiLockTimer') && (() => {
        const remain = lock.until - Date.now();
        document.getElementById('isiLockTimer').textContent = fmtMMSS(remain);
        stripEl.textContent = `🔒 ${LOCK_LABEL[lock.level] || 'LOCKED'} — ${lock.reason || ''} — Unlocks in ${fmtMMSS(remain)}`;
    })();
}

function hideLock() {
    clearInterval(tickTimer);
    if (overlayEl) overlayEl.style.display = 'none';
    if (stripEl) stripEl.style.display = 'none';
    document.body.classList.remove('isi-locked');
}

function handleLockValue(lock) {
    const now = Date.now();
    if (!lock || !lock.until || now >= lock.until) {
        currentLock = null;
        hideLock();
        return;
    }
    currentLock = lock;
    showLock(lock);
    maybeHardReset(lock);
}

// ── Hard reset / hard refresh on Level-2 events (fires once per event) ──
function maybeHardReset(lock) {
    if (lock.level !== 2) return;
    const guardKey = 'isi_lock_handled_' + lockPath();
    if (sessionStorage.getItem(guardKey) === String(lock.setAt)) return;
    sessionStorage.setItem(guardKey, String(lock.setAt));

    setTimeout(() => {
        if (typeof window.ISI_hardResetPreEntry === 'function') {
            window.ISI_hardResetPreEntry(lock.reason);
        } else {
            window.location.reload();
        }
    }, 600); // let the overlay/strip paint first so the trader sees WHY
}

// ── Firebase listener — re-attaches if the selected account changes ──
let detachCurrent = null;
function attachListener() {
    if (typeof detachCurrent === 'function') detachCurrent();
    const path = lockPath();
    const r = ref(db, path);
    const cb = onValue(r, snap => handleLockValue(snap.val()));
    detachCurrent = () => { try { cb(); } catch (e) {} };
}

let lastPath = null;
function watchAccountSwitch() {
    const p = lockPath();
    if (p !== lastPath) {
        lastPath = p;
        attachListener();
    }
}
setInterval(watchAccountSwitch, 1500);
watchAccountSwitch();

// ── Public trigger API — called from preentry.js / terminal.js ──
window.ISI_triggerLock = async function (level, minutes, reason, source) {
    try {
        const path = lockPath();
        const r = ref(db, path);
        const now = Date.now();
        const newUntil = now + minutes * 60000;

        const snap = await get(r);
        const existing = snap.val();
        // Never downgrade or shorten an already-active, equal-or-stronger lock.
        if (existing && existing.until > now && existing.level >= level && existing.until >= newUntil) {
            return;
        }
        await set(r, { level, until: newUntil, reason, source, setAt: now });
    } catch (e) {
        console.error('ISI_triggerLock failed:', e);
    }
};

// Cross-tab safety net: if another tab writes the forced-reset signal
// (used as a fallback when Firebase is briefly unreachable), honor it here too.
window.addEventListener('storage', (e) => {
    if (e.key === 'isi_force_preentry_reset' && typeof window.ISI_hardResetPreEntry === 'function') {
        window.ISI_hardResetPreEntry('Forced reset signal received.');
    }
});
