// ══════════════════════════════════════════════════════════════════
// ADVANCED METRICS — R-Multiple · Drawdown · Session · Regime · MAE/MFE
// All numbers derived from real trade records saved by the trader.
// No fabricated/estimated data — fields not yet present on older
// trades (sl, riskAmt, mstate, maeMfe, preEntryTime) are simply
// excluded from that specific metric's sample, and the sample size
// is always shown honestly next to each number.
// ══════════════════════════════════════════════════════════════════

const IST_SESSIONS = [
    { name: 'Asian',   start: 5.5,  end: 12.0, color: '#4a9eff' },
    { name: 'London',  start: 12.0, end: 18.0, color: '#ffaa00' },
    { name: 'New York',start: 18.0, end: 23.5, color: '#00c805' },
    { name: 'Off-Hours', start: 23.5, end: 5.5, color: '#888' }
];

function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : 0; }
function fmtMoney(curr, v) { const s = v>=0?'+':'-'; return `${s}${curr}${Math.abs(v).toFixed(2)}`; }
function fmtR(v) { const s = v>=0?'+':''; return `${s}${v.toFixed(2)}R`; }
function dominantCurrency(trades) {
    const counts = {}; trades.forEach(t=>{const c=t._curr||'$'; counts[c]=(counts[c]||0)+1;});
    let best='$',bestN=-1; Object.entries(counts).forEach(([c,n])=>{if(n>bestN){best=c;bestN=n;}});
    return best;
}
// IST hour-of-day (0-24) from an ISO timestamp
function istHour(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    // Server/device timestamps are stored as ISO (UTC-based via toISOString); convert to IST (+5:30)
    const utcH = d.getUTCHours() + d.getUTCMinutes()/60;
    let ist = utcH + 5.5;
    if (ist >= 24) ist -= 24;
    return ist;
}
function sessionForHour(h) {
    if (h === null) return null;
    for (const s of IST_SESSIONS) {
        if (s.start < s.end) { if (h >= s.start && h < s.end) return s; }
        else { if (h >= s.start || h < s.end) return s; } // wraps midnight (Off-Hours)
    }
    return null;
}

