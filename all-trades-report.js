// ══════════════════════════════════════════════════════════════════
// ALL TRADES — FULL REPORT  (per-trade cards)
// Monitoring page → "Recent Sessions Recap" → 📋 Full Report button.
// Shows EVERY trade of the selected cluster/account (same last-100
// dataset used by Recent Sessions Recap & Cost of Violation report)
// as an individual card — outer border colour = outcome:
//     GREEN = profit booked · RED = loss booked · BLUE = break-even
// Each card carries the complete trade record: execution context,
// risk/R-multiple, institutional bias & SMC, session context,
// violations (+cost), psychology ratings & notes (+cost), matched
// pre-entry analysis record, screenshot, and raw meta identifiers —
// nothing from the trade object is left out.
// ══════════════════════════════════════════════════════════════════
import { ref, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { PSY_LABELS, PSY_AXIS_TYPE } from "./cost-report.js";

const _state = { trades: [], peMap: {}, filter: 'all' };

// ── HELPERS ──
function esc(v) {
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
}
function fmtMoney(curr, v) {
    v = Number(v) || 0;
    const sign = v >= 0 ? '+' : '-';
    return `${sign}${curr}${Math.abs(v).toFixed(2)}`;
}
function fmtDT(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
}
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
    PSY_LABELS.forEach((label, i) => { if (isPsyFlagged(r[i], PSY_AXIS_TYPE[i])) reasons.push(label); });
    return reasons;
}
function tagHTML(text, cls) {
    return `<span class="tag ${cls}">${esc(text)}</span>`;
}

// ── FETCH PRE-ENTRY RECORDS for every unique (cluster, node) pair present ──
async function fetchPreentryMap(db, trades) {
    const pairs = new Set();
    trades.forEach(t => { if (t._clusterId !== undefined && t._nodeIdx !== undefined) pairs.add(`${t._clusterId}||${t._nodeIdx}`); });
    const map = {};
    await Promise.all([...pairs].map(async (key) => {
        const [cId, nIdxStr] = key.split('||');
        try {
            const snap = await get(ref(db, `isi_v6/preentry/${cId}/${nIdxStr}`));
            map[key] = snap.val() || {};
        } catch (e) { map[key] = {}; }
    }));
    return map;
}
function bestPEForTrade(t, peMap) {
    const key = `${t._clusterId}||${t._nodeIdx}`;
    const records = peMap[key];
    if (!records) return null;
    const list = Object.values(records)
        .filter(r => r && r.date === t.date)
        .sort((a,b) => (b.savedAt||'').localeCompare(a.savedAt||''));
    return list[0] || null;
}

// ── MFE/MAE bar (same logic as trade-report.js) ──
function mmBarHTML(mm) {
    if (typeof mm !== 'number') return `<p class="atr-muted" style="font-size:0.7rem;">Excursion not recorded for this trade.</p>`;
    const pct = Math.max(-100, Math.min(100, mm));
    const isAdverse = pct < 0;
    const widthPct = Math.abs(pct) / 2;
    const color = isAdverse ? 'var(--danger)' : 'var(--accent)';
    const side = isAdverse ? `left:calc(50% - ${widthPct}%);` : `left:50%;`;
    return `
        <div style="position:relative;height:38px;background:#000;border-radius:6px;overflow:hidden;border:1px solid #222;">
            <div style="position:absolute;left:50%;top:0;bottom:0;width:2px;background:#444;"></div>
            <div style="position:absolute;top:5px;bottom:5px;border-radius:4px;${side}width:${widthPct}%;background:${color};"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.56rem;color:#666;margin-top:5px;">
            <span>MAE ← 100%</span><span>Entry</span><span>100% → MFE</span>
        </div>
        <p style="font-size:0.72rem;font-weight:bold;color:${color};margin-top:5px;">
            ${isAdverse ? `Went ${Math.abs(pct)}% adverse before recovering.` : `Ran ${pct}% favourably before exit.`}
        </p>`;
}

