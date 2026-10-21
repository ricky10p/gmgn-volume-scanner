// Regression tests for bugs found in review. Offline: no network, no Telegram.
import assert from "node:assert/strict";

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

// ---------- stub fetch: Meteora discovery + Telegram ----------
let tgCalls = [];
let failAtChunk = 0;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes("pool-discovery-api")) {
    // 6 pools: 2 besar, 4 kecil -> menguji filter minPoolTvl
    const data = [
      { pool_address: "A1", name: "T-SOL", pool_type: "dlmm", token_x: { address: "MINTX", symbol: "T" }, token_y: { address: "So111", symbol: "SOL" }, dlmm_params: { bin_step: 100 }, fee_pct: 1, tvl: 900000, volume: 50000 },
      { pool_address: "A2", name: "T-USDC", pool_type: "dlmm", token_x: { address: "MINTX", symbol: "T" }, token_y: { address: "EPjF", symbol: "USDC" }, dlmm_params: { bin_step: 50 }, fee_pct: 0.5, tvl: 400000, volume: 20000 },
      { pool_address: "A3", name: "T-SOL", pool_type: "dlmm", token_x: { address: "MINTX", symbol: "T" }, token_y: { address: "So111", symbol: "SOL" }, dlmm_params: { bin_step: 10 }, fee_pct: 0.1, tvl: 50, volume: 10 },
      { pool_address: "A4", name: "T-SOL", pool_type: "dlmm", token_x: { address: "MINTX", symbol: "T" }, token_y: { address: "So111", symbol: "SOL" }, dlmm_params: { bin_step: 10 }, fee_pct: 0.1, tvl: 20, volume: 5 },
      { pool_address: "A5", name: "T-SOL", pool_type: "dlmm", token_x: { address: "MINTX", symbol: "T" }, token_y: { address: "So111", symbol: "SOL" }, dlmm_params: { bin_step: 10 }, fee_pct: 0.1, tvl: 10, volume: 1 },
      { pool_address: "A6", name: "T-SOL", pool_type: "damm", token_x: { address: "MINTX", symbol: "T" }, token_y: { address: "So111", symbol: "SOL" }, dlmm_params: null, fee_pct: 0.3, tvl: 5, volume: 0 },
    ];
    return { ok: true, json: async () => ({ total: data.length, page_size: 500, data }) };
  }

  if (u.includes("sendMessage")) {
    const body = JSON.parse(opts.body);
    tgCalls.push(body);
    if (failAtChunk && tgCalls.length === failAtChunk) {
      return { status: 400, json: async () => ({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }) };
    }
    return { status: 200, json: async () => ({ ok: true, result: { message_id: 9000 + tgCalls.length } }) };
  }

  if (u.includes("deleteMessage")) {
    return { status: 200, json: async () => ({ ok: true, result: true }) };
  }

  throw new Error(`unexpected fetch: ${u}`);
};

const { buildAlert, escHtml, fmtUsd } = await import("../src/alert.js");
const { sendTelegramBlocks } = await import("../src/telegram.js");
const { clearCache } = await import("../src/meteora.js");

process.env.TELEGRAM_BOT_TOKEN = "test";
process.env.TELEGRAM_CHAT_ID = "1";

const token = (over = {}) => ({
  address: "MINTX",
  symbol: "TEST",
  market_cap: 500000,
  history_highest_market_cap: 600000,
  volume: 60000,
  gas_fee: 10,
  swaps: 10,
  buys: 5,
  sells: 5,
  holder_count: 100,
  ...over,
});

await test("escHtml menetralkan <, >, &", () => {
  assert.equal(escHtml("A<B&C>D"), "A&lt;B&amp;C&gt;D");
});

await test("fmtUsd menaruh tanda minus di depan $", () => {
  assert.equal(fmtUsd(-5000), "-$5.0K");
  assert.equal(fmtUsd(0), "$0.00");
  assert.equal(fmtUsd(null), "n/a");
});

