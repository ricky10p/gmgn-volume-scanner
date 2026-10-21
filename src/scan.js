#!/usr/bin/env node
/**
 * GMGN + Meteora scanner.
 *
 * Sorts the GMGN 1m volume rank descending, keeps tokens with
 *   1m volume >= MIN_VOL_USD  AND  cumulative GMGN fee >= MIN_FEE_SOL,
 * enriches each hit with its Meteora SOL DLMM pools and emits one alert per token.
 */
import fs from "node:fs";
import path from "node:path";
import { GmgnPublic, GmgnOpenApi, PERIODS } from "./gmgn.js";
import { buildAlert, fmtUsd } from "./alert.js";
import { telegramConfigured, sendTelegramBlocks, deleteTelegramMessage } from "./telegram.js";
import { SustainedChannel } from "./channel2.js";

// minimal .env loader (no dependency); real env vars win
const envFile = path.resolve(".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

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
const num = (v) => (typeof v === "number" ? v : Number(v) || 0);

const CFG = {
  mode: env.GMGN_MODE || (env.GMGN_API_KEY ? "openapi" : "public"),
  chain: args.chain || env.GMGN_CHAIN || "sol",
  period: args.period || env.GMGN_PERIOD || "1m",
  limit: Number(args.limit || env.GMGN_LIMIT || 100),
  pollMs: Number(args.poll || env.GMGN_POLL_MS || 5000),
  minVolUsd: Number(args["min-vol"] || env.GMGN_MIN_VOL_USD || 20000),
  minFeeSol: Number(args["min-fee"] || env.GMGN_MIN_FEE_SOL || 3),
  minMcapUsd: Number(args["min-mcap"] ?? env.GMGN_MIN_MCAP_USD ?? 100000),
  cooldownMs: Number(args.cooldown || env.GMGN_COOLDOWN_MIN || 5) * 60000,
  // 0 = never delete. Telegram lets a bot delete its own messages for 48h.
  deleteAfterMs: Number(args["delete-after"] ?? env.GMGN_DELETE_AFTER_MIN ?? 0) * 60000,
  // default ON: a token without a Meteora DLMM pool is never notified
  requirePool: args["require-pool"] !== undefined ? Boolean(args["require-pool"]) : env.GMGN_REQUIRE_POOL !== "0",
  maxPools: args["max-pools"] ? Number(args["max-pools"]) : env.GMGN_MAX_POOLS ? Number(env.GMGN_MAX_POOLS) : Infinity,
  minPoolTvl: Number(args["min-pool-tvl"] || env.GMGN_MIN_POOL_TVL || 0),
  poolTypes: (args["pool-types"] || env.GMGN_POOL_TYPES || "dlmm").split(",").map((s) => s.trim()).filter(Boolean),
  once: Boolean(args.once),
  dryRun: Boolean(args["dry-run"]) || env.GMGN_DRY_RUN === "1",
  send: !args["no-send"] && telegramConfigured(),
  outDir: args.out || env.GMGN_OUT_DIR || path.resolve("data"),
  cookie: env.GMGN_COOKIE || null,
  apiKey: env.GMGN_API_KEY || null,
  clientId: env.GMGN_CLIENT_ID || null,
  lang: env.GMGN_LANG || "id",
  timezone: env.GMGN_TZ || null,
  pathStyle: args.path || env.GMGN_PATH || "api",
  publicBase: env.GMGN_PUBLIC_BASE || "https://gmgn.ai",
  openApiBase: env.GMGN_OPENAPI_BASE || "https://openapi.gmgn.ai",
};

// ---- second channel: sustained 1m volume, repeat every N s, delete after M s ----
const CH2 = {
  token: env.TG2_BOT_TOKEN || null,
  chatId: env.TG2_CHAT_ID || null,
  minVol: Number(args["ch2-min-vol"] ?? env.TG2_MIN_VOL_USD ?? 50000),
  sustainMs: Number(args["ch2-sustain"] ?? env.TG2_SUSTAIN_MIN ?? 3) * 60000,
  repeatMs: Number(args["ch2-repeat"] ?? env.TG2_REPEAT_SEC ?? 5) * 1000,
  deleteAfterMs: Number(args["ch2-delete"] ?? env.TG2_DELETE_AFTER_SEC ?? 30) * 1000,
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
const alertPath = path.join(CFG.outDir, `alerts-${CFG.chain}-${day}.log`);
const sentPath = path.join(CFG.outDir, "sent.json");

const ch2 = new SustainedChannel({
  token: CH2.token,
  chatId: CH2.chatId,
  minVol: CH2.minVol,
  minFeeSol: CFG.minFeeSol,
  minMcapUsd: CFG.minMcapUsd,
  sustainMs: CH2.sustainMs,
  repeatMs: CH2.repeatMs,
  deleteAfterMs: CH2.deleteAfterMs,
  requirePool: CFG.requirePool,
  poolTypes: CFG.poolTypes,
  stateFile: path.join(CFG.outDir, "sustained.json"),
  dryRun: CFG.dryRun,
});

const clock = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function loadSent() {
  try {
    return JSON.parse(fs.readFileSync(sentPath, "utf8"));
  } catch {
    return {};
  }
}
function saveSent(map) {
  // keep entries long enough to cover both cooldown and the delete window
  const keepMs = Math.max(7 * 24 * 3600 * 1000, CFG.deleteAfterMs * 2);
  const cutoff = Date.now() - keepMs;
  for (const [k, v] of Object.entries(map)) if (v.ts < cutoff && !v.msgIds?.length) delete map[k];
  fs.writeFileSync(sentPath, JSON.stringify(map));
}

const sent = loadSent();
// display-only de-dupe for --dry-run / --no-send (never persisted, never affects real cooldown)
const printed = new Map();

/**
 * Delete bot messages whose retention window has passed.
 * Runs every scan cycle; each message id is attempted once per cycle until it is gone.
 */
async function sweepDeletions() {
  if (!CFG.deleteAfterMs || !CFG.send || CFG.dryRun) return 0;

  const now = Date.now();
  let deleted = 0;

  for (const [mint, rec] of Object.entries(sent)) {
    if (!rec.msgIds?.length) continue;
    if (now - rec.ts < CFG.deleteAfterMs) continue;

    const remaining = [];
    for (const id of rec.msgIds) {
      const r = await deleteTelegramMessage(id, {});
      if (r === "deleted" || r === "already-gone") {
        deleted++;
      } else if (r === "too-old" || r === "forbidden") {
        // unrecoverable — drop it so we stop retrying
        console.error(`[${clock()}] delete msg ${id} (${rec.symbol}): ${r}`);
      } else {
        remaining.push(id);
        console.error(`[${clock()}] delete msg ${id} (${rec.symbol}) failed, will retry: ${r}`);
      }
    }
    rec.msgIds = remaining;
    if (!remaining.length) rec.deletedAt = now;
  }

  if (deleted) {
    console.log(`[${clock()}] retention: deleted ${deleted} message(s) older than ${CFG.deleteAfterMs / 60000}m`);
    saveSent(sent);
  }
  return deleted;
}

async function scan() {
  await sweepDeletions();
  await ch2.sweep();

  const raw = await client.rank({
    chain: CFG.chain,
    interval: CFG.period,
    orderby: "volume",
    direction: "desc",
    limit: CFG.limit,
  });

  // largest 1m volume first
  const sorted = [...raw].sort((a, b) => num(b.volume) - num(a.volume));

  // second channel works on the same snapshot, before the main filters
  if (ch2.enabled) await ch2.update(sorted);

  const hits = sorted.filter(
    (t) =>
      num(t.volume) >= CFG.minVolUsd &&
      num(t.gas_fee) >= CFG.minFeeSol &&
      num(t.market_cap) >= CFG.minMcapUsd
  );

  const now = Date.now();
  const fresh = hits.filter((t) => {
    const s = sent[t.address];
    return !s || now - s.ts > CFG.cooldownMs;
  });

  console.log(
    `[${clock()}] scan ${CFG.chain}/${CFG.period} | ${sorted.length} tokens | ${hits.length} pass filter ` +
      `(vol>=${fmtUsd(CFG.minVolUsd)}, fee>=${CFG.minFeeSol} SOL, mcap>=${fmtUsd(CFG.minMcapUsd)}) | ${fresh.length} to check`
  );

  const delivered = [];
  let noPool = 0;
  let quiet = 0;

  for (const t of fresh) {
    const built = await buildAlert(t, {
      maxPools: CFG.maxPools,
      requirePool: CFG.requirePool,
      minPoolTvl: CFG.minPoolTvl,
      poolTypes: CFG.poolTypes,
    });

    // no Meteora DLMM pool -> skip entirely: no notification, no cooldown, re-checked next poll
    if (!built) {
      noPool++;
      continue;
    }

    // dry-run / telegram disabled: print at most once per cooldown window, never persist
    if (!CFG.send || CFG.dryRun) {
      const last = printed.get(t.address) || 0;
      if (now - last < CFG.cooldownMs) {
        quiet++;
        continue;
      }
      printed.set(t.address, now);
      console.log("\n" + built.text + "\n" + "-".repeat(60));
      fs.appendFileSync(alertPath, `[${clock()}] ${t.symbol} ${t.address}\n${built.text}\n\n`);
      continue;
    }

    console.log("\n" + built.text + "\n" + "-".repeat(60));
    fs.appendFileSync(alertPath, `[${clock()}] ${t.symbol} ${t.address}\n${built.text}\n\n`);

    try {
      const ids = await sendTelegramBlocks(built.blocks, {
        header: `🚨 ${built.symbol}`,
      });
      // cooldown starts only after Telegram accepted the message
      sent[t.address] = {
        ts: now,
        symbol: t.symbol,
        volume: num(t.volume),
        msgId: ids[0],
        msgIds: ids,
        msgs: ids.length,
      };
      delivered.push(t.address);
      console.log(`sent -> telegram ${ids.length} message(s), first id ${ids[0]}`);
    } catch (e) {
      console.error(`telegram failed for ${t.symbol} (no cooldown applied, will retry): ${e.message}`);
    }
  }

  saveSent(sent);
  if (noPool) console.log(`[${clock()}] ${noPool} token(s) skipped — no Meteora DLMM pool (not cooled down)`);
  if (quiet) console.log(`[${clock()}] ${quiet} token(s) already shown in this window`);
  return { hits: hits.length, fresh: fresh.length, delivered: delivered.length, noPool };
}

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  console.log("\nstopped.");
  process.exit(0);
});

