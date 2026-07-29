// ══════════════════════════════════════════════════════════════════
// SMI — PRE-ENTRY vs TERMINAL MANIPULATION REPORT
// Some manipulation doesn't happen during Pre-Entry analysis — it
// happens LATER: Permission Matrix auto-fills honestly from Pre-Entry
// at Terminal, sometimes producing a TIMEFRAME CONFLICT that blocks
// AUTHORIZE ENTRY. If the trader then changes HTF/LTF/SMC selections
// just to force the conflict away, that's tracked here (terminal.js
// saves this as `termSmi` on the trade record) — separate from Pre-
// Entry's own SMI, which only covers rule-bending before the timer
// stopped.
// ══════════════════════════════════════════════════════════════════
function esc(v) { return (v === null || v === undefined || v === '') ? '—' : String(v); }
function fmtMoney(curr, v) {
    v = Number(v) || 0;
    const sign = v >= 0 ? '+' : '-';
    return `${sign}${curr}${Math.abs(v).toFixed(2)}`;
}
function fmtDT(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hour12:false });
}

export function computeTermSmiSummary(trades) {
    const all = (trades || []).filter(Boolean);
    const flagged = all.filter(t => t.termSmi && (t.termSmi.log || []).length > 0);
    const bypassed = flagged.filter(t => t.termSmi.conflictBypass);

    const totalPL      = all.reduce((s, t) => s + (Number(t.pl) || 0), 0);
    const manipulatedPL = flagged.reduce((s, t) => s + (Number(t.pl) || 0), 0);
    const cleanPL       = totalPL - manipulatedPL; // hypothetical: without any manipulated trade
    const bypassLoss    = bypassed.filter(t => (Number(t.pl) || 0) < 0)
        .reduce((s, t) => s + (Number(t.pl) || 0), 0);

    return {
        count: all.length, flaggedCount: flagged.length, bypassCount: bypassed.length,
        totalPL, manipulatedPL, cleanPL, bypassLoss, flagged,
    };
}

function buildEquityCurves(trades) {
    const sorted = [...(trades || [])].filter(Boolean)
        .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.savedAt || '').localeCompare(b.savedAt || ''));
    let eqActual = 0, eqClean = 0;
    const actual = [], clean = [], labels = [];
    sorted.forEach(t => {
        const pl = Number(t.pl) || 0;
        const isFlagged = t.termSmi && (t.termSmi.log || []).length > 0;
        eqActual += pl;
        if (!isFlagged) eqClean += pl;
        actual.push(eqActual);
        clean.push(eqClean);
        labels.push(t.date || '');
    });
    return { actual, clean, labels };
}

