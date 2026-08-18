// Quest automation for Modulo: preapproval, point conversion, the daily CIP-56 internal
// transfer, and quest claiming. Every money-moving step is guarded by a USD fee ceiling.
//
// Deliberately NOT automated (cfg.autoTask.skipSlugs): daily-swap and
// daily-external-cip56-transfer — both cost real value and need a destination the user picks.
import {
  api, ensureFresh, walletLabel, truncDecimals, toUnits, fromUnits, fmtUsd,
  getInstruments, instrumentBySymbol, instrumentById, getBalances, availableOf,
  getPreapprovals, grantPreapproval, getPoints, getExchangeRates, exchangePoints,
  getClaimableQuests, claimQuest, getQuests, getMyTier, getPartyId, transfer,
  tokenSecondsLeft, fmtDur,
  pickFeeInstrument, feeQuantity, feeUsdWithModifier, transferFeeUsdFor, isModuloParty,
  subscribe, pickSubscriptionPayment, subscriptionDaysRemaining,
  SUBSCRIPTION_PENDING, EXTEND_WINDOW_DAYS, DEFAULT_SKIP_SLUGS,
} from './core.mjs';

/** Assets the CIP-56 transfer quests accept ("Send CBTC or CETH token …"). */
export const CIP56_SYMBOLS = ['CBTC', 'cETH'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noop = () => {};

/** One shared read of everything the task steps need, so a pass makes one round of calls. */
export async function loadContext(wallet, cfg) {
  await ensureFresh(wallet, cfg);
  const [instruments, balances, preapproved, points, rates, tierInfo] = await Promise.all([
    getInstruments(wallet, cfg),
    getBalances(wallet, cfg),
    getPreapprovals(wallet, cfg),
    getPoints(wallet, cfg),
    getExchangeRates(wallet, cfg),
    getMyTier(wallet, cfg),
  ]);
  return { instruments, balances, preapproved, points, rates, tier: tierInfo.tier, sub: tierInfo.sub };
}

// --------------------------------------------------------------------------
// 1) preapproval — the portfolio "Enable" buttons
// --------------------------------------------------------------------------
/**
 * Instruments the transfer-preapproval endpoint refuses outright:
 *   400 "Transfer preapproval cannot be granted for Amulet or MOD via this endpoint."
 * The app agrees — the portfolio shows no "Enable" button on Canton Coin or Modulo. They are
 * granted server-side, and they do show up in the GET list later, so never try to grant them.
 */
export const PREAPPROVAL_EXEMPT = ['Amulet', 'MOD'];

/** Instruments that are active, grantable, and not yet preapproved for this wallet. */
export function missingPreapprovals(instruments, preapproved) {
  return Object.values(instruments)
    .filter((i) => i.isActive && !preapproved.includes(i.instrumentId)
      && !PREAPPROVAL_EXEMPT.includes(i.instrumentId))
    .map((i) => ({ symbol: i.symbol, instrumentId: i.instrumentId }));
}

/** Grant preapproval for every active instrument still missing one. Returns per-asset results. */
export async function preapproveAll(wallet, cfg, { onLog = noop, only = null, pauseMs = 900 } = {}) {
  const instruments = await getInstruments(wallet, cfg);
  let preapproved = await getPreapprovals(wallet, cfg);
  let todo = missingPreapprovals(instruments, preapproved);
  if (only && only.length) {
    const want = only.map((s) => String(s).toLowerCase());
    todo = todo.filter((t) => want.includes(t.symbol.toLowerCase()) || want.includes(t.instrumentId.toLowerCase()));
  }
  const results = [];
  if (!todo.length) { onLog('preapproval: semua token sudah aktif'); return { results, preapproved }; }
  for (const t of todo) {
    try {
      const r = await grantPreapproval(wallet, t.instrumentId, cfg);
      results.push({ ...t, ok: true, updateId: r?.updateId });
      onLog(`preapproval ✓ ${t.symbol}`);
    } catch (e) {
      results.push({ ...t, ok: false, error: e.message });
      onLog(`preapproval ✗ ${t.symbol}: ${e.message}`);
    }
    await sleep(pauseMs);
  }
  preapproved = await getPreapprovals(wallet, cfg).catch(() => preapproved);
  return { results, preapproved };
}

// --------------------------------------------------------------------------
// 2) convert points -> asset (daily-convert quest)
// --------------------------------------------------------------------------
/**
 * Per-asset preview of a conversion, mirroring the app's math exactly:
 *   usd   = points / pointsPerUsd
 *   gross = trunc(usd / usdPerUnit, decimals)
 *   fee   = trunc(claimFeeUsd * (1 - pointExchangeDiscount/100) / usdPerUnit, decimals)
 *   net   = max(0, gross - fee)
 */
export function previewConvert({ instruments, points, rates, tier, preapproved }) {
  const balance = Number(points?.claimable?.pointsBalance ?? 0);
  const maxPerClaim = Number(points?.claimable?.pointExchangeMaximumQtyPerClaim ?? balance);
  const usePoints = Math.min(balance, maxPerClaim);
  const claimFeeUsd = Number(tier?.claimFeeUsd ?? 0);
  const rows = [];
  for (const inst of Object.values(instruments)) {
    const rate = rates[inst.symbol];
    if (!inst.isActive || !inst.canPointExchange || !(Number(rate?.usdPerUnit) > 0)) continue;
    const decimals = rate.decimals ?? inst.decimals;
    const usd = usePoints / Number(rate.pointsPerUsd);
    const gross = truncDecimals(usd / Number(rate.usdPerUnit), decimals);
    const discount = inst.pointExchangeDiscountPercent || 0;
    const feeUsd = feeUsdWithModifier(claimFeeUsd, -discount);
    const fee = truncDecimals(feeUsd / Number(rate.usdPerUnit), decimals);
    const netUnits = toUnits(gross, decimals) - toUnits(fee, decimals);
    rows.push({
      symbol: inst.symbol, instrumentId: inst.instrumentId, decimals,
      usePoints, usdValue: usd, gross, fee, feeUsd, discountPercent: discount,
      net: fromUnits(netUnits > 0n ? netUnits : 0n, decimals),
      netUsd: Math.max(0, usd - feeUsd),
      preapproved: preapproved.includes(inst.instrumentId),
      usdPerUnit: rate.usdPerUnit,
    });
  }
  rows.sort((a, b) => (b.discountPercent - a.discountPercent) || (b.netUsd - a.netUsd));
  return {
    rows, usePoints,
    pointsBalance: balance,
    minPoints: Number(points?.claimable?.pointsConvertMinimumPoints ?? 0),
    canExchange: !!points?.claimable?.canExchangePoints,
    blocked: !!points?.claimable?.pointExchangeBlocked,
  };
}

/**
 * Rank convert targets best-first: discounted assets (currently CBTC/cETH at 75% off) ahead of
 * the rest, and within a tier the asset the wallet already holds — so a wallet stacks one asset
 * instead of collecting dust. Returns every eligible target, so a caller can fall back.
 */
export function rankConvertTargets(preview, { balances, prefer = ['CBTC', 'cETH'] } = {}) {
  const eligible = preview.rows.filter((r) => r.preapproved && toUnits(r.net, r.decimals) > 0n);
  if (!eligible.length) return [];
  const wanted = prefer.map((s) => s.toLowerCase());
  const rank = (r) => { const p = wanted.indexOf(r.symbol.toLowerCase()); return p < 0 ? wanted.length : p; };
  const held = (r) => (toUnits(availableOf(balances, r.symbol), r.decimals) > 0n ? 0 : 1);
  const tier = (r) => (r.discountPercent > 0 || wanted.includes(r.symbol.toLowerCase()) ? 0 : 1);
  return [...eligible].sort((a, b) =>
    (tier(a) - tier(b)) || (held(a) - held(b)) ||
    (b.discountPercent - a.discountPercent) || (rank(a) - rank(b)) || (b.netUsd - a.netUsd));
}

/** Best single target (first of the ranked list). */
export function pickConvertTarget(preview, opts = {}) {
  return rankConvertTargets(preview, opts)[0] || null;
}

/**
 * Explain a false canExchangePoints using the fields the API actually gives us.
 *
 * The server decides this flag and does not say why, so never assert a reason we have not
 * checked: reporting "poin 250 < minimum 50" when 250 > 50 sends the reader hunting the wrong
 * problem. Only the conditions visible in the payload are named; anything else is reported as
 * unknown, with the numbers attached so the real cause can be spotted.
 */
export function whyCannotExchange(preview, ctx) {
  const { pointsBalance: pts, minPoints: min } = preview;
  if (pts < min) return `poin ${pts} < minimum ${min}`;
  const done = Number(ctx?.points?.lifetime?.totalPointsExchanged ?? 0);
  const cap = Number(ctx?.points?.claimable?.pointExchangeMaximumQtyLifetime ?? Infinity);
  if (done >= cap) return `sudah tukar ${done} poin, mentok batas seumur hidup ${cap}`;
  const sub = ctx?.sub;
  const days = sub ? subscriptionDaysRemaining(sub) : 0;
  if (!sub || sub.status !== 'ACTIVE' || days <= 0) {
    return `server menolak convert (canExchangePoints=false) — subscription ${sub?.status ?? 'tidak ada'}${sub ? `, sisa ${days}d` : ''}. Poin ${pts} (min ${min}) cukup, jadi kemungkinan besar subscription dulu yang harus aktif.`;
  }
  return `server menolak convert (canExchangePoints=false) walau poin ${pts} >= minimum ${min}, subscription ${sub.status} sisa ${days}d — sebab tidak diungkap API`;
}

/**
 * Convert points into `symbol`, or into the best auto-picked target. Guarded by maxFeeUsd.
 *
 * The payout side is flaky per-asset: a healthy request can come back 503 "Service temporarily
 * unavailable" or 400 "<asset> claim could not be completed. Please check claim status." while
 * another asset — or the very same one moments later — succeeds. So we walk the ranked targets
 * instead of losing the day's convert to one sick asset.
 *
 * Retrying a payout is only safe if the failed attempt moved nothing, and that message says the
 * state is uncertain. So before each retry we re-read the points ledger: if totalPointsExchanged
 * moved, the claim did land and we stop and report it instead of spending the points twice.
 * A request-shape error (400 that is not the flaky claim message) never retries.
 */
const FLAKY_CLAIM_RE = /claim could not be completed/i;
function isRetryableClaimError(e) {
  return e?.status >= 500 || (e?.status === 400 && FLAKY_CLAIM_RE.test(e.message || ''));
}
export async function convertPoints(wallet, cfg, { symbol = null, ctx = null, onLog = noop, dryRun = false } = {}) {
  const c = ctx || (await loadContext(wallet, cfg));
  const preview = previewConvert(c);
  if (preview.blocked) return { skipped: 'point exchange diblokir untuk akun ini (flag sybil)' };
  if (!preview.canExchange) return { skipped: whyCannotExchange(preview, c) };

  let targets;
  if (symbol) {
    const one = preview.rows.find((r) => r.symbol.toLowerCase() === String(symbol).toLowerCase());
    if (!one) return { skipped: `target ${symbol} tidak tersedia` };
    if (!one.preapproved) return { skipped: `${one.symbol} belum preapproved — jalankan menu preapproval dulu` };
    targets = [one];
  } else {
    targets = rankConvertTargets(preview, { balances: c.balances, prefer: cfg.autoTask.convertPreferSymbols });
  }
  if (!targets.length) return { skipped: 'tidak ada target convert yang layak (cek preapproval)' };

  const maxFeeUsd = Number(cfg.autoTask.maxFeeUsd ?? Infinity);
  const affordable = targets.filter((t) => t.feeUsd <= maxFeeUsd);
  if (!affordable.length) {
    return { skipped: `fee convert ${fmtUsd(targets[0].feeUsd)} > guard ${fmtUsd(maxFeeUsd)}` };
  }

  // Ledger reading taken before any attempt, used to prove a failed attempt moved nothing.
  const exchangedBefore = String(c.points?.lifetime?.totalPointsExchanged ?? '');
  const tried = [];
  // one extra pass so a flaky asset gets a second chance after the others were tried
  const attempts = [...affordable, ...affordable.slice(0, 1)];

  for (const [i, target] of attempts.entries()) {
    onLog(`convert ${preview.usePoints} poin -> ${target.net} ${target.symbol} (fee ${fmtUsd(target.feeUsd)}${target.discountPercent ? `, -${target.discountPercent}%` : ''})`);
    if (dryRun) return { dryRun: true, target, preview, fallbacks: affordable.slice(1).map((t) => t.symbol) };
    try {
      const res = await exchangePoints(wallet, target.instrumentId, cfg);
      return { ok: true, target, result: res, tried };
    } catch (e) {
      tried.push(`${target.symbol}: ${e.message}`);
      if (i === attempts.length - 1 || !isRetryableClaimError(e)) throw e;

      // never spend the points twice: confirm the ledger did not move before retrying
      const after = await getPoints(wallet, cfg).catch(() => null);
      const exchangedAfter = String(after?.lifetime?.totalPointsExchanged ?? '');
      if (after && exchangedBefore && exchangedAfter !== exchangedBefore) {
        onLog(`  ${target.symbol} error tapi poin SUDAH terpotong — berhenti, jangan dobel. Cek status klaim di app.`);
        return { uncertain: true, target, tried, exchangedBefore, exchangedAfter };
      }
      onLog(`  ${target.symbol} bermasalah di server (${e.status}), poin belum terpotong — coba lagi`);
      await sleep(3000);
    }
  }
  return { skipped: tried.join(' | ') };
}

// --------------------------------------------------------------------------
// 3) subscription extend ("Extend now to stack another 30 days")
// --------------------------------------------------------------------------
/**
 * Decide whether to extend, and with which token. Returns { plan } or { skipped }.
 * Only ever extends the tier the wallet is already on — upgrading/downgrading is the user's call.
 */
export async function planSubscriptionExtend(wallet, cfg, { ctx = null, force = false } = {}) {
  const c = ctx || (await loadContext(wallet, cfg));
  const { sub, tier } = c;
  if (!sub) return { skipped: 'belum punya subscription — subscribe manual dulu' };
  if (SUBSCRIPTION_PENDING.includes(sub.status)) return { skipped: `pembayaran sedang diproses (${sub.status})` };
  if (!tier) return { skipped: 'tier tidak ketemu' };
  const costUsd = Number(tier.costAmountUsd ?? 0);
  if (!(costUsd > 0)) return { skipped: `tier "${tier.name}" gratis — upgrade itu keputusan kamu, bukan otomasi` };

  const days = subscriptionDaysRemaining(sub);
  // the app only offers Extend inside this window; going earlier would just be rejected
  if (days >= EXTEND_WINDOW_DAYS) return { skipped: `sisa ${days}d — belum masuk window extend (<${EXTEND_WINDOW_DAYS}d)` };
  const threshold = Number(cfg.autoTask.extendWhenDaysLeft ?? 3);
  if (!force && days > threshold) return { skipped: `sisa ${days}d > ambang ${threshold}d` };

  const pay = pickSubscriptionPayment({
    instruments: c.instruments, balances: c.balances, preapproved: c.preapproved,
    costAmountUsd: costUsd, rates: c.rates, prefer: cfg.autoTask.subscriptionPayPrefer,
  });
  if (!pay) return { skipped: 'tidak ada token dengan saldo cukup untuk bayar subscription' };

  const guard = Number(cfg.autoTask.maxSubscriptionUsd ?? Infinity);
  if (pay.usd > guard) return { skipped: `biaya ${fmtUsd(pay.usd)} > guard ${fmtUsd(guard)}` };

  return { plan: { tier, tierId: tier.id, days, costUsd, pay } };
}

/** Execute the extend. */
export async function extendSubscription(wallet, cfg, { ctx = null, onLog = noop, dryRun = false, force = false } = {}) {
  const { plan, skipped } = await planSubscriptionExtend(wallet, cfg, { ctx, force });
  if (!plan) return { skipped };
  onLog(`extend "${plan.tier.name}" (sisa ${plan.days}d) bayar ${plan.pay.quantity} ${plan.pay.symbol} = ${fmtUsd(plan.pay.usd)}${plan.pay.discountPercent ? ` (-${plan.pay.discountPercent}%, normal ${fmtUsd(plan.costUsd)})` : ''}`);
  if (dryRun) return { dryRun: true, plan };
  const res = await subscribe(wallet, { tierId: plan.tierId, instrumentId: plan.pay.instrumentId }, cfg);
  return { ok: true, plan, result: res };
}

// --------------------------------------------------------------------------
// 4) daily internal transfer (CIP-56, to another imported wallet)
// --------------------------------------------------------------------------
/** Resolve (and cache) the partyId of every other imported wallet. */
export async function resolvePeers(wallet, wallets, cfg) {
  const peers = [];
  for (const p of wallets) {
    if (p === wallet) continue;
    try {
      const partyId = p.partyId || (await getPartyId(p, cfg));
      if (isModuloParty(partyId)) peers.push({ wallet: p, partyId, label: walletLabel(p) });
    } catch { /* peer unusable, skip */ }
  }
  return peers;
}

/**
 * Plan the quest transfer: pick a CIP-56 asset the wallet can actually afford, size it from
 * `internalTransferUsd`, and choose a discounted fee token. Returns { plan } or { skipped }.
 */
export async function planInternalTransfer(wallet, peers, cfg, { ctx = null } = {}) {
  const c = ctx || (await loadContext(wallet, cfg));
  if (!peers.length) return { skipped: 'tidak ada wallet lain yang diimpor sebagai penerima' };

  const usdSize = Number(cfg.autoTask.internalTransferUsd ?? 0.01);
  const maxFeeUsd = Number(cfg.autoTask.maxFeeUsd ?? Infinity);
  const tried = [];

  for (const sym of CIP56_SYMBOLS) {
    const inst = instrumentBySymbol(c.instruments, sym);
    const rate = c.rates[sym];
    if (!inst || !inst.isActive || !(Number(rate?.usdPerUnit) > 0)) continue;
    if (!c.preapproved.includes(inst.instrumentId)) { tried.push(`${sym}: belum preapproved`); continue; }

    // size the send: usd -> units, never below one smallest unit
    let quantity = truncDecimals(usdSize / Number(rate.usdPerUnit), inst.decimals);
    if (toUnits(quantity, inst.decimals) <= 0n) quantity = fromUnits(1n, inst.decimals);

    // a receiver that has this instrument preapproved settles instantly; otherwise the
    // transfer lands as a pending instruction the receiver must accept in the app.
    const peer = peers.find((p) => (p.preapproved || []).includes(inst.instrumentId)) || peers[0];

    const feeUsdBase = transferFeeUsdFor(peer.partyId, c.tier);
    const fee = pickFeeInstrument({
      instruments: c.instruments, balances: c.balances, preapproved: c.preapproved,
      baseUsd: feeUsdBase, rates: c.rates,
      transferInstrumentId: inst.instrumentId, transferQuantity: quantity,
      prefer: cfg.autoTask.feeInstrumentPref,
    });
    if (!fee) { tried.push(`${sym}: tidak ada token yang cukup untuk bayar fee`); continue; }
    if (fee.usd > maxFeeUsd) { tried.push(`${sym}: fee ${fmtUsd(fee.usd)} > guard ${fmtUsd(maxFeeUsd)}`); continue; }

    const need = toUnits(quantity, inst.decimals)
      + (fee.instrumentId === inst.instrumentId ? toUnits(fee.quantity, fee.decimals) : 0n);
    if (toUnits(availableOf(c.balances, sym), inst.decimals) < need) {
      tried.push(`${sym}: saldo ${availableOf(c.balances, sym)} kurang dari ${fromUnits(need, inst.decimals)}`);
      continue;
    }
    return {
      plan: {
        symbol: sym, instrumentId: inst.instrumentId, decimals: inst.decimals,
        quantity, usdValue: Number(quantity) * Number(rate.usdPerUnit),
        to: peer, fee, feeUsdBase,
        peerPreapproved: (peer.preapproved || []).includes(inst.instrumentId),
      },
    };
  }
  return { skipped: tried.length ? tried.join(' | ') : `tidak ada saldo ${CIP56_SYMBOLS.join('/')}` };
}

/** Execute the planned quest transfer. */
export async function dailyInternalTransfer(wallet, peers, cfg, { ctx = null, onLog = noop, dryRun = false } = {}) {
  const { plan, skipped } = await planInternalTransfer(wallet, peers, cfg, { ctx });
  if (!plan) return { skipped };
  onLog(`kirim ${plan.quantity} ${plan.symbol} (${fmtUsd(plan.usdValue)}) -> ${plan.to.label}, fee ${plan.fee.quantity} ${plan.fee.symbol} (${fmtUsd(plan.fee.usd)}${plan.fee.discountPercent ? `, -${plan.fee.discountPercent}%` : ''})`);
  if (!plan.peerPreapproved) onLog(`  ⚠ ${plan.to.label} belum preapproved ${plan.symbol} — transfer jadi pending instruction`);
  if (dryRun) return { dryRun: true, plan };
  const res = await transfer(wallet, {
    receiverPartyId: plan.to.partyId, quantity: plan.quantity,
    instrumentId: plan.instrumentId, feeInstrumentId: plan.fee.instrumentId,
  }, cfg);
  return { ok: true, plan, result: res };
}

// --------------------------------------------------------------------------
// 4) claim
// --------------------------------------------------------------------------
/** Claim every COMPLETED quest. skipSlugs never blocks claiming — it only blocks *doing*. */
export async function claimAllQuests(wallet, cfg, { onLog = noop, dryRun = false, pauseMs = 900 } = {}) {
  const claimable = await getClaimableQuests(wallet, cfg);
  const out = [];
  if (!claimable.length) { onLog('tidak ada quest yang bisa diklaim'); return out; }
  for (const q of claimable) {
    if (dryRun) { out.push({ slug: q.slug, points: q.rewardPoints, dryRun: true }); onLog(`[dry] claim ${q.slug} (+${q.rewardPoints})`); continue; }
    try {
      await claimQuest(wallet, q.id, cfg);
      out.push({ slug: q.slug, points: q.rewardPoints, ok: true });
      onLog(`claim ✓ ${q.task} (+${q.rewardPoints})`);
    } catch (e) {
      out.push({ slug: q.slug, points: q.rewardPoints, ok: false, error: e.message });
      onLog(`claim ✗ ${q.task}: ${e.message}`);
    }
    await sleep(pauseMs);
  }
  return out;
}

// --------------------------------------------------------------------------
// full pass
// --------------------------------------------------------------------------
/** Which daily quests are still open for this wallet, minus the ones we never automate. */
export async function pendingDailyWork(wallet, cfg) {
  const skip = cfg.autoTask.skipSlugs || DEFAULT_SKIP_SLUGS;
  const [quests, claimable] = await Promise.all([
    getQuests(wallet, cfg).catch(() => []),
    getClaimableQuests(wallet, cfg).catch(() => []),
  ]);
  // periodKey for daily quests is a UTC date, so compare against UTC — not the local day.
  // EXPIRED never counts as done: the window closed unclaimed and a new one is open.
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = new Set(
    quests
      .filter((q) => q.status !== 'EXPIRED')
      .filter((q) => q.recurrence !== 'DAILY' || q.periodKey === today)
      .map((q) => q.slug),
  );
  return {
    claimable,
    convertDone: doneToday.has('daily-convert'),
    internalDone: doneToday.has('daily-internal-cip56-transfer'),
    skipped: skip,
  };
}

/**
 * One row of live state per wallet, for the dashboard.
 *
 * Never throws: a wallet with a dead session still gets a row saying so, because a status
 * panel that disappears when something breaks is worse than useless.
 */
export async function collectStatus(wallet, cfg) {
  const row = { label: walletLabel(wallet), status: 'cek…', token: '-', poin: '-', quest: '-',
    cbtc: '-', ceth: '-', sub: '-', convert: '-', xfer: '-', dead: false };
  try { await ensureFresh(wallet, cfg); }
  catch { row.status = 'SESI MATI'; row.dead = true; return row; }
  row.token = fmtDur(tokenSecondsLeft(wallet.accessToken));
  const grab = (p) => p.catch(() => null);
  const [points, balances, tierInfo, pending] = await Promise.all([
    grab(getPoints(wallet, cfg)), grab(getBalances(wallet, cfg)),
    grab(getMyTier(wallet, cfg)), grab(pendingDailyWork(wallet, cfg)),
  ]);
  if (points) row.poin = points.claimable?.pointsBalance ?? '-';
  if (balances) {
    row.cbtc = balances.CBTC?.totalBalance ?? '0';
    row.ceth = balances.cETH?.totalBalance ?? '0';
  }
  if (tierInfo?.sub) row.sub = `${subscriptionDaysRemaining(tierInfo.sub)}d`;
  if (pending) {
    row.quest = String(pending.claimable.length);
    row.convert = pending.convertDone ? 'ok' : '-';
    row.xfer = pending.internalDone ? 'ok' : '-';
    row.status = pending.claimable.length ? 'siap klaim'
      : (pending.convertDone && pending.internalDone) ? 'beres' : 'nunggu';
  }
  return row;
}

/** UTC date key — the same clock the quest windows use. */
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Milliseconds until the next UTC midnight plus `offsetMin`, i.e. when a new quest day is live. */
export function msUntilNextUtcDay(offsetMin = 5, now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, offsetMin, 0, 0);
  return Math.max(1000, next - now);
}

