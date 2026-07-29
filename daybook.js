// ══════════════════════════════════════════════════════════════════
// ISI DAYBOOK — v6.0
// This page is now the app's index/landing page. It owns the
// Oath + Password gate (moved here from Terminal). Once unlocked it
// activates the shared _ISISession, which every other page (Terminal,
// Pre-Entry, Monitoring, etc.) checks before allowing access.
// ══════════════════════════════════════════════════════════════════
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { renderAllTradesReportUI } from "./all-trades-report.js";
import { renderTermSmiReportUI } from "./smi-terminal-report.js";

const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};
// Reuse the same named 'newsPopup' app instance other pages already use,
// so we never collide with a page's own default initializeApp() call.
const existing = getApps().find(a => a.name === 'newsPopup');
const app = existing || initializeApp(firebaseConfig, 'newsPopup');
const db  = getDatabase(app);

// ──────────────────────────────────────────────
// OATH + PASSWORD GATE
// ──────────────────────────────────────────────
const oaths = [
    "Discipline First: Main profit ke liye trade nahi karta. Profit rules ka by-product hai. 🧠",
    "Permission Rule: Agar system allow nahi karta, to main trade nahi karta. 🚦",
    "Risk Authority: Risk mera boss hai. ⚖️",
    "Self-Control: Market mujhe control nahi karega. Main apne actions control karunga. 🪞",
    "No Revenge: Loss ke baad discipline maintain karna hai. ❌🔥",
    "Timing Law: Galat time pe sahi trade bhi galat hota hai. ⏱️",
    "Process Loyalty: Main outcome ka slave nahi hoon. Main process ka follower hoon. 📊",
    "Identity: Main trader nahi hoon. Main system operator hoon. 🏆",
    "Patience Protocol: Valid setup ka wait karna mera kaam hai. ⏳",
    "Calm Mind: Fast mind galti karta hai. Calm mind execute karta hai. 🌊",
    "Final Command: Aaj ka goal perfect execution hai. Profit khud follow karega. 🎖️"
];
const MASTER_KEY = 'Akanksha';

function getAllPermKeys() {
    const stored = JSON.parse(localStorage.getItem('isi_perm_keys') || '[]');
    if (!stored.includes(MASTER_KEY)) stored.unshift(MASTER_KEY);
    return stored;
}

window.verifyOathPassword = function () {
    const input = document.getElementById('oathPassInput');
    const errEl = document.getElementById('oathPassError');
    const val   = input?.value?.trim() || '';

    if (getAllPermKeys().includes(val)) { _unlockDaybook(); return; }

    const tempData = JSON.parse(localStorage.getItem('isi_temp_pass') || 'null');
    if (tempData && tempData.pass && tempData.expires) {
        if (val === tempData.pass && Date.now() < tempData.expires) { _unlockDaybook(); return; }
    }

    if (errEl) errEl.style.display = 'block';
    if (input) { input.value = ''; input.focus(); }
};

function _unlockDaybook() {
    document.getElementById('oathPopup').style.display = 'none';
    localStorage.setItem('isi_oath_date', window._ISIDate ? window._ISIDate.todayStr() : new Date().toISOString().split('T')[0]);
    const errEl = document.getElementById('oathPassError');
    if (errEl) errEl.style.display = 'none';
    // Session activates HERE — this is the single moment every other page
    // (Terminal included) will trust. Popups / gatekeepers on other pages
    // only ever run after this fires.
    if (window._ISISession) window._ISISession.activate();
    loadLiveData(); // start pulling snapshot/news only after auth succeeds
}

window.addEventListener('DOMContentLoaded', () => {
    const popup = document.getElementById('oathPopup');
    const d     = document.getElementById('oathDisplay');
    if (d) d.innerText = oaths[Math.floor(Math.random() * oaths.length)];
    // ALWAYS show the gate on Daybook load — every single time, no bypass,
    // regardless of any leftover/active session flag from a previous visit.
    if (popup) popup.style.display = 'flex';
    const pi = document.getElementById('oathPassInput');
    if (pi) { pi.value = ''; setTimeout(() => pi.focus(), 300); }

    document.getElementById('riskDate').textContent = window._ISIDate ? window._ISIDate.displayDate() : new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    const picker = document.getElementById('dbViewDatePicker');
    if (picker) {
        const t = window._ISIDate ? window._ISIDate.todayStr() : new Date().toISOString().split('T')[0];
        picker.value = t;
        picker.max = t; // can't browse a date that hasn't happened yet
    }
});

// ──────────────────────────────────────────────
// LIVE DATA — Today's Snapshot, Cost of Violation/Psychology, MFE/MAE,
// Back-to-back loss warning, Today's Sessions, News (direct, no popup)
// ──────────────────────────────────────────────
import { computeCostReport } from './cost-report.js';

// ── Pre-Entry data (needed to link today's trades to their HTF/LTF/SMC/
// Market-State plan for the Strategy Combo panel) ──
let preentryDataDB = {};
let lastTodayTrades = [];
let preentryListenerStarted = false;
function startPreentryListener() {
    if (preentryListenerStarted) return;
    preentryListenerStarted = true;
    onValue(ref(db, 'isi_v6/preentry'), (snap) => {
        preentryDataDB = snap.val() || {};
        renderStrategyCombosToday(lastTodayTrades);
    });
}

