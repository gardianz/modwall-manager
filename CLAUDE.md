# CLAUDE.md

Panduan untuk Claude Code di repo ini.

## Apa ini

`modwall-manager` — multi-wallet session keeper untuk Modulo (`app.modulo.finance`, Auth0 SPA).
Tugasnya: jaga sesi wallet tetap hidup (auto-refresh Auth0 token), pantau health, kerjakan +
klaim quest harian, convert poin, bulk transfer. Bukan sybil tool.

## Menjalankan

Tidak ada build, tidak ada test suite, tidak ada linter. Node ≥ 18 (pakai global `fetch`),
ESM (`"type": "module"`). Nol dependency wajib — hanya `playwright` opsional untuk `grab-token.mjs`.

```bash
node cli.mjs              # menu interaktif (tool utama)
node keeper.mjs           # loop headless VPS (--once untuk satu siklus / cron)
node telegram.mjs         # bot Telegram
node token-receiver.mjs   # HTTP 127.0.0.1:8787, terima token dari extension
```

Verifikasi perubahan = jalankan script-nya langsung. Jangan bikin test runner/dependency baru
tanpa diminta.

## Arsitektur

`core.mjs` = satu-satunya sumber logika bersama (storage, JWT, refresh Auth0, wrapper API,
instrument/balance/quest/rewards, fee math, transfer, alert). `autotask.mjs` = orkestrasi di
atasnya (claim, preapproval, convert, extend subscription, daily internal transfer). `cli.mjs`, `keeper.mjs`,
`telegram.mjs`, `token-receiver.mjs` semuanya tipis dan import dari keduanya.
**Endpoint atau storage baru masuk `core.mjs`; alur multi-langkah masuk `autotask.mjs`** —
jangan duplikat di frontend.

`modulo-wallet.mjs` = legacy single-wallet keeper berbasis `.env`. Sengaja **self-contained**
(punya salinan `decodeJwt`/`api`/`humanAmount` sendiri, tidak import `core.mjs`). Jangan
di-refactor ke `core.mjs` kecuali diminta.

`grab-token.mjs` juga berdiri sendiri (Playwright + `.env`), bukan bagian jalur multi-wallet.

## State & secret

| file | isi | catatan |
|---|---|---|
| `wallets.json` | array wallet + `accessToken`/`refreshToken` | gitignored, mode 0600 |
| `config.json` | `alert` (Telegram/webhook), `keeper`, `api` override | gitignored, mode 0600 |
| `.env` | hanya dipakai `modulo-wallet.mjs` + `grab-token.mjs` | gitignored, mode 0600 |

Tulis lewat `saveWallets()` / `saveConfig()` saja — keduanya lewat `writeJsonSecure()` yang
mengunci mode 0600. Jangan pernah `writeFileSync` mentah untuk file ini, dan jangan pernah
commit / print isinya ke log.

Bentuk objek wallet: `{ id, sub, email, label, accessToken, refreshToken, partyId?, addedAt,
lastRefreshAt?, dead?, alertedDead?, alertedSub?, lastError? }`. `id` = Auth0 `sub` — dipakai
untuk dedup saat import dan untuk lookup di alur multi-step Telegram.

## Aturan yang gampang dilanggar

**Refresh token rotasi.** Sekali `refreshWallet()` sukses, RT lama mati. `refreshWallet()` dan
`api()` **mutasi objek wallet di tempat** — setiap pemanggil wajib `saveWallets(wallets)`
setelahnya, kalau tidak RT baru hilang dan wallet jadi `invalid_grant` permanen. Konsekuensi
lain: satu wallet hanya boleh jalan di **satu** proses/mesin.

**`api()` auto-refresh pada 401/403** lalu retry sekali. Jangan tambah retry manual di caller.

**Saldo & jumlah = string desimal manusiawi** (`"0.0000805087"`), bukan integer berskala.
Bandingkan/jumlahkan lewat `toUnits()`/`fromUnits()` (BigInt) — jangan pakai `Number` untuk
kuantitas. Hanya aritmetika USD/harga yang lewat `Number`, dan hasilnya selalu dipotong dengan
`truncDecimals()` (ROUND_DOWN, meniru app) supaya estimasi tak pernah kebesaran.
`humanAmount()` cuma sisa kompatibilitas untuk payload lama.

