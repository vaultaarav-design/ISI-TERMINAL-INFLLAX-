/**
 * ISI Terminal v6 — RISK GUARD ENGINE  (v2 — hardened)
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
 *     amount (BALANCE-AT-DAY-START × risk%  — see FIX #1 below).
 *
 *  2) The moment today's loss crosses the allowed amount, it fires the
 *     existing system-wide lock (system-lock.js) — full freeze, red
 *     warning strip, countdown — until the Daybook resets (or longer,
 *     if this is a repeat/consecutive breach — see FIX #6). Daybook
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
 * ══════════════════════════════════════════════════════════════
 * FIXES IN THIS VERSION
 * ══════════════════════════════════════════════════════════════
 *  FIX #1 — BALANCE-AT-DAY-START (not live balance)
 *      Risk amount for a given day is now frozen the FIRST time this
 *      engine sees that day (isi_v6/risk_guard_daybal/{c}/{n}/{date}).
 *      Every later check that day re-reads that frozen snapshot, so a
 *      losing trade mid-day no longer shrinks the allowance under you
 *      (which used to cause an early "fake" breach).
 *
 *  FIX #2 — BREACH / DEBT AUDIT TRAIL
 *      Every accrual, pay-down, breach, manual clear and manual
 *      reprocess is appended (never overwritten) to
 *      isi_v6/risk_guard_log/{clusterId}/{nodeIdx}/{pushId}. The
 *      Risk Guard dashboard has a "📜 History" button per card that
 *      reads this log.
 *
 *  FIX #3 — CLEAR DEBT / REPROCESS LOGGED
 *      Both manual-override actions push a 'manual_clear_debt' /
 *      'manual_reprocess' entry to the same audit log (FIX #2) with
 *      before/after debt values, so a silent override is no longer
 *      silent.
 *
 *  FIX #4 — MULTI-SESSION AWARE
 *      computeDayAllowance() now sums the risk% × day-start-balance
 *      across EVERY session slot configured for that day (not just
 *      slot[0]), so a 2nd/3rd session's own Risk% is no longer
 *      bypassed.
 *
 *  FIX #5 — BROWSER / SW NOTIFICATIONS
 *      On a NEW breach (transition from not-breached → breached) this
 *      engine fires a native browser notification (via the Service
 *      Worker if registered, so it can still show while the tab is
 *      backgrounded) so the trader gets an out-of-tab alert. See the
 *      note in the code below for the hard limitation: a fully CLOSED
 *      app/browser cannot receive this without a server-push (FCM +
 *      Cloud Functions) backend, which this static frontend does not
 *      have configured. window.ISI_requestRiskGuardNotifyPermission()
 *      is exposed for the UI to ask for permission.
 *
 *  FIX #6 — CONSECUTIVE-BREACH ESCALATION
 *      state.consecutiveBreachDays tracks a streak of back-to-back
 *      breach days. Lock duration now scales with the streak:
 *        1st breach in a streak → locked until normal Daybook reset
 *        2nd consecutive        → + 1 extra full day locked
 *        3rd+ consecutive       → + 2 extra full days locked (capped)
 *      A clean (non-breach) day resets the streak to 0.
 *
 * DATA
 * ----
 * isi_v6/risk_guard/{clusterId}/{nodeIdx} = {
 *     debt:                number,       // outstanding accumulated debt
 *     lastProcessedDate:    'YYYY-MM-DD', // last trading day folded into `debt`
 *     breachedToday:        boolean,      // live: today's loss > effective allowance
 *     lastBreachDate:       'YYYY-MM-DD'|null,
 *     lastCheckedAt:        ISOString,
 *     consecutiveBreachDays: number       // FIX #6
 * }
 * isi_v6/risk_guard_daybal/{clusterId}/{nodeIdx}/{date} = number   // FIX #1
 * isi_v6/risk_guard_log/{clusterId}/{nodeIdx}/{pushId}  = {...}    // FIX #2/#3
 * ══════════════════════════════════════════════════════════════
 */
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, get, set, push } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

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

