// Channel 2 (sustained volume) tests — offline, no network, no Telegram.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// ---------- stub fetch ----------
let sends = [];
let poolCount = 1;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("pool-discovery-api")) {
    const data = Array.from({ length: poolCount }, (_, i) => ({
      pool_address: `P${i}`,
      pool_type: "dlmm",
      token_x: { address: "M1", symbol: "T" },
      token_y: { address: "So", symbol: "SOL" },
      dlmm_params: { bin_step: 100 },
      fee_pct: 1,
      tvl: 5000,
      volume: 100,
    }));
    return { ok: true, json: async () => ({ total: data.length, data }) };
  }
  if (u.includes("sendMessage")) {
    const body = JSON.parse(opts.body);
    sends.push(body);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 700 + sends.length } }) };
  }
  if (u.includes("deleteMessage")) return { ok: true, json: async () => ({ ok: true, result: true }) };
  throw new Error(`unexpected fetch ${u}`);
};

const { SustainedChannel } = await import("../src/channel2.js");
const { clearCache } = await import("../src/meteora.js");

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ch2-")), "sustained.json");

const mkCh = (stateFile, over = {}) =>
  new SustainedChannel({
    token: "T",
    chatId: "1",
    minVol: 50000,
    minFeeSol: 3,
    minMcapUsd: 100000,
    sustainMs: 3 * 60000,
    repeatMs: 5000,
    deleteAfterMs: 30000,
    staleMs: 60000,
    maxPerCycle: 10,
    stateFile,
    ...over,
  });

const tok = (over = {}) => [
  {
    address: "M1",
    symbol: "TEST",
    volume: 60000,
    gas_fee: 10,
    market_cap: 500000,
    swaps: 10,
    buys: 5,
    sells: 5,
    holder_count: 100,
    ...over,
  },
];

// ---------------------------------------------------------------- tests

await test("tidak kirim sebelum sustain tercapai", async () => {
  sends = [];
  clearCache();
  const ch = mkCh(tmpState());
  await ch.update(tok());
  await ch.update(tok());
  assert.equal(sends.length, 0, `harus 0, dapat ${sends.length}`);
});

await test("kirim setelah sustain tercapai, lalu repeat sesuai repeatMs", async () => {
  sends = [];
  clearCache();
  const ch = mkCh(tmpState(), { sustainMs: 0, repeatMs: 5000 });
  await ch.update(tok());
  assert.equal(sends.length, 1);
  await ch.update(tok()); // masih dalam window 5s
  assert.equal(sends.length, 1, "tidak boleh kirim dua kali dalam repeat window");
});

await test("state basi saat restart tidak langsung memicu kirim", async () => {
  sends = [];
  clearCache();
  const f = tmpState();
  // state dari proses lama: sudah "sustained" 2 jam
  fs.writeFileSync(
    f,
    JSON.stringify({ M1: { since: Date.now() - 2 * 3600 * 1000, symbol: "T", lastSent: 0, msgIds: [] } })
  );
  const ch = mkCh(f);
  await ch.update(tok());
  assert.equal(sends.length, 0, `streak basi harus di-reset, dapat ${sends.length} pesan`);
  assert.ok(ch.state.M1.since > Date.now() - 5000, "since harus di-reset ke sekarang");
});

await test("volume turun di bawah ambang -> streak reset", async () => {
  sends = [];
  clearCache();
  const ch = mkCh(tmpState(), { sustainMs: 0, repeatMs: 0 });
  await ch.update(tok());
  assert.equal(sends.length, 1);
  await ch.update(tok({ volume: 1000 })); // drop
  await ch.update(tok()); // naik lagi, streak baru
  assert.equal(sends.length, 2, "setelah drop harus mulai streak baru (langsung kirim karena sustainMs=0)");
  assert.ok(ch.state.M1.since >= Date.now() - 1000, "since harus baru");
});

