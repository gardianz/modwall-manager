#!/usr/bin/env node
// Interactive CLI to manage Modulo wallet sessions (multi-wallet).
import readline from 'node:readline';
import {
  loadWallets, saveWallets, loadConfig, saveConfig,
  parseImport, getUserinfo, refreshWallet, walletHealth,
  tokenSecondsLeft, fmtDur, fmtUsd, fmtBalances, sendAlert, walletLabel, decodeJwt, AuthError,
  getPartyId, getBalances, availableOf, getInstruments, instrumentBySymbol, getPreapprovals,
  getClaimableQuests, claimQuest, getQuests, getMyTier, getExchangeRates, getPoints,
  transfer, planTransfers, pickFeeInstrument, transferFeeUsdFor,
  pickSubscriptionPayment, subscriptionDaysRemaining, EXTEND_WINDOW_DAYS,
  toUnits, fromUnits, truncDecimals,
} from './core.mjs';
import {
  loadContext, preapproveAll, missingPreapprovals, previewConvert, pickConvertTarget,
  convertPoints, resolvePeers, runAutoTasks, runAutoTasksLoop, pendingDailyWork,
  planSubscriptionExtend, extendSubscription,
} from './autotask.mjs';

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
    const { balances, sub, points, counts, refs } = await walletHealth(w, cfg);
    persist(); // token may have been refreshed
    console.log(`balances : ${fmtBalances(balances)}`);
    if (sub && !sub._err) {
      const days = sub.endAt ? (new Date(sub.endAt) - Date.now()) / 86400000 : NaN;
      console.log(`sub      : ${sub.status}/${sub.state} ends ${String(sub.endAt).slice(0, 10)}${Number.isFinite(days) ? ` (${days.toFixed(1)}d)` : ''}`);
    } else console.log(`sub      : err(${sub?._err})`);
    if (points && !points._err) {
      const c = points.claimable || {};
      console.log(`poin     : ${c.pointsBalance} (min convert ${c.pointsConvertMinimumPoints}, bisa convert: ${c.canExchangePoints ? 'ya' : 'belum'})`);
    }
    if (counts && !counts._err) console.log(`quest    : ${counts.active} bisa diklaim, ${counts.completed} selesai, ${counts.expired} hangus`);
    if (refs && !refs._err) console.log(`referral : ${refs.myCode} invited ${refs.referreeCount}`);
    const pre = await getPreapprovals(w, cfg).catch(() => null);
    const inst = await getInstruments(w, cfg).catch(() => null);
    if (pre && inst) {
      const miss = missingPreapprovals(inst, pre).map((m) => m.symbol);
      console.log(`preappr  : ${pre.length} aktif${miss.length ? ` — belum: ${miss.join(', ')}` : ' (semua)'}`);
    }
    console.log(`partyId  : ${w.partyId || (await getPartyId(w, cfg).catch(() => '?'))}`);
    console.log(`token    : ${tokenState(w)}`);
    persist();
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

// ---- quest claim -------------------------------------------------------------
async function claimMenu() {
  const sel = await pickWallets('Wallet untuk klaim quest');
  if (!sel.length) return;
  console.log('\nCek quest yang bisa diklaim…');
  const rows = [];
  for (const w of sel) {
    try { rows.push({ w, quests: await getClaimableQuests(w, cfg) }); }
    catch (e) { rows.push({ w, quests: [], err: e.message }); }
  }
  persist();
  for (const r of rows) {
    const total = r.quests.reduce((s, q) => s + Number(q.rewardPoints || 0), 0);
    console.log(`  ${walletLabel(r.w).padEnd(28)} ${r.err ? 'err: ' + r.err : `${r.quests.length} quest, +${total} poin`}`);
    r.quests.forEach((q) => console.log(`      - ${q.task} (+${q.rewardPoints})`));
  }
  const claimable = rows.filter((r) => r.quests.length);
  if (!claimable.length) { console.log('Tidak ada yang bisa diklaim.'); return; }
  if ((await ask(`\nKlaim semua di ${claimable.length} wallet? (y/N) `)).toLowerCase() !== 'y') return;
  for (const r of claimable) {
    for (const q of r.quests) {
      try { await claimQuest(r.w, q.id, cfg); console.log(`  ✓ ${walletLabel(r.w)}: ${q.task} +${q.rewardPoints}`); }
      catch (e) { console.log(`  ✗ ${walletLabel(r.w)}: ${q.task} — ${e.message}`); }
      await new Promise((res) => setTimeout(res, 900));
    }
  }
  persist();
}

