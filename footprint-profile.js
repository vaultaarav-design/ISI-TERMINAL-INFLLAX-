/**
 * ISI Terminal v6 — FOOTPRINT & VOLUME PROFILE
 * ══════════════════════════════════════════════════════════════
 * Two very different feasibility stories, both honestly labeled:
 *
 *  1. CRYPTO — REAL tick-level footprint/volume-profile, built from
 *     Binance Futures' public aggTrades endpoint (no key needed).
 *     Each trade carries price, quantity, and `m` (isBuyerMaker) —
 *     when isBuyerMaker=true the SELLER was the aggressor (hit the
 *     bid); when false the BUYER was the aggressor (lifted the ask).
 *     That's genuine buy/sell-initiated volume, not simulated.
 *
 *  2. FOREX / US — NO free tick-tape exists for OTC forex or most US
 *     equities, so a real footprint/volume-profile isn't possible
 *     here. What's shown instead is an EXPLICITLY-LABELED
 *     approximation: each day's total volume (from Stooq's free daily
 *     OHLCV) is spread evenly across that day's High–Low range and
 *     accumulated into price buckets over the lookback window. This
 *     gives a rough "where has volume concentrated" view — useful as
 *     a directional guide, NOT tick-accurate, and the UI says so.
 * ══════════════════════════════════════════════════════════════
 */

import { corsSafeFetchText } from './cors-fetch.js';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ══════════════════════════════════════════════════════════════
// CRYPTO — Binance Futures aggTrades (live, real tick data)
// ══════════════════════════════════════════════════════════════
const BINANCE_BASE = 'https://fapi.binance.com';

async function fetchAggTrades(symbol, limit = 1000) {
    const res = await fetch(`${BINANCE_BASE}/fapi/v1/aggTrades?symbol=${symbol}&limit=${limit}`);
    if (!res.ok) throw new Error(`Binance aggTrades → HTTP ${res.status}`);
    return res.json();
}

function tickSizeFor(price) {
    if (price >= 10000) return 50;
    if (price >= 1000)  return 5;
    if (price >= 100)   return 0.5;
    if (price >= 10)    return 0.05;
    if (price >= 1)     return 0.005;
    return 0.0005;
}

export async function buildCryptoFootprint(symbol, numColumns = 12) {
    const trades = await fetchAggTrades(symbol, 1000);
    if (!trades.length) throw new Error('No recent trades returned');

    const prices = trades.map(t => parseFloat(t.p));
    const avgPrice = prices.reduce((s, p) => s + p, 0) / prices.length;
    const tick = tickSizeFor(avgPrice);

    const perCol = Math.ceil(trades.length / numColumns);
    const columns = [];
    for (let i = 0; i < trades.length; i += perCol) {
        columns.push(trades.slice(i, i + perCol));
    }

    const footprintCols = columns.map(colTrades => {
        const levels = {};
        let high = -Infinity, low = Infinity;
        colTrades.forEach(t => {
            const price = parseFloat(t.p);
            const qty = parseFloat(t.q);
            high = Math.max(high, price);
            low = Math.min(low, price);
            const level = Math.round(price / tick) * tick;
            if (!levels[level]) levels[level] = { buy: 0, sell: 0 };
            if (t.m) levels[level].sell += qty; else levels[level].buy += qty;
        });
        const totalVol = colTrades.reduce((s, t) => s + parseFloat(t.q), 0);
        const range = high - low;
        const startTs = colTrades[0]?.T, endTs = colTrades[colTrades.length - 1]?.T;
        return { levels, high, low, range, totalVol, startTs, endTs };
    });

    const profileLevels = {};
    trades.forEach(t => {
        const price = parseFloat(t.p);
        const qty = parseFloat(t.q);
        const level = Math.round(price / tick) * tick;
        profileLevels[level] = (profileLevels[level] || 0) + qty;
    });
    const profileArr = Object.entries(profileLevels)
        .map(([price, vol]) => ({ price: parseFloat(price), vol }))
        .sort((a, b) => b.price - a.price);
    const poc = profileArr.reduce((max, l) => l.vol > (max?.vol || 0) ? l : max, null);
    const totalVolAll = profileArr.reduce((s, l) => s + l.vol, 0);

    let vaVol = poc ? poc.vol : 0;
    let loIdx = profileArr.findIndex(l => l.price === poc?.price);
    let hiIdx = loIdx;
    while (vaVol < totalVolAll * 0.68 && (loIdx > 0 || hiIdx < profileArr.length - 1)) {
        const nextLo = loIdx > 0 ? profileArr[loIdx - 1] : null;
        const nextHi = hiIdx < profileArr.length - 1 ? profileArr[hiIdx + 1] : null;
        if (nextHi && (!nextLo || nextHi.vol >= nextLo.vol)) { hiIdx++; vaVol += nextHi.vol; }
        else if (nextLo) { loIdx--; vaVol += nextLo.vol; }
        else break;
    }
    const valueAreaHigh = profileArr[loIdx]?.price;
    const valueAreaLow  = profileArr[hiIdx]?.price;

    const volSorted = [...footprintCols].sort((a, b) => b.totalVol - a.totalVol);
    const volThreshold = volSorted[Math.floor(volSorted.length * 0.15)]?.totalVol || Infinity;
    const rangeMedian = [...footprintCols].map(c => c.range).sort((a, b) => a - b)[Math.floor(footprintCols.length / 2)] || 0;
    footprintCols.forEach(c => { c.absorption = c.totalVol >= volThreshold && c.range <= rangeMedian; });

    return {
        symbol, tick, footprintCols, profileArr, poc, valueAreaHigh, valueAreaLow, totalVolAll,
        fetchedAt: new Date().toISOString(),
    };
}