// FIX #6 — escalation cap (extra full days added beyond the normal
// Daybook-reset lock once a breach streak reaches 3+ consecutive days).
const MAX_ESCALATION_EXTRA_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

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
function ordinal(n) {
    const s = ['th','st','nd','rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
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

// ══════════════════════════════════════════════════════════════
// FIX #1 — BALANCE-AT-DAY-START
// The very first time this engine looks at a given (account, date)
// combo, it snapshots the CURRENT live balance and freezes it as that
// day's calculation base. Every subsequent check that day re-reads the
// same frozen number, so intra-day losses can't shrink the allowance
// out from under an already-running session.
// Idempotent: if a snapshot already exists for that date, it is
// returned as-is and never overwritten.
// ══════════════════════════════════════════════════════════════
async function getDayStartBalance(clusterId, nodeIdx, dateStr, liveBalFallback) {
    const balRef = ref(db, `isi_v6/risk_guard_daybal/${clusterId}/${nodeIdx}/${dateStr}`);
    try {
        const snap = await get(balRef);
        if (snap.exists() && typeof snap.val() === 'number') return snap.val();
        const snapshotVal = liveBalFallback || 0;
        await set(balRef, snapshotVal);
        return snapshotVal;
    } catch (e) {
        console.warn('Risk Guard: day-start balance snapshot failed:', e);
        return liveBalFallback || 0;
    }
}

// ══════════════════════════════════════════════════════════════
// FIX #4 — MULTI-SESSION AWARE ALLOWANCE
// Sums risk% × day-start-balance across EVERY slot configured for
// that weekday (previously only slots[0] was read, silently
// bypassing a 2nd/3rd session's own Risk% setting).
// ══════════════════════════════════════════════════════════════
function computeDayAllowance(node, dateStr, balAtDayStart) {
    const dayName = dayNameForDateStr(dateStr);
    const slots = getNodeSlotsForDay(node, dayName);
    if (!slots.length) return { riskPct: 0, riskAmt: 0, hasSession: false, slots: [] };

    const slotBreakdown = slots.map(slot => {
        const riskPct = slot.risk ?? node.risk ?? 0;
        const riskAmt = (balAtDayStart || 0) * riskPct / 100;
        return { slotIdx: slot.slotIdx, start: slot.start, end: slot.end || '', riskPct, riskAmt };
    });
    const riskAmt = slotBreakdown.reduce((sum, s) => sum + s.riskAmt, 0);
    const riskPct = balAtDayStart > 0 ? (riskAmt / balAtDayStart) * 100 : 0;
    return { riskPct, riskAmt, hasSession: true, slots: slotBreakdown };
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

// ══════════════════════════════════════════════════════════════
// FIX #2 / #3 — AUDIT LOG (append-only, never overwritten)
// ══════════════════════════════════════════════════════════════
async function logRiskEvent(clusterId, nodeIdx, entry) {
    try {
        await push(ref(db, `isi_v6/risk_guard_log/${clusterId}/${nodeIdx}`), {
            ts: new Date().toISOString(),
            ...entry,
        });
    } catch (e) {
        console.warn('Risk Guard: audit log write failed:', e);
    }
}

// ══════════════════════════════════════════════════════════════
// FIX #5 — NOTIFICATIONS
// Fires a native browser notification (via the registered Service
// Worker where available, so it can still surface while the tab is
// backgrounded/minimized). HARD LIMITATION: if the app/browser is
// fully CLOSED (not just backgrounded), this client-side call cannot
// reach the trader at all — that requires a server-push channel
// (Firebase Cloud Messaging + a Cloud Function trigger on
// isi_v6/risk_guard writes) which is backend infra this static
// frontend does not currently have deployed.
// ══════════════════════════════════════════════════════════════
function notifyBreach(node, curr, effectiveAllowToday, todayLoss, overage, consecutive) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const title = `🚫 Risk Guard — ${node.title || 'Account'} LOCKED`;
    const streakNote = consecutive > 1 ? ` — ${ordinal(consecutive)} consecutive breach` : '';
    const body = `Loss ${curr}${todayLoss.toFixed(2)} crossed allowed ${curr}${effectiveAllowToday.toFixed(2)} (overage ${curr}${overage.toFixed(2)})${streakNote}. Daybook reset tak locked.`;
    try {
        if (navigator.serviceWorker && navigator.serviceWorker.ready) {
            navigator.serviceWorker.ready.then(reg => {
                if (reg && reg.showNotification) {
                    reg.showNotification(title, {
                        body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
                        tag: 'isi-risk-guard', requireInteraction: true,
                    });
                } else {
                    new Notification(title, { body, icon: 'icons/icon-192.png' });
                }
            }).catch(() => { try { new Notification(title, { body }); } catch (e2) {} });
        } else {
            new Notification(title, { body, icon: 'icons/icon-192.png' });
        }
    } catch (e) {
        console.warn('Risk Guard: notification failed:', e);
    }
}

// Called by the UI (Settings / Risk Guard page) to ask for permission.
// Returns 'granted' | 'denied' | 'default' | 'unsupported'.
window.ISI_requestRiskGuardNotifyPermission = async function () {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
        return Notification.permission;
    }
    try { return await Notification.requestPermission(); }
    catch (e) { return 'default'; }
};
window.ISI_riskGuardNotifyPermission = function () {
    return ('Notification' in window) ? Notification.permission : 'unsupported';
};

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
        state = snap.val() || {
            debt: 0, lastProcessedDate: null, breachedToday: false,
            lastBreachDate: null, consecutiveBreachDays: 0,
        };
        if (state.consecutiveBreachDays === undefined) state.consecutiveBreachDays = 0; // back-compat
    } catch (e) {
        console.warn('Risk Guard: could not read state:', e);
        return;
    }

    // ── ROLLOVER: fold every fully-closed day since last check into `debt`.
    // IMPORTANT: start from lastProcessedDate ITSELF (not +1) — that day
    // was still "today" (in progress) the last time we checked, so its
    // own breach/overage was never folded into `debt` yet. Only once a
    // later date confirms it's fully closed do we settle it here. ──
    if (state.lastProcessedDate && state.lastProcessedDate < today) {
        let cursor = state.lastProcessedDate;
        let guard = 0;
        while (cursor < today && guard < 90) {
            // FIX #1 — use that day's OWN frozen day-start balance, not live.
            const dayStartBal = await getDayStartBalance(clusterId, nodeIdx, cursor, liveBal);
            // FIX #4 — allowance now sums every session slot for that day.
            const dayAllow  = computeDayAllowance(node, cursor, dayStartBal);
            const netPL     = await getDayNetPL(clusterId, nodeIdx, cursor);
            const lossThatDay    = netPL < 0 ? Math.abs(netPL) : 0;
            const debtBefore     = state.debt || 0;
            const effectiveAllow = Math.max(0, dayAllow.riskAmt - debtBefore);

            if (dayAllow.hasSession && lossThatDay > effectiveAllow) {
                const added = lossThatDay - effectiveAllow;
                state.debt = debtBefore + added;
                state.consecutiveBreachDays = (state.consecutiveBreachDays || 0) + 1; // FIX #6
                logRiskEvent(clusterId, nodeIdx, {
                    type: 'debt_accrue', date: cursor,
                    dayStartBalance: dayStartBal, dayAllowedAmt: dayAllow.riskAmt,
                    lossThatDay, effectiveAllow, debtBefore, debtAdded: added, debtAfter: state.debt,
                    consecutiveBreachDays: state.consecutiveBreachDays,
                });
            } else {
                const paidDown = dayAllow.hasSession ? Math.max(0, effectiveAllow - lossThatDay) : 0;
                state.debt = Math.max(0, debtBefore - paidDown);
                state.consecutiveBreachDays = 0; // FIX #6 — clean day resets the streak
                if (debtBefore > 0 || paidDown > 0) {
                    logRiskEvent(clusterId, nodeIdx, {
                        type: 'debt_paydown', date: cursor,
                        dayStartBalance: dayStartBal, dayAllowedAmt: dayAllow.riskAmt,
                        lossThatDay, effectiveAllow, debtBefore, paidDown, debtAfter: state.debt,
                    });
                }
            }
            cursor = addDaysStr(cursor, 1);
            guard++;
        }
    }
    state.lastProcessedDate = today;

    // ── TODAY: live breach check against remaining effective allowance ──
    // FIX #1 — frozen day-start balance for TODAY too (locked in on first
    // check of the day, not re-derived from live balance every time).
    const todayStartBal = await getDayStartBalance(clusterId, nodeIdx, today, liveBal);
    // FIX #4 — multi-session-aware allowance.
    const todayAllow = computeDayAllowance(node, today, todayStartBal);
    const todayNet    = await getDayNetPL(clusterId, nodeIdx, today);
    const todayLoss   = todayNet < 0 ? Math.abs(todayNet) : 0;
    const effectiveAllowToday = Math.max(0, todayAllow.riskAmt - (state.debt || 0));

    const wasBreachedBefore = !!state.breachedToday;
    let breachedToday = false;
    if (todayAllow.hasSession && todayLoss > effectiveAllowToday) {
        breachedToday = true;
        state.lastBreachDate = today;
        const overage = todayLoss - effectiveAllowToday;

        // FIX #6 — escalate lock duration with the consecutive-breach streak.
        // Today's own breach counts as +1 on top of whatever streak the
        // rollover already confirmed from prior closed days.
        const effectiveStreak = (state.consecutiveBreachDays || 0) + 1;
        const extraDays = Math.min(effectiveStreak - 1, MAX_ESCALATION_EXTRA_DAYS);
        const untilTs   = nextResetTimestamp() + extraDays * DAY_MS;
        const minutes   = Math.max(1, Math.ceil((untilTs - Date.now()) / 60000));

        const streakNote = effectiveStreak > 1
            ? ` — ${ordinal(effectiveStreak)} CONSECUTIVE breach, lock extended ${extraDays} extra din.`
            : '';
        if (typeof window.ISI_triggerLock === 'function') {
            window.ISI_triggerLock(
                3, minutes,
                `${node.title || 'Account ' + (Number(nodeIdx) + 1)}: Daily risk limit cross ho gaya — allowed ${curr}${effectiveAllowToday.toFixed(2)}, actual loss ${curr}${todayLoss.toFixed(2)} (overage ${curr}${overage.toFixed(2)}).${streakNote} Daybook reset tak locked.`,
                'Risk Guard'
            );
        }

        // Only fire notification + audit log on the NEW transition into breach,
        // not on every 60s re-check while still breached.
        if (!wasBreachedBefore) {
            notifyBreach(node, curr, effectiveAllowToday, todayLoss, overage, effectiveStreak);
            logRiskEvent(clusterId, nodeIdx, {
                type: 'breach', date: today,
                dayStartBalance: todayStartBal, dayAllowedAmt: todayAllow.riskAmt,
                effectiveAllowToday, todayLoss, overage,
                consecutiveBreachDays: effectiveStreak, lockMinutes: minutes, extraDaysLocked: extraDays,
            });
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
        daySlots: todayAllow.slots, // FIX #4 — per-session breakdown for the UI
        hasSession: todayAllow.hasSession,
        todayNetPL: todayNet, todayLossAmt: todayLoss,
        effectiveAllowToday,
        dayStartBalance: todayStartBal, // FIX #1 — expose to UI
        liveBalance: liveBal,
    };
    window.dispatchEvent(new CustomEvent('isi-riskguard-update'));
    if (window.ISI_applyRiskGuardOverlay) window.ISI_applyRiskGuardOverlay();
}

