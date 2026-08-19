// Shared core for the Modulo wallet tools: config, JWT, Auth0 refresh, API, alerts.
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import { proxyFetch, loadProxyFile, assignProxies, proxyLabel } from './proxy.mjs';

// Some hosts (WSL2 in particular) advertise IPv6 but cannot route it. Node's happy-eyeballs
// then stalls on the API's AAAA record until ETIMEDOUT while curl works fine. Pin IPv4.
try { net.setDefaultAutoSelectFamily(false); } catch { /* older node */ }
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* older node */ }

export const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- static config (discovered from the live app; override via config.json > api) ---
export const DEFAULTS = {
  API_BASE: 'https://modulo-canton-app-api-client-mainnet-prod.fly.dev',
  AUTH0_DOMAIN: 'canton-mainnet-2.us.auth0.com',
  AUTH0_CLIENT_ID: 'IJ0NkQST4x9w7e4BK78PdUktGlvDKVpW',
  AUTH0_AUDIENCE: 'https://client-api.modulo.finance',
  ORIGIN: 'https://app.modulo.finance',
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

/** Fee-instrument preference order used by the app itself (assets/instrument ids). */
export const FEE_INSTRUMENT_ORDER = ['CBTC', 'cETH', 'USDCx', 'Amulet', 'MOD'];
/** Quest slugs the auto-runner never attempts (cost/risk decided by the user). */
export const DEFAULT_SKIP_SLUGS = ['daily-swap', 'daily-external-cip56-transfer'];
/** The API caps this; larger values are rejected with 400. */
export const QUEST_PAGE_SIZE = 50;

export class AuthError extends Error {}

export const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export function log(...a) { console.log(`[${ts()}]`, ...a); }

// --------------------------------------------------------------------------
// storage: wallets.json + config.json (both may hold secrets -> chmod 600)
// --------------------------------------------------------------------------
const WALLETS_FILE = path.join(__dirname, 'wallets.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PROXY_FILE = path.join(__dirname, 'proxies.txt');

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonSecure(file, obj) {
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

export let proxyErrors = [];

/**
 * Wallets come back with `.proxy` already attached from proxies.txt — one line per account, in
 * order — so no caller has to remember to wire it up.
 */
export function loadWallets() {
  const d = readJson(WALLETS_FILE, { wallets: [] });
  const wallets = Array.isArray(d.wallets) ? d.wallets : [];
  const file = loadProxyFile(PROXY_FILE);
  proxyErrors = file.errors;
  return assignProxies(wallets, file);
}

/** `proxy` is derived from proxies.txt, so it is never written back into wallets.json. */
export function saveWallets(wallets) {
  writeJsonSecure(WALLETS_FILE, { wallets: wallets.map(({ proxy, ...w }) => w) });
}

/**
 * The fetch a wallet must use. Cached per wallet, and rebuilt if its proxy line changed, so an
 * edited proxies.txt takes effect on the next load instead of silently keeping the old exit IP.
 */
const fetchCache = new WeakMap();
export function fetchFor(wallet) {
  if (!wallet?.proxy) return globalThis.fetch;
  const hit = fetchCache.get(wallet);
  if (hit && hit.proxy === wallet.proxy) return hit.fn;
  const fn = proxyFetch(wallet.proxy);
  fetchCache.set(wallet, { proxy: wallet.proxy, fn });
  return fn;
}
export { proxyLabel };

export function loadConfig() {
  const d = readJson(CONFIG_FILE, {});
  return {
    alert: { telegram: { botToken: '', chatId: '' }, webhookUrl: '', ...(d.alert || {}),
      telegram: { botToken: '', chatId: '', ...((d.alert || {}).telegram || {}) } },
    keeper: { checkEveryMin: 30, refreshSkewSec: 300, ...(d.keeper || {}) },
    autoTask: {
      enabled: false,            // run the auto-task pass inside the keeper loop
      preapproveAll: true,       // grant transfer-preapproval for every active instrument
      dailyConvert: true,        // points -> asset (daily-convert quest)
      dailyInternalTransfer: true, // CIP-56 send to another imported wallet (daily-internal quest)
      claimQuests: true,         // claim every COMPLETED quest
      extendSubscription: true,  // renew/extend the current tier before it lapses
      skipSlugs: [...DEFAULT_SKIP_SLUGS],
      maxFeeUsd: 0.3,            // hard guard: never act when the estimated fee exceeds this
      internalTransferUsd: 0.01, // size of the quest transfer, in USD
      fundSubscription: true,    // top a wallet up from a peer when it cannot pay its renewal
      maxFundingUsd: 0.5,        // hard guard on one top-up transfer
      fundingMarginPercent: 30,  // send this much extra, so spot drift cannot undershoot
      convertPreferSymbols: ['CBTC', 'cETH'], // discounted point-exchange targets
      convertOnlyDiscounted: true, // never fall back to a non-discounted payout asset
      extendWhenDaysLeft: 3,     // only extend once the subscription is this close to ending
      maxSubscriptionUsd: 0.3,   // hard guard for the subscription payment itself
      settleWaitSec: 25,         // pause before re-polling quests so the evaluator can catch up
      loopRetryMin: 30,          // daily loop: how often to re-check inside the same UTC day
      loopStartOffsetMin: 5,     // daily loop: start the new day this long after 00:00 UTC
      ...(d.autoTask || {}),
    },
    api: { ...(d.api || {}) },
  };
}
export function saveConfig(cfg) { writeJsonSecure(CONFIG_FILE, cfg); }
export function apiCfg(cfg) { return { ...DEFAULTS, ...(cfg?.api || {}) }; }

// --------------------------------------------------------------------------
// jwt helpers
// --------------------------------------------------------------------------
export function decodeJwt(tok) {
  try {
    const json = Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch { return null; }
}
export function tokenSecondsLeft(tok) {
  const p = tok && decodeJwt(tok);
  if (!p || !p.exp) return -Infinity;
  return p.exp - Math.floor(Date.now() / 1000);
}
export function fmtDur(sec) {
  if (!Number.isFinite(sec)) return '?';
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d${h}h`;
  return h ? `${h}h${m}m` : `${m}m`;
}

// --------------------------------------------------------------------------
// import parsing: accept raw JWT, {access_token,refresh_token}, or the
// auth0-spa-js localStorage entry (has .body). "cookie" paste also handled.
// --------------------------------------------------------------------------
export function parseImport(text) {
  const raw = (text || '').trim();
  if (!raw) return {};
  // 1) JSON (object or the localStorage value)
  try {
    const j = JSON.parse(raw);
    const b = j && j.body ? j.body : j;
    if (b && (b.access_token || b.accessToken)) {
      return { accessToken: b.access_token || b.accessToken, refreshToken: b.refresh_token || b.refreshToken || '' };
    }
  } catch { /* not json */ }
  // 2) key=value; key=value (cookie-ish) -> pull access_token / refresh_token
  if (raw.includes('=') && /access_?token|refresh_?token/i.test(raw)) {
    const get = (re) => (raw.match(re) || [])[1];
    const at = get(/access_?token"?\s*[:=]\s*"?([A-Za-z0-9._-]+)/i);
    const rt = get(/refresh_?token"?\s*[:=]\s*"?([A-Za-z0-9._-]+)/i);
    if (at) return { accessToken: at, refreshToken: rt || '' };
  }
  // 3) bare JWT
  if (/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)) return { accessToken: raw, refreshToken: '' };
  // 4) two whitespace-separated tokens: access refresh
  const parts = raw.split(/\s+/);
  if (parts.length === 2 && /^ey/.test(parts[0])) return { accessToken: parts[0], refreshToken: parts[1] };
  return {};
}

// --------------------------------------------------------------------------
// auth0
// --------------------------------------------------------------------------
export async function getUserinfo(accessToken, cfg, wallet = null) {
  const c = apiCfg(cfg);
  try {
    const res = await fetchFor(wallet)(`https://${c.AUTH0_DOMAIN}/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': c.UA },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Refresh one wallet's access token. Mutates wallet (accessToken/refreshToken/lastRefreshAt). Throws AuthError on failure. */
export async function refreshWallet(wallet, cfg) {
  const c = apiCfg(cfg);
  if (!wallet.refreshToken) throw new AuthError('no refresh token for this wallet');
  // Auth0 must be reached through the same exit IP as the API, or the session looks like it
  // hopped countries mid-flight.
  const res = await fetchFor(wallet)(`https://${c.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': c.UA, Origin: c.ORIGIN },
    body: JSON.stringify({ grant_type: 'refresh_token', client_id: c.AUTH0_CLIENT_ID, refresh_token: wallet.refreshToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = `${res.status} ${data.error || ''} ${data.error_description || ''}`.trim();
    throw new AuthError(msg);
  }
  wallet.accessToken = data.access_token;
  if (data.refresh_token) wallet.refreshToken = data.refresh_token; // rotation
  wallet.lastRefreshAt = new Date().toISOString();
  return wallet;
}

/** Refresh only when the token is inside the skew window. */
export async function ensureFresh(wallet, cfg) {
  const skew = cfg?.keeper?.refreshSkewSec ?? 300;
  if (tokenSecondsLeft(wallet.accessToken) < skew && wallet.refreshToken) await refreshWallet(wallet, cfg);
  return wallet;
}

// --------------------------------------------------------------------------
// api (per wallet), auto-refresh on 401/403
// --------------------------------------------------------------------------
export async function api(wallet, method, ppath, body, cfg) {
  const c = apiCfg(cfg);
  const call = async () => {
    const headers = {
      Authorization: `Bearer ${wallet.accessToken}`,
      'User-Agent': c.UA, Accept: 'application/json, text/plain, */*',
      Origin: c.ORIGIN, Referer: `${c.ORIGIN}/`,
    };
    const init = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetchFor(wallet)(`${c.API_BASE}${ppath}`, init);
  };
  let res = await call();
  if ((res.status === 401 || res.status === 403) && wallet.refreshToken) {
    await refreshWallet(wallet, cfg);
    res = await call();
  }
  const txt = await res.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (res.status === 401 || res.status === 403) throw new AuthError(`${res.status} on ${method} ${ppath}`);
  if (!res.ok) {
    const detail = (data && (data.message || data.error)) || 'error';
    const e = new Error(`${method} ${ppath} -> ${res.status} ${Array.isArray(detail) ? detail.join('; ') : detail}`);
    e.status = res.status; e.data = data; throw e;
  }
  return data;
}

// --------------------------------------------------------------------------
// decimal helpers
//
// The API speaks *human* decimal strings ("0.0000805087"), not scaled integers.
// Quantities are compared/added as BigInt units so nothing is lost to floats;
// only USD/price arithmetic runs through Number, and always truncates like the app
// (Decimal.ROUND_DOWN) so an estimate can never overstate what the user receives.
// --------------------------------------------------------------------------
function expandExponential(s) {
  const m = /^(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const [, w = '', f = '', e] = m;
  const digits = w + f;
  const point = w.length + parseInt(e, 10);
  if (point <= 0) return '0.' + '0'.repeat(-point) + digits;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return digits.slice(0, point) + '.' + digits.slice(point);
}

/** Decimal string -> BigInt units at `dec` places (truncating extra precision). */
export function toUnits(value, dec = 10) {
  let s = String(value ?? '0').trim();
  if (!s || s === '-' || s === '.') return 0n;
  let neg = false;
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (/[eE]/.test(s)) s = expandExponential(s);
  const [w = '0', f = ''] = s.split('.');
  if (!/^\d*$/.test(w) || !/^\d*$/.test(f)) return 0n;
  const frac = (f + '0'.repeat(dec)).slice(0, dec);
  const v = BigInt(w || '0') * 10n ** BigInt(dec) + BigInt(frac || '0');
  return neg ? -v : v;
}

/** BigInt units -> trimmed decimal string. */
export function fromUnits(units, dec = 10) {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const scale = 10n ** BigInt(dec);
  const w = (abs / scale).toString();
  let f = (abs % scale).toString().padStart(dec, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + w + (f ? '.' + f : '');
}

/** Number -> decimal string truncated (never rounded up) at `dec` places. */
export function truncDecimals(value, dec = 10) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  // toFixed with headroom, then cut: rounding at dec+6 cannot bubble into dec.
  const s = expandExponential(Math.abs(n).toFixed(Math.min(100, dec + 6)));
  const [w, f = ''] = s.split('.');
  const out = fromUnits(toUnits(`${w}.${f}`, dec), dec);
  return n < 0 && out !== '0' ? '-' + out : out;
}

/** Legacy: scaled-integer -> human string. Kept for old payloads; live balances are already human. */
export function humanAmount(raw, decimals = 10) {
  try { return fromUnits(BigInt(String(raw).replace(/\..*$/, '')), decimals); }
  catch { return String(raw); }
}

export function fmtUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$?';
  return '$' + (Math.abs(v) < 0.01 && v !== 0 ? v.toFixed(4) : v.toFixed(2));
}

// --------------------------------------------------------------------------
// profile
// --------------------------------------------------------------------------
/** Get (and cache on the wallet) this wallet's Canton partyId = its receive address. */
export async function getPartyId(wallet, cfg) {
  const prof = await api(wallet, 'POST', '/api/auth/login', {}, cfg);
  wallet.partyId = prof?.partyId || wallet.partyId;
  wallet.status = prof?.status || wallet.status;
  if (prof?.email && !wallet.email) wallet.email = prof.email;
  return wallet.partyId;
}

// --------------------------------------------------------------------------
// instruments: /api/asset joined with /api/asset-blockchain metadata
// --------------------------------------------------------------------------
/**
 * Instrument table keyed by symbol:
 *   { symbol, instrumentId, decimals, isNative, isActive, canPointExchange,
 *     feeDiscountPercent, subscriptionDiscountPercent, pointExchangeDiscountPercent, instrumentAdmin }
 * Cached per wallet for the life of the process (the table changes rarely).
 */
const instrumentCache = new WeakMap();
export async function getInstruments(wallet, cfg, { force = false } = {}) {
  if (!force && instrumentCache.has(wallet)) return instrumentCache.get(wallet);
  const [assetRes, abRes] = await Promise.all([
    api(wallet, 'GET', '/api/asset', undefined, cfg),
    api(wallet, 'GET', '/api/asset-blockchain', undefined, cfg),
  ]);
  const metaByAssetId = new Map();
  for (const ab of abRes.assetBlockchains || []) {
    if (ab.isActive) metaByAssetId.set(ab.assetId, ab.metadata || {});
  }
  const out = {};
  for (const a of assetRes.assets || []) {
    const m = metaByAssetId.get(a.id) || {};
    out[a.symbol] = {
      symbol: a.symbol,
      instrumentId: m.instrumentId || a.symbol,
      decimals: a.decimals ?? 10,
      isNative: !!a.isNative,
      isActive: !!a.isActive,
      canPointExchange: !!a.canPointExchange,
      instrumentAdmin: m.instrumentAdmin,
      feeDiscountPercent: Number(m.feeDiscountPercent ?? 0),
      subscriptionDiscountPercent: Number(m.subscriptionDiscountPercent ?? 0),
      pointExchangeDiscountPercent: Number(m.pointExchangeDiscountPercent ?? 0),
    };
  }
  instrumentCache.set(wallet, out);
  return out;
}

export function instrumentBySymbol(instruments, symbol) {
  const key = Object.keys(instruments).find((s) => s.toLowerCase() === String(symbol || '').toLowerCase());
  return key ? instruments[key] : null;
}
export function instrumentById(instruments, instrumentId) {
  return Object.values(instruments).find((i) => i.instrumentId === instrumentId) || null;
}

// --------------------------------------------------------------------------
// balances / preapproval
// --------------------------------------------------------------------------
/** { SYMBOL: { availableBalance, lockedBalance, totalBalance } } — human decimal strings. */
export async function getBalances(wallet, cfg) {
  const r = await api(wallet, 'GET', '/api/canton/balances', undefined, cfg);
  return r?.balances || {};
}
export function availableOf(balances, symbol) {
  return balances?.[symbol]?.availableBalance ?? '0';
}

/** Instrument ids this wallet has already preapproved for transfers. */
export async function getPreapprovals(wallet, cfg) {
  const r = await api(wallet, 'GET', '/api/canton/transfer-preapproval', undefined, cfg);
  return Array.isArray(r?.instrumentIds) ? r.instrumentIds : [];
}
/** The app's "Enable" button. Idempotent server-side; returns { updateId }. */
export async function grantPreapproval(wallet, instrumentId, cfg) {
  return api(wallet, 'POST', '/api/canton/transfer-preapproval', { instrumentId }, cfg);
}

// --------------------------------------------------------------------------
// rewards: points, exchange rates, point exchange ("Convert")
// --------------------------------------------------------------------------
export async function getPoints(wallet, cfg) {
  const r = await api(wallet, 'GET', '/api/rewards/user-points', undefined, cfg);
  return r?.claimable ? r : { claimable: {}, lifetime: {} };
}
/** { SYMBOL: { symbol, instrumentId, decimals, usdPerUnit, usdPerPoint, pointsPerUsd, ... } } */
export async function getExchangeRates(wallet, cfg) {
  const r = await api(wallet, 'GET', '/api/rewards/exchange-rates', undefined, cfg);
  const out = {};
  for (const a of r?.assets || []) out[a.symbol] = a;
  return out;
}
/** Convert points -> asset. The server decides the amount (up to pointExchangeMaximumQtyPerClaim). */
export async function exchangePoints(wallet, instrumentId, cfg) {
  return api(wallet, 'POST', '/api/rewards/point-exchange', { instrumentId }, cfg);
}

// --------------------------------------------------------------------------
// quests
// --------------------------------------------------------------------------
/** status: 'active' (claimable) | 'completed' | 'expired' | undefined (all). pageSize caps at 50. */
export async function getQuests(wallet, cfg, { status } = {}) {
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  q.set('pageSize', String(QUEST_PAGE_SIZE));
  const r = await api(wallet, 'GET', `/api/user-quests?${q}`, undefined, cfg);
  return r?.quests || [];
}
export async function getAvailableQuests(wallet, cfg) {
  const r = await api(wallet, 'GET', `/api/user-quests/available?pageSize=${QUEST_PAGE_SIZE}`, undefined, cfg);
  return r?.quests || [];
}
export async function getQuestCounts(wallet, cfg) {
  return api(wallet, 'GET', '/api/user-quests/counts', undefined, cfg);
}
/** Quests that are finished but not yet claimed (the app's "Claim" buttons). */
export async function getClaimableQuests(wallet, cfg) {
  const quests = await getQuests(wallet, cfg, { status: 'active' });
  return quests.filter((q) => q.status === 'COMPLETED' && !q.isLocked && !q.claimedAt);
}
export async function claimQuest(wallet, progressId, cfg) {
  return api(wallet, 'POST', `/api/user-quests/${progressId}/claim`, undefined, cfg);
}

// --------------------------------------------------------------------------
// subscription
// --------------------------------------------------------------------------
export async function getSubscription(wallet, cfg) {
  return api(wallet, 'GET', '/api/subscription', undefined, cfg);
}
export async function getSubscriptionTiers(wallet, cfg) {
  const r = await api(wallet, 'GET', '/api/subscription-tier', undefined, cfg);
  return r?.subscriptionTiers || [];
}
/** The tier row backing this wallet's subscription — carries every fee in USD. */
export async function getMyTier(wallet, cfg) {
  const [sub, tiers] = await Promise.all([
    getSubscription(wallet, cfg).catch(() => null),
    getSubscriptionTiers(wallet, cfg),
  ]);
  const tier = tiers.find((t) => t.id === sub?.tierId) || tiers.find((t) => t.name === 'Free') || null;
  return { sub, tier, tiers };
}

/** Subscribe / renew / extend — one endpoint. instrumentId picks the payment token. */
export async function subscribe(wallet, { tierId, instrumentId }, cfg) {
  const body = { tierId };
  if (instrumentId) body.instrumentId = instrumentId; // server default is "Amulet" (CC)
  return api(wallet, 'POST', '/api/subscription/subscribe', body, cfg);
}

/** Statuses where a payment is already in flight — never start another one. */
export const SUBSCRIPTION_PENDING = ['REQUESTED', 'PENDING', 'AWAITING_PAYMENT'];
/** The app offers "Extend" while fewer than this many days remain. */
export const EXTEND_WINDOW_DAYS = 31;
const SUB_DAY_MS = 1440 * 60 * 1000;

/** Days left, rounded UP like the app (0 = ended). */
export function subscriptionDaysRemaining(sub, now = Date.now()) {
  if (!sub?.endAt) return 0;
  const ms = new Date(sub.endAt).getTime() - now;
  return !Number.isFinite(ms) || ms <= 0 ? 0 : Math.ceil(ms / SUB_DAY_MS);
}

/** price = costUsd * max(0, 1 + modifier/100); modifier = -subscriptionDiscountPercent. */
export function subscriptionPriceUsd(costAmountUsd, modifierPercent = 0) {
  return Number(costAmountUsd) * Math.max(0, 1 + Number(modifierPercent) / 100);
}
export function subscriptionQuantity(costAmountUsd, modifierPercent, spotUsdPerUnit, decimals = 10) {
  const spot = Number(spotUsdPerUnit);
  if (!(spot > 0)) throw new Error('spot price must be positive');
  return truncDecimals(subscriptionPriceUsd(costAmountUsd, modifierPercent) / spot, decimals);
}

/**
 * What each active instrument would cost to pay one subscription, ignoring balances.
 * Sorted biggest-discount first. Used to size a top-up before the wallet can pay at all.
 */
export function quoteSubscriptionPayments({ instruments, costAmountUsd, rates, prefer = FEE_INSTRUMENT_ORDER }) {
  const order = (i) => { const k = prefer.indexOf(i.instrumentId); return k < 0 ? prefer.length : k; };
  return Object.values(instruments)
    .filter((i) => i.isActive && Number(rates[i.symbol]?.usdPerUnit) > 0)
    .sort((a, b) => (b.subscriptionDiscountPercent - a.subscriptionDiscountPercent) || (order(a) - order(b)))
    .map((i) => {
      const modifier = -(i.subscriptionDiscountPercent || 0);
      return {
        symbol: i.symbol, instrumentId: i.instrumentId, decimals: i.decimals,
        quantity: subscriptionQuantity(costAmountUsd, modifier, rates[i.symbol].usdPerUnit, i.decimals),
        usd: subscriptionPriceUsd(costAmountUsd, modifier),
        discountPercent: i.subscriptionDiscountPercent,
      };
    });
}

/**
 * Pick the token that pays for the subscription: biggest discount first, then the app's order.
 * The app requires balance strictly greater than the payment quantity — matched here.
 */
export function pickSubscriptionPayment({
  instruments, balances, preapproved, costAmountUsd, rates, prefer = FEE_INSTRUMENT_ORDER,
}) {
  const order = (i) => { const k = prefer.indexOf(i.instrumentId); return k < 0 ? prefer.length : k; };
  const candidates = Object.values(instruments)
    .filter((i) => i.isActive && Number(rates[i.symbol]?.usdPerUnit) > 0)
    .sort((a, b) => (b.subscriptionDiscountPercent - a.subscriptionDiscountPercent) || (order(a) - order(b)));

  for (const i of candidates) {
    const modifier = -(i.subscriptionDiscountPercent || 0);
    const qty = subscriptionQuantity(costAmountUsd, modifier, rates[i.symbol].usdPerUnit, i.decimals);
    if (toUnits(availableOf(balances, i.symbol), i.decimals) <= toUnits(qty, i.decimals)) continue;
    return {
      symbol: i.symbol, instrumentId: i.instrumentId, decimals: i.decimals,
      quantity: qty, usd: subscriptionPriceUsd(costAmountUsd, modifier),
      discountPercent: i.subscriptionDiscountPercent,
      preapproved: preapproved.includes(i.instrumentId),
    };
  }
  return null;
}

// --------------------------------------------------------------------------
// fee math — mirrors the app (feeModifierPercent = -discount, ROUND_DOWN)
// --------------------------------------------------------------------------
export const MODULO_PARTY_RE = /^modulo::1220[a-fA-F0-9]{64}$/;
/** The app charges the *internal* fee for any well-formed modulo:: party id. */
export function isModuloParty(p) { return MODULO_PARTY_RE.test(String(p || '').trim()); }

/** feeUsd = baseUsd * max(0, 1 + modifierPercent/100). Discount d comes in as modifier -d. */
export function feeUsdWithModifier(baseUsd, modifierPercent = 0) {
  return Number(baseUsd) * Math.max(0, 1 + Number(modifierPercent) / 100);
}
/** Fee expressed in the fee instrument, truncated at its decimals. */
export function feeQuantity(baseUsd, modifierPercent, spotUsdPerUnit, decimals = 10) {
  const spot = Number(spotUsdPerUnit);
  if (!(spot > 0)) throw new Error('spot price must be positive');
  return truncDecimals(feeUsdWithModifier(baseUsd, modifierPercent) / spot, decimals);
}
/** Which USD fee applies to this destination. */
export function transferFeeUsdFor(receiverPartyId, tier) {
  return Number(isModuloParty(receiverPartyId) ? (tier?.internalTransferFeeUsd ?? 0) : (tier?.transferFeeUsd ?? 0));
}

/**
 * Choose which token pays the fee: biggest discount first, then the app's own order.
 * Mirrors the app's validity rule — when the fee token *is* the token being sent, the
 * balance has to cover fee + amount, otherwise just the fee.
 * Returns null when nothing qualifies.
 */
export function pickFeeInstrument({
  instruments, balances, preapproved, baseUsd, rates,
  transferInstrumentId = null, transferQuantity = '0', prefer = FEE_INSTRUMENT_ORDER,
}) {
  const order = (i) => { const k = prefer.indexOf(i.instrumentId); return k < 0 ? prefer.length : k; };
  const candidates = Object.values(instruments)
    .filter((i) => i.isActive && preapproved.includes(i.instrumentId) && Number(rates[i.symbol]?.usdPerUnit) > 0)
    .sort((a, b) => (b.feeDiscountPercent - a.feeDiscountPercent) || (order(a) - order(b)));

  for (const i of candidates) {
    const modifier = -(i.feeDiscountPercent || 0);
    const qty = feeQuantity(baseUsd, modifier, rates[i.symbol].usdPerUnit, i.decimals);
    const need = toUnits(qty, i.decimals)
      + (i.instrumentId === transferInstrumentId ? toUnits(transferQuantity, i.decimals) : 0n);
    if (toUnits(availableOf(balances, i.symbol), i.decimals) < need) continue;
    return {
      symbol: i.symbol, instrumentId: i.instrumentId, decimals: i.decimals,
      quantity: qty, usd: feeUsdWithModifier(baseUsd, modifier),
      discountPercent: i.feeDiscountPercent,
    };
  }
  return null;
}

// --------------------------------------------------------------------------
// transfers
// --------------------------------------------------------------------------
/**
 * Send `quantity` (human decimal string) of an instrument to a Canton party.
 * Body per the live API: { receiverPartyId, quantity, instrumentId?, memo?, feeInstrumentId? }.
 * The server computes and charges the fee itself; feeInstrumentId only picks which token pays.
 * Legacy callers may still pass { amount, symbol } — both are accepted.
 */
export async function transfer(wallet, opts, cfg) {
  const { receiverPartyId, memo, feeInstrumentId } = opts;
  const quantity = String(opts.quantity ?? opts.amount ?? '').trim();
  if (!quantity) throw new Error('quantity kosong');
  let instrumentId = opts.instrumentId;
  if (!instrumentId) {
    const instruments = await getInstruments(wallet, cfg);
    const inst = instrumentBySymbol(instruments, opts.symbol || 'CC');
    if (!inst) throw new Error(`asset ${opts.symbol} tidak ditemukan`);
    instrumentId = inst.instrumentId;
  }
  const body = { receiverPartyId: String(receiverPartyId).trim(), quantity, instrumentId };
  if (memo) body.memo = memo;
  if (feeInstrumentId) body.feeInstrumentId = feeInstrumentId;
  return api(wallet, 'POST', '/api/canton/transfer', body, cfg);
}

/** Balance row for a symbol, kept for callers that ask per-asset. */
export async function balanceOf(wallet, symbol, cfg) {
  const balances = await getBalances(wallet, cfg);
  const sym = Object.keys(balances).find((s) => s.toLowerCase() === String(symbol || 'CC').toLowerCase()) || symbol;
  return { symbol: sym, ...(balances[sym] || { availableBalance: '0', lockedBalance: '0', totalBalance: '0' }) };
}

/**
 * Build a transfer plan. senders/receivers are arrays of { wallet?, partyId, label }.
 *  - 1 receiver         -> every sender -> that receiver (collect / one-to-one)
 *  - 1 sender, N recv   -> that sender -> each receiver (distribute)
 *  - N senders, N recv  -> pair by index (must be equal length)
 */
export function planTransfers(senders, receivers, amount) {
  const plan = [];
  if (receivers.length === 1) for (const s of senders) plan.push({ from: s, to: receivers[0], amount });
  else if (senders.length === 1) for (const r of receivers) plan.push({ from: senders[0], to: r, amount });
  else {
    if (senders.length !== receivers.length) throw new Error('sender & receiver harus sama jumlahnya untuk mode pasangan (atau pakai 1 sisi tunggal)');
    for (let i = 0; i < senders.length; i++) plan.push({ from: senders[i], to: receivers[i], amount });
  }
  return plan;
}

// --------------------------------------------------------------------------
// health
// --------------------------------------------------------------------------
/** Snapshot for one wallet (ensures a fresh token first). Every field degrades to { _err }. */
export async function walletHealth(wallet, cfg) {
  await ensureFresh(wallet, cfg);
  const safe = (p) => p.catch((e) => ({ _err: e.message }));
  const [balances, sub, points, counts, refs] = await Promise.all([
    safe(getBalances(wallet, cfg)),
    safe(getSubscription(wallet, cfg)),
    safe(getPoints(wallet, cfg)),
    safe(getQuestCounts(wallet, cfg)),
    safe(api(wallet, 'GET', '/api/referrals/me', undefined, cfg)),
  ]);
  return { balances, sub, points, counts, refs };
}

/** "0.0000805087 CBTC · 0 CC" style summary of the non-zero balances. */
export function fmtBalances(balances, { all = false } = {}) {
  if (!balances || balances._err) return `err(${balances?._err || '?'})`;
  const rows = Object.entries(balances)
    .filter(([, b]) => all || toUnits(b.totalBalance, 10) > 0n)
    .map(([sym, b]) => `${b.totalBalance} ${sym}`);
  return rows.length ? rows.join(' · ') : '(kosong)';
}

// --------------------------------------------------------------------------
// alerts: Telegram + generic webhook
// --------------------------------------------------------------------------
export async function sendAlert(cfg, text) {
  const a = cfg.alert || {};
  const results = [];
  const tg = a.telegram || {};
  if (tg.botToken && tg.chatId) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tg.chatId, text, disable_web_page_preview: true }),
      });
      results.push({ ch: 'telegram', ok: res.ok, status: res.status });
    } catch (e) { results.push({ ch: 'telegram', ok: false, err: e.message }); }
  }
  if (a.webhookUrl) {
    try {
      const res = await fetch(a.webhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, content: text, service: 'modulo-wallet-keeper', ts: new Date().toISOString() }),
      });
      results.push({ ch: 'webhook', ok: res.ok, status: res.status });
    } catch (e) { results.push({ ch: 'webhook', ok: false, err: e.message }); }
  }
  return results;
}

export function walletLabel(w) { return w.label || w.email || (w.sub ? w.sub.split('|').pop() : w.id) || 'wallet'; }