**Fee = urusan server, angka kita cuma estimasi.** `POST /api/canton/transfer` menerima
`feeInstrumentId` (token mana yang bayar), **bukan** nominal fee. Rumus estimasi meniru app
persis: `feeUsd = baseUsd * max(0, 1 + modifier/100)` dengan `modifier = -feeDiscountPercent`,
lalu `truncDecimals(feeUsd / usdPerUnit, decimals)`. `baseUsd` diambil dari tier:
`internalTransferFeeUsd` kalau tujuan cocok `MODULO_PARTY_RE`, selain itu `transferFeeUsd`.
Diskon 75% saat ini cuma di **CBTC & cETH** (`feeDiscountPercent` di `/api/asset-blockchain`) —
jangan hardcode, baca dari API.

**Subscription.** Harga = `costAmountUsd × (1 − subscriptionDiscountPercent/100) ÷ spot`, pola
sama dengan fee. App cuma buka "Extend" saat `daysRemaining < 31` (dibulatkan ke ATAS), dan syarat
saldo di app itu `balance > qty` (**strict**, bukan `>=`) — `pickSubscriptionPayment()` menirunya.
Jangan extend saat status `REQUESTED`/`PENDING`/`AWAITING_PAYMENT` (pembayaran masih jalan).

**Dashboard: ukur teks polos, warnai belakangan.** `dashboard.mjs` membangun tiap sel sebagai
teks polos, memotong/mem-padding, baru menempel kode ANSI. Jangan pernah `padEnd()` string yang
sudah berwarna — escape code ikut terhitung dan layout box langsung melenceng. `width()` juga
menghitung CJK/emoji sebagai 2 kolom. Status panel dibaca lewat `onStatus` **di dalam** loop,
bukan timer paralel: dua `refreshWallet()` bersamaan akan saling merotasi RT dan mematikan sesi.

**Loop harian pakai timestamp absolut.** `runAutoTasksLoop()` menghitung `nextStart` sekali per
hari lalu membandingkan `Date.now() >= nextStart`. Jangan diganti jadi cek "apakah `utcDay()`
berubah" — tick retry bisa mendarat persis di 00:00, hari sudah berganti padahal
`loopStartOffsetMin` belum lewat, dan pass berikutnya jalan sebelum quest baru ada di server.

**Subscription lapse = buntu.** Wallet tanpa subscription aktif tidak bisa convert poin, jadi
tidak bisa mendanai renew-nya sendiri. `runAutoTasks()` memutusnya lewat `fundSubscription()`:
wallet lain mengirim harga renew dalam **aset diskon** (CBTC/cETH). Jangan menalangi pakai CC/MOD
— penerima jadi bayar $1.00, bukan $0.25. Pemicunya `reason: 'insufficient-balance'`, **bukan**
cocok-cocokan teks pesan (teks user-facing bahasa Indonesia, gampang berubah).

**Langkah yang saling membuka harus diulang di pass yang sama.** Renew menghapus persis penyebab
convert gagal, jadi `runAutoTasks()` menjalankan `daily-convert-ulang` setelah renew sukses —
dengan `loadContext()` baru, karena `canExchangePoints` ditentukan server. Pemicunya kode
`reason: 'subscription-inactive'`, bukan teks pesan.

**Log dashboard pakai channel.** `say()` mengirim label wallet sebagai argumen ketiga
(`onLog(msg, level, channel)`), jangan ditempel ke teks — panel per-akun memfilter lewat channel,
dan panel `SEMUA` yang menempelkan namanya sendiri saat render.

**Preapproval wajib duluan.** Token tanpa transfer-preapproval tidak bisa dikirim/diterima
mulus dan tidak bisa jadi target convert. Itu sebabnya `runAutoTasks()` menjalankan langkah
preapproval sebelum langkah yang memindahkan nilai.

**Flag alert dedup** (`dead`, `alertedDead`, `alertedSub`) hanya boleh berubah saat *transisi*
state — itu yang mencegah keeper spam. Jaga polanya saat menyentuh `keeper.mjs`.