(async () => {
  if (CFG.once) {
    try {
      await scan();
    } catch (e) {
      console.error(`[${clock()}] scan failed: ${e.message}`);
      process.exitCode = 2;
    }
    return;
  }

  console.log(
    `scanner up | ${CFG.chain}/${CFG.period} | vol>=${fmtUsd(CFG.minVolUsd)} | fee>=${CFG.minFeeSol} SOL | ` +
      `mcap>=${fmtUsd(CFG.minMcapUsd)} | ` +
      `poll ${CFG.pollMs / 1000}s | cooldown ${CFG.cooldownMs / 60000}m | ` +
      `pools=${CFG.maxPools === Infinity ? "all" : CFG.maxPools} | ` +
      `requirePool=${CFG.requirePool ? "yes" : "no"} | ` +
      `deleteAfter=${CFG.deleteAfterMs ? CFG.deleteAfterMs / 60000 + "m" : "never"} | ` +
      `telegram=${CFG.send ? "on" : "off"}`
  );
  console.log(
    ch2.enabled
      ? `ch2 up | @volumebasah | vol>=${fmtUsd(CH2.minVol)} for ${CH2.sustainMs / 60000}m | ` +
          `fee>=${CFG.minFeeSol} SOL | mcap>=${fmtUsd(CFG.minMcapUsd)} | ` +
          `repeat ${CH2.repeatMs / 1000}s | delete after ${CH2.deleteAfterMs / 1000}s`
      : `ch2 off | set TG2_BOT_TOKEN + TG2_CHAT_ID to enable the sustained-volume channel`
  );

  let backoff = 0;
  while (!stopping) {
    const t0 = Date.now();
    try {
      await scan();
      backoff = 0;
    } catch (e) {
      backoff = Math.min(backoff + 1, 6);
      console.error(`[${clock()}] scan failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, backoff * 3000));
      continue;
    }
    // keep a true N-second cadence: subtract the time the scan itself took
    const wait = Math.max(CFG.pollMs - (Date.now() - t0), 250);
    await new Promise((r) => setTimeout(r, wait));
  }
})();
