import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, push, get, set, update, remove, query, orderByChild, startAt } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getStorage, ref as sRef, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { aiValidateSetup, aiMarketContext, showAILoading, renderAIResponse } from "./gemini.js";

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
const storage = getStorage(app);

// ── STATE ──
let clusters           = {};
let selectedClusterId  = null;

// Keep "which account is selected" in Firebase too (not just localStorage)
// — so Order Tracker / Active Orders on a second device automatically
// follows whichever account was last picked here.
function syncSelectedAccountFB(cId, nIdx) {
    if (!cId || nIdx === null || nIdx === undefined) return;
    update(ref(db, 'isi_v6/last_selection'), {
        clusterId: cId, nodeIdx: String(nIdx), updatedAt: (window.ISI_NetTime ? window.ISI_NetTime.now() : new Date()).toISOString()
    }).catch(e => console.warn('last_selection sync failed:', e));
}
let selectedNodeIdx    = null;
let analysisStart      = null;
let analysisTimerInt   = null;
let analysisElapsed    = 0; // seconds
let _peProceeded       = false; // true once PROCEED TO TERMINAL actually saved successfully

// Pre-entry data state
const peData = {
    readiness:    {},   // { shower, sleep, noemo, noloss, screen, plan }
    htf:          {},   // { ms, zone }
    ltf:          {},   // { ms, candle }
    smm:          {},   // { liqHunt, orderBlock, ... }
    mstate:       null,
    volatility:   null,
    asset:        'XAUUSD',
    direction:    '',
    entryZone:    '',
    stopZone:     '',
    targetZone:   '',
    rrPlanned:    '',
    note:         '',
    timerSecs:    0,
    savedAt:      null,
    entryZoneValidation: null, // set by updateEntryZoneValidation()
    smi:          null         // set by recalcSmiScore() — { score, log }
};

// ══════════════════════════════════════════════════════════════
// SMI — SYSTEM MANIPULATION INDEX
// Tracking starts ONLY when the Analysis Timer is pressed START.
// Whatever value already exists in a section at that moment becomes
// its "baseline" — that first value is the trader's honest call, not
// manipulation. Any value in that SAME group that is CHANGED after
// tracking begins is logged as a manipulation event with a fixed
// point penalty. Score starts at 100 and only goes down.
// ══════════════════════════════════════════════════════════════
let smiTrackingActive = false;
let smiBaseline       = {};   // groupKey -> last known value since tracking started
let smiSmmOn          = {};   // smm key -> true while currently selected (for detect-and-remove)
let smiLog            = [];   // [{ ts, section, message }]

const SMI_PENALTY = { bias: 8, smc: 10, state: 8, price: 15 };

const SMI_GROUP_LABEL = {
    htf_ms:     'Market Structure (HTF)',
    htf_zone:   'Price Zone (HTF)',
    ltf_ms:     '1-Min / 5-Min Structure (LTF)',
    ltf_candle: 'Entry Candle Context (LTF)',
    mstate:     'Market State',
    vol:        'Current Volatility Level',
};
const SMI_SMM_LABEL = {
    liqHunt: 'LIQUIDITY HUNT', liqPool: 'LIQUIDITY POOL', orderBlock: 'ORDER BLOCK',
    fvg: 'FVG / IMBALANCE', inducement: 'INDUCEMENT', manipulation: 'MANIPULATION',
    distribution: 'DISTRIBUTION', accumulation: 'ACCUMULATION',
    wyckoffSpring: 'WYCKOFF SPRING', stopHunt: 'STOP HUNT COMPLETE',
};
const SMI_PRICE_LABEL = { entryZone: 'Entry Price', stopZone: 'Stop Loss Price', targetZone: 'Target Price' };

function smiLogEvent(section, message) {
    smiLog.push({ ts: (window.ISI_NetTime ? window.ISI_NetTime.now() : new Date()).toISOString(), section, message });
    recalcSmiScore();
    renderSmiLog();
}

// Called once, the moment the analysis timer starts — snapshots whatever
// is already selected (before START was pressed) as the honest baseline.
function smiActivateTracking() {
    if (smiTrackingActive) return;
    smiTrackingActive = true;
    smiBaseline = {
        htf_ms:     peData.htf?.ms     || null,
        htf_zone:   peData.htf?.zone   || null,
        ltf_ms:     peData.ltf?.ms     || null,
        ltf_candle: peData.ltf?.candle || null,
        mstate:     peData.mstate      || null,
        vol:        peData.volatility  || null,
        entryZone:  document.getElementById('peEntryZone')?.value || null,
        stopZone:   document.getElementById('peStopZone')?.value  || null,
        targetZone: document.getElementById('peTargetZone')?.value|| null,
    };
    smiSmmOn = { ...peData.smm };
    const st = document.getElementById('smiStatus');
    if (st) { st.textContent = '🔴 LIVE — tracking every change from here'; st.style.color = 'var(--danger)'; }
}
function smiResetTracking() {
    smiTrackingActive = false;
    smiBaseline = {};
    smiSmmOn    = {};
    smiLog      = [];
    recalcSmiScore();
    renderSmiLog();
    const st = document.getElementById('smiStatus');
    if (st) { st.textContent = 'Tracking starts when you press START above'; st.style.color = '#555'; }
}

// Single-select groups: HTF ms/zone, LTF ms/candle, Market State, Volatility
function smiTrackGroupChange(groupKey, newVal) {
    if (!smiTrackingActive) return;
    const prev = smiBaseline[groupKey];
    if (prev === undefined || prev === null) { smiBaseline[groupKey] = newVal; return; } // first real pick — not manipulation
    if (prev !== newVal) {
        const label = SMI_GROUP_LABEL[groupKey] || groupKey;
        const isState = groupKey === 'mstate' || groupKey === 'vol';
        smiLogEvent(isState ? 'STATE' : 'BIAS',
            `Changed ${label} from "${prev}" → "${newVal}" after analysis started — ${isState ? 'manipulation / entry without state clarity' : 'bias manipulation'} detected.`);
        smiBaseline[groupKey] = newVal;
    }
}
// SMC multi-toggle: only a SELECT-then-REMOVE (deselect) counts
function smiTrackSmmToggle(key, isNowOn) {
    if (!smiTrackingActive) { return; }
    if (smiSmmOn[key] && !isNowOn) {
        smiLogEvent('SMC', `Deselected "${SMI_SMM_LABEL[key] || key}" after marking it on chart — manipulation / lack of focus detected.`);
    }
    smiSmmOn[key] = isNowOn;
}
// Pre-Trade Plan & Risk price fields
window.smiTrackPriceChange = function (fieldKey, newValRaw) {
    if (!smiTrackingActive) return;
    const newVal = (newValRaw || '').toString().trim();
    const prev = smiBaseline[fieldKey];
    if (prev === undefined || prev === null || prev === '') { smiBaseline[fieldKey] = newVal; return; }
    if (prev !== newVal && newVal !== '') {
        smiLogEvent('RISK', `Changed ${SMI_PRICE_LABEL[fieldKey] || fieldKey} from ${prev} → ${newVal} after analysis started — possible trade-chasing / greed behaviour (moving the goalposts as price moves).`);
        smiBaseline[fieldKey] = newVal;
    }
};

function recalcSmiScore() {
    let penalty = 0;
    smiLog.forEach(ev => {
        if (ev.section === 'BIAS')  penalty += SMI_PENALTY.bias;
        else if (ev.section === 'SMC')   penalty += SMI_PENALTY.smc;
        else if (ev.section === 'STATE') penalty += SMI_PENALTY.state;
        else if (ev.section === 'RISK')  penalty += SMI_PENALTY.price;
    });
    const score = Math.max(0, 100 - penalty);
    peData.smi = { score, log: [...smiLog] };
    const el = document.getElementById('smiScore');
    const cnt = document.getElementById('smiLogCount');
    if (cnt) cnt.textContent = smiLog.length;
    if (el) {
        el.textContent = score;
        el.style.color = score >= 90 ? 'var(--accent)' : score >= 70 ? 'var(--gold)' : 'var(--danger)';
    }
    checkSmiLockTriggers(score);
    return score;
}

// ══════════════════════════════════════════════════════════════
// SMI SYSTEM LOCK TRIGGERS — Pre-Entry
//   score < 60 → Level 1: whole system locked/frozen 15 min
//   score < 40 → Level 2: whole system locked/frozen 30 min +
//                          hard reset of this Pre-Entry
// A weaker trigger never shortens a stronger/active lock — this is
// handled centrally in system-lock.js's ISI_triggerLock().
// ══════════════════════════════════════════════════════════════
function checkSmiLockTriggers(score) {
    if (typeof window.ISI_triggerLock !== 'function') return; // system-lock.js not loaded yet
    if (score < 40) {
        window.ISI_triggerLock(
            2, 30,
            `Pre-Entry SMI score dropped to ${score} (below 40) — repeated rule-bending detected.`,
            'Pre-Entry SMI'
        );
    } else if (score < 60) {
        window.ISI_triggerLock(
            1, 15,
            `Pre-Entry SMI score dropped to ${score} (below 60) — manipulation detected during analysis.`,
            'Pre-Entry SMI'
        );
    }
}

// Called by system-lock.js when a Level-2 (30 min) lock fires from
// EITHER Pre-Entry or Terminal SMI — wipes this account's active plan
// so the trader is forced to redo Pre-Entry from scratch, then reloads.
window.ISI_hardResetPreEntry = async function (reason) {
    try {
        if (selectedClusterId !== null && selectedNodeIdx !== null) {
            await remove(ref(db, `isi_v6/active_session/${selectedClusterId}/${selectedNodeIdx}`));
        }
    } catch (e) {
        console.warn('ISI_hardResetPreEntry: could not clear active_session:', e);
    }
    try {
        sessionStorage.setItem('isi_pe_reset_notice', reason || 'SMI score bahut neeche gaya — Pre-Entry reset kar diya gaya hai. Dobara planning karo.');
        localStorage.setItem('isi_force_preentry_reset', String(Date.now())); // notify other open tabs
    } catch (e) {}
    window.location.reload();
};
function renderSmiLog() {
    const box = document.getElementById('smiLogList');
    if (!box) return;
    box.innerHTML = smiLog.length
        ? smiLog.slice().reverse().map(ev => `<div class="smi-log-item">[${ev.section}] ${ev.message}</div>`).join('')
        : `<div style="font-size:0.65rem;color:#444;padding:8px;">No manipulation detected — clean analysis so far. ✅</div>`;
}
window.toggleSmiLog = function () {
    const box = document.getElementById('smiLogList');
    if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
    renderSmiLog();
};