// ---- preapproval -------------------------------------------------------------
async function preapprovalMenu() {
  const sel = await pickWallets('Wallet untuk enable preapproval');
  if (!sel.length) return;
  console.log('\nCek status preapproval…');
  const rows = [];
  for (const w of sel) {
    try {
      const [instruments, preapproved] = [await getInstruments(w, cfg), await getPreapprovals(w, cfg)];
      rows.push({ w, missing: missingPreapprovals(instruments, preapproved), total: Object.values(instruments).filter((i) => i.isActive).length });
    } catch (e) { rows.push({ w, missing: [], err: e.message }); }
  }
  persist();
  for (const r of rows) {
    if (r.err) { console.log(`  ${walletLabel(r.w).padEnd(28)} err: ${r.err}`); continue; }
    console.log(`  ${walletLabel(r.w).padEnd(28)} ${r.missing.length ? `belum: ${r.missing.map((m) => m.symbol).join(', ')}` : `semua ${r.total} token aktif ✓`}`);
  }
  const todo = rows.filter((r) => r.missing.length);
  if (!todo.length) { console.log('\nSemua wallet sudah preapproved.'); return; }
  console.log('\nPreapproval = tombol "Enable" di portfolio. Tidak ada biaya, tapi bikin transaksi on-chain.');
  if ((await ask(`Enable semua token yang kurang di ${todo.length} wallet? (y/N) `)).toLowerCase() !== 'y') return;
  for (const r of todo) {
    console.log(`\n-- ${walletLabel(r.w)}`);
    await preapproveAll(r.w, cfg, { onLog: (m) => console.log('   ' + m) });
  }
  persist();
}

// ---- convert poin -> token ---------------------------------------------------
async function convertMenu() {
  const sel = await pickWallets('Wallet untuk convert poin');
  if (!sel.length) return;
  const jobs = [];
  for (const w of sel) {
    console.log(`\n=== ${walletLabel(w)} ===`);
    let ctx;
    try { ctx = await loadContext(w, cfg); } catch (e) { console.log('  err:', e.message); continue; }
    const pv = previewConvert(ctx);
    if (pv.blocked) { console.log('  ✗ point exchange diblokir untuk akun ini.'); continue; }
    console.log(`  poin ${pv.pointsBalance} (min ${pv.minPoints}) — dipakai per convert: ${pv.usePoints}`);
    if (!pv.canExchange) { console.log('  ✗ poin belum cukup untuk convert.'); continue; }
    const auto = pickConvertTarget(pv, { balances: ctx.balances, prefer: cfg.autoTask.convertPreferSymbols });
    console.log('  target   terima          fee              nilai   preappr');
    pv.rows.forEach((r, i) => {
      console.log(`  [${String(i + 1).padStart(2)}] ${r.symbol.padEnd(6)} ${String(r.net).padEnd(16)} ${(r.fee + ' ' + r.symbol).padEnd(20)} ${fmtUsd(r.netUsd).padEnd(8)} ${r.preapproved ? 'ya' : 'BELUM'}${r.discountPercent ? `  -${r.discountPercent}% fee` : ''}${auto && auto.symbol === r.symbol ? '  <- saran' : ''}`);
    });
    const a = await ask('  Pilih nomor target (kosong=lewati, "auto"=pakai saran): ');
    if (!a) continue;
    const target = a.toLowerCase() === 'auto' ? auto : pv.rows[parseInt(a, 10) - 1];
    if (!target) { console.log('  nomor tidak valid.'); continue; }
    if (!target.preapproved) { console.log(`  ✗ ${target.symbol} belum preapproved — jalankan menu Preapproval dulu.`); continue; }
    jobs.push({ w, target });
  }
  if (!jobs.length) return;
  console.log('\nRencana convert:');
  jobs.forEach((j) => console.log(`  ${walletLabel(j.w).padEnd(28)} ${j.target.usePoints} poin -> ${j.target.net} ${j.target.symbol} (fee ${fmtUsd(j.target.feeUsd)})`));
  if ((await ask(`\nEksekusi ${jobs.length} convert? ketik "CONVERT": `)) !== 'CONVERT') { console.log('batal.'); return; }
  for (const j of jobs) {
    try {
      const r = await convertPoints(j.w, cfg, { symbol: j.target.symbol, onLog: (m) => console.log(`  ${walletLabel(j.w)}: ${m}`) });
      if (r.skipped) console.log(`  ✗ ${walletLabel(j.w)}: ${r.skipped}`);
      else console.log(`  ✓ ${walletLabel(j.w)}: ${r.result?.amountReceived ?? j.target.net} ${j.target.symbol} (status ${r.result?.status ?? '?'})`);
    } catch (e) { console.log(`  ✗ ${walletLabel(j.w)}: ${e.message}`); }
    await new Promise((res) => setTimeout(res, 1200));
  }
  persist();
}