**Readline di `cli.mjs`** pakai satu antrean baris global (`nextLine`). Jangan pasang listener
`rl.on('line')` tambahan atau bikin `readline.createInterface` kedua — itu bikin baris hilang
saat paste JSON multi-baris. Input user lewat `ask()` / `askPaste()` saja.

**Telegram** hanya melayani `cfg.alert.telegram.chatId`. Jangan longgarkan cek otorisasi di
`poll()`. Receiver HTTP bind ke `127.0.0.1` saja — jangan diekspos.

## Konvensi

- Komentar & nama identifier: **bahasa Inggris**. Teks yang dilihat user (CLI, Telegram,
  extension, README): **bahasa Indonesia**.
- Gaya: ESM, `async/await`, tanpa class kecuali `AuthError`, helper satu baris kalau muat,
  indentasi 2 spasi, semicolon. Ikuti gaya padat file sekitar.
- Error auth dilempar sebagai `AuthError` supaya caller bisa bedakan "sesi mati" dari error biasa.
- Commit message: Conventional Commits (`feat:`, `docs:`, `fix:`).

**Node + IPv6.** `core.mjs` memaksa IPv4 (`net.setDefaultAutoSelectFamily(false)` +
`dns.setDefaultResultOrder('ipv4first')`). Tanpa itu, host yang punya AAAA tapi IPv6-nya tidak
routable (WSL2) bikin `fetch` ke API mentok `ETIMEDOUT` padahal `curl` jalan. Jangan dihapus.

## Endpoint yang dipakai

Base `https://modulo-canton-app-api-client-mainnet-prod.fly.dev` (override lewat `config.json > api`).
Semua diverifikasi live — kalau ragu, cek ulang bundle SPA di `https://app.modulo.finance/assets/index-*.js`
(client-nya hasil generate OpenAPI + zod, jadi shape request/response ada di situ).

| endpoint | catatan |
|---|---|
| `POST /api/auth/login` | profil + `partyId` (alamat terima) |
| `GET /api/asset`, `/api/asset-blockchain` | tabel instrument + `instrumentId` + `*DiscountPercent` |
| `GET /api/canton/balances` | `{balances:{SYM:{availableBalance,lockedBalance,totalBalance}}}` |
| `GET/POST /api/canton/transfer-preapproval` | `{instrumentIds}` / body `{instrumentId}` (tombol "Enable") |
| `POST /api/canton/transfer` | body `{receiverPartyId, quantity, instrumentId?, memo?, feeInstrumentId?}` |
| `GET /api/rewards/user-points`, `/exchange-rates` | saldo poin + `usdPerUnit`/`pointsPerUsd` per asset |
| `POST /api/rewards/point-exchange` | body `{instrumentId}` saja — server yang tentukan jumlahnya |
| `GET /api/user-quests[?status=active]`, `/available`, `/counts` | `pageSize` **maks 50**, lebih = 400 |
| `POST /api/user-quests/{progressId}/claim` | tanpa body; `progressId` = `id` user-quest |
| `GET /api/subscription`, `/api/subscription-tier` | join `sub.tierId` → tier; semua fee USD ada di tier |
| `POST /api/subscription/subscribe` | body `{tierId, instrumentId?}` (default `"Amulet"`) — subscribe/renew/extend satu endpoint |
| `GET /api/referrals/me`, `/api/user/profile` | |
| `POST https://canton-mainnet-2.us.auth0.com/oauth/token` | refresh |

Quest: `status` = `IN_PROGRESS|COMPLETED|CLAIMED|EXPIRED`; yang bisa diklaim = `COMPLETED`
(`?status=active`). `periodKey` harian pakai tanggal **UTC** — bandingkan dengan
`toISOString().slice(0,10)`, bukan tanggal lokal. Quest baru muncul di `/available` dan otomatis
jadi user-quest begitu aktivitasnya dilakukan; evaluator-nya async, makanya ada `settleWaitSec`.

Sudah **hilang** dari API (jangan dipakai lagi): `/api/canton/balances/mod`,
`/api/daily-reward/user-daily-reward`, `POST /api/daily-reward/claim`. Sistem reward sekarang
= poin → convert, plus quest.

Login hanya "Continue with Google" (PKCE di browser). Tidak ada grant password/device_code —
jangan coba bikin jalur login headless; polanya: import sesi di laptop, jalankan refresh di VPS.
