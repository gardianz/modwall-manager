#!/usr/bin/env node
/**
 * Telegram control bot for the Modulo wallet manager — same actions as the interactive CLI:
 * list wallets, detail, refresh, claim (multi), bulk send (multi-step), keeper status.
 *
 * Setup: set botToken + chatId via `node cli.mjs` -> 8) Alerts, atau langsung di config.json.
 * Hanya membalas chatId yang di-authorize (cfg.alert.telegram.chatId). Jalankan: node telegram.mjs
 */
import {
  loadWallets, saveWallets, loadConfig,
  refreshWallet, walletHealth, claimDaily, getPartyId, balanceOf, transfer, planTransfers,
  tokenSecondsLeft, fmtDur, humanAmount, walletLabel, log, AuthError,
} from './core.mjs';

let cfg = loadConfig();
const TOKEN = cfg.alert.telegram.botToken;
let AUTH_CHAT = String(cfg.alert.telegram.chatId || '');
if (!TOKEN) { console.error('botToken kosong. Set via `node cli.mjs` -> 8) Alerts.'); process.exit(1); }
const API = `https://api.telegram.org/bot${TOKEN}`;

const sessions = new Map(); // chatId -> { flow, step, data }

async function tg(method, params) {
  const res = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  return res.json().catch(() => ({}));
}
const send = (chat, text, extra = {}) => tg('sendMessage', { chat_id: chat, text, disable_web_page_preview: true, ...extra });

const mainKb = { inline_keyboard: [
  [{ text: '📋 Wallets', callback_data: 'wallets' }, { text: '🔍 Detail', callback_data: 'detail' }],
  [{ text: '🔄 Refresh all', callback_data: 'refresh' }, { text: '🎁 Claim', callback_data: 'claim' }],
  [{ text: '💸 Send', callback_data: 'send' }, { text: '📡 Keeper', callback_data: 'keeper' }],
] };

function walletLine(w, i) {
  const left = w.dead ? 'DEAD' : (tokenSecondsLeft(w.accessToken) <= 0 ? (w.refreshToken ? 'expired(+RT)' : 'EXPIRED') : `valid ${fmtDur(tokenSecondsLeft(w.accessToken))}${w.refreshToken ? '+RT' : ''}`);
  return `${i + 1}. ${walletLabel(w)} — ${left}`;
}

function parseSel(text, wallets) {
  const a = text.trim().toLowerCase();
  if (a === 'all') return [...wallets];
  const idxs = a.split(',').map((x) => parseInt(x.trim(), 10) - 1).filter((i) => i >= 0 && i < wallets.length);
  return [...new Set(idxs)].map((i) => wallets[i]);
}

// ---- actions ----------------------------------------------------------------
async function doWallets(chat) {
  const w = loadWallets();
  if (!w.length) return send(chat, 'Belum ada wallet. Tambah via CLI: node cli.mjs -> 2.');
  return send(chat, '📋 Wallets:\n' + w.map(walletLine).join('\n'));
}

async function doRefreshAll(chat) {
  const wallets = loadWallets();
  const out = [];
  for (const w of wallets) {
    if (!w.refreshToken) { out.push(`• ${walletLabel(w)}: no RT`); continue; }
    try { await refreshWallet(w, cfg); w.dead = false; w.lastError = undefined; out.push(`✓ ${walletLabel(w)}: ${fmtDur(tokenSecondsLeft(w.accessToken))}`); }
    catch (e) { w.dead = true; w.lastError = e.message; out.push(`✗ ${walletLabel(w)}: ${e.message}`); }
  }
  saveWallets(wallets);
  return send(chat, '🔄 Refresh:\n' + out.join('\n'));
}

async function doDetail(chat, sel) {
  const wallets = loadWallets();
  const list = sel && sel.length ? sel : wallets;
  const out = [];
  for (const w of list) {
    try {
      const { cc, mod, sub, reward } = await walletHealth(w, cfg);
      const bal = (b) => b && !b._err ? `${humanAmount(b.totalBalance ?? b.balance, b.decimals ?? 10)} ${b.symbol}` : 'err';
      const days = sub && !sub._err && sub.endAt ? ((new Date(sub.endAt) - Date.now()) / 86400000).toFixed(1) : '?';
      out.push(`*${walletLabel(w)}*\n  ${bal(cc)} | ${bal(mod)}\n  sub ${sub?.status || '?'} (${days}d) | reward ${reward?.accruedQuantity ?? '?'}`);
    } catch (e) { out.push(`${walletLabel(w)}: ${e.message}`); }
  }
  saveWallets(wallets);
  return send(chat, out.join('\n\n'));
}

