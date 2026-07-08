const MODULO_URL = 'https://app.modulo.finance/portfolio';
const BOT_ENDPOINT = 'http://127.0.0.1:8787/session';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const outEl = $('out');
let current = null; // last grabbed { access_token, refresh_token, ... }

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

// Runs INSIDE the app.modulo.finance page. Reads auth0-spa-js cache from localStorage
// (the app uses cacheLocation:"localstorage", key prefix "@@auth0spajs@@").
function readAuth0FromPage() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || k.indexOf('@@auth0spajs@@') !== 0) continue;
    try {
      const v = JSON.parse(localStorage.getItem(k));
      const b = v && v.body ? v.body : v;
      if (b && b.access_token) {
        let exp = null;
        try {
          const p = JSON.parse(atob(b.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
          exp = p.exp;
        } catch { /* not a jwt */ }
        out.push({
          key: k,
          access_token: b.access_token,
          refresh_token: b.refresh_token || null,
          exp,
        });
      }
    } catch { /* skip */ }
  }
  return out;
}

async function getModuloTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.startsWith('https://app.modulo.finance/')) return tab;
  // find any modulo tab
  const tabs = await chrome.tabs.query({ url: 'https://app.modulo.finance/*' });
  return tabs[0] || null;
}

async function grab() {
  setStatus('membaca sesi…');
  $('copy').disabled = $('send').disabled = true;
  current = null; outEl.value = '';

  let tab = await getModuloTab();
  if (!tab) {
    setStatus('Tab Modulo tidak ada. Membuka app.modulo.finance… login lalu klik "Ambil Sesi" lagi.', 'err');
    await chrome.tabs.create({ url: MODULO_URL });
    return;
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readAuth0FromPage });
  } catch (e) {
    setStatus('Gagal baca halaman: ' + e.message, 'err');
    return;
  }
  const entries = (results && results[0] && results[0].result) || [];
  const withAccess = entries.filter((e) => e.access_token);
  if (!withAccess.length) {
    setStatus('Tidak ada sesi di localStorage. Pastikan tab Modulo sudah login (reload dulu), lalu ulangi.', 'err');
    return;
  }
  // prefer the entry that also has a refresh token
  current = withAccess.find((e) => e.refresh_token) || withAccess[0];

  const left = current.exp ? Math.max(0, current.exp - Math.floor(Date.now() / 1000)) : null;
  const leftStr = left != null ? `${Math.floor(left / 3600)}h${Math.floor((left % 3600) / 60)}m` : '?';
  outEl.value = JSON.stringify({ access_token: current.access_token, refresh_token: current.refresh_token }, null, 2);
  setStatus(
    `OK. access_token (sisa ${leftStr}). ` +
    (current.refresh_token ? 'refresh_token ADA — auto-refresh bisa.' : 'refresh_token TIDAK ADA (offline_access mati?).'),
    'ok',
  );
  $('copy').disabled = false;
  $('send').disabled = false;
}

async function copyJson() {
  if (!current) return;
  await navigator.clipboard.writeText(outEl.value);
  setStatus('JSON disalin ke clipboard.', 'ok');
}

async function sendToBot() {
  if (!current) return;
  setStatus('mengirim ke bot lokal…');
  try {
    const res = await fetch(BOT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: current.access_token, refresh_token: current.refresh_token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    setStatus('Terkirim ke bot. .env terupdate: ' + (data.wrote || 'ok'), 'ok');
  } catch (e) {
    setStatus('Gagal kirim (bot jalan? `node token-receiver.mjs`): ' + e.message, 'err');
  }
}

$('grab').addEventListener('click', grab);
$('copy').addEventListener('click', copyJson);
$('send').addEventListener('click', sendToBot);
