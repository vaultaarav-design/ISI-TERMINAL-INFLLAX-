/**
 * ISI Terminal v6 — BEHAVIORAL CHECKLIST ENGINE
 * ══════════════════════════════════════════════════════════════
 * "Don't repeat the mistakes of the last 7 days" — a mandatory daily
 * checklist shown at the top of the Daybook, built entirely from REAL
 * data already generated elsewhere in the app. No new manual tagging
 * system — this reads and cross-references FOUR existing sources:
 *
 *  1. TERMINAL VIOLATIONS (t.vios) — trader's own self-tagged rule
 *     breaks at trade-save time (SL NOT USED, Revenge trade, FOMO
 *     entry, etc.)
 *  2. PRE-ENTRY SMI LOG (isi_v6/preentry/{c}/{n}/{key}.smi.log) —
 *     rule-bending DURING analysis: changing bias/structure/price
 *     levels after the analysis timer started (preentry.js).
 *  3. TERMINAL SMI LOG (t.termSmi.log) — forcing a Permission-Matrix
 *     timeframe conflict away by changing HTF/LTF/SMC selections
 *     just to unlock AUTHORIZE ENTRY (terminal.js).
 *  4. RISK GUARD BREACH LOG (isi_v6/risk_guard_log/{c}/{n}, type
 *     'breach') — days the daily risk limit was actually crossed and
 *     the system had to force-lock the account (risk-guard.js).
 *
 * REPEAT-OFFENDER TRACKING
 * ------------------------
 * Every time the trader submits a day's checklist with an item
 * checked ("I will not repeat this"), that's stored as an
 * acknowledgment. If that SAME mistake label occurs again on a LATER
 * date, it's flagged here as a broken promise — with a running count
 * ("Tumne yeh 3 baar 'nahi karunga' tick kiya, phir bhi 3 baar hui").
 *
 * GATING
 * ------
 * Terminal & Pre-Entry both mount a lightweight full-screen gate
 * (visual language borrowed from system-lock.js) that checks ONLY
 * whether isi_v6/behavioral_checklist/{today} has been submitted —
 * cheap, no aggregation needed there. If not submitted, the page is
 * fully frozen with a "Go to Daybook" button; the actual checklist
 * itself only exists on the Daybook.
 * ══════════════════════════════════════════════════════════════
 */
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, get, set, push, query, limitToLast } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};
const bcApp = getApps().find(a => a.name === 'isiBehavioral') || initializeApp(firebaseConfig, 'isiBehavioral');
const db = getDatabase(bcApp);

