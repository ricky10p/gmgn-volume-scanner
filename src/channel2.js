import fs from "node:fs";
import { buildAlert, fmtUsd } from "./alert.js";
import { sendTelegramBlocks, deleteTelegramMessage } from "./telegram.js";

const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
const clock = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/**
 * Second Telegram channel.
 *
 * Fires every `repeatMs` while a token's 1m volume has stayed above `minVol` for
 * `sustainMs`, applies the same fee / market-cap filters as channel 1, renders the
 * same full pool message, and deletes each message after `deleteAfterMs`.
 */
export class SustainedChannel {
  constructor({
    token,
    chatId,
    minVol = 50000,
    minFeeSol = 3,
    minMcapUsd = 100000,
    sustainMs = 3 * 60000,
    repeatMs = 5000,
    deleteAfterMs = 30000,
    requirePool = true,
    poolTypes = ["dlmm"],
    stateFile,
    dryRun = false,
  } = {}) {
    this.token = token;
    this.chatId = chatId;
    this.minVol = minVol;
    this.minFeeSol = minFeeSol;
    this.minMcapUsd = minMcapUsd;
    this.sustainMs = sustainMs;
    this.repeatMs = repeatMs;
    this.deleteAfterMs = deleteAfterMs;
    this.requirePool = requirePool;
    this.poolTypes = poolTypes;
    this.stateFile = stateFile;
    this.dryRun = dryRun;
    this.state = this.#load();
  }

  get enabled() {
    return Boolean(this.token && this.chatId);
  }

  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      return {};
    }
  }

  #save() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state));
    } catch {
      /* non-fatal */
    }
  }

  /** Delete messages whose retention window has passed. */
  async sweep() {
    if (!this.enabled || this.dryRun) return 0;
    const now = Date.now();
    let deleted = 0;

    for (const rec of Object.values(this.state)) {
      if (!rec.msgIds?.length) continue;
      const keep = [];
      for (const m of rec.msgIds) {
        if (now - m.ts < this.deleteAfterMs) {
          keep.push(m);
          continue;
        }
        const r = await deleteTelegramMessage(m.id, { token: this.token, chatId: this.chatId });
        if (r === "deleted" || r === "already-gone") deleted++;
        else if (r === "too-old" || r === "forbidden") {
          console.error(`[${clock()}] ch2 delete ${m.id}: ${r}`);
        } else keep.push(m); // retry next cycle
      }
      rec.msgIds = keep;
    }

    if (deleted) {
      console.log(
        `[${clock()}] ch2 retention: deleted ${deleted} message(s) older than ${this.deleteAfterMs / 1000}s`
      );
      this.#save();
    }
    return deleted;
  }

  /**
   * Feed the full (already volume-sorted) token list.
   * The streak tracks volume only; fee/mcap are checked at send time so a temporary
   * dip in either does not throw away a genuinely sustained volume streak.
   */
  async update(tokens) {
    if (!this.enabled) return { fired: 0, tracking: 0 };
    const now = Date.now();
    const seen = new Set();
    let fired = 0;

    for (const t of tokens) {
      const vol = num(t.volume);
      const mint = t.address;

      if (vol < this.minVol) {
        if (this.state[mint]) delete this.state[mint]; // streak broken
        continue;
      }
      seen.add(mint);

      const rec = (this.state[mint] ||= { since: now, symbol: t.symbol, lastSent: 0, msgIds: [] });
      rec.symbol = t.symbol || rec.symbol;

      if (now - rec.since < this.sustainMs) continue; // not sustained long enough
      if (now - rec.lastSent < this.repeatMs) continue; // inside this repeat window

      // same filters as channel 1
      if (num(t.gas_fee) < this.minFeeSol) continue;
      if (num(t.market_cap) < this.minMcapUsd) continue;

      if (this.requirePool) {
        const { pools } = await import("./meteora.js").then((m) =>
          m.poolsForToken(mint, { types: this.poolTypes })
        );
        if (!pools.length) continue;
      }

      const held = ((now - rec.since) / 60000).toFixed(1);

      if (this.dryRun) {
        console.log(`[ch2 dry-run] ${rec.symbol} vol ${fmtUsd(vol)} sustained ${held}m`);
        rec.lastSent = now;
        fired++;
        continue;
      }

      try {
        const built = await buildAlert(t, { poolTypes: this.poolTypes, requirePool: this.requirePool });
        if (!built) continue;

        const ids = await sendTelegramBlocks(built.blocks, {
          token: this.token,
          chatId: this.chatId,
          header: `🚨 ${built.symbol} · ${held}m stable`,
        });
        rec.lastSent = now;
        for (const id of ids) rec.msgIds.push({ id, ts: now });
        fired++;
        console.log(
          `[${clock()}] ch2 sent ${rec.symbol} (${fmtUsd(vol)}, ${held}m sustained, ${ids.length} msg) ${ids[0]}`
        );
      } catch (e) {
        console.error(`[${clock()}] ch2 send failed ${rec.symbol}: ${e.message}`);
      }
    }

    // drop tokens that vanished from the list and have no live messages left
    for (const mint of Object.keys(this.state)) {
      if (!seen.has(mint) && !this.state[mint].msgIds?.length) delete this.state[mint];
    }

    this.#save();
    return { fired, tracking: seen.size };
  }
}