// ── ONE TRADE CARD ──
function cardHTML(t, seq, peMap) {
    const pl      = Number(t.pl) || 0;
    const curr    = t._curr || t.currency || '$';
    const isWin   = pl > 0, isLoss = pl < 0;
    const borderColor = isWin ? '#00c805' : isLoss ? '#ff3131' : '#4a9eff';
    const badgeBg     = isWin ? 'rgba(0,200,5,0.12)' : isLoss ? 'rgba(255,49,49,0.12)' : 'rgba(74,158,255,0.12)';
    const badgeText   = isWin ? '✅ PROFIT BOOKED' : isLoss ? '❌ LOSS BOOKED' : '➖ BREAK EVEN';

    const vios       = tradeViolations(t);
    const psyReasons = tradePsyReasons(t);
    const pe         = bestPEForTrade(t, peMap);
    const rMultiple  = (t.riskAmt && Number(t.riskAmt) > 0) ? (pl / Number(t.riskAmt)) : null;

    const viosHtml = vios.length
        ? vios.map(v => tagHTML(v, 'red')).join('')
        : tagHTML('Clean Session — No Violations', 'green');
    const scalesHtml = (t.scale||[]).length ? t.scale.map(s => tagHTML(s, 'green')).join('') : '<span class="atr-muted">None booked</span>';
    const smcHtml = (t.smcFlags||[]).length
        ? t.smcFlags.map(f => `<span class="tag" style="color:#c5a059;border-color:#c5a059;">${esc(f)}</span>`).join('')
        : '<span class="atr-muted">None recorded</span>';

    // Cost of Violation attribution (this trade's full P/L, per shared cost-report.js logic)
    const vioCostHtml = vios.length
        ? `<div style="margin-top:6px;">${vios.map(v => `<div style="display:flex;justify-content:space-between;font-size:0.68rem;padding:3px 0;border-bottom:1px dashed #222;">
                <span style="color:#ff9999;">${esc(v)}</span><span style="color:${pl>=0?'#00c805':'#ff5252'};font-weight:bold;">${fmtMoney(curr, pl)}</span></div>`).join('')}</div>`
        : `<p class="atr-muted" style="font-size:0.68rem;">No violation — $0 cost attributed.</p>`;

    // Psychology ratings table (all 7 axes, flagged ones highlighted + cost)
    const psyTableHtml = (Array.isArray(t.psyRating) && t.psyRating.length)
        ? `<div>${PSY_LABELS.map((label,i) => {
              const rating = t.psyRating[i];
              const flagged = isPsyFlagged(rating, PSY_AXIS_TYPE[i]);
              return `<div style="display:flex;justify-content:space-between;font-size:0.68rem;padding:3px 0;border-bottom:1px dashed #222;">
                  <span style="color:${flagged?'#d1aaff':'#888'};">${label}${flagged?' ⚠':''}</span>
                  <span style="color:${flagged?'#d1aaff':'#ccc'};font-weight:${flagged?'bold':'normal'};">${rating ?? '—'}/10${flagged?` · cost ${fmtMoney(curr,pl)}`:''}</span>
              </div>`;
          }).join('')}</div>`
        : `<p class="atr-muted" style="font-size:0.68rem;">No psychology ratings recorded.</p>`;

    // Pre-entry (matched by same date)
    const peHtml = pe ? `
        <p><b>Score:</b> <span style="font-weight:900;font-family:monospace;color:${pe.score>=75?'var(--accent)':pe.score>=50?'var(--gold)':'var(--danger)'};">${esc(pe.score)}/100</span>
           &nbsp; <b>Analysis Timer:</b> ${Math.floor((pe.timerSecs||0)/60)}m ${(pe.timerSecs||0)%60}s</p>
        <p><b>Planned Direction:</b> ${esc(pe.direction)} &nbsp; <b>RR Planned:</b> ${esc(pe.rrPlanned)} &nbsp; <b>Calc RR:</b> ${esc(pe.calcRR)}</p>
        <p><b>Entry Zone:</b> ${esc(pe.entryZone)} &nbsp; <b>Stop Zone:</b> ${esc(pe.stopZone)} &nbsp; <b>Target Zone:</b> ${esc(pe.targetZone)}</p>
        <p><b>Qty (calc):</b> ${esc(pe.calcQty)} &nbsp; <b>Risk Amt:</b> ${pe.riskAmt!=null?fmtMoney(pe.curr||curr,pe.riskAmt):'—'} &nbsp; <b>Risk %:</b> ${esc(pe.riskPct)}</p>
        <p><b>Bias Result:</b> ${esc(pe.biasResult)}</p>
        <p><b>HTF:</b> ${esc(pe.htf?.ms)}${pe.htf?.zone?' · '+pe.htf.zone:''} &nbsp; <b>LTF:</b> ${esc(pe.ltf?.ms)}${pe.ltf?.candle?' · '+pe.ltf.candle:''}</p>
        <p><b>SMC Confluence:</b> ${(pe.smm||[]).join(', ') || '—'}</p>
        <p><b>Market State:</b> ${esc(pe.mstate)} &nbsp; <b>Volatility:</b> ${esc(pe.volatility)}</p>
        ${pe.conflict ? `<p style="color:#ff8a00;"><b>⚠ Conflict:</b> ${esc(pe.conflict).slice(0,160)}</p>` : ''}
        <p><b>Session Window:</b> ${pe.sessionWindow ? `${esc(pe.sessionWindow.start)}–${esc(pe.sessionWindow.end)} (expire ${esc(pe.sessionWindow.expire)})` : '—'} &nbsp;
           <b>Session Violation:</b> ${pe.sessionViolation ? '⚠ YES' : 'No'}</p>
        ${pe.note ? `<p style="font-style:italic;color:#888;">"${esc(pe.note).slice(0,220)}"</p>` : ''}
        <p class="atr-muted" style="font-size:0.62rem;">Saved: ${fmtDT(pe.savedAt)}</p>
    ` : `<p class="atr-muted">No pre-entry record found for this date.</p>`;

    return `
    <div class="atr-card" style="border:2px solid ${borderColor};box-shadow:0 0 0 1px ${borderColor}22;">
        <div class="atr-card-header">
            <div>
                <div style="font-size:0.6rem;color:#666;letter-spacing:1px;">TRADE #${seq} &nbsp;·&nbsp; ${esc(t.date)}</div>
                <div style="font-size:0.9rem;font-weight:900;color:var(--gold);margin-top:2px;">${esc(t._nodeTitle||t.nodeTitle)} &nbsp;|&nbsp; ${esc(t.asset)}</div>
            </div>
            <div style="text-align:right;">
                <span style="display:inline-block;background:${badgeBg};color:${borderColor};font-size:0.62rem;font-weight:bold;padding:4px 10px;border-radius:5px;letter-spacing:1px;margin-bottom:4px;">${badgeText}</span>
                <div style="font-size:1.15rem;font-weight:900;color:${borderColor};font-family:monospace;">${fmtMoney(curr, pl)}</div>
                <div style="font-size:0.6rem;color:#888;">Outcome: ${esc(t.type)} &nbsp;·&nbsp; Grade ${esc(t.grade)}</div>
            </div>
        </div>

        <div class="atr-grid2">
            <div class="atr-pane">
                <h4>1 · Execution Context</h4>
                <p><b>Position:</b> ${esc(t.position)} &nbsp; <b>Liquidity:</b> ${esc(t.liq)}</p>
                <p><b>Entry:</b> ${esc(t.entry)} &nbsp; <b>Exit:</b> ${esc(t.exit)}</p>
                <p><b>Scales Booked:</b> ${scalesHtml}</p>
            </div>
            <div class="atr-pane">
                <h4>2 · Risk &amp; R-Multiple</h4>
                <p><b>SL:</b> ${esc(t.sl)} &nbsp; <b>TP:</b> ${esc(t.tp)}</p>
                <p><b>Risk Amt:</b> ${t.riskAmt!=null?fmtMoney(curr,t.riskAmt):'—'} &nbsp; <b>RR Planned:</b> ${esc(t.rrPlanned)}</p>
                <p><b>R-Multiple (realized):</b> ${rMultiple!==null?`<span style="font-weight:bold;color:${rMultiple>=0?'var(--accent)':'var(--danger)'};">${rMultiple>=0?'+':''}${rMultiple.toFixed(2)}R</span>`:'—'}</p>
            </div>
            <div class="atr-pane">
                <h4>3 · Institutional Bias &amp; Structure</h4>
                ${t.biasResult ? `<p style="color:var(--gold);font-weight:bold;">${esc(t.biasResult)}</p>` : '<p class="atr-muted">No bias recorded</p>'}
                <p><b>HTF:</b> ${esc(t.htfMs)}${t.htfZone?' · '+esc(t.htfZone):''} &nbsp; <b>LTF:</b> ${esc(t.ltfMs)}${t.ltfCandle?' · '+esc(t.ltfCandle):''}</p>
                <p><b>Market State:</b> ${esc(t.mstate)} &nbsp; <b>Volatility:</b> ${esc(t.volatility)}</p>
                <p><b>SMC Flags:</b> ${smcHtml}</p>
                ${t.conflict ? `<p style="color:#ff8a00;font-size:0.68rem;"><b>⚠ Conflict:</b> ${esc(t.conflict).slice(0,160)}</p>` : ''}
            </div>
            <div class="atr-pane">
                <h4>4 · Session Context</h4>
                <p><b>Session Window:</b> ${t.sessionWindow ? `${esc(t.sessionWindow.start)}–${esc(t.sessionWindow.end)} (expire ${esc(t.sessionWindow.expire)})` : '—'}</p>
                <p><b>Session Violation:</b> ${t.sessionViolation ? '⚠ YES' : 'No'}</p>
                <p><b>Pre-Entry Time:</b> ${fmtDT(t.preEntryTime)}</p>
                <p><b>Trade Saved:</b> ${fmtDT(t.savedAt)}</p>
            </div>
        </div>

        <div class="atr-grid2">
            <div class="atr-pane">
                <h4>5 · System Health — Violations</h4>
                <p>${viosHtml}</p>
                <div style="font-size:0.58rem;color:#666;margin-top:6px;letter-spacing:1px;">COST OF VIOLATION — THIS TRADE</div>
                ${vioCostHtml}
            </div>
            <div class="atr-pane">
                <h4>6 · Psychology — Ratings (1-10)</h4>
                ${psyTableHtml}
                ${psyReasons.length ? `<div style="font-size:0.58rem;color:#666;margin-top:6px;letter-spacing:1px;">FLAGGED AXES: ${psyReasons.join(', ')}</div>` : ''}
            </div>
        </div>

        <div class="atr-pane" style="margin-bottom:10px;">
            <h4>7 · Psychology — Notes &amp; Lesson</h4>
            <p><b>Plan vs Emotion:</b> ${esc((t.psy||[])[0])}</p>
            <p><b>Setup Quality:</b> ${esc((t.psy||[])[1])}</p>
            <p><b>Patience:</b> ${esc((t.psy||[])[2])}</p>
            <p><b>Focus / Neutrality:</b> ${esc((t.psy||[])[3])}</p>
            <p><b>Emotional Bias:</b> ${esc((t.psy||[])[4])}</p>
            <p style="background:#000;padding:8px;border-left:3px solid var(--accent);border-radius:4px;margin-top:6px;">
                <b>Master Lesson:</b> ${esc((t.psy||[])[5])}
            </p>
        </div>

        <div class="atr-pane" style="margin-bottom:10px;">
            <h4>8 · MFE / MAE — Reversal Path</h4>
            ${mmBarHTML(typeof t.maeMfe === 'number' ? t.maeMfe : null)}
        </div>

        <div class="atr-pane" style="margin-bottom:10px;">
            <h4>9 · Pre-Entry Analysis (matched by date)</h4>
            ${peHtml}
        </div>

        <div class="atr-pane" style="margin-bottom:10px;">
            <h4>10 · Trade Screenshot</h4>
            ${t.image ? `<img src="${t.image}" class="atr-screenshot">` : '<p class="atr-muted" style="text-align:center;padding:10px 0;">No screenshot found</p>'}
        </div>

        <div class="atr-pane" style="margin-bottom:10px;">
            <h4>11 · Account / Cluster / Raw Meta</h4>
            <p><b>Cluster ID:</b> ${esc(t._clusterId)} &nbsp; <b>Node Index:</b> ${esc(t._nodeIdx)} &nbsp; <b>Account:</b> ${esc(t._nodeTitle)}</p>
            <p><b>Firebase Key:</b> ${esc(t._fbKey)} &nbsp; <b>Pre-Entry Key:</b> ${esc(t.preEntryKey)}</p>
            <p><b>Currency:</b> ${esc(curr)} &nbsp; <b>Image Path:</b> ${esc(t.imagePath)}</p>
        </div>

        <div style="text-align:right;">
            <button class="atr-deep-btn" onclick="window.viewDeepDive('${t._nodeIdx}','${t._fbKey}','${t._clusterId}')">🔍 Open Full Deep-Dive + PDF Export</button>
        </div>
    </div>`;
}

