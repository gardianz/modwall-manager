// Shared core for the Modulo wallet tools: config, JWT, Auth0 refresh, API, alerts.
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export class AuthError extends Error {}

export const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export function log(...a) { console.log(`[${ts()}]`, ...a); }

// --------------------------------------------------------------------------
// storage: wallets.json + config.json (both may hold secrets -> chmod 600)
// --------------------------------------------------------------------------
const WALLETS_FILE = path.join(__dirname, 'wallets.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonSecure(file, obj) {
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function loadWallets() { const d = readJson(WALLETS_FILE, { wallets: [] }); return Array.isArray(d.wallets) ? d.wallets : []; }
export function saveWallets(wallets) { writeJsonSecure(WALLETS_FILE, { wallets }); }

export function loadConfig() {
  const d = readJson(CONFIG_FILE, {});
  return {
    alert: { telegram: { botToken: '', chatId: '' }, webhookUrl: '', ...(d.alert || {}),
      telegram: { botToken: '', chatId: '', ...((d.alert || {}).telegram || {}) } },
    keeper: { checkEveryMin: 30, refreshSkewSec: 300, enableClaim: false, claimMin: 0, ...(d.keeper || {}) },
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
export async function getUserinfo(accessToken, cfg) {
  const c = apiCfg(cfg);
  try {
    const res = await fetch(`https://${c.AUTH0_DOMAIN}/userinfo`, {
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
  const res = await fetch(`https://${c.AUTH0_DOMAIN}/oauth/token`, {
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
    return fetch(`${c.API_BASE}${ppath}`, init);
  };
  let res = await call();
  if ((res.status === 401 || res.status === 403) && wallet.refreshToken) {
    await refreshWallet(wallet, cfg);
    res = await call();
  }
  const txt = await res.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (res.status === 401 || res.status === 403) throw new AuthError(`${res.status} on ${method} ${ppath}`);
  if (!res.ok) { const e = new Error(`${method} ${ppath} -> ${(data && data.error) || 'HTTP ' + res.status}`); e.status = res.status; throw e; }
  return data;
}

export function humanAmount(raw, decimals = 10) {
  try {
    const neg = String(raw).startsWith('-');
    const s = String(raw).replace('-', '').padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals) || '0';
    const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
    return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
  } catch { return String(raw); }
}

/** Gather health for one wallet (ensures a fresh token first). Returns a summary object. */
export async function walletHealth(wallet, cfg) {
  const skew = (cfg?.keeper?.refreshSkewSec ?? 300);
  if (tokenSecondsLeft(wallet.accessToken) < skew && wallet.refreshToken) await refreshWallet(wallet, cfg);
  const [cc, mod, sub, reward, refs] = await Promise.all([
    api(wallet, 'GET', '/api/canton/balances', undefined, cfg).catch((e) => ({ _err: e.message })),
    api(wallet, 'GET', '/api/canton/balances/mod', undefined, cfg).catch((e) => ({ _err: e.message })),
    api(wallet, 'GET', '/api/subscription', undefined, cfg).catch((e) => ({ _err: e.message })),
    api(wallet, 'GET', '/api/daily-reward/user-daily-reward', undefined, cfg).catch((e) => ({ _err: e.message })),
    api(wallet, 'GET', '/api/referrals/me', undefined, cfg).catch((e) => ({ _err: e.message })),
  ]);
  return { cc, mod, sub, reward, refs };
}

export async function claimDaily(wallet, cfg) {
  return api(wallet, 'POST', '/api/daily-reward/claim', {}, cfg);
}

// --------------------------------------------------------------------------
// transfers (Canton): partyId = wallet address; asset admin from asset-blockchain
// --------------------------------------------------------------------------
/** Get (and cache on the wallet) this wallet's Canton partyId = its receive address. */
export async function getPartyId(wallet, cfg) {
  const prof = await api(wallet, 'POST', '/api/auth/login', {}, cfg);
  wallet.partyId = prof?.partyId || wallet.partyId;
  wallet.status = prof?.status || wallet.status;
  if (prof?.email && !wallet.email) wallet.email = prof.email;
  return wallet.partyId;
}

/** Resolve asset transfer params for a symbol -> {symbol, decimals, native, instrumentId, instrumentAdmin}. */
export async function resolveAsset(wallet, symbol, cfg) {
  const sym = (symbol || 'CC').toUpperCase();
  const assets = await api(wallet, 'GET', '/api/asset', undefined, cfg);
  const a = (assets.assets || []).find((x) => x.symbol === sym);
  if (!a) throw new Error(`asset ${sym} tidak ditemukan`);
  const ab = await api(wallet, 'GET', '/api/asset-blockchain', undefined, cfg);
  const meta = ((ab.assetBlockchains || []).find((x) => x.assetId === a.id) || {}).metadata || null;
  return { symbol: sym, decimals: a.decimals, native: !!a.isNative, instrumentId: meta?.instrumentId, instrumentAdmin: meta?.instrumentAdmin };
}

/** Balance object for a symbol ({symbol, decimals, balance, totalBalance, ...}). */
export async function balanceOf(wallet, symbol, cfg) {
  const sym = (symbol || 'CC').toUpperCase();
  return sym === 'MOD'
    ? api(wallet, 'GET', '/api/canton/balances/mod', undefined, cfg)
    : api(wallet, 'GET', '/api/canton/balances', undefined, cfg);
}

/** Send `amount` (human string) of `symbol` from wallet to receiverPartyId. */
export async function transfer(wallet, { receiverPartyId, amount, symbol, memo }, cfg) {
  const asset = await resolveAsset(wallet, symbol, cfg);
  const body = { receiverPartyId: String(receiverPartyId).trim(), amount: String(amount) };
  if (!asset.native) {
    if (asset.instrumentId) body.instrumentId = asset.instrumentId;
    if (asset.instrumentAdmin) body.instrumentAdmin = asset.instrumentAdmin;
  }
  if (memo) body.memo = memo;
  return api(wallet, 'POST', '/api/canton/transfer', body, cfg);
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
