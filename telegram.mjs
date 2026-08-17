#!/usr/bin/env node
/**
 * Telegram control bot for the Modulo wallet manager — same actions as the interactive CLI:
 * list wallets, detail, refresh, claim quests, preapproval, convert points, bulk send, auto task.
 *
 * Setup: set botToken + chatId via `node cli.mjs` -> 8) Alerts, atau langsung di config.json.
 * Hanya membalas chatId yang di-authorize (cfg.alert.telegram.chatId). Jalankan: node telegram.mjs
 */
import {
  loadWallets, saveWallets, loadConfig,
  refreshWallet, walletHealth, fmtBalances, fmtUsd,
  getPartyId, getClaimableQuests, claimQuest, getPreapprovals, getInstruments,
  instrumentBySymbol, availableOf, transfer, planTransfers, pickFeeInstrument,
  transferFeeUsdFor, toUnits, fromUnits, subscriptionDaysRemaining,
  tokenSecondsLeft, fmtDur, walletLabel, log,
} from './core.mjs';
import {
  loadContext, preapproveAll, missingPreapprovals, previewConvert, pickConvertTarget,
  convertPoints, runAutoTasks, planSubscriptionExtend, extendSubscription,
} from './autotask.mjs';

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
const send = (chat, text, extra = {}) => tg('sendMessage', { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true, ...extra });

const mainKb = { inline_keyboard: [
  [{ text: '📋 Wallets', callback_data: 'wallets' }, { text: '🔍 Detail', callback_data: 'detail' }],
  [{ text: '🔄 Refresh all', callback_data: 'refresh' }, { text: '🎁 Claim quest', callback_data: 'claim' }],
  [{ text: '🔓 Preapproval', callback_data: 'preapprove' }, { text: '♻️ Convert', callback_data: 'convert' }],
  [{ text: '💸 Send', callback_data: 'send' }, { text: '🤖 Auto task', callback_data: 'autotask' }],
  [{ text: '🗓 Subscription', callback_data: 'subscription' }, { text: '📡 Keeper', callback_data: 'keeper' }],
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
      const { balances, sub, points, counts } = await walletHealth(w, cfg);
      const days = sub && !sub._err && sub.endAt ? ((new Date(sub.endAt) - Date.now()) / 86400000).toFixed(1) : '?';
      out.push(`${walletLabel(w)}\n  ${fmtBalances(balances)}\n  sub ${sub?.status || '?'} (${days}d) | poin ${points?.claimable?.pointsBalance ?? '?'} | quest siap ${counts?.active ?? '?'}`);
    } catch (e) { out.push(`${walletLabel(w)}: ${e.message}`); }
  }
  saveWallets(wallets);
  return send(chat, out.join('\n\n'));
}

async function doKeeper(chat) {
  const wallets = loadWallets();
  const dead = wallets.filter((w) => w.dead).length;
  return send(chat, `📡 Keeper store: ${wallets.length} wallet, ${dead} DEAD.\nAuto task: ${cfg.autoTask.enabled ? 'ON' : 'off'} | guard fee ${fmtUsd(cfg.autoTask.maxFeeUsd)}\nJalankan keeper headless: node keeper.mjs`);
}