// ── SUMMARY + FILTER BAR + CARD LIST ──
function renderList(container) {
    const trades = _state.trades;
    const wins   = trades.filter(t => (Number(t.pl)||0) > 0).length;
    const losses = trades.filter(t => (Number(t.pl)||0) < 0).length;
    const be     = trades.filter(t => (Number(t.pl)||0) === 0).length;
    const vioCnt = trades.filter(t => tradeViolations(t).length > 0).length;
    const psyCnt = trades.filter(t => tradePsyReasons(t).length > 0).length;

    const netByCurr = {};
    trades.forEach(t => { const c = t._curr||'$'; netByCurr[c] = (netByCurr[c]||0) + (Number(t.pl)||0); });
    const netStr = Object.entries(netByCurr).map(([c,v]) => fmtMoney(c,v)).join(' &nbsp;|&nbsp; ') || '—';

    container.innerHTML = `
        <div style="font-size:0.6rem;color:#555;margin-bottom:14px;font-style:italic;">
            Selected cluster/account ke <b style="color:var(--gold);">last ${trades.length} trades</b> — har trade ka pura data (execution, risk, bias/SMC, session, violations, psychology, pre-entry, screenshot) individual card mein. Card ki outer border: <span style="color:#00c805;">green = profit</span>, <span style="color:#ff3131;">red = loss</span>, <span style="color:#4a9eff;">blue = break-even</span>.
        </div>
        <div class="atr-summary-grid">
            <div class="atr-stat"><div class="atr-stat-label">TOTAL TRADES</div><div class="atr-stat-val" style="color:var(--gold);">${trades.length}</div></div>
            <div class="atr-stat"><div class="atr-stat-label">WINS</div><div class="atr-stat-val" style="color:#00c805;">${wins}</div></div>
            <div class="atr-stat"><div class="atr-stat-label">LOSSES</div><div class="atr-stat-val" style="color:#ff3131;">${losses}</div></div>
            <div class="atr-stat"><div class="atr-stat-label">BREAK-EVEN</div><div class="atr-stat-val" style="color:#4a9eff;">${be}</div></div>
            <div class="atr-stat"><div class="atr-stat-label">NET P/L</div><div class="atr-stat-val" style="color:var(--gold);font-size:0.85rem;">${netStr}</div></div>
            <div class="atr-stat"><div class="atr-stat-label">VIOLATION TRADES</div><div class="atr-stat-val" style="color:#ff9999;">${vioCnt}</div></div>
            <div class="atr-stat"><div class="atr-stat-label">PSYCH-FLAGGED</div><div class="atr-stat-val" style="color:#d1aaff;">${psyCnt}</div></div>
        </div>
        <div class="atr-filterbar">
            <button class="atr-chip-btn ${_state.filter==='all'?'active':''}" onclick="window.__atrSetFilter('all')">ALL (${trades.length})</button>
            <button class="atr-chip-btn ${_state.filter==='win'?'active':''}" onclick="window.__atrSetFilter('win')">✅ PROFIT (${wins})</button>
            <button class="atr-chip-btn ${_state.filter==='loss'?'active':''}" onclick="window.__atrSetFilter('loss')">❌ LOSS (${losses})</button>
            <button class="atr-chip-btn ${_state.filter==='be'?'active':''}" onclick="window.__atrSetFilter('be')">➖ BREAK-EVEN (${be})</button>
            <button class="atr-chip-btn ${_state.filter==='vio'?'active':''}" onclick="window.__atrSetFilter('vio')">⚠ VIOLATIONS (${vioCnt})</button>
            <button class="atr-chip-btn ${_state.filter==='psy'?'active':''}" onclick="window.__atrSetFilter('psy')">🧠 PSYCH-FLAGGED (${psyCnt})</button>
        </div>
        <div id="atrCardsWrap" class="atr-cards"></div>
        <div style="margin-top:18px;padding-top:12px;border-top:1px solid #1a1a1a;font-size:0.52rem;color:#333;letter-spacing:1px;text-align:center;">
            ISI TERMINAL · ALL TRADES — FULL REPORT · GENERATED ${new Date().toLocaleString()}
        </div>
    `;

    window.__atrSetFilter = function (f) { _state.filter = f; renderList(container); };
    renderCards();
}