// ---- subscription ------------------------------------------------------------
async function subscriptionMenu() {
  const sel = await pickWallets('Wallet untuk extend subscription');
  if (!sel.length) return;
  const jobs = [];
  for (const w of sel) {
    console.log(`\n=== ${walletLabel(w)} ===`);
    let ctx;
    try { ctx = await loadContext(w, cfg); } catch (e) { console.log('  err:', e.message); continue; }
    const { sub, tier } = ctx;
    if (!sub || !tier) { console.log('  ✗ tidak ada subscription/tier.'); continue; }
    const days = subscriptionDaysRemaining(sub);
    const cost = Number(tier.costAmountUsd ?? 0);
    console.log(`  tier ${tier.name} (${fmtUsd(cost)}/bln) — status ${sub.status}, sisa ${days} hari (berakhir ${String(sub.endAt).slice(0, 10)})`);
    if (!(cost > 0)) { console.log('  tier gratis — upgrade harus manual di app.'); continue; }
    if (days >= EXTEND_WINDOW_DAYS) { console.log(`  belum bisa extend (app cuma buka window <${EXTEND_WINDOW_DAYS} hari).`); continue; }

    // show every payment option the way the app's dropdown does
    console.log('  bayar    jumlah                 biaya    saldo cukup  preappr');
    const rows = [];
    for (const inst of Object.values(ctx.instruments)) {
      const rate = ctx.rates[inst.symbol];
      if (!inst.isActive || !(Number(rate?.usdPerUnit) > 0)) continue;
      const one = pickSubscriptionPayment({
        instruments: { [inst.symbol]: inst }, balances: ctx.balances,
        preapproved: ctx.preapproved, costAmountUsd: cost, rates: ctx.rates,
      });
      const mod = -(inst.subscriptionDiscountPercent || 0);
      const qty = truncDecimals((cost * Math.max(0, 1 + mod / 100)) / Number(rate.usdPerUnit), inst.decimals);
      rows.push({ inst, qty, usd: cost * Math.max(0, 1 + mod / 100), ok: !!one, disc: inst.subscriptionDiscountPercent || 0 });
    }
    rows.sort((a, b) => (b.disc - a.disc) || 0);
    rows.forEach((r, i) => console.log(`  [${String(i + 1).padStart(2)}] ${r.inst.symbol.padEnd(6)} ${String(r.qty).padEnd(20)} ${fmtUsd(r.usd).padEnd(8)} ${(r.ok ? 'ya' : 'TIDAK').padEnd(12)} ${ctx.preapproved.includes(r.inst.instrumentId) ? 'ya' : 'belum'}${r.disc ? `  -${r.disc}%` : ''}`));

    const { plan, skipped } = await planSubscriptionExtend(w, cfg, { ctx, force: true });
    if (!plan) { console.log(`  ✗ ${skipped}`); continue; }
    console.log(`  saran: bayar ${plan.pay.quantity} ${plan.pay.symbol} = ${fmtUsd(plan.pay.usd)}${plan.pay.discountPercent ? ` (-${plan.pay.discountPercent}%)` : ''}`);
    if ((await ask('  Extend wallet ini? (y/N) ')).toLowerCase() !== 'y') continue;
    jobs.push({ w, plan });
  }
  if (!jobs.length) return;
  console.log('\nRencana extend:');
  jobs.forEach((j) => console.log(`  ${walletLabel(j.w).padEnd(28)} ${j.plan.tier.name} +30d, bayar ${j.plan.pay.quantity} ${j.plan.pay.symbol} (${fmtUsd(j.plan.pay.usd)})`));
  const total = jobs.reduce((s, j) => s + j.plan.pay.usd, 0);
  if ((await ask(`\nTotal ${fmtUsd(total)}. Ketik "EXTEND" untuk eksekusi: `)) !== 'EXTEND') { console.log('batal.'); return; }
  for (const j of jobs) {
    try {
      const r = await extendSubscription(j.w, cfg, { force: true, onLog: (m) => console.log(`  ${walletLabel(j.w)}: ${m}`) });
      if (r.skipped) console.log(`  ✗ ${walletLabel(j.w)}: ${r.skipped}`);
      else console.log(`  ✓ ${walletLabel(j.w)}: status ${r.result?.status ?? '?'} sampai ${String(r.result?.endAt ?? '?').slice(0, 10)}`);
    } catch (e) { console.log(`  ✗ ${walletLabel(j.w)}: ${e.message}`); }
    await new Promise((res) => setTimeout(res, 1200));
  }
  persist();
}