async function doKeeper(chat) {
  const wallets = loadWallets();
  const dead = wallets.filter((w) => w.dead).length;
  return send(chat, `📡 Keeper store: ${wallets.length} wallet, ${dead} DEAD.\nJalankan keeper headless: node keeper.mjs`);
}

// ---- claim flow -------------------------------------------------------------
async function startClaim(chat) {
  const wallets = loadWallets();
  if (!wallets.length) return send(chat, 'Belum ada wallet.');
  sessions.set(chat, { flow: 'claim', step: 'pick', data: {} });
  return send(chat, '🎁 Klaim — balas nomor wallet (mis `1,3`) atau `all`:\n' + wallets.map(walletLine).join('\n'));
}
async function claimStep(chat, text) {
  const s = sessions.get(chat); const wallets = loadWallets();
  if (s.step === 'pick') {
    const sel = parseSel(text, wallets);
    if (!sel.length) { sessions.delete(chat); return send(chat, 'Batal (pilihan kosong).'); }
    const rows = [];
    for (const w of sel) { try { const { reward } = await walletHealth(w, cfg); rows.push({ w, accrued: Number(reward?.accruedQuantity ?? 0) }); } catch (e) { rows.push({ w, accrued: 0, err: e.message }); } }
    saveWallets(wallets);
    const claimable = rows.filter((r) => r.accrued > 0);
    if (!claimable.length) { sessions.delete(chat); return send(chat, 'Tidak ada yang bisa diklaim:\n' + rows.map((r) => `• ${walletLabel(r.w)}: ${r.err || r.accrued}`).join('\n')); }
    s.data.ids = claimable.map((r) => r.w.id); s.step = 'confirm';
    return send(chat, 'Akan klaim:\n' + claimable.map((r) => `• ${walletLabel(r.w)}: ${r.accrued}`).join('\n') + '\n\nBalas `YA` untuk klaim.');
  }
  if (s.step === 'confirm') {
    if (text.trim().toUpperCase() !== 'YA') { sessions.delete(chat); return send(chat, 'Batal.'); }
    const out = [];
    for (const id of s.data.ids) {
      const w = wallets.find((x) => x.id === id); if (!w) continue;
      try { await claimDaily(w, cfg); out.push(`✓ ${walletLabel(w)}`); } catch (e) { out.push(`✗ ${walletLabel(w)}: ${e.message}`); }
    }
    saveWallets(wallets); sessions.delete(chat);
    return send(chat, '🎁 Hasil klaim:\n' + out.join('\n'));
  }
}

// ---- send flow --------------------------------------------------------------
async function startSend(chat) {
  const wallets = loadWallets();
  if (!wallets.length) return send(chat, 'Belum ada wallet.');
  sessions.set(chat, { flow: 'send', step: 'senders', data: {} });
  return send(chat, '💸 Bulk Send.\nSENDER — balas nomor (`1,3`) atau `all`:\n' + wallets.map(walletLine).join('\n'));
}
async function sendStep(chat, text) {
  const s = sessions.get(chat); const wallets = loadWallets();
  if (s.step === 'senders') {
    const sel = parseSel(text, wallets);
    if (!sel.length) { sessions.delete(chat); return send(chat, 'Batal.'); }
    s.data.senderIds = sel.map((w) => w.id); s.step = 'receiver';
    return send(chat, 'RECEIVER — balas `w 1,2` (wallet internal) atau `ext <partyId>` (alamat eksternal):\n' + wallets.map(walletLine).join('\n'));
  }
  if (s.step === 'receiver') {
    const t = text.trim();
    if (/^w\s+/i.test(t)) {
      const sel = parseSel(t.replace(/^w\s+/i, ''), wallets);
      if (!sel.length) return send(chat, 'Pilihan wallet kosong, ulangi.');
      const recv = [];
      for (const w of sel) { try { recv.push({ partyId: await getPartyId(w, cfg), label: walletLabel(w) }); } catch (e) { return send(chat, `partyId ${walletLabel(w)} gagal: ${e.message}`); } }
      saveWallets(wallets); s.data.receivers = recv;
    } else if (/^ext\s+/i.test(t)) {
      const addr = t.replace(/^ext\s+/i, '').trim();
      if (!addr) return send(chat, 'Alamat kosong, ulangi.');
      s.data.receivers = [{ partyId: addr, label: 'eksternal' }];
    } else return send(chat, 'Format salah. `w 1,2` atau `ext <partyId>`.');
    s.step = 'asset';
    return send(chat, 'Asset? balas `CC` atau `MOD`.');
  }
  if (s.step === 'asset') {
    s.data.symbol = (text.trim().toUpperCase() === 'MOD') ? 'MOD' : 'CC'; s.step = 'amount';
    return send(chat, 'Jumlah per transfer? angka (mis `1.5`) atau `max`.');
  }
  if (s.step === 'amount') {
    s.data.amount = text.trim();
    const senders = s.data.senderIds.map((id) => wallets.find((w) => w.id === id)).filter(Boolean);
    let plan;
    try { plan = planTransfers(senders, s.data.receivers, s.data.amount); }
    catch (e) { sessions.delete(chat); return send(chat, '✗ ' + e.message); }
    s.data.planIdx = plan.map((p) => ({ fromId: p.from.id, toPartyId: p.to.partyId, toLabel: p.to.label }));
    s.step = 'confirm';
    return send(chat, `Rencana (${plan.length} transfer, ${s.data.symbol}):\n` +
      plan.map((p, i) => `${i + 1}. ${walletLabel(p.from)} -> ${p.to.label}: ${s.data.amount} ${s.data.symbol}`).join('\n') +
      '\n\nBalas `KIRIM` untuk eksekusi.');
  }
  if (s.step === 'confirm') {
    if (text.trim().toUpperCase() !== 'KIRIM') { sessions.delete(chat); return send(chat, 'Batal.'); }
    const out = [];
    for (const [i, p] of s.data.planIdx.entries()) {
      const from = wallets.find((w) => w.id === p.fromId); if (!from) continue;
      try {
        let amount = s.data.amount;
        if (amount.toLowerCase() === 'max') { const b = await balanceOf(from, s.data.symbol, cfg); amount = humanAmount(b.totalBalance ?? b.balance, b.decimals ?? 10); }
        if (Number(amount) <= 0) { out.push(`• ${walletLabel(from)}: saldo 0, skip`); continue; }
        const r = await transfer(from, { receiverPartyId: p.toPartyId, amount, symbol: s.data.symbol }, cfg);
        out.push(`✓ ${i + 1}. ${walletLabel(from)} -> ${p.toLabel}: ${amount} ${s.data.symbol}${r?.status ? ` (${r.status})` : ''}`);
      } catch (e) { out.push(`✗ ${i + 1}. ${walletLabel(from)} -> ${p.toLabel}: ${e.message}`); }
      await new Promise((res) => setTimeout(res, 1200));
    }
    saveWallets(wallets); sessions.delete(chat);
    return send(chat, '💸 Hasil:\n' + out.join('\n'));
  }
}

