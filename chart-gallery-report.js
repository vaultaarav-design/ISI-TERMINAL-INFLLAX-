// ══════════════════════════════════════════════════════════════════
// CHART GALLERY — fixed-size trade screenshot grid
// Monitoring page → header button. Shows only what a chart-overview
// gallery needs: the trade screenshot (center-cropped into a fixed
// card size), pair, WIN/LOSS outcome, date and the auto-detected
// strategy rank (from Strategy Discovery) — nothing fabricated,
// every field pulled straight from the trade's real saved record.
// ══════════════════════════════════════════════════════════════════

function esc(v) {
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
}
function fmtMoney(curr, v) {
    v = Number(v) || 0;
    const sign = v >= 0 ? '+' : '-';
    return `${sign}${curr}${Math.abs(v).toFixed(2)}`;
}
function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function cardHTML(t, rankMap) {
    const pl    = Number(t.pl) || 0;
    const curr  = t._curr || t.currency || '$';
    const isWin = pl > 0, isLoss = pl < 0;
    const color = isWin ? '#00c805' : isLoss ? '#ff3131' : '#4a9eff';
    const badge = isWin ? 'WIN' : isLoss ? 'LOSS' : 'B/E';
    const rank  = rankMap && rankMap.get ? rankMap.get(t) : null;
    const stratLabel = rank ? `Strategy #${rank}` : null;

    return `
    <div class="cg-card" style="background:#0a0a0a;border:1px solid #1a1a1a;border-radius:10px;overflow:hidden;width:230px;">
        <div style="position:relative;width:230px;height:170px;background:#000;overflow:hidden;">
            ${t.image
                ? `<img src="${t.image}" style="width:100%;height:100%;object-fit:cover;object-position:center center;display:block;">`
                : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#444;font-size:0.62rem;">No screenshot</div>`}
            <div style="position:absolute;top:7px;left:7px;background:rgba(0,0,0,0.65);color:#e0e0e0;font-size:0.6rem;font-weight:bold;padding:3px 8px;border-radius:5px;letter-spacing:0.5px;">${esc(t.asset)}</div>
            <div style="position:absolute;top:7px;right:7px;background:rgba(0,0,0,0.65);color:${color};font-size:0.58rem;font-weight:bold;padding:3px 8px;border-radius:5px;">${esc(t.date)}</div>
        </div>
        <div style="padding:9px 10px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                <span style="display:inline-block;background:${color}22;color:${color};font-size:0.62rem;font-weight:900;padding:3px 9px;border-radius:4px;letter-spacing:1px;">${badge}</span>
                <span style="font-family:monospace;font-weight:900;font-size:0.72rem;color:${color};">${fmtMoney(curr, pl)}</span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-top:7px;gap:6px;">
                <span style="font-size:0.56rem;color:#666;">${fmtDate(t.date)}</span>
                ${stratLabel
                    ? `<span style="font-size:0.56rem;font-weight:bold;color:var(--gold);background:#1a1200;border:1px solid var(--gold);padding:2px 7px;border-radius:10px;">${stratLabel}</span>`
                    : `<span style="font-size:0.56rem;color:#555;">Unranked setup</span>`}
            </div>
        </div>
    </div>`;
}

export function renderChartGalleryUI(container, trades, rankMap) {
    // NOTE: `trades` (window._monCostReportTrades) is already sorted most-recent-first
    // upstream in monitoring.js (allTrades.sort by date desc). Do NOT reverse here —
    // reversing was pushing the newest trades to the bottom and oldest to the top.
    const list = [...(trades || [])];
    const wins   = list.filter(t => (Number(t.pl)||0) > 0).length;
    const losses = list.filter(t => (Number(t.pl)||0) < 0).length;

    container.innerHTML = `
        <div style="font-size:0.6rem;color:#555;margin-bottom:14px;font-style:italic;">
            Selected cluster/account ke <b style="color:var(--gold);">last ${list.length} trades</b> ka chart overview — har card mein sirf uss trade ka screenshot (center-cropped), pair, outcome, date aur (agar Strategy Discovery se match hua ho to) uska auto-ranked strategy tag. Card size fixed hai, sab screenshots ussi box mein center-crop hoke fit hote hain.
        </div>
        <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
            <div style="background:#0a0a0a;border:1px solid #1a1a1a;border-radius:6px;padding:8px 14px;">
                <div style="font-size:0.55rem;color:#666;letter-spacing:1px;">TOTAL</div>
                <div style="font-size:0.9rem;font-weight:bold;color:#ccc;">${list.length}</div>
            </div>
            <div style="background:#0a0a0a;border:1px solid #1a1a1a;border-radius:6px;padding:8px 14px;">
                <div style="font-size:0.55rem;color:#666;letter-spacing:1px;">WINS</div>
                <div style="font-size:0.9rem;font-weight:bold;color:#00c805;">${wins}</div>
            </div>
            <div style="background:#0a0a0a;border:1px solid #1a1a1a;border-radius:6px;padding:8px 14px;">
                <div style="font-size:0.55rem;color:#666;letter-spacing:1px;">LOSSES</div>
                <div style="font-size:0.9rem;font-weight:bold;color:#ff3131;">${losses}</div>
            </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:14px;justify-content:flex-start;">
            ${list.length ? list.map(t => cardHTML(t, rankMap)).join('') : '<p style="color:#555;font-size:0.75rem;">Is selection mein abhi koi trade nahi mila.</p>'}
        </div>`;
}
