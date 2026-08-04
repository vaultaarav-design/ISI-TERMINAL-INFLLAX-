/**
 * ISI Terminal v6 — RISK GUARD ENGINE
 * ══════════════════════════════════════════════════════════════
 * Loaded on preentry.html, terminal.html and risk-guard.html.
 *
 * WHAT IT DOES
 * ------------
 * Every account (cluster/node) already has a per-day "allowed risk %"
 * configured in Settings (the same number the Pre-Entry/Terminal
 * slider cards show once a session window goes green). This engine:
 *
 *  1) Watches how much that account has actually LOST today (net P/L,
 *     only counted when negative) against that day's allowed risk
 *     amount (balance × risk%).
 *
 *  2) The moment today's loss crosses the allowed amount, it fires the
 *     existing system-wide lock (system-lock.js) — full freeze, red
 *     warning strip, countdown — until the Daybook resets. Daybook
 *     resets on the UTC calendar day rollover, i.e. ~05:30 AM IST
 *     (see session.js / window._ISIDate) — NOT local midnight.
 *
 *  3) Whatever amount was lost BEYOND the allowed risk becomes that
 *     account's "risk accumulation debt". This debt carries into the
 *     next trading day and eats into that day's allowance FIRST:
 *         effective allowance (next day) = day's normal allowance − debt
 *     If a day passes where the actual loss stays under that reduced
 *     effective allowance, the unused portion pays the debt down. A
 *     profitable/flat day pays down the FULL effective allowance.
 *     This repeats — day after day — until the debt reaches zero.
 *
 *  4) As long as an account carries ANY outstanding debt (however
 *     small), that account's card on BOTH the Pre-Entry slider and the
 *     Terminal slider is painted dark red with a "🚫 RISK LOCKED"
 *     ribbon and cannot be selected for a new session — even outside
 *     the full-system lock window — until the debt clears to zero.
 *
 * DATA
 * ----
 * isi_v6/risk_guard/{clusterId}/{nodeIdx} = {
 *     debt:              number,      // outstanding accumulated debt
 *     lastProcessedDate: 'YYYY-MM-DD', // last trading day folded into `debt`
 *     breachedToday:     boolean,      // live: today's loss > effective allowance
 *     lastBreachDate:    'YYYY-MM-DD'|null,
 *     lastCheckedAt:     ISOString
 * }
 * ══════════════════════════════════════════════════════════════
 */
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, get, set } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};

const rgApp = getApps().find(a => a.name === 'isiRiskGuard') || initializeApp(firebaseConfig, 'isiRiskGuard');
const db = getDatabase(rgApp);

// ── LIVE CACHES ──
let clustersCache   = {};
let liveStatsCache  = {};
export const riskGuardCache = {}; // { [clusterId]: { [nodeIdx]: {...state, curr, blocked, ...live} } }
window.ISI_riskGuardCache = riskGuardCache;

onValue(ref(db, 'isi_v6/clusters'), snap => { clustersCache = snap.val() || {}; });
onValue(ref(db, 'isi_v6/stats'),    snap => { liveStatsCache = snap.val() || {}; });
onValue(ref(db, 'isi_v6/risk_guard'), snap => {
    const raw = snap.val() || {};
    Object.entries(raw).forEach(([cId, nodes]) => {
        Object.entries(nodes || {}).forEach(([nIdx, st]) => {
            riskGuardCache[cId] = riskGuardCache[cId] || {};
            const node = clustersCache[cId]?.nodes?.[nIdx];
            const prev = riskGuardCache[cId][nIdx] || {};
            riskGuardCache[cId][nIdx] = {
                ...prev, ...st,
                curr: node?.curr || prev.curr || '₹',
                blocked: (st.debt || 0) > 0,
            };
        });
    });
    window.dispatchEvent(new CustomEvent('isi-riskguard-update'));
    if (window.ISI_applyRiskGuardOverlay) window.ISI_applyRiskGuardOverlay();
});

