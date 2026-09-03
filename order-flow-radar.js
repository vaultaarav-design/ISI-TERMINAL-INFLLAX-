/**
 * ISI Terminal v6 — ORDER FLOW RADAR
 * ══════════════════════════════════════════════════════════════
 * Inspired by institutional order-flow tools (liquidity heatmaps, stop-
 * hunt zones, liquidity scoring) — but built HONESTLY within what's
 * actually possible from a static frontend with free/public data. Two
 * things from the inspiration are deliberately NOT attempted here:
 *
 *   - "Iceberg Tracker" — detecting hidden orders that keep refilling
 *     at the same price needs a continuous raw trade-tape stream +
 *     pattern analysis over time. That needs a always-on backend
 *     worker, not a page that only runs while open in a browser tab.
 *   - "MBO Bundle / 0.01s precision" — tick-level Market-By-Order data
 *     is institutional-grade paid data (Bloomberg/Refinitiv/exchange
 *     direct feeds) — no free API provides this.
 *
 * What IS built, honestly:
 *
 *  1. CRYPTO — LIVE Order Book Depth Map (Binance Futures /fapi/v1/depth,
 *     no key needed) — a real snapshot of resting bid/ask size at each
 *     price level, refreshed periodically. This is a genuine "where are
 *     the walls right now" view — just not a multi-hour rolling
 *     heatmap-over-time (that needs 24/7 data collection this static
 *     page can't do on its own).
 *
 *  2. STOP-HUNT ZONES (both Crypto + Forex/US) — approximate, not
 *     exact: recent swing-high/low + round-number levels, the classic
 *     places retail stop-losses cluster and price often "hunts" before
 *     reversing. Crypto uses Binance klines; Forex/US uses Stooq's free
 *     keyless daily-OHLC CSV endpoint.
 *
 *  3. LIQUIDITY QUALITY SCORE (both) — ISI's own composite score
 *     (−100..+100 style, but here 0-100 "quality" scale since this
 *     isn't bullish/bearish, it's about HOW TRADEABLE conditions are):
 *       Crypto  = order-book bid/ask imbalance + spread tightness + OI
 *       Forex/US = COT positioning extremity (crowded = thinner/riskier)
 *                  — reuses the SAME COT fetch already built for the
 *                  Smart Money Dashboard, no duplicate logic.
 * ══════════════════════════════════════════════════════════════
 */
import { COT_INSTRUMENTS, fetchCOTSnapshotWithFallback } from './smart-money.js';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ══════════════════════════════════════════════════════════════
// CRYPTO — Binance Futures (live, no key)
// ══════════════════════════════════════════════════════════════
const BINANCE_BASE = 'https://fapi.binance.com';