// ---- claim flow -------------------------------------------------------------
async function startClaim(chat) {
  const wallets = loadWallets();
  if (!wallets.length) return send(chat, 'Belum ada wallet.');
  sessions.set(chat, { flow: 'claim', step: 'pick', data: {} });
  return send(chat, '🎁 Klaim quest — balas nomor wallet (mis `1,3`) atau `all`:\n' + wallets.map(walletLine).join('\n'));
}
async function claimStep(chat, text) {
  const s = sessions.get(chat); const wallets = loadWallets();
  if (s.step === 'pick') {
    const sel = parseSel(text, wallets);
    if (!sel.length) { sessions.delete(chat); return send(chat, 'Batal (pilihan kosong).'); }
    const rows = [];
    for (const w of sel) { try { rows.push({ w, quests: await getClaimableQuests(w, cfg) }); } catch (e) { rows.push({ w, quests: [], err: e.message }); } }
    saveWallets(wallets);
    const claimable = rows.filter((r) => r.quests.length);
    if (!claimable.length) { sessions.delete(chat); return send(chat, 'Tidak ada quest yang bisa diklaim.'); }
    s.data.ids = claimable.map((r) => ({ id: r.w.id, quests: r.quests.map((q) => ({ id: q.id, task: q.task, pts: q.rewardPoints })) }));
    s.step = 'confirm';
    return send(chat, 'Akan klaim:\n' + claimable.map((r) => `• ${walletLabel(r.w)}\n` + r.quests.map((q) => `   - ${q.task} (+${q.rewardPoints})`).join('\n')).join('\n') + '\n\nBalas `YA` untuk klaim.');
  }
  if (s.step === 'confirm') {
    if (text.trim().toUpperCase() !== 'YA') { sessions.delete(chat); return send(chat, 'Batal.'); }
    const out = [];
    for (const row of s.data.ids) {
      const w = wallets.find((x) => x.id === row.id); if (!w) continue;
      for (const q of row.quests) {
        try { await claimQuest(w, q.id, cfg); out.push(`✓ ${walletLabel(w)}: ${q.task} +${q.pts}`); }
        catch (e) { out.push(`✗ ${walletLabel(w)}: ${q.task} — ${e.message}`); }
        await new Promise((r) => setTimeout(r, 900));
      }
    }
    saveWallets(wallets); sessions.delete(chat);
    return send(chat, '🎁 Hasil klaim:\n' + out.join('\n'));
  }
}

// ---- preapproval flow -------------------------------------------------------
async function startPreapprove(chat) {
  const wallets = loadWallets();
  if (!wallets.length) return send(chat, 'Belum ada wallet.');
  sessions.set(chat, { flow: 'preapprove', step: 'pick', data: {} });
  return send(chat, '🔓 Preapproval — balas nomor wallet (`1,3`) atau `all`:\n' + wallets.map(walletLine).join('\n'));
}
async function preapproveStep(chat, text) {
  const s = sessions.get(chat); const wallets = loadWallets();
  if (s.step === 'pick') {
    const sel = parseSel(text, wallets);
    if (!sel.length) { sessions.delete(chat); return send(chat, 'Batal.'); }
    const out = []; const todo = [];
    for (const w of sel) {
      try {
        const miss = missingPreapprovals(await getInstruments(w, cfg), await getPreapprovals(w, cfg));
        if (miss.length) { todo.push(w.id); out.push(`• ${walletLabel(w)}: ${miss.map((m) => m.symbol).join(', ')}`); }
        else out.push(`• ${walletLabel(w)}: semua sudah aktif ✓`);
      } catch (e) { out.push(`• ${walletLabel(w)}: err ${e.message}`); }
    }
    saveWallets(wallets);
    if (!todo.length) { sessions.delete(chat); return send(chat, 'Semua token sudah preapproved:\n' + out.join('\n')); }
    s.data.ids = todo; s.step = 'confirm';
    return send(chat, 'Token yang belum di-enable:\n' + out.join('\n') + '\n\nBalas `YA` untuk enable semua.');
  }
  if (s.step === 'confirm') {
    if (text.trim().toUpperCase() !== 'YA') { sessions.delete(chat); return send(chat, 'Batal.'); }
    const out = [];
    for (const id of s.data.ids) {
      const w = wallets.find((x) => x.id === id); if (!w) continue;
      const r = await preapproveAll(w, cfg, { onLog: () => {} }).catch((e) => ({ results: [{ ok: false, symbol: '-', error: e.message }] }));
      out.push(`${walletLabel(w)}: ` + (r.results.map((x) => `${x.ok ? '✓' : '✗'}${x.symbol}`).join(' ') || 'tidak ada perubahan'));
    }
    saveWallets(wallets); sessions.delete(chat);
    return send(chat, '🔓 Preapproval:\n' + out.join('\n'));
  }
}