const HTF_MS_LABELS = {
    BOS_BULL:'HTF BOS ▲', BOS_BEAR:'HTF BOS ▼', CHoCH_BULL:'HTF CHoCH ▲',
    CHoCH_BEAR:'HTF CHoCH ▼', RANGE:'HTF Range', TREND_BULL:'HTF Trend ▲'
};
const LTF_MS_LABELS = {
    BOS_BULL:'LTF BOS ▲', BOS_BEAR:'LTF BOS ▼', CHoCH_BULL:'LTF CHoCH ▲',
    CHoCH_BEAR:'LTF CHoCH ▼', CONTRACTION:'LTF Contraction', EXPANSION:'LTF Expansion'
};
const SMM_LABELS = {
    liqHunt:'🎯 Liquidity Hunt', liqPool:'💧 Liquidity Pool', orderBlock:'📦 Order Block',
    fvg:'⬜ FVG / Imbalance', inducement:'🪤 Inducement', manipulation:'🐋 Manipulation',
    distribution:'📤 Distribution', accumulation:'📥 Accumulation',
    wyckoffSpring:'🌀 Wyckoff Spring', stopHunt:'🔫 Stop Hunt Complete'
};
const MSTATE_LABELS = {
    TREND_BULL:'Trending ▲', TREND_BEAR:'Trending ▼', RANGE:'Ranging',
    PRE_BREAKOUT:'Pre-Breakout', POST_BREAKOUT:'Post-Breakout',
    HIGH_VOL:'High Volatility', LOW_VOL:'Low Volatility', REVERSAL_SETUP:'Reversal Setup'
};
const VOL_LABELS = {
    VERY_LOW:'Very Low', LOW:'Low', NORMAL:'Normal', HIGH:'High', EXTREME:'Extreme'
};

// Find the pre-entry record linked to this trade (same logic as Monitoring/Multi-Cluster)
function matchPreEntryDB(t) {
    const recs = preentryDataDB?.[t.clusterId]?.[t.nodeIdx];
    if (!recs) return null;
    if (t.preEntryKey && recs[t.preEntryKey]) return recs[t.preEntryKey];
    const sameDay = Object.values(recs)
        .filter(r => r.date === t.date)
        .sort((a,b) => (b.savedAt||'').localeCompare(a.savedAt||''));
    if (!sameDay.length) return null;
    if (t.savedAt) {
        const before = sameDay.filter(r => (r.savedAt||'') <= t.savedAt);
        if (before.length) return before[0];
    }
    return sameDay[0];
}

function biasArrowDB(htfMs) {
    if (!htfMs) return { sym:'■', color:'#888' };
    if (htfMs.includes('BULL')) return { sym:'▲', color:'var(--accent)' };
    if (htfMs.includes('BEAR')) return { sym:'▼', color:'var(--danger)' };
    return { sym:'■', color:'#ffcc00' };
}

// Group today's trades by (HTF Bias + LTF + SMC + Market State) combo,
// same "Strategy Discovery Engine" as Monitoring — but scoped to today,
// and each row also explicitly shows Market State & Volatility per trade.
function buildStrategyCombosToday(trades) {
    const combos = {};
    trades.forEach(t => {
        const pe = matchPreEntryDB(t);
        if (!pe) return;
        const isWin = t.type === 'Target';
        const pl    = t.pl || 0;

        const htfKey    = pe.htf?.ms || '';
        const htfTag    = htfKey ? (HTF_MS_LABELS[htfKey]||htfKey) : 'No HTF Bias';
        const ltfTag    = pe.ltf?.ms ? (LTF_MS_LABELS[pe.ltf.ms]||pe.ltf.ms) : 'No LTF Read';
        const mstateTag = pe.mstate ? (MSTATE_LABELS[pe.mstate]||pe.mstate) : 'No Market State';
        const volTag    = pe.volatility ? (VOL_LABELS[pe.volatility]||pe.volatility) : 'No Volatility Read';
        const smmList   = (pe.smm||[]).map(k => SMM_LABELS[k]||k);
        const smmTag    = smmList.length ? smmList.slice(0,2).join(' + ') + (smmList.length>2?` +${smmList.length-2}`:'') : 'No SMC Confluence';

        const key = `${htfTag} ▸ ${ltfTag} ▸ ${smmTag} ▸ ${mstateTag}`;
        if (!combos[key]) combos[key] = { key, htfKey, mstateTag, volTag, trades:0, wins:0, losses:0, pl:0 };
        combos[key].trades++;
        if (isWin) combos[key].wins++; else combos[key].losses++;
        combos[key].pl += pl;
    });
    return Object.values(combos)
        .map(c => ({ ...c, winRate: c.trades ? Math.round((c.wins/c.trades)*100) : 0 }))
        .sort((a,b) => b.pl - a.pl);
}

function renderStrategyCombosToday(trades) {
    const el = document.getElementById('strategyCombosList');
    if (!el) return;
    if (!trades.length) {
        el.innerHTML = '<div class="news-empty">Aaj abhi tak koi trade nahi hua.</div>';
        return;
    }
    const combos = buildStrategyCombosToday(trades);
    if (!combos.length) {
        el.innerHTML = '<div class="news-empty">Aaj ke trades ka Pre-Entry record nahi mila — Pre-Entry Analysis page pehle fill karo.</div>';
        return;
    }
    const maxAbsPl = Math.max(1, ...combos.map(c => Math.abs(c.pl)));

    el.innerHTML = combos.map((c, i) => {
        const arrow    = biasArrowDB(c.htfKey);
        const barColor = c.pl >= 0 ? 'var(--accent)' : 'var(--danger)';
        const plStr    = (c.pl >= 0 ? '+' : '') + c.pl.toFixed(2);
        return `
            <div class="combo-row" style="border-left-color:${barColor};">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
                    <div class="combo-key">
                        <span style="color:var(--gold);font-weight:bold;">#${i+1}</span>
                        <span style="color:${arrow.color};font-weight:bold;">${arrow.sym}</span> ${c.key}
                    </div>
                    <div class="combo-badges">
                        <span class="combo-badge">${c.trades}T</span>
                        <span class="combo-badge" style="color:var(--accent);">${c.wins}W</span>
                        <span class="combo-badge" style="color:var(--danger);">${c.losses}L</span>
                        <span style="color:${barColor};font-weight:bold;">${c.winRate}%</span>
                        <span style="color:${barColor};font-weight:900;">${plStr}</span>
                    </div>
                </div>
                <div class="combo-mstate">
                    <span>📍 Market State: ${c.mstateTag}</span>
                    <span>🌪 Volatility: ${c.volTag}</span>
                </div>
            </div>`;
    }).join('');
}