window.ISI_checkRiskGuard = checkRiskGuard;

// Manual override — trader can clear a stuck/incorrect debt from the Risk Guard page.
// FIX #3 — this is now logged (never silent).
window.ISI_clearRiskDebt = async function (clusterId, nodeIdx) {
    const guardRef = ref(db, `isi_v6/risk_guard/${clusterId}/${nodeIdx}`);
    try {
        const snap = await get(guardRef);
        const state = snap.val() || {};
        const debtBefore = state.debt || 0;
        state.debt = 0;
        state.breachedToday = false;
        state.consecutiveBreachDays = 0;
        await set(guardRef, state);
        await logRiskEvent(clusterId, nodeIdx, {
            type: 'manual_clear_debt', debtBefore, debtAfter: 0,
        });
    } catch (e) {
        console.warn('Risk Guard: clear debt failed:', e);
    }
};

// Manual override — re-walk this account's full trade history from a chosen
// date forward, correctly folding every day's result into `debt`. Use this
// to fix an account whose debt tracking got stuck/desynced (e.g. after an
// engine bug, or after manually editing trade history).
// FIX #3 — this is now logged (never silent).
window.ISI_reprocessRiskGuard = async function (clusterId, nodeIdx, fromDateStr) {
    const guardRef = ref(db, `isi_v6/risk_guard/${clusterId}/${nodeIdx}`);
    let debtBefore = 0;
    try {
        const snap = await get(guardRef);
        debtBefore = (snap.val() || {}).debt || 0;
        await set(guardRef, {
            debt: 0,
            lastProcessedDate: fromDateStr,
            breachedToday: false,
            lastBreachDate: null,
            consecutiveBreachDays: 0,
        });
        await logRiskEvent(clusterId, nodeIdx, {
            type: 'manual_reprocess', fromDate: fromDateStr, debtBefore,
        });
    } catch (e) {
        console.warn('Risk Guard: reprocess reset failed:', e);
        return;
    }
    await checkRiskGuard(clusterId, nodeIdx);
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
        const streak = state.consecutiveBreachDays || 0;
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
            ${streak > 1 ? `<div style="font-size:0.45rem;color:#ff9e9e;font-weight:700;">🔥 ${streak}x consecutive breach</div>` : ''}
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
    getDayStartBalance, ordinal,
};