// ---- dispatch ---------------------------------------------------------------
async function handleCommand(chat, cmd) {
  sessions.delete(chat);
  if (cmd === 'wallets') return doWallets(chat);
  if (cmd === 'refresh') return doRefreshAll(chat);
  if (cmd === 'detail') return doDetail(chat);
  if (cmd === 'keeper') return doKeeper(chat);
  if (cmd === 'claim') return startClaim(chat);
  if (cmd === 'send') return startSend(chat);
  return send(chat, 'Menu:', { reply_markup: mainKb });
}

async function onText(chat, text) {
  if (text.startsWith('/')) {
    const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();
    if (cmd === 'cancel') { sessions.delete(chat); return send(chat, 'Dibatalkan.'); }
    if (['start', 'menu'].includes(cmd)) return send(chat, 'Modulo Wallet Manager 🤖\nPilih:', { reply_markup: mainKb });
    return handleCommand(chat, cmd);
  }
  const s = sessions.get(chat);
  if (s?.flow === 'claim') return claimStep(chat, text);
  if (s?.flow === 'send') return sendStep(chat, text);
  return send(chat, 'Ketik /menu.', { reply_markup: mainKb });
}

// ---- long-poll loop ---------------------------------------------------------
async function poll() {
  let offset = 0;
  log(`telegram bot up. authChat=${AUTH_CHAT || '(belum di-set)'}`);
  for (;;) {
    try {
      const upd = await tg('getUpdates', { offset, timeout: 30 });
      for (const u of upd.result || []) {
        offset = u.update_id + 1;
        const msg = u.message || u.callback_query?.message;
        const chat = String(msg?.chat?.id || '');
        const fromId = String((u.message?.from || u.callback_query?.from)?.id || '');
        if (!chat) continue;
        // authorize: only the configured chatId. If unset, tell the user their id (once) and ignore.
        if (!AUTH_CHAT) { await send(chat, `chatId kamu: ${fromId}\nSet ini di CLI (8) Alerts) lalu restart bot.`); continue; }
        if (chat !== AUTH_CHAT && fromId !== AUTH_CHAT) { continue; }
        if (u.callback_query) {
          await tg('answerCallbackQuery', { callback_query_id: u.callback_query.id });
          await handleCommand(chat, u.callback_query.data);
        } else if (u.message?.text) {
          await onText(chat, u.message.text.trim());
        }
      }
    } catch (e) { log('poll error:', e.message); await new Promise((r) => setTimeout(r, 3000)); }
  }
}

poll();
