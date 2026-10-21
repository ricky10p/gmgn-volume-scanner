# GMGN Solana volume monitor

Zero-dependency Node.js monitor for Solana token volume on GMGN.

## Working endpoints (no API key)

Both paths return **identical data** (same address order, same 97 fields) — they are the same handler,
only the route differs:

```
/api/v1/rank/{chain}/swaps/{interval}          # newer, used by the current web app
/defi/quotation/v1/rank/{chain}/swaps/{interval}   # older, still live
```

Query params (`?orderby=volume&direction=desc&limit=100&filters[]=not_honeypot`) are enough on either
path — the `device_id`/`fp_did`/`client_id`/`app_ver`/`tz_*` block is accepted but not required.
`--path defi` or `--path api` picks the route.

```
GET https://gmgn.ai/api/v1/rank/{chain}/swaps/{interval}
    ?device_id=<uuid>&fp_did=<hex32>&client_id=gmgn_web_20260424-12795-39b9a56
    &from_app=gmgn&app_ver=20260424-12795-39b9a56
    &tz_name=Asia/Jakarta&tz_offset=25200&app_lang=id&os=web&worker=0
    &orderby=volume&direction=desc&limit=100
    &filters[]=renounced&filters[]=frozen&min_gas_fee=3
```

`interval` = `1m | 5m | 1h | 6h | 24h`. Response: `{code, reason, message, data:{rank:[...]}}`.

### Why plain `fetch`/`curl` gets 403

The edge rejects HTTP/1.1 clients with a non-Chrome TLS ClientHello. Two things must match:

1. **HTTP/2** (ALPN `h2`) — HTTP/1.1 is blocked outright.
2. **Chrome cipher order** — `TLS_AES_128_GCM_SHA256` first, then ECDHE-ECDSA/RSA GCM, CHACHA20, CBC.

`src/h2.js` does exactly that with Node's `http2.connect` + `ciphers` + `ecdhCurve`, so no proxy,
no `cf_clearance` cookie and no API key are needed. Verified live: HTTP 200 from a datacenter IP.

Do **not** add `sigalgs` — Node's OpenSSL rejects the Chrome string with
`error:00000000:lib(0)::reason(0)`.

The older path `/defi/quotation/v1/rank/...` is **not** dead — it answers 200 with byte-identical
structure once the same h2/Chrome fingerprint is used. Only HTTP/1.1 is blocked, on both paths.

## Alert scanner (GMGN + Meteora)

### Cara menjalankan (paling gampang)

```bash
cd ~/gmgn-volume-monitor
./run.sh start      # jalankan di background
./run.sh status     # cek hidup + config + siklus terakhir
./run.sh logs       # ikuti log realtime (Ctrl+C keluar)
./run.sh stop       # hentikan
./run.sh restart    # stop + start (setelah ubah .env)
```

Perintah lain:

```bash
./run.sh test       # unit test offline (mock server)
./run.sh dry        # satu siklus, cetak saja, tidak kirim ke Telegram
./run.sh once       # satu siklus, kirim ke Telegram kalau lolos filter
```

Kalau tidak mau pakai `run.sh`, jalankan langsung:

```bash
node src/scan.js --once --dry-run     # print alerts, send nothing
node src/scan.js                      # continuous, sends to Telegram if configured
```

Logic, in this order:

1. pull the `1m` volume rank (`orderby=volume&direction=desc&limit=100`) every **5 s**
2. **sort descending by 1m volume**
3. keep only `1m volume >= 20000` **and** `gas_fee >= 3 SOL` **and** `market_cap >= $100,000`
4. resolve **every** Meteora DLMM pool for that mint — any quote token (SOL, USDC, USDT, JupUSD,
   mSOL, hSOL, or another memecoin), not just SOL pairs. `tvl` and `volume` come back already in USD.
5. **a token with no DLMM pool is dropped** — no notification, and it is *not* cooled down, so it is
   re-checked on the next poll (it may get a pool later)
