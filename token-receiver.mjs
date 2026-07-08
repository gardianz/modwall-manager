#!/usr/bin/env node
/**
 * Local token receiver for the Modulo Session Grabber browser extension.
 *
 * Listens on 127.0.0.1:8787 (loopback only). The extension POSTs the tokens it read from
 * your already-logged-in Modulo tab; this upserts them as a wallet in wallets.json
 * (used by cli.mjs and keeper.mjs). No re-login, no Playwright, no copy-paste.
 *
 * Usage:  node token-receiver.mjs        (Ctrl-C to stop)
 * Then in Chrome: load unpacked ./extension, open app.modulo.finance (logged in),
 * click the extension -> "Ambil Sesi" -> "Kirim ke Bot".
 */
import { createServer } from 'node:http';
import { loadWallets, saveWallets, getUserinfo, loadConfig, decodeJwt, log } from './core.mjs';

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.PORT || '8787', 10);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function upsertWallet(accessToken, refreshToken) {
  const cfg = loadConfig();
  const wallets = loadWallets();
  const info = await getUserinfo(accessToken, cfg).catch(() => null);
  const sub = info?.sub || decodeJwt(accessToken)?.sub;
  const label = info?.email || (sub ? sub.split('|').pop() : `wallet-${Date.now()}`);
  const id = sub || label;
  const idx = wallets.findIndex((w) => w.id && w.id === id);
  const base = { id, sub, email: info?.email, label, accessToken, refreshToken: refreshToken || '', dead: false, alertedDead: false, lastError: undefined };
  if (idx >= 0) { wallets[idx] = { ...wallets[idx], ...base }; }
  else { wallets.push({ ...base, addedAt: new Date().toISOString() }); }
  saveWallets(wallets);
  return { label, updated: idx >= 0, refresh: !!refreshToken };
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: true, service: 'modulo-token-receiver' })); return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/session')) {
    res.writeHead(404, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'POST /session only' })); return;
  }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let data; try { data = JSON.parse(body); } catch { data = null; }
    const at = data && String(data.access_token || '').trim();
    const rt = data && data.refresh_token ? String(data.refresh_token).trim() : '';
    if (!at) { res.writeHead(400, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify({ error: 'missing access_token' })); return; }
    try {
      const r = await upsertWallet(at, rt);
      log(`extension -> wallet "${r.label}" ${r.updated ? 'updated' : 'added'} (refresh:${r.refresh})`);
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ ok: true, wrote: `wallet ${r.label}`, refresh: r.refresh }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, HOST, () => log(`token receiver on http://${HOST}:${PORT} (POST /session). Waiting for the extension…`));
