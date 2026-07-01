// ══════════════════════════════════════════════════════════════════
// COST OF VIOLATION & COST OF PSYCHOLOGY — FULL REPORT
// Shared module — used by monitoring.html (monitoring.js) AND
// multicluster.html (inline module script). Read-only / additive:
// this file does not touch any existing rendering logic anywhere else.
//
// Logic recap (as specified by the trader):
//  • VIOLATION → any trade tagged with one or more violation labels
//    (checklist skip, SL not used, revenge trade, etc). That trade's
//    ENTIRE P/L (profit or loss) is attributed to every violation it
//    carries — if a trade has 2 violations, its P/L counts fully in
//    BOTH violation sections.
//  • PSYCHOLOGY → per-trade self-rating (1-10) on 7 axes taken from
//    index.html at trade finalization. For every axis EXCEPT
//    "Setup Quality": rating 1-3 OR 8-10 = a psychology reason for
//    that trade. For "Setup Quality" only: rating below 7 (1-6) is
//    the reason (10 = best there, monotonic axis).
//  • 4 Equity Pulses:
//      BLUE   = Real equity (unmodified, actual P/L)
//      RED    = Equity if violation-tagged trades had cost $0
//      PURPLE = Equity if psychology-flagged trades had cost $0
//      GOLD   = Equity if BOTH were clean (fully disciplined curve)
// ══════════════════════════════════════════════════════════════════

