// ══════════════════════════════════════════════════════════════════
// PNL OVERVIEW — ring gauges + Win by Strategy + Profit per Day
// Monitoring page → header button. Every number here is derived
// directly from the same last-N trade set used across the rest of
// the Monitoring page (window._monCostReportTrades) — no invented
// figures. Strategy ranking reuses the existing Strategy Discovery
// engine (top combos by net P/L, passed in from monitoring.js).
// ══════════════════════════════════════════════════════════════════

let _charts = {}; // keep refs so re-opening the modal doesn't leak Chart.js instances

function destroyCharts() {
    Object.values(_charts).forEach(c => { try { c.destroy(); } catch (e) {} });
    _charts = {};
}

function dominantCurrency(trades) {
    const counts = {};
    trades.forEach(t => { const c = t._curr || t.currency || '$'; counts[c] = (counts[c]||0) + 1; });
    let best = '$', bestN = -1;
    Object.entries(counts).forEach(([c,n]) => { if (n > bestN) { best = c; bestN = n; } });
    return best;
}
function fmtMoney(curr, v) {
    v = Number(v) || 0;
    const sign = v >= 0 ? '+' : '-';
    return `${sign}${curr}${Math.abs(v).toFixed(2)}`;
}

// ── SVG progress ring (true % arc, gap at top like a gauge) ──
function ringSVG(pct, color, trackColor, size, stroke) {
    pct = Math.max(0, Math.min(100, pct));
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const dash = (pct/100) * c;
    return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="transform:rotate(-90deg);">
        <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${trackColor}" stroke-width="${stroke}"></circle>
        <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
                stroke-dasharray="${dash} ${c-dash}" stroke-linecap="round"></circle>
    </svg>`;
}
function gaugeCard(label, centerBig, centerSmall, pct, color, trackColor) {
    const size = 128, stroke = 11;
    return `
    <div style="background:#0a0a0a;border:1px solid #1a1a1a;border-radius:12px;padding:16px;display:flex;flex-direction:column;align-items:center;flex:1;min-width:150px;">
        <div style="font-size:0.58rem;color:#666;letter-spacing:2px;margin-bottom:10px;text-transform:uppercase;">${label}</div>
        <div style="position:relative;width:${size}px;height:${size}px;">
            ${ringSVG(pct, color, trackColor, size, stroke)}
            <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;">
                <div style="font-size:1.35rem;font-weight:900;color:#e0e0e0;">${centerBig}</div>
                <div style="font-size:0.55rem;color:#666;margin-top:2px;">${centerSmall}</div>
            </div>
        </div>
    </div>`;
}

function drawWinByStrategy(canvasId, combos, curr) {
    const el = document.getElementById(canvasId);
    if (!el || !window.Chart) return;
    const palette = ['#00d9ff', '#ffd400', '#ffffff', '#c5a059'];
    _charts.strategy = new window.Chart(el, {
        type: 'bar',
        data: {
            labels: combos.map((c,i) => `Strategy #${i+1}`),
            datasets: [{
                data: combos.map(c => Number(c.pl.toFixed(2))),
                backgroundColor: combos.map((c,i) => palette[i % palette.length]),
                borderRadius: 4,
                maxBarThickness: 46
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => fmtMoney(curr, ctx.parsed.y) } }
            },
            scales: {
                x: { ticks: { color: '#888', font: { size: 10 } }, grid: { display: false } },
                y: { ticks: { color: '#888', font: { size: 10 }, callback: (v) => curr + v }, grid: { color: '#1a1a1a' } }
            }
        }
    });
}

function drawProfitPerDay(canvasId, dayRows, curr) {
    const el = document.getElementById(canvasId);
    if (!el || !window.Chart) return;
    _charts.perDay = new window.Chart(el, {
        type: 'bar',
        data: {
            labels: dayRows.map(r => r.date),
            datasets: [{
                data: dayRows.map(r => Number(r.pl.toFixed(2))),
                backgroundColor: dayRows.map(r => r.pl >= 0 ? '#00c805' : '#ff3131'),
                borderRadius: 4,
                maxBarThickness: 22
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => fmtMoney(curr, ctx.parsed.x) } }
            },
            scales: {
                x: { ticks: { color: '#888', font: { size: 10 }, callback: (v) => curr + v }, grid: { color: '#1a1a1a' } },
                y: { ticks: { color: '#888', font: { size: 9.5 } }, grid: { display: false } }
            }
        }
    });
}