function todayStr() {
    return window._ISIDate ? window._ISIDate.todayStr() : new Date().toISOString().split('T')[0];
}

function loadLiveData() {
    loadClustersData();
    loadNews();
    loadQuickLinks();
    startPreentryListener();
}

function timeToMinutes(t) {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
}

function getSlotsForToday(node, dayName) {
    if (node.timeSlots && node.timeSlots[dayName] && Array.isArray(node.timeSlots[dayName])) {
        return node.timeSlots[dayName].filter(sl => sl && sl.start).map((sl, i) => ({ ...sl, slotIdx: i }));
    }
    if (node.times && node.times[dayName] && node.times[dayName].start) {
        const t = node.times[dayName];
        return [{ start: t.start, end: t.end || '', expire: t.expire || '', risk: node.risk ?? null, slotIdx: 0 }];
    }
    return [];
}

// Today's Net P/L, trades taken, win rate, cost of violation/psychology,
// MFE/MAE list, back-to-back loss check, and today's session schedule —
// ALL derived from one 'isi_v6/clusters' read. Also browsable to any
// PAST date via the View Date picker — same rendering pipeline, just a
// different date is used as the filter, so nothing is duplicated.
let _latestClusters   = {};
let _lastRenderedDate = null;
let viewDate          = todayStr();     // which date the whole page is currently showing
const DAY_NAMES = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

function dayNameForDate(dateStr) {
    // Build the Date from Y/M/D components (not `new Date(dateStr)`,
    // which parses as UTC midnight and can shift a day depending on the
    // browser's local timezone) — this must match the actual calendar
    // weekday of the date being viewed, not a UTC-shifted one.
    const [y, m, d] = dateStr.split('-').map(Number);
    return DAY_NAMES[new Date(y, m - 1, d).getDay()];
}

window.changeDbViewDate = function (newDate) {
    if (!newDate) return;
    viewDate = newDate;
    processToday();
};
window.jumpDbToToday = function () {
    viewDate = todayStr();
    const picker = document.getElementById('dbViewDatePicker');
    if (picker) picker.value = viewDate;
    processToday();
};

function processToday() {
    const clusters   = _latestClusters;
    const today       = viewDate;
    const isHistorical = today !== todayStr();
    _lastRenderedDate = today;
    const dayName = dayNameForDate(today);

    const riskDateEl = document.getElementById('riskDate');
    if (riskDateEl) riskDateEl.textContent = window._ISIDate ? window._ISIDate.displayDate(today) : today;
    const picker = document.getElementById('dbViewDatePicker');
    if (picker && picker.value !== today) picker.value = today;
    const jumpBtn = document.getElementById('dbJumpTodayBtn');
    if (jumpBtn) jumpBtn.style.display = isHistorical ? 'inline-block' : 'none';
    const histNote = document.getElementById('dbHistoricalNote');
    if (histNote) histNote.style.display = isHistorical ? 'block' : 'none';
    const b2bTitle = document.getElementById('b2bTitle');
    if (b2bTitle) b2bTitle.textContent = isHistorical
        ? `⚠ TWO CONSECUTIVE LOSSES WERE TAKEN ON ${window._ISIDate ? window._ISIDate.displayDate(today) : today}`
        : 'STOP — TWO CONSECUTIVE LOSSES DETECTED TODAY';

    const todayTrades = [];
    const upcomingSessions = [];

    Object.entries(clusters).forEach(([cId, cluster]) => {
        (cluster.nodes || []).forEach((node, nIdx) => {
            // Trades
            const hist = node?.tradeHistory || {};
            Object.values(hist).forEach(t => {
                if (t.date === today) {
                    todayTrades.push({ ...t, _curr: t.currency || node.curr || '$', _nodeTitle: node.title || `Account ${nIdx + 1}` });
                }
            });
            // Sessions scheduled for this weekday (Settings/Setup risk schedule)
            getSlotsForToday(node, dayName).forEach(slot => {
                upcomingSessions.push({ cId, node, nIdx, slot });
            });
        });
    });

    lastTodayTrades = todayTrades;
    renderSnapshotAndCosts(todayTrades);
    renderPerformanceRadar(todayTrades);
    renderStrategyCombosToday(todayTrades);
    renderMfeMae(todayTrades);
    renderBackToBackWarning(todayTrades);
    renderUpcomingSessions(upcomingSessions, isHistorical);
    renderNewsForDate(today, isHistorical);

    renderActiveClusters(clusters);

    const reportBtn = document.getElementById('dbFullReportBtn');
    if (reportBtn) reportBtn.style.display = todayTrades.length ? 'inline-block' : 'none';
    const smiBtn = document.getElementById('dbTermSmiBtn');
    if (smiBtn) smiBtn.style.display = todayTrades.length ? 'inline-block' : 'none';
}

// ── TODAY'S FULL REPORT (per-trade cards, reuses the same module as Monitoring) ──
window.openTodayFullReport = function () {
    const modal = document.getElementById('todayFullReportModal');
    const body  = document.getElementById('todayFullReportModalBody');
    if (!modal || !body) return;
    modal.style.display = 'block';
    renderAllTradesReportUI(body, lastTodayTrades || [], db);
};
window.closeTodayFullReport = function () {
    const modal = document.getElementById('todayFullReportModal');
    if (modal) modal.style.display = 'none';
};

// ── SMI: PRE-ENTRY vs TERMINAL (today's trades, reuses Monitoring's module) ──
window.openTodayTermSmiReport = function () {
    const modal = document.getElementById('todayTermSmiModal');
    const body  = document.getElementById('todayTermSmiModalBody');
    if (!modal || !body) return;
    modal.style.display = 'block';
    renderTermSmiReportUI(body, lastTodayTrades || []);
};
window.closeTodayTermSmiReport = function () {
    const modal = document.getElementById('todayTermSmiModal');
    if (modal) modal.style.display = 'none';
};
window.addEventListener('click', (e) => {
    if (e.target.id === 'todayFullReportModal') window.closeTodayFullReport();
    if (e.target.id === 'todayTermSmiModal') window.closeTodayTermSmiReport();
});

