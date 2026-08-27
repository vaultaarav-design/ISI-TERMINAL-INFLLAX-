/**
 * ISI Terminal v6 — SMART MONEY DASHBOARD ENGINE
 * ══════════════════════════════════════════════════════════════
 * Three data zones, each handled honestly according to what's
 * actually technically possible from a pure browser (no backend
 * server on this static app):
 *
 *  1) CRYPTO — LIVE, fully automatic.
 *     Binance Futures public REST API (no key needed, CORS-open):
 *       • Open Interest + 24h change
 *       • Funding Rate (perpetual)
 *       • Long/Short Ratio — Global accounts vs Top-Trader accounts
 *         vs Top-Trader positions (closest available proxy for
 *         "smart/big money" vs "retail crowd" on Binance)
 *       • Taker Buy/Sell volume ratio
 *       • 24h price change (to judge whether OI is confirming trend)
 *     Plus Fear & Greed Index (alternative.me, free/live).
 *
 *  2) FOREX + US INDICES + COMMODITIES + BTC FUTURES — LIVE, weekly.
 *     CFTC "Commitment of Traders" (COT) report — the official,
 *     government-published, classic "smart money" indicator: what
 *     Non-Commercial (large speculators/institutions) are net
 *     long/short on CME/ICE/COMEX/NYMEX futures. ONE public API
 *     (publicreporting.cftc.gov, Socrata/open-data — CORS-open)
 *     covers ALL of: EUR/GBP/JPY/AUD/CAD/CHF/NZD, USD Index (DXY),
 *     S&P 500 / Nasdaq / Dow E-mini futures, Gold/Silver/Crude Oil,
 *     and CME Bitcoin futures. Updates once a week (Fridays, for the
 *     prior Tuesday's data) — that's the CFTC's own publish cadence,
 *     not a limitation of this code.
 *
 *  3) INDIA (NSE) — MANUAL QUICK-ENTRY, by design, not a shortcut.
 *     NSE's FII/DII, Option-Chain/PCR, Participant-wise OI and
 *     Delivery% data all sit behind session-cookie + anti-bot
 *     protection on nseindia.com. A browser fetch from a static site
 *     (no backend proxy) WILL fail there — that is a hard technical
 *     wall, not something any amount of client JS can route around.
 *     So this section gives a ~60-second daily entry form (same
 *     pattern as the existing News Event Manager: trader's own
 *     numbers, no fake data) and keeps full history + trend in
 *     Firebase, so it's still trackable over time.
 *
 * ══════════════════════════════════════════════════════════════
 * CUSTOM "SMART MONEY SCORE" LOGIC (ISI's own — transparent, tunable)
 * ══════════════════════════════════════════════════════════════
 * Every zone produces a composite score from −100 (max bearish
 * smart-money lean) to +100 (max bullish). This is NOT a black box —
 * every component and its weight is named below and in-line, so it
 * can be argued with / retuned. It is an opinionated heuristic, not
 * a scientific formula — treat it as a fast "which way is the big
 * money leaning" gauge, not a signal to blindly trade.
 *
 *  CRYPTO SCORE =
 *      + fundingScore   (extreme positive funding = crowded-long
 *                         retail paying shorts → mild BEARISH fade;
 *                         extreme negative = crowded-short → mild
 *                         BULLISH fade)                       [±40]
 *      + topVsGlobalScore (Top-Trader accounts net-long/short bias
 *                         MINUS Global/retail accounts bias — when
 *                         big accounts diverge from the crowd, that
 *                         divergence IS the smart-money signal)  [±30]
 *      + oiTrendScore    (rising OI in the SAME direction as the
 *                         24h price move = fresh conviction;
 *                         falling OI = unwind/no conviction)     [±15]
 *      + takerFlowScore  (aggressive taker buy vs sell volume)   [±15]
 *
 *  COT SCORE (per Forex/Index/Commodity/BTC-futures instrument) =
 *      + netPositionScore (Non-Commercial net position as % of
 *                         total Open Interest, scaled)           [±85]
 *      + momentumScore    (week-over-week change in that net %,
 *                         i.e. is the big-money bias building or
 *                         fading)                                [±15]
 *
 *  INDIA SCORE (from the trader's manual daily entry) =
 *      + fiiFlowScore     (net FII cash+F&O flow, sign + magnitude) [±40]
 *      + pcrScore         (Put-Call Ratio, CONTRARIAN: high PCR =
 *                         excess put buying/fear = bullish tilt;
 *                         low PCR = complacency = bearish tilt)    [±40]
 *      + participantScore (Client/retail OI positioning vs FII+Pro,
 *                         CONTRARIAN on the retail side)           [±20]
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
const smApp = getApps().find(a => a.name === '[DEFAULT]') || getApps()[0] || initializeApp(firebaseConfig, 'isiSmartMoney');
const db = getDatabase(smApp);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function pct(a, b) { return b ? ((a - b) / b) * 100 : 0; }

// ══════════════════════════════════════════════════════════════
// ZONE 1 — CRYPTO (Binance Futures, live)
// ══════════════════════════════════════════════════════════════
const BINANCE_BASE = 'https://fapi.binance.com';

async function binanceGet(path, params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${BINANCE_BASE}${path}?${qs}`);
    if (!res.ok) throw new Error(`Binance ${path} → HTTP ${res.status}`);
    return res.json();
}

export async function fetchCryptoSnapshot(symbol) {
    const [oiHist, funding, topAcct, globalAcct, topPos, takerFlow, ticker24h] = await Promise.all([
        binanceGet('/futures/data/openInterestHist', { symbol, period: '1h', limit: 25 }),
        binanceGet('/fapi/v1/premiumIndex', { symbol }),
        binanceGet('/futures/data/topLongShortAccountRatio', { symbol, period: '1h', limit: 1 }),
        binanceGet('/futures/data/globalLongShortAccountRatio', { symbol, period: '1h', limit: 1 }),
        binanceGet('/futures/data/topLongShortPositionRatio', { symbol, period: '1h', limit: 1 }),
        binanceGet('/futures/data/takerlongshortRatio', { symbol, period: '1h', limit: 1 }),
        binanceGet('/fapi/v1/ticker/24hr', { symbol }),
    ]);

    const oiLatest = oiHist.length ? Number(oiHist[oiHist.length - 1].sumOpenInterest) : null;
    const oiEarliest = oiHist.length ? Number(oiHist[0].sumOpenInterest) : null;
    const oiChangePct24h = (oiLatest !== null && oiEarliest) ? pct(oiLatest, oiEarliest) : 0;

    const fundingRatePct = funding.lastFundingRate ? Number(funding.lastFundingRate) * 100 : 0;
    const priceChangePct = ticker24h.priceChangePercent ? Number(ticker24h.priceChangePercent) : 0;

    const topLSRatio = topAcct.length ? Number(topAcct[0].longShortRatio) : 1;
    const globalLSRatio = globalAcct.length ? Number(globalAcct[0].longShortRatio) : 1;
    const topPosRatio = topPos.length ? Number(topPos[0].longShortRatio) : 1;
    const takerBSRatio = takerFlow.length ? Number(takerFlow[0].buySellRatio) : 1;

    // ── SCORING (see file header for the full rationale of each term) ──
    const fundingScore = clamp(-fundingRatePct * 400, -40, 40);
    const topVsGlobalScore = clamp((topLSRatio - globalLSRatio) * 30, -30, 30);
    const oiTrendScore = clamp(Math.sign(priceChangePct) * Math.min(Math.abs(oiChangePct24h), 15), -15, 15);
    const takerFlowScore = clamp((takerBSRatio - 1) * 20, -15, 15);
    const score = Math.round(clamp(fundingScore + topVsGlobalScore + oiTrendScore + takerFlowScore, -100, 100));

    return {
        symbol, markPrice: Number(funding.markPrice) || null, priceChangePct,
        openInterest: oiLatest, oiChangePct24h,
        fundingRatePct, nextFundingTime: funding.nextFundingTime || null,
        topLSRatio, globalLSRatio, topPosRatio, takerBSRatio,
        score, breakdown: { fundingScore, topVsGlobalScore, oiTrendScore, takerFlowScore },
        fetchedAt: new Date().toISOString(),
    };
}

export async function fetchFearGreedIndex() {
    const res = await fetch('https://api.alternative.me/fng/?limit=2');
    if (!res.ok) throw new Error(`Fear&Greed → HTTP ${res.status}`);
    const data = await res.json();
    const rows = data.data || [];
    return {
        value: rows[0] ? Number(rows[0].value) : null,
        classification: rows[0] ? rows[0].value_classification : null,
        prevValue: rows[1] ? Number(rows[1].value) : null,
        fetchedAt: new Date().toISOString(),
    };
}

// ══════════════════════════════════════════════════════════════
// ZONE 2 — FOREX / US INDICES / COMMODITIES / BTC FUTURES (CFTC COT, live weekly)
// ══════════════════════════════════════════════════════════════
const COT_BASE = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';

// Distinctive substrings matched against CFTC's Market_and_Exchange_Names
// column via a SoQL LIKE query — safer than hard-coding the full exact
// name (CFTC's naming has changed slightly over the years).
export const COT_INSTRUMENTS = [
    { key: 'EUR', label: 'EUR/USD',        group: 'Forex',      match: 'EURO FX' },
    { key: 'GBP', label: 'GBP/USD',        group: 'Forex',      match: 'BRITISH POUND' },
    { key: 'JPY', label: 'USD/JPY',        group: 'Forex',      match: 'JAPANESE YEN' },
    { key: 'AUD', label: 'AUD/USD',        group: 'Forex',      match: 'AUSTRALIAN DOLLAR' },
    { key: 'CAD', label: 'USD/CAD',        group: 'Forex',      match: 'CANADIAN DOLLAR' },
    { key: 'CHF', label: 'USD/CHF',        group: 'Forex',      match: 'SWISS FRANC' },
    { key: 'NZD', label: 'NZD/USD',        group: 'Forex',      match: 'NZ DOLLAR' },
    { key: 'DXY', label: 'US Dollar Index', group: 'Forex',     match: 'USD INDEX' },
    { key: 'SPX', label: 'S&P 500 (E-mini)', group: 'US Market', match: 'E-MINI S&P 500' },
    { key: 'NDX', label: 'Nasdaq (E-mini)', group: 'US Market', match: 'NASDAQ-100' },
    { key: 'DOW', label: 'Dow Jones (mini)', group: 'US Market', match: 'DOW JONES' },
    { key: 'RUT', label: 'Russell 2000',   group: 'US Market',  match: 'RUSSELL 2000' },
    { key: 'VIX', label: 'VIX Futures',    group: 'US Market',  match: 'VIX FUTURE' },
    { key: 'GOLD', label: 'Gold',          group: 'Commodities', match: 'GOLD' },
    { key: 'SILVER', label: 'Silver',      group: 'Commodities', match: 'SILVER' },
    { key: 'WTI', label: 'Crude Oil WTI',  group: 'Commodities', match: 'WTI-PHYSICAL' },
    { key: 'BTC', label: 'Bitcoin Futures', group: 'Crypto Futures', match: 'BITCOIN' },
];

async function cotFetchRaw(matchFragment) {
    const where = `upper(market_and_exchange_names) like '%${matchFragment.toUpperCase()}%'`;
    const qs = new URLSearchParams({
        '$where': where,
        '$order': 'report_date_as_yyyy_mm_dd DESC',
        '$limit': '2',
    }).toString();
    const res = await fetch(`${COT_BASE}?${qs}`);
    if (!res.ok) throw new Error(`CFTC COT → HTTP ${res.status}`);
    return res.json();
}

export async function fetchCOTSnapshot(instrument) {
    const rows = await cotFetchRaw(instrument.match);
    if (!rows.length) throw new Error(`No CFTC rows matched "${instrument.match}"`);
    const latest = rows[0];
    const prev = rows[1] || null;

    const oi = Number(latest.open_interest_all) || 0;
    const ncLong = Number(latest.noncomm_positions_long_all) || 0;
    const ncShort = Number(latest.noncomm_positions_short_all) || 0;
    const netPositionPct = oi ? ((ncLong - ncShort) / oi) * 100 : 0;

    let wowChange = 0;
    if (prev) {
        const prevOi = Number(prev.open_interest_all) || 0;
        const prevLong = Number(prev.noncomm_positions_long_all) || 0;
        const prevShort = Number(prev.noncomm_positions_short_all) || 0;
        const prevNetPct = prevOi ? ((prevLong - prevShort) / prevOi) * 100 : 0;
        wowChange = netPositionPct - prevNetPct;
    }

    // ── SCORING ──
    const netPositionScore = clamp(netPositionPct * 2.5, -85, 85);
    const momentumScore = clamp(wowChange * 3, -15, 15);
    const score = Math.round(clamp(netPositionScore + momentumScore, -100, 100));

    const snapshot = {
        key: instrument.key, label: instrument.label, group: instrument.group,
        reportDate: latest.report_date_as_yyyy_mm_dd, openInterest: oi,
        ncLong, ncShort, netPositionPct: Math.round(netPositionPct * 100) / 100,
        wowChange: Math.round(wowChange * 100) / 100,
        score, breakdown: { netPositionScore, momentumScore },
        fetchedAt: new Date().toISOString(),
    };

    // Write-through cache — if a future fetch gets CORS/network-blocked,
    // the dashboard can still show the last known-good snapshot.
    set(ref(db, `isi_v6/smart_money/cot_cache/${instrument.key}`), snapshot).catch(() => {});
    return snapshot;
}

export async function fetchCOTSnapshotWithFallback(instrument) {
    try {
        return await fetchCOTSnapshot(instrument);
    } catch (e) {
        try {
            const cached = await get(ref(db, `isi_v6/smart_money/cot_cache/${instrument.key}`));
            if (cached.exists()) return { ...cached.val(), stale: true };
        } catch (e2) {}
        return { key: instrument.key, label: instrument.label, group: instrument.group, error: e.message };
    }
}

// ══════════════════════════════════════════════════════════════
// ZONE 3 — INDIA (manual quick-entry, honest about why)
// ══════════════════════════════════════════════════════════════
function todayStr() {
    return window._ISIDate ? window._ISIDate.todayStr() : new Date().toISOString().slice(0, 10);
}

export async function saveIndiaEntry(entry) {
    const date = todayStr();
    const fiiFlowScore = clamp(((Number(entry.fiiCashNet) || 0) + (Number(entry.fiiFoNet) || 0)) / 20, -40, 40);
    const pcr = Number(entry.pcr) || 1;
    const pcrScore = clamp((pcr - 1) * 60, -40, 40); // contrarian: high PCR (fear) → bullish tilt
    const clientNet = Number(entry.participantClientNet) || 0;
    const participantScore = clamp(-clientNet / 500, -20, 20); // retail net-long crowding → contrarian bearish tilt

    const score = Math.round(clamp(fiiFlowScore + pcrScore + participantScore, -100, 100));
    const record = {
        date, ...entry, score,
        breakdown: { fiiFlowScore, pcrScore, participantScore },
        enteredAt: new Date().toISOString(),
    };
    await set(ref(db, `isi_v6/smart_money/india/${date}`), record);
    return record;
}

export function watchIndiaHistory(callback) {
    const q = query(ref(db, 'isi_v6/smart_money/india'), limitToLast(30));
    return onValue(q, snap => {
        const val = snap.val() || {};
        const rows = Object.values(val).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        callback(rows);
    });
}

export async function getTodayIndiaEntry() {
    const snap = await get(ref(db, `isi_v6/smart_money/india/${todayStr()}`));
    return snap.exists() ? snap.val() : null;
}

window.ISI_SmartMoney = {
    fetchCryptoSnapshot, fetchFearGreedIndex,
    COT_INSTRUMENTS, fetchCOTSnapshotWithFallback,
    saveIndiaEntry, watchIndiaHistory, getTodayIndiaEntry,
};
