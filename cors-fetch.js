/**
 * ISI Terminal v6 — CORS-SAFE FETCH HELPER
 * ══════════════════════════════════════════════════════════════
 * Some free/keyless data sources (Stooq's CSV endpoint, specifically)
 * don't send an Access-Control-Allow-Origin header. A direct browser
 * fetch() to them is blocked by the browser itself before any response
 * arrives — which surfaces as a generic "Failed to fetch" TypeError,
 * not an HTTP error status. That's a CORS problem, not a data problem.
 *
 * Free public CORS-proxy mirrors are individually unreliable (rate
 * limits, downtime, policy changes — corsproxy.io started returning
 * 401 for anonymous use, for example). Trying them ONE AT A TIME is
 * slow AND fragile: if the first pick is having a bad day, everything
 * behind it pays the full timeout before its turn even comes.
 *
 * So instead this fires ALL proxies (plus a direct attempt) AT THE
 * SAME TIME and takes whichever one answers first. One flaky proxy no
 * longer blocks or slows down the others.
 * ══════════════════════════════════════════════════════════════
 */
const CORS_PROXIES = [
    { build: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, extract: (res) => res.text() },
    { build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, extract: (res) => res.text() },
    { build: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, extract: async (res) => (await res.json()).contents },
    { build: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`, extract: (res) => res.text() },
    { build: (url) => `https://thingproxy.freeboard.io/fetch/${url}`, extract: (res) => res.text() },
    { build: (url) => `https://cors.eu.org/${url}`, extract: (res) => res.text() },
];

const ATTEMPT_TIMEOUT_MS = 12000;

async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function tryOne(url, label) {
    const res = await fetchWithTimeout(url, ATTEMPT_TIMEOUT_MS);
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
    return res;
}

export async function corsSafeFetchText(url) {
    const attempts = CORS_PROXIES.map((proxy, i) =>
        tryOne(proxy.build(url), `proxy${i + 1}`)
            .then(async (res) => {
                const text = await proxy.extract(res);
                if (!text || !text.trim()) throw new Error(`proxy${i + 1}: empty response`);
                return text;
            })
    );
    // Also race a direct fetch, in case the source ever adds CORS headers.
    attempts.push(
        tryOne(url, 'direct').then(async (res) => {
            const text = await res.text();
            if (!text || !text.trim()) throw new Error('direct: empty response');
            return text;
        })
    );

    try {
        return await Promise.any(attempts);
    } catch (aggErr) {
        const reasons = (aggErr.errors || []).map((e) => e?.message || 'unknown error');
        throw new Error(`All fetch routes failed — [${reasons.join(' | ')}]`);
    }
}