function loadClustersData() {
    onValue(ref(db, 'isi_v6/clusters'), (snap) => {
        _latestClusters = snap.val() || {};
        processToday();
    });

    // Firebase's onValue only re-fires when the DATA changes — it does NOT
    // re-fire just because the clock crossed local midnight. Without this,
    // a tab left open overnight keeps showing yesterday's snapshot/cost/
    // radar/etc until something else happens to change in Firebase.
    // Check every 30s and recompute the instant the local calendar date
    // rolls over, so everything auto-resets to a fresh (zero) day on time,
    // not just on the next data write.
    setInterval(() => {
        const nowStr = todayStr();
        // Only auto-advance if the trader was tracking "today" live — if
        // they manually picked a past date via the View Date picker,
        // leave that view exactly as they left it; don't yank them back.
        if (viewDate === _lastRenderedDate && nowStr !== _lastRenderedDate) {
            viewDate = nowStr;
            processToday();
        }
    }, 30 * 1000);
}

// ── Today's Snapshot + Cost of Violation + Cost of Psychology ──
function renderSnapshotAndCosts(todayTrades) {
    const netPl = todayTrades.reduce((s, t) => s + (Number(t.pl) || 0), 0);
    const wins  = todayTrades.filter(t => t.type === 'Target').length;

    const plEl = document.getElementById('snapPL');
    plEl.textContent = (netPl >= 0 ? '+$' : '-$') + Math.abs(netPl).toFixed(2);
    plEl.style.color = netPl >= 0 ? 'var(--accent)' : 'var(--danger)';
    document.getElementById('snapTrades').textContent = todayTrades.length;
    document.getElementById('snapWinRate').textContent = todayTrades.length ? Math.round((wins / todayTrades.length) * 100) + '%' : '—';

    const violationsToday = todayTrades.reduce((s, t) => s + (t.vios || []).length, 0);
    document.getElementById('riskVios').textContent = violationsToday;

    // Cost of Violation / Cost of Psychology — reuse the SAME methodology
    // already used on Monitoring & Multi-Cluster's cost reports, just
    // scoped to today's trades only.
    const report = computeCostReport(todayTrades);
    const curr = report.curr || '$';

    const vioCostEl = document.getElementById('costVioToday');
    const vioCost = report.totals.avoidableVioLoss; // real vs. no-violation equity, today
    vioCostEl.textContent = (vioCost <= 0 ? '' : '-') + curr + Math.abs(vioCost).toFixed(2);
    vioCostEl.style.color = vioCost > 0 ? 'var(--danger)' : '#555';

    const psyCostEl = document.getElementById('costPsyToday');
    const psyCost = report.totals.avoidablePsyLoss; // real vs. no-psychology-flag equity, today
    psyCostEl.textContent = (psyCost <= 0 ? '' : '-') + curr + Math.abs(psyCost).toFixed(2);
    psyCostEl.style.color = psyCost > 0 ? 'var(--danger)' : '#555';

    document.getElementById('costVioCount').textContent = report.vioStats.reduce((s, v) => s + v.count, 0) + ' violation-tagged trade(s) today';
    document.getElementById('costPsyCount').textContent = report.psyStats.reduce((s, p) => s + p.count, 0) + ' psychology-flagged trade(s) today';
}

// ── MFE/MAE Truth Matrix — every trade taken today ──
function renderMfeMae(todayTrades) {
    const el = document.getElementById('mfeMaeList');
    const withExcursion = todayTrades.filter(t => typeof t.maeMfe === 'number');

    if (!todayTrades.length) {
        el.innerHTML = '<div class="news-empty">Aaj abhi tak koi trade nahi hua.</div>';
        return;
    }
    if (!withExcursion.length) {
        el.innerHTML = '<div class="news-empty">Aaj ke trades mein MFE/MAE excursion record nahi hai.</div>';
        return;
    }

    el.innerHTML = withExcursion.map(t => {
        const pct = Math.max(-100, Math.min(100, t.maeMfe));
        const isAdverse = pct < 0;
        const widthPct = Math.abs(pct) / 2;
        const color = isAdverse ? 'var(--danger)' : 'var(--accent)';
        const side = isAdverse ? `left:calc(50% - ${widthPct}%);` : `left:50%;`;
        return `
            <div style="margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;font-size:0.7rem;margin-bottom:4px;">
                    <span><b>${t.asset || '—'}</b> · ${t._nodeTitle} · ${t.type || '—'}</span>
                    <span style="color:${(t.pl||0)>=0?'var(--accent)':'var(--danger)'};font-weight:bold;">${(t.pl||0)>=0?'+':''}${t._curr}${Math.abs(t.pl||0).toFixed(2)}</span>
                </div>
                <div class="mm-bar-wrap">
                    <div class="mm-bar-mid"></div>
                    <div class="mm-bar-fill" style="${side} width:${widthPct}%; background:${color};"></div>
                </div>
                <div class="mm-label"><span>MAE ← 100%</span><span>Entry</span><span>100% → MFE</span></div>
            </div>`;
    }).join('');
}

