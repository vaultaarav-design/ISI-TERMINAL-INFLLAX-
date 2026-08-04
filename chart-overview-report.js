// ══════════════════════════════════════════════════════════════════
// CHART OVERVIEW — grid of trade screenshots
// Every trade's uploaded chart, shown as a fixed-size card: outcome
// badge (WIN/LOSS + %), date, and asset/strategy tag — same visual
// language as the reference screenshots the user shared.
// ══════════════════════════════════════════════════════════════════
function esc(v) { return (v === null || v === undefined || v === '') ? '—' : String(v); }

function pctForTrade(t) {
    const pl = Number(t.pl) || 0;
    const risk = Number(t.riskAmt);
    if (risk && risk > 0) return (pl / risk) * 100; // R-multiple based %, like their "95.52%"
    return null;
}

function cardHTML(t) {
    const pl   = Number(t.pl) || 0;
    const win  = pl > 0;
    const pct  = pctForTrade(t);
    const pctStr = pct !== null ? `${pct >= 0 ? '' : ''}${pct.toFixed(2)}%` : `${t._curr || '$'}${pl.toFixed(2)}`;
    const badgeColor = win ? '#00c805' : (pl < 0 ? '#ff3131' : '#4a9eff');
    const badgeText  = win ? 'WIN' : (pl < 0 ? 'LOSS' : 'B/E');

    return `
    <div class="co-card">
        <div class="co-img-wrap">
            ${t.image
                ? `<img src="${t.image}" class="co-img" loading="lazy" alt="${esc(t.asset)}">`
                : `<div class="co-noimg">No Screenshot</div>`}
        </div>
        <div class="co-meta">
            <div class="co-badges">
                <span class="co-badge" style="background:${badgeColor};">${badgeText}</span>
                <span class="co-pct" style="color:${badgeColor};">${pctStr}</span>
            </div>
            <div class="co-date">${esc(t.date)}</div>
            <div class="co-tags">
                <span class="co-tag">${esc(t.asset)}</span>
                ${t._nodeTitle ? `<span class="co-tag co-tag-alt">${esc(t._nodeTitle)}</span>` : ''}
            </div>
        </div>
    </div>`;
}

export function renderChartOverviewUI(container, trades) {
    trades = (trades || []).filter(Boolean)
        .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.savedAt || '').localeCompare(a.savedAt || ''));

    if (!trades.length) {
        container.innerHTML = `<div style="text-align:center;padding:40px;color:#555;">Is selection ke liye abhi koi trade nahi mila.</div>`;
        return;
    }

    const withImg = trades.filter(t => t.image).length;
    container.innerHTML = `
        <div style="font-size:0.62rem;color:#555;margin-bottom:14px;">
            ${trades.length} trades · ${withImg} ke paas screenshot hai · Har card fixed size hai, image ka center-crop dikhta hai.
        </div>
        <div class="co-grid">${trades.map(cardHTML).join('')}</div>
    `;
}
