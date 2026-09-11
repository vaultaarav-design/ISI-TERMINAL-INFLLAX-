/**
 * ISI Terminal v6 — CORS-SAFE FETCH HELPER
 * ══════════════════════════════════════════════════════════════
 * Some free/keyless data sources (Stooq's CSV endpoint, specifically)
 * don't send an Access-Control-Allow-Origin header. A direct browser
 * fetch() to them is blocked by the browser itself before any response
 * arrives — which surfaces as a generic "Failed to fetch" TypeError,
 * not an HTTP error status. That's a CORS problem, not a data problem.
 *
 * Free public CORS-proxy mirrors are themselves unreliable (they get
 * rate-limited or go down without notice), so this tries a chain of
 * FOUR independent ones, each with its own short timeout so one dead
 * proxy can't stall the whole chain, then finally tries a direct fetch
 * as a last resort.
 * ══════════════════════════════════════════════════════════════
 */
const CORS_PROXIES = [
    // codetabs — historically the most reliable of the free options
    { build: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, extract: (res) => res.text() },
    // allorigins "raw" — returns the body as-is
    { build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, extract: (res) => res.text() },
    // allorigins "get" — wraps the body in JSON, used as a second attempt against the same host
    { build: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, extract: async (res) => (await res.json()).contents },
    // corsproxy.io
    { build: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`, extract: (res) => res.text() },
];

const ATTEMPT_TIMEOUT_MS = 9000;

async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

export async function corsSafeFetchText(url) {
    const errors = [];
    for (const proxy of CORS_PROXIES) {
        try {
            const res = await fetchWithTimeout(proxy.build(url), ATTEMPT_TIMEOUT_MS);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await proxy.extract(res);
            if (text && text.trim().length > 0) return text;
            throw new Error('Empty response');
        } catch (e) {
            errors.push(e?.name === 'AbortError' ? 'timeout' : (e?.message || 'unknown error'));
        }
    }
    // Last resort — direct fetch (works if the source ever adds CORS headers).
    try {
        const res = await fetchWithTimeout(url, ATTEMPT_TIMEOUT_MS);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } catch (e) {
        errors.push(e?.name === 'AbortError' ? 'timeout' : (e?.message || 'unknown error'));
    }
    throw new Error(`All fetch routes failed — [${errors.join(' | ')}]`);
}
