# GMGN Solana Volume Scanner

Scanner volume token Solana dari GMGN, diperkaya data pool Meteora DLMM, dengan dua channel notifikasi
Telegram. Tanpa dependency — cukup Node.js, tidak perlu `npm install`.

---

## Daftar Isi

- [Cara Menjalankan](#cara-menjalankan)
- [Konfigurasi](#konfigurasi)
- [Cara Kerja Channel 1](#channel-1--volume-spike)
- [Cara Kerja Channel 2](#channel-2--volume-bertahan)
- [Contoh Pesan](#contoh-pesan)
- [Endpoint GMGN](#endpoint-gmgn-yang-dipakai)
- [Endpoint Meteora](#endpoint-meteora-yang-dipakai)
- [Struktur File](#struktur-file)
- [Troubleshooting](#troubleshooting)

---

## Cara Menjalankan

### Instalasi

```bash
git clone https://github.com/ricky10p/gmgn-volume-scanner.git
cd gmgn-volume-scanner
cp .env.example .env
nano .env          # isi token bot Telegram
chmod 600 .env
```

Butuh **Node.js 18 atau lebih baru**. Tidak ada dependency, jadi tidak perlu `npm install`.

### Perintah harian

```bash
./run.sh start      # jalankan di background
./run.sh status     # cek hidup + config + siklus terakhir
./run.sh logs       # lihat log realtime (Ctrl+C untuk keluar)
./run.sh stop       # hentikan
./run.sh restart    # stop + start (pakai ini setelah ubah .env)
```

### Cara update

```bash
cd ~/gmgn-volume-scanner
./run.sh stop
git pull
./run.sh test        # pastikan tidak ada yang rusak
./run.sh start
```

`.env` tidak akan tersentuh — file itu di-`.gitignore`, jadi tidak pernah ikut tertimpa.

Kalau `git pull` menolak karena ada perubahan lokal di file source:

```bash
git stash            # simpan perubahan lokal
git pull
git stash pop        # kembalikan perubahan lokal
```

Atau, kalau perubahan lokal memang tidak diperlukan:

```bash
git fetch origin
git reset --hard origin/main   # HAPUS perubahan lokal di file yang dilacak git
```

`data/` dan `logs/` aman di kedua cara — keduanya tidak dilacak git.

### Perintah bantu

```bash
./run.sh test       # unit test offline (pakai mock server, tidak kena API)
./run.sh dry        # satu siklus, cetak ke layar, TIDAK kirim ke Telegram
./run.sh once       # satu siklus, kirim ke Telegram kalau lolos filter
```

### Tanpa `run.sh`

```bash
node src/scan.js --once --dry-run    # sekali jalan, tidak kirim
node src/scan.js --once              # sekali jalan, kirim
node src/scan.js                     # jalan terus (Ctrl+C untuk stop)
```

Catatan: kalau dijalankan langsung tanpa `run.sh`, proses akan mati begitu terminal ditutup.
`run.sh start` memakai `nohup` sehingga tetap hidup di background.

---

## Konfigurasi

Semua pengaturan ada di file `.env`. Setelah mengubah, jalankan `./run.sh restart`.

### Channel 1 — volume spike

| Variabel | Default | Keterangan |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | token bot (dari @BotFather) |
| `TELEGRAM_CHAT_ID` | — | ID chat tujuan |
| `GMGN_MIN_VOL_USD` | `20000` | volume 1 menit minimal |
| `GMGN_MIN_FEE_SOL` | `3` | GMGN fee kumulatif minimal (SOL) |
| `GMGN_MIN_MCAP_USD` | `100000` | market cap minimal |
| `GMGN_COOLDOWN_MIN` | `5` | jeda per token setelah terkirim (menit) |
| `GMGN_DELETE_AFTER_MIN` | `5` | hapus pesan setelah N menit (`0` = simpan) |

### Channel 2 — volume bertahan

| Variabel | Default | Keterangan |
|---|---|---|
| `TG2_BOT_TOKEN` | — | token bot kedua |
| `TG2_CHAT_ID` | — | ID chat tujuan |
| `TG2_MIN_VOL_USD` | `50000` | ambang volume 1 menit |
| `TG2_SUSTAIN_MIN` | `3` | harus bertahan di atas ambang selama N menit |
| `TG2_REPEAT_SEC` | `5` | kirim ulang tiap N detik |
| `TG2_DELETE_AFTER_SEC` | `30` | hapus tiap pesan setelah N detik |
| `TG2_MAX_PER_CYCLE` | `10` | batas token per siklus (anti-flood) |

Filter fee dan market cap channel 2 **otomatis mengikuti channel 1** (`GMGN_MIN_FEE_SOL` dan
`GMGN_MIN_MCAP_USD`).

### Umum

| Variabel | Default | Keterangan |
|---|---|---|
| `GMGN_CHAIN` | `sol` | chain yang dipantau |
| `GMGN_PERIOD` | `1m` | bucket volume: `1m`, `5m`, `1h`, `6h`, `24h` |
| `GMGN_POLL_MS` | `5000` | interval polling |
| `GMGN_LIMIT` | `100` | jumlah token yang diambil per siklus |
| `GMGN_MAX_POOLS` | *(kosong)* | batasi jumlah pool yang ditampilkan; kosong = semua |
| `GMGN_MIN_POOL_TVL` | `0` | sembunyikan pool dengan TVL di bawah nilai ini |
| `GMGN_POOL_TYPES` | `dlmm` | `dlmm` atau `dlmm,damm` |
| `GMGN_REQUIRE_POOL` | `1` | `0` = tetap kirim walau tanpa pool DLMM |
| `GMGN_DRY_RUN` | `0` | `1` = cetak saja, tidak kirim |

### Mengambil Chat ID

Kalau belum tahu `chat_id`, kirim pesan apa pun ke bot, lalu jalankan:

```bash
node scripts/tg_discover.mjs
```

Script akan menampilkan bot yang aktif beserta daftar chat yang pernah mengirim pesan.

---

## Channel 1 — Volume Spike

Alur kerja, berurutan:

1. Ambil ranking volume `1m` dari GMGN setiap **5 detik**
2. **Urutkan dari volume terbesar ke terkecil**
3. Saring: `volume 1m >= $20K` **dan** `fee >= 3 SOL` **dan** `market cap >= $100K`
4. Ambil **semua** pool Meteora DLMM untuk token itu — quote apa pun (SOL, USDC, USDT, JupUSD, mSOL,
   hSOL, atau memecoin lain), bukan hanya pair SOL
5. **Token tanpa pool DLMM dibuang** — tidak dikirim, dan **tidak masuk cooldown**, jadi dicek ulang
   pada siklus berikutnya (mungkin pool-nya baru muncul)
6. Urutkan pool berdasarkan TVL terbesar, tampilkan **semuanya** tanpa batas. Kalau kepanjangan,
   pesan dipecah otomatis di batas pool (342 pool = 15 pesan), satu pool tidak pernah terpotong
7. **Cooldown 5 menit per token dimulai hanya setelah Telegram menerima pesannya.** Kalau pengiriman
   gagal atau token dilewati, tidak ada cooldown yang tercatat

---

## Channel 2 — Volume Bertahan

Channel kedua yang perilakunya berlawanan: tanpa cooldown, frekuensi tinggi.

- Token mulai dihitung "streak" saat volume `1m` pertama kali menyentuh `>= $50K`
- Streak **direset ke nol** begitu volume turun di bawah ambang, **token hilang dari rank list**, atau
  **state tersimpan lebih tua dari 3 siklus polling** (proses mati / jeda panjang). Streak tidak pernah
  dipercaya menyeberangi restart — token harus membuktikan 3 menitnya lagi
- Setelah streak melewati **3 menit**, pesan dikirim tiap **5 detik** selama streak masih berjalan
- Filter fee (`>= 3 SOL`) dan market cap (`>= $100K`) sama seperti channel 1, dicek saat pengiriman
  supaya penurunan sesaat tidak membuang streak volume yang sudah panjang
- **Tanpa cooldown**
- Syarat punya pool DLMM tetap berlaku
- **Format pesan sama persis dengan channel 1** — semua pool DLMM ditampilkan
- Tiap pesan dihapus **30 detik** setelah dikirim, jadi maksimal ~6 alert per token yang terlihat

Kedua channel berbagi **satu polling GMGN yang sama**, jadi tidak menambah beban request, dan berjalan
dalam satu proses.

---

## Contoh Pesan

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

Detail tampilan di Telegram:

- **Simbol token** dicetak tebal
- **Alamat kontrak** dibungkus `<code>` → cukup **tap sekali untuk menyalin**
- **Quote token** tiap pool (SOL/USDC/dll) adalah link ke halaman Meteora pool tersebut
- **`Open on GMGN`** adalah link — tidak ada URL mentah yang memakan ruang
- Angka memakai pemisah ribuan (`1,884`), nominal besar diringkas (`$589.5K`, `$64.8M`)

### Pemetaan field

| Baris di pesan | Sumber data GMGN |
|---|---|
| MC | `market_cap` |
| ATH | `history_highest_market_cap` |
| 1m Vol | `volume` (bucket `1m`) |
| Fee | `gas_fee` — fee kumulatif dalam SOL |
| Tx | `swaps` (`buys` / `sells`) |
| Holders | `holder_count` |
| Bin Step / Base Fee | `dlmm_params.bin_step` / `fee_pct` (Meteora) |
| TVL / Vol24 | `tvl` dan `volume` (Meteora, sudah dalam USD) |

### Penghapusan pesan otomatis

Channel 1 menghapus pesan setelah `GMGN_DELETE_AFTER_MIN` menit, channel 2 setelah
`TG2_DELETE_AFTER_SEC` detik.

- ID pesan disimpan di `data/sent.json` (`msgIds`) dan `data/sustained.json`, lalu disapu di awal
  setiap siklus scan
- Penghapusan memakai `deleteMessage`; bot hanya boleh menghapus **pesannya sendiri**
- Telegram membatasi penghapusan oleh bot maksimal **48 jam** — nilai lebih dari itu akan gagal diam-diam
- Entri yang sudah dihapus tetap menyimpan timestamp (supaya cooldown tetap berlaku) tapi ID-nya
  dikosongkan dan dicatat `deletedAt`
- Status `already-gone` (sudah dihapus manual) dan `too-old` dianggap selesai, tidak dicoba ulang

---

## Endpoint GMGN yang Dipakai

Tidak butuh API key.

```
GET https://gmgn.ai/api/v1/rank/{chain}/swaps/{interval}
    ?orderby=volume&direction=desc&limit=100
    &filters[]=renounced&filters[]=frozen&min_gas_fee=3
```

Ada dua route yang datanya **identik** (urutan alamat sama, 97 field sama) — beda path saja:

```
/api/v1/rank/{chain}/swaps/{interval}                # dipakai web app sekarang
/defi/quotation/v1/rank/{chain}/swaps/{interval}     # versi lama, masih hidup
```

`interval` = `1m | 5m | 1h | 6h | 24h`. Response: `{code, reason, message, data:{rank:[...]}}`.

Parameter `device_id`, `fp_did`, `client_id`, `app_ver`, `tz_*` diterima tapi **tidak wajib**.

### Kenapa `curl` / `fetch` biasa kena 403

Edge Cloudflare menolak client HTTP/1.1 dengan TLS fingerprint non-Chrome. Dua hal harus cocok:

1. **HTTP/2** (ALPN `h2`) — HTTP/1.1 diblokir total
2. **Urutan cipher Chrome** — `TLS_AES_128_GCM_SHA256` dulu, lalu ECDHE-ECDSA/RSA GCM, CHACHA20, CBC

`src/h2.js` melakukan persis itu memakai `http2.connect` + `ciphers` + `ecdhCurve`, jadi **tidak perlu
proxy, tidak perlu cookie `cf_clearance`, tidak perlu API key**. Terverifikasi live: HTTP 200 dari IP
datacenter.

Jangan menambahkan opsi `sigalgs` — OpenSSL di Node menolaknya dengan
`error:00000000:lib(0)::reason(0)`.

---

## Endpoint Meteora yang Dipakai

Tidak butuh API key.

```
GET https://pool-discovery-api.datapi.meteora.ag/pools
    ?page_size=500&page=1&category=all&filter_by=token_x=<mint>
```

Satu panggilan mengembalikan **semua** pool untuk mint tersebut, termasuk semua quote token, dengan
`tvl` dan `volume` yang **sudah dalam USD**, plus `dlmm_params.bin_step` dan `fee_pct` — tidak perlu
memanggil detail per pool.

- `filter_by=token_x=<mint>` adalah satu-satunya filter mint yang bekerja. `token_address`, `mint`,
  `base_mint` ditolak dengan error 400
- Meteora selalu menaruh token yang diluncurkan di sisi `token_x`, jadi `token_y=<mint>` menghasilkan 0
  — satu query sudah mencakup dua arah
- `page_size=500` mengembalikan seluruh set (satu token bisa punya 300+ pool)
- `pool_type` bernilai `dlmm` atau `damm`; pakai `GMGN_POOL_TYPES=dlmm,damm` untuk memperluas scan
- Host lama `dlmm-api.meteora.ag` sudah mati (404 di semua path)

**Penting:** `tvl` dan `volume` dari API ini **sudah USD**. Jangan dikalikan harga SOL lagi — itu akan
membuat angkanya membengkak ~100x.

---

## Struktur File

```
gmgn-volume-scanner/
├── run.sh                  kontrol start/stop/status/logs
├── .env.example            template konfigurasi
├── .gitignore              .env, data/, logs/ dikecualikan
├── src/
│   ├── scan.js             program utama (dua channel)
│   ├── alert.js            render pesan + format angka
│   ├── channel2.js         channel volume bertahan
│   ├── gmgn.js             client GMGN (public + openapi)
│   ├── h2.js               HTTP/2 + TLS fingerprint Chrome
│   ├── meteora.js          client Meteora
│   ├── telegram.js         kirim / hapus / pecah pesan
│   ├── http.js             helper HTTP/1.1 (untuk OpenAPI)
│   └── monitor.js          mode tabel (utility, lihat bagian bawah)
├── scripts/
│   └── tg_discover.mjs     cari chat_id bot
└── test/
    └── mock.test.mjs       unit test offline
```

### File runtime (tidak masuk git)

```
data/
├── sent.json          cooldown channel 1
├── sustained.json     streak channel 2
└── device.json        identitas device GMGN (acak, sekali dibuat)
logs/
└── scanner.log        log
```

---

## Mode Tabel (utility)

Selain scanner, ada mode tabel sederhana untuk memantau pergerakan volume:

```bash
node src/monitor.js --once                          # satu snapshot
node src/monitor.js --period 1h --poll 30000        # 1 jam, polling 30 detik
node src/monitor.js --watch <mint1>,<mint2>         # pantau mint tertentu
node src/monitor.js --json                          # output JSON lines
```

Kolom: `VOL(periode)` volume dalam bucket, `ΔVOL` pertambahan sejak polling sebelumnya, `Δ/MIN` laju
per menit, `Δ%` pertumbuhan, `SWAPS`, `MCAP`. Riwayat tersimpan di `data/volume-sol-<tanggal>.jsonl`.

---

## Mode OpenAPI Resmi (opsional, butuh key)

```
GMGN_MODE=openapi GMGN_API_KEY=... node src/scan.js
```

Endpoint `https://openapi.gmgn.ai/v1/market/rank`, header `X-APIKEY`, query `timestamp` (unix detik,
toleransi ±5 detik) + `client_id` (uuid). Key dibuat di https://gmgn.ai/ai.

---

## Test

```bash
./run.sh test
# atau
node test/mock.test.mjs        # mode tabel (monitor.js) terhadap mock server
node test/regression.test.mjs  # alert, escaping HTML, chunking, partial-send, merge state
```

Keduanya offline — tidak menyentuh API asli maupun Telegram.

`regression.test.mjs` mengunci bug yang pernah ditemukan:

- simbol token yang mengandung `<`, `>`, `&` tidak boleh merusak `parse_mode=HTML`
- kegagalan di tengah pengiriman harus mencatat id yang sudah terkirim (`err.sentIds`)
- re-send tidak boleh menimpa `msgIds` lama (kalau tidak, pesan lama tidak pernah terhapus)
- `minPoolTvl` harus melaporkan jumlah pool yang benar-benar ditampilkan
- `pool_type` non-DLMM tidak boleh ikut saat `poolTypes=dlmm`

---

## Batasan yang diketahui

- **Cache pool Meteora 60 detik.** TVL/Vol24 pada alert bisa tertinggal hingga 1 menit. Volume GMGN
  tetap segar setiap polling.
- **Maksimal 10 halaman pool** (5.000 pool) per token. Di atas itu dipotong — saat ini token terbesar
  (TRUMP) punya 396 pool, jadi jauh dari batas.
- **Polling 5 detik = 12 request/menit** ke GMGN. Jangan diturunkan tanpa alasan.
- **Penghapusan pesan oleh bot dibatasi Telegram 48 jam.** Nilai `GMGN_DELETE_AFTER_MIN` di atas itu
  akan gagal diam-diam.
- **Rate limit Telegram (429)** ditangani dengan satu kali retry mengikuti `retry_after`. Kalau ch2
  mengirim sangat banyak token sekaligus, sebagian pengiriman bisa tertunda satu siklus.

---

## Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| `already running` | memang sudah jalan — cek `./run.sh status` |
| Tidak ada notifikasi | pasar sepi. Cek `./run.sh logs`, lihat baris `0 pass filter` |
| `HTTP 403` dari GMGN | fingerprint TLS berubah — perlu update `src/h2.js` |
| `telegram: Unauthorized` | token bot salah atau sudah di-revoke |
| `telegram: chat not found` | `chat_id` salah, atau bot belum pernah di-`/start` |
| Pesan tidak terhapus | retensi > 48 jam (batas Telegram) atau bot bukan pengirim pesan |
| `EADDRINUSE` | ada proses lain; `./run.sh stop` lalu `start` |

---

## Catatan

- Endpoint GMGN yang dipakai di sini **tidak resmi** (endpoint internal web app). Bisa berubah sewaktu-waktu.
- Gunakan dengan bijak. Polling 5 detik = 12 request/menit; jangan diturunkan lebih jauh tanpa alasan.
- Data dari GMGN dan Meteora bisa meleset beberapa detik dari kondisi on-chain sebenarnya.