6. sort pools by TVL desc and list **all of them** (no cap), split across as many Telegram messages
   as needed — 342 pools becomes 15 messages, and a pool entry is never cut in half
7. **cooldown (5 min per mint) starts only after Telegram accepted the message.** A failed send or a
   skipped token leaves no cooldown behind.

Sample output (verified live):

```
🟢 LASTAGENCY
Eb2i5vHczEoXzt3uDkMGcscLZX6qii4yySJqcGCRpump

💰 MC $589.5K  ·  ATH $653.0K
📈 1m Vol $64.8K  ·  Fee 13.88 SOL
🔄 Tx 324 (154 / 170)  ·  Holders 1,884

💧 Meteora DLMM — 2 pools

1. SOL  ·  bin 100 / 0.8%
     TVL $10  ·  Vol24 $32.1K

2. SOL  ·  bin 100 / 1%
     TVL $0.00  ·  Vol24 $9.8K

🔗 Open on GMGN
```

In Telegram: the symbol is bold, the mint is a tappable `<code>` block (copy with one tap), each pool's
quote token is a link to its Meteora page, and `Open on GMGN` is a link — no raw URLs eating space.

### Channel 2 — sustained volume (@volumebasah_bot)

A second, independent channel with opposite behaviour: no cooldown, high repeat rate.

```
TG2_BOT_TOKEN=...
TG2_CHAT_ID=...
TG2_MIN_VOL_USD=50000        # 1m volume threshold
TG2_SUSTAIN_MIN=3            # must stay above it this long
TG2_REPEAT_SEC=5             # then re-send this often
TG2_DELETE_AFTER_SEC=30      # and delete each message after this
```

Behaviour:
- a mint starts a streak the first poll its `1m volume >= 50000`; the streak resets to zero the moment
  volume dips below, so it only fires on genuinely sustained activity
- once the streak passes 3 minutes, one message per token per 5 s, for as long as the streak holds
- **same fee (>= 3 SOL) and market-cap (>= $100k) filters as channel 1**, checked at send time so a
  brief dip in either does not throw away a genuinely sustained volume streak
- no cooldown
- the DLMM-pool requirement still applies (a token with no pool is skipped)
- **same full message as channel 1** — every DLMM pool, split across messages when needed
- each message is deleted 30 s after sending, so at most ~6 alerts per token are ever on screen

Both channels share one GMGN poll (no extra request load) and run in the same process.

### Field mapping

| Alert line | Source |
|---|---|
| MC | `market_cap` |
| ATH | `history_highest_market_cap` |
| 1m Vol | `volume` (of the `1m` bucket) |
| GMGN Fee | `gas_fee` — cumulative fee in SOL |
| Tx | `swaps` (`buys`/`sells`) |
| Holders | `holder_count` |
| Bin Step / Base Fee | `pool_config.bin_step` / `pool_config.base_fee_pct` |
| TVL / Vol24h | `tvl` and `volume["24h"]` × `token_y.price` |

### Telegram delivery

Set both and the scanner posts each alert as an HTML message:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Rendering rules:
- the mint address is wrapped in `<code>` → **tap to copy** in every Telegram client
- `Open Pool` / `GMGN Link` are clickable anchors
- messages longer than 4096 chars are split at pool boundaries, each part prefixed `🚨 SYMBOL (n/total)`

### Auto-delete

`GMGN_DELETE_AFTER_MIN=5` deletes each alert 5 minutes after it was sent (`0` = keep forever), so the
chat always shows only the last few minutes.

- message ids are stored in `data/sent.json` as `msgIds`, then swept at the start of every scan cycle
- deletion uses `deleteMessage`; the bot may only remove **its own** messages
- Telegram caps bot deletions at **48 h** — a longer retention silently fails, so keep the value under that
- a deleted entry keeps its timestamp (so cooldown still applies) but drops its ids and records `deletedAt`
- `already-gone` (message deleted by hand) and `too-old` are treated as done, never retried

