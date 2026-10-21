#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { GmgnPublic, GmgnOpenApi, PERIODS } from "./gmgn.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const env = process.env;

const CFG = {
  mode: env.GMGN_MODE || (env.GMGN_API_KEY ? "openapi" : "public"),
  chain: args.chain || env.GMGN_CHAIN || "sol",
  period: args.period || env.GMGN_PERIOD || "1m",
  orderby: args.orderby || env.GMGN_ORDERBY || "volume",
  limit: Number(args.limit || env.GMGN_LIMIT || 100),
  pollMs: Number(args.poll || env.GMGN_POLL_MS || 30000),
  minVolume: Number(args["min-volume"] || env.GMGN_MIN_VOLUME || 0),
  alertPct: Number(args["alert-pct"] || env.GMGN_ALERT_PCT || 15),
  alertUsd: Number(args["alert-usd"] || env.GMGN_ALERT_USD || 5000),
  top: Number(args.top || env.GMGN_TOP || 10),
  once: Boolean(args.once),
  json: Boolean(args.json),
  watch: (args.watch || env.GMGN_WATCH || "").split(",").map((s) => s.trim()).filter(Boolean),
  outDir: args.out || env.GMGN_OUT_DIR || path.resolve("data"),
  proxy: env.GMGN_PROXY || null,
  cookie: env.GMGN_COOKIE || null,
  apiKey: env.GMGN_API_KEY || null,
  clientId: env.GMGN_CLIENT_ID || null,
  lang: env.GMGN_LANG || "id",
  timezone: env.GMGN_TZ || null,
  pathStyle: args.path || env.GMGN_PATH || "api",
  publicBase: env.GMGN_PUBLIC_BASE || "https://gmgn.ai",
  openApiBase: env.GMGN_OPENAPI_BASE || "https://openapi.gmgn.ai",
};

if (!PERIODS.includes(CFG.period)) {
  console.error(`period must be one of ${PERIODS.join(", ")}`);
  process.exit(1);
}

fs.mkdirSync(CFG.outDir, { recursive: true });

const client =
  CFG.mode === "openapi"
    ? new GmgnOpenApi({ apiKey: CFG.apiKey, clientId: CFG.clientId, base: CFG.openApiBase })
    : new GmgnPublic({
        cookie: CFG.cookie,
        base: CFG.publicBase,
        lang: CFG.lang,
        timezone: CFG.timezone,
        pathStyle: CFG.pathStyle,
        deviceFile: path.join(CFG.outDir, "device.json"),
      });
const day = new Date().toISOString().slice(0, 10);
const jsonlPath = path.join(CFG.outDir, `volume-${CFG.chain}-${day}.jsonl`);
const alertPath = path.join(CFG.outDir, `alerts-${CFG.chain}-${day}.log`);