// ── PERFORMANCE RADAR — TODAY ONLY (same 6-axis engine as Monitoring's
// blue radar, but scoped strictly to today's trades. Nothing is stored —
// it's recomputed fresh from today's trades on every load, so it
// naturally resets to 0 the moment the date rolls over.) ──
function calcRadarScoresToday(trades) {
    const axes = { score:0, consistency:0, dailyReturn:0, rr:0, slUsage:0, calmar:0, wr:0 };
    if (!trades.length) return axes;

    const wins   = trades.filter(t => t.type === 'Target');
    const losses = trades.filter(t => t.type === 'Stop Loss');
    const wr     = (wins.length / trades.length) * 100;

    const avgPL    = trades.reduce((s,t)=>s+(t.pl||0),0) / trades.length;
    const dailyRet = Math.max(0, Math.min(100, 50 + avgPL * 2));

    const mean     = avgPL;
    const variance = trades.reduce((s,t)=>s+Math.pow((t.pl||0)-mean,2),0) / trades.length;
    const stdDev   = Math.sqrt(variance);
    const consistency = Math.max(0, Math.min(100, 100 - stdDev));

    const avgWin  = wins.length   ? wins.reduce((s,t)=>s+Math.abs(t.pl||0),0)/wins.length     : 0;
    const avgLoss = losses.length ? losses.reduce((s,t)=>s+Math.abs(t.pl||0),0)/losses.length : 1;
    const rrRatio = avgLoss ? avgWin/avgLoss : 0;
    const rrScore = Math.max(0, Math.min(100, rrRatio * 33.3));

    const slNotUsedCount = trades.filter(t=>(t.vios||[]).includes('SL NOT USED')).length;
    const slUsageRate    = (trades.length - slNotUsedCount) / trades.length;
    const slScore        = Math.max(0, Math.min(100, slUsageRate * 100));

    let running = 0, peak = 0, maxDD = 0;
    trades.forEach(t => {
        running += (t.pl||0);
        if (running > peak) peak = running;
        const dd = peak - running;
        if (dd > maxDD) maxDD = dd;
    });
    const netPL  = trades.reduce((s,t)=>s+(t.pl||0),0);
    const calmar = maxDD > 0 ? Math.max(0, Math.min(100, (netPL/maxDD) * 20)) : (netPL > 0 ? 80 : 30);

    const overall = (wr*0.25 + dailyRet*0.15 + consistency*0.2 + rrScore*0.2 + slScore*0.1 + calmar*0.1);

    return {
        score: Math.round(overall),
        consistency: Math.round(consistency),
        dailyReturn: Math.round(dailyRet),
        rr: Math.round(rrScore),
        slUsage: Math.round(slScore),
        calmar: Math.round(calmar),
        wr: Math.round(wr)
    };
}

function drawTodayRadar(canvasId, scores) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W/2, cy = H/2 - 6;
    const R  = Math.min(W,H)/2 - 42;

    ctx.clearRect(0,0,W,H);

    const labels = ['Consistency','Calmar','SL Usage','WR','RR','Daily Return'];
    const values  = [scores.consistency, scores.calmar, scores.slUsage, scores.wr, scores.rr, scores.dailyReturn];
    const n = labels.length;

    for (let ring=1; ring<=4; ring++) {
        ctx.beginPath();
        for (let i=0;i<=n;i++) {
            const ang = (Math.PI*2*i/n) - Math.PI/2;
            const r   = R*(ring/4);
            const x   = cx + r*Math.cos(ang);
            const y   = cy + r*Math.sin(ang);
            i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
        }
        ctx.strokeStyle = 'rgba(0,170,255,0.18)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    for (let i=0;i<n;i++) {
        const ang = (Math.PI*2*i/n) - Math.PI/2;
        ctx.beginPath();
        ctx.moveTo(cx,cy);
        ctx.lineTo(cx+R*Math.cos(ang), cy+R*Math.sin(ang));
        ctx.strokeStyle = 'rgba(0,170,255,0.25)';
        ctx.stroke();
    }

    ctx.beginPath();
    for (let i=0;i<=n;i++) {
        const idx = i % n;
        const ang = (Math.PI*2*idx/n) - Math.PI/2;
        const r   = R*(Math.max(0,Math.min(100,values[idx]))/100);
        const x   = cx + r*Math.cos(ang);
        const y   = cy + r*Math.sin(ang);
        i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,170,255,0.28)';
    ctx.fill();
    ctx.strokeStyle = '#00aaff';
    ctx.lineWidth = 2;
    ctx.stroke();

    for (let i=0;i<n;i++) {
        const ang = (Math.PI*2*i/n) - Math.PI/2;
        const r   = R*(Math.max(0,Math.min(100,values[i]))/100);
        const x   = cx + r*Math.cos(ang);
        const y   = cy + r*Math.sin(ang);
        ctx.beginPath();
        ctx.arc(x,y,3,0,Math.PI*2);
        ctx.fillStyle = '#fff';
        ctx.fill();
    }

    ctx.font = '9px monospace';
    ctx.fillStyle = '#aaccff';
    ctx.textAlign = 'center';
    for (let i=0;i<n;i++) {
        const ang = (Math.PI*2*i/n) - Math.PI/2;
        const lx  = cx + (R+18)*Math.cos(ang);
        const ly  = cy + (R+18)*Math.sin(ang);
        ctx.fillText(labels[i], lx, ly);
    }
}

// ── VIOLATION RADAR — today's violation tags only ──
const ALL_VIOLATIONS = [
    'SL NOT USED',
    'Mid-session risk alteration',
    'Emotional account switching',
    'Forced/revenge trade',
    'Intuition entry',
    'Exceeding 2 trades/day',
    'Missing screenshot',
    'Platform access without checklist',
    'FOMO entry',
    'No HTF confluence'
];