Without the env vars it prints to stdout and appends to `data/alerts-sol-<date>.log`.

## Meteora API (no key)

```
GET https://pool-discovery-api.datapi.meteora.ag/pools?page_size=500&page=1&category=all&filter_by=token_x=<mint>
```

One call returns every pool for the mint, all quote tokens included, with `tvl` and `volume` already
in USD, plus `dlmm_params.bin_step` and `fee_pct` — no per-pool detail call needed.

- `filter_by=token_x=<mint>` is the working filter (`token_address`, `mint`, `base_mint` are rejected
  with 400). Meteora always stores the launched token on the `token_x` side, so `token_y=<mint>` returns
  0 — one query covers both directions.
- `page_size=500` returns the whole set (a token can have 300+ pools).
- `pool_type` is `dlmm` or `damm` — filter by it; `--pool-types dlmm,damm` widens the scan.
- Old host `dlmm-api.meteora.ag` is dead (404 everywhere).

## Usage

```bash
# one snapshot (1m volume bucket)
node src/monitor.js --once

# continuous: 1h bucket, poll every 30s, top 15 movers
node src/monitor.js --period 1h --poll 30000 --top 15

# track specific mints only
node src/monitor.js --watch <mint1>,<mint2>

# JSON lines (also appended to data/volume-sol-<date>.jsonl)
node src/monitor.js --json
```

Columns: `VOL(period)` volume inside the bucket, `ΔVOL` gained since previous poll, `Δ/MIN` rate,
`Δ%` growth vs previous snapshot, `SWAPS`, `MCAP`.

A spike is printed and appended to `data/alerts-sol-<date>.log` when `ΔVOL >= GMGN_ALERT_USD`
**and** `Δ% >= GMGN_ALERT_PCT` in one poll window.

## Config (env)

```
GMGN_CHAIN=sol
GMGN_PERIOD=1m            # 1m | 5m | 1h | 6h | 24h
GMGN_ORDERBY=volume       # volume|swaps|marketcap|liquidity|holder_count|smartmoney|price|change1m|change5m|change1h|open_timestamp
GMGN_LIMIT=100
GMGN_POLL_MS=5000
GMGN_MIN_VOLUME=0
GMGN_ALERT_USD=5000
GMGN_ALERT_PCT=15
# scanner thresholds (src/scan.js)
GMGN_MIN_VOL_USD=20000
GMGN_MIN_FEE_SOL=3
GMGN_MIN_MCAP_USD=100000
GMGN_COOLDOWN_MIN=5
GMGN_DELETE_AFTER_MIN=5
GMGN_WATCH=mint1,mint2
GMGN_OUT_DIR=./data
GMGN_LANG=id
GMGN_TZ=Asia/Jakarta
GMGN_COOKIE=              # optional, only if you ever get rate-limited
```

`data/device.json` holds the generated `device_id` / `fp_did`. Any random UUID works — the wall is
fingerprint-based, not session-based — but keeping it stable avoids churn.

## Official OpenAPI mode (optional, needs key)

```
GMGN_MODE=openapi GMGN_API_KEY=... node src/monitor.js --period 1h
```

Endpoint: `https://openapi.gmgn.ai/v1/market/rank`, headers `X-APIKEY`, query `timestamp` (unix s,
±5s) + `client_id` (uuid). Keys are created at https://gmgn.ai/ai.

## Files

```
src/h2.js       HTTP/2 + Chrome TLS fingerprint GET, brotli/gzip decode
src/gmgn.js     GmgnPublic (/api/v1/rank) and GmgnOpenApi clients
src/http.js     HTTP/1.1 helper used by the OpenAPI client
src/monitor.js  polling loop, delta math, table, JSONL history, spike alerts
```

## Test

```bash
node test/mock.test.mjs
```

Spins a local mock of the rank endpoint and asserts delta math, table rendering, and spike alerts.
