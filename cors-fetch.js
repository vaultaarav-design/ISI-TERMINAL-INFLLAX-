/**
 * ISI Terminal v6 — CORS-SAFE FETCH HELPER
 * ══════════════════════════════════════════════════════════════
 * Some free/keyless data sources (Stooq's CSV endpoint, specifically)
 * don't send an Access-Control-Allow-Origin header. A direct browser
 * fetch() to them is blocked by the browser itself before any response
 * arrives — which surfaces as a generic "Failed to fetch" TypeError,
 * not an HTTP error status. That's a CORS problem, not a data problem.
 *
 * This helper routes such requests through a couple of public CORS-
 * proxy mirrors (tried in order), then falls back to a direct fetch as
 * a last resort (in case the source ever adds proper CORS headers, or
 * the proxies are down and the browser/extension allows it anyway).
 * ══════════════════════════════════════════════════════════════
 */
const CORS_PROXIES = [
    (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

export async function corsSafeFetchText(url) {
    let lastErr;
    for (const buildProxyUrl of CORS_PROXIES) {
        try {
            const res = await fetch(buildProxyUrl(url));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            if (text && text.trim().length > 0) return text;
            throw new Error('Empty response');
        } catch (e) { lastErr = e; }
    }
    // Last resort — direct fetch (works if the source ever adds CORS headers).
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } catch (e) { lastErr = e; }
    throw new Error(`All fetch routes failed — ${lastErr?.message || 'unknown error'}`);
}