export function computeAdvancedMetrics(trades) {
    const sorted = [...(trades||[])].filter(Boolean)
        .sort((a,b) => (a.date||'').localeCompare(b.date||'') || (a.savedAt||'').localeCompare(b.savedAt||''));
    const curr = dominantCurrency(sorted);

    // ── R-MULTIPLE ──
    const rTrades = sorted.filter(t => t.riskAmt && Number(t.riskAmt) > 0);
    const rValues = rTrades.map(t => (Number(t.pl)||0) / Number(t.riskAmt));
    const winRs  = rValues.filter(r => r > 0);
    const lossRs = rValues.filter(r => r < 0);
    const rMultiple = {
        sampleSize: rTrades.length, totalSize: sorted.length,
        avgR: mean(rValues), avgWinR: mean(winRs), avgLossR: mean(lossRs),
        bestR: rValues.length ? Math.max(...rValues) : 0,
        worstR: rValues.length ? Math.min(...rValues) : 0,
        expectancyR: mean(rValues),
        rows: rTrades.map((t,i) => ({ date:t.date, asset:t.asset, pl:Number(t.pl)||0, riskAmt:Number(t.riskAmt), r:rValues[i], curr:t._curr||curr }))
    };

    // ── DRAWDOWN ──
    let peak = 0, equity = 0, maxDD = 0, maxDDPct = 0;
    let ddStartDate = null, maxDDStart = null, maxDDEnd = null, longestDDDays = 0, curDDStartDate = null;
    const curve = [];
    sorted.forEach(t => {
        equity += Number(t.pl) || 0;
        if (equity > peak) {
            peak = equity;
            curDDStartDate = null;
        } else if (curDDStartDate === null && equity < peak) {
            curDDStartDate = t.date;
        }
        const dd = peak - equity;
        const ddPct = peak > 0 ? (dd / peak * 100) : (dd > 0 ? 100 : 0);
        if (dd > maxDD) { maxDD = dd; maxDDPct = ddPct; maxDDStart = curDDStartDate; maxDDEnd = t.date; }
        curve.push({ date: t.date, equity, dd, ddPct });
    });
    let longestDD = 0;
    if (maxDDStart && maxDDEnd) {
        const d1 = new Date(maxDDStart), d2 = new Date(maxDDEnd);
        if (!isNaN(d1) && !isNaN(d2)) longestDD = Math.max(0, Math.round((d2-d1)/(1000*3600*24)));
    }
    const netProfit = equity;
    const drawdown = {
        maxDD, maxDDPct, maxDDStart, maxDDEnd, longestDD,
        recoveryFactor: maxDD > 0 ? (netProfit / maxDD) : null,
        netProfit, curve
    };

    // ── SESSION / TIME-OF-DAY (IST) ──
    const sessStats = {};
    IST_SESSIONS.forEach(s => sessStats[s.name] = { name:s.name, color:s.color, count:0, wins:0, pl:0 });
    let sessSampleSize = 0;
    sorted.forEach(t => {
        const h = istHour(t.preEntryTime || t.savedAt);
        const s = sessionForHour(h);
        if (!s) return;
        sessSampleSize++;
        sessStats[s.name].count++;
        sessStats[s.name].pl += Number(t.pl)||0;
        if (t.type === 'Target') sessStats[s.name].wins++;
    });
    const session = {
        sampleSize: sessSampleSize, totalSize: sorted.length,
        stats: Object.values(sessStats).filter(s=>s.count>0).map(s => ({ ...s, winRate: s.count?(s.wins/s.count*100):0 }))
    };

    // ── MARKET REGIME ──
    const regimeStats = {};
    let regimeSampleSize = 0;
    sorted.forEach(t => {
        if (!t.mstate) return;
        regimeSampleSize++;
        if (!regimeStats[t.mstate]) regimeStats[t.mstate] = { name:t.mstate, count:0, wins:0, pl:0 };
        regimeStats[t.mstate].count++;
        regimeStats[t.mstate].pl += Number(t.pl)||0;
        if (t.type === 'Target') regimeStats[t.mstate].wins++;
    });
    const volStats = {};
    sorted.forEach(t => {
        if (!t.volatility) return;
        if (!volStats[t.volatility]) volStats[t.volatility] = { name:t.volatility, count:0, wins:0, pl:0 };
        volStats[t.volatility].count++;
        volStats[t.volatility].pl += Number(t.pl)||0;
        if (t.type === 'Target') volStats[t.volatility].wins++;
    });
    const regime = {
        sampleSize: regimeSampleSize, totalSize: sorted.length,
        marketState: Object.values(regimeStats).map(r => ({ ...r, winRate: r.count?(r.wins/r.count*100):0 })).sort((a,b)=>b.pl-a.pl),
        volatility: Object.values(volStats).map(r => ({ ...r, winRate: r.count?(r.wins/r.count*100):0 })).sort((a,b)=>b.pl-a.pl)
    };

    // ── MAE / MFE ──
    const maeTrades = sorted.filter(t => t.maeMfe !== undefined && t.maeMfe !== null && t.maeMfe !== 0 && t.type !== 'Break Even');
    const gaveBack   = maeTrades.filter(t => t.type === 'Target' && t.maeMfe < 0);     // won, but dipped toward SL first
    const recovered  = maeTrades.filter(t => t.type === 'Stop Loss' && t.maeMfe > 0);  // lost, but was toward TP first
    const maeMfe = {
        sampleSize: maeTrades.length, totalSize: sorted.length,
        avgAdverseOnWins: gaveBack.length ? mean(gaveBack.map(t=>Math.abs(t.maeMfe))) : null,
        avgFavorableOnLosses: recovered.length ? mean(recovered.map(t=>t.maeMfe)) : null,
        gaveBackCount: gaveBack.length, recoveredCount: recovered.length,
        rows: maeTrades.map(t => ({ date:t.date, asset:t.asset, type:t.type, pl:Number(t.pl)||0, maeMfe:t.maeMfe, curr:t._curr||curr }))
    };

    return { curr, count: sorted.length, rMultiple, drawdown, session, regime, maeMfe };
}

function statCard(label, value, sub, color) {
    return `<div style="background:#0a0a0a;border:1px solid #1a1a1a;border-radius:8px;padding:12px 14px;">
        <div style="font-size:0.5rem;color:#666;letter-spacing:2px;font-weight:bold;margin-bottom:6px;">${label}</div>
        <div style="font-size:1.1rem;font-weight:900;color:${color||'#ccc'};">${value}</div>
        ${sub ? `<div style="font-size:0.55rem;color:#555;margin-top:3px;">${sub}</div>` : ''}
    </div>`;
}

function sectionHeader(icon, title, sampleSize, totalSize) {
    return `<div style="display:flex;justify-content:space-between;align-items:center;margin:22px 0 10px;flex-wrap:wrap;gap:6px;">
        <div style="font-size:0.62rem;color:#ff9955;letter-spacing:2px;font-weight:bold;">${icon} ${title}</div>
        <div style="font-size:0.55rem;color:#555;">Sample: ${sampleSize} of ${totalSize} trades ${sampleSize<totalSize ? '(baaki trades mein ye field abhi nahi tha)':''}</div>
    </div>`;
}

