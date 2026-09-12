/**
 * ISI Terminal v6 — FLOATING TRADE REPORT WIDGET
 * ══════════════════════════════════════════════════════════════
 * Included on EVERY page (one <script type="module"> tag). Watches
 * Firebase `isi_v6/active_session/{cluster}/{node}` — the exact same
 * node Pre-Entry writes to on PROCEED and Terminal reads/updates on
 * Authorize Entry / Exit Price. No new backend, no new data model —
 * this widget just SURFACES what's already there, live, everywhere.
 *
 * Visible window:  entryTimestamp is set  AND  exitTimestamp is NOT.
 * That is precisely "trade is active" per the existing app logic
 * (window.revealSections stamps entryTimestamp; window.stampExitTimestamp
 * stamps exitTimestamp the moment Exit Price is filled on Terminal).
 *
 * Draggable (position remembered per-device via localStorage), but
 * NOT closable — it disappears on its own the moment the trade closes.
 * ══════════════════════════════════════════════════════════════
 */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};

let fbApp, db;
try {
    fbApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
    db = getDatabase(fbApp);
} catch (e) {
    console.warn('zone-report-widget: Firebase init skipped (likely already initialized by page script)', e);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let panelEl = null;
let timerHandle = null;
let lastSession = null;
let wasActive = false;

// ══════════════════════════════════════════════════════════════
// ZONE MATH — built ON TOP OF the entryZoneValidation object that
// Pre-Entry already computed and saved. No re-fetching, no re-guessing
// HTF/LTF numbers — just extra interpretation the trader asked for:
// kill-zone strength, allowed-direction-by-position, FOMO flag.
// ══════════════════════════════════════════════════════════════
function killZoneStrength(pct) {
    if (pct == null || isNaN(pct)) return null;
    return Math.round(Math.abs(clamp(pct, 0, 100) - 50) * 2); // 0 at mid, 100 at either edge
}
function allowedDirection(pct) {
    if (pct == null || isNaN(pct)) return '—';
    return pct < 50 ? 'LONG (Demand side)' : 'SHORT (Supply side)';
}
function zoneEdgeNote(pct) {
    if (pct == null || isNaN(pct)) return '';
    const strength = killZoneStrength(pct);
    const side = pct < 50 ? 'Demand' : 'Supply';
    if (strength >= 80)  return `${side} edge — very strong kill zone (tight stop, high-probability side)`;
    if (strength >= 50)  return `${side} lean — decent edge, not extreme`;
    return `Near mid-zone (50%) — weak edge, low conviction either way`;
}
function buildFomoWarning(direction, htfPct, ltfPct) {
    if (!direction || (htfPct == null && ltfPct == null)) return null;
    const warnings = [];
    if (direction === 'LONG' && htfPct != null && htfPct > 65)
        warnings.push(`LONG liya gaya hai lekin HTF Supply zone mein hai (${Math.round(htfPct)}%) — yeh FOMO buy ho sakta hai.`);
    if (direction === 'SHORT' && htfPct != null && htfPct < 35)
        warnings.push(`SHORT liya gaya hai lekin HTF Demand zone mein hai (${Math.round(htfPct)}%) — yeh FOMO sell ho sakta hai.`);
    if (direction === 'LONG' && ltfPct != null && ltfPct > 70)
        warnings.push(`LTF bhi Supply side (${Math.round(ltfPct)}%) pe hai — LONG ke liye late entry.`);
    if (direction === 'SHORT' && ltfPct != null && ltfPct < 30)
        warnings.push(`LTF bhi Demand side (${Math.round(ltfPct)}%) pe hai — SHORT ke liye late entry.`);
    return warnings.length ? warnings : null;
}
function buildAlignmentVerdict(htfPct, ltfPct) {
    if (htfPct == null || ltfPct == null) return { agree: null, text: 'HTF/LTF zone data incomplete.' };
    const htfSide = htfPct < 50 ? 'LONG' : 'SHORT';
    const ltfSide = ltfPct < 50 ? 'LONG' : 'SHORT';
    if (htfSide === ltfSide) {
        return { agree: true, text: `✅ HTF aur LTF dono ${htfSide} favour kar rahe hain — aligned setup.` };
    }
    return { agree: false, text: `⚠ CONFLICT — HTF ${htfSide} favour karta hai, LTF ${ltfSide} favour karta hai. Confidence kam rakho.` };
}

function buildPsychologySummary(session) {
    const ezv = session.entryZoneValidation || {};
    const htfPct = ezv.htfPositionPct, ltfPct = ezv.ltfPositionPct;
    const align = buildAlignmentVerdict(htfPct, ltfPct);
    const fomo = buildFomoWarning(session.direction, htfPct, ltfPct);
    const parts = [];
    if (htfPct != null) parts.push(`HTF: ${allowedDirection(htfPct)} @ ${Math.round(htfPct)}% (${zoneEdgeNote(htfPct)})`);
    if (ltfPct != null) parts.push(`LTF: ${allowedDirection(ltfPct)} @ ${Math.round(ltfPct)}%`);
    parts.push(align.text);
    if (fomo) parts.push('⚠ ' + fomo.join(' '));
    else parts.push('No FOMO conflict detected.');
    return parts.join(' — ');
}

// ══════════════════════════════════════════════════════════════
// PANEL — created once, reused, position persisted
// ══════════════════════════════════════════════════════════════
function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.id = 'isiFloatingReport';
    panelEl.style.cssText = `
        position:fixed; width:290px; max-height:80vh; overflow-y:auto;
        background:linear-gradient(160deg,#05070a,#0a0d12); border:1.5px solid #c5a059;
        border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,0.6); z-index:999999;
        font-family:monospace; color:#ddd; font-size:0.62rem; line-height:1.5;
        top:70px; right:10px; touch-action:none;
    `;
    document.body.appendChild(panelEl);
    makeDraggable(panelEl);
    restorePosition(panelEl);
    return panelEl;
}