// ---- auto task ---------------------------------------------------------------
async function autoTaskMenu() {
  const sel = await pickWallets('Wallet untuk auto task');
  if (!sel.length) return;
  const at = cfg.autoTask;
  console.log('\n=== Auto task ===');
  console.log(`  langkah  : ${[at.claimQuests && 'claim', at.preapproveAll && 'preapproval', at.dailyConvert && 'daily-convert', at.extendSubscription && 'extend-subscription', at.dailyInternalTransfer && 'daily-internal-transfer', at.claimQuests && 'claim'].filter(Boolean).join(' -> ') || '(semua dimatikan)'}`);
  console.log(`  dilewati : ${(at.skipSlugs || []).join(', ')}`);
  console.log(`  guard    : fee ${fmtUsd(at.maxFeeUsd)}/aksi | subscription ${fmtUsd(at.maxSubscriptionUsd)} (extend saat sisa <= ${at.extendWhenDaysLeft}d)`);
  console.log(`  lain     : transfer ${fmtUsd(at.internalTransferUsd)} | target convert ${(at.convertPreferSymbols || []).join('/')}`);
  console.log('\n  [1] Dry-run (lihat rencana, tidak eksekusi)');
  console.log('  [2] Jalankan sekali');
  console.log(`  [3] Loop harian (jalan terus, pass baru tiap 00:0${cfg.autoTask.loopStartOffsetMin} UTC)`);
  const mode = await ask('Pilih (kosong=batal): ');
  if (!['1', '2', '3'].includes(mode)) return;
  const dryRun = mode === '1';
  if (!dryRun && (await ask('Ketik "JALAN" untuk eksekusi beneran: ')) !== 'JALAN') { console.log('batal.'); return; }

  if (mode === '3') {
    console.log('\n================ LOOP HARIAN ================');
    console.log('Jalan terus, tidak balik ke menu. Ctrl-C untuk stop.');
    console.log(`Sela cek ${cfg.autoTask.loopRetryMin}m; pass penuh tiap hari quest baru (00:00 UTC = 07:00 WIB).`);
    console.log('============================================\n');
    rl.close();
    await runAutoTasksLoop(sel, wallets, cfg, {
      onLog: (m) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${m}`),
      onPersist: persist,
    });
    return;
  }

  for (const w of sel) {
    console.log(`\n---------- ${walletLabel(w)} ----------`);
    try {
      const rep = await runAutoTasks(w, wallets, cfg, { dryRun, onLog: (m) => console.log('  ' + m) });
      if (rep.errors.length) console.log('  ⚠ error:', rep.errors.join(' | '));
    } catch (e) { console.log('  ✗ fatal:', e.message); }
    persist();
  }
}

async function autoTaskSettings() {
  for (;;) {
    const at = cfg.autoTask;
    console.log('\n=== Auto task settings ===');
    console.log(`  [1] enabled (dipakai keeper)   : ${at.enabled}`);
    console.log(`  [2] preapproveAll              : ${at.preapproveAll}`);
    console.log(`  [3] dailyConvert               : ${at.dailyConvert}`);
    console.log(`  [4] dailyInternalTransfer      : ${at.dailyInternalTransfer}`);
    console.log(`  [5] claimQuests                : ${at.claimQuests}`);
    console.log(`  [6] maxFeeUsd (guard fee)      : ${at.maxFeeUsd}`);
    console.log(`  [7] internalTransferUsd        : ${at.internalTransferUsd}`);
    console.log(`  [8] convertPreferSymbols       : ${(at.convertPreferSymbols || []).join(',')}`);
    console.log(`  [9] settleWaitSec              : ${at.settleWaitSec}`);
    console.log(` [10] skipSlugs (tidak diotomasi): ${(at.skipSlugs || []).join(',')}`);
    console.log(` [11] extendSubscription         : ${at.extendSubscription}`);
    console.log(` [12] extendWhenDaysLeft         : ${at.extendWhenDaysLeft}`);
    console.log(` [13] maxSubscriptionUsd (guard) : ${at.maxSubscriptionUsd}`);
    console.log(` [14] loopRetryMin (sela cek)    : ${at.loopRetryMin}`);
    console.log(` [15] loopStartOffsetMin         : ${at.loopStartOffsetMin} (menit setelah 00:00 UTC)`);
    console.log('  [0] Kembali');
    const a = await ask('Ubah nomor: ');
    const yn = async (q) => /^(y|1|true|on)/i.test(await ask(q));
    if (a === '1') at.enabled = await yn('enable auto task di keeper? (y/n): ');
    else if (a === '2') at.preapproveAll = await yn('auto preapproval? (y/n): ');
    else if (a === '3') at.dailyConvert = await yn('auto daily convert? (y/n): ');
    else if (a === '4') at.dailyInternalTransfer = await yn('auto daily internal transfer? (y/n): ');
    else if (a === '5') at.claimQuests = await yn('auto claim quest? (y/n): ');
    else if (a === '6') { const v = Number(await ask('max fee USD per aksi: ')); if (Number.isFinite(v) && v >= 0) at.maxFeeUsd = v; }
    else if (a === '7') { const v = Number(await ask('nilai transfer harian (USD): ')); if (Number.isFinite(v) && v > 0) at.internalTransferUsd = v; }
    else if (a === '8') { const v = (await ask('target convert prioritas (pisah koma, mis CBTC,cETH): ')).split(',').map((s) => s.trim()).filter(Boolean); if (v.length) at.convertPreferSymbols = v; }
    else if (a === '9') { const v = parseInt(await ask('detik tunggu sebelum claim: '), 10); if (Number.isFinite(v) && v >= 0) at.settleWaitSec = v; }
    else if (a === '10') { at.skipSlugs = (await ask('slug quest yang TIDAK diotomasi (pisah koma): ')).split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '11') at.extendSubscription = await yn('auto extend subscription? (y/n): ');
    else if (a === '12') { const v = parseInt(await ask(`extend saat sisa <= berapa hari (app buka window <${EXTEND_WINDOW_DAYS}d): `), 10); if (Number.isFinite(v) && v >= 0) at.extendWhenDaysLeft = v; }
    else if (a === '13') { const v = Number(await ask('max biaya subscription USD: ')); if (Number.isFinite(v) && v >= 0) at.maxSubscriptionUsd = v; }
    else if (a === '14') { const v = parseInt(await ask('sela cek loop (menit): '), 10); if (Number.isFinite(v) && v >= 1) at.loopRetryMin = v; }
    else if (a === '15') { const v = parseInt(await ask('mulai hari baru berapa menit setelah 00:00 UTC: '), 10); if (Number.isFinite(v) && v >= 0) at.loopStartOffsetMin = v; }
    else { persist(); return; }
    persist();
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

  const symbol = ((await ask('Asset (CC/CBTC/cETH/MOD/USDCx) [CBTC]: ')) || 'CBTC');
  const amtRaw = (await ask('Jumlah per transfer (angka, atau "max"): ')).trim();
  if (!amtRaw) return;

  let plan;
  try { plan = planTransfers(senders, receivers, amtRaw); }
  catch (e) { console.log('✗', e.message); return; }

  console.log(`\nRencana (${plan.length} transfer, asset ${symbol}) — hitung fee…`);
  const prepared = [];
  for (const [i, p] of plan.entries()) {
    try {
      const ctx = await loadContext(p.from, cfg);
      const inst = instrumentBySymbol(ctx.instruments, symbol);
      if (!inst) throw new Error(`asset ${symbol} tidak dikenal`);
      const baseUsd = transferFeeUsdFor(p.to.partyId, ctx.tier);
      let quantity = amtRaw;
      if (amtRaw.toLowerCase() === 'max') quantity = availableOf(ctx.balances, inst.symbol);
      const fee = pickFeeInstrument({
        instruments: ctx.instruments, balances: ctx.balances, preapproved: ctx.preapproved,
        baseUsd, rates: ctx.rates, transferInstrumentId: inst.instrumentId,
        transferQuantity: '0', prefer: cfg.autoTask.feeInstrumentPref,
      });
      if (!fee) throw new Error('tidak ada token yang cukup untuk bayar fee');
      // "max" must leave the fee behind when the same token pays for it
      if (amtRaw.toLowerCase() === 'max' && fee.instrumentId === inst.instrumentId) {
        const left = toUnits(quantity, inst.decimals) - toUnits(fee.quantity, fee.decimals);
        quantity = fromUnits(left > 0n ? left : 0n, inst.decimals);
      }
      if (toUnits(quantity, inst.decimals) <= 0n) throw new Error('saldo tidak cukup setelah fee');
      prepared.push({ ...p, inst, quantity, fee, baseUsd });
      console.log(`  ${i + 1}. ${walletLabel(p.from)} -> ${p.to.label}: ${quantity} ${inst.symbol} | fee ${fee.quantity} ${fee.symbol} (${fmtUsd(fee.usd)}${fee.discountPercent ? `, -${fee.discountPercent}%` : ''})`);
    } catch (e) { console.log(`  ${i + 1}. ${walletLabel(p.from)} -> ${p.to.label}: ✗ ${e.message}`); }
  }
  if (!prepared.length) { console.log('Tidak ada transfer yang layak.'); return; }
  const guard = Number(cfg.autoTask.maxFeeUsd ?? Infinity);
  const over = prepared.filter((p) => p.fee.usd > guard);
  if (over.length) console.log(`\n⚠ ${over.length} transfer fee-nya di atas guard ${fmtUsd(guard)} (menu 7 = manual, guard tidak memblokir).`);
  if ((await ask(`\nEksekusi ${prepared.length} transfer? ketik "KIRIM" untuk lanjut: `)) !== 'KIRIM') { console.log('batal.'); return; }

  for (const [i, p] of prepared.entries()) {
    try {
      const r = await transfer(p.from, {
        receiverPartyId: p.to.partyId, quantity: p.quantity,
        instrumentId: p.inst.instrumentId, feeInstrumentId: p.fee.instrumentId,
      }, cfg);
      persist();
      console.log(`  ✓ ${i + 1}. ${walletLabel(p.from)} -> ${p.to.label}: ${p.quantity} ${p.inst.symbol}`, r?.updateId ? `(${r.updateId.slice(0, 12)}…)` : '');
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
  console.log('  (auto task diatur di menu 14)');
  console.log('  [0] Kembali');
  const a = await ask('Ubah nomor (kosong=batal): ');
  if (a === '1') k.checkEveryMin = parseInt(await ask('menit: '), 10) || k.checkEveryMin;
  else if (a === '2') k.refreshSkewSec = parseInt(await ask('detik: '), 10) || k.refreshSkewSec;
  persist();
}

async function main() {
  console.log('Modulo Wallet Manager — CLI interaktif');
  for (;;) {
    console.log('\n========================================');
    console.log(` Wallets: ${wallets.length} | Alert: ${cfg.alert.telegram.botToken || cfg.alert.webhookUrl ? 'ON' : 'off'} | Auto task: ${cfg.autoTask.enabled ? 'ON' : 'off'}`);
    console.log('========================================');
    console.log('   1) List wallets            2) Add wallet (import)');
    console.log('   3) Detail wallet           4) Refresh token now');
    console.log('   5) Claim quest reward      6) Remove wallet');
    console.log('   7) Bulk send (transfer)    8) Alerts (Telegram/webhook)');
    console.log('   9) Keeper settings        10) Run keeper now (watch semua)');
    console.log('  11) Preapproval token      12) Convert poin -> token');
    console.log('  13) Auto task (jalankan)   14) Auto task settings');
    console.log('  15) Subscription (extend)');
    console.log('   0) Exit');
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
      else if (a === '11') { await preapprovalMenu(); await pause(); }
      else if (a === '12') { await convertMenu(); await pause(); }
      else if (a === '13') { await autoTaskMenu(); await pause(); }
      else if (a === '14') { await autoTaskSettings(); }
      else if (a === '15') { await subscriptionMenu(); await pause(); }
      else if (a === '0' || a === '') { rl.close(); return; }
    } catch (e) { console.log('error:', e.message); await pause(); }
  }
}

main();
