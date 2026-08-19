// Per-wallet proxy support, zero dependency.
//
// Node's bundled fetch has no public proxy hook: undici is not importable and NODE_USE_ENV_PROXY
// is process-wide, so it cannot give each wallet its own exit IP. We therefore open the tunnel
// ourselves (HTTP CONNECT or SOCKS5) and run an ordinary https.request over that socket, wrapping
// the result in a small fetch-shaped object so callers stay unchanged.
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Accepts the shapes proxy lists actually ship in:
 *   host:port                       user:pass@host:port
 *   host:port:user:pass             scheme://user:pass@host:port
 * Scheme defaults to http. Returns null for blank/comment lines.
 */
export function parseProxy(line) {
  let s = String(line || '').trim();
  if (!s || s.startsWith('#') || s.startsWith('//')) return null;

  let protocol = 'http';
  const scheme = s.match(/^([a-z0-9]+):\/\//i);
  if (scheme) { protocol = scheme[1].toLowerCase(); s = s.slice(scheme[0].length); }

  let username = '', password = '';
  const at = s.lastIndexOf('@');
  if (at >= 0) {
    const cred = s.slice(0, at);
    s = s.slice(at + 1);
    const i = cred.indexOf(':');
    username = i < 0 ? cred : cred.slice(0, i);
    password = i < 0 ? '' : cred.slice(i + 1);
  }

  const parts = s.split(':');
  let host, port;
  if (parts.length >= 4 && !username) {
    // host:port:user:pass — password may itself contain ':', so only split the first three
    [host, port, username] = parts;
    password = parts.slice(3).join(':');
  } else if (parts.length >= 2) {
    host = parts[0]; port = parts[1];
  } else return null;

  port = parseInt(port, 10);
  if (!host || !Number.isFinite(port)) return null;
  if (!['http', 'https', 'socks5', 'socks5h', 'socks'].includes(protocol)) {
    throw new Error(`skema proxy "${protocol}" tidak didukung (pakai http/https/socks5)`);
  }
  return { protocol, host, port, username, password };
}

/** Short label for logs/UI. Credentials are never included. */
export function proxyLabel(p) {
  return p ? `${p.protocol}://${p.host}:${p.port}` : '-';
}

// --------------------------------------------------------------------------
// tunnels
// --------------------------------------------------------------------------
function httpConnect(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}`, 'Proxy-Connection': 'keep-alive' };
    if (proxy.username || proxy.password) {
      headers['Proxy-Authorization'] = 'Basic '
        + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
    }
    const mod = proxy.protocol === 'https' ? https : http;
    const req = mod.request({
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: `${host}:${port}`, headers, agent: false, timeout,
      ...(proxy.protocol === 'https' ? { rejectUnauthorized: false } : {}),
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`proxy CONNECT ditolak: ${res.statusCode} ${res.statusMessage || ''}`.trim()));
      }
      resolve(socket);
    });
    req.once('timeout', () => { req.destroy(new Error('proxy CONNECT timeout')); });
    req.once('error', reject);
    req.end();
  });
}

function socks5Connect(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    let stage = 'greet';
    const fail = (m) => { sock.destroy(); reject(new Error(m)); };
    const timer = setTimeout(() => fail('proxy SOCKS5 timeout'), timeout);
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });

    const useAuth = !!(proxy.username || proxy.password);
    sock.on('connect', () => sock.write(Buffer.from(useAuth ? [5, 2, 0, 2] : [5, 1, 0])));

    sock.on('data', (buf) => {
      if (stage === 'greet') {
        if (buf[0] !== 5) return fail('balasan SOCKS5 tidak valid');
        if (buf[1] === 0x02) {
          const u = Buffer.from(proxy.username || ''), p = Buffer.from(proxy.password || '');
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          stage = 'auth'; return;
        }
        if (buf[1] !== 0x00) return fail('proxy SOCKS5 menolak metode auth');
        stage = 'request';
        return sendRequest();
      }
      if (stage === 'auth') {
        if (buf[1] !== 0x00) return fail('auth SOCKS5 gagal (user/pass salah)');
        stage = 'request';
        return sendRequest();
      }
      if (stage === 'request') {
        if (buf[1] !== 0x00) return fail(`SOCKS5 gagal connect (kode ${buf[1]})`);
        clearTimeout(timer);
        sock.removeAllListeners('data');
        stage = 'done';
        resolve(sock);
      }
    });

    function sendRequest() {
      const h = Buffer.from(host);
      sock.write(Buffer.concat([
        Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 0xff]),
      ]));
    }
  });
}

/** Open a raw TCP tunnel to host:port through the proxy. */
export function openTunnel(proxy, host, port, timeout = 30000) {
  return proxy.protocol.startsWith('socks')
    ? socks5Connect(proxy, host, port, timeout)
    : httpConnect(proxy, host, port, timeout);
}

// --------------------------------------------------------------------------
// fetch over a tunnel
// --------------------------------------------------------------------------
/** Minimal Response stand-in: only what this project's callers actually use. */
function makeResponse(status, statusText, headers, body) {
  return {
    status, statusText, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null, raw: headers },
    async text() { return body; },
    async json() { return JSON.parse(body); },
  };
}

/**
 * fetch(url, init) equivalent routed through `proxy`. Returns the global fetch when proxy is
 * falsy, so a wallet without a proxy costs nothing.
 */
export function proxyFetch(proxy, { timeout = 60000 } = {}) {
  if (!proxy) return globalThis.fetch;

  // The tunnel has to be handed over through an Agent subclass. Passing options.createConnection
  // with agent:false does not work: Node then builds its own Agent, whose createConnection wins,
  // and the request goes out on a socket that never entered the proxy — it just hangs up.
  const makeAgent = (isTls, hostname) => {
    const Base = isTls ? https.Agent : http.Agent;
    const agent = new Base({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = (opts, cb) => {
      openTunnel(proxy, hostname, opts.port, timeout)
        .then((socket) => cb(null, isTls ? tls.connect({ socket, servername: hostname }) : socket))
        .catch(cb);
    };
    return agent;
  };

  return (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const isTls = url.protocol === 'https:';
    const port = Number(url.port) || (isTls ? 443 : 80);
    const req = (isTls ? https : http).request({
      host: url.hostname, port,
      method: init.method || 'GET',
      path: url.pathname + url.search,
      headers: { Host: url.host, Connection: 'close', ...(init.headers || {}) },
      agent: makeAgent(isTls, url.hostname),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(makeResponse(
        res.statusCode, res.statusMessage, res.headers, Buffer.concat(chunks).toString('utf8'),
      )));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('request timeout lewat proxy')));
    req.once('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

// --------------------------------------------------------------------------
// proxies.txt
// --------------------------------------------------------------------------
/**
 * One proxy per line, matched to wallets BY ORDER: line 1 -> wallet 1.
 * A line may instead bind explicitly with "email=proxy", which survives reordering.
 * Blank lines and #comments are skipped, but a bare blank line still consumes a slot only if
 * written as "-" — otherwise ordering would silently shift.
 */
export function loadProxyFile(file) {
  if (!existsSync(file)) return { list: [], byEmail: new Map(), errors: [] };
  const list = [], byEmail = new Map(), errors = [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (line === '-') { list.push(null); continue; } // explicit "no proxy for this slot"
    const eq = line.indexOf('=');
    const looksEmail = eq > 0 && /^[^\s@]+@[^\s@]+$/.test(line.slice(0, eq).trim());
    try {
      if (looksEmail) byEmail.set(line.slice(0, eq).trim().toLowerCase(), parseProxy(line.slice(eq + 1)));
      else list.push(parseProxy(line));
    } catch (e) { errors.push(`baris ${i + 1}: ${e.message}`); }
  }
  return { list, byEmail, errors };
}

/** Attach a proxy to each wallet: explicit email binding wins, otherwise position. */
export function assignProxies(wallets, { list, byEmail }) {
  let slot = 0;
  for (const w of wallets) {
    const explicit = byEmail.get(String(w.email || '').toLowerCase());
    if (explicit !== undefined) { w.proxy = explicit; continue; }
    w.proxy = list[slot] ?? null;
    slot++;
  }
  return wallets;
}