function drawTodayViolationRadar(canvasId, trades) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return 0;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W/2, cy = H/2 - 4;
    const R  = Math.min(W,H)/2 - 40;
    ctx.clearRect(0,0,W,H);

    const vioCount = {};
    ALL_VIOLATIONS.forEach(v => vioCount[v] = 0);
    trades.forEach(t => (t.vios||[]).forEach(v => { if (vioCount[v]!==undefined) vioCount[v]++; }));
    const maxCount = Math.max(1, ...Object.values(vioCount));

    const labels = ALL_VIOLATIONS.map(v => v.length>14 ? v.slice(0,13)+'…' : v);
    const values = ALL_VIOLATIONS.map(v => Math.min(100, (vioCount[v]/maxCount)*100));
    const n = labels.length;

    for (let ring=1; ring<=4; ring++) {
        ctx.beginPath();
        for (let i=0;i<=n;i++) {
            const ang=(Math.PI*2*i/n)-Math.PI/2;
            const r=R*(ring/4);
            const x=cx+r*Math.cos(ang), y=cy+r*Math.sin(ang);
            i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
        }
        ctx.strokeStyle='rgba(255,80,80,0.12)'; ctx.lineWidth=1; ctx.stroke();
    }
    for (let i=0;i<n;i++) {
        const ang=(Math.PI*2*i/n)-Math.PI/2;
        ctx.beginPath(); ctx.moveTo(cx,cy);
        ctx.lineTo(cx+R*Math.cos(ang),cy+R*Math.sin(ang));
        ctx.strokeStyle='rgba(255,80,80,0.18)'; ctx.stroke();
    }
    ctx.beginPath();
    for (let i=0;i<=n;i++) {
        const idx=i%n, ang=(Math.PI*2*idx/n)-Math.PI/2;
        const r=R*(Math.max(0,values[idx])/100);
        const x=cx+r*Math.cos(ang), y=cy+r*Math.sin(ang);
        i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    ctx.closePath();
    ctx.fillStyle='rgba(255,60,60,0.22)'; ctx.fill();
    ctx.strokeStyle='#ff4444'; ctx.lineWidth=2; ctx.stroke();
    for (let i=0;i<n;i++) {
        const ang=(Math.PI*2*i/n)-Math.PI/2;
        const r=R*(Math.max(0,values[i])/100);
        ctx.beginPath(); ctx.arc(cx+r*Math.cos(ang),cy+r*Math.sin(ang),3,0,Math.PI*2);
        ctx.fillStyle='#ff8888'; ctx.fill();
    }
    ctx.font='8px monospace'; ctx.fillStyle='#ff9999'; ctx.textAlign='center';
    for (let i=0;i<n;i++) {
        const ang=(Math.PI*2*i/n)-Math.PI/2;
        const lx=cx+(R+16)*Math.cos(ang), ly=cy+(R+16)*Math.sin(ang);
        const cnt = ALL_VIOLATIONS[i] ? vioCount[ALL_VIOLATIONS[i]] : 0;
        ctx.fillText(labels[i]+(cnt>0?`(${cnt})`:''), lx, ly);
    }

    return Object.values(vioCount).reduce((a,b)=>a+b,0);
}

// ── PSYCHOLOGY RADAR — today's authentic psyRating[] input only ──
const PSY_LABELS = ['Plan vs Emotion','Setup Quality','Patience','Focus','Emotional Bias','Pulse','Heartbeat'];
const PSY_AXIS_TYPE = ['peak','monotonic','peak','peak','peak','peak','peak'];

function psyRatingQualityDB(rating, axisType) {
    if (rating == null || rating === '') rating = 7;
    rating = Math.max(1, Math.min(10, Number(rating)));
    if (axisType === 'monotonic') return Math.round(((rating - 1) / 9) * 100);
    const diff = Math.abs(rating - 7);
    return Math.round(Math.max(0, 100 - (diff / 6) * 100));
}

function drawTodayPsyRadar(canvasId, trades) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return 0;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W/2, cy = H/2 - 4;
    const R  = Math.min(W,H)/2 - 42;
    ctx.clearRect(0,0,W,H);

    const psyAvg = [0,0,0,0,0,0,0];
    let tCount = 0;
    trades.forEach(t => {
        if (!t.psyRating || !t.psyRating.length) return;
        tCount++;
        for (let i=0;i<7;i++) psyAvg[i] += psyRatingQualityDB(t.psyRating[i], PSY_AXIS_TYPE[i]);
    });
    const values = tCount > 0 ? psyAvg.map(s => Math.round(s/tCount)) : [0,0,0,0,0,0,0];
    const n = PSY_LABELS.length;

    for (let ring=1; ring<=4; ring++) {
        ctx.beginPath();
        for (let i=0;i<=n;i++) {
            const ang=(Math.PI*2*i/n)-Math.PI/2;
            const r=R*(ring/4);
            const x=cx+r*Math.cos(ang), y=cy+r*Math.sin(ang);
            i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
        }
        ctx.strokeStyle='rgba(160,100,255,0.12)'; ctx.lineWidth=1; ctx.stroke();
    }
    for (let i=0;i<n;i++) {
        const ang=(Math.PI*2*i/n)-Math.PI/2;
        ctx.beginPath(); ctx.moveTo(cx,cy);
        ctx.lineTo(cx+R*Math.cos(ang),cy+R*Math.sin(ang));
        ctx.strokeStyle='rgba(160,100,255,0.18)'; ctx.stroke();
    }
    ctx.beginPath();
    for (let i=0;i<=n;i++) {
        const idx=i%n, ang=(Math.PI*2*idx/n)-Math.PI/2;
        const r=R*(Math.max(0,Math.min(100,values[idx]))/100);
        const x=cx+r*Math.cos(ang), y=cy+r*Math.sin(ang);
        i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    ctx.closePath();
    ctx.fillStyle='rgba(140,80,255,0.22)'; ctx.fill();
    ctx.strokeStyle='#b388ff'; ctx.lineWidth=2; ctx.stroke();
    for (let i=0;i<n;i++) {
        const ang=(Math.PI*2*i/n)-Math.PI/2;
        const r=R*(Math.max(0,Math.min(100,values[i]))/100);
        ctx.beginPath(); ctx.arc(cx+r*Math.cos(ang),cy+r*Math.sin(ang),3,0,Math.PI*2);
        ctx.fillStyle='#d1aaff'; ctx.fill();
    }
    ctx.font='8px monospace'; ctx.fillStyle='#c8aaff'; ctx.textAlign='center';
    for (let i=0;i<n;i++) {
        const ang=(Math.PI*2*i/n)-Math.PI/2;
        const lx=cx+(R+18)*Math.cos(ang), ly=cy+(R+18)*Math.sin(ang);
        ctx.fillText(PSY_LABELS[i], lx, ly);
    }

    return tCount > 0 ? Math.round(values.reduce((a,b)=>a+b,0)/n) : 0;
}

