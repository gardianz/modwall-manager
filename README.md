# modwall-manager

Interactive **multi-wallet** session keeper + health monitor for Modulo
([app.modulo.finance/portfolio](https://app.modulo.finance/portfolio)).

- **CLI interaktif** (`cli.mjs`) — kelola banyak wallet: add (import sesi), lihat health, refresh, claim, bulk send, atur alert.
- **Session keeper** (`keeper.mjs`) — jalan headless di VPS, auto-refresh Auth0 token semua wallet, **alert Telegram/webhook kalau refresh token mati**.
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
1) List wallets        2) Add wallet (import)
3) Detail wallet       4) Refresh token now
5) Claim daily reward  6) Remove wallet
7) Bulk send (transfer)  8) Alerts (Telegram/webhook)
9) Keeper settings     10) Run keeper now      0) Exit
```

Data disimpan di `wallets.json` (token) + `config.json` (alert/keeper), keduanya `chmod 600`, gitignored.

## Claim daily reward (manual, bukan auto)

Menu `5) Claim` → pilih wallet (`1,3` / `all`) → tampil accrued per wallet → konfirmasi → klaim.
Klaim **manual** (kamu yang trigger). Keeper **tidak** auto-claim kecuali kamu set `enableClaim=true`
di `9) Keeper settings` (default off).

## Bulk send (transfer CC/MOD)

Menu `7) Bulk send`. Pilih **sender** (satu/`1,3`/`all`) dan **receiver**:
- **Wallet internal** — pilih dari daftar (multi). Alamat (partyId) diambil otomatis via `/api/auth/login`.
- **Alamat eksternal** — paste `partyId` receiver.

Aturan plan:
| sender | receiver | hasil |
|---|---|---|
| banyak | 1 | tiap sender → receiver itu (kumpulkan) |
| 1 | banyak | sender → tiap receiver (sebar) |
| N | N | pasangan per-indeks (jumlah harus sama) |

Asset `CC` (native) atau `MOD` (pakai `instrumentId`/`instrumentAdmin` otomatis).
Jumlah = angka per transfer, atau `max` (kirim seluruh saldo). Preview plan → ketik `KIRIM` untuk eksekusi.

## Telegram bot (fitur sama seperti CLI)

Set `botToken` + `chatId` di `8) Alerts`, lalu:
```bash
node telegram.mjs
```
Bot **hanya** merespon `chatId` yang di-authorize. Kirim `/menu` → tombol: Wallets, Detail,
Refresh all, Claim, Send, Keeper. `/send` & `/claim` = alur multi-step (balas teks):
- Send: pilih sender (`1,3`/`all`) → receiver (`w 1,2` atau `ext <partyId>`) → asset (`CC`/`MOD`) → jumlah (`1.5`/`max`) → `KIRIM`.
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

Keeper mengirim alert saat: 🔴 refresh token **mati** (`invalid_grant`), ⚠️ token expired tanpa RT, ⏳ subscription <3 hari & autoRenew off, ✅ pulih. Alert **dedup** (sekali per transisi, tidak spam).

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
| `keeper.mjs` | keeper headless VPS + alert |
| `telegram.mjs` | bot Telegram (fitur sama CLI: wallets/claim/send) |
| `core.mjs` | shared: store, JWT, refresh, API, alert, transfer |
| `token-receiver.mjs` | terima token dari extension → `wallets.json` |
| `extension/` | Chrome MV3: ambil sesi dari browser |
| `grab-token.mjs` | Playwright: login/grab dari profil browser |
| `modulo-wallet.mjs` | (legacy) keeper single-`.env` |
| `modulo-wallet.service` | unit systemd |

## Endpoints (read-only kecuali ditandai)
`GET /api/canton/balances` · `/api/canton/balances/mod` · `/api/subscription` ·
`/api/daily-reward/user-daily-reward` · `/api/referrals/me` ·
`POST /api/daily-reward/claim` (klaim) · `POST {auth0}/oauth/token` (refresh).