function renderCards() {
    const wrap = document.getElementById('atrCardsWrap');
    if (!wrap) return;
    let list = _state.trades;
    if      (_state.filter === 'win')  list = list.filter(t => (Number(t.pl)||0) > 0);
    else if (_state.filter === 'loss') list = list.filter(t => (Number(t.pl)||0) < 0);
    else if (_state.filter === 'be')   list = list.filter(t => (Number(t.pl)||0) === 0);
    else if (_state.filter === 'vio')  list = list.filter(t => tradeViolations(t).length > 0);
    else if (_state.filter === 'psy')  list = list.filter(t => tradePsyReasons(t).length > 0);

    wrap.innerHTML = list.length
        ? list.map((t,i) => cardHTML(t, i+1, _state.peMap)).join('')
        : `<div style="color:#555;padding:20px;text-align:center;">No trades match this filter.</div>`;
}

// ── PUBLIC ENTRY POINT ──
export async function renderAllTradesReportUI(container, trades, db) {
    trades = trades || [];
    if (!trades.length) {
        container.innerHTML = `<div style="color:#555;font-size:0.75rem;padding:30px;text-align:center;">
            Is selection ke liye abhi koi trade data nahi mila. Pehle cluster/account select karke kuch trades finalize karo.
        </div>`;
        return;
    }
    container.innerHTML = `<div style="text-align:center;padding:40px;color:#888;font-size:0.75rem;">⏳ Loading complete trade-by-trade data (fetching pre-entry records)...</div>`;
    let peMap = {};
    try { peMap = await fetchPreentryMap(db, trades); } catch (e) { peMap = {}; }
    _state.trades = trades;
    _state.peMap  = peMap;
    if (_state.filter !== 'all' && _state.filter !== 'win' && _state.filter !== 'loss' && _state.filter !== 'be' && _state.filter !== 'vio' && _state.filter !== 'psy') {
        _state.filter = 'all';
    }
    renderList(container);
}