// ---- convert flow -----------------------------------------------------------
async function startConvert(chat) {
  const wallets = loadWallets();
  if (!wallets.length) return send(chat, 'Belum ada wallet.');
  sessions.set(chat, { flow: 'convert', step: 'pick', data: {} });
  return send(chat, '♻️ Convert poin — balas nomor wallet (`1,3`) atau `all`:\n' + wallets.map(walletLine).join('\n'));
}
async function convertStep(chat, text) {
  const s = sessions.get(chat); const wallets = loadWallets();
  if (s.step === 'pick') {
    const sel = parseSel(text, wallets);
    if (!sel.length) { sessions.delete(chat); return send(chat, 'Batal.'); }
    const out = []; const ready = [];
    for (const w of sel) {
      try {
        const ctx = await loadContext(w, cfg);
        const pv = previewConvert(ctx);
        if (!pv.canExchange) { out.push(`• ${walletLabel(w)}: poin ${pv.pointsBalance} < min ${pv.minPoints}`); continue; }
        const auto = pickConvertTarget(pv, { balances: ctx.balances, prefer: cfg.autoTask.convertPreferSymbols });
        if (!auto) { out.push(`• ${walletLabel(w)}: tidak ada target layak (cek preapproval)`); continue; }
        ready.push(w.id);
        out.push(`• ${walletLabel(w)}: ${pv.usePoints} poin -> ${auto.net} ${auto.symbol} (fee ${fmtUsd(auto.feeUsd)}${auto.discountPercent ? `, -${auto.discountPercent}%` : ''})`);
      } catch (e) { out.push(`• ${walletLabel(w)}: err ${e.message}`); }
    }
    saveWallets(wallets);
    if (!ready.length) { sessions.delete(chat); return send(chat, 'Tidak ada yang bisa di-convert:\n' + out.join('\n')); }
    s.data.ids = ready; s.step = 'symbol';
    return send(chat, out.join('\n') + '\n\nBalas `AUTO` untuk pakai target di atas, atau ketik simbol (mis `CBTC`).');
  }
  if (s.step === 'symbol') {
    const t = text.trim();
    s.data.symbol = /^auto$/i.test(t) ? null : t;
    s.step = 'confirm';
    return send(chat, `Target: ${s.data.symbol || 'AUTO (token diskon / yang sudah dipegang)'}\n\nBalas \`CONVERT\` untuk eksekusi.`);
  }
  if (s.step === 'confirm') {
    if (text.trim().toUpperCase() !== 'CONVERT') { sessions.delete(chat); return send(chat, 'Batal.'); }
    const out = [];
    for (const id of s.data.ids) {
      const w = wallets.find((x) => x.id === id); if (!w) continue;
      try {
        const r = await convertPoints(w, cfg, { symbol: s.data.symbol });
        if (r.skipped) out.push(`✗ ${walletLabel(w)}: ${r.skipped}`);
        else out.push(`✓ ${walletLabel(w)}: ${r.result?.amountReceived ?? r.target.net} ${r.target.symbol} (${r.result?.status ?? '?'})`);
      } catch (e) { out.push(`✗ ${walletLabel(w)}: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 1200));
    }
    saveWallets(wallets); sessions.delete(chat);
    return send(chat, '♻️ Hasil convert:\n' + out.join('\n'));
  }
}

// ---- subscription flow ------------------------------------------------------
async function startSubscription(chat) {
  const wallets = loadWallets();
  if (!wallets.length) return send(chat, 'Belum ada wallet.');
  sessions.set(chat, { flow: 'subscription', step: 'pick', data: {} });
  return send(chat, '🗓 Extend subscription — balas nomor wallet (`1,3`) atau `all`:\n' + wallets.map(walletLine).join('\n'));
}
async function subscriptionStep(chat, text) {
  const s = sessions.get(chat); const wallets = loadWallets();
  if (s.step === 'pick') {
    const sel = parseSel(text, wallets);
    if (!sel.length) { sessions.delete(chat); return send(chat, 'Batal.'); }
    const out = []; const ready = [];
    for (const w of sel) {
      try {
        const ctx = await loadContext(w, cfg);
        const days = subscriptionDaysRemaining(ctx.sub);
        const { plan, skipped } = await planSubscriptionExtend(w, cfg, { ctx, force: true });
        if (!plan) { out.push(`• ${walletLabel(w)}: sisa ${days}d — ${skipped}`); continue; }
        ready.push(w.id);
        out.push(`• ${walletLabel(w)}: ${plan.tier.name}, sisa ${days}d → bayar ${plan.pay.quantity} ${plan.pay.symbol} (${fmtUsd(plan.pay.usd)}${plan.pay.discountPercent ? `, -${plan.pay.discountPercent}%` : ''})`);
      } catch (e) { out.push(`• ${walletLabel(w)}: err ${e.message}`); }
    }
    saveWallets(wallets);
    if (!ready.length) { sessions.delete(chat); return send(chat, 'Tidak ada yang bisa di-extend:\n' + out.join('\n')); }
    s.data.ids = ready; s.step = 'confirm';
    return send(chat, out.join('\n') + '\n\nBalas `EXTEND` untuk eksekusi.');
  }
  if (s.step === 'confirm') {
    if (text.trim().toUpperCase() !== 'EXTEND') { sessions.delete(chat); return send(chat, 'Batal.'); }
    const out = [];
    for (const id of s.data.ids) {
      const w = wallets.find((x) => x.id === id); if (!w) continue;
      try {
        const r = await extendSubscription(w, cfg, { force: true });
        if (r.skipped) out.push(`✗ ${walletLabel(w)}: ${r.skipped}`);
        else out.push(`✓ ${walletLabel(w)}: ${r.result?.status ?? '?'} s/d ${String(r.result?.endAt ?? '?').slice(0, 10)}`);
      } catch (e) { out.push(`✗ ${walletLabel(w)}: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 1200));
    }
    saveWallets(wallets); sessions.delete(chat);
    return send(chat, '🗓 Hasil extend:\n' + out.join('\n'));
  }
}

