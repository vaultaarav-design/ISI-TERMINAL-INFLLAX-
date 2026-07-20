// ══════════════════════════════════════════════════════════════════
// TRADE — FULL REPORT PAGE
// Reached by clicking a Trade Card in Monitoring's cluster view.
// Fetches ONE trade directly from Firebase by (cluster, node, key) —
// doesn't depend on monitoring.js's in-memory trade list, so this page
// works as a standalone deep-link too.
// ══════════════════════════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, get, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};
const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

(function(){
    const t = localStorage.getItem('isi_theme') || 'dark';
    document.body.classList.toggle('light-mode', t === 'light');
})();

const qs = new URLSearchParams(location.search);
const nodeIdx  = parseInt(qs.get('node'));
const fbKey    = qs.get('key');
const clusterId = qs.get('cluster');

let _trade = null, _nodeTitle = '', _curr = '$', _bestPE = null;

async function load() {
    if (isNaN(nodeIdx) || !fbKey || !clusterId) {
        document.getElementById('trBody').innerHTML = '<div class="tr-empty">Invalid trade reference.</div>';
        return;
    }
    try {
        const [tradeSnap, clusterSnap, peSnap] = await Promise.all([
            get(ref(db, `isi_v6/clusters/${clusterId}/nodes/${nodeIdx}/tradeHistory/${fbKey}`)),
            get(ref(db, `isi_v6/clusters/${clusterId}`)),
            get(ref(db, `isi_v6/preentry/${clusterId}/${nodeIdx}`))
        ]);

        _trade = tradeSnap.val();
        if (!_trade) {
            document.getElementById('trBody').innerHTML = '<div class="tr-empty">Trade record not found (may have been deleted).</div>';
            return;
        }
        const cluster = clusterSnap.val() || {};
        const node = (cluster.nodes || [])[nodeIdx] || {};
        _nodeTitle = node.title || `Account ${nodeIdx + 1}`;
        _curr = _trade.currency || node.curr || '$';

        const peRecords = peSnap.val();
        const todayPE = peRecords
            ? Object.values(peRecords).filter(r => r.date === _trade.date).sort((a,b) => (b.savedAt||'').localeCompare(a.savedAt||''))
            : [];
        _bestPE = todayPE[0];
        render(_trade, _bestPE);
    } catch (e) {
        document.getElementById('trBody').innerHTML = `<div class="tr-empty">Error loading report: ${e.message}</div>`;
    }
}

