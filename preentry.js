import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, push, get, set, query, orderByChild, startAt } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
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

// ── STATE ──
let clusters           = {};
let selectedClusterId  = null;
let selectedNodeIdx    = null;
let analysisStart      = null;
let analysisTimerInt   = null;
let analysisElapsed    = 0; // seconds

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
    smiLog.push({ ts: new Date().toISOString(), section, message });
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
    return score;
}
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
    loadTodayHistory();
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
    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];
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

    const now    = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

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
            const d = (startMin - nowMin)*60 - now.getSeconds();
            countdown = formatCountdown(d); phase='pre'; st='ANALYSE';
            borderCol='#c5a059'; glowCol='rgba(197,160,89,0.25)';
        } else if (startMin !== null && expireMin !== null && nowMin>=startMin && nowMin<expireMin) {
            const d = (expireMin - nowMin)*60 - now.getSeconds();
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
}

// Update slider countdown every second without full rebuild
function updatePeSliderCountdowns() {
    const grid = document.getElementById('peTimerSlider');
    if (!grid) return;
    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];
    const now     = new Date();
    const nowMin  = now.getHours() * 60 + now.getMinutes();
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
            cd = formatCountdown((startMin-nowMin)*60-now.getSeconds()); st='ANALYSE'; col='#c5a059'; lbl='ENTRY IN';
        } else if (startMin!==null && expireMin!==null && nowMin>=startMin && nowMin<expireMin) {
            cd = formatCountdown((expireMin-nowMin)*60-now.getSeconds()); st='● ENTRY'; col='#00ff41'; lbl='EXPIRES IN';
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

    // Fill risk amount in pre-trade plan section
    const node    = clusters[cId]?.nodes[nIdx];
    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];
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
    loadTodayHistory();

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
    loadTodayHistory();
};

window.onPeAccountChange = function () {
    const val = document.getElementById('peAccountSel').value;
    selectedNodeIdx = val !== '' ? parseInt(val) : null;
    if (selectedNodeIdx !== null) localStorage.setItem('isi_sel_node', selectedNodeIdx);
    loadTodayHistory();
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
        analysisStart = new Date();
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
        // ── Snapshot the active session window (from SETUP) + check if analysis time falls inside it ──
        let sessionWindow = null, sessionViolation = false;
        try {
            const cluster = clusters[selectedClusterId];
            const node    = cluster?.nodes?.[selectedNodeIdx];
            const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];
            const slots   = node ? getNodeSlotsForDay(node, dayName) : [];
            const slot    = slots.find(s => s.slotIdx === (peData._selectedSlot || 0)) || slots[0] || null;
            if (slot && slot.start) {
                sessionWindow = { start: slot.start, end: slot.end || '', expire: slot.expire || '' };
                const nowHHMM = new Date().toTimeString().slice(0,5);
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
            savedAt:     new Date().toISOString(),
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
            smi: peData.smi || { score: 100, log: [] }
        };

        try {
            const peRef = await push(ref(db, `isi_v6/preentry/${selectedClusterId}/${selectedNodeIdx}`), record);
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
                updatedAt: new Date().toISOString(),
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
    if (!confirm('Go to terminal without saving pre-entry analysis?')) return;
    location.href = 'terminal.html';
};

// ── LOAD TODAY'S HISTORY ──
function loadTodayHistory() {
    if (!selectedClusterId || selectedNodeIdx === null) return;
    const today = window._ISIDate ? window._ISIDate.todayStr() : new Date().toISOString().slice(0,10);

    get(ref(db, `isi_v6/preentry/${selectedClusterId}/${selectedNodeIdx}`)).then(snap => {
        const data = snap.val();
        const list = document.getElementById('peHistoryList');
        if (!data) {
            list.innerHTML = '<div style="color:#444;font-size:0.78rem;padding:14px;text-align:center;">No pre-entry sessions today.</div>';
            return;
        }

        const todayItems = Object.values(data)
            .filter(r => r.date === today)
            .sort((a,b) => (b.savedAt||'').localeCompare(a.savedAt||''));

        if (!todayItems.length) {
            list.innerHTML = '<div style="color:#444;font-size:0.78rem;padding:14px;text-align:center;">No pre-entry sessions today.</div>';
            return;
        }

        list.innerHTML = todayItems.map(r => {
            const mins = Math.floor((r.timerSecs||0)/60);
            const secs = (r.timerSecs||0) % 60;
            const hasConflict = !!r.conflict;
            const cls = hasConflict ? 'conflict' : r.score >= 75 ? 'went-live' : 'skipped';
            const time = new Date(r.savedAt).toLocaleTimeString('en-GB',{hour12:false,hour:'2-digit',minute:'2-digit'});
            return `
            <div class="pe-history-item ${cls}">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div>
                        <span style="color:var(--gold);font-weight:bold;font-size:0.82rem;">${time}</span>
                        <span style="color:#555;font-size:0.65rem;margin-left:8px;">${r.asset || '—'} | ${r.direction || '—'}</span>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-family:monospace;font-weight:bold;color:${r.score>=75?'var(--accent)':r.score>=50?'var(--gold)':'var(--danger)'};">${r.score}/100</div>
                        <div style="font-size:0.58rem;color:#555;">${mins}m ${secs}s analysis</div>
                    </div>
                </div>
                <div style="font-size:0.65rem;color:#666;margin-top:5px;">${r.biasResult||'—'}</div>
                ${r.conflict ? `<div style="font-size:0.62rem;color:#ff6600;margin-top:4px;">⚠ ${r.conflict.slice(0,80)}...</div>` : ''}
                ${r.note ? `<div style="font-size:0.63rem;color:#555;margin-top:4px;font-style:italic;">"${r.note.slice(0,100)}${r.note.length>100?'...':''}"</div>` : ''}
            </div>`;
        }).join('');
    });
}

// Set today's date
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.ready-item').forEach(el => el.classList.remove('checked'));
    updateReadinessScore();
    recalcScore();
});

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