// ══════════════════════════════════════════════════════════════
// ENTRY ZONE VALIDATION — Institutional Entry Zone check
// Confirms whether the planned Entry Price actually sits inside the
// trader's own stated HTF and LTF zone coordinates (not just a text
// tag like "Discount" — the real high/low numbers).
// ══════════════════════════════════════════════════════════════
window.updateEntryZoneValidation = function () {
    const box = document.getElementById('ezvResult');
    if (!box) return;
    const entry    = parseFloat(document.getElementById('peEntryZone')?.value);
    const htfHighR = parseFloat(document.getElementById('ezvHtfHigh')?.value);
    const htfLowR  = parseFloat(document.getElementById('ezvHtfLow')?.value);
    const ltfHighR = parseFloat(document.getElementById('ezvLtfHigh')?.value);
    const ltfLowR  = parseFloat(document.getElementById('ezvLtfLow')?.value);
    const htfTf    = document.getElementById('ezvHtfTf')?.value || '';
    const ltfTf    = document.getElementById('ezvLtfTf')?.value || '';
    const direction = document.getElementById('peDirection')?.value || '';

    if (!entry || isNaN(htfHighR) || isNaN(htfLowR) || isNaN(ltfHighR) || isNaN(ltfLowR)) {
        box.style.borderColor = '#333';
        box.style.color = '#555';
        box.innerHTML = 'Fill Entry Price (Section 5 — Pre-Trade Plan) + both Zone High/Low fields above to validate.';
        peData.entryZoneValidation = null;
        return;
    }

    const htfLo = Math.min(htfHighR, htfLowR), htfHi = Math.max(htfHighR, htfLowR);
    const ltfLo = Math.min(ltfHighR, ltfLowR), ltfHi = Math.max(ltfHighR, ltfLowR);
    const inHtf = entry >= htfLo && entry <= htfHi;
    const inLtf = entry >= ltfLo && entry <= ltfHi;

    // Smart addition #1: zone position % (0% = at the low edge, 100% = at the high edge)
    const htfPct = htfHi > htfLo ? Math.round((entry - htfLo) / (htfHi - htfLo) * 100) : 50;
    const ltfPct = ltfHi > ltfLo ? Math.round((entry - ltfLo) / (ltfHi - ltfLo) * 100) : 50;

    // Smart addition #2: freshness — is this a fresh reaction at the zone edge (institutional-style)
    // or a late/mid-zone entry (retail-style chase)? Direction-aware.
    let freshness = null, freshCol = '#888';
    if (direction === 'LONG') {
        if (htfPct <= 30)      { freshness = 'FRESH — near zone low (discount, textbook buy)';  freshCol = 'var(--accent)'; }
        else if (htfPct <= 60) { freshness = 'MID-ZONE — acceptable but not ideal';               freshCol = 'var(--gold)';   }
        else                   { freshness = 'LATE — near zone high, this looks like chasing';    freshCol = 'var(--danger)'; }
    } else if (direction === 'SHORT') {
        if (htfPct >= 70)      { freshness = 'FRESH — near zone high (premium, textbook sell)';   freshCol = 'var(--accent)'; }
        else if (htfPct >= 40) { freshness = 'MID-ZONE — acceptable but not ideal';               freshCol = 'var(--gold)';   }
        else                   { freshness = 'LATE — near zone low, this looks like chasing';     freshCol = 'var(--danger)'; }
    }

    let tag, color, msg;
    if (inHtf && inLtf) {
        tag = '✅ INSTITUTIONAL ENTRY: ALIGNED'; color = 'var(--accent)';
        msg = `Entry sits inside both HTF (${htfTf || '—'}) and LTF (${ltfTf || '—'}) zones.`;
    } else if (inHtf || inLtf) {
        tag = '⚠ PARTIAL ALIGNMENT'; color = 'var(--gold)';
        msg = `Entry is inside the ${inHtf ? 'HTF' : 'LTF'} zone only — ${inHtf ? 'LTF' : 'HTF'} zone is missed.`;
    } else {
        tag = '❌ RETAIL CHASE'; color = 'var(--danger)';
        msg = 'Entry price is OUTSIDE both HTF and LTF zones — this looks like a chase, not an institutional entry.';
    }

    box.style.borderColor = color;
    box.innerHTML = `
        <div style="color:${color};font-weight:900;">${tag}</div>
        <div style="color:#888;font-size:0.68rem;margin-top:4px;">${msg}</div>
        ${freshness ? `<div style="color:${freshCol};font-size:0.65rem;margin-top:6px;font-weight:bold;">Zone Position: ${freshness}</div>` : ''}
        <div class="ezv-bar-wrap"><div class="ezv-bar-fill" style="left:${Math.max(0,Math.min(100,htfPct))}%;background:${color};"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:0.52rem;color:#555;margin-top:3px;"><span>Zone Low</span><span>HTF Position: ${htfPct}%</span><span>Zone High</span></div>
    `;

    peData.entryZoneValidation = {
        htfTf, ltfTf, htfHigh: htfHi, htfLow: htfLo, ltfHigh: ltfHi, ltfLow: ltfLo,
        inHtf, inLtf, aligned: inHtf && inLtf,
        htfPositionPct: htfPct, ltfPositionPct: ltfPct,
        tag: tag.replace(/^[^ ]+\s/, ''), freshness,
    };
};
function timeToMinutes(t) {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}
function formatCountdown(diffSeconds) {
    if (diffSeconds <= 0) return '00:00:00';
    const h = Math.floor(diffSeconds / 3600);
    const m = Math.floor((diffSeconds % 3600) / 60);
    const s = diffSeconds % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function getNodeSlotsForDay(node, dayName) {
    if (node.timeSlots && node.timeSlots[dayName] && Array.isArray(node.timeSlots[dayName])) {
        return node.timeSlots[dayName]
            .filter(sl => sl && sl.start)
            .map((sl, i) => ({ ...sl, slotIdx: i }));
    }
    if (node.times && node.times[dayName] && node.times[dayName].start) {
        const t = node.times[dayName];
        return [{ start:t.start, end:t.end||'', expire:t.expire||'',
            risk:node.risk??null, qtyFrom:node.qtyFrom||1, qtyTo:node.qtyTo||10, slotIdx:0 }];
    }
    return [];
}

// ── LIVE STATS CACHE ──
let liveStats = {};
onValue(ref(db, 'isi_v6/stats'), snap => {
    liveStats = snap.val() || {};
    buildPeTimerSlider(); // refresh balances/risk on slider
});

// ── FIREBASE CLUSTERS ──
onValue(ref(db, 'isi_v6/clusters'), (snap) => {
    clusters = snap.val() || {};
    document.getElementById('peFbStatus').textContent = '● LIVE';
    document.getElementById('peFbStatus').className   = 'fb-dot live';
    populateClusters();
    buildPeTimerSlider();
    loadAnalysisHistory(null, null);

    // Auto-resume if opened via Order Tracker's "RESUME" button
    // (preentry.html?resume=KEY) — runs once, after real cluster/account
    // data is actually available to switch into.
    if (!window._peUrlResumeHandled) {
        window._peUrlResumeHandled = true;
        const resumeKey = new URLSearchParams(location.search).get('resume');
        if (resumeKey && window.peResumeAnalysis) {
            setTimeout(() => window.peResumeAnalysis(resumeKey), 300);
        }
    }
});

function populateClusters() {
    const sel   = document.getElementById('peClusterSel');
    const saved = localStorage.getItem('isi_sel_cluster');
    sel.innerHTML = '<option value="">— Cluster —</option>';
    Object.entries(clusters).forEach(([id, c]) => {
        const o = document.createElement('option');
        o.value = id; o.textContent = c.title;
        sel.appendChild(o);
    });
    if (saved && clusters[saved]) {
        sel.value = saved;
        selectedClusterId = saved;
        populateAccounts(saved);
        const savedNode = localStorage.getItem('isi_sel_node');
        if (savedNode !== null && savedNode !== '') {
            document.getElementById('peAccountSel').value = savedNode;
            selectedNodeIdx = parseInt(savedNode);
        }
    }
}

function populateAccounts(clusterId) {
    const sel = document.getElementById('peAccountSel');
    sel.innerHTML = '<option value="">— Account —</option>';
    sel.disabled  = false;
    const nodes = clusters[clusterId]?.nodes || [];
    nodes.forEach((n, i) => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = `${n.title || 'Account ' + (i+1)} [#${n.order||i+1}]`;
        sel.appendChild(o);
    });
}

// ── PE TIMER SLIDER — build and auto-refresh ──
let peSliderInterval = null;

