# modwall-manager

Interactive **multi-wallet** session keeper + health monitor for Modulo
([app.modulo.finance/portfolio](https://app.modulo.finance/portfolio)).

- **CLI interaktif** (`cli.mjs`) — kelola banyak wallet: add (import sesi), lihat health, refresh, preapproval token, convert poin, claim quest, auto task, bulk send, atur alert.
- **Auto task** (`autotask.mjs`) — kerjakan quest harian otomatis: klaim quest, enable preapproval, convert poin ke token diskon, extend subscription, daily internal transfer ke wallet sendiri.
- **Session keeper** (`keeper.mjs`) — jalan headless di VPS, auto-refresh Auth0 token semua wallet, **alert Telegram/webhook kalau refresh token mati**, opsional jalankan auto task tiap siklus.
- **Browser extension** (`extension/`) + **receiver** (`token-receiver.mjs`) — impor sesi dari browser yang sudah login, tanpa login ulang.
- **Telegram bot** (`telegram.mjs`) — kontrol semua fitur CLI dari Telegram.

Bukan sybil tool.

## Setup step-by-step

**Prasyarat**: Node.js ≥ 18. Cek: `node --version`.

```bash
git clone https://github.com/gardianz/modwall-manager.git
cd modwall-manager
```

Tidak ada dependency wajib (pakai Node built-in). `playwright` opsional (buat `grab-token.mjs`).

### Langkah 1 — impor sesi wallet (di laptop, browser sudah login)

Pilih salah satu:

**Cara mudah (extension):**
1. `node token-receiver.mjs` (biarkan jalan di terminal).
2. Chrome → `chrome://extensions` → aktifkan **Developer mode** → **Load unpacked** → pilih folder `extension/`.
3. Buka <https://app.modulo.finance/portfolio> (pastikan sudah login).
4. Klik ikon extension → **Ambil Sesi** → **Kirim ke Bot**. Wallet masuk `wallets.json` otomatis.

**Cara manual (paste):**
1. `node cli.mjs` → `2) Add wallet`.
2. Buka DevTools (F12) di tab Modulo → Application → Local Storage → `https://app.modulo.finance` → key `@@auth0spajs@@…` → salin isinya.
3. Tempel di CLI. Ulangi untuk wallet lain (`Tambah wallet lagi? y`).

> Pastikan ada **refresh_token** (biar bisa auto-refresh > 24 jam). Extension & localStorage sudah bawa refresh_token.

### Langkah 2 — jalankan / kelola

```bash
node cli.mjs            # menu: list, detail, refresh, claim, bulk send, alerts
```

### Langkah 3 — (opsional) alert Telegram

1. Chat @BotFather → `/newbot` → dapat **botToken**.
2. Chat @userinfobot → dapat **chatId**.
3. `node cli.mjs` → `8) Alerts` → isi botToken + chatId → `4) Test alert`.
4. Kontrol via Telegram: `node telegram.mjs` → kirim `/menu` ke bot.

### Langkah 4 — jaga sesi 24/7 di VPS

Login tak bisa di VPS (Google blokir). Pola: impor di laptop → jalankan refresh_token di VPS.

```bash
# di VPS:
git clone https://github.com/gardianz/modwall-manager.git && cd modwall-manager
# salin wallets.json (berisi refresh_token) dari laptop ke sini, atau impor ulang via: node cli.mjs -> 2
chmod 600 wallets.json config.json
node keeper.mjs                 # loop selamanya + alert kalau RT mati
```

systemd (auto-start): lihat bagian [Running on a VPS](#running-on-a-vps-headless-no-display) di bawah.

> ⚠️ **Jangan commit `wallets.json` / `config.json` / `.env`** — isinya token sesi (akses penuh wallet). Sudah gitignored.

---

Single account per Google login.

## Cara kerja auth (ringkas)

`app.modulo.finance` = Auth0 SPA. Login **hanya "Continue with Google"** (dites live: tak ada email/password; `device_code` & `password` grant ditolak client). Client cuma izinkan `authorization_code` (PKCE, browser) + `refresh_token`.

- Access token JWT hidup ~24h.
- `refresh_token` (scope `offline_access`) = satu-satunya kredensial mesin yang bikin sesi hidup headless. **Rotasi** tiap dipakai.
- Auth0 domain `canton-mainnet-2.us.auth0.com`, client `IJ0NkQST4x9w7e4BK78PdUktGlvDKVpW`, audience `https://client-api.modulo.finance`, API `https://modulo-canton-app-api-client-mainnet-prod.fly.dev`.

## Quick start

```bash
node cli.mjs            # menu interaktif
```

Menu:
```
 1) List wallets            2) Add wallet (import)
 3) Detail wallet           4) Refresh token now
 5) Claim quest reward      6) Remove wallet
 7) Bulk send (transfer)    8) Alerts (Telegram/webhook)
 9) Keeper settings        10) Run keeper now
11) Preapproval token      12) Convert poin -> token
13) Auto task (jalankan)   14) Auto task settings
15) Subscription (extend)   0) Exit
```

Data disimpan di `wallets.json` (token) + `config.json` (alert/keeper/autoTask), keduanya `chmod 600`, gitignored.

## Proxy per akun (`proxies.txt`)

Satu baris = satu akun, **urut** sesuai daftar wallet (menu `1`). Baris 1 → wallet 1, dst.
Salin contohnya: `cp proxies.txt.example proxies.txt`.

```
198.51.100.10:8080:user1:pass1        # wallet 1
198.51.100.11:8080:user2:pass2        # wallet 2
-                                     # wallet 3 sengaja TANPA proxy
socks5://user3:pass3@198.51.100.12:1080   # wallet 4
```

Format yang diterima: `host:port`, `host:port:user:pass`, `user:pass@host:port`, dan bentuk
ber-skema `http://`, `https://`, `socks5://`. Baris `#`/`//` diabaikan.

Pakai `-` untuk melewati satu slot — **jangan baris kosong**, itu bikin urutannya bergeser
diam-diam. Kalau tidak mau bergantung urutan, ikat langsung ke email:

```
nama@gmail.com=198.51.100.10:8080:user1:pass1
```

Semua trafik wallet lewat proxy-nya sendiri, **termasuk refresh token ke Auth0** — bukan cuma
panggilan API. Kalau hanya API yang diproxy, sesi terlihat berpindah negara di tengah jalan.

Proxy aktif terlihat di menu `1`, menu `3`, dan kolom `PROXY` di dashboard. Baris yang formatnya
salah dilaporkan (`⚠ proxies.txt: baris N: …`), tidak didiamkan.

> `proxies.txt` **gitignored** — isinya kredensial proxy.

## Sistem reward: poin → convert → quest

Reward Modulo sekarang berbasis **poin**: kerjakan quest → dapat poin → convert poin jadi token.

- **`11) Preapproval token`** — sama dengan tombol **Enable** di halaman portfolio. Token tanpa
  preapproval tidak bisa dikirim/diterima mulus dan **tidak bisa jadi target convert**. Menu ini
  meng-enable semua token yang masih kurang, per wallet. Gratis (hanya transaksi on-chain).
- **`12) Convert poin -> token`** — tampilkan tabel semua target: jumlah diterima, fee, nilai USD,
  status preapproval. Pilih nomor, atau `auto` untuk saran. Minimum convert 50 poin, maksimum
  1000 poin per klaim (dibaca dari API, bukan hardcode).
- **`5) Claim quest reward`** — klaim semua quest berstatus `COMPLETED` di wallet terpilih.

Fee convert = `claimFeeUsd` tier ($0.20 di tier Basic), **diskon 75% kalau target CBTC/cETH**.

## Auto task (quest harian otomatis)

`13) Auto task` menjalankan, per wallet, berurutan:

1. **Claim awal** — klaim dulu semua quest yang sudah selesai, **sebelum** ngerjain apa pun.
2. **Preapproval** semua token yang belum aktif.
3. **Daily Convert** — poin → token. Target dipilih otomatis: token yang **diskon** (CBTC/cETH)
   dan **yang sudah dipegang wallet** lebih dulu, biar saldo menumpuk di satu aset, bukan jadi debu.
4. **Extend Subscription** — perpanjang tier yang sedang dipakai kalau sisanya sudah
   ≤ `extendWhenDaysLeft`. Dibayar pakai token **diskon** (CBTC/cETH = 75% off, $1.00 → $0.25).
   Kalau saldonya kurang, bot **menalangi dulu** dari wallet lain yang punya dana (lihat bawah).
5. **Convert ulang** — kalau langkah 3 tadi gagal *karena* subscription mati dan langkah 4 baru
   saja memperbaikinya, convert diulang di pass yang sama. Poinnya sudah ada; menundanya ke besok
   tidak ada gunanya.
6. **Daily Internal Transfer** — kirim CBTC/cETH senilai `internalTransferUsd` (default $0.01) ke
   **wallet lain yang sudah diimpor ke bot**. Fee dibayar pakai token diskon.
7. **Claim akhir** — klaim quest yang baru selesai (setelah jeda `settleWaitSec`, karena evaluator
   quest jalan async).

Urutannya disengaja: convert dulu supaya ada saldo, subscription sebelum transfer supaya saldonya
tidak keburu habis buat transfer.

> **Kenapa claim didahulukan?** Window quest harian tutup tepat di **tengah malam UTC**. Quest
> berstatus `COMPLETED` yang belum diklaim saat window tutup langsung jadi `EXPIRED` dan poinnya
> hangus. Jadi poin yang sudah kelihatan diamankan duluan, baru cari kerjaan baru.
> Hindari juga menjalankan auto task persis menjelang 00:00 UTC (07:00 WIB).

**Tidak pernah diotomasi**: `daily-swap` dan `daily-external-cip56-transfer` — keduanya butuh
tujuan/pasangan yang kamu pilih sendiri dan biayanya paling besar. Ada di `skipSlugs` kalau mau diubah.

Tiga mode:

| mode | kelakuan |
|---|---|
| `[1]` Dry-run | tampilkan rencana lengkap + fee, tidak eksekusi apa pun |
| `[2]` Jalankan sekali | satu pass, lalu balik ke menu |
| `[3]` Loop harian | jalan terus, satu pass penuh tiap hari quest baru |

Eksekusi beneran (`[2]`/`[3]`) butuh ketik `JALAN`.

### Loop harian

`[3]` **tidak pernah berhenti** walau semua quest hari itu sudah selesai — dia menunggu window
quest berikutnya. Jadwalnya dipatok ke **00:00 UTC + `loopStartOffsetMin`** (default 00:05 UTC =
07:05 WIB), bukan "24 jam sejak terakhir jalan", supaya tidak ngambang menjauhi batas hari.

Di sela dua pass penuh, tiap `loopRetryMin` (default 30 menit) dia bangun untuk:

- **klaim** apa pun yang baru diselesaikan evaluator quest — gratis, dan quest `COMPLETED` yang
  belum diklaim saat batas hari akan **hangus**, jadi ini justru inti gunanya;
- **mengulang** wallet yang pass-nya error, karena sisi payout Modulo suka flaky per-aset.

Sela ini murah: cuma cek quest, bukan pass penuh.

```bash
node cli.mjs   # -> 13 -> pilih wallet -> [3] -> JALAN
```

Mode `[3]` membuka **dashboard layar penuh**: header, tabel per wallet (status, token, poin,
quest siap klaim, saldo CBTC/cETH, sisa subscription, convert/transfer hari ini), ringkasan +
hitung mundur pass berikutnya, dan log aktivitas bergulir. Tekan `q` untuk berhenti.

Kalau output di-pipe ke file atau bukan TTY, otomatis balik ke log baris biasa — tidak ada
sampah escape code di log.

Buat 24/7 tanpa terminal nyala, pakai keeper + systemd (`autoTask.enabled = true`) — lihat
bagian VPS di bawah.

### Guard fee

`14) Auto task settings` → `maxFeeUsd` (default **$0.30**). Setiap aksi yang estimasi fee-nya
melebihi angka ini **dilewati**, bukan dijalankan. Estimasi memakai rumus yang sama persis dengan
app (`baseUsd × (1 − diskon%) ÷ harga spot`, dibulatkan ke bawah).

| setting | arti | default |
|---|---|---|
| `enabled` | auto task ikut jalan di dalam keeper | `false` |
| `maxFeeUsd` | plafon fee per aksi (USD) | `0.3` |
| `internalTransferUsd` | nilai transfer harian | `0.01` |
| `convertPreferSymbols` | prioritas target convert | `CBTC,cETH` |
| `extendSubscription` | auto perpanjang subscription | `true` |
| `fundSubscription` | talangi wallet yang tak sanggup bayar renew | `true` |
| `maxFundingUsd` | plafon satu transfer talangan (USD) | `0.5` |
| `fundingMarginPercent` | kelebihan kiriman, jaga-jaga harga bergerak | `30` |
| `extendWhenDaysLeft` | extend kalau sisa ≤ segini hari | `3` |
| `maxSubscriptionUsd` | plafon biaya subscription (USD) | `0.3` |
| `settleWaitSec` | jeda sebelum claim / setelah convert | `25` |
| `loopRetryMin` | sela cek di loop harian (menit) | `30` |
| `loopStartOffsetMin` | mulai hari baru berapa menit setelah 00:00 UTC | `5` |
| `skipSlugs` | quest yang tidak diotomasi | `daily-swap,daily-external-cip56-transfer` |

> ⚠️ Fee transfer internal ($0.25 base, jadi ~$0.06 dengan diskon 75%) **lebih besar** dari nilai
> transfer default $0.01. Quest-nya bayar 10 poin (~$0.09). Cek sendiri apakah selisihnya masuk akal
> buat kamu sebelum menyalakan langkah ini.

### Talangan renew antar wallet

Wallet yang subscription-nya habis **tidak bisa convert poin** — jadi tidak bisa mengumpulkan dana
sendiri. Buntu: tak ada saldo → tak bisa renew → tak bisa convert → tetap tak ada saldo.

Bot memutusnya: kalau saat renew saldonya kurang, wallet lain yang punya dana mengirimkan
**tepat sejumlah harga renew** (plus margin `fundingMarginPercent`, karena harga spot bergerak
antara perhitungan dan saat server menagih), lalu renew dijalankan.

Talangan **selalu memakai aset diskon** (CBTC/cETH). Mengirim CC hanya akan membuat wallet itu
membayar harga penuh $1.00, bukan $0.25.

```
harga renew Basic $1.00 per aset:
  CBTC  0.0000039778  = $0.25 (-75%)
  cETH  0.000133398   = $0.25 (-75%)
  CC    10.4166666666 = $1.00 (tanpa diskon)   <- tidak pernah dipakai buat talangan

talangan: $0.325 (harga + margin 30%)  +  fee transfer $0.0625
```

Syarat: wallet penerima sudah preapproved aset itu (kalau belum, transfer jadi pending
instruction dan renew tetap gagal) — langkah preapproval di auto task sudah menanganinya lebih dulu.
Dibatasi `maxFundingUsd` per transfer. Matikan lewat `fundSubscription: false`.

## Subscription (extend manual)

Menu `15) Subscription (extend)` — tampilkan tier, sisa hari, dan **semua opsi pembayaran** persis
seperti dropdown di app: jumlah token, biaya USD, saldo cukup atau tidak, status preapproval.
Saran otomatis = token dengan diskon terbesar yang saldonya cukup.

Biaya = `costAmountUsd` tier × `(1 − subscriptionDiscountPercent/100) ÷ harga spot`.
Basic $1.00/bln → **$0.25** kalau bayar pakai CBTC/cETH.

App hanya membuka tombol Extend saat **sisa < 31 hari**; di luar itu menu ini menolak (bukan bug).
Auto task pakai ambang lebih ketat (`extendWhenDaysLeft`, default 3 hari) supaya tidak
memperpanjang kepagian. Tier tidak pernah diganti otomatis — upgrade/downgrade tetap manual.

## Bulk send (transfer)

Menu `7) Bulk send`. Pilih **sender** (satu/`1,3`/`all`) dan **receiver**:
- **Wallet internal** — pilih dari daftar (multi). Alamat (partyId) diambil otomatis via `/api/auth/login`.
- **Alamat eksternal** — paste `partyId` receiver.

Aturan plan:
| sender | receiver | hasil |
|---|---|---|
| banyak | 1 | tiap sender → receiver itu (kumpulkan) |
| 1 | banyak | sender → tiap receiver (sebar) |
| N | N | pasangan per-indeks (jumlah harus sama) |

Asset: `CBTC`, `cETH`, `CC`, `MOD`, `USDCx` (`instrumentId` diambil otomatis dari API).
Jumlah = angka per transfer, atau `max`. Token pembayar fee dipilih otomatis (yang diskon dulu);
kalau fee dibayar pakai token yang sama dengan yang dikirim, `max` otomatis menyisakan fee.
Preview plan (termasuk fee per transfer) → ketik `KIRIM` untuk eksekusi.

## Telegram bot (fitur sama seperti CLI)

Set `botToken` + `chatId` di `8) Alerts`, lalu:
```bash
node telegram.mjs
```
Bot **hanya** merespon `chatId` yang di-authorize. Kirim `/menu` → tombol: Wallets, Detail,
Refresh all, Claim quest, Preapproval, Convert, Send, Auto task, Subscription, Keeper. Semuanya alur multi-step
(balas teks):
- Send: sender (`1,3`/`all`) → receiver (`w 1,2` atau `ext <partyId>`) → asset (`CBTC`) → jumlah (`0.0001`/`max`) → `KIRIM`.
- Convert: pilih wallet → `AUTO` atau simbol target → `CONVERT`.
- Preapproval: pilih wallet → `YA`.
- Auto task: pilih wallet → bot balas **dry-run** dulu → `JALAN` untuk eksekusi.
- Subscription: pilih wallet → bot balas rencana + biaya → `EXTEND`.
- `/cancel` batalkan alur.

Kalau `chatId` belum di-set, bot membalas id kamu supaya bisa dimasukkan ke config.

## Add wallet — 3 cara impor sesi

**A. Browser extension (paling gampang, nol login ulang).** Baca token dari tab yang sudah login.
```bash
node token-receiver.mjs          # receiver lokal 127.0.0.1:8787
```
Lalu di Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → `./extension` →
buka app.modulo.finance (sudah login) → klik ekstensi → **Ambil Sesi** → **Kirim ke Bot**.
Wallet otomatis masuk `wallets.json` (label = email).

**B. CLI paste.** Menu `2) Add wallet` → tempel salah satu:
- `access_token` (JWT mentah)
- JSON `{"access_token":"...","refresh_token":"..."}`
- isi localStorage `@@auth0spajs@@...` dari DevTools (Application → Local Storage)

**C. Playwright (headless-cron).**
```bash
npm i playwright && npx playwright install chromium
node grab-token.mjs --login      # 1x login Google -> tulis .env; lalu impor via CLI/receiver
```

> `refresh_token` penting: tanpa itu wallet cuma hidup sampai access token expired (~24h). Cara A & C menangkapnya otomatis.

## Alerts (Telegram / webhook)

CLI menu `7) Alerts`:
- **Telegram**: bikin bot di @BotFather → `botToken`; `chatId` dari @userinfobot.
- **Webhook**: URL Discord/Slack/custom (dikirim JSON `{text, content, service, ts}`).
- **Test alert** untuk verifikasi.

Keeper mengirim alert saat: 🔴 refresh token **mati** (`invalid_grant`), ⚠️ token expired tanpa RT, ⏳ subscription <3 hari, ✅ pulih. Alert **dedup** (sekali per transisi, tidak spam).

## Jalan di VPS (headless)

Login tak bisa di VPS (Google blokir automation). Pola: **login sekali di laptop, refresh_token dijalankan di VPS.**

1. Laptop: impor wallet (extension/CLI) → dapat `refresh_token`.
2. Salin wallet ke VPS `wallets.json` (atau impor ulang di VPS via CLI paste refresh_token).
3. VPS:
```bash
node keeper.mjs                  # loop selamanya (default cek tiap 30m)
node keeper.mjs --once           # satu siklus (untuk cron)
```

### systemd
```bash
sudo cp -r . /opt/modulo-wallet
sudo cp modulo-wallet.service /etc/systemd/system/
# edit WorkingDirectory/ExecStart + tambah "User=youruser" di unit
sudo systemctl daemon-reload && sudo systemctl enable --now modulo-wallet
journalctl -u modulo-wallet -f
```

### Rotation — WAJIB baca
Refresh token **rotasi**: sekali dipakai, yang lama mati; keeper simpan yang baru otomatis.
- Jalankan tiap wallet di **satu tempat** saja. Re-grab di laptop saat VPS jalan → token VPS `invalid_grant` (dapat alert 🔴), harus re-import.
- Ada **absolute lifetime** (diset Modulo). Saat lapse → alert 🔴 → login ulang di laptop, re-import ke VPS.

## Security

`wallets.json`, `config.json`, `.env` = token sesi + secret alert. `chmod 600`, gitignored. Refresh token = akses penuh wallet — jangan commit/bagikan. Receiver loopback-only. Revoke: logout semua sesi di app Modulo (rotasi RT → token tersimpan jadi `invalid_grant`).

## File

| file | fungsi |
|---|---|
| `cli.mjs` | menu interaktif (tool utama) |
| `keeper.mjs` | keeper headless VPS + alert + auto task opsional |
| `telegram.mjs` | bot Telegram (fitur sama CLI) |
| `core.mjs` | shared: store, JWT, refresh, API, instrument/balance/quest/rewards, fee math, transfer, alert |
| `autotask.mjs` | orkestrasi quest: preapproval, convert, daily internal transfer, claim, loop harian |
| `dashboard.mjs` | TUI ANSI: tabel + ringkasan + log (nol dependency) |
| `token-receiver.mjs` | terima token dari extension → `wallets.json` |
| `extension/` | Chrome MV3: ambil sesi dari browser |
| `grab-token.mjs` | Playwright: login/grab dari profil browser |
| `modulo-wallet.mjs` | (legacy, **usang**) keeper single-`.env`; masih pakai endpoint daily-reward yang sudah dihapus Modulo |
| `modulo-wallet.service` | unit systemd |

## Endpoints (read-only kecuali ditandai)

`GET /api/canton/balances` · `/api/asset` · `/api/asset-blockchain` · `/api/subscription` ·
`/api/subscription-tier` · `/api/rewards/user-points` · `/api/rewards/exchange-rates` ·
`/api/user-quests[?status=active]` · `/api/user-quests/available` · `/api/user-quests/counts` ·
`/api/canton/transfer-preapproval` · `/api/referrals/me` · `/api/user/profile`

**Menulis:** `POST /api/auth/login` (ambil `partyId`) · `POST /api/canton/transfer-preapproval`
(enable token) · `POST /api/rewards/point-exchange` (convert poin) ·
`POST /api/user-quests/{progressId}/claim` (klaim quest) · `POST /api/canton/transfer` (kirim) ·
`POST {auth0}/oauth/token` (refresh).

> Endpoint reward lama (`/api/daily-reward/*`, `/api/canton/balances/mod`) sudah dihapus Modulo —
> diganti sistem poin + quest di atas.
