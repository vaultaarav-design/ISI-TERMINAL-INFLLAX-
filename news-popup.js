// ══════════════════════════════════════════════════════════════════
// NEWS IMPACT POPUP — shared across ALL pages (Terminal, Pre-Entry,
// Monitoring, Multi Cluster, Knowledge, Algo, Settings)
// Data source: isi_v6/news in Firebase (added by trader via Settings
// → News Event Manager). 100% real, trader-entered data — no fake/API data.
//
// Behaviour:
//  - Popup shows automatically starting 2 hours BEFORE a news event's
//    start time, and stays "active" until the news event's end time.
//  - Re-appears every time the page becomes visible again (page switch,
//    tab switch, app resume) — even if dismissed earlier — so the
//    trader keeps getting reminded until the news window is over.
//  - Works identically in Dark and Light theme (reuses .mon-modal CSS
//    already defined in style.css, which both themes already style).
// ══════════════════════════════════════════════════════════════════
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
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

// IMPORTANT: use a uniquely-NAMED secondary Firebase app instance ('newsPopup'),
// never the default app. Every page (monitoring.js, index.js, settings.js, etc.)
// already calls initializeApp(firebaseConfig) for the DEFAULT app with no
// getApps() guard — if this module touched the default app name at all, on
// whichever page happens to execute this script first, every other page's own
// initializeApp() call would throw "Firebase App named '[DEFAULT]' already
// exists" and crash that page's entire script. A named app sidesteps this
// completely regardless of script execution order.
const existing = getApps().find(a => a.name === 'newsPopup');
const app = existing || initializeApp(firebaseConfig, 'newsPopup');
const db  = getDatabase(app);

let _newsList = [];
let _lastShownFor = null; // dedupe key so we don't rebuild identical popup content repeatedly

function computeActiveNews() {
    const now = new Date();
    return _newsList.filter(n => {
        try {
            const start = new Date(`${n.date}T${n.start}:00`);
            const end   = new Date(`${n.date}T${n.end}:00`);
            const popupStart = new Date(start.getTime() - 2 * 3600 * 1000); // 2 hrs before
            return now >= popupStart && now <= end;
        } catch (e) { return false; }
    });
}

function fmtCountdown(msLeft) {
    if (msLeft <= 0) return 'Started';
    const totalMin = Math.floor(msLeft / 60000);
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function ensureOverlay() {
    let ov = document.getElementById('newsPopupOverlay');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'newsPopupOverlay';
    ov.className = 'mon-modal';
    ov.style.zIndex = '99998';
    ov.innerHTML = `
        <div class="mon-modal-content" style="max-width:480px;border-top-color:#ff9955;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
                <h2 style="color:#ff9955;margin:0;border:none;padding:0;">📰 News Impact Alert</h2>
                <button onclick="window.__dismissNewsPopup()" style="background:var(--danger);border:none;color:#fff;padding:7px 14px;cursor:pointer;font-weight:bold;width:auto;border-radius:4px;">CLOSE ✕</button>
            </div>
            <div id="newsPopupBody"></div>
        </div>
    `;
    document.body.appendChild(ov);
    return ov;
}

function renderNewsPopup(activeNews) {
    const ov = ensureOverlay();
    const body = document.getElementById('newsPopupBody');
    const now = new Date();
    const impactColor = { High: '#ff5252', Medium: '#ffaa00', Low: '#00c805' };

    body.innerHTML = `
        <div style="font-size:0.68rem;color:#888;margin-bottom:14px;">
            High-impact news window active hai — trading avoid karo ya risk kam rakho jab tak ye window khatam na ho jaaye.
        </div>
        ${activeNews.map(n => {
            const start = new Date(`${n.date}T${n.start}:00`);
            const end   = new Date(`${n.date}T${n.end}:00`);
            const status = now < start ? `Starts in ${fmtCountdown(start - now)}` :
                           now <= end   ? `🔴 LIVE NOW — ends in ${fmtCountdown(end - now)}` :
                                          'Ended';
            return `
            <div style="background:#0a0a0a;border:1px solid #1a1a1a;border-left:4px solid ${impactColor[n.impact]||'#888'};border-radius:6px;padding:12px 14px;margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;align-items:start;gap:8px;">
                    <div style="font-size:0.8rem;color:var(--text,#eee);font-weight:bold;">${n.title}</div>
                    <div style="font-size:0.55rem;color:${impactColor[n.impact]||'#888'};border:1px solid ${impactColor[n.impact]||'#888'};padding:2px 7px;border-radius:3px;white-space:nowrap;">${n.impact||'Medium'}</div>
                </div>
                <div style="font-size:0.65rem;color:#666;margin-top:6px;">${n.date} · ${n.start} → ${n.end} IST</div>
                <div style="font-size:0.68rem;margin-top:6px;font-weight:bold;color:${now <= end && now >= start ? '#ff5252' : 'var(--gold)'};">${status}</div>
            </div>`;
        }).join('')}
        <div style="font-size:0.55rem;color:#444;margin-top:6px;text-align:center;">Ye list Settings → News Event Manager se tumne khud add ki hai.</div>
    `;
    ov.style.display = 'block';
}

window.__dismissNewsPopup = function () {
    const ov = document.getElementById('newsPopupOverlay');
    if (ov) ov.style.display = 'none';
};

function checkAndShowNews(force) {
    // ── BOOT-SEQUENCE SAFETY: never let the news popup cover/interrupt an
    // active password/security-key entry (e.g. index.html's #sysPass "Enter
    // Cluster Security Key" field). If that field exists and currently has
    // focus, defer showing — recheck shortly after instead of blocking it. ──
    const pwField = document.getElementById('sysPass');
    if (pwField && document.activeElement === pwField) {
        setTimeout(() => checkAndShowNews(force), 1500);
        return;
    }

    const active = computeActiveNews();
    if (!active.length) {
        window.__dismissNewsPopup();
        _lastShownFor = null;
        return;
    }
    const key = active.map(n => n.date + n.start).sort().join('|');
    const ov = document.getElementById('newsPopupOverlay');
    const isVisible = ov && ov.style.display === 'block';
    if (force || !isVisible || key !== _lastShownFor) {
        renderNewsPopup(active);
        _lastShownFor = key;
    }
}

onValue(ref(db, 'isi_v6/news'), (snap) => {
    const val = snap.val() || {};
    _newsList = Object.values(val);
    checkAndShowNews(false);
});

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => checkAndShowNews(true), 1200);
    const pwField = document.getElementById('sysPass');
    if (pwField) pwField.addEventListener('blur', () => checkAndShowNews(true));
});
if (document.readyState !== 'loading') setTimeout(() => checkAndShowNews(true), 1200);

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkAndShowNews(true);
});
window.addEventListener('pageshow', () => checkAndShowNews(true));
window.addEventListener('focus', () => checkAndShowNews(true));

setInterval(() => checkAndShowNews(false), 60000);