function buildPeTimerSlider() {
    const grid = document.getElementById('peTimerSlider');
    if (!grid) return;
    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][window.ISI_NetTime ? window.ISI_NetTime.nowIST().day : new Date().getDay()];
    const entries = Object.entries(clusters);
    grid.innerHTML = '';

    let todayCards = [];
    entries.forEach(([cId, cluster]) => {
        (cluster.nodes || []).forEach((node, nIdx) => {
            const slots = getNodeSlotsForDay(node, dayName);
            slots.forEach(slot => todayCards.push({ cId, cluster, node, nIdx, slot }));
        });
    });

    if (!todayCards.length) {
        grid.innerHTML = '<div style="padding:10px 18px;font-size:0.65rem;color:#444;letter-spacing:2px;">NO SCHEDULED SESSIONS TODAY</div>';
        grid.classList.add('no-anim');
        return;
    }

    const nowMin = window.ISI_NetTime ? (window.ISI_NetTime.nowIST().hours * 60 + window.ISI_NetTime.nowIST().minutes) : (new Date().getHours() * 60 + new Date().getMinutes());
    const nowSec = (window.ISI_NetTime ? window.ISI_NetTime.now() : new Date()).getSeconds();

    todayCards.forEach(({ cId, cluster, node, nIdx, slot }) => {
        const stats   = liveStats[cId]?.[String(nIdx)] || {};
        const liveBal = stats.currentBal ?? node.balance ?? 0;
        const riskPct = slot.risk ?? node.risk ?? 0;
        const riskAmt = (liveBal * riskPct / 100);
        const curr    = node.curr || '₹';
        const sIdx    = slot.slotIdx;

        const startMin  = timeToMinutes(slot.start);
        const expireMin = timeToMinutes(slot.expire);

        let phase = 'pre', st = 'ANALYSE', borderCol = '#c5a059', glowCol = 'rgba(197,160,89,0.25)';
        let countdown = '--:--:--', lbl = 'ENTRY IN';
        if (startMin !== null && nowMin < startMin) {
            const d = (startMin - nowMin)*60 - nowSec;
            countdown = formatCountdown(d); phase='pre'; st='ANALYSE';
            borderCol='#c5a059'; glowCol='rgba(197,160,89,0.25)';
        } else if (startMin !== null && expireMin !== null && nowMin>=startMin && nowMin<expireMin) {
            const d = (expireMin - nowMin)*60 - nowSec;
            countdown = formatCountdown(d); phase='entry'; st='● ENTRY';
            borderCol='#00ff41'; glowCol='rgba(0,255,65,0.3)'; lbl='EXPIRES IN';
        } else if (expireMin !== null && nowMin>=expireMin) {
            phase='closed'; st='EXPIRE'; countdown='DONE'; lbl='SESSION';
            borderCol='#ff3b3b'; glowCol='rgba(255,59,59,0.15)';
        }

        const isActive = selectedClusterId===cId && selectedNodeIdx===nIdx && slot.slotIdx===(peData._selectedSlot||0);
        const activeCss = isActive ? `border-color:#4a9eff!important;box-shadow:0 0 18px rgba(74,158,255,0.4)!important;` : '';
        const activeLabel = isActive ? '<div style="position:absolute;bottom:5px;right:8px;font-size:0.48rem;color:#4a9eff;font-weight:bold;letter-spacing:1px;">◀ LOCKED</div>' : '';
        const slotLabel = sIdx > 0 ? ` <span style="font-size:0.5rem;color:#555;">(S${sIdx+1})</span>` : '';

        const div = document.createElement('div');
        div.className = 'pe-slide-card';
        div.dataset.cluster = cId;
        div.dataset.node    = String(nIdx);
        div.dataset.slot    = String(sIdx);
        div.style.cssText   = `border-color:${borderCol};box-shadow:0 0 10px ${glowCol};${activeCss}cursor:pointer;`;
        // onclick via attribute so it survives innerHTML clone
        div.setAttribute('onclick', `selectPeCard('${cId}',${nIdx},${sIdx})`);
        div.innerHTML = `
            <div style="font-size:0.52rem;color:#666;letter-spacing:2px;font-weight:bold;">${cluster.title}</div>
            <div style="font-size:0.72rem;font-weight:900;color:#fff;margin:2px 0;">${node.title||'Account '+(nIdx+1)}${slotLabel}</div>
            <div style="font-size:0.55rem;color:#555;font-family:monospace;">${slot.start||'--'} → ${slot.expire||'--'}</div>
            <div style="margin:6px 0;font-size:0.65rem;font-weight:bold;color:${borderCol};">${st}</div>
            <div style="font-size:1.3rem;font-weight:900;color:${borderCol};font-family:monospace;">${countdown}</div>
            <div style="font-size:0.48rem;color:#555;letter-spacing:2px;margin-top:1px;">${lbl}</div>
            <div style="margin-top:6px;padding-top:6px;border-top:1px solid #1a1a1a;display:flex;justify-content:space-between;align-items:center;">
                <div style="font-size:0.6rem;color:var(--gold);font-weight:bold;">${curr}${riskAmt.toLocaleString('en-US',{maximumFractionDigits:0})}</div>
                <div style="font-size:0.52rem;color:#555;">${riskPct}% RISK</div>
            </div>
            ${activeLabel}`;
        grid.appendChild(div);
    });

    // Duplicate for seamless scroll if many cards
    if (todayCards.length > 2) {
        const clone = grid.innerHTML;
        grid.innerHTML += clone;
        grid.classList.remove('no-anim');
    } else {
        grid.classList.add('no-anim');
    }

    // Paint dark-red "RISK LOCKED" ribbon on any account still carrying
    // risk-accumulation debt (see risk-guard.js).
    if (window.ISI_applyRiskGuardOverlay) window.ISI_applyRiskGuardOverlay();
}

// Update slider countdown every second without full rebuild
function updatePeSliderCountdowns() {
    const grid = document.getElementById('peTimerSlider');
    if (!grid) return;
    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][window.ISI_NetTime ? window.ISI_NetTime.nowIST().day : new Date().getDay()];
    const nowMin  = window.ISI_NetTime ? (window.ISI_NetTime.nowIST().hours * 60 + window.ISI_NetTime.nowIST().minutes) : (new Date().getHours() * 60 + new Date().getMinutes());
    const nowSec  = (window.ISI_NetTime ? window.ISI_NetTime.now() : new Date()).getSeconds();
    grid.querySelectorAll('.pe-slide-card').forEach(card => {
        const cId  = card.dataset.cluster;
        const nIdx = parseInt(card.dataset.node);
        const sIdx = parseInt(card.dataset.slot || '0');
        const node = clusters[cId]?.nodes[nIdx];
        if (!node) return;
        const slots = getNodeSlotsForDay(node, dayName);
        const slot  = slots[sIdx] || slots[0];
        if (!slot) return;
        const startMin  = timeToMinutes(slot.start);
        const expireMin = timeToMinutes(slot.expire);
        let cd = '--:--:--', st = 'ANALYSE', lbl = 'ENTRY IN', col = '#c5a059';
        if (startMin !== null && nowMin < startMin) {
            cd = formatCountdown((startMin-nowMin)*60-nowSec); st='ANALYSE'; col='#c5a059'; lbl='ENTRY IN';
        } else if (startMin!==null && expireMin!==null && nowMin>=startMin && nowMin<expireMin) {
            cd = formatCountdown((expireMin-nowMin)*60-nowSec); st='● ENTRY'; col='#00ff41'; lbl='EXPIRES IN';
        } else { cd='DONE'; st='EXPIRE'; col='#ff3b3b'; lbl='SESSION'; }
        const cdEl = card.querySelectorAll('div')[5];
        const stEl = card.querySelectorAll('div')[4];
        const lbEl = card.querySelectorAll('div')[6];
        if (cdEl) cdEl.textContent = cd;
        if (stEl) { stEl.textContent = st; stEl.style.color = col; }
        if (lbEl) lbEl.textContent = lbl;
    });
}
setInterval(updatePeSliderCountdowns, 1000);

// ── Global onclick wrapper (survives innerHTML clone) ──
window.selectPeCard = function(cId, nIdx, sIdx) {
    selectPeSliderCard({ dataset:{ cluster:cId, node:String(nIdx), slot:String(sIdx) } });
};

// ── CLICK on PE slider card → auto-fill cluster + account + risk ──
function selectPeSliderCard(card) {
    const cId  = card.dataset.cluster;
    const nIdx = parseInt(card.dataset.node);
    const sIdx = parseInt(card.dataset.slot || '0');
    if (!cId || !clusters[cId]) return;

    // Risk Guard: this account still owes risk-accumulation debt from a
    // past breach — no new session allowed until it clears to zero.
    const rgState = window.ISI_riskGuardCache?.[cId]?.[String(nIdx)];
    if (rgState && rgState.blocked) {
        alert(`🚫 RISK LOCKED — ${clusters[cId]?.nodes?.[nIdx]?.title || 'Is account'} pe abhi trading allowed nahi.\n\nPichle session me allowed risk se zyada loss hua tha. Bacha hua risk accumulation: ${rgState.curr || ''}${(rgState.debt || 0).toFixed(2)}.\n\nYeh tab tak lock rahega jab tak accumulation zero na ho jaaye.`);
        return;
    }

    selectedClusterId = cId;
    selectedNodeIdx   = nIdx;
    peData._selectedSlot = sIdx;

    // Update header dropdowns
    const clSel  = document.getElementById('peClusterSel');
    const accSel = document.getElementById('peAccountSel');
    if (clSel)  { clSel.value = cId; }
    populateAccounts(cId);
    if (accSel) { accSel.value = String(nIdx); accSel.disabled = false; }

    localStorage.setItem('isi_sel_cluster', cId);
    localStorage.setItem('isi_sel_node',    String(nIdx));
    syncSelectedAccountFB(cId, nIdx);

    // Fill risk amount in pre-trade plan section
    const node    = clusters[cId]?.nodes[nIdx];
    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][window.ISI_NetTime ? window.ISI_NetTime.nowIST().day : new Date().getDay()];
    const slots   = getNodeSlotsForDay(node, dayName);
    const slot    = slots[sIdx] || slots[0] || {};
    const stats   = liveStats[cId]?.[String(nIdx)] || {};
    const liveBal = stats.currentBal ?? node?.balance ?? 0;
    const riskPct = slot.risk ?? node?.risk ?? 0;
    const riskAmt = (liveBal * riskPct / 100);
    const curr    = node?.curr || '₹';

    // Store in peData for calcQty use
    peData._riskAmt = riskAmt;
    peData._riskPct = riskPct;
    peData._curr    = curr;

    // Show risk amount in section 4
    const riskDisplay = document.getElementById('peRiskAmtDisplay');
    if (riskDisplay) {
        riskDisplay.textContent = `${curr}${riskAmt.toLocaleString('en-US',{maximumFractionDigits:2})}`;
        riskDisplay.style.display = 'block';
    }

    // Rebuild slider to show LOCKED state
    buildPeTimerSlider();
    loadAnalysisHistory(null, null);

    // Trigger qty recalc if entry+sl already filled
    calcQty();
}

window.onPeClusterChange = function () {
    selectedClusterId = document.getElementById('peClusterSel').value || null;
    selectedNodeIdx   = null;
    const accSel = document.getElementById('peAccountSel');
    accSel.innerHTML = '<option value="">— Account —</option>';
    accSel.disabled  = true;
    if (selectedClusterId) {
        localStorage.setItem('isi_sel_cluster', selectedClusterId);
        populateAccounts(selectedClusterId);
    }
    loadAnalysisHistory(null, null);
};

window.onPeAccountChange = function () {
    const val = document.getElementById('peAccountSel').value;
    selectedNodeIdx = val !== '' ? parseInt(val) : null;
    if (selectedNodeIdx !== null) {
        localStorage.setItem('isi_sel_node', selectedNodeIdx);
        syncSelectedAccountFB(selectedClusterId, selectedNodeIdx);
    }
    loadAnalysisHistory(null, null);
};

// ── READINESS ──
window.toggleReady = function (el, key) {
    el.classList.toggle('checked');
    peData.readiness[key] = el.classList.contains('checked');
    updateReadinessScore();
    recalcScore();
};

function updateReadinessScore() {
    const total   = Object.keys(peData.readiness).length;
    const checked = Object.values(peData.readiness).filter(Boolean).length;
    const el = document.getElementById('readinessScore');
    const pct = total ? (checked / 6) * 100 : 0;
    const color = pct === 100 ? 'var(--accent)' : pct >= 50 ? 'var(--gold)' : 'var(--danger)';
    el.style.color = color;
    el.style.borderColor = color;
    el.textContent = `Readiness: ${checked}/6 — ${
        pct === 100 ? '✅ FULLY READY TO ANALYZE' :
        pct >= 50   ? '⚡ Partially ready' :
                      '⚠ Not ready — complete items above'
    }`;
}

