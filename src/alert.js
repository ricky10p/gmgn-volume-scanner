import { poolsForToken } from "./meteora.js";

const nf = new Intl.NumberFormat("en-US");

/** Escape for Telegram parse_mode=HTML. Must be used on every dynamic string. */
export const escHtml = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const fmtUsd = (v) => {
  if (v == null || !Number.isFinite(v)) return "n/a";
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  if (a >= 1) return `${sign}$${Math.round(a)}`;
  return `${sign}$${a.toFixed(2)}`;
};

export const fmtSol = (v) =>
  v == null || !Number.isFinite(v) ? "n/a" : v >= 100 ? nf.format(Math.round(v)) : v.toFixed(2);

export const fmtNum = (v) => (v == null || !Number.isFinite(v) ? "n/a" : nf.format(Math.round(v)));

const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
const feePct = (v) => (v == null ? "?" : String(Number(v)));

/**
 * Builds one alert for a GMGN token row.
 *
 * Returns:
 *   text   — plain text for the log file
 *   blocks — Telegram HTML blocks (header, one per pool, footer). The caller packs
 *            them into messages so a pool entry is never split across two messages.
 *   pools  — the pools actually listed (after minPoolTvl)
 *   all    — every pool Meteora returned
 */
export async function buildAlert(
  token,
  { maxPools = Infinity, requirePool = false, minPoolTvl = 0, poolTypes = ["dlmm"] } = {}
) {
  const mint = token.address;
  const { pools: all } = await poolsForToken(mint, { types: poolTypes });

  const pools = minPoolTvl > 0 ? all.filter((p) => (p.tvlUsd ?? 0) >= minPoolTvl) : all;
  if (requirePool && all.length === 0) return null;

  const symbol = token.symbol || token.name || "?";
  const buys = num(token.buys);
  const sells = num(token.sells);
  const swaps = num(token.swaps) || buys + sells;
  const mc = fmtUsd(num(token.market_cap));
  const ath = fmtUsd(num(token.history_highest_market_cap));
  const vol = fmtUsd(num(token.volume));
  const fee = fmtSol(num(token.gas_fee));
  const holders = fmtNum(token.holder_count);
  const gmgnUrl = `https://gmgn.ai/sol/token/${mint}`;
  const typeLabel = poolTypes.includes("damm") ? "Meteora" : "Meteora DLMM";

  // ---------- plain text (log) ----------
  const t = [
    symbol,
    mint,
    `MC: ${mc} | ATH: ${ath}`,
    `1m Vol: ${vol} | Fee: ${fee} SOL`,
    `Tx: ${swaps} (${buys}/${sells}) | Holders: ${holders}`,
    "",
    all.length === 0 ? `No ${typeLabel} pool` : `${typeLabel} (${all.length} pools)`,
  ];
  pools.forEach((p, i) => {
    t.push(
      `${i + 1}. ${p.quoteSymbol} | bin ${p.binStep ?? "?"} / ${feePct(p.baseFee)}% | TVL ${fmtUsd(p.tvlUsd)} | Vol24 ${fmtUsd(p.vol24Usd)} | ${p.address}`
    );
  });
  const text = t.join("\n");

  // ---------- telegram HTML ----------
  const blocks = [];

  blocks.push(
    [
      `🟢 <b>${escHtml(symbol)}</b>`,
      `<code>${escHtml(mint)}</code>`,
      "",
      `💰 <b>MC</b> ${mc}  ·  <b>ATH</b> ${ath}`,
      `📈 <b>1m Vol</b> <b>${vol}</b>  ·  <b>Fee</b> ${fee} SOL`,
      `🔄 <b>Tx</b> ${swaps} <i>(${buys} / ${sells})</i>  ·  <b>Holders</b> ${holders}`,
    ].join("\n")
  );

  if (all.length === 0) {
    blocks.push(`⚪ <i>No ${typeLabel} pool</i>`);
  } else {
    const shown = maxPools === Infinity ? pools : pools.slice(0, maxPools);
    // report the count that is actually listed, not the unfiltered total
    const head =
      pools.length === all.length
        ? `${all.length} pool${all.length === 1 ? "" : "s"}`
        : `${pools.length} of ${all.length} pools`;
    blocks.push(`💧 <b>${typeLabel}</b> — ${head}`);

    shown.forEach((p, i) => {
      blocks.push(
        `${i + 1}. <a href="https://www.meteora.ag/dlmm/${p.address}">${escHtml(p.quoteSymbol || "?")}</a>` +
          `  ·  bin ${p.binStep ?? "?"} / ${feePct(p.baseFee)}%` +
          `\n     TVL ${fmtUsd(p.tvlUsd)}  ·  Vol24 ${fmtUsd(p.vol24Usd)}`
      );
    });

    const hidden = pools.length - shown.length;
    if (hidden > 0) blocks.push(`<i>+${hidden} more pools</i>`);
  }

  blocks.push(`🔗 <a href="${gmgnUrl}">Open on GMGN</a>`);

  return { text, blocks, pools, all, mint, symbol };
}