const state = new Map();
const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
const usd = (v) =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`;
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const lpad = (s, n) => String(s).padStart(n).slice(-n);
const clock = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function pick(list) {
  if (!CFG.watch.length) return list;
  const set = new Set(CFG.watch);
  return list.filter((t) => set.has(t.address));
}

async function poll() {
  const raw = await client.rank({
    chain: CFG.chain,
    interval: CFG.period,
    orderby: CFG.orderby,
    direction: "desc",
    limit: CFG.limit,
  });
  const list = pick(raw).filter((t) => num(t.volume) >= CFG.minVolume);
  const now = Date.now();
  const rows = [];
  const alerts = [];

  for (const t of list) {
    const volume = num(t.volume);
    const swaps = num(t.swaps);
    const prev = state.get(t.address);
    let dv = 0;
    let ds = 0;
    let vpm = 0;
    let pct = 0;
    if (prev) {
      const dt = Math.max((now - prev.ts) / 1000, 1);
      dv = volume - prev.volume;
      ds = swaps - prev.swaps;
      vpm = (dv / dt) * 60;
      pct = prev.volume > 0 ? (dv / prev.volume) * 100 : 0;
    }
    state.set(t.address, { volume, swaps, ts: now, symbol: t.symbol });

    rows.push({
      address: t.address,
      symbol: t.symbol,
      volume,
      dv,
      ds,
      vpm,
      pct,
      swaps,
      price: num(t.price),
      mcap: num(t.market_cap),
      liq: num(t.liquidity),
      change1h: num(t.price_change_percent1h ?? t.price_change_percent),
      buys: num(t.buys),
      sells: num(t.sells),
    });

    if (prev && dv >= CFG.alertUsd && pct >= CFG.alertPct) {
      alerts.push({ ...rows[rows.length - 1] });
    }
  }

  const rec = { ts: now, period: CFG.period, count: rows.length, rows };
  fs.appendFileSync(jsonlPath, JSON.stringify(rec) + "\n");

  if (CFG.json) {
    console.log(JSON.stringify(rec));
  } else {
    const movers = [...rows].sort((a, b) => b.vpm - a.vpm).slice(0, CFG.top);
    console.log(`\n[${clock()}] ${CFG.chain.toUpperCase()} ${CFG.period} | ${rows.length} tokens | poll ${CFG.pollMs / 1000}s`);
    console.log(
      `${pad("#", 3)}${pad("SYMBOL", 12)}${lpad("VOL(" + CFG.period + ")", 12)}${lpad("ΔVOL", 11)}${lpad("Δ/MIN", 11)}${lpad("Δ%", 8)}${lpad("SWAPS", 8)}${lpad("MCAP", 10)}  ADDRESS`
    );
    movers.forEach((r, i) => {
      console.log(
        `${pad(i + 1, 3)}${pad(r.symbol || "?", 12)}${lpad(usd(r.volume), 12)}${lpad(usd(r.dv), 11)}${lpad(
          usd(r.vpm),
          11
        )}${lpad(r.pct.toFixed(1) + "%", 8)}${lpad(r.swaps, 8)}${lpad(usd(r.mcap), 10)}  ${r.address}`
      );
    });
    if (!rows.some((r) => r.dv !== 0)) console.log("(baseline poll — deltas appear on the next cycle)");
  }

  for (const a of alerts) {
    const line = `[${clock()}] SPIKE ${a.symbol} ${a.address} +${usd(a.dv)} (+${a.pct.toFixed(1)}%) in ${CFG.pollMs / 1000}s | ${usd(
      a.vpm
    )}/min | total ${usd(a.volume)}`;
    console.log("\x1b[33m" + line + "\x1b[0m");
    fs.appendFileSync(alertPath, line + "\n");
  }
  return rows.length;
}

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  console.log("\nstopped. history: " + jsonlPath);
  process.exit(0);
});

(async () => {
  if (CFG.once) {
    try {
      await poll();
    } catch (e) {
      console.error(`[${clock()}] poll failed: ${e.message}${e.body ? " | " + JSON.stringify(e.body).slice(0, 300) : ""}`);
      if (CFG.mode === "public" && (e.status === 403 || /challenge|non-JSON/i.test(e.message))) {
        console.error(
          "hint: public endpoint is behind Cloudflare — set GMGN_COOKIE (cf_clearance) or GMGN_PROXY, or use GMGN_MODE=openapi with GMGN_API_KEY"
        );
      }
      process.exitCode = 2;
    }
    return;
  }
  let backoff = 0;
  while (!stopping) {
    try {
      await poll();
      backoff = 0;
    } catch (e) {
      backoff = Math.min(backoff + 1, 6);
      console.error(`[${clock()}] poll failed: ${e.message}${e.body ? " | " + JSON.stringify(e.body).slice(0, 200) : ""}`);
      if (CFG.mode === "public" && (e.status === 403 || /challenge|non-JSON/i.test(e.message))) {
        console.error("hint: public endpoint is behind Cloudflare — set GMGN_COOKIE (cf_clearance) or GMGN_PROXY, or use GMGN_MODE=openapi with GMGN_API_KEY");
      }
      await new Promise((r) => setTimeout(r, backoff * 3000));
      continue;
    }
    await new Promise((r) => setTimeout(r, CFG.pollMs));
  }
})();