// ── ANALYSIS TIMER ──
window.startAnalysisTimer = function () {
    if (analysisTimerInt) return;
    if (!analysisStart) {
        analysisStart = window.ISI_NetTime ? window.ISI_NetTime.now() : new Date();
        document.getElementById('analysisSince').textContent =
            `Analysis started at ${analysisStart.toLocaleTimeString('en-GB', {hour12:false})}`;
    }
    smiActivateTracking();
    analysisTimerInt = setInterval(() => {
        analysisElapsed++;
        peData.timerSecs = analysisElapsed;
        const m = Math.floor(analysisElapsed / 60);
        const s = analysisElapsed % 60;
        document.getElementById('timerMM').textContent = String(m).padStart(2,'0');
        document.getElementById('timerSS').textContent = String(s).padStart(2,'0');
        const status = document.getElementById('timerStatus');
        if (analysisElapsed >= 900) {         // 15+ min = excellent
            status.textContent = '✅ 15+ MIN — READY';
            status.style.color = 'var(--accent)';
        } else if (analysisElapsed >= 300) {  // 5-15 min = good
            status.textContent = '⚡ ANALYZING...';
            status.style.color = 'var(--gold)';
        } else {
            status.textContent = '🔄 ANALYZING...';
            status.style.color = '#888';
        }
        recalcScore();
    }, 1000);
};

window.resetAnalysisTimer = function () {
    clearInterval(analysisTimerInt);
    analysisTimerInt = null;
    analysisElapsed  = 0;
    analysisStart    = null;
    peData.timerSecs = 0;
    document.getElementById('timerMM').textContent = '00';
    document.getElementById('timerSS').textContent = '00';
    document.getElementById('timerStatus').textContent = '⏸ NOT STARTED';
    document.getElementById('timerStatus').style.color = '#888';
    document.getElementById('analysisSince').textContent = 'Chart analysis not yet started for this session';
    smiResetTracking();
    recalcScore();
};

// ── STRUCTURE BUTTONS ──
window.setStruct = function (btn) {
    const tf  = btn.dataset.tf;   // htf / ltf
    const key = btn.dataset.key;  // ms / zone / candle
    const val = btn.dataset.val;
    const typ = btn.dataset.type; // bull / bear / neut

    // Deselect siblings with same tf+key
    document.querySelectorAll(`.struct-btn[data-tf="${tf}"][data-key="${key}"]`).forEach(b => {
        b.classList.remove('active-bull','active-bear','active-neut');
    });
    btn.classList.add(`active-${typ}`);

    if (!peData[tf]) peData[tf] = {};
    peData[tf][key] = val;
    smiTrackGroupChange(`${tf}_${key}`, val);

    checkConflict();
    updateBiasResult();
    recalcScore();
};

// ── SMM TOGGLE ──
window.toggleSmm = function (btn) {
    const key = btn.dataset.key;
    btn.classList.toggle('sel');
    peData.smm[key] = btn.classList.contains('sel');
    smiTrackSmmToggle(key, peData.smm[key]);
    recalcScore();
};

// ── MARKET STATE ──
window.setMarketState = function (btn) {
    document.querySelectorAll('.mstate-btn').forEach(b => {
        b.classList.remove('sel-bull','sel-bear','sel-neut');
    });
    btn.classList.add(btn.dataset.cls);
    peData.mstate = btn.dataset.val;
    smiTrackGroupChange('mstate', peData.mstate);
    recalcScore();
};

// ── VOLATILITY ──
window.setVolatility = function (btn) {
    document.querySelectorAll('[data-key="vol"]').forEach(b => {
        b.classList.remove('active-bull','active-bear','active-neut');
    });
    btn.classList.add('active-neut');
    peData.volatility = btn.dataset.val;
    smiTrackGroupChange('vol', peData.volatility);
    recalcScore();
};

// ── RR CALCULATOR ──
window.calcRR = function () {
    const entry  = parseFloat(document.getElementById('peEntryZone').value);
    const sl     = parseFloat(document.getElementById('peStopZone').value);
    const target = parseFloat(document.getElementById('peTargetZone').value);
    if (!entry || !sl || !target) { document.getElementById('peRR').textContent = '—'; return; }

    const risk   = Math.abs(entry - sl);
    const reward = Math.abs(target - entry);
    if (risk === 0) { document.getElementById('peRR').textContent = '—'; return; }

    const rr = (reward / risk).toFixed(2);
    peData.rrPlanned = rr;
    const color = rr >= 3 ? 'var(--accent)' : rr >= 2 ? 'var(--gold)' : 'var(--danger)';
    document.getElementById('peRR').style.color = color;
    document.getElementById('peRR').textContent = `1 : ${rr}`;
    recalcScore();
    calcQty(); // auto-calc qty after RR update
};

// ── INDUSTRY-GRADE QTY CALCULATION ──
// Formula: Qty = Risk Amount / (|Entry - Stop Loss| × Point Value)
// Point Value per asset: XAUUSD=1 (per oz, price direct), Forex=varies by pip
// For simplicity (retail/prop): Qty = RiskAmt / (|Entry - SL|)
// This gives units. For forex lots: Qty(lots) = RiskAmt / (pips × pip_value)
// We compute "units" here — trader adjusts lot size in MT5 accordingly
window.calcQty = function () {
    const entry   = parseFloat(document.getElementById('peEntryZone').value);
    const sl      = parseFloat(document.getElementById('peStopZone').value);
    const riskAmt = peData._riskAmt || 0;
    const el      = document.getElementById('peCalcQtyDisplay');
    const box     = document.getElementById('peCalcQtyBox');

    if (!entry || !sl || !riskAmt) {
        if (el)  el.textContent = '—';
        if (box) box.style.display = 'none';
        peData.calcQty = null;
        return;
    }

    const priceDiff = Math.abs(entry - sl);
    if (priceDiff === 0) {
        if (el) el.textContent = 'SL = Entry!';
        return;
    }

    // Industry standard: Raw Qty = Risk / Price Diff
    // For futures/commodities/crypto: this is direct units
    // For forex: divide by pip value (assume 1 pip = 0.0001, lot=100000 units)
    // Auto-detect forex vs commodity by price range
    let qty;
    const assetEl = document.getElementById('peAsset');
    const assetCi = document.getElementById('peAssetCustom');
    const asset   = (assetEl?.value === 'CUSTOM') ? (assetCi?.value?.toUpperCase()||'') : (assetEl?.value||'');
    const isForex = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','GBPJPY','EURGBP'].includes(asset);
    const isIndex = ['NAS100','US30','SPX500','DAX'].includes(asset);
    const isCrypto = ['BTCUSD','ETHUSD','XRPUSD'].includes(asset);

    if (isForex) {
        // Standard forex: pip = 0.0001 (4-decimal pairs), 1 std lot = 100,000 units
        // Risk per pip per 0.01 lot = ~$1 (USD account)
        // qty(lots) = RiskAmt / (pips × pip_value_per_lot)
        // pip_value_per_lot ≈ 10 USD for major pairs
        const pips = priceDiff / 0.0001;
        const pipValuePerLot = 10; // USD per pip per standard lot
        qty = riskAmt / (pips * pipValuePerLot);
        qty = parseFloat(qty.toFixed(2));
    } else if (isIndex) {
        // Indices: 1 point move, contract size varies. Generic: units = risk / move
        qty = parseFloat((riskAmt / priceDiff).toFixed(2));
    } else {
        // Commodities (XAUUSD), Crypto: direct — qty = risk / price_diff
        qty = parseFloat((riskAmt / priceDiff).toFixed(4));
        // Round to sensible decimal: if qty > 1, round to 2 decimals
        if (qty >= 10) qty = Math.round(qty);
        else if (qty >= 1) qty = parseFloat(qty.toFixed(2));
        else qty = parseFloat(qty.toFixed(4));
    }

    peData.calcQty = qty;
    const curr = peData._curr || '';

    if (el) {
        el.textContent = `${qty} ${isForex ? 'lots' : 'units'}`;
        el.style.color = 'var(--accent)';
    }
    if (box) box.style.display = 'flex';

    // Also show breakdown
    const breakdown = document.getElementById('peQtyBreakdown');
    if (breakdown) {
        breakdown.textContent = `${curr}${riskAmt.toLocaleString('en-IN',{maximumFractionDigits:0})} ÷ ${priceDiff.toFixed(isForex?5:2)} = ${qty} ${isForex?'lots':'units'}`;
    }
};
// alias for oninput events
function calcQty() { window.calcQty(); }