// ══════════════════════════════════════════════════════════════
// FOREX / US — Stooq daily OHLCV → APPROXIMATE volume profile
// ══════════════════════════════════════════════════════════════
export const STOOQ_VP_INSTRUMENTS = [
    { key: 'EURUSD', label: 'EUR/USD', symbol: 'eurusd', group: 'Forex' },
    { key: 'GBPUSD', label: 'GBP/USD', symbol: 'gbpusd', group: 'Forex' },
    { key: 'USDJPY', label: 'USD/JPY', symbol: 'usdjpy', group: 'Forex' },
    { key: 'XAUUSD', label: 'Gold (XAU/USD)', symbol: 'xauusd', group: 'Commodities' },
    { key: 'SPX', label: 'S&P 500', symbol: '^spx', group: 'US Market' },
    { key: 'NDX', label: 'Nasdaq 100', symbol: '^ndq', group: 'US Market' },
];

async function stooqDailyCSVWithVolume(symbol, days = 30) {
    const text = await corsSafeFetchText(`https://stooq.com/q/d/l/?s=${symbol}&i=d`);
    const rows = text.trim().split('\n').slice(1);
    const parsed = rows.map(r => {
        const parts = r.split(',');
        const [date, open, high, low, close, volume] = parts;
        return { date, high: parseFloat(high), low: parseFloat(low), close: parseFloat(close), volume: parseFloat(volume) || 0 };
    }).filter(r => !isNaN(r.close));
    return parsed.slice(-days);
}

export async function buildForexVolumeProfileApprox(instrument, days = 30) {
    const rows = await stooqDailyCSVWithVolume(instrument.symbol, days);
    if (!rows.length) throw new Error('No Stooq data returned');
    const hasVolume = rows.some(r => r.volume > 0);

    const overallHigh = Math.max(...rows.map(r => r.high));
    const overallLow  = Math.min(...rows.map(r => r.low));
    const numBuckets = 20;
    const bucketSize = (overallHigh - overallLow) / numBuckets || 1;
    const buckets = Array.from({ length: numBuckets }, (_, i) => ({
        priceLow: overallLow + i * bucketSize,
        priceHigh: overallLow + (i + 1) * bucketSize,
        vol: 0,
    }));

    rows.forEach(r => {
        const range = r.high - r.low || 0.0001;
        const subSteps = 10;
        const dayVol = hasVolume ? r.volume : range * 1000;
        for (let s = 0; s < subSteps; s++) {
            const p = r.low + (range * (s + 0.5) / subSteps);
            const bIdx = clamp(Math.floor((p - overallLow) / bucketSize), 0, numBuckets - 1);
            buckets[bIdx].vol += dayVol / subSteps;
        }
    });

    const poc = buckets.reduce((max, b) => b.vol > (max?.vol || 0) ? b : max, null);
    const currentPrice = rows[rows.length - 1].close;

    return {
        key: instrument.key, label: instrument.label, group: instrument.group,
        buckets: buckets.slice().reverse(), poc, currentPrice, hasRealVolume: hasVolume,
        fetchedAt: new Date().toISOString(),
    };
}

export async function buildForexVolumeProfileWithFallback(instrument, days = 30) {
    try { return await buildForexVolumeProfileApprox(instrument, days); }
    catch (e) { return { key: instrument.key, label: instrument.label, group: instrument.group, error: e.message }; }
}