await test("simbol aneh tidak merusak HTML (header aman)", async () => {
  const b = await buildAlert(token({ symbol: "A<B&C" }), {});
  const header = `🚨 ${escHtml(b.symbol)}`;
  assert.ok(!/[<>]/.test(header.replace(/&lt;|&gt;/g, "")), `header masih mengandung tag: ${header}`);
  assert.ok(header.includes("&lt;"), "harus di-escape");
});

await test("minPoolTvl: header melaporkan jumlah yang benar-benar ditampilkan", async () => {
  const b = await buildAlert(token(), { minPoolTvl: 100000 });
  const head = b.blocks.find((x) => x.startsWith("💧"));
  const listed = b.blocks.filter((x) => /^\d+\. /.test(x)).length;
  // 6 pool dlmm+1 damm, filter dlmm saja -> 5 dlmm; minPoolTvl 100k -> 2 lolos
  assert.equal(listed, 2, `harus 2 pool, dapat ${listed}`);
  assert.match(head, /2 of 5 pools/, `header salah: ${head}`);
});

await test("pool_type damm tidak ikut saat poolTypes=dlmm", async () => {
  const b = await buildAlert(token(), { poolTypes: ["dlmm"] });
  assert.equal(b.all.length, 5, `dapat ${b.all.length}, harus 5 (damm dikecualikan)`);
});

await test("requirePool mengembalikan null kalau tidak ada pool", async () => {
  clearCache();
  const saved = globalThis.fetch;
  globalThis.fetch = async (u) =>
    String(u).includes("pool-discovery-api")
      ? { ok: true, json: async () => ({ total: 0, data: [] }) }
      : saved(u);
  const b = await buildAlert(token(), { requirePool: true });
  globalThis.fetch = saved;
  clearCache();
  assert.equal(b, null);
});

await test("kegagalan di tengah kirim mencatat id yang sudah terkirim", async () => {
  tgCalls = [];
  failAtChunk = 3;
  const blocks = [];
  for (let i = 0; i < 30; i++) blocks.push(`pool ${i}\n` + "x".repeat(500));

  let err = null;
  try {
    await sendTelegramBlocks(blocks, { header: "hdr" });
  } catch (e) {
    err = e;
  }
  failAtChunk = 0;
  assert.ok(err, "harus throw");
  assert.deepEqual(err.sentIds, [9001, 9002], `sentIds salah: ${JSON.stringify(err.sentIds)}`);
  assert.ok(err.totalChunks >= 3, `totalChunks harus >=3, dapat ${err.totalChunks}`);
});

await test("pesan ke-1 sukses: id tercatat, tidak ada yang bocor", async () => {
  tgCalls = [];
  const ids = await sendTelegramBlocks(["a", "b"], { header: "hdr" });
  assert.equal(ids.length, 1);
  assert.equal(ids[0], 9001);
});

await test("re-send menggabungkan msgIds lama (tidak menimpa)", () => {
  // mensimulasikan logika merge di scan.js
  const sent = {};
  const send = (ids, now) => {
    const prev = sent.MINT?.msgIds || [];
    sent.MINT = { ts: now, msgIds: [...prev, ...ids.map((id) => ({ id, ts: now }))] };
  };
  send([101], 1000);
  send([202], 2000);
  assert.deepEqual(sent.MINT.msgIds.map((m) => m.id), [101, 202], "pesan lama harus tetap tercatat");
});

await test("normalisasi state lama msgIds:[123] -> [{id,ts}]", () => {
  const rec = { ts: 5000, msgIds: [123, 456] };
  rec.msgIds = rec.msgIds.map((m) => (typeof m === "object" ? m : { id: m, ts: rec.ts }));
  assert.deepEqual(rec.msgIds, [{ id: 123, ts: 5000 }, { id: 456, ts: 5000 }]);
});

await test("antrian pesan panjang dipecah di batas blok", async () => {
  tgCalls = [];
  const blocks = [];
  for (let i = 0; i < 12; i++) blocks.push("y".repeat(900));
  const ids = await sendTelegramBlocks(blocks, { header: "hdr" });
  assert.ok(ids.length >= 3, `harus >=3 pesan, dapat ${ids.length}`);
  for (const c of tgCalls) assert.ok(c.text.length <= 4096, `pesan ${c.text.length} char melebihi batas`);
});

console.log(`\n${passed} test lulus`);