function barRow(name, value, maxAbs, color, curr, isMoney) {
    const pct = maxAbs > 0 ? Math.min(100, Math.abs(value)/maxAbs*100) : 0;
    const display = isMoney ? fmtMoney(curr, value) : value.toFixed(2)+'%';
    return `<div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:0.65rem;margin-bottom:3px;">
            <span style="color:#ccc;">${name}</span>
            <span style="color:${value>=0?'#00c805':'#ff3333'};font-weight:bold;">${display}</span>
        </div>
        <div style="background:#111;border-radius:4px;height:8px;overflow:hidden;">
            <div style="background:${color};height:100%;width:${pct}%;"></div>
        </div>
    </div>`;
}

export function renderAdvancedMetricsUI(container, trades) {
    const m = computeAdvancedMetrics(trades || []);
    const c = m.curr;

    if (!m.count) {
        container.innerHTML = `<div style="color:#555;font-size:0.75rem;padding:30px;text-align:center;">Is selection ke liye abhi koi trade data nahi mila.</div>`;
        return;
    }

    // R-MULTIPLE SECTION
    const r = m.rMultiple;
    const rHtml = r.sampleSize ? `
        ${sectionHeader('📐','R-MULTIPLE (Risk-Adjusted Performance)', r.sampleSize, r.totalSize)}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px;">
            ${statCard('EXPECTANCY', fmtR(r.expectancyR), 'Avg R per trade', r.expectancyR>=0?'#00c805':'#ff3333')}
            ${statCard('AVG WIN', fmtR(r.avgWinR||0), '', '#00c805')}
            ${statCard('AVG LOSS', fmtR(r.avgLossR||0), '', '#ff3333')}
            ${statCard('BEST TRADE', fmtR(r.bestR), '', '#00c805')}
            ${statCard('WORST TRADE', fmtR(r.worstR), '', '#ff3333')}
        </div>
        <div style="font-size:0.6rem;color:#555;margin-bottom:8px;">R = P/L ÷ Planned Risk Amount (jo Pre-Entry mein set kiya tha). Institutional desks profit ko $ mein nahi, R mein measure karte hain — isse position-size badalne ke bawajood performance compare ho paati hai.</div>
    ` : `${sectionHeader('📐','R-MULTIPLE', 0, m.count)}<div style="color:#555;font-size:0.65rem;padding:10px;">Koi trade mila nahi jisme Risk Amount pre-entry se linked ho. Ye naye trades se automatically aana shuru hoga.</div>`;

    // DRAWDOWN SECTION
    const d = m.drawdown;
    const ddHtml = `
        ${sectionHeader('📉','DRAWDOWN ANALYTICS', m.count, m.count)}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px;">
            ${statCard('MAX DRAWDOWN', fmtMoney(c, -d.maxDD), d.maxDDPct.toFixed(1)+'% of peak', '#ff3333')}
            ${statCard('DD DURATION', d.longestDD + ' days', d.maxDDStart ? `${d.maxDDStart} → ${d.maxDDEnd}` : '', '#ffaa00')}
            ${statCard('RECOVERY FACTOR', d.recoveryFactor!==null ? d.recoveryFactor.toFixed(2)+'x' : '—', 'Net Profit ÷ Max DD', d.recoveryFactor>=1?'#00c805':'#ffaa00')}
            ${statCard('NET PROFIT', fmtMoney(c, d.netProfit), '', d.netProfit>=0?'#00c805':'#ff3333')}
        </div>
        <div style="font-size:0.6rem;color:#555;">Max Drawdown = tumhari equity peak se sabse zyada kitna neeche gayi. Recovery Factor 1.0 se upar hona chahiye — matlab tumne apna max drawdown se zyada net kamaya.</div>
    `;

    // SESSION SECTION
    const s = m.session;
    const maxSessPl = s.stats.length ? Math.max(...s.stats.map(x=>Math.abs(x.pl)), 1) : 1;
    const sessHtml = s.sampleSize ? `
        ${sectionHeader('🕐','SESSION / TIME-OF-DAY BREAKDOWN (IST)', s.sampleSize, s.totalSize)}
        ${s.stats.sort((a,b)=>b.pl-a.pl).map(x => `
            <div style="margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;font-size:0.68rem;margin-bottom:3px;">
                    <span style="color:${x.color};font-weight:bold;">${x.name}</span>
                    <span style="color:#888;">${x.count} trades · ${x.winRate.toFixed(0)}% WR</span>
                </div>
                ${barRow('', x.pl, maxSessPl, x.color, c, true)}
            </div>
        `).join('')}
        <div style="font-size:0.55rem;color:#555;">IST time-zone approximation: Asian 5:30-12:00 · London 12:00-18:00 · New York 18:00-23:30 · Off-Hours baaki. Time source: Pre-Entry analysis timestamp (jab available ho) warna trade finalize time.</div>
    ` : `${sectionHeader('🕐','SESSION / TIME-OF-DAY BREAKDOWN', 0, m.count)}<div style="color:#555;font-size:0.65rem;padding:10px;">Time data nahi mila.</div>`;

    // MARKET REGIME SECTION
    const rg = m.regime;
    const maxRegPl = rg.marketState.length ? Math.max(...rg.marketState.map(x=>Math.abs(x.pl)),1) : 1;
    const maxVolPl = rg.volatility.length ? Math.max(...rg.volatility.map(x=>Math.abs(x.pl)),1) : 1;
    const regimeHtml = rg.sampleSize ? `
        ${sectionHeader('🌊','MARKET REGIME PERFORMANCE', rg.sampleSize, rg.totalSize)}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
            <div>
                <div style="font-size:0.58rem;color:#888;margin-bottom:8px;">BY MARKET STATE</div>
                ${rg.marketState.map(x => `<div style="margin-bottom:8px;"><div style="font-size:0.62rem;color:#ccc;margin-bottom:2px;">${x.name} <span style="color:#666;">(${x.count}T · ${x.winRate.toFixed(0)}% WR)</span></div>${barRow('', x.pl, maxRegPl, '#ff9955', c, true)}</div>`).join('')}
            </div>
            <div>
                <div style="font-size:0.58rem;color:#888;margin-bottom:8px;">BY VOLATILITY LEVEL</div>
                ${rg.volatility.map(x => `<div style="margin-bottom:8px;"><div style="font-size:0.62rem;color:#ccc;margin-bottom:2px;">${x.name} <span style="color:#666;">(${x.count}T · ${x.winRate.toFixed(0)}% WR)</span></div>${barRow('', x.pl, maxVolPl, '#b388ff', c, true)}</div>`).join('')}
            </div>
        </div>
        <div style="font-size:0.55rem;color:#555;margin-top:8px;">Data source: Pre-Entry Analysis ke "Market State" aur "Volatility" fields (jo har session mein already fill karte ho).</div>
    ` : `${sectionHeader('🌊','MARKET REGIME PERFORMANCE', 0, m.count)}<div style="color:#555;font-size:0.65rem;padding:10px;">Koi regime data nahi mila.</div>`;

    // MAE/MFE SECTION
    const mm = m.maeMfe;
    const maeHtml = mm.sampleSize ? `
        ${sectionHeader('📊','MAE / MFE — TRADE EXCURSION', mm.sampleSize, mm.totalSize)}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:10px;">
            ${statCard('AVG ADVERSE ON WINS', mm.avgAdverseOnWins!==null ? mm.avgAdverseOnWins.toFixed(0)+'%' : '—', mm.gaveBackCount+' winning trades', '#ff9955')}
            ${statCard('AVG FAVORABLE ON LOSSES', mm.avgFavorableOnLosses!==null ? mm.avgFavorableOnLosses.toFixed(0)+'%' : '—', mm.recoveredCount+' losing trades', '#b388ff')}
        </div>
        <div style="font-size:0.6rem;color:#555;">"Avg Adverse on Wins" = jab trade jeeta, average kitna % pehle Stop-Loss ki taraf gaya tha (bata sakta hai SL bahut tight hai ya sahi hai). "Avg Favorable on Losses" = jab trade hara, kitna % pehle Target ki taraf gaya tha (bata sakta hai exit jaldi le lete ho ya target door hai).</div>
    ` : `${sectionHeader('📊','MAE / MFE', 0, m.count)}<div style="color:#555;font-size:0.65rem;padding:10px;">Ye field naye trades se milna shuru hoga (Trade Outcome ke neeche wala scale use karo).</div>`;

    container.innerHTML = `
        <div style="font-size:0.6rem;color:#555;margin-bottom:6px;font-style:italic;">Ye report last ${m.count} trades (selected cluster/account) ka institutional-grade performance breakdown hai.</div>
        ${rHtml}
        ${ddHtml}
        ${sessHtml}
        ${regimeHtml}
        ${maeHtml}
    `;
}