// ── CUSTOM ASSET TOGGLE ──
window.onPeAssetChange = function () {
    const sel = document.getElementById('peAsset');
    const ci  = document.getElementById('peAssetCustom');
    if (!sel || !ci) return;
    if (sel.value === 'CUSTOM') {
        ci.style.display = 'block'; ci.focus();
    } else {
        ci.style.display = 'none'; ci.value = '';
    }

    // Different assets trade on completely different price scales
    // (Gold ~4000, EURUSD ~1.08, BTC ~65000). Entry/Stop/Target values
    // typed for the PREVIOUS asset are meaningless for the new one and
    // silently produce a wrong price-difference → wrong (often near-zero)
    // auto-calculated quantity. Clear them so the trader re-enters fresh,
    // correct values for whatever asset is now selected.
    ['peEntryZone', 'peStopZone', 'peTargetZone'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    peData.entryZone = ''; peData.stopZone = ''; peData.targetZone = '';
    const qtyBox = document.getElementById('peCalcQtyBox');
    if (qtyBox) qtyBox.style.display = 'none';
    if (typeof window.updateEntryZoneValidation === 'function') window.updateEntryZoneValidation();

    calcRR();
    calcQty();
};

// ── CONFLICT DETECTION ──
function checkConflict() {
    const htfMs  = peData.htf?.ms  || '';
    const ltfMs  = peData.ltf?.ms  || '';
    const htfZn  = peData.htf?.zone || '';
    const ltfCn  = peData.ltf?.candle || '';

    const htfBull = htfMs.includes('BULL') || htfMs === 'TREND_BULL';
    const htfBear = htfMs.includes('BEAR');
    const ltfBull = ltfMs.includes('BULL') || ltfCn === 'REJECTION' || ltfCn === 'MITIGATION';
    const ltfBear = ltfMs.includes('BEAR');

    const premiumZone = htfZn === 'PREMIUM' || htfZn === 'SUPPLY';
    const discountZone = htfZn === 'DISCOUNT' || htfZn === 'DEMAND';

    let conflict = false;
    let conflictMsg = '';

    if (htfBull && ltfBear) {
        conflict = true;
        conflictMsg = `HTF shows BULLISH structure (${htfMs}) but LTF shows BEARISH (${ltfMs}). ` +
            `Institutional bias is LONG — LTF shorting is counter-trend. ` +
            `Wait for LTF to confirm bullish before entry.`;
    } else if (htfBear && ltfBull) {
        conflict = true;
        conflictMsg = `HTF shows BEARISH structure (${htfMs}) but LTF shows BULLISH (${ltfMs}). ` +
            `Institutional bias is SHORT — LTF buying is counter-trend. ` +
            `Wait for LTF to confirm bearish before entry.`;
    } else if (discountZone && ltfBear && htfBull) {
        conflict = true;
        conflictMsg = `Price is in HTF DISCOUNT/DEMAND zone (institutional buy area) but LTF is bearish. ` +
            `This may be final liquidity sweep before reversal — wait for LTF CHoCH or BOS.`;
    } else if (premiumZone && ltfBull && htfBear) {
        conflict = true;
        conflictMsg = `Price is in HTF PREMIUM/SUPPLY zone (institutional sell area) but LTF is bullish. ` +
            `This may be final push (stop hunt) before reversal — wait for LTF BOS bearish.`;
    }

    const alertEl = document.getElementById('conflictAlert');
    const warnEl  = document.getElementById('sessionWarning');
    if (conflict) {
        alertEl.classList.add('vis');
        document.getElementById('conflictDetail').textContent = conflictMsg;
        warnEl.style.display = 'block';
    } else {
        alertEl.classList.remove('vis');
        warnEl.style.display = 'none';
    }

    peData.conflict = conflict ? conflictMsg : '';
    return conflict;
}

// ── BIAS RESULT ──
function updateBiasResult() {
    const htfMs  = peData.htf?.ms  || '';
    const ltfMs  = peData.ltf?.ms  || '';
    const htfZn  = peData.htf?.zone || '';
    const ltfCn  = peData.ltf?.candle || '';
    const el     = document.getElementById('biasResult');

    const htfBull = htfMs.includes('BULL') || htfMs === 'TREND_BULL';
    const htfBear = htfMs.includes('BEAR');
    const ltfBull = ltfMs.includes('BULL') || ['MITIGATION','REJECTION','ENGULF','PINBAR','IMPULSE'].includes(ltfCn);
    const ltfBear = ltfMs.includes('BEAR');
    const discZone = htfZn === 'DISCOUNT' || htfZn === 'DEMAND';
    const premZone = htfZn === 'PREMIUM'  || htfZn === 'SUPPLY';

    let bias = '', bg = '', color = '';

    if (htfBull && ltfBull && discZone) {
        bias = '🟢 STRONG INSTITUTIONAL LONG BIAS — HTF + LTF + ZONE ALIGNED ▲';
        bg = '#001a00'; color = 'var(--accent)';
    } else if (htfBear && ltfBear && premZone) {
        bias = '🔴 STRONG INSTITUTIONAL SHORT BIAS — HTF + LTF + ZONE ALIGNED ▼';
        bg = '#1a0000'; color = 'var(--danger)';
    } else if (htfBull && ltfBull) {
        bias = '🟡 BULLISH BIAS — HTF + LTF ALIGNED ▲ (Zone not confirmed)';
        bg = '#0d0900'; color = 'var(--gold)';
    } else if (htfBear && ltfBear) {
        bias = '🟡 BEARISH BIAS — HTF + LTF ALIGNED ▼ (Zone not confirmed)';
        bg = '#0d0900'; color = 'var(--gold)';
    } else if (htfBull && discZone) {
        bias = '🔵 BULLISH SETUP — In Discount/Demand, LTF confirmation needed';
        bg = '#000d1a'; color = '#4a9eff';
    } else if (htfBear && premZone) {
        bias = '🔵 BEARISH SETUP — In Premium/Supply, LTF confirmation needed';
        bg = '#000d1a'; color = '#4a9eff';
    } else if (htfMs || ltfMs) {
        bias = '⚪ PARTIAL DATA — Complete both HTF and LTF analysis for full bias';
        bg = '#0a0a0a'; color = '#888';
    } else {
        bias = 'Select HTF + LTF structure to generate institutional bias';
        bg = '#0a0a0a'; color = '#555';
    }

    el.style.background = bg;
    el.style.color = color;
    el.style.borderColor = color || '#222';
    el.textContent = bias;
    peData.biasResult = bias;
}

// ── INSTITUTIONAL SCORE ──
function recalcScore() {
    let score = 0;
    const breakdown = [];

    // Readiness (max 15)
    const readinessCount = Object.values(peData.readiness).filter(Boolean).length;
    const rScore = Math.round((readinessCount / 6) * 15);
    score += rScore;
    breakdown.push({ label: 'Trader Readiness', score: rScore, max: 15,
        color: rScore >= 12 ? 'var(--accent)' : rScore >= 8 ? 'var(--gold)' : 'var(--danger)' });

    // Analysis time (max 20)
    let tScore = 0;
    if (analysisElapsed >= 900)      tScore = 20; // 15+ min
    else if (analysisElapsed >= 600) tScore = 16; // 10-15 min
    else if (analysisElapsed >= 300) tScore = 12; // 5-10 min
    else if (analysisElapsed >= 120) tScore = 7;  // 2-5 min
    else if (analysisElapsed >= 60)  tScore = 3;  // 1-2 min
    score += tScore;
    breakdown.push({ label: 'Analysis Time', score: tScore, max: 20,
        color: tScore >= 16 ? 'var(--accent)' : tScore >= 10 ? 'var(--gold)' : 'var(--danger)' });

    // HTF + LTF alignment (max 25)
    const htfMs = peData.htf?.ms || '';
    const ltfMs = peData.ltf?.ms || '';
    const htfZn = peData.htf?.zone || '';
    const ltfCn = peData.ltf?.candle || '';
    const htfBull = htfMs.includes('BULL') || htfMs === 'TREND_BULL';
    const htfBear = htfMs.includes('BEAR');
    const ltfBull = ltfMs.includes('BULL') || ['MITIGATION','REJECTION','ENGULF','PINBAR','IMPULSE'].includes(ltfCn);
    const ltfBear = ltfMs.includes('BEAR');
    const zoneAligned = (htfBull && (htfZn==='DISCOUNT'||htfZn==='DEMAND')) ||
                        (htfBear && (htfZn==='PREMIUM'||htfZn==='SUPPLY'));
    const conflict = checkConflict();

    let bScore = 0;
    if (htfMs && ltfMs && !conflict)           bScore += 15;
    else if (htfMs && ltfMs && conflict)       bScore += 5;
    else if (htfMs || ltfMs)                   bScore += 7;
    if (htfZn)                                  bScore += 5;
    if (ltfCn && ltfCn !== 'NO_SIGNAL')         bScore += 5;
    bScore = Math.min(bScore, 25);
    score += bScore;
    breakdown.push({ label: 'HTF/LTF Alignment', score: bScore, max: 25,
        color: bScore >= 20 ? 'var(--accent)' : bScore >= 13 ? 'var(--gold)' : 'var(--danger)' });

    // Smart money concepts (max 15)
    const smmCount = Object.values(peData.smm).filter(Boolean).length;
    const sScore = Math.min(smmCount * 3, 15);
    score += sScore;
    breakdown.push({ label: 'SMC Confluence', score: sScore, max: 15,
        color: sScore >= 12 ? 'var(--accent)' : sScore >= 6 ? 'var(--gold)' : '#555' });

    // Market state + volatility (max 10)
    let mScore = 0;
    if (peData.mstate)    mScore += 5;
    if (peData.volatility) mScore += 5;
    score += mScore;
    breakdown.push({ label: 'Market Context', score: mScore, max: 10,
        color: mScore >= 8 ? 'var(--accent)' : mScore >= 5 ? 'var(--gold)' : '#555' });

    // Trade plan (max 15)
    let pScore = 0;
    const dir = document.getElementById('peDirection')?.value;
    if (dir && dir !== '')                       pScore += 5;
    if (document.getElementById('peEntryZone')?.value)  pScore += 2;
    if (document.getElementById('peStopZone')?.value)   pScore += 2;
    if (document.getElementById('peTargetZone')?.value) pScore += 2;
    if (peData.rrPlanned && parseFloat(peData.rrPlanned) >= 2) pScore += 4;
    score += pScore;
    breakdown.push({ label: 'Trade Plan', score: pScore, max: 15,
        color: pScore >= 12 ? 'var(--accent)' : pScore >= 7 ? 'var(--gold)' : '#555' });

    score = Math.min(score, 100);

    // Update ring
    const circumference = 201;
    const offset = circumference - (score / 100) * circumference;
    const ring = document.getElementById('scoreRingCircle');
    const ringColor = score >= 75 ? 'var(--accent)' : score >= 50 ? 'var(--gold)' : score >= 30 ? '#ff6600' : 'var(--danger)';
    ring.style.strokeDashoffset = offset;
    ring.style.stroke = ringColor;

    document.getElementById('iScoreNum').textContent = score;
    document.getElementById('iScoreNum').style.color = ringColor;

    // Breakdown lines
    document.getElementById('scoreLines').innerHTML = breakdown.map(b => `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="color:#666;font-size:0.65rem;">${b.label}</span>
            <span style="color:${b.color};font-weight:bold;font-size:0.7rem;font-family:monospace;">${b.score}/${b.max}</span>
        </div>
        <div class="sd-bar"><div class="sd-fill" style="width:${(b.score/b.max)*100}%;background:${b.color};"></div></div>
    `).join('');

    // Proceed button
    const btn = document.getElementById('proceedBtn');
    if (conflict) {
        btn.className = 'conflict';
        btn.textContent = `⚠ CONFLICT DETECTED — Score: ${score}/100 — Proceed with caution`;
    } else if (score >= 75 && analysisElapsed >= 300) {
        btn.className = 'ready';
        btn.textContent = `✅ ANALYSIS COMPLETE — Score: ${score}/100 — PROCEED TO TERMINAL`;
    } else if (score >= 40) {
        btn.className = 'locked';
        btn.textContent = `⏳ SCORE: ${score}/100 — Need 75+ and 5 min analysis to proceed`;
    } else {
        btn.className = 'locked';
        btn.textContent = `⏳ COMPLETE ANALYSIS — Current Score: ${score}/100`;
    }

    peData._score = score;
    peData._conflict = conflict;
};

// ── PROCEED / SAVE ──
// Resize to max 1000px + re-encode as JPEG @ 0.6 quality before upload —
// cuts typical phone-photo file size by 80-95%, reducing how fast the
// Firebase Storage quota gets consumed.
async function compressImageForUpload(file) {
    const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = URL.createObjectURL(file);
    });
    const maxDim = 1000;
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(img.src);
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.6));
}

