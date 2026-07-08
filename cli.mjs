#!/usr/bin/env node
// Interactive CLI to manage Modulo wallet sessions (multi-wallet).
import readline from 'node:readline';
import {
  loadWallets, saveWallets, loadConfig, saveConfig,
  parseImport, getUserinfo, refreshWallet, walletHealth, claimDaily,
  tokenSecondsLeft, fmtDur, humanAmount, sendAlert, walletLabel, decodeJwt, AuthError,
  getPartyId, balanceOf, transfer, planTransfers,
} from './core.mjs';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Single global line queue -> no lost lines / no race between prompts (which broke
// multi-line JSON paste when a line arrived in the gap before a listener attached).
const lineQ = [];
let lineWaiter = null;
rl.on('line', (l) => { if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(l); } else lineQ.push(l); });
function nextLine() { return new Promise((res) => { if (lineQ.length) res(lineQ.shift()); else lineWaiter = res; }); }

async function ask(q) { process.stdout.write(q); return (await nextLine()).trim(); }
const pause = () => ask('\n(enter untuk lanjut) ');

// Multi-line paste reader. Pretty-printed JSON arrives as many lines; collect until braces
// balance. A single-line token (JWT / one-line JSON) resolves on the first non-empty line.
async function askPaste(q) {
  process.stdout.write(q);
  let buf = [];
  let jsonMode = null;
  for (;;) {
    const line = await nextLine();
    buf.push(line);
    const joined = buf.join('\n').trim();
    if (!joined) { buf = []; continue; } // skip leading blanks
    if (jsonMode === null) jsonMode = /^[[{]/.test(joined);
    if (!jsonMode) return joined;
    const opens = (joined.match(/[[{]/g) || []).length;
    const closes = (joined.match(/[\]}]/g) || []).length;
    if (opens > 0 && closes >= opens) return joined;
  }
}

let wallets = loadWallets();
let cfg = loadConfig();
const persist = () => { saveWallets(wallets); saveConfig(cfg); };

function tokenState(w) {
  if (w.dead) return 'DEAD (refresh mati)';
  const left = tokenSecondsLeft(w.accessToken);
  if (left <= 0) return w.refreshToken ? 'expired (bisa refresh)' : 'EXPIRED (tak ada RT)';
  return `valid ${fmtDur(left)}${w.refreshToken ? ' +RT' : ' (no RT)'}`;
}

function listWallets() {
  console.log('\n=== Wallets ===');
  if (!wallets.length) { console.log('(kosong) — pilih "Add wallet".'); return; }
  wallets.forEach((w, i) => {
    console.log(`  [${i + 1}] ${walletLabel(w).padEnd(28)} ${tokenState(w)}${w.lastError ? '  err: ' + w.lastError : ''}`);
  });
}

async function pickWallet(prompt = 'Nomor wallet') {
  if (!wallets.length) { console.log('Belum ada wallet.'); return null; }
  listWallets();
  const a = await ask(`${prompt} (kosong=batal): `);
  if (!a) return null;
  const idx = parseInt(a, 10) - 1;
  if (idx < 0 || idx >= wallets.length) { console.log('Nomor tidak valid.'); return null; }
  return wallets[idx];
}

/** Multi-select: "1,3" | "all" | "" (batal). Returns array of wallets. */
async function pickWallets(prompt) {
  if (!wallets.length) { console.log('Belum ada wallet.'); return []; }
  listWallets();
  const a = await ask(`${prompt} (nomor pisah koma, "all", kosong=batal): `);
  if (!a) return [];
  if (a.toLowerCase() === 'all') return [...wallets];
  const idxs = a.split(',').map((x) => parseInt(x.trim(), 10) - 1).filter((i) => i >= 0 && i < wallets.length);
  return [...new Set(idxs)].map((i) => wallets[i]);
}

async function addWallet() {
  for (;;) {
    console.log('\n=== Add wallet (import sesi) ===');
    console.log('Tempel: access_token (JWT), JSON {access_token,refresh_token},');
    console.log('atau isi localStorage "@@auth0spajs@@..." dari browser (DevTools > Application).');
    const raw = await askPaste('Paste di sini (JSON multi-baris OK): ');
    const { accessToken, refreshToken } = parseImport(raw);
    if (!accessToken) {
      console.log('✗ Tidak menemukan access_token dari input.');
    } else {
      if (!refreshToken) console.log('⚠ Tidak ada refresh_token — wallet hanya hidup sampai access token ini expired (~24h).');
      const w = { accessToken, refreshToken, addedAt: new Date().toISOString() };
      console.log('Validasi ke Auth0 userinfo…');
      const info = await getUserinfo(accessToken, cfg).catch(() => null);
      if (info) { w.email = info.email; w.sub = info.sub; w.id = info.sub; }
      else {
        const p = decodeJwt(accessToken);
        w.sub = p?.sub; w.id = p?.sub || `wallet-${Date.now()}`;
        console.log('⚠ userinfo gagal (token mungkin expired) — tetap simpan pakai data JWT.');
      }
      // auto-label dari email (fallback: suffix sub) — tidak tanya user
      w.label = w.email || (w.sub ? w.sub.split('|').pop() : `wallet-${wallets.length + 1}`);
      const existing = wallets.findIndex((x) => x.id && w.id && x.id === w.id);
      if (existing >= 0) {
        wallets[existing] = { ...wallets[existing], ...w, dead: false, alertedDead: false, lastError: undefined };
        console.log(`✓ Wallet sudah ada — token diperbarui: ${w.label}`);
      } else { wallets.push({ ...w, dead: false }); console.log(`✓ Wallet ditambah: ${w.label}`); }
      persist();
    }
    const again = (await ask('\nTambah wallet lagi? (y/N) ')).toLowerCase();
    if (again !== 'y') return;
  }
}

async function showDetail() {
  const w = await pickWallet();
  if (!w) return;
  console.log(`\n=== ${walletLabel(w)} ===`);
  try {
    const { cc, mod, sub, reward, refs } = await walletHealth(w, cfg);
    persist(); // token may have been refreshed
    const bal = (b) => b && !b._err ? `${humanAmount(b.totalBalance ?? b.balance, b.decimals ?? 10)} ${b.symbol}` : `err(${b?._err})`;
    console.log(`balances : ${bal(cc)} | ${bal(mod)}`);
    if (sub && !sub._err) {
      const days = sub.endAt ? (new Date(sub.endAt) - Date.now()) / 86400000 : NaN;
      console.log(`sub      : ${sub.status}/${sub.state} autoRenew=${sub.autoRenew} ends ${String(sub.endAt).slice(0, 10)}${Number.isFinite(days) ? ` (${days.toFixed(1)}d)` : ''}`);
    } else console.log(`sub      : err(${sub?._err})`);
    if (reward && !reward._err) console.log(`reward   : accrued ${reward.accruedQuantity} status ${reward.status} lastSent ${reward.lastSentAt || 'never'}`);
    if (refs && !refs._err) console.log(`referral : ${refs.myCode} invited ${refs.referreeCount}`);
    console.log(`token    : ${tokenState(w)}`);
  } catch (e) {
    if (e instanceof AuthError) { w.dead = true; w.lastError = e.message; persist(); console.log(`AUTH mati: ${e.message}`); }
    else console.log('error:', e.message);
  }
}

async function refreshNow() {
  const w = await pickWallet();
  if (!w) return;
  try { await refreshWallet(w, cfg); w.dead = false; w.lastError = undefined; persist(); console.log(`✓ refreshed (valid ${fmtDur(tokenSecondsLeft(w.accessToken))})`); }
  catch (e) { w.dead = true; w.lastError = e.message; persist(); console.log(`✗ refresh gagal: ${e.message}`); }
}

async function claimMenu() {
  const sel = await pickWallets('Wallet untuk klaim daily reward');
  if (!sel.length) return;
  console.log('\nCek accrued…');
  const rows = [];
  for (const w of sel) {
    try {
      const { reward } = await walletHealth(w, cfg);
      rows.push({ w, accrued: Number(reward?.accruedQuantity ?? 0) });
    } catch (e) { rows.push({ w, accrued: 0, err: e.message }); }
  }
  persist();
  rows.forEach((r) => console.log(`  ${walletLabel(r.w).padEnd(28)} accrued ${r.err ? 'err: ' + r.err : r.accrued}`));
  const claimable = rows.filter((r) => r.accrued > 0);
  if (!claimable.length) { console.log('Tidak ada yang bisa diklaim.'); return; }
  const total = claimable.reduce((s, r) => s + r.accrued, 0);
  if ((await ask(`\nKlaim ${claimable.length} wallet (total ~${total.toFixed(4)})? (y/N) `)).toLowerCase() !== 'y') return;
  for (const r of claimable) {
    try { await claimDaily(r.w, cfg); persist(); console.log(`  ✓ ${walletLabel(r.w)}: claimed ${r.accrued}`); }
    catch (e) { console.log(`  ✗ ${walletLabel(r.w)}: ${e.message}`); }
  }
}

// ---- bulk sender -------------------------------------------------------------
async function sendMenu() {
  console.log('\n=== Bulk Send ===');
  const senders = await pickWallets('SENDER (dari wallet mana)');
  if (!senders.length) return;

  console.log('\nReceiver:');
  console.log('  1) Wallet internal (pilih dari daftar)');
  console.log('  2) Alamat eksternal (paste partyId)');
  const rtype = await ask('Pilih receiver (1/2): ');
  let receivers = [];
  if (rtype === '1') {
    const rw = await pickWallets('RECEIVER (ke wallet mana)');
    if (!rw.length) return;
    console.log('Ambil partyId receiver…');
    for (const w of rw) {
      try { const pid = await getPartyId(w, cfg); receivers.push({ partyId: pid, label: walletLabel(w) }); }
      catch (e) { console.log(`  ✗ partyId ${walletLabel(w)}: ${e.message}`); }
    }
    persist();
  } else if (rtype === '2') {
    const addr = (await askPaste('Paste alamat receiver (partyId): ')).trim();
    if (!addr) return;
    receivers.push({ partyId: addr, label: 'eksternal' });
  } else return;
  if (!receivers.length) { console.log('Tidak ada receiver valid.'); return; }

  const symbol = ((await ask('Asset (CC/MOD) [CC]: ')) || 'CC').toUpperCase();
  const amtRaw = (await ask('Jumlah per transfer (angka, atau "max"): ')).trim();
  if (!amtRaw) return;

  let plan;
  try { plan = planTransfers(senders, receivers, amtRaw); }
  catch (e) { console.log('✗', e.message); return; }

  console.log(`\nRencana (${plan.length} transfer, asset ${symbol}):`);
  plan.forEach((p, i) => console.log(`  ${i + 1}. ${walletLabel(p.from)} -> ${p.to.label} : ${amtRaw} ${symbol}`));
  if ((await ask(`\nEksekusi ${plan.length} transfer? ketik "KIRIM" untuk lanjut: `)) !== 'KIRIM') { console.log('batal.'); return; }

  for (const [i, p] of plan.entries()) {
    let amount = amtRaw;
    try {
      if (amtRaw.toLowerCase() === 'max') {
        const b = await balanceOf(p.from, symbol, cfg);
        amount = humanAmount(b.totalBalance ?? b.balance, b.decimals ?? 10);
      }
      if (Number(amount) <= 0) { console.log(`  ${i + 1}. ${walletLabel(p.from)}: saldo 0, skip`); continue; }
      const r = await transfer(p.from, { receiverPartyId: p.to.partyId, amount, symbol }, cfg);
      persist();
      console.log(`  ✓ ${i + 1}. ${walletLabel(p.from)} -> ${p.to.label}: ${amount} ${symbol}`, r?.status ? `(${r.status})` : '');
    } catch (e) { console.log(`  ✗ ${i + 1}. ${walletLabel(p.from)} -> ${p.to.label}: ${e.message}`); }
    await new Promise((res) => setTimeout(res, 1200)); // pacing
  }
}

async function removeWallet() {
  const w = await pickWallet('Nomor wallet (hapus)');
  if (!w) return;
  if ((await ask(`Hapus "${walletLabel(w)}"? (y/N) `)).toLowerCase() !== 'y') return;
  wallets = wallets.filter((x) => x !== w); persist();
  console.log('✓ dihapus.');
}

async function alertsMenu() {
  for (;;) {
    const tg = cfg.alert.telegram;
    console.log('\n=== Alerts ===');
    console.log(`  [1] Telegram botToken : ${tg.botToken ? '****' + tg.botToken.slice(-6) : '(kosong)'}`);
    console.log(`  [2] Telegram chatId   : ${tg.chatId || '(kosong)'}`);
    console.log(`  [3] Webhook URL       : ${cfg.alert.webhookUrl || '(kosong)'}`);
    console.log('  [4] Kirim test alert');
    console.log('  [0] Kembali');
    const a = await ask('Pilih: ');
    if (a === '1') { tg.botToken = await ask('Telegram bot token (dari @BotFather): '); persist(); }
    else if (a === '2') { tg.chatId = await ask('Telegram chat id (dari @userinfobot): '); persist(); }
    else if (a === '3') { cfg.alert.webhookUrl = await ask('Webhook URL (Discord/Slack/dll): '); persist(); }
    else if (a === '4') { const r = await sendAlert(cfg, '✅ Test alert dari modulo-wallet-keeper'); console.log('hasil:', JSON.stringify(r)); }
    else if (a === '0' || a === '') return;
  }
}

async function keeperSettings() {
  const k = cfg.keeper;
  console.log('\n=== Keeper settings ===');
  console.log(`  [1] checkEveryMin  : ${k.checkEveryMin}`);
  console.log(`  [2] refreshSkewSec : ${k.refreshSkewSec}`);
  console.log(`  [3] enableClaim    : ${k.enableClaim}`);
  console.log(`  [4] claimMin       : ${k.claimMin}`);
  console.log('  [0] Kembali');
  const a = await ask('Ubah nomor (kosong=batal): ');
  if (a === '1') k.checkEveryMin = parseInt(await ask('menit: '), 10) || k.checkEveryMin;
  else if (a === '2') k.refreshSkewSec = parseInt(await ask('detik: '), 10) || k.refreshSkewSec;
  else if (a === '3') k.enableClaim = /^(y|1|true|on)/i.test(await ask('enable claim? (y/n): '));
  else if (a === '4') k.claimMin = Number(await ask('min accrued: ')) || 0;
  persist();
}

async function main() {
  console.log('Modulo Wallet Manager — CLI interaktif');
  for (;;) {
    console.log('\n========================================');
    console.log(` Wallets: ${wallets.length} | Alert: ${cfg.alert.telegram.botToken || cfg.alert.webhookUrl ? 'ON' : 'off'} | Claim: ${cfg.keeper.enableClaim ? 'ON' : 'off'}`);
    console.log('========================================');
    console.log('  1) List wallets           2) Add wallet (import)');
    console.log('  3) Detail wallet          4) Refresh token now');
    console.log('  5) Claim daily reward     6) Remove wallet');
    console.log('  7) Bulk send (transfer)   8) Alerts (Telegram/webhook)');
    console.log('  9) Keeper settings        10) Run keeper now (watch semua)');
    console.log('  0) Exit');
    const a = await ask('Pilih: ');
    try {
      if (a === '1') { listWallets(); await pause(); }
      else if (a === '2') { await addWallet(); }
      else if (a === '3') { await showDetail(); await pause(); }
      else if (a === '4') { await refreshNow(); await pause(); }
      else if (a === '5') { await claimMenu(); await pause(); }
      else if (a === '6') { await removeWallet(); await pause(); }
      else if (a === '7') { await sendMenu(); await pause(); }
      else if (a === '8') { await alertsMenu(); }
      else if (a === '9') { await keeperSettings(); }
      else if (a === '10') { rl.close(); const { runKeeper } = await import('./keeper.mjs'); await runKeeper(); return; }
      else if (a === '0' || a === '') { rl.close(); return; }
    } catch (e) { console.log('error:', e.message); await pause(); }
  }
}

main();