// ---- auto task flow ---------------------------------------------------------
async function startAuto(chat) {
  const wallets = loadWallets();
  if (!wallets.length) return send(chat, 'Belum ada wallet.');
  sessions.set(chat, { flow: 'autotask', step: 'pick', data: {} });
  const at = cfg.autoTask;
  return send(chat, `🤖 Auto task (preapproval -> convert -> internal transfer -> claim)\n` +
    `dilewati: ${(at.skipSlugs || []).join(', ')}\nguard fee ${fmtUsd(at.maxFeeUsd)} | transfer ${fmtUsd(at.internalTransferUsd)}\n\n` +
    'Balas nomor wallet (`1,3`) atau `all`:\n' + wallets.map(walletLine).join('\n'));
}
async function autoStep(chat, text) {
  const s = sessions.get(chat); const wallets = loadWallets();
  if (s.step === 'pick') {
    const sel = parseSel(text, wallets);
    if (!sel.length) { sessions.delete(chat); return send(chat, 'Batal.'); }
    s.data.ids = sel.map((w) => w.id); s.step = 'confirm';
    const out = [];
    for (const w of sel) {
      const lines = [];
      try { await runAutoTasks(w, wallets, cfg, { dryRun: true, onLog: (m) => lines.push('  ' + m) }); }
      catch (e) { lines.push('  fatal: ' + e.message); }
      out.push(`${walletLabel(w)}\n${lines.join('\n') || '  (tidak ada aksi)'}`);
    }
    saveWallets(wallets);
    return send(chat, '🔎 Dry-run:\n' + out.join('\n\n') + '\n\nBalas `JALAN` untuk eksekusi beneran.');
  }
  if (s.step === 'confirm') {
    if (text.trim().toUpperCase() !== 'JALAN') { sessions.delete(chat); return send(chat, 'Batal.'); }
    const out = [];
    for (const id of s.data.ids) {
      const w = wallets.find((x) => x.id === id); if (!w) continue;
      const lines = [];
      try { const rep = await runAutoTasks(w, wallets, cfg, { onLog: (m) => lines.push('  ' + m) }); if (rep.errors.length) lines.push('  ⚠ ' + rep.errors.join(' | ')); }
      catch (e) { lines.push('  ✗ fatal: ' + e.message); }
      out.push(`${walletLabel(w)}\n${lines.join('\n')}`);
      saveWallets(wallets);
    }
    sessions.delete(chat);
    return send(chat, '🤖 Auto task selesai:\n' + out.join('\n\n'));
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
    return send(chat, 'Asset? balas simbol: `CBTC`, `cETH`, `CC`, `MOD`, `USDCx`.');
  }
  if (s.step === 'asset') {
    s.data.symbol = text.trim(); s.step = 'amount';
    return send(chat, 'Jumlah per transfer? angka (mis `0.0001`) atau `max`.');
  }
  if (s.step === 'amount') {
    s.data.amount = text.trim();
    const senders = s.data.senderIds.map((id) => wallets.find((w) => w.id === id)).filter(Boolean);
    let plan;
    try { plan = planTransfers(senders, s.data.receivers, s.data.amount); }
    catch (e) { sessions.delete(chat); return send(chat, '✗ ' + e.message); }

    const prepared = []; const lines = [];
    for (const p of plan) {
      try {
        const ctx = await loadContext(p.from, cfg);
        const inst = instrumentBySymbol(ctx.instruments, s.data.symbol);
        if (!inst) throw new Error(`asset ${s.data.symbol} tidak dikenal`);
        let quantity = s.data.amount;
        if (/^max$/i.test(quantity)) quantity = availableOf(ctx.balances, inst.symbol);
        const fee = pickFeeInstrument({
          instruments: ctx.instruments, balances: ctx.balances, preapproved: ctx.preapproved,
          baseUsd: transferFeeUsdFor(p.to.partyId, ctx.tier), rates: ctx.rates,
          transferInstrumentId: inst.instrumentId, transferQuantity: '0',
          prefer: cfg.autoTask.feeInstrumentPref,
        });
        if (!fee) throw new Error('tidak ada token yang cukup untuk bayar fee');
        if (/^max$/i.test(s.data.amount) && fee.instrumentId === inst.instrumentId) {
          const left = toUnits(quantity, inst.decimals) - toUnits(fee.quantity, fee.decimals);
          quantity = fromUnits(left > 0n ? left : 0n, inst.decimals);
        }
        if (toUnits(quantity, inst.decimals) <= 0n) throw new Error('saldo tidak cukup setelah fee');
        prepared.push({ fromId: p.from.id, toPartyId: p.to.partyId, toLabel: p.to.label, instrumentId: inst.instrumentId, symbol: inst.symbol, quantity, feeInstrumentId: fee.instrumentId });
        lines.push(`${walletLabel(p.from)} -> ${p.to.label}: ${quantity} ${inst.symbol} (fee ${fee.quantity} ${fee.symbol}, ${fmtUsd(fee.usd)})`);
      } catch (e) { lines.push(`${walletLabel(p.from)} -> ${p.to.label}: ✗ ${e.message}`); }
    }
    saveWallets(wallets);
    if (!prepared.length) { sessions.delete(chat); return send(chat, 'Tidak ada transfer yang layak:\n' + lines.join('\n')); }
    s.data.prepared = prepared; s.step = 'confirm';
    return send(chat, `Rencana (${prepared.length} transfer):\n` + lines.join('\n') + '\n\nBalas `KIRIM` untuk eksekusi.');
  }
  if (s.step === 'confirm') {
    if (text.trim().toUpperCase() !== 'KIRIM') { sessions.delete(chat); return send(chat, 'Batal.'); }
    const out = [];
    for (const [i, p] of s.data.prepared.entries()) {
      const from = wallets.find((w) => w.id === p.fromId); if (!from) continue;
      try {
        const r = await transfer(from, { receiverPartyId: p.toPartyId, quantity: p.quantity, instrumentId: p.instrumentId, feeInstrumentId: p.feeInstrumentId }, cfg);
        out.push(`✓ ${i + 1}. ${walletLabel(from)} -> ${p.toLabel}: ${p.quantity} ${p.symbol}${r?.updateId ? ` (${String(r.updateId).slice(0, 10)}…)` : ''}`);
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
  if (cmd === 'preapprove') return startPreapprove(chat);
  if (cmd === 'convert') return startConvert(chat);
  if (cmd === 'autotask') return startAuto(chat);
  if (cmd === 'subscription') return startSubscription(chat);
  return send(chat, 'Menu:', { reply_markup: mainKb });
}

const FLOW_STEPS = {
  claim: claimStep, send: sendStep, preapprove: preapproveStep,
  convert: convertStep, autotask: autoStep, subscription: subscriptionStep,
};

async function onText(chat, text) {
  if (text.startsWith('/')) {
    const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();
    if (cmd === 'cancel') { sessions.delete(chat); return send(chat, 'Dibatalkan.'); }
    if (['start', 'menu'].includes(cmd)) return send(chat, 'Modulo Wallet Manager 🤖\nPilih:', { reply_markup: mainKb });
    return handleCommand(chat, cmd);
  }
  const s = sessions.get(chat);
  const step = s && FLOW_STEPS[s.flow];
  if (step) return step(chat, text);
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
