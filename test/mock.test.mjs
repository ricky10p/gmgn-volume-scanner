import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let tick = 0;
const tokens = [
  { address: "So11111111111111111111111111111111111111112", symbol: "TESTA", base: 120000 },
  { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "TESTB", base: 90000 },
  { address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "TESTC", base: 40000 },
];

const server = http.createServer((req, res) => {
  tick++;
  const rank = tokens.map((t, i) => {
    const grow = i === 0 ? 1 + tick * 1.2 : 1 + tick * 0.05;
    const volume = t.base * grow;
    return {
      address: t.address,
      symbol: t.symbol,
      volume,
      swaps: 100 + tick * 10,
      price: 0.001 * tick,
      market_cap: 500000 + tick * 1000,
      liquidity: 50000,
      price_change_percent1h: 3.5,
      buys: 60,
      sells: 40,
    };
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 0, msg: "success", data: { rank } }));
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const outDir = path.join(root, "data", "test");
fs.rmSync(outDir, { recursive: true, force: true });

const child = spawn(process.execPath, [path.join(root, "src", "monitor.js"), "--poll", "600", "--top", "3", "--out", outDir], {
  env: {
    ...process.env,
    GMGN_MODE: "public",
    GMGN_PUBLIC_BASE: `http://127.0.0.1:${port}`,
    GMGN_ALERT_USD: "5000",
    GMGN_ALERT_PCT: "5",
    GMGN_PERIOD: "1h",
  },
});

let out = "";
child.stdout.on("data", (d) => (out += d.toString()));
child.stderr.on("data", (d) => (out += d.toString()));

await new Promise((r) => setTimeout(r, 3200));
child.kill("SIGKILL");
server.close();

const files = fs.readdirSync(outDir);
const jsonl = files.find((f) => f.endsWith(".jsonl"));
const lines = jsonl ? fs.readFileSync(path.join(outDir, jsonl), "utf8").trim().split("\n") : [];
const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
const topMover = last ? [...last.rows].sort((a, b) => b.vpm - a.vpm)[0] : null;

const checks = [
  ["poll cycles >= 3", lines.length >= 3, `got ${lines.length}`],
  ["delta volume computed", topMover && topMover.dv > 0, topMover ? `dv=${topMover.dv.toFixed(0)}` : "no row"],
  ["spike alert fired", /SPIKE TESTA/.test(out), out.includes("SPIKE") ? "yes" : "no"],
  ["table rendered", out.includes("SYMBOL") && out.includes("TESTA"), ""],
];

let ok = true;
for (const [name, pass, info] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${info ? " — " + info : ""}`);
  if (!pass) ok = false;
}

if (!ok) {
  console.log("\n---- monitor output ----\n" + out.slice(-3000));
  process.exit(1);
}
console.log("\nall checks passed");