async function binanceGet(path, params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${BINANCE_BASE}${path}?${qs}`);
    if (!res.ok) throw new Error(`Binance ${path} → HTTP ${res.status}`);
    return res.json();
}

/** Live order-book snapshot — top N levels each side, with the biggest "wall" flagged. */
export async function fetchOrderBookDepth(symbol, limit = 20) {
    const data = await binanceGet('/fapi/v1/depth', { symbol, limit });
    const bids = (data.bids || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
    const asks = (data.asks || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
    const maxQty = Math.max(...bids.map(b => b.qty), ...asks.map(a => a.qty), 1);
    const biggestBidWall = bids.reduce((max, b) => b.qty > (max?.qty || 0) ? b : max, null);
    const biggestAskWall = asks.reduce((max, a) => a.qty > (max?.qty || 0) ? a : max, null);

    const bidTotal = bids.reduce((s, b) => s + b.qty, 0);
    const askTotal = asks.reduce((s, a) => s + a.qty, 0);
    const imbalancePct = (bidTotal + askTotal) ? ((bidTotal - askTotal) / (bidTotal + askTotal)) * 100 : 0;
    const bestBid = bids[0]?.price || 0, bestAsk = asks[0]?.price || 0;
    const spreadPct = bestBid ? ((bestAsk - bestBid) / bestBid) * 100 : 0;

    return { symbol, bids, asks, maxQty, biggestBidWall, biggestAskWall, imbalancePct, spreadPct, fetchedAt: new Date().toISOString() };
}

/** Recent klines → swing high/low + round-number levels near current price. */
export async function fetchCryptoStopHuntZones(symbol, interval = '1h', lookback = 48) {
    const klines = await binanceGet('/fapi/v1/klines', { symbol, interval, limit: lookback });
    const highs = klines.map(k => parseFloat(k[2]));
    const lows  = klines.map(k => parseFloat(k[3]));
    const closes = klines.map(k => parseFloat(k[4]));
    const currentPrice = closes[closes.length - 1];
    const swingHigh = Math.max(...highs);
    const swingLow  = Math.min(...lows);
    return { symbol, currentPrice, swingHigh, swingLow, roundLevels: roundNumberLevels(currentPrice), fetchedAt: new Date().toISOString() };
}

/** Nearby psychological round-number levels — classic stop-cluster zones. */
function roundNumberLevels(price) {
    if (!price) return [];
    const magnitude = Math.pow(10, Math.floor(Math.log10(price)) - 1);
    const step = magnitude;
    const base = Math.floor(price / step) * step;
    return [base - step, base, base + step, base + 2 * step].filter(l => l > 0);
}

export async function fetchCryptoOI(symbol) {
    try {
        const data = await binanceGet('/fapi/v1/openInterest', { symbol });
        return parseFloat(data.openInterest) || 0;
    } catch (e) { return 0; }
}

/** ISI's own Liquidity Quality Score for crypto — 0 (thin/risky) to 100 (deep/tradeable). */
export function scoreCryptoLiquidity(depth) {
    const imbalanceScore = clamp(100 - Math.abs(depth.imbalancePct) * 2, 0, 100); // heavy imbalance = lower quality
    const spreadScore    = clamp(100 - depth.spreadPct * 500, 0, 100); // wider spread = lower quality
    const score = Math.round(clamp(imbalanceScore * 0.5 + spreadScore * 0.5, 0, 100));
    return { score, breakdown: { imbalanceScore, spreadScore } };
}

// ══════════════════════════════════════════════════════════════
// FOREX / US — Stooq daily OHLC (free, keyless) for stop-hunt zones,
// COT (reused from smart-money.js) for liquidity/crowding score.
// ══════════════════════════════════════════════════════════════
export const STOOQ_INSTRUMENTS = [
    { key: 'EURUSD', label: 'EUR/USD',  symbol: 'eurusd',  group: 'Forex' },
    { key: 'GBPUSD', label: 'GBP/USD',  symbol: 'gbpusd',  group: 'Forex' },
    { key: 'USDJPY', label: 'USD/JPY',  symbol: 'usdjpy',  group: 'Forex' },
    { key: 'XAUUSD', label: 'Gold (XAU/USD)', symbol: 'xauusd', group: 'Commodities' },
    { key: 'SPX',    label: 'S&P 500',  symbol: '^spx',    group: 'US Market' },
    { key: 'NDX',    label: 'Nasdaq 100', symbol: '^ndq',  group: 'US Market' },
];

/** Stooq's CSV endpoint — no key, "Date,Open,High,Low,Close,Volume" rows. */
async function stooqDailyCSV(symbol, days = 30) {
    const res = await fetch(`https://stooq.com/q/d/l/?s=${symbol}&i=d`);
    if (!res.ok) throw new Error(`Stooq → HTTP ${res.status}`);
    const text = await res.text();
    const rows = text.trim().split('\n').slice(1); // drop header
    const parsed = rows.map(r => {
        const [date, open, high, low, close] = r.split(',');
        return { date, high: parseFloat(high), low: parseFloat(low), close: parseFloat(close) };
    }).filter(r => !isNaN(r.close));
    return parsed.slice(-days);
}

export async function fetchForexStopHuntZones(instrument) {
    const rows = await stooqDailyCSV(instrument.symbol, 30);
    if (!rows.length) throw new Error('No Stooq data returned');
    const highs = rows.map(r => r.high);
    const lows  = rows.map(r => r.low);
    const currentPrice = rows[rows.length - 1].close;
    return {
        key: instrument.key, label: instrument.label, group: instrument.group,
        currentPrice, swingHigh: Math.max(...highs), swingLow: Math.min(...lows),
        roundLevels: roundNumberLevels(currentPrice),
        fetchedAt: new Date().toISOString(),
    };
}

export async function fetchForexStopHuntZonesWithFallback(instrument) {
    try { return await fetchForexStopHuntZones(instrument); }
    catch (e) { return { key: instrument.key, label: instrument.label, group: instrument.group, error: e.message }; }
}

/** Reuses the SAME COT data already built for Smart Money Dashboard — no duplicate fetch logic. */
export async function fetchForexLiquidityScore(cotInstrumentKey) {
    const inst = COT_INSTRUMENTS.find(i => i.key === cotInstrumentKey);
    if (!inst) return null;
    const cot = await fetchCOTSnapshotWithFallback(inst);
    if (cot.error) return { error: cot.error };
    // Extreme net-positioning (either direction) = crowded market = thinner
    // liquidity on the "surprise" side if positioning unwinds.
    const crowdingScore = clamp(100 - Math.abs(cot.netPositionPct) * 2, 0, 100);
    return { key: inst.key, label: inst.label, crowdingScore: Math.round(crowdingScore), netPositionPct: cot.netPositionPct, reportDate: cot.reportDate };
}