export const ALL_VIOLATIONS = [
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

export const PSY_LABELS = [
    'Plan vs Emotion',
    'Setup Quality',
    'Patience',
    'Focus',
    'Emotional Bias',
    'Pulse',
    'Heartbeat'
];
// 'monotonic' = only Setup Quality (10 = best, below 7 = reason)
// 'peak'      = everything else (7 = ideal; 1-3 or 8-10 = reason)
export const PSY_AXIS_TYPE = ['peak','monotonic','peak','peak','peak','peak','peak'];

function isPsyFlagged(rating, axisType) {
    if (rating === null || rating === undefined || rating === '') return false;
    const v = Number(rating);
    if (!isFinite(v)) return false;
    if (axisType === 'monotonic') return v < 7;
    return v <= 3 || v >= 8;
}

function tradeViolations(t) {
    return Array.isArray(t.vios) ? [...new Set(t.vios.filter(Boolean))] : [];
}

function tradePsyReasons(t) {
    const r = t.psyRating;
    if (!Array.isArray(r) || !r.length) return [];
    const reasons = [];
    PSY_LABELS.forEach((label, i) => {
        if (isPsyFlagged(r[i], PSY_AXIS_TYPE[i])) reasons.push(label);
    });
    return reasons;
}

function fmtMoney(curr, v) {
    const sign = v >= 0 ? '+' : '-';
    return `${sign}${curr}${Math.abs(v).toFixed(2)}`;
}

function dominantCurrency(trades) {
    const counts = {};
    trades.forEach(t => { const c = t._curr || '$'; counts[c] = (counts[c]||0) + 1; });
    let best = '$', bestN = -1;
    Object.entries(counts).forEach(([c,n]) => { if (n > bestN) { best = c; bestN = n; } });
    return best;
}

// ──────────────────────────────────────────────
// CORE CALCULATION
// ──────────────────────────────────────────────
export function computeCostReport(trades) {
    const sorted = [...(trades||[])].filter(t => t && typeof t === 'object')
        .sort((a,b) => (a.date||'').localeCompare(b.date||'') || (a.savedAt||'').localeCompare(b.savedAt||''));

    const vioStats = {};
    ALL_VIOLATIONS.forEach(v => vioStats[v] = { name:v, count:0, cost:0, lossCost:0, profitCost:0, trades:[] });
    const psyStats = {};
    PSY_LABELS.forEach(p => psyStats[p] = { name:p, count:0, cost:0, lossCost:0, profitCost:0, trades:[] });

    const monthly = {};
    let real=0, noVio=0, noPsy=0, bothClean=0;
    const curve = [];

    sorted.forEach((t, idx) => {
        const pl = Number(t.pl) || 0;
        const vios = tradeViolations(t);
        const psyReasons = tradePsyReasons(t);
        const hasVio = vios.length > 0;
        const hasPsy = psyReasons.length > 0;

        real       += pl;
        noVio      += hasVio ? 0 : pl;
        noPsy      += hasPsy ? 0 : pl;
        bothClean  += (hasVio || hasPsy) ? 0 : pl;

        const month = (t.date || '').slice(0,7) || 'Unknown';
        if (!monthly[month]) monthly[month] = { label: month, real:0, noVio:0, noPsy:0, bothClean:0, count:0 };
        monthly[month].real      += pl;
        monthly[month].noVio     += hasVio ? 0 : pl;
        monthly[month].noPsy     += hasPsy ? 0 : pl;
        monthly[month].bothClean += (hasVio||hasPsy) ? 0 : pl;
        monthly[month].count++;

        const rowBase = {
            serial: idx+1, date: t.date || '—', pl,
            nodeTitle: t._nodeTitle || t._nodeId || '—',
            curr: t._curr || '$',
            asset: t.asset || '—',
            type: t.type || '—',
            vios, psyReasons, hasVio, hasPsy,
            clusterId: t._clusterId, nodeIdx: t._nodeIdx, fbKey: t._fbKey
        };

        curve.push({ ...rowBase, real, noVio, noPsy, bothClean });

        vios.forEach(v => {
            if (!vioStats[v]) vioStats[v] = { name:v, count:0, cost:0, lossCost:0, profitCost:0, trades:[] };
            vioStats[v].count++;
            vioStats[v].cost += pl;
            if (pl < 0) vioStats[v].lossCost += pl; else vioStats[v].profitCost += pl;
            vioStats[v].trades.push(rowBase);
        });
        psyReasons.forEach(p => {
            psyStats[p].count++;
            psyStats[p].cost += pl;
            if (pl < 0) psyStats[p].lossCost += pl; else psyStats[p].profitCost += pl;
            psyStats[p].trades.push(rowBase);
        });
    });

    const monthlyArr = Object.values(monthly).sort((a,b) => a.label.localeCompare(b.label));

    // Quarterly roll-up from monthly
    const quarterly = {};
    monthlyArr.forEach(m => {
        const [y, mo] = m.label.split('-');
        if (!y || !mo) return;
        const q = `${y}-Q${Math.ceil(Number(mo)/3)}`;
        if (!quarterly[q]) quarterly[q] = { label:q, real:0, noVio:0, noPsy:0, bothClean:0, count:0 };
        quarterly[q].real      += m.real;
        quarterly[q].noVio     += m.noVio;
        quarterly[q].noPsy     += m.noPsy;
        quarterly[q].bothClean += m.bothClean;
        quarterly[q].count     += m.count;
    });
    const quarterlyArr = Object.values(quarterly).sort((a,b) => a.label.localeCompare(b.label));

    return {
        curr: dominantCurrency(sorted),
        totals: {
            real, noVio, noPsy, bothClean,
            avoidableVioLoss:   noVio - real,
            avoidablePsyLoss:   noPsy - real,
            avoidableTotalLoss: bothClean - real,
            count: sorted.length
        },
        curve,
        vioStats:  Object.values(vioStats).filter(s => s.count > 0).sort((a,b) => a.cost - b.cost),
        psyStats:  Object.values(psyStats).filter(s => s.count > 0).sort((a,b) => a.cost - b.cost),
        monthly: monthlyArr,
        quarterly: quarterlyArr
    };
}

// ──────────────────────────────────────────────
// UI STATE (per rendered instance)
// ──────────────────────────────────────────────
const _state = { report: null, filterType: null, filterName: null, periodMode: 'monthly', chart: null };

function statCard(label, value, curr, colorPos, colorNeg, sub) {
    const color = value >= 0 ? colorPos : colorNeg;
    return `<div style="background:#0a0a0a;border:1px solid #1a1a1a;border-radius:8px;padding:12px 14px;">
        <div style="font-size:0.5rem;color:#666;letter-spacing:2px;font-weight:bold;margin-bottom:6px;">${label}</div>
        <div style="font-size:1.15rem;font-weight:900;color:${color};">${fmtMoney(curr, value)}</div>
        ${sub ? `<div style="font-size:0.55rem;color:#555;margin-top:3px;">${sub}</div>` : ''}
    </div>`;
}

function chipHTML(kind, stat, curr, active) {
    const colorHeader = kind === 'vio' ? '#ff7070' : '#b388ff';
    const bg = active ? (kind === 'vio' ? 'rgba(255,80,80,0.15)' : 'rgba(179,136,255,0.15)') : '#0a0a0a';
    const bd = active ? colorHeader : '#1a1a1a';
    return `<div onclick="window.__costReportFilter('${kind}','${stat.name.replace(/'/g,"\\'")}')"
        style="cursor:pointer;background:${bg};border:1px solid ${bd};border-radius:7px;padding:8px 10px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div style="min-width:0;">
            <div style="font-size:0.65rem;color:#ddd;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${stat.name}</div>
            <div style="font-size:0.52rem;color:#666;margin-top:2px;">${stat.count} trade${stat.count>1?'s':''} affected</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
            <div style="font-size:0.78rem;font-weight:900;color:${stat.cost>=0?'#00c805':'#ff3333'};">${fmtMoney(curr, stat.cost)}</div>
            <div style="font-size:0.48rem;color:#555;">total cost</div>
        </div>
    </div>`;
}

function ledgerRowsHTML(rows, curr) {
    if (!rows.length) return '<div style="color:#555;font-size:0.7rem;padding:14px;text-align:center;">Koi trade nahi mila is filter ke liye.</div>';
    // Group date-wise, each date = its own section
    const byDate = {};
    rows.forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });
    const dates = Object.keys(byDate).sort();
    return dates.map(d => {
        const dayRows = byDate[d];
        const dayNet = dayRows.reduce((s,r)=>s+r.pl,0);
        return `<div style="margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;background:#050505;padding:6px 10px;border-radius:5px 5px 0 0;border:1px solid #1a1a1a;border-bottom:none;">
                <span style="font-size:0.62rem;color:var(--gold);font-weight:bold;letter-spacing:1px;">📅 ${d}</span>
                <span style="font-size:0.65rem;font-weight:bold;color:${dayNet>=0?'#00c805':'#ff3333'};">${fmtMoney(curr, dayNet)}</span>
            </div>
            <div style="border:1px solid #1a1a1a;border-radius:0 0 5px 5px;overflow:hidden;">
                ${dayRows.map(r => `
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:7px 10px;border-top:1px solid #111;font-size:0.6rem;">
                    <div style="min-width:0;flex:1;">
                        <span style="color:#666;">#${r.serial}</span>
                        <span style="color:#ccc;margin-left:5px;">${r.nodeTitle}</span>
                        <span style="color:#555;margin-left:5px;">${r.asset}</span>
                        <div style="margin-top:3px;">
                            ${r.vios.length ? r.vios.map(v=>`<span style="display:inline-block;background:#1a0000;color:#ff7070;border:1px solid #4a1a1a;border-radius:3px;padding:1px 5px;margin:1px 3px 1px 0;font-size:0.5rem;">${v}</span>`).join('') : ''}
                            ${r.psyReasons.length ? r.psyReasons.map(p=>`<span style="display:inline-block;background:#160029;color:#c8a2ff;border:1px solid #3a1a5a;border-radius:3px;padding:1px 5px;margin:1px 3px 1px 0;font-size:0.5rem;">🧠 ${p}</span>`).join('') : ''}
                            ${(!r.vios.length && !r.psyReasons.length) ? '<span style="color:#2a7a2a;font-size:0.5rem;">✓ Clean trade</span>' : ''}
                        </div>
                    </div>
                    <div style="flex-shrink:0;font-weight:bold;color:${r.pl>=0?'#00c805':'#ff3333'};">${fmtMoney(r.curr, r.pl)}</div>
                </div>`).join('')}
            </div>
        </div>`;
    }).join('');
}

