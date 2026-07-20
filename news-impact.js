// ══════════════════════════════════════════════════════════════════
// NEWS IMPACT — correlates real trades against real news events
// (both from Firebase, trader-entered in Settings → News Event Manager).
// No external/fake news API — 100% the trader's own data.
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
// Reuse the same named 'newsPopup' app instance if news-popup.js already created it on this page.
const existing = getApps().find(a => a.name === 'newsPopup');
const app = existing || initializeApp(firebaseConfig, 'newsPopup');
const db  = getDatabase(app);

let _newsCache = [];
onValue(ref(db, 'isi_v6/news'), (snap) => { _newsCache = Object.values(snap.val() || {}); });

function fmtMoney(curr, v) { const s = v>=0?'+':'-'; return `${s}${curr}${Math.abs(v).toFixed(2)}`; }
function dominantCurrency(trades) {
    const counts = {}; trades.forEach(t=>{const c=t._curr||'$'; counts[c]=(counts[c]||0)+1;});
    let best='$',bestN=-1; Object.entries(counts).forEach(([c,n])=>{if(n>bestN){best=c;bestN=n;}});
    return best;
}

function tradeNewsOverlap(t, newsList) {
    const timeStr = t.preEntryTime || t.savedAt;
    if (!timeStr) return [];
    const tTime = new Date(timeStr);
    if (isNaN(tTime)) return [];
    return newsList.filter(n => {
        try {
            const start = new Date(`${n.date}T${n.start}:00`);
            const end   = new Date(`${n.date}T${n.end}:00`);
            const popupStart = new Date(start.getTime() - 2*3600*1000);
            return tTime >= popupStart && tTime <= end;
        } catch (e) { return false; }
    });
}

export function computeNewsImpact(trades) {
    const sorted = [...(trades||[])].filter(Boolean)
        .sort((a,b) => (a.date||'').localeCompare(b.date||''));
    const curr = dominantCurrency(sorted);
    const newsList = _newsCache;

    const newsTrades = [], normalTrades = [];
    sorted.forEach(t => {
        const overlaps = tradeNewsOverlap(t, newsList);
        if (overlaps.length) newsTrades.push({ ...t, _newsOverlap: overlaps });
        else normalTrades.push(t);
    });

    const statsOf = (arr) => {
        const count = arr.length;
        const wins  = arr.filter(t => t.type === 'Target').length;
        const pl    = arr.reduce((s,t) => s + (Number(t.pl)||0), 0);
        return { count, wins, pl, winRate: count ? (wins/count*100) : 0, avgPl: count ? pl/count : 0 };
    };

    return {
        curr, count: sorted.length,
        newsListCount: newsList.length,
        newsTrades: statsOf(newsTrades),
        normalTrades: statsOf(normalTrades),
        newsTradeRows: newsTrades
    };
}

function statCard(label, value, sub, color) {
    return `<div style="background:#0a0a0a;border:1px solid #1a1a1a;border-radius:8px;padding:12px 14px;">
        <div style="font-size:0.5rem;color:#666;letter-spacing:2px;font-weight:bold;margin-bottom:6px;">${label}</div>
        <div style="font-size:1.1rem;font-weight:900;color:${color||'#ccc'};">${value}</div>
        ${sub ? `<div style="font-size:0.55rem;color:#555;margin-top:3px;">${sub}</div>` : ''}
    </div>`;
}

