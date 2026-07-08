#!/usr/bin/env node
/**
 * Grab a fresh Modulo wallet ACCESS_TOKEN (+ REFRESH_TOKEN) from a real browser profile.
 *
 * app.modulo.finance is an Auth0 SPA (auth0-spa-js). After you log in once with Google in
 * a persistent browser profile, auth0-spa-js keeps a refresh token in localStorage under
 *   @@auth0spajs@@::<clientId>::<audience>::<scope>
 * Google's session in that profile stays valid for weeks, so this can re-mint tokens headless.
 *
 * First time (headed, needs a display, do the Google login + 2FA yourself):
 *     npm i playwright && npx playwright install chromium
 *     node grab-token.mjs --login
 *   -> browser opens. Click "Continue with Google", finish login, wait until /portfolio loads.
 *      Press Enter in the terminal. Tokens are read from localStorage and written to .env.
 *
 * After that (headless, cron-able):
 *     node grab-token.mjs         # reuse profile, refresh tokens, update .env
 *
 * Then keep the session alive:  node modulo-wallet.mjs --watch
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(__dirname, '.env'));

const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, '.browser-profile');
const ENV_FILE = path.join(__dirname, '.env');
const APP = process.env.ORIGIN || 'https://app.modulo.finance';
const CLIENT_ID = process.env.AUTH0_CLIENT_ID || 'IJ0NkQST4x9w7e4BK78PdUktGlvDKVpW';
const LOGIN = process.argv.includes('--login');

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

function loadDotEnv(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('='); if (eq < 0) continue;
      const k = t.slice(0, eq).trim(); let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* none */ }
}
function waitEnter(msg) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => { rl.close(); res(); });
  });
}
function writeEnvVar(key, value) {
  let lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n') : [];
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const idx = lines.findIndex((l) => re.test(l));
  const line = `${key}="${value}"`;
  if (idx >= 0) lines[idx] = line; else lines.push(line);
  writeFileSync(ENV_FILE, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
}

/** Read the auth0-spa-js cache entry from localStorage -> {access_token, refresh_token}. */
async function readAuth0Tokens(page, clientId) {
  return page.evaluate((cid) => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('@@auth0spajs@@')) continue;
      if (cid && !key.includes(cid)) continue;
      try {
        const v = JSON.parse(localStorage.getItem(key));
        const b = v && v.body ? v.body : v;
        if (b && b.access_token) {
          out.access_token = b.access_token;
          if (b.refresh_token) out.refresh_token = b.refresh_token;
          out.expires_in = b.expires_in;
          out.key = key;
        }
      } catch { /* skip */ }
    }
    return out;
  }, clientId);
}

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !LOGIN,
    viewport: { width: 1280, height: 800 },
    channel: process.env.PW_CHANNEL || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    await page.goto(`${APP}/portfolio`, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (LOGIN) {
      log('Browser open. Log in with Google, wait until /portfolio shows your wallet.');
      await waitEnter('Press Enter here once you are logged in... ');
    } else {
      // let auth0-spa-js silently renew and populate localStorage
      await page.waitForTimeout(6000);
    }

    let tok = await readAuth0Tokens(page, CLIENT_ID);
    if (!tok.access_token) { await page.waitForTimeout(4000); tok = await readAuth0Tokens(page, CLIENT_ID); }

    if (!tok.access_token) {
      log('No Auth0 token in localStorage.', LOGIN ? 'Login not completed.' : 'Session expired - run: node grab-token.mjs --login');
      process.exitCode = 2; return;
    }
    writeEnvVar('ACCESS_TOKEN', tok.access_token);
    if (tok.refresh_token) writeEnvVar('REFRESH_TOKEN', tok.refresh_token);

    const exp = (() => { try { const p = JSON.parse(Buffer.from(tok.access_token.split('.')[1], 'base64').toString()); return new Date(p.exp * 1000).toISOString(); } catch { return '?'; } })();
    log(`OK. ACCESS_TOKEN written (exp ${exp}).${tok.refresh_token ? ' REFRESH_TOKEN written (auto-refresh enabled).' : ' No refresh_token found - offline_access may be off.'} .env updated.`);
  } finally {
    await ctx.close();
  }
}

main().catch((e) => { console.error('fatal:', e.message); process.exitCode = 1; });