export function renderPnlOverviewUI(container, trades, topStrategies) {
    destroyCharts();
    const list = trades || [];
    const curr = dominantCurrency(list);
    const wins   = list.filter(t => (Number(t.pl)||0) > 0).length;
    const losses = list.filter(t => (Number(t.pl)||0) < 0).length;
    const total  = list.length;
    const winRate  = total ? (wins/total*100) : 0;
    const lossRate = total ? (losses/total*100) : 0;
    const netPl = list.reduce((s,t) => s + (Number(t.pl)||0), 0);

    // Profit per day (real trade dates, grouped + summed).
    // Chart.js horizontal bars (indexAxis:'y') plot array index 0 at the TOP,
    // so we sort newest date -> oldest date (descending) here so the freshest
    // day shows on top and older days stack downward below it.
    const byDay = {};
    list.forEach(t => { const d = t.date || '—'; byDay[d] = (byDay[d]||0) + (Number(t.pl)||0); });
    const dayRows = Object.entries(byDay)
        .map(([date, pl]) => ({ date, pl }))
        .sort((a,b) => b.date.localeCompare(a.date));

    const combos = (topStrategies || []).slice(0, 3);

    container.innerHTML = `
        <div style="font-size:0.6rem;color:#555;margin-bottom:14px;font-style:italic;">
            Selected cluster/account ke <b style="color:var(--gold);">last ${total} trades</b> se compute kiya gaya PnL overview — win rate, net P/L aur loss rate real gauge rings mein, top-3 auto-ranked strategies ka contribution, aur din-wise profit breakdown.
        </div>

        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:20px;">
            ${gaugeCard('PnL Rate', winRate.toFixed(0)+'%', wins+'W / '+total+'T', winRate, '#e8e8e8', '#2a2a2a')}
            ${gaugeCard('Profit', fmtMoney(curr, netPl), 'Net P/L', netPl>=0?100:0, netPl>=0?'#4a9eff':'#ff3131', '#1a2733')}
            ${gaugeCard('Loss Rate', lossRate.toFixed(0)+'%', losses+'L / '+total+'T', lossRate, '#ff3131', '#331313')}
        </div>

        <div style="background:#0a0a0a;border:1px solid #1a1a1a;border-radius:12px;padding:16px;margin-bottom:16px;">
            <div style="font-size:0.62rem;color:var(--gold);letter-spacing:1.5px;font-weight:bold;margin-bottom:10px;text-transform:uppercase;">📊 Win by Strategy</div>
            ${combos.length
                ? `<div style="height:200px;"><canvas id="pnlStrategyChart"></canvas></div>`
                : `<p style="color:#555;font-size:0.7rem;">Strategy Discovery se koi ranked combo nahi mila — pre-entry linked trades chahiye.</p>`}
        </div>

        <div style="background:#0a0a0a;border:1px solid #1a1a1a;border-radius:12px;padding:16px;">
            <div style="font-size:0.62rem;color:var(--gold);letter-spacing:1.5px;font-weight:bold;margin-bottom:10px;text-transform:uppercase;">📅 Profit per Day</div>
            ${dayRows.length
                ? `<div style="height:${Math.max(160, dayRows.length*26)}px;"><canvas id="pnlPerDayChart"></canvas></div>`
                : `<p style="color:#555;font-size:0.7rem;">Is selection mein abhi koi trade nahi mila.</p>`}
        </div>`;

    if (combos.length) drawWinByStrategy('pnlStrategyChart', combos, curr);
    if (dayRows.length) drawProfitPerDay('pnlPerDayChart', dayRows, curr);
}