function periodTableHTML(rep, mode) {
    const rows = mode === 'quarterly' ? rep.quarterly : rep.monthly;
    if (!rows.length) return '<div style="color:#555;font-size:0.7rem;padding:10px;text-align:center;">No data yet.</div>';
    return `<div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;font-size:0.65rem;">
        <thead><tr style="background:#050505;color:#888;">
            <th style="padding:6px;text-align:left;border-bottom:1px solid #1a1a1a;">${mode==='quarterly'?'Quarter':'Month'}</th>
            <th style="padding:6px;text-align:center;border-bottom:1px solid #1a1a1a;">Trades</th>
            <th style="padding:6px;text-align:right;border-bottom:1px solid #1a1a1a;color:#7aa8ff;">Real P/L</th>
            <th style="padding:6px;text-align:right;border-bottom:1px solid #1a1a1a;color:#ff7070;">Clean of Violation</th>
            <th style="padding:6px;text-align:right;border-bottom:1px solid #1a1a1a;color:#b388ff;">Clean of Psychology</th>
            <th style="padding:6px;text-align:right;border-bottom:1px solid #1a1a1a;color:var(--gold);">Fully Clean</th>
            <th style="padding:6px;text-align:right;border-bottom:1px solid #1a1a1a;">Avoidable Loss</th>
        </tr></thead>
        <tbody>
        ${rows.map(m => `<tr style="border-bottom:1px solid #111;">
            <td style="padding:6px;color:#ccc;">${m.label}</td>
            <td style="padding:6px;text-align:center;color:#888;">${m.count}</td>
            <td style="padding:6px;text-align:right;color:${m.real>=0?'#00c805':'#ff3333'};">${fmtMoney(rep.curr, m.real)}</td>
            <td style="padding:6px;text-align:right;color:${m.noVio>=0?'#00c805':'#ff3333'};">${fmtMoney(rep.curr, m.noVio)}</td>
            <td style="padding:6px;text-align:right;color:${m.noPsy>=0?'#00c805':'#ff3333'};">${fmtMoney(rep.curr, m.noPsy)}</td>
            <td style="padding:6px;text-align:right;color:${m.bothClean>=0?'#00c805':'#ff3333'};">${fmtMoney(rep.curr, m.bothClean)}</td>
            <td style="padding:6px;text-align:right;color:#ff9955;">${fmtMoney(rep.curr, m.bothClean - m.real)}</td>
        </tr>`).join('')}
        </tbody>
    </table></div>`;
}