window.proceedToTerminal = async function () {
    const score  = peData._score || 0;
    const elapsed = analysisElapsed;

    if (elapsed < 300 && score < 75) {
        const confirm_ = confirm(
            `Analysis time is only ${Math.floor(elapsed/60)}m ${elapsed%60}s and score is ${score}/100.\n\n` +
            `Institutional standard requires minimum 5 minutes chart analysis.\n\n` +
            `Proceed anyway? (Not recommended)`
        );
        if (!confirm_) return;
    }

    // Save pre-entry record to Firebase
    if (selectedClusterId !== null && selectedNodeIdx !== null) {
        // ── Optional chart screenshot — same Storage convention as
        // Terminal's trade screenshots, so this analysis is still
        // visually referenceable later even if no trade ever happens. ──
        let screenshotUrl = null;
        const shotFile = document.getElementById('peScreenshotInput')?.files?.[0];
        if (shotFile) {
            try {
                const compressed  = await compressImageForUpload(shotFile);
                const safeName    = `preentry_${Date.now()}.jpg`;
                const storagePath = `preentry_screenshots/${selectedClusterId}/${selectedNodeIdx}/${safeName}`;
                const storageRef  = sRef(storage, storagePath);
                const uploadTask  = uploadBytesResumable(storageRef, compressed);
                screenshotUrl = await new Promise((resolve, reject) => {
                    uploadTask.on('state_changed', null, reject, async () => {
                        resolve(await getDownloadURL(uploadTask.snapshot.ref));
                    });
                });
            } catch (e) {
                console.warn('Pre-entry screenshot upload failed:', e);
                if (String(e.message || e).includes('quota') || String(e.message || e).includes('Quota')) {
                    alert('⚠️ Screenshot save nahi hui — Firebase Storage ka quota khatam ho gaya hai (account-level limit, code ka bug nahi). Analysis phir bhi save ho jaayegi, sirf photo ke bina. Firebase Console se purani files delete karo ya plan upgrade karo.');
                }
            }
        }
        const peTags = [
            ...Array.from(document.querySelectorAll('#peTagChips input:checked')).map(el => el.value),
        ];
        const customTag = document.getElementById('peCustomTag')?.value?.trim();
        if (customTag) peTags.push(customTag);

        // ── Snapshot the active session window (from SETUP) + check if analysis time falls inside it ──
        let sessionWindow = null, sessionViolation = false;
        try {
            const cluster = clusters[selectedClusterId];
            const node    = cluster?.nodes?.[selectedNodeIdx];
            const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][window.ISI_NetTime ? window.ISI_NetTime.nowIST().day : new Date().getDay()];
            const slots   = node ? getNodeSlotsForDay(node, dayName) : [];
            const slot    = slots.find(s => s.slotIdx === (peData._selectedSlot || 0)) || slots[0] || null;
            if (slot && slot.start) {
                sessionWindow = { start: slot.start, end: slot.end || '', expire: slot.expire || '' };
                const nowHHMM = (window.ISI_NetTime ? window.ISI_NetTime.now() : new Date()).toTimeString().slice(0,5);
                const inWindow = (t, s, e) => {
                    if (!s) return true;
                    if (!e) return t >= s;
                    return e >= s ? (t >= s && t <= e) : (t >= s || t <= e); // handles overnight windows
                };
                // Live entry window is [start, expire) everywhere else in the app (terminal.js
                // status card, preentry countdown, etc). "end" is a separate/unused display field —
                // it must NOT be used ahead of "expire" here, or a valid pre-entry made between
                // "end" and "expire" gets wrongly flagged as outside the session window.
                sessionViolation = !inWindow(nowHHMM, sessionWindow.start, sessionWindow.expire || sessionWindow.end);
            }
        } catch (e) { console.warn('Session window snapshot failed:', e); }

        const record = {
            date:        window._ISIDate ? window._ISIDate.todayStr() : new Date().toISOString().slice(0,10),
            savedAt:     (window.ISI_NetTime ? window.ISI_NetTime.now() : new Date()).toISOString(),
            clusterId:   selectedClusterId,
            nodeIdx:     selectedNodeIdx,
            score:       score,
            timerSecs:   elapsed,
            sessionWindow:   sessionWindow,
            sessionViolation: sessionViolation,
            readiness:   { ...peData.readiness },
            htf:         { ...peData.htf },
            ltf:         { ...peData.ltf },
            smm:         Object.keys(peData.smm).filter(k => peData.smm[k]),
            mstate:      peData.mstate,
            volatility:  peData.volatility,
            biasResult:  peData.biasResult || '',
            conflict:    peData.conflict   || '',
            asset:       (document.getElementById('peAsset')?.value==='CUSTOM' ? (document.getElementById('peAssetCustom')?.value?.trim().toUpperCase()||'CUSTOM') : document.getElementById('peAsset')?.value) || '',
            direction:   document.getElementById('peDirection').value,
            entryZone:   document.getElementById('peEntryZone').value,
            stopZone:    document.getElementById('peStopZone').value,
            targetZone:  document.getElementById('peTargetZone').value,
            rrPlanned:   peData.rrPlanned || '',
            note:        document.getElementById('peNote').value,
            // Qty + risk calc data for terminal OrderCard
            entryPrice:  parseFloat(document.getElementById('peEntryZone').value) || null,
            stopLoss:    parseFloat(document.getElementById('peStopZone').value)  || null,
            calcQty:     peData.calcQty  || null,
            riskAmt:     peData._riskAmt ? parseFloat(peData._riskAmt.toFixed(2)) : null,
            riskPct:     peData._riskPct || null,
            curr:        peData._curr    || '₹',
            calcRR:      peData.rrPlanned || null,
            // Institutional Entry Zone Validation (HTF/LTF coordinate check)
            entryZoneValidation: peData.entryZoneValidation || null,
            // System Manipulation Index — score + full audit log of every
            // post-timer rule-bending action (bias/state changes, SMC
            // deselects, entry/SL/target price edits)
            smi: peData.smi || { score: 100, log: [] },
            // Screenshot + situation tags — for analyses that don't
            // immediately (or ever) become a live order.
            screenshot: screenshotUrl,
            tags:       peTags,
            completed:  true,   // deliberately finished via PROCEED, not an abandoned draft
            autoSaved:  false,
        };

        try {
            let peRef;
            if (_draftKey) {
                // A periodic draft already exists for this session — finalize
                // IN PLACE so we don't leave an orphaned duplicate draft
                // record sitting in history alongside the real one.
                const draftRef = ref(db, `isi_v6/preentry/${selectedClusterId}/${selectedNodeIdx}/${_draftKey}`);
                await set(draftRef, record);
                peRef = { key: _draftKey };
            } else {
                peRef = await push(ref(db, `isi_v6/preentry/${selectedClusterId}/${selectedNodeIdx}`), record);
            }
            _peProceeded = true;
            if (_draftInterval) clearInterval(_draftInterval);
            // ── Publish to Firebase "active session" — the SINGLE source of
            // truth Terminal reads from (real-time, any device). No local
            // storage anywhere in this chain: if this device shuts down
            // right after Authorize Entry, another device can still resume
            // and finalize the trade with full continuity + duration.
            await set(ref(db, `isi_v6/active_session/${selectedClusterId}/${selectedNodeIdx}`), {
                ...record,
                preEntryFirebaseKey: peRef.key,
                entryTimestamp: null,
                exitTimestamp:  null,
                updatedAt: (window.ISI_NetTime ? window.ISI_NetTime.now() : new Date()).toISOString(),
            });
        } catch(e) {
            console.warn('Pre-entry save error:', e);
        }
    }

    // Stop timer
    clearInterval(analysisTimerInt);
    location.href = 'terminal.html';
};

window.goToTerminal = function () {
    if (!confirm('Analysis abhi complete/proceed nahi hui — ek draft auto-save ho jaayega (History me "AUTO-CAPTURED" tag ke saath, wahan se Resume kar sakte ho). Terminal pe jaana chahte ho?')) return;
    location.href = 'terminal.html';
};