function drawTermSmiChart(canvas, curves) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const { actual, clean } = curves;
    if (!actual.length) {
        ctx.fillStyle = '#555'; ctx.font = '12px monospace'; ctx.textAlign = 'center';
        ctx.fillText('Koi manipulated trade nahi mila — chart ke liye data nahi hai.', W/2, H/2);
        return;
    }
    const all = [...actual, ...clean, 0];
    const min = Math.min(...all), max = Math.max(...all);
    const pad = (max - min) * 0.1 || 10;
    const yMin = min - pad, yMax = max + pad;
    const padL = 46, padR = 14, padT = 16, padB = 24;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    const xFor = i => padL + (actual.length <= 1 ? plotW/2 : (i / (actual.length - 1)) * plotW);
    const yFor = v => padT + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

    // zero line
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, yFor(0)); ctx.lineTo(W - padR, yFor(0)); ctx.stroke();

    // y-axis labels
    ctx.fillStyle = '#555'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
    [yMax, 0, yMin].forEach(v => ctx.fillText(v.toFixed(0), padL - 6, yFor(v) + 3));

    function drawLine(arr, color, dashed) {
        ctx.beginPath();
        ctx.setLineDash(dashed ? [5, 4] : []);
        arr.forEach((v, i) => { const x = xFor(i), y = yFor(v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
        ctx.setLineDash([]);
    }
    drawLine(clean, '#4a9eff', true);   // hypothetical: without manipulated trades
    drawLine(actual, '#ff3131', false); // actual equity (includes manipulated trades)

    // legend
    ctx.textAlign = 'left'; ctx.font = 'bold 10px monospace';
    ctx.fillStyle = '#ff3131'; ctx.fillText('● Actual P/L', padL, 12);
    ctx.fillStyle = '#4a9eff'; ctx.fillText('┄ Without manipulated trades', padL + 90, 12);
}

function tradeCardHTML(t) {
    const curr = t._curr || t.currency || '$';
    const pl = Number(t.pl) || 0;
    const sm = t.termSmi;
    const borderColor = sm.conflictBypass ? 'var(--danger)' : (sm.log||[]).length ? 'var(--gold)' : '#333';

    return `
    <div class="tsmi-card" style="border-color:${borderColor};">
        <div class="tsmi-card-head">
            <div>
                <div style="font-size:0.6rem;color:#666;letter-spacing:1px;">${esc(t.date)} · ${esc(t._nodeTitle)}</div>
                <div style="font-size:0.85rem;font-weight:900;color:var(--gold);">${esc(t.asset)} — ${esc(t.position)}</div>
            </div>
            <div style="text-align:right;">
                ${sm.conflictBypass ? '<span class="tsmi-badge tsmi-badge-danger">⚠ CONFLICT BYPASSED</span>' : '<span class="tsmi-badge tsmi-badge-warn">⚠ MODIFIED AFTER AUTO-FILL</span>'}
                <div style="font-size:1rem;font-weight:900;color:${pl>=0?'var(--accent)':'var(--danger)'};font-family:monospace;">${fmtMoney(curr, pl)}</div>
            </div>
        </div>

        <div class="tsmi-vs-grid">
            <div class="tsmi-vs-pane">
                <h5>PRE-ENTRY SAID</h5>
                <p><b>Bias:</b> ${esc(sm.preEntryBias)}</p>
                <p><b>Status:</b> ${sm.preEntryConflict ? `<span style="color:var(--danger);">🔴 BLOCKED — ${esc(sm.preEntryConflictMsg)}</span>` : '<span style="color:var(--accent);">🟢 Clear</span>'}</p>
            </div>
            <div class="tsmi-vs-pane">
                <h5>TERMINAL — AT AUTHORIZE</h5>
                <p><b>Bias:</b> ${esc(sm.terminalBias)}</p>
                <p><b>Status:</b> ${sm.terminalConflict ? `<span style="color:var(--danger);">🔴 Still Blocked</span>` : '<span style="color:var(--accent);">🟢 Cleared (entry authorized)</span>'}</p>
            </div>
        </div>

        <div class="tsmi-log-box">
            <div style="font-size:0.6rem;color:#666;letter-spacing:1px;margin-bottom:6px;">WHAT WAS CHANGED (${(sm.log||[]).length})</div>
            ${(sm.log||[]).map(ev => `<div class="tsmi-log-line">[${fmtDT(ev.ts)}] ${esc(ev.message)}</div>`).join('') || '<div style="color:#444;font-size:0.65rem;">—</div>'}
        </div>

        <div style="font-size:0.6rem;color:#555;margin-top:8px;">SMI Score for this trade: <b style="color:${sm.score>=70?'var(--gold)':'var(--danger)'};">${sm.score}/100</b></div>
    </div>`;
}

export async function renderTermSmiReportUI(container, trades) {
    trades = trades || [];
    const summary = computeTermSmiSummary(trades);
    const curr = trades.find(t => t._curr)?._curr || '$';

    if (!summary.flaggedCount) {
        container.innerHTML = `
            <div style="text-align:center;padding:40px 20px;color:#555;">
                <div style="font-size:2rem;margin-bottom:10px;">✅</div>
                <div style="font-size:0.85rem;color:#888;">Is selection ke ${summary.count} trades mein koi Terminal-side manipulation nahi mila.</div>
                <div style="font-size:0.65rem;color:#444;margin-top:8px;">Matlab jo bhi Pre-Entry ne bola, Terminal pe authorize karte waqt bhi wahi data use hua — koi Permission Matrix change nahi kiya gaya.</div>
            </div>`;
        return;
    }

    const curves = buildEquityCurves(trades);

    container.innerHTML = `
        <div class="tsmi-sticky">
            <div class="tsmi-stat"><div class="tsmi-stat-label">TOTAL TRADES</div><div class="tsmi-stat-val" style="color:var(--gold);">${summary.count}</div></div>
            <div class="tsmi-stat"><div class="tsmi-stat-label">MANIPULATED TRADES</div><div class="tsmi-stat-val" style="color:#ffb020;">${summary.flaggedCount}</div></div>
            <div class="tsmi-stat"><div class="tsmi-stat-label">CONFLICT BYPASSED</div><div class="tsmi-stat-val" style="color:var(--danger);">${summary.bypassCount}</div></div>
            <div class="tsmi-stat"><div class="tsmi-stat-label">P/L FROM MANIPULATED TRADES</div><div class="tsmi-stat-val" style="color:${summary.manipulatedPL>=0?'var(--accent)':'var(--danger)'};font-size:0.95rem;">${fmtMoney(curr, summary.manipulatedPL)}</div></div>
            <div class="tsmi-stat"><div class="tsmi-stat-label">EQUITY WITHOUT THEM WOULD BE</div><div class="tsmi-stat-val" style="color:${summary.cleanPL>=0?'var(--accent)':'var(--danger)'};font-size:0.95rem;">${fmtMoney(curr, summary.cleanPL)}</div></div>
        </div>

        <div class="tsmi-chart-wrap" id="tsmiChartWrap">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <div style="font-size:0.6rem;color:#666;letter-spacing:1px;">EQUITY IMPACT — ACTUAL vs WITHOUT MANIPULATED TRADES</div>
                <button class="tsmi-fs-btn" onclick="window.__tsmiFullscreen()">⛶ Fullscreen</button>
            </div>
            <canvas id="tsmiCanvas" style="width:100%;height:220px;"></canvas>
        </div>

        <div style="font-size:0.6rem;color:#555;margin:14px 0;">Har manipulated trade ka pura data neeche — Pre-Entry ne kya kaha tha vs Terminal pe authorize karte waqt kya tha, aur exactly kya-kya change kiya gaya.</div>
        <div class="tsmi-cards">${summary.flagged.map(tradeCardHTML).join('')}</div>
    `;

    requestAnimationFrame(() => drawTermSmiChart(document.getElementById('tsmiCanvas'), curves));

    window.__tsmiFullscreen = function () {
        const wrap = document.getElementById('tsmiChartWrap');
        if (!wrap) return;
        if (wrap.requestFullscreen) wrap.requestFullscreen();
        else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
        setTimeout(() => drawTermSmiChart(document.getElementById('tsmiCanvas'), curves), 200);
    };
    document.addEventListener('fullscreenchange', () => {
        setTimeout(() => drawTermSmiChart(document.getElementById('tsmiCanvas'), curves), 150);
    });
}