const fmtWait = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}j${m % 60}m` : `${m}m`;
};

/**
 * Run the auto task forever, one full pass per UTC day. Never exits just because a day's work
 * is finished — it waits for the next quest window instead.
 *
 * Between full passes it still wakes every `loopRetryMin` to:
 *   - claim anything the quest evaluator finished after our pass (claiming is free, and a
 *     COMPLETED quest left unclaimed at the UTC boundary EXPIRES — this is the whole point)
 *   - retry wallets whose pass errored, since the payout side is flaky per-asset
 *
 * `onPersist` is called after every wallet so rotated refresh tokens are never held in memory.
 */
export async function runAutoTasksLoop(selected, wallets, cfg, {
  onLog = noop, onPersist = noop, onStatus = null, onSchedule = noop,
} = {}) {
  const at = cfg.autoTask;
  const retryMs = Math.max(1, Number(at.loopRetryMin ?? 30)) * 60_000;
  const offsetMin = Number(at.loopStartOffsetMin ?? 5);
  // Status reads share the wallet objects with the task steps, so they run here, between steps —
  // never on a parallel timer. Two concurrent refreshes would rotate the refresh token against
  // each other and kill the session for good.
  const status = async (list = selected) => {
    if (onStatus) { try { await onStatus(list); } catch { /* panel only, never fail the run */ } }
  };

  for (;;) {
    const day = utcDay();
    onLog(`===== pass harian ${day} (UTC) — ${selected.length} wallet =====`, 'head');
    await status(); // seed the panel first: an empty table during a long pass reads as broken
    const failed = new Set();
    for (const w of selected) {
      try {
        const rep = await runAutoTasks(w, wallets, cfg, { onLog });
        if (rep.errors.length) failed.add(w.id);
      } catch (e) {
        onLog(`${walletLabel(w)}: fatal ${e.message}`, 'err');
        failed.add(w.id);
      }
      onPersist();
      await status([w]); // refresh just this row, not the whole table
    }

    // Hold until the next quest window. Pinned to an absolute timestamp rather than "has the UTC
    // day changed": a retry tick can land exactly on 00:00, which flips the day while the offset
    // has not elapsed yet, and the next pass would then run before the new quests exist.
    const nextStart = Date.now() + msUntilNextUtcDay(offsetMin);
    for (;;) {
      const untilNewDay = nextStart - Date.now();
      const wait = Math.min(retryMs, untilNewDay);
      onSchedule({ nextStart, nextCheck: Date.now() + wait, failed: failed.size });
      onLog(`cek lagi ${fmtWait(wait)} · hari quest baru ${fmtWait(untilNewDay)} lagi${failed.size ? ` · ${failed.size} wallet perlu diulang` : ''}`);
      await sleep(wait);
      if (Date.now() >= nextStart) break; // new quest window -> full pass

      for (const w of selected) {
        try {
          // Keeping the session alive is a job of the wait, not a side effect of it: refresh
          // before the token lapses instead of letting a request 401 first. Sequential per
          // wallet — never in parallel, or two refreshes rotate the RT against each other.
          await ensureFresh(w, cfg);
          // free and time-critical: bank anything that finished since the last look
          await claimAllQuests(w, cfg, { onLog: (m) => onLog(`${walletLabel(w)}: ${m}`) });
          if (failed.has(w.id)) {
            const rep = await runAutoTasks(w, wallets, cfg, { onLog });
            if (!rep.errors.length) failed.delete(w.id);
          }
        } catch (e) { onLog(`${walletLabel(w)}: ${e.message}`, 'err'); }
        onPersist();
      }
      await status();
    }
  }
}

/**
 * Run the whole automated pass for one wallet:
 *   preapproval -> daily convert -> daily internal transfer -> settle wait -> claim.
 * Nothing here touches daily-swap or daily-external-cip56-transfer.
 */
export async function runAutoTasks(wallet, wallets, cfg, { onLog = noop, dryRun = false } = {}) {
  const label = walletLabel(wallet);
  const at = cfg.autoTask;
  const say = (m) => onLog(`${label}: ${m}`);
  const report = { label, steps: [], errors: [] };
  const step = async (name, enabled, fn) => {
    if (!enabled) { report.steps.push({ name, skipped: 'dimatikan di settings' }); return null; }
    try { const r = await fn(); report.steps.push({ name, ...(r || {}) }); return r; }
    catch (e) { report.steps.push({ name, error: e.message }); report.errors.push(`${name}: ${e.message}`); say(`${name} error: ${e.message}`); return null; }
  };

  // A dead refresh token is a normal state in a multi-wallet run, not a crash: report it and
  // let the caller move on to the next wallet.
  try { await ensureFresh(wallet, cfg); }
  catch (e) {
    say(`sesi mati (${e.message}) — re-import wallet ini`);
    report.errors.push(`sesi: ${e.message}`);
    report.dead = true;
    return report;
  }

  // Claim FIRST. Quest windows close on the UTC day boundary, and a COMPLETED quest that is
  // still unclaimed when its window ends goes EXPIRED and the points are gone. Banking what is
  // already earned before spending time on new work costs nothing and cannot be undone later.
  await step('claim-awal', at.claimQuests, async () => {
    const claims = await claimAllQuests(wallet, cfg, { onLog: say, dryRun });
    return { claimed: claims.filter((c) => c.ok || c.dryRun).length, claims };
  });

  await step('preapproval', at.preapproveAll, async () => {
    if (dryRun) {
      const c = await loadContext(wallet, cfg);
      const miss = missingPreapprovals(c.instruments, c.preapproved);
      say(`[dry] preapproval kurang: ${miss.map((m) => m.symbol).join(', ') || '(tidak ada)'}`);
      return { dryRun: true, missing: miss.map((m) => m.symbol) };
    }
    const r = await preapproveAll(wallet, cfg, { onLog: say });
    return { granted: r.results.filter((x) => x.ok).map((x) => x.symbol) };
  });

  // read state once after preapproval so both money steps see the same picture
  const ctx = await loadContext(wallet, cfg);
  const pending = await pendingDailyWork(wallet, cfg).catch(() => null);

  let converted = false;
  await step('daily-convert', at.dailyConvert, async () => {
    if (pending?.convertDone) { say('daily-convert sudah beres hari ini'); return { skipped: 'sudah beres hari ini' }; }
    const r = await convertPoints(wallet, cfg, { ctx, onLog: say, dryRun });
    if (r.skipped) say(`daily-convert skip: ${r.skipped}`);
    converted = !!r.ok;
    return r;
  });

  // point-exchange settles asynchronously; wait once so its payout can fund what follows
  if (converted && !dryRun) {
    const wait = Number(at.settleWaitSec ?? 0);
    if (wait > 0) { say(`tunggu ${wait}s biar hasil convert masuk…`); await sleep(wait * 1000); }
  }
  const funded = { ...ctx, balances: await getBalances(wallet, cfg).catch(() => ctx.balances) };

  // Subscription before the transfer: the transfer would otherwise drain the balance that pays
  // for it, and a lapsed subscription stops the quests that make the rest of this worthwhile.
  await step('extend-subscription', at.extendSubscription, async () => {
    const r = await extendSubscription(wallet, cfg, { ctx: funded, onLog: say, dryRun });
    if (r.skipped) say(`extend-subscription skip: ${r.skipped}`);
    if (r.ok) funded.balances = await getBalances(wallet, cfg).catch(() => funded.balances);
    return r;
  });

  await step('daily-internal-transfer', at.dailyInternalTransfer, async () => {
    if (pending?.internalDone) { say('daily-internal-transfer sudah beres hari ini'); return { skipped: 'sudah beres hari ini' }; }
    const peers = await resolvePeers(wallet, wallets, cfg);
    for (const p of peers) p.preapproved = await getPreapprovals(p.wallet, cfg).catch(() => []);
    const r = await dailyInternalTransfer(wallet, peers, cfg, { ctx: funded, onLog: say, dryRun });
    if (r.skipped) say(`daily-internal-transfer skip: ${r.skipped}`);
    return r;
  });

  await step('claim-akhir', at.claimQuests, async () => {
    const wait = Number(at.settleWaitSec ?? 0);
    if (wait > 0 && !dryRun) { say(`tunggu ${wait}s biar evaluator quest menyusul…`); await sleep(wait * 1000); }
    const claims = await claimAllQuests(wallet, cfg, { onLog: say, dryRun });
    return { claimed: claims.filter((c) => c.ok || c.dryRun).length, claims };
  });

  return report;
}