function drawEquityPulseChart(canvasId, curve, curr) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !window.Chart) return;
    if (_state.chart) { try { _state.chart.destroy(); } catch(e){} _state.chart = null; }
    const labels = curve.map(c => `#${c.serial} ${c.date}`);
    const mk = (arr, color, dashed) => ({
        data: arr, borderColor: color, backgroundColor: 'transparent',
        borderWidth: 2, pointRadius: 0, tension: 0.15,
        borderDash: dashed ? [5,4] : []
    });
    _state.chart = new window.Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Real Equity (Blue)',            ...mk(curve.map(c=>c.real), '#4a9eff', false) },
                { label: 'Clean of Violation (Red)',       ...mk(curve.map(c=>c.noVio), '#ff5252', true) },
                { label: 'Clean of Psychology (Purple)',   ...mk(curve.map(c=>c.noPsy), '#b388ff', true) },
                { label: 'Fully Clean (Gold)',             ...mk(curve.map(c=>c.bothClean), '#c5a059', true) }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: '#aaa', font: { size: 10 }, boxWidth: 14 } },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(curr, ctx.parsed.y)}`
                    }
                }
            },
            scales: {
                x: { ticks: { color: '#555', maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font:{size:9} }, grid: { color: '#111' } },
                y: { ticks: { color: '#555', font:{size:9}, callback: v => curr + v }, grid: { color: '#111' } }
            }
        }
    });
}

window.__costReportFilter = function (kind, name) {
    _state.filterType = kind;
    _state.filterName = name;
    _rerenderLedger();
};
window.__costReportReset = function () {
    _state.filterType = null; _state.filterName = null;
    _rerenderLedger();
};
window.__costReportSetPeriod = function (mode) {
    _state.periodMode = mode;
    const el = document.getElementById('costRepPeriodBody');
    if (el && _state.report) el.innerHTML = periodTableHTML(_state.report, mode);
    ['monthly','quarterly'].forEach(m => {
        const b = document.getElementById('costRepPeriodBtn_'+m);
        if (b) { b.style.background = m===mode ? 'var(--gold)' : '#111'; b.style.color = m===mode ? '#000' : '#888'; }
    });
};

function _rerenderLedger() {
    const rep = _state.report;
    const el = document.getElementById('costRepLedger');
    const titleEl = document.getElementById('costRepLedgerTitle');
    if (!rep || !el) return;
    let rows = rep.curve;
    let title = '📋 ALL TRADES — DATE-WISE / SERIAL-WISE';
    if (_state.filterType === 'vio' && _state.filterName) {
        rows = rep.curve.filter(r => r.vios.includes(_state.filterName));
        title = `⚠ VIOLATION FILTER: "${_state.filterName}" — ${rows.length} trade(s)`;
    } else if (_state.filterType === 'psy' && _state.filterName) {
        rows = rep.curve.filter(r => r.psyReasons.includes(_state.filterName));
        title = `🧠 PSYCHOLOGY FILTER: "${_state.filterName}" — ${rows.length} trade(s)`;
    }
    if (titleEl) titleEl.innerHTML = `${title} ${(_state.filterType) ? `<span onclick="window.__costReportReset()" style="cursor:pointer;color:var(--gold);font-size:0.55rem;margin-left:8px;border:1px solid var(--gold);padding:2px 7px;border-radius:4px;">✕ CLEAR FILTER</span>` : ''}`;
    el.innerHTML = ledgerRowsHTML(rows, rep.curr);
}

// ──────────────────────────────────────────────
// MAIN ENTRY — renders full report into a container element
// ──────────────────────────────────────────────
export function renderCostReportUI(container, trades, opts) {
    opts = opts || {};
    const rep = computeCostReport(trades || []);
    _state.report = rep;
    _state.filterType = null; _state.filterName = null;

    if (!rep.totals.count) {
        container.innerHTML = `<div style="color:#555;font-size:0.75rem;padding:30px;text-align:center;">
            Is selection ke liye abhi koi trade data nahi mila. Pehle account/cluster select karke kuch trades finalize karo.
        </div>`;
        return;
    }

    const t = rep.totals, c = rep.curr;

    container.innerHTML = `
        <div style="font-size:0.6rem;color:#555;margin-bottom:14px;font-style:italic;">
            Yeh report last <b style="color:var(--gold);">${t.count}</b> trades (selected cluster/account) ka <b>Cost of Violation</b> aur <b>Cost of Psychology</b> breakdown dikhata hai — kaunsi galti se kitna nuksan hua, kaunsi repeat ho rahi hai, aur agar discipline clean hota to equity kaisi dikhti.
        </div>

        <!-- SUMMARY CARDS -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px;">
            ${statCard('REAL EQUITY (ACTUAL)', t.real, c, '#4a9eff', '#4a9eff', 'Blue Pulse')}
            ${statCard('CLEAN OF VIOLATION', t.noVio, c, '#ff5252', '#ff5252', `Avoidable: ${fmtMoney(c, t.avoidableVioLoss)}`)}
            ${statCard('CLEAN OF PSYCHOLOGY', t.noPsy, c, '#b388ff', '#b388ff', `Avoidable: ${fmtMoney(c, t.avoidablePsyLoss)}`)}
            ${statCard('FULLY CLEAN (BOTH)', t.bothClean, c, '#c5a059', '#c5a059', `Avoidable: ${fmtMoney(c, t.avoidableTotalLoss)}`)}
        </div>

        <!-- EQUITY PULSE CHART -->
        <div style="background:#020202;border:1px solid #111;border-radius:8px;padding:10px;margin-bottom:16px;position:relative;height:220px;">
            <canvas id="costRepCanvas"></canvas>
        </div>

        <!-- VIOLATION + PSYCHOLOGY COST BREAKDOWN -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;">
            <div>
                <div style="font-size:0.55rem;color:#ff7070;letter-spacing:2px;font-weight:bold;margin-bottom:8px;">⚠ COST OF VIOLATION — TAP TO FILTER</div>
                ${rep.vioStats.length ? rep.vioStats.map(s => chipHTML('vio', s, c, false)).join('') : '<div style="color:#555;font-size:0.65rem;padding:8px;">Koi violation record nahi mila.</div>'}
            </div>
            <div>
                <div style="font-size:0.55rem;color:#b388ff;letter-spacing:2px;font-weight:bold;margin-bottom:8px;">🧠 COST OF PSYCHOLOGY — TAP TO FILTER</div>
                ${rep.psyStats.length ? rep.psyStats.map(s => chipHTML('psy', s, c, false)).join('') : '<div style="color:#555;font-size:0.65rem;padding:8px;">Koi psychology red-flag nahi mila (sab ratings healthy range mein the).</div>'}
            </div>
        </div>

        <!-- MONTHLY / QUARTERLY COMPARISON -->
        <div style="margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <div style="font-size:0.55rem;color:var(--gold);letter-spacing:2px;font-weight:bold;">📆 PERIOD COMPARISON</div>
                <div style="display:flex;gap:5px;">
                    <button id="costRepPeriodBtn_monthly" onclick="window.__costReportSetPeriod('monthly')" style="padding:4px 10px;font-size:0.58rem;border-radius:4px;border:1px solid #333;background:var(--gold);color:#000;font-weight:bold;cursor:pointer;">MONTHLY</button>
                    <button id="costRepPeriodBtn_quarterly" onclick="window.__costReportSetPeriod('quarterly')" style="padding:4px 10px;font-size:0.58rem;border-radius:4px;border:1px solid #333;background:#111;color:#888;font-weight:bold;cursor:pointer;">QUARTERLY</button>
                </div>
            </div>
            <div id="costRepPeriodBody">${periodTableHTML(rep, 'monthly')}</div>
        </div>

        <!-- FULL LEDGER — DATE-WISE / SERIAL-WISE -->
        <div>
            <div id="costRepLedgerTitle" style="font-size:0.55rem;color:var(--gold);letter-spacing:1.5px;font-weight:bold;margin-bottom:8px;">📋 ALL TRADES — DATE-WISE / SERIAL-WISE</div>
            <div id="costRepLedger"></div>
        </div>

        <div style="margin-top:18px;padding-top:12px;border-top:1px solid #1a1a1a;font-size:0.52rem;color:#333;letter-spacing:1px;text-align:center;">
            ISI TERMINAL · INSTITUTIONAL EXPECTANCY PORTAL · COST OF VIOLATION &amp; PSYCHOLOGY REPORT · GENERATED ${new Date().toLocaleString()}
        </div>
    `;

    drawEquityPulseChart('costRepCanvas', rep.curve, c);
    _rerenderLedger();
}