function restorePosition(el) {
    try {
        const pos = JSON.parse(localStorage.getItem('isi_floating_report_pos') || 'null');
        if (pos && typeof pos.top === 'number' && typeof pos.left === 'number') {
            el.style.top = pos.top + 'px';
            el.style.left = pos.left + 'px';
            el.style.right = 'auto';
        }
    } catch (e) { /* ignore corrupt saved position */ }
}

function makeDraggable(el) {
    let dragging = false, offsetX = 0, offsetY = 0;
    const handleId = 'isiFrDragHandle';
    el.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest(`#${handleId}`);
        if (!handle) return;
        dragging = true;
        const rect = el.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const left = clamp(e.clientX - offsetX, 0, window.innerWidth - el.offsetWidth);
        const top  = clamp(e.clientY - offsetY, 0, window.innerHeight - el.offsetHeight);
        el.style.left = left + 'px';
        el.style.top  = top + 'px';
        el.style.right = 'auto';
    });
    ['pointerup', 'pointercancel'].forEach(evt => el.addEventListener(evt, () => {
        if (!dragging) return;
        dragging = false;
        localStorage.setItem('isi_floating_report_pos', JSON.stringify({
            top: parseInt(el.style.top, 10), left: parseInt(el.style.left, 10)
        }));
    }));
}