function renderPerformanceRadar(todayTrades) {
    const scores = calcRadarScoresToday(todayTrades);
    drawTodayRadar('dbRadarCanvas', scores);
    const scoreEl = document.getElementById('dbRadarScore');
    if (scoreEl) scoreEl.textContent = scores.score.toFixed(2);

    const vioTotal = drawTodayViolationRadar('dbVioRadarCanvas', todayTrades);
    const vioEl = document.getElementById('dbVioScore');
    if (vioEl) vioEl.textContent = vioTotal;

    const psyAvg = drawTodayPsyRadar('dbPsyRadarCanvas', todayTrades);
    const psyEl = document.getElementById('dbPsyScore');
    if (psyEl) psyEl.textContent = psyAvg;
}

// ── ACTIVE CLUSTERS & ACCOUNTS ──
// Mirrors Settings.html's "Active Clusters" list exactly (same live-stats
// lookup, same balance/net/trades/win-rate per node) so Daybook always
// matches what Settings shows. Every cluster present in the DB is "active"
// (this app has no archived/paused cluster concept — matches Settings.html).
const statsPath = (cId, nIdx) => `isi_v6/stats/${cId}/${String(nIdx)}`;

async function getLiveStatsDB(cId, nIdx, fallbackBalance) {
    try {
        const snap = await get(ref(db, statsPath(cId, nIdx)));
        if (snap.val()) return snap.val();
    } catch (e) {}
    return { currentBal: fallbackBalance || 0, trades: 0, wins: 0, winRate: 0, net: 0 };
}