function todayStr() {
    return window._ISIDate ? window._ISIDate.todayStr() : new Date().toISOString().slice(0, 10);
}
function addDaysStr(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
function slugify(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// ══════════════════════════════════════════════════════════════
// PART 1 — LIGHTWEIGHT GATE (Terminal / Pre-Entry pages)
// ══════════════════════════════════════════════════════════════
async function isTodaySubmitted() {
    try {
        const snap = await get(ref(db, `isi_v6/behavioral_checklist/${todayStr()}`));
        return !!(snap.exists() && snap.val()?.submittedAt);
    } catch (e) {
        console.warn('Behavioral gate: check failed, failing OPEN (not blocking access):', e);
        return true; // never let a Firebase hiccup lock the trader out entirely
    }
}

function mountGateOverlay() {
    const style = document.createElement('style');
    style.textContent = `
        #bcGateOverlay {
            position: fixed; inset: 0; z-index: 2147483000;
            background: rgba(2,2,2,0.85); backdrop-filter: blur(6px) saturate(60%);
            -webkit-backdrop-filter: blur(6px) saturate(60%);
            display: flex; align-items: center; justify-content: center;
            flex-direction: column; gap: 14px; text-align: center;
            font-family: 'Courier New', monospace; padding: 24px; cursor: not-allowed;
        }
        #bcGateOverlay .bc-icon { font-size: 2.6rem; }
        #bcGateOverlay .bc-title { color: #C5A059; font-size: 1.05rem; font-weight: 700; letter-spacing: 2px; }
        #bcGateOverlay .bc-reason { color: #e0e0e0; font-size: 0.75rem; max-width: 480px; line-height: 1.6; opacity: 0.9; }
        #bcGateOverlay .bc-goto-btn {
            margin-top: 10px; background: #C5A059; color: #000; border: none;
            padding: 12px 26px; border-radius: 6px; font-weight: 900; font-size: 0.8rem;
            cursor: pointer; text-decoration: none; letter-spacing: 1px;
        }
        body.bc-gated { overflow: hidden; }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'bcGateOverlay';
    overlay.innerHTML = `
        <div class="bc-icon">📋🔒</div>
        <div class="bc-title">TODAY'S BEHAVIORAL CHECKLIST PENDING</div>
        <div class="bc-reason">Terminal aur Pre-Entry tab tak access nahi milega jab tak aaj ka
        "last 7 din ki galtiyan" checklist Daybook pe complete karke submit nahi karte. Yeh ek
        baar ka 60-second kaam hai — roz.</div>
        <a class="bc-goto-btn" href="index.html">📖 Go to Daybook & Complete Checklist</a>
    `;
    document.body.appendChild(overlay);
    document.body.classList.add('bc-gated');
    ['click', 'keydown', 'touchstart', 'wheel'].forEach(evt => {
        document.addEventListener(evt, e => {
            if (!overlay.contains(e.target)) { e.stopPropagation(); e.preventDefault(); }
        }, true);
    });
}

// Call this on Terminal / Pre-Entry page load.
window.ISI_BehavioralGate_mount = async function () {
    const ok = await isTodaySubmitted();
    if (!ok) mountGateOverlay();
};

// ══════════════════════════════════════════════════════════════
// PART 2 — DAYBOOK: 7-DAY MISTAKE AGGREGATION
// ══════════════════════════════════════════════════════════════
const MISTAKE_LABELS = {}; // slug -> { label, source }

function addOccurrence(map, label, source, dateStr) {
    const id = slugify(label);
    if (!map[id]) map[id] = { id, label, source, count: 0, dates: [] };
    map[id].count++;
    if (!map[id].dates.includes(dateStr)) map[id].dates.push(dateStr);
    MISTAKE_LABELS[id] = { label, source };
}

const SMI_SECTION_LABEL = {
    BIAS:  'Pre-Entry: Bias badla mid-analysis (rule-bending)',
    SMC:   'Pre-Entry: SMC confluence badla mid-analysis (rule-bending)',
    STATE: 'Pre-Entry: Market State/Volatility badla mid-analysis (rule-bending)',
    RISK:  'Pre-Entry: Entry/SL/Target price badla mid-analysis (rule-bending)',
};

/**
 * Pulls all 4 sources, determines the last 7 TRADING days (days with
 * actual activity — a trade, a Pre-Entry session, or a Risk Guard
 * breach — NOT just the last 7 calendar days, since weekends/breaks
 * would otherwise make the checklist go empty while older
 * unaddressed mistakes get silently skipped), and returns a sorted
 * array of unique mistake items scoped to those 7 trading days.
 */
export async function aggregateLast7Days() {
    const today = todayStr();
    // Wide lookback ceiling — generous enough to find 7 trading days
    // even after a multi-week gap, without scanning unbounded history.
    const lookbackFloor = addDaysStr(today, -45);
    const inLookback = d => d && d >= lookbackFloor && d <= today;

    const rawOccurrences = []; // { label, source, date }
    const activeDates = new Set();
    const trackDate = d => { if (inLookback(d)) activeDates.add(d); };
    const record = (label, source, date) => {
        if (!inLookback(date)) return;
        rawOccurrences.push({ label, source, date });
        trackDate(date);
    };

    // ── Source 1 & 3: Terminal trades (vios + termSmi) ──
    try {
        const snap = await get(ref(db, 'isi_v6/clusters'));
        const clusters = snap.val() || {};
        Object.values(clusters).forEach(cluster => {
            Object.values(cluster.nodes || {}).forEach(node => {
                Object.values(node.tradeHistory || {}).forEach(t => {
                    if (!t || !t.date) return;
                    trackDate(t.date); // every trade counts as a trading day, even with no violations
                    (t.vios || []).forEach(v => record(v, 'Terminal (self-tagged)', t.date));
                    if (t.termSmi && (t.termSmi.log || []).length) {
                        record('Terminal: HTF/LTF/SMC badla conflict bypass karne ke liye', 'Terminal SMI', t.date);
                    }
                });
            });
        });
    } catch (e) { console.warn('Behavioral checklist: clusters fetch failed:', e); }

    // ── Source 2: Pre-Entry SMI log ──
    try {
        const snap = await get(ref(db, 'isi_v6/preentry'));
        const preentry = snap.val() || {};
        Object.values(preentry).forEach(clusterNodes => {
            Object.values(clusterNodes || {}).forEach(nodeEntries => {
                Object.values(nodeEntries || {}).forEach(rec => {
                    const d = (rec?.savedAt || '').slice(0, 10);
                    if (!rec || !d) return;
                    trackDate(d); // a Pre-Entry session also counts as activity, even without violations
                    const sectionsHit = new Set();
                    (rec.smi?.log || []).forEach(ev => sectionsHit.add(ev.section));
                    sectionsHit.forEach(sec => {
                        record(SMI_SECTION_LABEL[sec] || `Pre-Entry: ${sec} badla mid-analysis`, 'Pre-Entry SMI', d);
                    });
                });
            });
        });
    } catch (e) { console.warn('Behavioral checklist: preentry fetch failed:', e); }

    // ── Source 4: Risk Guard breaches ──
    try {
        const snap = await get(ref(db, 'isi_v6/risk_guard_log'));
        const logs = snap.val() || {};
        Object.values(logs).forEach(clusterNodes => {
            Object.values(clusterNodes || {}).forEach(nodeEntries => {
                Object.values(nodeEntries || {}).forEach(ev => {
                    if (!ev || ev.type !== 'breach' || !ev.date) return;
                    record('Risk Guard: Daily loss limit breach (account locked)', 'Risk Guard', ev.date);
                });
            });
        });
    } catch (e) { console.warn('Behavioral checklist: risk_guard_log fetch failed:', e); }

    // ── Determine the last 7 TRADING days (not calendar days) ──
    const last7TradingDays = new Set([...activeDates].sort((a, b) => b.localeCompare(a)).slice(0, 7));
    const inWindow = last7TradingDays.size
        ? d => last7TradingDays.has(d)
        : () => false; // no activity at all in the 45-day lookback — nothing to show, not a bug

    const map = {};
    rawOccurrences.filter(o => inWindow(o.date)).forEach(o => addOccurrence(map, o.label, o.source, o.date));

    // ── Cross-reference with past acknowledgments for repeat-offender count ──
    const pastAcks = await getPastAcknowledgments();
    const items = Object.values(map).map(item => {
        const ackDates = (pastAcks[item.id] || []).sort();
        let repeatCount = 0;
        if (ackDates.length) {
            const firstAck = ackDates[0];
            repeatCount = item.dates.filter(d => d > firstAck).length;
        }
        return { ...item, repeatCount, checked: false };
    }).sort((a, b) => b.count - a.count);

    return items;
}

async function getPastAcknowledgments() {
    // slug -> [dates it was checked=true in a submitted checklist, before today]
    const result = {};
    try {
        const q = query(ref(db, 'isi_v6/behavioral_checklist'), limitToLast(30));
        const snap = await get(q);
        const all = snap.val() || {};
        Object.entries(all).forEach(([date, doc]) => {
            if (!doc.submittedAt || date >= todayStr()) return;
            (doc.items || []).forEach(it => {
                if (it.checked) {
                    result[it.id] = result[it.id] || [];
                    result[it.id].push(date);
                }
            });
        });
    } catch (e) { console.warn('Behavioral checklist: history fetch failed:', e); }
    return result;
}

// ══════════════════════════════════════════════════════════════
// PART 3 — TODAY'S CHECKLIST STATE (persisted, cross-device)
// ══════════════════════════════════════════════════════════════
export async function getTodayChecklist() {
    const snap = await get(ref(db, `isi_v6/behavioral_checklist/${todayStr()}`));
    return snap.exists() ? snap.val() : null;
}

export async function saveTodayProgress(items) {
    await set(ref(db, `isi_v6/behavioral_checklist/${todayStr()}`), {
        date: todayStr(), items, submittedAt: null,
    });
}

export async function submitTodayChecklist(items) {
    const allChecked = items.length === 0 || items.every(i => i.checked);
    const record = { date: todayStr(), items, submittedAt: (window.ISI_NetTime ? window.ISI_NetTime.now() : new Date()).toISOString(), allChecked };
    await set(ref(db, `isi_v6/behavioral_checklist/${todayStr()}`), record);

    // Auto-log into Knowledge Base as a 'Checklist' type entry — same
    // schema Settings.html's Knowledge Base editor uses.
    try {
        const summary = items.length
            ? items.map(i => `${i.checked ? '[x]' : '[ ]'} ${i.label} (${i.count}x last 7d${i.repeatCount ? `, !! REPEATED ${i.repeatCount}x despite promise` : ''})`).join('\n')
            : 'Is 7-din ke window mein koi tracked mistake nahi mili — clean streak.';
        await push(ref(db, 'isi_v6/knowledge/entries'), {
            title: `Behavioral Checklist — ${todayStr()}`,
            type: 'Checklist',
            desc: `Auto-generated daily checklist. ${items.filter(i=>i.checked).length}/${items.length} acknowledged.`,
            tags: 'behavioral, daily-checklist, auto-generated',
            linkedTo: '',
            content: summary,
            file: null, subSections: null,
            createdAt: (window.ISI_NetTime ? window.ISI_NetTime.now() : new Date()).toISOString(), updatedAt: (window.ISI_NetTime ? window.ISI_NetTime.now() : new Date()).toISOString(),
        });
    } catch (e) { console.warn('Behavioral checklist: knowledge-base log failed:', e); }

    return record;
}

// ══════════════════════════════════════════════════════════════
// PART 4 — PDF EXPORT (works for both blank and filled checklists)
// ══════════════════════════════════════════════════════════════
export function exportChecklistPDF(items, isBlank) {
    if (!window.jspdf) { alert('PDF library load nahi hui — page refresh karo.'); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(14);
    doc.text(`ISI Terminal — Behavioral Checklist (${todayStr()})`, 14, 16);
    doc.setFontSize(9);
    doc.text(isBlank ? 'Blank copy — physical/manual tick ke liye print karo' : 'Completed copy', 14, 22);

    doc.autoTable({
        startY: 28,
        head: [['✓', 'Mistake (last 7 din)', 'Source', 'Count', 'Repeat despite promise', 'Dates']],
        body: items.length
            ? items.map(i => [
                isBlank ? '[ ]' : (i.checked ? '[x]' : '[ ]'),
                i.label, i.source, String(i.count),
                i.repeatCount ? `!! ${i.repeatCount}x` : '-',
                i.dates.join(', '),
            ])
            : [['—', 'Koi tracked mistake nahi mili last 7 din mein — clean streak 🎉', '—', '—', '—', '—']],
        theme: 'grid', styles: { fontSize: 8 },
        headStyles: { fillColor: [30, 30, 30] },
    });
    doc.save(`ISI_Behavioral_Checklist_${todayStr()}.pdf`);
}
