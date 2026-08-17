// Full-screen terminal dashboard: header, per-wallet table, summary, live activity log.
//
// Built on raw ANSI so the project keeps its zero-dependency rule. Cells are built as PLAIN
// text and only colourised after padding/truncating — measuring a string that already contains
// escape codes is how box layouts drift, so we never do it.
import { EventEmitter } from 'node:events';

const ESC = '\x1b[';
const sgr = (...codes) => `${ESC}${codes.join(';')}m`;
const RESET = sgr(0);

// palette (256-colour, degrades fine on 16-colour terminals)
const C = {
  border: sgr(38, 5, 45),
  title: sgr(1, 38, 5, 231),
  dim: sgr(38, 5, 245),
  label: sgr(38, 5, 251),
  head: sgr(1, 38, 5, 252),
  ok: sgr(38, 5, 84),
  warn: sgr(38, 5, 221),
  err: sgr(1, 38, 5, 203),
  accent: sgr(38, 5, 213),
  num: sgr(38, 5, 87),
  time: sgr(38, 5, 245),
};

const paint = (s, color) => (color ? color + s + RESET : s);

/** Visible width, ignoring escape codes. Counts common wide (CJK/emoji) codepoints as 2. */
export function width(str) {
  let n = 0;
  for (const ch of String(str).replace(/\x1b\[[0-9;]*m/g, '')) {
    const cp = ch.codePointAt(0);
    n += (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a
      || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff))) ? 2 : 1;
  }
  return n;
}

/** Cut plain text to `n` columns, adding an ellipsis when it had to cut. */
export function clip(str, n) {
  const s = String(str ?? '');
  if (width(s) <= n) return s;
  if (n <= 1) return '…'.slice(0, n);
  let out = '';
  for (const ch of s) {
    if (width(out + ch) > n - 1) break;
    out += ch;
  }
  return out + '…';
}

const padR = (s, n) => { const t = clip(s, n); return t + ' '.repeat(Math.max(0, n - width(t))); };
const padL = (s, n) => { const t = clip(s, n); return ' '.repeat(Math.max(0, n - width(t))) + t; };

/**
 * Column spec: { key, label, w, align: 'l'|'r', color: (row) => ansi | string }
 * Rows are plain objects; every value is stringified before layout.
 */
export class Dashboard extends EventEmitter {
  constructor({ title = 'dashboard', subtitle = '', columns = [], logLines = 14, stream = process.stdout } = {}) {
    super();
    this.title = title;
    this.subtitle = subtitle;
    this.columns = columns;
    this.rows = [];
    this.summary = [];
    this.logs = [];
    this.maxLogs = 500;
    this.logLines = logLines;
    this.out = stream;
    this.started = false;
    this.dirty = true;
    this._onResize = () => { this.dirty = true; this.render(); };
  }

  get cols() { return Math.max(60, this.out.columns || 100); }

  setRows(rows) { this.rows = rows; this.dirty = true; }
  setSummary(lines) { this.summary = lines.filter(Boolean); this.dirty = true; }

  log(text, level = '') {
    const t = new Date().toTimeString().slice(0, 8).replace(/:/g, '.');
    this.logs.push({ t, text: String(text), level });
    if (this.logs.length > this.maxLogs) this.logs.splice(0, this.logs.length - this.maxLogs);
    this.dirty = true;
    if (this.started) this.render();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.out.write(`${ESC}?1049h${ESC}?25l`); // alt screen + hide cursor
    this.out.on?.('resize', this._onResize);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', this._onKey = (buf) => {
        const k = buf.toString();
        if (k === 'q' || k === '') this.emit('quit');   // q / Ctrl-C
      });
    }
    this.timer = setInterval(() => this.render(), 1000).unref?.() ?? this.timer;
    this.render();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    clearInterval(this.timer);
    this.out.off?.('resize', this._onResize);
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* already closed */ }
      if (this._onKey) process.stdin.off('data', this._onKey);
      process.stdin.pause();
    }
    this.out.write(`${ESC}?25h${ESC}?1049l`); // restore cursor + main screen
  }

  // ---- box drawing ---------------------------------------------------------
  _top(w) { return C.border + '┌' + '─'.repeat(w - 2) + '┐' + RESET; }
  _sep(w) { return C.border + '├' + '─'.repeat(w - 2) + '┤' + RESET; }
  _bot(w) { return C.border + '└' + '─'.repeat(w - 2) + '┘' + RESET; }
  _row(inner, w) {
    const body = padR(inner.plain ?? inner, w - 4);
    const shown = inner.painted ? inner.painted(body) : body;
    return C.border + '│' + RESET + ' ' + shown + ' ' + C.border + '│' + RESET;
  }
  /** A line whose cells are already coloured: pass plain for measuring, painted for display. */
  _rowRich(plain, painted, w) {
    const pad = ' '.repeat(Math.max(0, (w - 4) - width(plain)));
    return C.border + '│' + RESET + ' ' + painted + pad + ' ' + C.border + '│' + RESET;
  }

  render() {
    if (!this.started) return;
    const w = this.cols;
    const lines = [];

    // header
    lines.push(this._top(w));
    lines.push(this._rowRich(this.title, paint(this.title, C.title), w));
    const stamp = new Date().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' });
    const sub = this.subtitle ? `${stamp}  ·  ${this.subtitle}` : stamp;
    lines.push(this._rowRich(sub, paint(sub, C.dim), w));

    // table
    lines.push(this._sep(w));
    const head = this.columns.map((c) => (c.align === 'r' ? padL(c.label, c.w) : padR(c.label, c.w))).join('  ');
    lines.push(this._rowRich(head, paint(head, C.head), w));
    if (!this.rows.length) {
      lines.push(this._rowRich('(belum ada data)', paint('(belum ada data)', C.dim), w));
    }
    for (const r of this.rows) {
      let plain = '', painted = '';
      this.columns.forEach((c, i) => {
        const raw = String(r[c.key] ?? '');
        const cell = c.align === 'r' ? padL(raw, c.w) : padR(raw, c.w);
        const gap = i ? '  ' : '';
        plain += gap + cell;
        const col = typeof c.color === 'function' ? c.color(r) : c.color;
        painted += gap + paint(cell, col);
      });
      lines.push(this._rowRich(plain, painted, w));
    }

    // summary
    if (this.summary.length) {
      lines.push(this._sep(w));
      for (const s of this.summary) {
        const plain = typeof s === 'string' ? s : s.plain;
        const painted = typeof s === 'string' ? paint(s, C.label) : s.painted;
        lines.push(this._rowRich(plain, painted, w));
      }
    }

    // activity log
    lines.push(this._sep(w));
    const cap = `aktivitas  ${this.logs.length} baris`;
    lines.push(this._rowRich(cap, paint(cap, C.head), w));
    const rows = Math.max(3, Math.min(this.logLines, (this.out.rows || 40) - lines.length - 3));
    for (const e of this.logs.slice(-rows)) {
      const col = e.level === 'ok' ? C.ok : e.level === 'warn' ? C.warn
        : e.level === 'err' ? C.err : e.level === 'head' ? C.accent : C.label;
      const plain = `${e.t} ${e.text}`;
      const painted = paint(e.t, C.time) + ' ' + paint(clip(e.text, w - 5 - width(e.t)), col);
      lines.push(this._rowRich(clip(plain, w - 4), painted, w));
    }
    lines.push(this._bot(w));

    this.out.write(`${ESC}H${ESC}2J` + lines.join('\n') + '\n');
  }
}

export const colors = C;