// ── DATE / DAY HELPERS (same UTC-rollover convention as the rest of the app) ──
function todayStr() {
    return window._ISIDate ? window._ISIDate.todayStr() : new Date().toISOString().slice(0, 10);
}
function dayNameForDateStr(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    return ['SUN','MON','TUE','WED','THU','FRI','SAT'][d.getUTCDay()];
}
function addDaysStr(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
function nextResetTimestamp() {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
}

// ── Same slot-lookup logic used by preentry.js / terminal.js sliders ──
function getNodeSlotsForDay(node, dayName) {
    if (!node) return [];
    if (node.timeSlots && node.timeSlots[dayName] && Array.isArray(node.timeSlots[dayName])) {
        return node.timeSlots[dayName]
            .filter(sl => sl && sl.start)
            .map((sl, i) => ({ ...sl, slotIdx: i }));
    }
    if (node.times && node.times[dayName] && node.times[dayName].start) {
        const t = node.times[dayName];
        return [{ start: t.start, end: t.end || '', expire: t.expire || '',
            risk: node.risk ?? null, qtyFrom: node.qtyFrom || 1, qtyTo: node.qtyTo || 10, slotIdx: 0 }];
    }
    return [];
}

function computeDayAllowance(node, dateStr, liveBal) {
    const dayName = dayNameForDateStr(dateStr);
    const slots = getNodeSlotsForDay(node, dayName);
    if (!slots.length) return { riskPct: 0, riskAmt: 0, hasSession: false };
    const slot = slots[0];
    const riskPct = slot.risk ?? node.risk ?? 0;
    const riskAmt = (liveBal || 0) * riskPct / 100;
    return { riskPct, riskAmt, hasSession: true };
}

async function getDayNetPL(clusterId, nodeIdx, dateStr) {
    try {
        const snap = await get(ref(db, `isi_v6/clusters/${clusterId}/nodes/${nodeIdx}/tradeHistory`));
        const val = snap.val();
        if (!val) return 0;
        let net = 0;
        Object.values(val).forEach(t => { if (t && t.date === dateStr) net += (Number(t.pl) || 0); });
        return net;
    } catch (e) {
        console.warn('Risk Guard: could not read tradeHistory for', clusterId, nodeIdx, dateStr, e);
        return 0;
    }
}

// ── CORE ENGINE — safe to call repeatedly; only settles CLOSED days once ──
async function checkRiskGuard(clusterId, nodeIdx) {
    if (!clusterId || nodeIdx === null || nodeIdx === undefined || nodeIdx === '') return;
    const node = clustersCache[clusterId]?.nodes?.[nodeIdx];
    if (!node) return;

    const today   = todayStr();
    const stats   = liveStatsCache[clusterId]?.[String(nodeIdx)] || {};
    const liveBal = stats.currentBal ?? node.balance ?? 0;
    const curr    = node.curr || '₹';

    const guardRef = ref(db, `isi_v6/risk_guard/${clusterId}/${nodeIdx}`);
    let state;
    try {
        const snap = await get(guardRef);
        state = snap.val() || { debt: 0, lastProcessedDate: null, breachedToday: false, lastBreachDate: null };
    } catch (e) {
        console.warn('Risk Guard: could not read state:', e);
        return;
    }

    // ── ROLLOVER: fold every fully-closed day since last check into `debt` ──
    if (state.lastProcessedDate && state.lastProcessedDate < today) {
        let cursor = addDaysStr(state.lastProcessedDate, 1);
        let guard = 0;
        while (cursor < today && guard < 45) {
            const dayAllow = computeDayAllowance(node, cursor, liveBal);
            const netPL    = await getDayNetPL(clusterId, nodeIdx, cursor);
            const lossThatDay      = netPL < 0 ? Math.abs(netPL) : 0;
            const effectiveAllow   = Math.max(0, dayAllow.riskAmt - (state.debt || 0));
            if (lossThatDay > effectiveAllow) {
                state.debt = (state.debt || 0) + (lossThatDay - effectiveAllow);
            } else {
                const paidDown = effectiveAllow - lossThatDay;
                state.debt = Math.max(0, (state.debt || 0) - paidDown);
            }
            cursor = addDaysStr(cursor, 1);
            guard++;
        }
    }
    state.lastProcessedDate = today;

    // ── TODAY: live breach check against remaining effective allowance ──
    const todayAllow = computeDayAllowance(node, today, liveBal);
    const todayNet    = await getDayNetPL(clusterId, nodeIdx, today);
    const todayLoss   = todayNet < 0 ? Math.abs(todayNet) : 0;
    const effectiveAllowToday = Math.max(0, todayAllow.riskAmt - (state.debt || 0));

    let breachedToday = false;
    if (todayAllow.hasSession && todayLoss > effectiveAllowToday) {
        breachedToday = true;
        state.lastBreachDate = today;
        const overage  = todayLoss - effectiveAllowToday;
        const untilTs  = nextResetTimestamp();
        const minutes  = Math.max(1, Math.ceil((untilTs - Date.now()) / 60000));
        if (typeof window.ISI_triggerLock === 'function') {
            window.ISI_triggerLock(
                3, minutes,
                `${node.title || 'Account ' + (Number(nodeIdx) + 1)}: Daily risk limit cross ho gaya — allowed ${curr}${effectiveAllowToday.toFixed(2)}, actual loss ${curr}${todayLoss.toFixed(2)} (overage ${curr}${overage.toFixed(2)}). Daybook reset tak locked.`,
                'Risk Guard'
            );
        }
    }
    state.breachedToday = breachedToday;
    state.lastCheckedAt = new Date().toISOString();

    try { await set(guardRef, state); } catch (e) { console.warn('Risk Guard: could not persist state:', e); }

    riskGuardCache[clusterId] = riskGuardCache[clusterId] || {};
    riskGuardCache[clusterId][nodeIdx] = {
        ...state, curr,
        blocked: (state.debt || 0) > 0,
        dayAllowedAmt: todayAllow.riskAmt, dayAllowedPct: todayAllow.riskPct,
        hasSession: todayAllow.hasSession,
        todayNetPL: todayNet, todayLossAmt: todayLoss,
        effectiveAllowToday,
    };
    window.dispatchEvent(new CustomEvent('isi-riskguard-update'));
    if (window.ISI_applyRiskGuardOverlay) window.ISI_applyRiskGuardOverlay();
}

window.ISI_checkRiskGuard = checkRiskGuard;

// Manual override — trader can clear a stuck/incorrect debt from the Risk Guard page.
window.ISI_clearRiskDebt = async function (clusterId, nodeIdx) {
    const guardRef = ref(db, `isi_v6/risk_guard/${clusterId}/${nodeIdx}`);
    try {
        const snap = await get(guardRef);
        const state = snap.val() || {};
        state.debt = 0;
        state.breachedToday = false;
        await set(guardRef, state);
    } catch (e) {
        console.warn('Risk Guard: clear debt failed:', e);
    }
};

// ── Periodic safety-net check for the currently selected account ──
setInterval(() => {
    const cId  = localStorage.getItem('isi_sel_cluster');
    const nIdx = localStorage.getItem('isi_sel_node');
    if (cId && nIdx !== null && nIdx !== '') checkRiskGuard(cId, parseInt(nIdx)).catch(() => {});
}, 60000);

// ── OVERLAY — paints a dark-red "RISK LOCKED" ribbon on any slider card
//    (Pre-Entry or Terminal) belonging to an account with debt > 0 ──
window.ISI_applyRiskGuardOverlay = function () {
    document.querySelectorAll('.pe-slide-card, .s-timer-card').forEach(card => {
        const cId     = card.dataset.cluster;
        const nIdxStr = card.dataset.node;
        if (cId === undefined || nIdxStr === undefined) return;
        const state = riskGuardCache[cId]?.[nIdxStr];
        card.style.position = 'relative';
        if (!state || !state.blocked) {
            const old = card.querySelector('.isi-rg-ribbon');
            if (old) old.remove();
            return;
        }
        card.style.borderColor = '#7a0000';
        card.style.boxShadow   = '0 0 14px rgba(122,0,0,0.6)';
        if (card.querySelector('.isi-rg-ribbon')) return; // already painted
        const ribbon = document.createElement('div');
        ribbon.className = 'isi-rg-ribbon';
        ribbon.style.cssText = `
            position:absolute; inset:0; z-index:6; border-radius:inherit;
            background:rgba(35,0,0,0.64); display:flex; flex-direction:column;
            align-items:center; justify-content:center; gap:3px; text-align:center;
            padding:6px; cursor:not-allowed;
        `;
        ribbon.innerHTML = `
            <div style="font-size:0.6rem;font-weight:900;color:#ff5252;letter-spacing:1px;">🚫 RISK LOCKED</div>
            <div style="font-size:0.47rem;color:#ffb3b3;line-height:1.3;">Last session risk cross hua — is season allowed nahi</div>
            <div style="font-size:0.5rem;color:#ff8080;font-family:monospace;">Owed: ${state.curr || ''}${(state.debt || 0).toFixed(2)}</div>
        `;
        ['click', 'touchstart'].forEach(evt =>
            ribbon.addEventListener(evt, e => { e.stopPropagation(); e.preventDefault(); }, true)
        );
        card.appendChild(ribbon);
    });
};

// Expose helpers for the Risk Guard dashboard page.
window.ISI_RiskGuardEngine = {
    clustersCache: () => clustersCache,
    liveStatsCache: () => liveStatsCache,
    computeDayAllowance, getDayNetPL, todayStr, dayNameForDateStr, nextResetTimestamp,
};