function formatDuration(ms) {
    if (!ms || ms < 0) return '00:00:00';
    const s = Math.floor(ms / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
}

function startTimer(entryTimestamp) {
    clearInterval(timerHandle);
    if (!entryTimestamp) return;
    const tick = () => {
        const el = document.getElementById('isiFrDuration');
        if (!el) return;
        el.textContent = formatDuration(Date.now() - new Date(entryTimestamp).getTime());
    };
    tick();
    timerHandle = setInterval(tick, 1000);
}

function buildReportHTML(session) {
    const ezv = session.entryZoneValidation || {};
    const htfPct = ezv.htfPositionPct, ltfPct = ezv.ltfPositionPct;
    const align = buildAlignmentVerdict(htfPct, ltfPct);
    const fomo = buildFomoWarning(session.direction, htfPct, ltfPct);
    const dirColor = session.direction === 'LONG' ? '#00c805' : '#ff3b3b';

    const row = (label, val) => `<div style="display:flex;justify-content:space-between;gap:6px;"><span style="color:#666;">${label}</span><span style="color:#eee;font-weight:bold;">${val}</span></div>`;

    return `
        <div id="${'isiFrDragHandle'}" style="cursor:move;padding:8px 10px;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.02);border-radius:9px 9px 0 0;">
            <span style="color:#c5a059;font-weight:900;letter-spacing:1px;">🔴 LIVE TRADE</span>
            <span id="isiFrDuration" style="color:#4a9eff;font-weight:900;">00:00:00</span>
        </div>
        <div style="padding:10px;">
            ${row('Asset', session.asset || '—')}
            ${row('Direction', `<span style="color:${dirColor}">${session.direction || '—'}</span>`)}
            ${row('Entry', session.entryPrice ?? '—')}

            <div style="margin-top:8px;padding-top:8px;border-top:1px dashed #222;color:#c5a059;font-weight:bold;">HTF Report</div>
            ${row('Position', htfPct != null ? Math.round(htfPct) + '%' : '—')}
            ${row('Allowed Dir', allowedDirection(htfPct))}
            ${row('Kill-Zone Strength', htfPct != null ? killZoneStrength(htfPct) + '/100' : '—')}
            <div style="color:#888;margin-top:2px;">${zoneEdgeNote(htfPct)}</div>

            <div style="margin-top:8px;padding-top:8px;border-top:1px dashed #222;color:#4a9eff;font-weight:bold;">LTF Report</div>
            ${row('Position', ltfPct != null ? Math.round(ltfPct) + '%' : '—')}
            ${row('Allowed Dir', allowedDirection(ltfPct))}
            ${row('Kill-Zone Strength', ltfPct != null ? killZoneStrength(ltfPct) + '/100' : '—')}
            <div style="color:#888;margin-top:2px;">${zoneEdgeNote(ltfPct)}</div>

            <div style="margin-top:8px;padding-top:8px;border-top:1px dashed #222;color:${align.agree === false ? '#ff3b3b' : align.agree === true ? '#00c805' : '#888'};font-weight:bold;">
                ${align.text}
            </div>
            ${fomo ? `<div style="margin-top:6px;color:#ff3b3b;font-weight:bold;">⚠ FOMO WARNING</div><div style="color:#ffb3b3;">${fomo.join('<br>')}</div>` : ''}

            <div style="margin-top:10px;padding-top:10px;border-top:1px solid #222;display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                <button id="isiFrEntryBtn" style="background:#00c805;color:#000;border:none;border-radius:5px;padding:8px 4px;font-weight:900;font-family:monospace;">🟢 ENTRY</button>
                <button id="isiFrExitBtn"  style="background:#ff3b3b;color:#000;border:none;border-radius:5px;padding:8px 4px;font-weight:900;font-family:monospace;">🔴 EXIT</button>
            </div>
        </div>
    `;
}

function wirePanelButtons() {
    const entryBtn = document.getElementById('isiFrEntryBtn');
    const exitBtn  = document.getElementById('isiFrExitBtn');
    if (entryBtn) entryBtn.onclick = () => {
        if (typeof window.revealSections === 'function') window.revealSections();
        else window.location.href = 'terminal.html';
    };
    if (exitBtn) exitBtn.onclick = () => {
        const el = document.getElementById('exitPrice');
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
        else window.location.href = 'terminal.html';
    };
}

// ══════════════════════════════════════════════════════════════
// AUTO-FILL — Section 7 Institutional Psychology Review, ONLY on
// terminal.html, ONLY into fields still empty, the instant the
// trade transitions from active → closed (exitTimestamp just stamped).
// ══════════════════════════════════════════════════════════════
function autoFillPsychology(session) {
    if (!session) return;
    const psy2 = document.getElementById('psy2');
    if (psy2 && !psy2.value.trim()) {
        psy2.value = buildPsychologySummary(session);
    }
    if (typeof window.setPsyRating === 'function') {
        const readiness = session.entryZoneValidation?.readinessMeter;
        if (typeof readiness === 'number') {
            const scaled = clamp(Math.round(readiness / 10), 1, 10);
            window.setPsyRating('psyRate2', scaled);
        }
    }
}

// ══════════════════════════════════════════════════════════════
// WATCH — Firebase listener on the shared active_session node
// ══════════════════════════════════════════════════════════════
function watch() {
    if (!db) return;
    const cluster = localStorage.getItem('isi_sel_cluster');
    const node = localStorage.getItem('isi_sel_node');
    if (!cluster || node === null || node === undefined || node === '') return;

    onValue(ref(db, `isi_v6/active_session/${cluster}/${node}`), (snap) => {
        const session = snap.val();
        const active = !!(session && session.entryTimestamp && !session.exitTimestamp);

        if (active) {
            lastSession = session;
            wasActive = true;
            const el = ensurePanel();
            el.innerHTML = buildReportHTML(session);
            el.style.display = 'block';
            wirePanelButtons();
            startTimer(session.entryTimestamp);
        } else {
            if (wasActive && session && session.exitTimestamp) {
                // Just closed — fill psychology review if we're on that page.
                autoFillPsychology(lastSession);
            }
            wasActive = false;
            clearInterval(timerHandle);
            if (panelEl) panelEl.style.display = 'none';
        }
    });
}

watch();
// Re-attach if the trader switches accounts on this device mid-session.
window.addEventListener('storage', (e) => {
    if (e.key === 'isi_sel_cluster' || e.key === 'isi_sel_node') watch();
});
