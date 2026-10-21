import fs from "node:fs";
import { buildAlert, escHtml, fmtUsd } from "./alert.js";
import { sendTelegramBlocks, deleteTelegramMessage } from "./telegram.js";

const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
const clock = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/**
 * Second Telegram channel.
 *
 * Fires every `repeatMs` while a token's 1m volume has stayed *continuously* above
 * `minVol` for `sustainMs`, applies the same fee / market-cap filters as channel 1,
 * renders the same full pool message, and deletes each message after `deleteAfterMs`.
 *
 * Streak rules (the important part):
 *   - `since` is the first poll of the current streak; it is reset to 0 the moment
 *     volume drops below `minVol`, the token disappears from the rank list, or the
 *     persisted state is older than `staleMs` (i.e. the process was down).
 *   - a reset never throws away `msgIds` — those messages still have to be deleted.
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
    staleMs = 60000,
    maxPerCycle = 10,
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
    this.staleMs = staleMs;
    this.maxPerCycle = maxPerCycle;
    this.stateFile = stateFile;
    this.dryRun = dryRun;
    this.state = this.#load();
  }

  get enabled() {
    return Boolean(this.token && this.chatId);
  }

  #load() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      return {};
    }

    const now = Date.now();
    let resetCount = 0;

    for (const [mint, rec] of Object.entries(raw)) {
      if (!rec || typeof rec !== "object") {
        delete raw[mint];
        continue;
      }
      // normalise legacy msgIds: [123] -> [{id, ts}]
      if (Array.isArray(rec.msgIds)) {
        rec.msgIds = rec.msgIds
          .map((m) => (typeof m === "object" && m !== null ? m : { id: m, ts: rec.since || now }))
          .filter((m) => Number.isFinite(m.id));
      } else {
        rec.msgIds = [];
      }

      // A streak can only be trusted if we were actually watching the token.
      // After a restart (or a long gap) the persisted `since` is meaningless,
      // so the token must earn its 3 minutes again.
      const lastProof = rec.lastSeen || rec.since || 0;
      if (!lastProof || now - lastProof > this.staleMs) {
        rec.since = 0;
        rec.lastSent = 0;
        resetCount++;
      }
      if (!rec.msgIds.length && !rec.since) delete raw[mint];
    }

    if (resetCount) {
      console.log(`[${clock()}] ch2: ${resetCount} streak lama di-reset (state basi / proses sempat mati)`);
    }
    return raw;
  }

  #save() {
    try {
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.stateFile);
    } catch {
      /* non-fatal */
    }
  }

  /** Break the streak but keep msgIds so sweep() can still delete the messages. */
  #breakStreak(mint) {
    const rec = this.state[mint];
    if (!rec) return;
    rec.since = 0;
    rec.lastSent = 0;
    if (!rec.msgIds?.length) delete this.state[mint];
  }

  /** Delete messages whose retention window has passed. */
  async sweep() {
    if (!this.enabled || this.dryRun) return 0;
    const now = Date.now();
    let deleted = 0;
    let dirty = false;

    for (const [mint, rec] of Object.entries(this.state)) {
      if (!rec.msgIds?.length) continue;
      const keep = [];
      for (const m of rec.msgIds) {
        if (now - m.ts < this.deleteAfterMs) {
          keep.push(m);
          continue;
        }
        const r = await deleteTelegramMessage(m.id, { token: this.token, chatId: this.chatId });
        if (r === "deleted" || r === "already-gone") {
          deleted++;
          dirty = true;
        } else if (r === "too-old" || r === "forbidden") {
          console.error(`[${clock()}] ch2 delete ${m.id}: ${r}`);
          dirty = true;
        } else {
          keep.push(m); // retry next cycle
        }
      }
      if (keep.length !== rec.msgIds.length) {
        rec.msgIds = keep;
        dirty = true;
      }
      // fully cleaned and no live streak -> drop the record
      if (!rec.msgIds.length && !rec.since) {
        delete this.state[mint];
        dirty = true;
      }
    }

    if (deleted) {
      console.log(
        `[${clock()}] ch2 retention: deleted ${deleted} message(s) older than ${this.deleteAfterMs / 1000}s`
      );
    }
    if (dirty) this.#save();
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
    let throttled = 0;

    for (const t of tokens) {
      const vol = num(t.volume);
      const mint = t.address;

      if (vol < this.minVol) {
        this.#breakStreak(mint); // streak broken, messages kept for cleanup
        continue;
      }
      seen.add(mint);

      let rec = this.state[mint];
      if (!rec) rec = this.state[mint] = { since: now, symbol: t.symbol, lastSent: 0, msgIds: [], lastSeen: now };
      rec.symbol = t.symbol || rec.symbol;
      rec.lastSeen = now;
      if (!rec.since) rec.since = now; // streak restarts after a break

      if (now - rec.since < this.sustainMs) continue; // not sustained long enough
      if (now - rec.lastSent < this.repeatMs) continue; // inside this repeat window

      // same filters as channel 1
      if (num(t.gas_fee) < this.minFeeSol) continue;
      if (num(t.market_cap) < this.minMcapUsd) continue;

      // safety valve: never flood one chat with more than N tokens per cycle
      if (fired >= this.maxPerCycle) {
        throttled++;
        continue;
      }

      const held = ((now - rec.since) / 60000).toFixed(1);

      // build once: this both resolves the pools and applies the pool requirement
      let built;
      try {
        built = await buildAlert(t, { poolTypes: this.poolTypes, requirePool: this.requirePool });
      } catch (e) {
        console.error(`[${clock()}] ch2 meteora lookup failed ${rec.symbol}: ${e.message}`);
        continue;
      }
      if (!built) continue; // no pool and requirePool is on

      if (this.dryRun) {
        console.log(`[ch2 dry-run] ${rec.symbol} vol ${fmtUsd(vol)} sustained ${held}m`);
        rec.lastSent = now;
        fired++;
        continue;
      }

      try {
        const ids = await sendTelegramBlocks(built.blocks, {
          token: this.token,
          chatId: this.chatId,
          header: `🚨 ${escHtml(built.symbol)} · ${held}m stable`,
        });
        rec.lastSent = now;
        for (const id of ids) rec.msgIds.push({ id, ts: now });
        fired++;
        console.log(
          `[${clock()}] ch2 sent ${rec.symbol} (${fmtUsd(vol)}, ${held}m sustained, ${ids.length} msg) ${ids[0]}`
        );
      } catch (e) {
        // partial delivery: keep the ids that made it out so sweep() can delete them
        if (e.sentIds?.length) {
          rec.lastSent = now;
          for (const id of e.sentIds) rec.msgIds.push({ id, ts: now });
        }
        console.error(
          `[${clock()}] ch2 send failed ${rec.symbol}` +
            (e.sentIds?.length ? ` after ${e.sentIds.length}/${e.totalChunks} msg` : "") +
            `: ${e.message}`
        );
      }
    }

    // tokens that vanished from the rank list: their streak is no longer provable
    for (const mint of Object.keys(this.state)) {
      if (!seen.has(mint)) this.#breakStreak(mint);
    }

    if (throttled) {
      console.log(`[${clock()}] ch2: ${throttled} token ditahan (batas ${this.maxPerCycle} per siklus)`);
    }

    this.#save();
    return { fired, tracking: seen.size, throttled };
  }
}
