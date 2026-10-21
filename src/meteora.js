const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

const DISCOVERY = "https://pool-discovery-api.datapi.meteora.ag";
export const WSOL = "So11111111111111111111111111111111111111112";

async function getJson(url, timeout = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: ctl.signal,
    });
    if (!r.ok) {
      const e = new Error(`meteora HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const cache = new Map();

/**
 * Every Meteora DLMM pool for `mint`, whatever the quote token
 * (SOL, USDC, USDT, mSOL, hSOL, another memecoin, ...).
 *
 * Meteora's discovery API stores the launched token on the token_x side, so
 * `filter_by=token_x=<mint>` returns the complete set — no quote filter here.
 *
 * Units: `tvl` and `volume` come back already denominated in USD (verified against
 * token amount x token price), so no conversion is applied.
 */
export async function poolsForToken(mint, { ttlMs = 60000, pageSize = 500, types = ["dlmm"] } = {}) {
  const key = `${mint}:${types.join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.value;

  const url = `${DISCOVERY}/pools?page_size=${pageSize}&page=1&category=all&filter_by=token_x%3D${mint}`;
  const disc = await getJson(url);

  const pools = (disc.data || [])
    .filter((p) => types.includes(p.pool_type))
    .map((p) => {
      const base = p.token_x?.address === mint ? p.token_x : p.token_y;
      const quote = p.token_x?.address === mint ? p.token_y : p.token_x;
      return {
        address: p.pool_address,
        name: p.name,
        poolType: p.pool_type,
        baseSymbol: base?.symbol ?? null,
        quoteSymbol: quote?.symbol ?? null,
        quoteMint: quote?.address ?? null,
        binStep: p.dlmm_params?.bin_step ?? null,
        baseFee: p.fee_pct ?? null,
        tvlUsd: p.tvl ?? 0,
        vol24Usd: p.volume ?? 0,
        fee24Usd: p.fee ?? 0,
        swaps24h: p.swap_count ?? 0,
        holders: p.base_token_holders ?? null,
        createdAt: p.pool_created_at ?? null,
        hasFarm: Boolean(p.has_farm),
      };
    })
    .sort((a, b) => b.tvlUsd - a.tvlUsd);

  const value = { pools, total: pools.length, totalAll: disc.total ?? pools.length };
  cache.set(key, { ts: Date.now(), value });
  return value;
}

export function clearCache() {
  cache.clear();
}