await test("volume turun TIDAK membuang msgIds (pesan tetap bisa dihapus)", async () => {
  sends = [];
  clearCache();
  const f = tmpState();
  const ch = mkCh(f, { sustainMs: 0, repeatMs: 0 });
  await ch.update(tok());
  const id = ch.state.M1.msgIds[0].id;
  await ch.update(tok({ volume: 1000 }));
  assert.ok(ch.state.M1, "record tidak boleh dihapus selama masih ada pesan");
  assert.deepEqual(ch.state.M1.msgIds.map((m) => m.id), [id], "msgIds harus dipertahankan");
});

await test("token hilang dari rank list -> streak reset, msgIds tetap", async () => {
  sends = [];
  clearCache();
  const ch = mkCh(tmpState(), { sustainMs: 0, repeatMs: 0 });
  await ch.update(tok());
  const id = ch.state.M1.msgIds[0].id;
  await ch.update([]); // token tidak muncul lagi
  assert.equal(ch.state.M1.since, 0, "streak harus putus");
  assert.deepEqual(ch.state.M1.msgIds.map((m) => m.id), [id]);
});

await test("filter fee: fee < 3 SOL tidak dikirim walau streak panjang", async () => {
  sends = [];
  clearCache();
  const ch = mkCh(tmpState(), { sustainMs: 0, repeatMs: 0 });
  await ch.update(tok({ gas_fee: 1 }));
  assert.equal(sends.length, 0, "fee 1 SOL harus ditolak");
});

await test("filter mcap: < $100K tidak dikirim", async () => {
  sends = [];
  clearCache();
  const ch = mkCh(tmpState(), { sustainMs: 0, repeatMs: 0 });
  await ch.update(tok({ market_cap: 50000 }));
  assert.equal(sends.length, 0, "mcap 50K harus ditolak");
});

await test("token tanpa pool DLMM tidak dikirim", async () => {
  sends = [];
  clearCache();
  poolCount = 0;
  const ch = mkCh(tmpState(), { sustainMs: 0, repeatMs: 0 });
  await ch.update(tok());
  poolCount = 1;
  assert.equal(sends.length, 0, "tanpa pool harus dilewati");
});

await test("sweep menghapus pesan setelah deleteAfterMs", async () => {
  sends = [];
  clearCache();
  const ch = mkCh(tmpState(), { sustainMs: 0, repeatMs: 0, deleteAfterMs: 0 });
  await ch.update(tok());
  assert.equal(ch.state.M1.msgIds.length, 1);
  const deleted = await ch.sweep();
  assert.equal(deleted, 1, "harus 1 pesan terhapus");
  assert.equal(ch.state.M1.msgIds.length, 0);
});

await test("maxPerCycle membatasi jumlah kirim per siklus", async () => {
  sends = [];
  clearCache();
  const ch = mkCh(tmpState(), { sustainMs: 0, repeatMs: 0, maxPerCycle: 2 });
  const many = [];
  for (let i = 0; i < 5; i++) {
    many.push({ address: `M${i}`, symbol: `T${i}`, volume: 90000, gas_fee: 10, market_cap: 900000, swaps: 1, buys: 1, sells: 0, holder_count: 10 });
  }
  const res = await ch.update(many);
  assert.equal(sends.length, 2, `harus 2, dapat ${sends.length}`);
  assert.equal(res.throttled, 3);
});

await test("legacy msgIds:[123] dinormalisasi saat load", async () => {
  sends = [];
  const f = tmpState();
  fs.writeFileSync(f, JSON.stringify({ M1: { since: 0, symbol: "T", lastSent: 0, msgIds: [123, 456] } }));
  const ch = mkCh(f);
  assert.deepEqual(ch.state.M1.msgIds.map((m) => m.id), [123, 456]);
  assert.ok(ch.state.M1.msgIds.every((m) => Number.isFinite(m.ts)), "ts harus diisi");
});

console.log(`\n${passed} test lulus`);
