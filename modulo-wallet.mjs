#!/usr/bin/env node
/**
 * Modulo Wallet session keeper (app.modulo.finance / portfolio).
 *
 * Keeps ONE logged-in Modulo wallet session alive and healthy:
 *   - refreshes the Auth0 access token before it expires (needs a refresh token)
 *   - reports wallet health: CC/MOD balances, subscription state + expiry, daily-reward accrual
 *   - optionally auto-claims the accrued daily reward (ENABLE_CLAIM=true)
 *
 * Auth is an Auth0 (canton-mainnet-2.us.auth0.com) Bearer JWT for the SPA client.
 * The access token lives ~24h. To keep the session alive across days you need the
 * REFRESH_TOKEN (offline_access). Get both with:  node grab-token.mjs --login
 * If you only have ACCESS_TOKEN, the bot still monitors + claims until it expires,
 * then prints an AUTH notice.
 *
 * Usage:
 *   node modulo-wallet.mjs               # one status pass (refresh if near expiry)
 *   node modulo-wallet.mjs --dry-run     # never write (no claim, no .env update)
 *   node modulo-wallet.mjs --refresh     # force a token refresh now, then status
 *   node modulo-wallet.mjs --watch       # keep the session alive forever (loop)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '.env');

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
loadDotEnv(ENV_FILE);

const API_BASE = (process.env.API_BASE ||
  'https://modulo-canton-app-api-client-mainnet-prod.fly.dev').replace(/\/$/, '');
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || 'canton-mainnet-2.us.auth0.com';
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID || 'IJ0NkQST4x9w7e4BK78PdUktGlvDKVpW';
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || 'https://client-api.modulo.finance';
const ORIGIN = process.env.ORIGIN || 'https://app.modulo.finance';
const UA = process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

let ACCESS_TOKEN = (process.env.ACCESS_TOKEN || process.env.MODULO_TOKEN || '').trim();
let REFRESH_TOKEN = (process.env.REFRESH_TOKEN || '').trim();

// refresh when the access token has less than this many seconds of life left
const REFRESH_SKEW_SEC = intEnv('REFRESH_SKEW_SEC', 5 * 60);
// --watch loop cadence: check this often (minutes). Kept well under token lifetime.
const CHECK_EVERY_MIN = intEnv('CHECK_EVERY_MIN', 30);

const ENABLE_CLAIM = boolEnv('ENABLE_CLAIM', false);
// only claim when accrued >= this (avoids spamming tiny claims). "0" = claim any positive.
const CLAIM_MIN = Number(process.env.CLAIM_MIN || 0);

const DRY_RUN = process.argv.includes('--dry-run');
const WATCH = process.argv.includes('--watch');
const FORCE_REFRESH = process.argv.includes('--refresh');

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
function loadDotEnv(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* no .env, rely on real env */ }
}
function intEnv(k, d) { const v = parseInt(process.env[k], 10); return Number.isFinite(v) ? v : d; }
function boolEnv(k, d) { const v = process.env[k]; if (v == null) return d; return /^(1|true|yes|on)$/i.test(v.trim()); }
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function log(...a) { console.log(`[${ts()}]`, ...a); }

class AuthError extends Error {}