// ── ANALYSIS HISTORY — last 10 by default, or a picked date range ──
function loadAnalysisHistory(fromDate, toDate) {
    if (!selectedClusterId || selectedNodeIdx === null) return;

    get(ref(db, `isi_v6/preentry/${selectedClusterId}/${selectedNodeIdx}`)).then(snap => {
        const data = snap.val();
        const list = document.getElementById('peHistoryList');
        if (!data) {
            list.innerHTML = '<div style="color:#444;font-size:0.78rem;padding:14px;text-align:center;">No pre-entry sessions found for this account yet.</div>';
            return;
        }

        let items = Object.entries(data).map(([key, r]) => ({ ...r, _key: key }));
        if (fromDate || toDate) {
            items = items.filter(r => (!fromDate || r.date >= fromDate) && (!toDate || r.date <= toDate));
        }
        items.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
        if (!fromDate && !toDate) items = items.slice(0, 10); // default: last 10 across all dates

        if (!items.length) {
            list.innerHTML = '<div style="color:#444;font-size:0.78rem;padding:14px;text-align:center;">Is range mein koi pre-entry session nahi mili.</div>';
            return;
        }

        list.innerHTML = items.map(r => {
            const mins = Math.floor((r.timerSecs||0)/60);
            const secs = (r.timerSecs||0) % 60;
            const hasConflict = !!r.conflict;
            const cls = hasConflict ? 'conflict' : r.score >= 75 ? 'went-live' : 'skipped';
            const dt = r.savedAt ? new Date(r.savedAt) : null;
            const timeStr = dt ? dt.toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hour12:false }) : '—';
            const canResume = !r.orderPlaced; // once an actual order was placed from it, resuming again would be confusing
            return `
            <div class="pe-history-item ${cls}">
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
                    <div>
                        <span style="color:var(--gold);font-weight:bold;font-size:0.8rem;">${timeStr}</span>
                        <span style="color:#555;font-size:0.65rem;margin-left:8px;">${r.asset || '—'} | ${r.direction || '—'}</span>
                        ${r.autoSaved ? '<span style="color:#ff8c00;font-size:0.56rem;margin-left:6px;border:1px solid #ff8c00;border-radius:8px;padding:1px 6px;">AUTO-CAPTURED (not finished)</span>' : ''}
                    </div>
                    <div style="text-align:right;">
                        <div style="font-family:monospace;font-weight:bold;color:${r.score>=75?'var(--accent)':r.score>=50?'var(--gold)':'var(--danger)'};">${r.score}/100</div>
                        <div style="font-size:0.58rem;color:#555;">${mins}m ${secs}s analysis</div>
                    </div>
                </div>
                <div style="font-size:0.65rem;color:#666;margin-top:5px;">${r.biasResult||'—'}</div>
                ${r.conflict ? `<div style="font-size:0.62rem;color:#ff6600;margin-top:4px;">⚠ ${r.conflict.slice(0,80)}...</div>` : ''}
                ${r.note ? `<div style="font-size:0.63rem;color:#555;margin-top:4px;font-style:italic;">"${r.note.slice(0,100)}${r.note.length>100?'...':''}"</div>` : ''}
                ${(r.tags||[]).length ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;">${r.tags.map(t=>`<span style="font-size:0.55rem;background:#1a1400;border:1px solid #443300;color:#c5a059;padding:2px 8px;border-radius:10px;">${t}</span>`).join('')}</div>` : ''}
                ${r.screenshot ? `<img src="${r.screenshot}" style="max-width:120px;max-height:80px;border-radius:5px;margin-top:6px;border:1px solid #333;cursor:zoom-in;" onclick="window.peZoomImage('${r.screenshot}')">` : ''}
                <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
                    <button onclick="window.peResumeAnalysis('${r._key}')" style="width:auto;padding:5px 12px;font-size:0.6rem;background:#0a0800;border:1px solid var(--gold);color:var(--gold);border-radius:4px;cursor:pointer;font-weight:bold;">↩ Resume This Analysis</button>
                    <button onclick="window.peDeleteAnalysis('${r._key}')" style="width:auto;padding:5px 12px;font-size:0.6rem;background:#1a0000;border:1px solid #7a0000;color:#ff5c5c;border-radius:4px;cursor:pointer;font-weight:bold;">🗑️ Delete</button>
                </div>
            </div>`;
        }).join('');
    });
}

// ── IMAGE ZOOM LIGHTBOX ──
window.peZoomImage = function(url) {
    let overlay = document.getElementById('peZoomOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'peZoomOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;padding:20px;cursor:zoom-out;';
        overlay.onclick = () => overlay.remove();
        document.body.appendChild(overlay);
    }
    const img = document.createElement('img');
    img.src = url;
    img.style.cssText = 'max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 0 40px rgba(0,0,0,0.8);';
    overlay.innerHTML = '';
    overlay.appendChild(img);
    const closeBtn = document.createElement('div');
    closeBtn.textContent = '✕ Close';
    closeBtn.style.cssText = 'position:fixed;top:16px;right:16px;color:#fff;font-size:0.8rem;font-weight:bold;background:rgba(255,255,255,0.1);padding:8px 16px;border-radius:6px;';
    overlay.appendChild(closeBtn);
};

// ── DELETE — permanently removes a saved analysis directly from this
// page's own history (in addition to the Delete already available via
// Order Tracker for unresolved ones). ──
window.peDeleteAnalysis = async function(key) {
    if (!confirm('Yeh analysis permanently delete karna chahte ho? Yeh undo nahi ho sakta.')) return;
    try {
        // Find which account this record actually belongs to (same
        // cross-account lookup used by Resume), since history may show
        // analyses from a different account than the one currently open.
        const snap = await get(ref(db, 'isi_v6/preentry'));
        const allPe = snap.val() || {};
        let foundClusterId = null, foundNodeIdx = null;
        for (const cId of Object.keys(allPe)) {
            for (const nIdx of Object.keys(allPe[cId] || {})) {
                if (allPe[cId][nIdx] && allPe[cId][nIdx][key]) { foundClusterId = cId; foundNodeIdx = nIdx; break; }
            }
            if (foundClusterId) break;
        }
        if (!foundClusterId) return alert('Record nahi mila.');
        await remove(ref(db, `isi_v6/preentry/${foundClusterId}/${foundNodeIdx}/${key}`));
        loadAnalysisHistory(null, null);
    } catch (e) { alert('Delete failed: ' + e.message); }
};

window.applyPeHistoryRange = function() {
    const from = document.getElementById('peHistFrom')?.value || '';
    const to   = document.getElementById('peHistTo')?.value || '';
    loadAnalysisHistory(from, to);
};
window.resetPeHistoryToRecent = function() {
    document.getElementById('peHistFrom').value = '';
    document.getElementById('peHistTo').value = '';
    loadAnalysisHistory(null, null);
};

// ── RESUME — pick up a saved analysis (whether or not it ever became
// an order) and push it into Terminal's active_session, same pattern
// Order Tracker's resume() uses. Fixes: "price never tapped entry" /
// "forgot to execute" analyses that had nowhere to be continued from. ──
window.peResumeAnalysis = async function(key) {
    try {
        // Look across ALL accounts for this key (the record itself carries
        // which cluster/node it belongs to) — not just whatever account
        // happens to be currently selected. Fixes: resuming an analysis
        // that was done on a DIFFERENT account than the one currently open.
        let r = null, foundClusterId = null, foundNodeIdx = null;
        const clustersSnap = await get(ref(db, 'isi_v6/preentry'));
        const allPe = clustersSnap.val() || {};
        for (const cId of Object.keys(allPe)) {
            for (const nIdx of Object.keys(allPe[cId] || {})) {
                if (allPe[cId][nIdx] && allPe[cId][nIdx][key]) {
                    r = allPe[cId][nIdx][key];
                    foundClusterId = cId; foundNodeIdx = parseInt(nIdx);
                    break;
                }
            }
            if (r) break;
        }
        if (!r) return alert('Analysis record nahi mila — shayad delete ho gaya.');
        if (!clusters[foundClusterId]) return alert(`❌ Account switch fail — cluster "${foundClusterId}" ab exist nahi karta (delete/rename ho gaya hoga). Analysis data safe hai, bas is account ko wapas nahi khola ja sakta.`);

        // ── COMPLETED analysis (trader already clicked PROCEED, went to
        // Terminal, but never actually Authorized Entry — e.g. price never
        // tapped the zone, or they got interrupted) → nothing left to
        // analyze here. Rebuild active_session (same shape PROCEED
        // originally wrote) and go straight to Terminal, account switched,
        // ready to Authorize. ──
        if (r.completed === true) {
            localStorage.setItem('isi_sel_cluster', foundClusterId);
            localStorage.setItem('isi_sel_node', String(foundNodeIdx));
            await set(ref(db, `isi_v6/active_session/${foundClusterId}/${foundNodeIdx}`), {
                ...r,
                preEntryFirebaseKey: key,
                entryTimestamp: null,
                exitTimestamp: null,
                updatedAt: (window.ISI_NetTime ? window.ISI_NetTime.now() : new Date()).toISOString(),
            });
            location.href = 'terminal.html';
            return;
        }

        // ── DRAFT / incomplete analysis → restore the full Pre-Entry form
        // right here so the trader can pick up the analysis where they
        // left off, THEN proceed properly when ready. ──

        // ── Directly and unconditionally switch account — this does NOT
        // depend on selectPeCard's internal lookup succeeding; it sets
        // everything needed itself, guaranteed. selectPeCard is still
        // called afterward purely for its bonus UI polish (risk-lock
        // banner, slider highlight), never as a requirement. ──
        selectedClusterId = foundClusterId;
        selectedNodeIdx   = foundNodeIdx;
        localStorage.setItem('isi_sel_cluster', foundClusterId);
        localStorage.setItem('isi_sel_node', String(foundNodeIdx));

        const clusterSelEl = document.getElementById('peClusterSel');
        if (clusterSelEl) clusterSelEl.value = foundClusterId;
        populateAccounts(foundClusterId);
        const accountSelEl = document.getElementById('peAccountSel');
        if (accountSelEl) accountSelEl.value = String(foundNodeIdx);

        if (window.selectPeCard) {
            try { window.selectPeCard(foundClusterId, foundNodeIdx, r._selectedSlot || 0); } catch (e2) { /* bonus polish only — never block on this */ }
        }

        // Give the DOM a proper tick to settle before filling fields.
        await new Promise(res => setTimeout(res, 150));

        if (selectedClusterId !== foundClusterId || selectedNodeIdx !== foundNodeIdx) {
            return alert('❌ Account switch verify nahi hua — kuch aur JS ne overwrite kar diya. Page refresh karke dobara try karo.');
        }

        restoreAnalysisIntoForm(r, key);

        alert('✅ Analysis resume ho gayi (draft) — saari selections (account, HTF/LTF structure, SMC, market state, entry zone, readiness) wapas load ho gayi hain. Neeche scroll karke review karo, phir PROCEED TO TERMINAL dabao jab ready ho.');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
        alert('Resume failed: ' + e.message);
    }
};

// Rebuilds the ENTIRE Pre-Entry page state from a saved record — reuses
// the actual existing click-handler functions (setStruct/toggleSmm/
// setMarketState/setVolatility/toggleReady) so the visual button state,
// peData, SMI tracking, bias/score recalculation all stay in sync exactly
// as if the trader had clicked everything themselves.
function restoreAnalysisIntoForm(r, resumeKey) {
    // Trader Readiness Protocol
    if (r.readiness) {
        Object.entries(r.readiness).forEach(([k, checked]) => {
            const el = document.querySelector(`.ready-item[onclick*="'${k}'"]`);
            if (el && checked && !el.classList.contains('checked')) window.toggleReady(el, k);
        });
    }

    // Asset / Direction / Entry-SL-Target / Note
    if (r.asset) {
        const assetSel = document.getElementById('peAsset');
        const opt = assetSel && Array.from(assetSel.options).find(o => o.value === r.asset);
        if (assetSel && opt) { assetSel.value = r.asset; }
        else if (assetSel) {
            assetSel.value = 'CUSTOM';
            const customEl = document.getElementById('peAssetCustom');
            if (customEl) customEl.value = r.asset;
        }
        if (window.onPeAssetChange) window.onPeAssetChange();
    }
    if (r.direction && document.getElementById('peDirection')) document.getElementById('peDirection').value = r.direction;
    if (document.getElementById('peEntryZone'))  document.getElementById('peEntryZone').value  = r.entryZone || r.entryPrice || '';
    if (document.getElementById('peStopZone'))   document.getElementById('peStopZone').value   = r.stopZone  || r.stopLoss   || '';
    if (document.getElementById('peTargetZone')) document.getElementById('peTargetZone').value = r.targetZone || '';
    if (document.getElementById('peNote'))       document.getElementById('peNote').value       = r.note || '';
    if (window.calcRR) window.calcRR();
    if (window.calcQty) window.calcQty();

    // Tags + screenshot preview
    if (r.tags && r.tags.length) {
        const predefined = Array.from(document.querySelectorAll('#peTagChips input')).map(el => el.value);
        document.querySelectorAll('#peTagChips input').forEach(cb => { cb.checked = r.tags.includes(cb.value); });
        const custom = r.tags.find(t => !predefined.includes(t));
        if (custom && document.getElementById('peCustomTag')) document.getElementById('peCustomTag').value = custom;
    }
    if (r.screenshot) {
        const preview = document.getElementById('peScreenshotPreview');
        const wrap    = document.getElementById('peScreenshotPreviewWrap');
        if (preview && wrap) { preview.src = r.screenshot; wrap.style.display = 'block'; }
    }

    // Institutional Entry Zone Validation (HTF/LTF coordinate check)
    if (r.entryZoneValidation) {
        const ezv = r.entryZoneValidation;
        if (document.getElementById('ezvHtfTf'))   document.getElementById('ezvHtfTf').value   = ezv.htfTf || '';
        if (document.getElementById('ezvLtfTf'))   document.getElementById('ezvLtfTf').value   = ezv.ltfTf || '';
        if (document.getElementById('ezvHtfHigh')) document.getElementById('ezvHtfHigh').value = ezv.htfHigh ?? '';
        if (document.getElementById('ezvHtfLow'))  document.getElementById('ezvHtfLow').value  = ezv.htfLow  ?? '';
        if (document.getElementById('ezvLtfHigh')) document.getElementById('ezvLtfHigh').value = ezv.ltfHigh ?? '';
        if (document.getElementById('ezvLtfLow'))  document.getElementById('ezvLtfLow').value  = ezv.ltfLow  ?? '';
        if (window.updateEntryZoneValidation) window.updateEntryZoneValidation();
    }

    // HTF + LTF Structure buttons — the "market conditions clicks"
    ['htf', 'ltf'].forEach(tf => {
        const data = r[tf] || {};
        Object.entries(data).forEach(([k, val]) => {
            const btn = document.querySelector(`.struct-btn[data-tf="${tf}"][data-key="${k}"][data-val="${val}"]`);
            if (btn) window.setStruct(btn);
        });
    });

    // Smart Money Concepts (multi-select)
    (r.smm || []).forEach(k => {
        const btn = document.querySelector(`.smm-btn[data-key="${k}"]`);
        if (btn && !btn.classList.contains('sel')) window.toggleSmm(btn);
    });

    // Market State
    if (r.mstate) {
        const btn = document.querySelector(`.mstate-btn[data-val="${r.mstate}"]`);
        if (btn) window.setMarketState(btn);
    }
    // Volatility
    if (r.volatility) {
        const btn = document.querySelector(`[data-key="vol"][data-val="${r.volatility}"]`);
        if (btn) window.setVolatility(btn);
    }

    _draftKey = resumeKey; // continue autosaving into the SAME record, not a fresh duplicate
    if (window.checkDirectionFlip) window.checkDirectionFlip();
    recalcScore();
}


// Set today's date
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.ready-item').forEach(el => el.classList.remove('checked'));
    updateReadinessScore();
    recalcScore();

    // If we just got here via ISI_hardResetPreEntry(), show why once.
    const resetNotice = sessionStorage.getItem('isi_pe_reset_notice');
    if (resetNotice) {
        sessionStorage.removeItem('isi_pe_reset_notice');
        const banner = document.createElement('div');
        banner.style.cssText = `
            position:fixed; top:52px; left:50%; transform:translateX(-50%);
            z-index:2147483002; background:#d32f2f; color:#fff;
            font-family:'Courier New',monospace; font-size:0.7rem; font-weight:700;
            padding:8px 16px; border-radius:4px; max-width:90vw; text-align:center;
            box-shadow:0 4px 16px rgba(0,0,0,0.5);
        `;
        banner.textContent = `⚠️ PRE-ENTRY RESET: ${resetNotice}`;
        document.body.appendChild(banner);
        setTimeout(() => banner.remove(), 12000);
    }

    // Screenshot preview
    const shotInput = document.getElementById('peScreenshotInput');
    if (shotInput) {
        shotInput.addEventListener('change', () => {
            const file = shotInput.files?.[0];
            const wrap = document.getElementById('peScreenshotPreviewWrap');
            const img  = document.getElementById('peScreenshotPreview');
            if (!file) { wrap.style.display = 'none'; return; }
            const reader = new FileReader();
            reader.onload = () => { img.src = reader.result; wrap.style.display = 'block'; };
            reader.readAsDataURL(file);
        });
    }
});

// ══════════════════════════════════════════════════════════════
// AUTO-SAVE ON ABANDON — fixes the "kal raat ki analysis gayab ho gayi"
// gap: if the trader closes the tab, switches app, or uses the top
// "Go to Terminal" skip button WITHOUT clicking PROCEED, this fires a
// best-effort save of whatever's currently filled in — tagged
// completed:false, autoSaved:true — so it still shows up in history
// and can be resumed later, instead of vanishing with zero trace.
// No screenshot upload here (too slow/unreliable during page-unload);
// that only happens on a deliberate PROCEED.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// SAME-ASSET, SAME-DAY DIRECTION-FLIP WARNING
// If today's already-taken trades on the SAME asset ended with a
// LONG (or SHORT), and the trader is now planning the OPPOSITE
// direction on that same asset, same day — flag it. This is often a
// genuine reversal call, but just as often it's revenge-trading or an
// impulsive flip after a loss — worth a visible pause, not a hard
// block (the trader knows their own setup better than a static rule).
// ══════════════════════════════════════════════════════════════
async function getTodayTradesForAccount() {
    if (selectedClusterId === null || selectedNodeIdx === null) return [];
    const today = window._ISIDate ? window._ISIDate.todayStr() : new Date().toISOString().slice(0, 10);
    try {
        const snap = await get(ref(db, `isi_v6/clusters/${selectedClusterId}/nodes/${selectedNodeIdx}/tradeHistory`));
        const val = snap.val() || {};
        return Object.values(val)
            .filter(t => t && t.date === today)
            .sort((a, b) => (a.savedAt || '').localeCompare(b.savedAt || ''));
    } catch (e) { console.warn('Direction-flip check: trade fetch failed:', e); return []; }
}

window.checkDirectionFlip = async function () {
    const warnBox = document.getElementById('peDirFlipWarning');
    const warnMsg = document.getElementById('peDirFlipMsg');
    if (!warnBox) return;

    const assetSel = document.getElementById('peAsset')?.value;
    const asset = assetSel === 'CUSTOM' ? (document.getElementById('peAssetCustom')?.value || '').trim().toUpperCase() : assetSel;
    const direction = document.getElementById('peDirection')?.value;

    if (!asset || !direction || direction === 'WAIT') { warnBox.style.display = 'none'; return; }

    const trades = await getTodayTradesForAccount();
    const sameAssetTrades = trades.filter(t => (t.asset || '').toUpperCase() === asset.toUpperCase());
    if (!sameAssetTrades.length) { warnBox.style.display = 'none'; return; }

    const lastTrade = sameAssetTrades[sameAssetTrades.length - 1];
    const lastDir = lastTrade.direction;
    if (!lastDir || lastDir === direction) { warnBox.style.display = 'none'; return; }

    const lastTime = lastTrade.savedAt ? new Date(lastTrade.savedAt).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—';
    warnMsg.textContent = `Aaj ${lastTime} pe isi asset (${asset}) pe ${lastDir} trade li thi (P/L: ${lastTrade.pl >= 0 ? '+' : ''}${(lastTrade.pl||0).toFixed(2)}). Ab ${direction} plan kar rahe ho — same din, same asset, opposite direction. Genuine reversal hai ya revenge/impulsive flip? Ek baar confirm kar lo.`;
    warnBox.style.display = 'block';
};

// ══════════════════════════════════════════════════════════════
// RELIABLE DRAFT AUTO-SAVE — fixes the "kal raat ki analysis gayab ho
// gayi" gap PROPERLY. The previous version only tried to save at the
// moment of abandonment (tab close / app switch) — but that's exactly
// the moment a browser is LEAST likely to let an async Firebase write
// finish (pagehide/beforeunload give no such guarantee for anything
// other than synchronous code or navigator.sendBeacon). So instead:
// as soon as there's meaningful data on the page, a STABLE draft
// record is created and then re-saved every 20 seconds while you keep
// working — by the time you ever abandon the page, the data is
// ALREADY safely on Firebase, not dependent on a risky last-second
// write. No screenshot upload here (kept for the deliberate PROCEED
// save only — too slow for a background autosave).
// ══════════════════════════════════════════════════════════════
let _draftKey = null;

function hasMeaningfulPeData() {
    const asset = document.getElementById('peAsset')?.value;
    const note  = document.getElementById('peNote')?.value?.trim();
    return !!(asset || note);
}

function getDraftRef() {
    if (!_draftKey) {
        _draftKey = push(ref(db, `isi_v6/preentry/${selectedClusterId}/${selectedNodeIdx}`)).key;
    }
    return ref(db, `isi_v6/preentry/${selectedClusterId}/${selectedNodeIdx}/${_draftKey}`);
}

async function saveDraftNow() {
    if (_peProceeded) return; // already properly finished via PROCEED — draft no longer needed
    if (selectedClusterId === null || selectedNodeIdx === null) return;
    if (!hasMeaningfulPeData()) return;

    try {
        const peTags = Array.from(document.querySelectorAll('#peTagChips input:checked')).map(el => el.value);
        const customTag = document.getElementById('peCustomTag')?.value?.trim();
        if (customTag) peTags.push(customTag);

        const record = {
            date:        window._ISIDate ? window._ISIDate.todayStr() : new Date().toISOString().slice(0,10),
            savedAt:     (window.ISI_NetTime ? window.ISI_NetTime.now() : new Date()).toISOString(),
            clusterId:   selectedClusterId,
            nodeIdx:     selectedNodeIdx,
            score:       parseInt(document.getElementById('iScoreNum')?.textContent) || 0,
            timerSecs:   analysisElapsed,
            readiness:   { ...peData.readiness },
            htf:         { ...peData.htf },
            ltf:         { ...peData.ltf },
            smm:         Object.keys(peData.smm || {}).filter(k => peData.smm[k]),
            mstate:      peData.mstate,
            volatility:  peData.volatility,
            biasResult:  peData.biasResult || '',
            entryZoneValidation: peData.entryZoneValidation || null,
            asset:       document.getElementById('peAsset')?.value || '',
            direction:   document.getElementById('peDirection')?.value || '',
            entryZone:   document.getElementById('peEntryZone')?.value || '',
            stopZone:    document.getElementById('peStopZone')?.value || '',
            targetZone:  document.getElementById('peTargetZone')?.value || '',
            entryPrice:  parseFloat(document.getElementById('peEntryZone')?.value) || null,
            stopLoss:    parseFloat(document.getElementById('peStopZone')?.value)  || null,
            note:        document.getElementById('peNote')?.value || '',
            tags:        peTags,
            screenshot:  null,
            completed:   false,
            autoSaved:   true,
            smi: peData.smi || { score: 100, log: [] },
        };
        await set(getDraftRef(), record);
    } catch (e) { console.warn('Pre-entry periodic draft save failed:', e); }
}

// Save 3s after the page loads (catches a very-quick abandon), then
// every 20s continuously while the trader is working.
setTimeout(saveDraftNow, 3000);
const _draftInterval = setInterval(saveDraftNow, 20000);

// Also flush immediately on any sign of leaving — best-effort safety
// net on top of the periodic save above (not the primary mechanism).
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveDraftNow();
});
window.addEventListener('pagehide', saveDraftNow);

// ── AI VALIDATE SETUP ──
window.aiValidateSetupNow = async function () {
    showAILoading('aiValidateBox');
    const result = await aiValidateSetup({
        ...peData,
        direction: document.getElementById('peDirection')?.value,
        _score: peData._score
    });
    renderAIResponse('aiValidateBox', result, '🤖 AI Setup Validation');
};

// ── AI MARKET CONTEXT ──
window.aiMarketContextNow = async function () {
    showAILoading('aiMarketBox');
    const smcActive = Object.keys(peData.smm || {}).filter(k => peData.smm[k]).join(', ') || 'None';
    const result = await aiMarketContext(
        peData.htf?.ms, peData.ltf?.ms, peData.htf?.zone,
        peData.mstate, peData.volatility, smcActive
    );
    renderAIResponse('aiMarketBox', result, '🤖 AI Market Context');
};