function fmtBalDB(curr, val) {
    return `${curr}${Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function renderActiveClusters(clusters) {
    const el = document.getElementById('clustersList');
    const entries = Object.entries(clusters);
    if (!entries.length) {
        el.innerHTML = '<div class="news-empty">No clusters deployed yet. Set one up in Settings.</div>';
        return;
    }

    const cards = await Promise.all(entries.map(async ([cId, cluster]) => {
        const nodes = cluster.nodes || [];
        const statsArr = await Promise.all(nodes.map((n, i) => getLiveStatsDB(cId, i, n.balance)));

        const byCurrency = {};
        nodes.forEach((n, i) => {
            const c = n.curr || '$';
            byCurrency[c] = (byCurrency[c] || 0) + (statsArr[i].currentBal ?? n.balance ?? 0);
        });
        const aumStr = Object.entries(byCurrency).map(([c, v]) => fmtBalDB(c, v)).join(' + ');

        const totalTrades = statsArr.reduce((s, st) => s + (st.trades || 0), 0);

        const netByCurr = {};
        nodes.forEach((n, i) => {
            const c = n.curr || '$';
            netByCurr[c] = (netByCurr[c] || 0) + (statsArr[i].net || 0);
        });
        const netStr = Object.entries(netByCurr)
            .map(([c, v]) => `<span style="color:${v>=0?'var(--accent)':'var(--danger)'};">${v>=0?'+':''}${fmtBalDB(c,v)}</span>`)
            .join(' ');

        const nodeRows = nodes.map((n, i) => {
            const s = statsArr[i];
            const liveBal = s.currentBal ?? n.balance ?? 0;
            const net = s.net || 0;
            return `
                <div class="cl-node-row">
                    <span style="color:#999;">🟢 ${n.title || 'Account ' + (i + 1)}</span>
                    <div style="display:flex;gap:10px;font-family:monospace;">
                        <span style="color:var(--gold);font-weight:bold;">${fmtBalDB(n.curr||'$', liveBal)}</span>
                        <span style="color:${net>=0?'var(--accent)':'var(--danger)'};">${net>=0?'+':''}${fmtBalDB(n.curr||'$', net)}</span>
                        <span style="color:#555;">T:${s.trades||0} WR:${s.winRate||0}%</span>
                    </div>
                </div>`;
        }).join('') || '<div style="color:#444;font-size:0.65rem;">No accounts in this cluster.</div>';

        return `
            <div class="cl-card">
                <div class="cl-head">
                    <div>
                        <div class="cl-title">${cluster.title || cId}</div>
                        <div class="cl-sub">${nodes.length} account(s) · ${totalTrades} trades total</div>
                    </div>
                    <div class="cl-status">● ACTIVE / LIVE</div>
                </div>
                <div class="cl-metrics">
                    <div><span style="color:#666;">Live AUM</span><b style="color:var(--gold);">${aumStr || '—'}</b></div>
                    <div><span style="color:#666;">Net P/L</span><b>${netStr || '—'}</b></div>
                    <div><span style="color:#666;">Trades</span><b>${totalTrades}</b></div>
                </div>
                <div class="cl-nodes">${nodeRows}</div>
            </div>`;
    }));

    el.innerHTML = cards.join('');
}
function renderBackToBackWarning(todayTrades) {
    const strip = document.getElementById('b2bWarning');
    const sorted = [...todayTrades].sort((a, b) => (a.savedAt || '').localeCompare(b.savedAt || ''));
    const lastTwo = sorted.slice(-2);
    const isB2BLoss = lastTwo.length === 2 && lastTwo.every(t => (Number(t.pl) || 0) < 0);

    if (isB2BLoss) {
        strip.style.display = 'flex';
    } else {
        strip.style.display = 'none';
    }
}

// ── Today's Sessions (Setup page risk schedule) — ALL of today, not just next 15 min ──
function renderUpcomingSessions(sessions, isHistorical) {
    const el = document.getElementById('sessionsList');
    if (!sessions.length) {
        el.innerHTML = '<div class="news-empty">Us din ke liye Settings mein koi session schedule nahi hai.</div>';
        return;
    }

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const rows = sessions.map(({ node, slot }) => {
        const startMin  = timeToMinutes(slot.start);
        const expireMin = timeToMinutes(slot.expire || slot.end);
        const riskPct   = slot.risk ?? node.risk ?? 0;
        const bal       = node.balance ?? 0;
        const riskAmt   = (bal * riskPct / 100);
        const curr      = node.curr || '$';
        const nodeTitle = node.title || 'Account';

        let status, color;
        if (isHistorical) {
            // A past date's schedule is purely informational — there's no
            // "live" or "starts in" concept for a day that's already over.
            status = '📋 Scheduled (historical)';
            color = '#666';
        } else if (startMin === null) { status = 'No start time'; color = '#555'; }
        else if (nowMin < startMin) { status = `Starts in ${Math.floor((startMin-nowMin)/60)}h ${((startMin-nowMin)%60)}m`; color = 'var(--gold)'; }
        else if (expireMin !== null && nowMin < expireMin) { status = '🔴 LIVE NOW'; color = 'var(--db-alert)'; }
        else { status = 'Session Over'; color = '#444'; }

        // Display the FULL live session window (start → expire) — same
        // definition used everywhere else in the app (terminal.js status
        // card countdown, LIVE/closed phase check just below). "end" is a
        // separate, narrower field (pre-entry-analysis-to-entry cutoff) and
        // must not be shown here as if it were the session's actual close.
        return { nodeTitle, start: slot.start, end: slot.expire || slot.end || '—', riskPct, riskAmt, curr, status, color, startMin: startMin ?? 9999 };
    }).sort((a, b) => a.startMin - b.startMin);

    el.innerHTML = rows.map(r => `
        <div class="news-item" style="border-left-color:${r.color};">
            <div class="ni-title">${r.nodeTitle} — ${r.start} → ${r.end}</div>
            <div class="ni-meta">Risk: ${r.riskPct}% (${r.curr}${r.riskAmt.toFixed(2)})</div>
            <div class="ni-status" style="color:${r.color};">${r.status}</div>
        </div>`).join('');
}

// News — shown directly inline, always visible, no popup/modal gating
// ── QUICK LINKS — trader-managed shortcuts (Settings → Quick Links
// Manager). Rendered as real <a target="_blank" rel="noopener noreferrer">
// elements — NOT a JS window.open() — because a genuine anchor with
// target="_blank" is what reliably hands off to the system browser on
// every platform (desktop tab, Android installed PWA, iOS home-screen
// PWA), instead of risking navigation inside the app's own window. ──
function loadQuickLinks() {
    onValue(ref(db, 'isi_v6/quick_links'), (snap) => {
        const card = document.getElementById('quickLinksCard');
        const list = document.getElementById('dbQuickLinksList');
        if (!card || !list) return;

        const entries = Object.values(snap.val() || {})
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt||'').localeCompare(b.createdAt||''));

        if (!entries.length) {
            card.style.display = 'none';
            return;
        }
        card.style.display = '';
        list.innerHTML = `<div class="ql-grid">${entries.map(l => `
            <a class="ql-tile" href="${escAttr(l.url)}" target="_blank" rel="noopener noreferrer" title="${escAttr(l.title)}">
                <img class="ql-tile-logo" src="${escAttr(l.logo || '')}" onerror="this.style.visibility='hidden'" alt="">
                <span class="ql-tile-title">${escHtml(l.title || 'Untitled')}</span>
                <span class="ql-tile-arrow">↗</span>
            </a>`).join('')}</div>`;
    });
}
function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escAttr(s) { return escHtml(s); }

let _newsSnapshot = [];

function loadNews() {
    onValue(ref(db, 'isi_v6/news'), (snap) => {
        _newsSnapshot = Object.values(snap.val() || {});
        renderNewsForDate(viewDate, viewDate !== todayStr());
    });
}

function renderNewsForDate(dateStr, isHistorical) {
    const listEl = document.getElementById('newsList');
    if (!listEl) return;
    const impactColor = { High: '#ff4d1c', Medium: '#ffaa00', Low: '#00c805' };

    if (isHistorical) {
        // Past date — just show whatever news events were scheduled ON
        // that exact date, no live/upcoming countdown (the day is over).
        const dayEvents = _newsSnapshot.filter(n => n.date === dateStr)
            .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
        if (!dayEvents.length) {
            listEl.innerHTML = '<div class="news-empty">Us din koi high-impact news event record nahi mila.</div>';
            return;
        }
        listEl.innerHTML = dayEvents.map(n => `
            <div class="news-item" style="border-left-color:${impactColor[n.impact] || '#888'};">
                <div class="ni-title">${n.title || 'Untitled Event'}</div>
                <div class="ni-meta">${n.date} · ${n.start} → ${n.end} IST · Impact: ${n.impact || 'Medium'}</div>
                <div class="ni-status" style="color:#666;">📋 Historical</div>
            </div>`).join('');
        return;
    }

    // "Today" — original live/upcoming behaviour (48h look-back window)
    const now = new Date();
    const relevant = _newsSnapshot.filter(n => {
        try {
            const end = new Date(`${n.date}T${n.end}:00`);
            const windowStart = new Date(new Date(`${n.date}T${n.start}:00`).getTime() - 48 * 3600 * 1000);
            return now <= end && now >= windowStart;
        } catch (e) { return false; }
    }).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

    if (!relevant.length) {
        listEl.innerHTML = '<div class="news-empty">Aaj koi high-impact news window nahi hai.</div>';
        return;
    }

    listEl.innerHTML = relevant.map(n => {
        const start = new Date(`${n.date}T${n.start}:00`);
        const end   = new Date(`${n.date}T${n.end}:00`);
        const live  = now >= start && now <= end;
        const status = now < start
            ? `Starts ${start.toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })}`
            : (live ? '🔴 LIVE NOW' : 'Ended');
        return `
            <div class="news-item" style="border-left-color:${impactColor[n.impact] || '#888'};">
                <div class="ni-title">${n.title || 'Untitled Event'}</div>
                <div class="ni-meta">${n.date} · ${n.start} → ${n.end} IST · Impact: ${n.impact || 'Medium'}</div>
                <div class="ni-status" style="color:${live ? '#ff4d1c' : 'var(--gold)'};">${status}</div>
            </div>`;
    }).join('');
}