function render(t, bestPE) {
    document.getElementById('trTitle').innerText = `${t.date} | ${_nodeTitle} | ${t.asset || '—'}`;
    const plEl = document.getElementById('trPl');
    plEl.textContent = `${(t.pl||0)>=0?'+':''}${_curr}${Math.abs(t.pl||0).toFixed(2)}`;
    plEl.style.color = (t.pl||0) >= 0 ? 'var(--accent)' : 'var(--danger)';

    const viosHtml   = (t.vios || []).length
        ? t.vios.map(v => `<span class="tr-tag red">${v}</span>`).join('')
        : '<span class="tr-tag green">Clean Session</span>';
    const scalesHtml = (t.scale || []).map(s => `<span class="tr-tag green">${s}</span>`).join('') || '—';
    const smcHtml    = (t.smcFlags || []).length
        ? t.smcFlags.map(f => `<span class="tr-tag" style="color:#c5a059;border-color:#c5a059;">${f}</span>`).join('')
        : '<span style="color:#444;font-size:0.72rem;">None recorded</span>';

    // ── MFE/MAE reversal matrix (real, trader-entered excursion %) ──
    const mm = (typeof t.maeMfe === 'number') ? t.maeMfe : null;
    const mmHtml = mm === null
        ? `<p style="color:#555;font-size:0.72rem;">Excursion not recorded for this trade.</p>`
        : (() => {
            const pct = Math.max(-100, Math.min(100, mm));
            const isAdverse = pct < 0;
            const widthPct = Math.abs(pct) / 2; // half-bar max width from center
            const color = isAdverse ? 'var(--danger)' : 'var(--accent)';
            const side = isAdverse ? `left:calc(50% - ${widthPct}%);` : `left:50%;`;
            return `
                <div class="mm-bar-wrap">
                    <div class="mm-bar-mid"></div>
                    <div class="mm-bar-fill" style="${side} width:${widthPct}%; background:${color};"></div>
                </div>
                <div class="mm-label"><span>MAE (adverse) ← 100%</span><span>Entry</span><span>100% → MFE (favorable)</span></div>
                <p style="margin-top:8px;font-size:0.85rem;font-weight:bold;color:${color};">
                    ${isAdverse ? `Went ${Math.abs(pct)}% toward opposite side before recovering to ${t.type || 'outcome'}.`
                                : `Ran ${pct}% favorably before final ${t.type || 'outcome'}.`}
                </p>`;
        })();

    document.getElementById('trBody').innerHTML = `
        <div class="tr-grid">
            <div class="tr-pane">
                <h3>1. Execution Context</h3>
                <p><b>Asset:</b> ${t.asset||'—'} &nbsp; <b>Position:</b> ${t.position||'—'}</p>
                <p><b>Entry:</b> ${t.entry||'—'} &nbsp; <b>Exit:</b> ${t.exit||'—'}</p>
                <p><b>Outcome:</b> <span style="color:${t.type==='Target'?'var(--accent)':'var(--danger)'}">${t.type||'—'}</span> (Grade ${t.grade||'—'})</p>
                <p><b>Liquidity:</b> ${t.liq||'—'}</p>
            </div>
            <div class="tr-pane">
                <h3>2. Institutional Bias</h3>
                ${t.biasResult ? `<p style="color:var(--gold);font-weight:bold;">${t.biasResult}</p>` : '<p style="color:#444;">No bias recorded</p>'}
                ${t.htfMs ? `<p><b>HTF:</b> ${t.htfMs}${t.htfZone?' · '+t.htfZone:''}</p>` : ''}
                ${t.ltfMs ? `<p><b>LTF:</b> ${t.ltfMs}${t.ltfCandle?' · '+t.ltfCandle:''}</p>` : ''}
            </div>
            <div class="tr-pane">
                <h3>3. Conflict &amp; SMC Flags</h3>
                ${t.conflict ? `<p style="color:#ff8a00;font-size:0.72rem;"><b>⚠ Conflict:</b> ${t.conflict.slice(0,160)}</p>` : '<p style="color:#444;">No conflict noted</p>'}
                <p style="margin-top:6px;">${smcHtml}</p>
            </div>
            <div class="tr-pane">
                <h3>4. System Health — Violations</h3>
                <p>${viosHtml}</p>
            </div>
            <div class="tr-pane">
                <h3>5. Scales Booked</h3>
                <p>${scalesHtml}</p>
            </div>
            <div class="tr-pane">
                <h3>6. Pre-Entry Analysis</h3>
                ${bestPE ? `
                    <p><b>Score:</b> <span style="font-size:1.05rem;font-weight:900;font-family:monospace;color:${bestPE.score>=75?'var(--accent)':bestPE.score>=50?'var(--gold)':'var(--danger)'};">${bestPE.score}/100</span></p>
                    <p>Analysis timer: ${Math.floor((bestPE.timerSecs||0)/60)}m ${(bestPE.timerSecs||0)%60}s</p>
                    ${bestPE.direction ? `<p>Planned: ${bestPE.direction} · RR ${bestPE.rrPlanned||'—'}</p>` : ''}
                    ${bestPE.note ? `<p style="font-style:italic;color:#888;font-size:0.72rem;">"${bestPE.note.slice(0,140)}"</p>` : ''}
                ` : `<p style="color:#444;">No pre-entry record for this date.</p>`}
            </div>
        </div>

        <div class="tr-pane" style="margin-bottom:12px;">
            <h3>7. Psychology &amp; Lessons</h3>
            <p><b>Plan vs Emotion:</b> ${(t.psy||[])[0]||'—'}</p>
            <p><b>Setup Quality:</b> ${(t.psy||[])[1]||'—'}</p>
            <p><b>Patience:</b> ${(t.psy||[])[2]||'—'}</p>
            <p><b>Focus / Neutrality:</b> ${(t.psy||[])[3]||'—'}</p>
            <p><b>Emotional Bias:</b> ${(t.psy||[])[4]||'—'}</p>
            <p style="background:#000;padding:10px;border-left:3px solid var(--accent);border-radius:4px;">
                <b>Master Lesson:</b> ${(t.psy||[])[5]||'—'}
            </p>
        </div>

        <div class="tr-pane" style="margin-bottom:12px;">
            <h3>8. MFE / MAE — Truth Matrix Reversal Path</h3>
            ${mmHtml}
        </div>

        <div class="tr-pane" style="margin-bottom:12px;">
            <h3>9. Trade Screenshot</h3>
            ${t.image
                ? `<img src="${t.image}" class="tr-screenshot"><button class="del-ss-btn" style="margin-top:8px;" onclick="window.__deleteScreenshot()">🗑 Delete Screenshot</button>`
                : `<p style="color:#444;text-align:center;padding:16px 0;">No screenshot found</p>`}
        </div>

        <div class="tr-pane" style="margin-bottom:12px;">
            <h3>10. Account / Cluster Context</h3>
            <p><b>Cluster:</b> ${clusterId}</p>
            <p><b>Node / Account:</b> ${_nodeTitle} (index ${nodeIdx})</p>
            <p><b>Net P/L:</b> <span style="color:${(t.pl||0)>=0?'var(--accent)':'var(--danger)'};font-weight:bold;">${(t.pl||0)>=0?'+':''}${_curr}${Math.abs(t.pl||0).toFixed(2)}</span></p>
        </div>

        <div class="tr-pane">
            <h3>11. Export</h3>
            <button class="tr-pdf-btn" onclick="window.__downloadTradePDF()">⬇ DOWNLOAD PDF REPORT</button>
        </div>
    `;
}