export function renderNewsImpactUI(container, trades) {
    const m = computeNewsImpact(trades || []);
    const c = m.curr;

    if (!m.count) {
        container.innerHTML = `<div style="color:#555;font-size:0.75rem;padding:30px;text-align:center;">Is selection ke liye abhi koi trade data nahi mila.</div>`;
        return;
    }
    if (!m.newsListCount) {
        container.innerHTML = `<div style="color:#555;font-size:0.75rem;padding:30px;text-align:center;">
            Abhi tak koi news event add nahi kiya. <a href="Settings.html" style="color:#ff9955;">Settings → News Event Manager</a> mein jaake pehle news add karo, tabhi ye report kaam karega.
        </div>`;
        return;
    }

    const nt = m.newsTrades, ot = m.normalTrades;

    container.innerHTML = `
        <div style="font-size:0.6rem;color:#555;margin-bottom:14px;font-style:italic;">
            Tumhari ${m.newsListCount} news events ke against ${m.count} trades check kiye — kaunse trades news-window (start se 2 ghante pehle se end tak) ke andar liye gaye.
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px;">
            <div style="background:#1a0000;border:1px solid #4a1a1a;border-radius:8px;padding:14px;">
                <div style="font-size:0.58rem;color:#ff5252;letter-spacing:2px;font-weight:bold;margin-bottom:10px;">🔴 TRADES DURING NEWS WINDOW</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                    ${statCard('COUNT', nt.count, '', '#ff5252')}
                    ${statCard('WIN RATE', nt.winRate.toFixed(1)+'%', '', nt.winRate>=50?'#00c805':'#ff5252')}
                    ${statCard('NET P/L', fmtMoney(c, nt.pl), '', nt.pl>=0?'#00c805':'#ff3333')}
                    ${statCard('AVG P/L', fmtMoney(c, nt.avgPl), 'per trade', nt.avgPl>=0?'#00c805':'#ff3333')}
                </div>
            </div>
            <div style="background:#001a05;border:1px solid #1a4a2a;border-radius:8px;padding:14px;">
                <div style="font-size:0.58rem;color:#00c805;letter-spacing:2px;font-weight:bold;margin-bottom:10px;">🟢 NORMAL TRADES (NO NEWS NEARBY)</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                    ${statCard('COUNT', ot.count, '', '#00c805')}
                    ${statCard('WIN RATE', ot.winRate.toFixed(1)+'%', '', ot.winRate>=50?'#00c805':'#ff5252')}
                    ${statCard('NET P/L', fmtMoney(c, ot.pl), '', ot.pl>=0?'#00c805':'#ff3333')}
                    ${statCard('AVG P/L', fmtMoney(c, ot.avgPl), 'per trade', ot.avgPl>=0?'#00c805':'#ff3333')}
                </div>
            </div>
        </div>

        ${nt.count > 0 && ot.count > 0 ? `
        <div style="background:${ (ot.avgPl - nt.avgPl) > 0 ? '#1a0f00' : '#001a05'};border:1px solid #333;border-radius:8px;padding:12px 14px;margin-bottom:18px;text-align:center;">
            <span style="font-size:0.72rem;color:#ccc;">Normal trades ka average P/L news-window trades se <b style="color:${(ot.avgPl-nt.avgPl)>0?'#ff9955':'#00c805'};">${fmtMoney(c, ot.avgPl-nt.avgPl)}</b> ${(ot.avgPl-nt.avgPl)>=0?'zyada':'kam'} hai per trade.</span>
        </div>` : ''}

        <div style="font-size:0.6rem;color:var(--gold, #c5a059);letter-spacing:2px;font-weight:bold;margin-bottom:8px;">📋 NEWS-WINDOW TRADES — DETAIL</div>
        ${m.newsTradeRows.length ? m.newsTradeRows.map(t => `
            <div style="background:#0a0a0a;border:1px solid #1a1a1a;border-left:4px solid #ff5252;border-radius:6px;padding:10px 12px;margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;font-size:0.68rem;">
                    <span style="color:#ccc;">${t.date} · ${t.asset||'—'} · ${t.nodeTitle||''}</span>
                    <span style="font-weight:bold;color:${(Number(t.pl)||0)>=0?'#00c805':'#ff3333'};">${fmtMoney(t._curr||c, Number(t.pl)||0)}</span>
                </div>
                <div style="font-size:0.58rem;color:#ff9955;margin-top:4px;">⚠ ${t._newsOverlap.map(n=>n.title).join(', ')}</div>
            </div>
        `).join('') : '<div style="color:#555;font-size:0.65rem;padding:10px;">Koi trade news-window ke andar nahi mila — accha discipline!</div>'}
    `;
}
