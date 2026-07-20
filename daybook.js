// ══════════════════════════════════════════════════════════════════
// ISI DAYBOOK — v6.0
// This page is now the app's index/landing page. It owns the
// Oath + Password gate (moved here from Terminal). Once unlocked it
// activates the shared _ISISession, which every other page (Terminal,
// Pre-Entry, Monitoring, etc.) checks before allowing access.
// ══════════════════════════════════════════════════════════════════
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

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
    localStorage.setItem('isi_oath_date', new Date().toISOString().split('T')[0]);
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

    document.getElementById('riskDate').textContent = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
});

// ──────────────────────────────────────────────
// LIVE DATA — Today's Snapshot, Cost of Violation/Psychology, MFE/MAE,
// Back-to-back loss warning, Today's Sessions, News (direct, no popup)
// ──────────────────────────────────────────────
import { computeCostReport } from './cost-report.js';

function todayStr() { return new Date().toISOString().split('T')[0]; }

function loadLiveData() {
    loadClustersData();
    loadNews();
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
// ALL derived from one 'isi_v6/clusters' read.
function loadClustersData() {
    onValue(ref(db, 'isi_v6/clusters'), (snap) => {
        const clusters = snap.val() || {};
        const today = todayStr();
        const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];

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
                // Sessions scheduled for today (Settings/Setup risk schedule)
                getSlotsForToday(node, dayName).forEach(slot => {
                    upcomingSessions.push({ cId, node, nIdx, slot });
                });
            });
        });

        renderSnapshotAndCosts(todayTrades);
        renderPerformanceRadar(todayTrades);
        renderMfeMae(todayTrades);
        renderBackToBackWarning(todayTrades);
        renderUpcomingSessions(upcomingSessions);

        renderActiveClusters(clusters);
    });
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
function renderUpcomingSessions(sessions) {
    const el = document.getElementById('sessionsList');
    if (!sessions.length) {
        el.innerHTML = '<div class="news-empty">Aaj ke liye Settings mein koi session schedule nahi hai.</div>';
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
        if (startMin === null) { status = 'No start time'; color = '#555'; }
        else if (nowMin < startMin) { status = `Starts in ${Math.floor((startMin-nowMin)/60)}h ${((startMin-nowMin)%60)}m`; color = 'var(--gold)'; }
        else if (expireMin !== null && nowMin < expireMin) { status = '🔴 LIVE NOW'; color = 'var(--db-alert)'; }
        else { status = 'Session Over'; color = '#444'; }

        return { nodeTitle, start: slot.start, end: slot.end || slot.expire || '—', riskPct, riskAmt, curr, status, color, startMin: startMin ?? 9999 };
    }).sort((a, b) => a.startMin - b.startMin);

    el.innerHTML = rows.map(r => `
        <div class="news-item" style="border-left-color:${r.color};">
            <div class="ni-title">${r.nodeTitle} — ${r.start} → ${r.end}</div>
            <div class="ni-meta">Risk: ${r.riskPct}% (${r.curr}${r.riskAmt.toFixed(2)})</div>
            <div class="ni-status" style="color:${r.color};">${r.status}</div>
        </div>`).join('');
}

// News — shown directly inline, always visible, no popup/modal gating
function loadNews() {
    onValue(ref(db, 'isi_v6/news'), (snap) => {
        const list = Object.values(snap.val() || {});
        const now  = new Date();
        const listEl = document.getElementById('newsList');

        const relevant = list.filter(n => {
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

        const impactColor = { High: '#ff4d1c', Medium: '#ffaa00', Low: '#00c805' };
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
    });
}