// ── PDF export (self-contained, mirrors previous monitoring.js behaviour) ──
async function fetchImageAsBase64(url) {
    try {
        const res = await fetch(url);
        const blob = await res.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (e) { return null; }
}

window.__downloadTradePDF = async function () {
    const t = _trade;
    if (!t) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFillColor(10, 10, 10); doc.rect(0, 0, 210, 297, 'F');
    doc.setTextColor(197, 160, 89); doc.setFontSize(18);
    doc.text('ISI INSTITUTIONAL TRADE REPORT', 14, 20);

    const rows = [
        ['Date', t.date || '—'], ['Account', _nodeTitle || '—'],
        ['Asset', t.asset || '—'], ['Position', t.position || '—'],
        ['Outcome', t.type || '—'], ['Net P/L', `${_curr}${(t.pl || 0).toFixed(2)}`],
        ['Entry', t.entry || '—'], ['Exit', t.exit || '—'],
        ['Grade', t.grade || '—'], ['Liquidity', t.liq || '—'],
        ['MFE/MAE Excursion', typeof t.maeMfe === 'number' ? t.maeMfe + '%' : '—'],
        ['Scales', (t.scale || []).join(', ') || 'None'],
        ['Violations', (t.vios || []).join(', ') || 'None'],
        ['Plan vs Emotion', (t.psy || [])[0] || '—'],
        ['Setup Quality', (t.psy || [])[1] || '—'],
        ['Master Lesson', (t.psy || [])[5] || '—']
    ];

    doc.setTextColor(255, 255, 255);
    doc.autoTable({ startY: 30, body: rows, theme: 'grid', styles: { fontSize: 9 } });

    if (t.image) {
        try {
            doc.addPage();
            doc.setTextColor(197, 160, 89); doc.setFontSize(14);
            doc.text('EXECUTION PROOF', 14, 15);
            let imgData = t.image;
            if (!t.image.startsWith('data:')) imgData = await fetchImageAsBase64(t.image);
            if (imgData) {
                const fmt = imgData.includes('image/png') ? 'PNG' : 'JPEG';
                doc.addImage(imgData, fmt, 10, 22, 190, 130);
            }
        } catch (e) {}
    }
    doc.save(`Journal_${t.date || 'trade'}_${_nodeTitle || 'node'}.pdf`);
};

window.__deleteScreenshot = async function () {
    if (!confirm('Delete this screenshot?\n\nIt will disappear from the app.')) return;
    try {
        await update(ref(db, `isi_v6/clusters/${clusterId}/nodes/${nodeIdx}/tradeHistory/${fbKey}`), {
            image: null, imagePath: null
        });
        _trade.image = null; _trade.imagePath = null;
        render(_trade, _bestPE); // re-render without the screenshot section
        alert('✅ Screenshot removed successfully!');
    } catch (e) {
        alert('Error: ' + e.message);
    }
};

load();