function decodeJwt(tok) {
  try {
    const p = tok.split('.')[1];
    const json = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch { return null; }
}
function tokenSecondsLeft(tok) {
  const p = decodeJwt(tok);
  if (!p || !p.exp) return -Infinity;
  return p.exp - Math.floor(Date.now() / 1000);
}
function fmtDur(sec) {
  if (!Number.isFinite(sec)) return '?';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${m}m` : `${m}m`;
}

/** Rewrite a KEY="value" line in .env, preserving everything else. Adds if missing. */
function writeEnvVar(key, value) {
  let lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n') : [];
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const idx = lines.findIndex((l) => re.test(l));
  const line = `${key}="${value}"`;
  if (idx >= 0) lines[idx] = line; else lines.push(line);
  writeFileSync(ENV_FILE, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
/** Exchange the refresh token for a fresh access token (Auth0 SPA public client). */
async function refreshAccessToken() {
  if (!REFRESH_TOKEN) throw new AuthError('no REFRESH_TOKEN set - run: node grab-token.mjs --login');
  const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Origin': ORIGIN },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: AUTH0_CLIENT_ID,
      refresh_token: REFRESH_TOKEN,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant = refresh token revoked/rotated away -> must re-login
    throw new AuthError(`refresh failed (${res.status} ${data.error || ''}): ${data.error_description || ''} - re-login: node grab-token.mjs --login`);
  }
  ACCESS_TOKEN = data.access_token;
  if (data.refresh_token) REFRESH_TOKEN = data.refresh_token; // rotation: keep the new one
  if (!DRY_RUN) {
    writeEnvVar('ACCESS_TOKEN', ACCESS_TOKEN);
    if (data.refresh_token) writeEnvVar('REFRESH_TOKEN', REFRESH_TOKEN);
  }
  log(`token refreshed (valid ${fmtDur(tokenSecondsLeft(ACCESS_TOKEN))})${DRY_RUN ? ' [dry: .env not written]' : ''}`);
  return ACCESS_TOKEN;
}

/** Refresh proactively if the token is missing / expired / within the skew window. */
async function ensureFreshToken(force = false) {
  const left = ACCESS_TOKEN ? tokenSecondsLeft(ACCESS_TOKEN) : -Infinity;
  if (force || left < REFRESH_SKEW_SEC) {
    if (REFRESH_TOKEN) { await refreshAccessToken(); return; }
    if (!ACCESS_TOKEN) throw new AuthError('no ACCESS_TOKEN and no REFRESH_TOKEN - run: node grab-token.mjs --login');
    if (left <= 0) throw new AuthError('ACCESS_TOKEN expired and no REFRESH_TOKEN to renew - run: node grab-token.mjs --login');
    log(`WARN token expires in ${fmtDur(left)} and no REFRESH_TOKEN - cannot auto-renew`);
  }
}

async function api(method, ppath, body) {
  const doFetch = async () => {
    const headers = {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Origin': ORIGIN,
      'Referer': `${ORIGIN}/`,
    };
    const init = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(`${API_BASE}${ppath}`, init);
  };
  let res = await doFetch();
  if ((res.status === 401 || res.status === 403) && REFRESH_TOKEN) {
    log(`${res.status} on ${method} ${ppath} - refreshing token and retrying`);
    await refreshAccessToken();
    res = await doFetch();
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`${res.status} on ${method} ${ppath} - session invalid. Re-login: node grab-token.mjs --login`);
  }
  if (!res.ok) {
    const msg = data && data.error ? data.error : `HTTP ${res.status}`;
    const e = new Error(`${method} ${ppath} -> ${msg}`); e.status = res.status; e.data = data; throw e;
  }
  return data;
}

// ---------------------------------------------------------------------------
// wallet units: balances are integer strings scaled by 10^decimals
// ---------------------------------------------------------------------------
function humanAmount(raw, decimals) {
  try {
    const neg = String(raw).startsWith('-');
    const s = String(raw).replace('-', '').padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals) || '0';
    const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
    return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
  } catch { return String(raw); }
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------
async function showStatus() {
  const [cc, mod, sub, reward, refs] = await Promise.all([
    api('GET', '/api/canton/balances').catch((e) => ({ _err: e.message })),
    api('GET', '/api/canton/balances/mod').catch((e) => ({ _err: e.message })),
    api('GET', '/api/subscription').catch((e) => ({ _err: e.message })),
    api('GET', '/api/daily-reward/user-daily-reward').catch((e) => ({ _err: e.message })),
    api('GET', '/api/referrals/me').catch((e) => ({ _err: e.message })),
  ]);

  const bal = (b) => b && !b._err
    ? `${humanAmount(b.totalBalance ?? b.balance, b.decimals ?? 10)} ${b.symbol}` +
      (b.lockedBalance && b.lockedBalance !== '0' ? ` (locked ${humanAmount(b.lockedBalance, b.decimals ?? 10)})` : '')
    : `err(${b?._err})`;
  log(`balances: ${bal(cc)} | ${bal(mod)}`);

  if (sub && !sub._err) {
    const days = sub.endAt ? ((new Date(sub.endAt) - Date.now()) / 86400000) : NaN;
    log(`subscription: ${sub.status}/${sub.state} autoRenew=${sub.autoRenew} ends ${String(sub.endAt).slice(0, 10)}` +
      (Number.isFinite(days) ? ` (${days.toFixed(1)}d left)` : ''));
    if (Number.isFinite(days) && days < 3 && !sub.autoRenew) log('  WARN subscription ends soon and autoRenew is OFF');
  } else log(`subscription: err(${sub?._err})`);

  if (reward && !reward._err) {
    log(`daily reward: accrued ${reward.accruedQuantity} status=${reward.status} lastSent=${reward.lastSentAt || 'never'}`);
  } else log(`daily reward: err(${reward?._err})`);

  if (refs && !refs._err) log(`referrals: code ${refs.myCode} invited ${refs.referreeCount}`);

  return { cc, mod, sub, reward, refs };
}

async function claimDaily(reward) {
  if (!ENABLE_CLAIM) return;
  const accrued = Number(reward?.accruedQuantity ?? 0);
  if (!Number.isFinite(accrued) || accrued <= 0) { log('claim: nothing accrued'); return; }
  if (accrued < CLAIM_MIN) { log(`claim: accrued ${accrued} < CLAIM_MIN ${CLAIM_MIN}, skip`); return; }
  if (DRY_RUN) { log(`  [dry] would CLAIM daily reward (${accrued})`); return; }
  try {
    const r = await api('POST', '/api/daily-reward/claim', {});
    log(`claimed daily reward (${accrued})`, r ? JSON.stringify(r).slice(0, 200) : '');
  } catch (e) { log(`claim failed: ${e.message}`); }
}

async function runOnce(force = false) {
  log(`=== pass start${DRY_RUN ? ' (DRY RUN)' : ''} ===`);
  await ensureFreshToken(force);
  const left = tokenSecondsLeft(ACCESS_TOKEN);
  log(`token valid ${fmtDur(left)}${REFRESH_TOKEN ? ' (auto-refresh ON)' : ' (no refresh token)'}`);
  const { reward } = await showStatus();
  await claimDaily(reward);
  log('=== pass done ===');
}

async function main() {
  if (!ACCESS_TOKEN && !REFRESH_TOKEN) {
    log('No ACCESS_TOKEN or REFRESH_TOKEN. Copy .env.example to .env (or run: node grab-token.mjs --login).');
    process.exitCode = 2; return;
  }
  try {
    await runOnce(FORCE_REFRESH);
  } catch (e) {
    if (e instanceof AuthError) { log('AUTH:', e.message); process.exitCode = 2; return; }
    log('fatal:', e.message); process.exitCode = 1; return;
  }
  if (WATCH) {
    const ms = CHECK_EVERY_MIN * 60 * 1000;
    for (;;) {
      log(`next check in ${CHECK_EVERY_MIN}m`);
      await sleep(ms);
      try { await runOnce(false); }
      catch (e) {
        if (e instanceof AuthError) { log('AUTH:', e.message, '- stopping watch.'); return; }
        log('pass error:', e.message);
      }
    }
  }
}

main();
