#!/usr/bin/env node
// Hand-drawn diagram renderer: JSON spec -> ELK layout -> rough.js SVG (+ PNG via resvg-wasm).
// SOURCE FILE. scripts/render.mjs is generated from this by `npm run build` — edit here, not there.
// Usage: node scripts/render.mjs <spec.json> [--out out/name] [--no-png] [--scale 2]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rough from 'roughjs';
import ELK from 'elkjs/lib/elk.bundled.js';
import opentype from 'opentype.js';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// WOFF 1.0 -> plain TTF/OTF (sfnt). Each table is either stored raw or zlib-compressed.
function woffToSfnt(buf) {
  if (buf.readUInt32BE(0) !== 0x774f4646) return buf; // not 'wOFF': already sfnt
  const flavor = buf.readUInt32BE(4), numTables = buf.readUInt16BE(12);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    const t = { tag: buf.readUInt32BE(o), offset: buf.readUInt32BE(o + 4), compLength: buf.readUInt32BE(o + 8), origLength: buf.readUInt32BE(o + 12), checksum: buf.readUInt32BE(o + 16) };
    const raw = buf.subarray(t.offset, t.offset + t.compLength);
    t.data = t.compLength < t.origLength ? zlib.inflateSync(raw) : raw;
    tables.push(t);
  }
  let es = 0; while ((1 << (es + 1)) <= numTables) es++;
  const searchRange = (1 << es) * 16;
  const headerLen = 12 + numTables * 16;
  const total = tables.reduce((s, t) => s + ((t.origLength + 3) & ~3), headerLen);
  const out = Buffer.alloc(total);
  out.writeUInt32BE(flavor, 0); out.writeUInt16BE(numTables, 4); out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(es, 8); out.writeUInt16BE(numTables * 16 - searchRange, 10);
  let off = headerLen;
  tables.forEach((t, i) => {
    const o = 12 + i * 16;
    out.writeUInt32BE(t.tag, o); out.writeUInt32BE(t.checksum, o + 4); out.writeUInt32BE(off, o + 8); out.writeUInt32BE(t.origLength, o + 12);
    t.data.copy(out, off); off += (t.origLength + 3) & ~3;
  });
  return out;
}

// ---------- palette (Open Color, MIT) ----------
const INK = '#1e1e1e';
const MUTED = '#868e96';
const PALETTE = {
  blue: '#a5d8ff', green: '#b2f2bb', yellow: '#ffec99', red: '#ffc9c9',
  violet: '#d0bfff', orange: '#ffd8a8', pink: '#fcc2d7', teal: '#96f2d7',
  gray: '#e9ecef', white: '#ffffff', none: 'none',
};
const ACCENT = { // stronger tone, for primary buttons / highlights
  blue: '#4dabf7', green: '#69db7c', yellow: '#ffd43b', red: '#ff8787',
  violet: '#9775fa', orange: '#ffa94d', pink: '#f783ac', teal: '#38d9a9', gray: '#adb5bd',
};
const fillOf = (c) => (c ? PALETTE[c] ?? c : null);
// Mix a colour with white: t=1 keeps it, t=0 is white. Used so big group areas stay light.
const tint = (c, t) => {
  const h = String(c).replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return c;
  return '#' + [0, 2, 4].map((i) => Math.round(255 - (255 - parseInt(h.slice(i, i + 2), 16)) * t).toString(16).padStart(2, '0')).join('');
};

// ---------- fonts ----------
const FONTS = {
  kalam: { family: 'Kalam', regular: 'kalam-400.woff', bold: 'kalam-700.woff', scale: 1 },
  caveat: { family: 'Caveat', regular: 'caveat-400.woff', bold: 'caveat-700.woff', scale: 1.25 },
};

// ---------- args ----------
const args = process.argv.slice(2);
if (!args[0] || args.includes('-h') || args.includes('--help')) {
  console.log('Usage: node scripts/render.mjs <spec.json> [--out out/name] [--no-png] [--scale 2]');
  process.exit(args[0] ? 0 : 1);
}
const specPath = path.resolve(args[0]);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const outBase = path.resolve(argVal('--out', specPath.replace(/\.json$/i, '')));
const wantPng = !args.includes('--no-png');
const scale = Number(argVal('--scale', 2));

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const LAYOUT = String(spec.layout || '').toLowerCase();
const isMap = LAYOUT === 'map';
const isScene = LAYOUT === 'scene';

// The handwritten fonts only cover Latin letters and common punctuation. resvg has no fallback font,
// so a missing glyph becomes a box. Swap the usual symbols for look-alikes the font does have.
const GLYPH_SUBS = {
  '→': '->', '⟶': '->', '➔': '->', '➜': '->', '➝': '->', '←': '<-', '⟵': '<-', '↔': '<->', '⟷': '<->',
  '⇒': '=>', '⟹': '=>', '⇐': '<=', '⇔': '<=>',
  '✓': 'ok', '✔': 'ok', '☑': 'ok', '✅': 'ok', '✗': '×', '✘': '×', '❌': '×', '●': '•', '⦁': '•',
};
const GLYPH_RE = new RegExp(`[${Object.keys(GLYPH_SUBS).join('')}]`, 'gu');
// Invisible format characters (emoji variation selectors like the one in ✔️, zero-width joiners/spaces, BOM).
// They draw nothing, so drop them instead of warning about a "missing" glyph nobody can see.
const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFE00-\uFE0F\uFEFF]/gu;
const substituted = new Set();
(function subStrings(o) {
  for (const k in o) {
    if (typeof o[k] === 'string') o[k] = o[k].replace(INVISIBLE_RE, '').replace(GLYPH_RE, (c) => (substituted.add(`"${c}" with "${GLYPH_SUBS[c]}"`), GLYPH_SUBS[c]));
    else if (o[k] && typeof o[k] === 'object') subStrings(o[k]);
  }
})(spec);
const warnings = [];
const warn = (m) => warnings.push(m);

const fontKey = (spec.font || 'kalam').toLowerCase();
const FONT = FONTS[fontKey] || FONTS.kalam;
const loadFont = (f) => { const b = fs.readFileSync(path.join(ROOT, 'assets/fonts', f)); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const fontRegular = loadFont(FONT.regular);
const fontBold = loadFont(FONT.bold);
const fs_ = (s) => s * FONT.scale; // font-size scaling per family

function checkGlyphs(str, bold = false) {
  const font = bold ? fontBold : fontRegular;
  for (const ch of String(str ?? '')) {
    if (/\s/.test(ch) || font.charToGlyphIndex(ch)) continue;
    warn(`Character "${ch}" (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) is not in font ${FONT.family}: it renders as a box. Replace it with plain text (e.g. "->", "ok").`);
  }
}
function measure(str, size, bold = false) {
  checkGlyphs(str, bold);
  return (bold ? fontBold : fontRegular).getAdvanceWidth(String(str), fs_(size));
}
function wrap(str, size, maxW, bold = false) {
  const lines = [];
  for (const para of String(str ?? '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (measure(t, size, bold) <= maxW || !cur) {
        if (!cur && measure(w, size, bold) > maxW) warn(`Word too long for its box: "${w}"`);
        cur = t;
      } else { lines.push(cur); cur = w; }
    }
    lines.push(cur);
  }
  return lines;
}
const lineH = (size) => Math.round(fs_(size) * 1.25);

// ---------- rough drawing context ----------
const gen = rough.generator();
let seedCounter = Number(spec.seed ?? 7);
const ROUGH = Number(spec.roughness ?? 1.1);
const DEFAULT_FILL = spec.fillStyle || 'hachure';
const svgParts = [];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function emit(drawable, extra = {}) {
  for (const p of gen.toPaths(drawable)) {
    const dash = extra.dashed ? ` stroke-dasharray="${extra.dashed === 'dot' ? '1.5 6' : '8 7'}"` : '';
    svgParts.push(`<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill || 'none'}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`);
  }
}
function opts(o = {}) {
  const fill = o.fill && o.fill !== 'none' ? o.fill : undefined;
  return {
    seed: ++seedCounter,
    roughness: o.roughness ?? ROUGH,
    bowing: o.bowing ?? 1,
    stroke: o.stroke ?? INK,
    strokeWidth: o.strokeWidth ?? 1.6,
    fill,
    fillStyle: o.fillStyle ?? DEFAULT_FILL,
    fillWeight: o.fillWeight ?? 1.1,
    hachureGap: o.hachureGap ?? 6,
    hachureAngle: o.hachureAngle ?? -41,
    disableMultiStroke: o.single ?? false,
    preserveVertices: true,
  };
}
function roundRectPath(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) return `M${x} ${y} H${x + w} V${y + h} H${x} Z`;
  return `M${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${y + r} Q${x} ${y} ${x + r} ${y} Z`;
}
const D = {
  rect(x, y, w, h, o = {}) {
    if (o.fill && o.fillStyle !== 'solid' && o.fill !== 'none') {
      // hachure looks better from a plain polygon; outline drawn separately with radius
      emit(gen.path(roundRectPath(x + 2, y + 2, w - 4, h - 4, o.r ?? 0), { ...opts(o), stroke: 'none' }));
      emit(gen.path(roundRectPath(x, y, w, h, o.r ?? 0), opts({ ...o, fill: undefined })), o);
    } else emit(gen.path(roundRectPath(x, y, w, h, o.r ?? 0), opts(o)), o);
  },
  ellipse(cx, cy, w, h, o = {}) { emit(gen.ellipse(cx, cy, w, h, opts(o)), o); },
  diamond(x, y, w, h, o = {}) {
    emit(gen.polygon([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]], opts(o)), o);
  },
  line(x1, y1, x2, y2, o = {}) { emit(gen.line(x1, y1, x2, y2, opts(o)), o); },
  poly(pts, o = {}) { emit(gen.linearPath(pts, opts(o)), o); },
  path(d, o = {}) { emit(gen.path(d, opts(o)), o); },
  text(x, y, str, o = {}) {
    // y = top of the text block. Returns block height.
    const size = o.size ?? 16, bold = !!o.bold, anchor = o.anchor ?? 'middle';
    checkGlyphs(str, bold);
    const lines = o.maxW ? wrap(str, size, o.maxW, bold) : String(str).split('\n');
    const lh = lineH(size);
    if (o.rotate) svgParts.push(`<g transform="rotate(${Number(o.rotate)} ${x} ${(y + (lines.length * lh) / 2).toFixed(1)})">`);
    lines.forEach((ln, i) => {
      const by = y + i * lh + fs_(size) * 0.95;
      const deco = o.underline ? ' text-decoration="underline"' : '';
      const halo = o.halo ? ` stroke="${o.halo === true ? (spec.background && spec.background !== 'transparent' ? spec.background : '#ffffff') : o.halo}" stroke-width="5" stroke-linejoin="round" paint-order="stroke"` : '';
      svgParts.push(`<text x="${x}" y="${by.toFixed(1)}" font-size="${fs_(size).toFixed(1)}" text-anchor="${anchor}" fill="${o.color ?? INK}"${bold ? ' font-weight="700"' : ''}${deco}${halo}>${esc(ln)}</text>`);
    });
    if (o.rotate) svgParts.push('</g>');
    return lines.length * lh;
  },
  textHeight(str, size, maxW, bold) { return wrap(str, size, maxW, bold).length * lineH(size); },
};

// ---------- screen components ----------
// Each component: measure(W) -> height ; draw(x, y, W, ctx)
const accentOf = (ctx) => ctx.accent;
const COMPONENTS = {
  header: {
    h: () => 34,
    draw(c, x, y, W) {
      if (c.back !== false) D.poly([[x + 10, y + 9], [x + 3, y + 17], [x + 10, y + 25]], { strokeWidth: 1.8, roughness: 0.6 });
      if (c.text) D.text(x + W / 2, y + 5, c.text, { size: 15, bold: true });
      if (c.action) D.text(x + W, y + 7, c.action, { size: 13, anchor: 'end', color: MUTED });
    },
  },
  progress: {
    h: () => 16,
    draw(c, x, y, W) {
      const n = c.total ?? 3, s = c.step ?? 1;
      if (c.style === 'bar') {
        D.rect(x, y + 4, W, 8, { r: 4, roughness: 0.5 });
        D.rect(x, y + 4, (W * s) / n, 8, { r: 4, roughness: 0.5, fill: ACCENT[c.color] || ACCENT.blue, fillStyle: 'solid' });
      } else {
        const gap = 16, tot = (n - 1) * gap, sx = x + W / 2 - tot / 2;
        for (let i = 0; i < n; i++) {
          const on = i < s;
          D.ellipse(sx + i * gap, y + 8, on ? 10 : 8, on ? 10 : 8, { roughness: 0.4, fill: on ? INK : undefined, fillStyle: 'solid' });
        }
      }
    },
  },
  image: {
    h: (c) => c.h ?? 130,
    draw(c, x, y, W) {
      const h = c.h ?? 130, w = c.w ? Math.min(c.w, W) : W, ix = x + (W - w) / 2;
      D.rect(ix, y, w, h, { r: 10, fill: fillOf(c.color || 'gray'), roughness: 0.9, hachureGap: 9 });
      if (c.label) {
        const th = D.textHeight(c.label, 13, w - 20);
        D.rect(ix + w / 2 - Math.min(w - 20, measure(c.label, 13) + 16) / 2, y + h / 2 - th / 2 - 4, Math.min(w - 20, measure(c.label, 13) + 16), th + 8, { r: 6, fill: '#fff', fillStyle: 'solid', roughness: 0.4, strokeWidth: 1 });
        D.text(ix + w / 2, y + h / 2 - th / 2, c.label, { size: 13, maxW: w - 24, color: '#495057' });
      } else {
        D.line(ix + 8, y + 8, ix + w - 8, y + h - 8, { strokeWidth: 1, roughness: 0.7, stroke: MUTED });
        D.line(ix + w - 8, y + 8, ix + 8, y + h - 8, { strokeWidth: 1, roughness: 0.7, stroke: MUTED });
      }
    },
  },
  avatar: {
    h: (c, W) => (c.size ?? 64) + (c.text ? 6 + D.textHeight(c.text, 14, W) : 0),
    draw(c, x, y, W) {
      const s = c.size ?? 64;
      D.ellipse(x + W / 2, y + s / 2, s, s, { fill: fillOf(c.color || 'violet'), roughness: 0.8 });
      D.ellipse(x + W / 2, y + s * 0.4, s * 0.32, s * 0.32, { roughness: 0.6, strokeWidth: 1.2 });
      D.path(`M${x + W / 2 - s * 0.26} ${y + s * 0.8} Q${x + W / 2} ${y + s * 0.5} ${x + W / 2 + s * 0.26} ${y + s * 0.8}`, { roughness: 0.6, strokeWidth: 1.2 });
      if (c.text) D.text(x + W / 2, y + s + 6, c.text, { size: 14, maxW: W });
    },
  },
  title: {
    h: (c, W) => D.textHeight(c.text, c.size ?? 21, W, true),
    draw(c, x, y, W) {
      const a = c.align ?? 'center';
      D.text(a === 'left' ? x : x + W / 2, y, c.text, { size: c.size ?? 21, bold: true, maxW: W, anchor: a === 'left' ? 'start' : 'middle' });
    },
  },
  text: {
    h: (c, W) => D.textHeight(c.text, c.size ?? 14, W),
    draw(c, x, y, W) {
      const a = c.align ?? 'center';
      D.text(a === 'left' ? x : x + W / 2, y, c.text, { size: c.size ?? 14, maxW: W, color: c.muted === false ? INK : '#495057', anchor: a === 'left' ? 'start' : 'middle' });
    },
  },
  input: {
    h: (c) => 40 + (c.label ? 20 : 0),
    draw(c, x, y, W) {
      let yy = y;
      if (c.label) { D.text(x, yy, c.label, { size: 13, anchor: 'start' }); yy += 20; }
      D.rect(x, yy, W, 40, { r: 8, roughness: 0.7, fill: c.error ? PALETTE.red : undefined, fillStyle: 'solid', stroke: c.error ? '#e03131' : INK });
      D.text(x + 12, yy + 9, c.value ?? c.placeholder ?? '', { size: 14, anchor: 'start', color: c.value ? INK : '#adb5bd' });
      if (c.icon === 'eye') D.ellipse(x + W - 20, yy + 20, 16, 9, { roughness: 0.4, strokeWidth: 1.2 });
    },
  },
  otp: {
    h: () => 48,
    draw(c, x, y, W) {
      const n = c.count ?? 6, gap = 8, bw = Math.min(42, (W - gap * (n - 1)) / n), tot = n * bw + (n - 1) * gap, sx = x + (W - tot) / 2;
      const filled = String(c.value ?? '');
      for (let i = 0; i < n; i++) {
        D.rect(sx + i * (bw + gap), y, bw, 48, { r: 8, roughness: 0.7, stroke: i === filled.length ? ACCENT.blue : INK, strokeWidth: i === filled.length ? 2.2 : 1.6 });
        if (filled[i]) D.text(sx + i * (bw + gap) + bw / 2, y + 11, filled[i], { size: 20, bold: true });
      }
    },
  },
  button: {
    h: (c) => (c.variant === 'link' ? 24 : 42),
    draw(c, x, y, W, ctx) {
      const v = c.variant ?? 'primary';
      if (v === 'link') { D.text(x + W / 2, y + 1, c.text, { size: 14, color: '#1971c2', underline: true }); return; }
      const fill = v === 'primary' ? (ACCENT[c.color] || accentOf(ctx)) : undefined;
      D.rect(x, y, W, 42, { r: 10, roughness: 0.8, fill, fillStyle: 'solid', strokeWidth: 1.8 });
      D.text(x + W / 2, y + 9, c.text, { size: 15, bold: v === 'primary' });
    },
  },
  social: {
    h: (c) => 40,
    draw(c, x, y, W) {
      const items = c.items ?? ['Google', 'Apple'], gap = 10, bw = (W - gap * (items.length - 1)) / items.length;
      items.forEach((it, i) => {
        const bx = x + i * (bw + gap);
        D.rect(bx, y, bw, 40, { r: 10, roughness: 0.8 });
        D.ellipse(bx + 18, y + 20, 14, 14, { roughness: 0.4, strokeWidth: 1.2, fill: PALETTE.gray, fillStyle: 'solid' });
        D.text(bx + 18 + (bw - 18) / 2, y + 9, it, { size: 13 });
      });
    },
  },
  divider: {
    h: () => 22,
    draw(c, x, y, W) {
      if (c.text) {
        const tw = measure(c.text, 13) + 16;
        D.line(x, y + 11, x + W / 2 - tw / 2, y + 11, { strokeWidth: 1, roughness: 0.6, stroke: MUTED });
        D.line(x + W / 2 + tw / 2, y + 11, x + W, y + 11, { strokeWidth: 1, roughness: 0.6, stroke: MUTED });
        D.text(x + W / 2, y + 1, c.text, { size: 13, color: MUTED });
      } else D.line(x, y + 11, x + W, y + 11, { strokeWidth: 1, roughness: 0.6, stroke: MUTED });
    },
  },
  checkbox: {
    h: (c, W) => Math.max(22, D.textHeight(c.text, 13, W - 30)),
    draw(c, x, y, W) {
      D.rect(x, y + 2, 18, 18, { r: 4, roughness: 0.6, fill: c.checked ? ACCENT.blue : undefined, fillStyle: 'solid' });
      if (c.checked) D.poly([[x + 4, y + 11], [x + 8, y + 15], [x + 15, y + 6]], { strokeWidth: 2, roughness: 0.4 });
      D.text(x + 28, y + 1, c.text, { size: 13, anchor: 'start', maxW: W - 30 });
    },
  },
  toggle: {
    h: () => 28,
    draw(c, x, y, W) {
      D.text(x, y + 3, c.text, { size: 14, anchor: 'start', maxW: W - 60 });
      const on = !!c.on, tx = x + W - 44;
      D.rect(tx, y + 2, 44, 24, { r: 12, roughness: 0.5, fill: on ? ACCENT.green : PALETTE.gray, fillStyle: 'solid' });
      D.ellipse(on ? tx + 32 : tx + 12, y + 14, 18, 18, { roughness: 0.4, fill: '#fff', fillStyle: 'solid' });
    },
  },
  chips: {
    h(c, W) { return chipRows(c, W).length * 40 - 6; },
    draw(c, x, y, W, ctx) {
      chipRows(c, W).forEach((row, ri) => {
        const tot = row.reduce((a, r) => a + r.w, 0) + (row.length - 1) * 8;
        let cx = x + (W - tot) / 2;
        for (const ch of row) {
          const sel = (c.selected ?? []).includes(ch.t);
          D.rect(cx, y + ri * 40, ch.w, 32, { r: 16, roughness: 0.6, fill: sel ? fillOf(c.color || 'blue') : undefined, fillStyle: 'solid', strokeWidth: sel ? 2 : 1.4 });
          D.text(cx + ch.w / 2, y + ri * 40 + 6, ch.t, { size: 13, bold: sel });
          cx += ch.w + 8;
        }
      });
    },
  },
  list: {
    h: (c) => (c.items?.length ?? 3) * 44,
    draw(c, x, y, W) {
      (c.items ?? []).forEach((it, i) => {
        const yy = y + i * 44;
        const label = typeof it === 'string' ? it : it.text;
        D.ellipse(x + 14, yy + 22, 24, 24, { roughness: 0.5, fill: fillOf(c.color || 'blue'), fillStyle: 'solid', strokeWidth: 1.2 });
        D.text(x + 36, yy + 11, label, { size: 14, anchor: 'start', maxW: W - 56 });
        D.poly([[x + W - 12, yy + 16], [x + W - 6, yy + 22], [x + W - 12, yy + 28]], { strokeWidth: 1.4, roughness: 0.4 });
        if (i < c.items.length - 1) D.line(x + 36, yy + 44, x + W, yy + 44, { strokeWidth: 0.8, roughness: 0.4, stroke: '#ced4da' });
      });
    },
  },
  card: {
    h: (c, W) => 24 + (c.title ? D.textHeight(c.title, 15, W - 24, true) : 0) + (c.text ? 4 + D.textHeight(c.text, 13, W - 24) : 0),
    draw(c, x, y, W) {
      const h = COMPONENTS.card.h(c, W);
      D.rect(x, y, W, h, { r: 10, roughness: 0.8, fill: fillOf(c.color), hachureGap: 8 });
      let yy = y + 12;
      if (c.title) yy += D.text(x + 12, yy, c.title, { size: 15, bold: true, anchor: 'start', maxW: W - 24 }) + 4;
      if (c.text) D.text(x + 12, yy, c.text, { size: 13, anchor: 'start', maxW: W - 24, color: '#495057' });
    },
  },
  tabs: {
    h: () => 46,
    draw(c, x, y, W) {
      const items = c.items ?? ['Inicio', 'Buscar', 'Perfil'], bw = W / items.length;
      D.line(x - 8, y, x + W + 8, y, { strokeWidth: 1, roughness: 0.5, stroke: '#ced4da' });
      items.forEach((it, i) => {
        const on = (c.active ?? 0) === i, cx = x + bw * i + bw / 2;
        D.rect(cx - 9, y + 7, 18, 16, { r: 4, roughness: 0.5, fill: on ? ACCENT.blue : undefined, fillStyle: 'solid', strokeWidth: 1.2 });
        D.text(cx, y + 25, it, { size: 11, bold: on, color: on ? INK : MUTED });
      });
    },
  },
  spacer: { h: (c) => c.h ?? 12, draw() {} },
};
function chipRows(c, W) {
  const rows = [[]]; let rw = 0;
  for (const t of c.items ?? []) {
    const w = measure(t, 13) + 28;
    if (rw + w > W && rows.at(-1).length) { rows.push([]); rw = 0; }
    rows.at(-1).push({ t, w }); rw += w + 8;
  }
  return rows;
}

// ---------- scene doodles: small drawings for "layout": "scene" ----------
// size(n, k) -> [w, h] of the drawing (k = n.scale). draw(n, cx, cy, w, h, k) draws it centred on (cx, cy).
// Sizes run before the canvas exists, so they only measure text; colours resolve at draw time.
const HAIR = { brown: '#7a4a2a', black: '#2e2e2e', blonde: '#d9a441', red: '#b5482b', gray: '#9aa0a6', white: '#f1f3f5' };
const SKIN = '#f6d7b8';
const bold_ = (c, d) => (c ? ACCENT[c] ?? c : d);          // mid tone: shirts, buttons, bulbs
const ink_ = (c, d) => (c ? STRONG[c] ?? c : d);           // strong tone: titles, strokes
const SW = (n, k) => (n.strokeWidth ?? 2.2) * Math.max(0.7, k);
const textBlock = (str, size, maxW, bold = true) => {
  const lines = wrap(str ?? '', size, maxW, bold);
  return { lines, w: Math.max(0, ...lines.map((l) => measure(l, size, bold))), h: lines.length * lineH(size) };
};
// where a tail / arrow should point: [x, y] scene coordinates or a node id (filled in by drawScene)
let sceneTarget = () => null;

function drawPerson(cx, cy, k, shirt, hair, arm, sw) {
  const y0 = cy - 35 * k; // head centre
  D.path(`M${cx - 38 * k} ${y0 + 95 * k} Q${cx - 40 * k} ${y0 + 30 * k} ${cx} ${y0 + 28 * k} Q${cx + 40 * k} ${y0 + 30 * k} ${cx + 38 * k} ${y0 + 95 * k} Z`,
    { fill: shirt, fillStyle: 'hachure', hachureGap: 5 * k, fillWeight: 2, strokeWidth: sw });
  if (arm) {
    D.line(cx + 28 * k, y0 + 45 * k, cx + 56 * k, y0 - 16 * k, { stroke: shirt, strokeWidth: 7 * k, roughness: 0.7 });
    D.ellipse(cx + 58 * k, y0 - 22 * k, 15 * k, 15 * k, { fill: SKIN, fillStyle: 'solid', strokeWidth: sw * 0.8 });
  }
  D.ellipse(cx, y0, 46 * k, 46 * k, { fill: SKIN, fillStyle: 'solid', strokeWidth: sw });
  D.path(`M${cx - 23 * k} ${y0 - 2 * k} Q${cx - 20 * k} ${y0 - 30 * k} ${cx + 4 * k} ${y0 - 24 * k} Q${cx + 24 * k} ${y0 - 20 * k} ${cx + 22 * k} ${y0 - 2 * k} Q${cx + 8 * k} ${y0 - 14 * k} ${cx - 23 * k} ${y0 - 2 * k}Z`,
    { fill: hair, fillStyle: 'solid', strokeWidth: sw * 0.8, roughness: 0.8 });
}
const crowdColors = (n) => n.colors ?? (n.kind === 'person' ? [n.color ?? 'blue'] : ['yellow', 'pink', 'blue', 'green', 'violet', 'orange'].slice(0, n.count ?? 3));

// tail of a speech bubble / thought cloud: from the side of the box that faces the target
function tailBase(x, y, w, h, tx, ty) {
  if (ty > y + h) return { side: 'b', p: [Math.min(Math.max(tx, x + 26), x + w - 26), y + h] };
  if (ty < y) return { side: 't', p: [Math.min(Math.max(tx, x + 26), x + w - 26), y] };
  return { side: tx > x + w / 2 ? 'r' : 'l', p: [tx > x + w / 2 ? x + w : x, Math.min(Math.max(ty, y + 18), y + h - 18)] };
}

const DOODLES = {
  person: {
    size: (n, k) => [96 * k, 130 * k],
    draw: (n, cx, cy, w, h, k) => drawPerson(cx, cy, k, bold_(n.color ?? 'blue'), HAIR[n.hair] ?? n.hair ?? HAIR.brown, !!n.arm, SW(n, k)),
  },
  crowd: {
    size: (n, k) => [(crowdColors(n).length * 98 - 2) * k, 145 * k],
    draw: (n, cx, cy, w, h, k) => {
      const cols = crowdColors(n), hairs = n.hair ? [].concat(n.hair) : ['brown', 'black', 'blonde', 'red', 'gray'];
      cols.forEach((c, i) => {
        const x = cx - ((cols.length - 1) * 49 - i * 98) * k, y = cy + (i % 2 ? 9 : -6) * k;
        drawPerson(x, y, k, bold_(c), HAIR[hairs[i % hairs.length]] ?? hairs[i % hairs.length], n.arm && i === (n.armIndex ?? 0), SW(n, k));
      });
    },
  },
  laptop: {
    size: (n, k) => [360 * k, 200 * k],
    draw: (n, cx, cy, w, h, k) => {
      const L = cx - w / 2, T = cy - h / 2, sw = SW(n, k);
      D.path(`M${L + 30 * k} ${T + 150 * k} L${L + 330 * k} ${T + 150 * k} L${L + 360 * k} ${T + 200 * k} L${L} ${T + 200 * k} Z`, { fill: '#ced4da', fillStyle: 'solid', strokeWidth: sw });
      const sx = L + 45 * k, sy = T, swd = 270 * k;
      D.rect(sx, sy, swd, 155 * k, { fill: '#ffffff', fillStyle: 'solid', strokeWidth: sw * 1.2, r: 4 * k });
      let y = sy + 10 * k;
      if (n.text) { D.text(sx + swd / 2, y, n.text, { size: 28 * k, bold: true, color: ink_(n.color, STRONG.orange) }); y += 46 * k; }
      if (n.prompt) {
        D.rect(sx + 22 * k, y, swd - 44 * k, 26 * k, { fill: '#fff4e6', fillStyle: 'solid', strokeWidth: 1.4 * k, roughness: 0.7 });
        D.text(sx + 30 * k, y + 2 * k, n.prompt, { size: 15 * k, anchor: 'start' });
        y += 40 * k;
      }
      for (const f of [0.92, 0.78, 0.86, 0.6]) {
        if (y > sy + 145 * k) break;
        D.line(sx + 22 * k, y, sx + 22 * k + (swd - 44 * k) * f, y, { stroke: '#adb5bd', strokeWidth: 1.4 * k, roughness: 0.8 });
        y += 19 * k;
      }
    },
  },
  cloud: {
    size: (n, k) => { const t = textBlock(n.text, 24 * k, 250 * k); return [Math.max(170 * k, t.w + 100 * k), Math.max(100 * k, t.h + 60 * k)]; },
    draw: (n, cx, cy, w, h, k) => {
      const rx = w / 2 / 1.2, ry = h / 2 / 1.3, bumps = n.bumps ?? Math.max(8, Math.round(w / (34 * k))), fill = fillOf(n.color) ?? '#ffffff';
      let d = '';
      for (let i = 0; i <= bumps; i++) {
        const t = (i / bumps) * Math.PI * 2, x = cx + rx * Math.cos(t), y = cy + ry * Math.sin(t);
        if (!i) { d += `M${x.toFixed(1)} ${y.toFixed(1)}`; continue; }
        const tm = ((i - 0.5) / bumps) * Math.PI * 2;
        d += ` Q${(cx + rx * 1.34 * Math.cos(tm)).toFixed(1)} ${(cy + ry * 1.4 * Math.sin(tm)).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      D.path(d + 'Z', { fill, fillStyle: 'solid', strokeWidth: SW(n, k), roughness: 1 });
      const tg = sceneTarget(n.tail);
      if (tg) {
        const dx = tg[0] - cx, dy = tg[1] - cy, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
        const r = 1 / Math.hypot(ux / (w / 2), uy / (h / 2)), ex = cx + ux * r, ey = cy + uy * r;
        D.ellipse(ex + ux * 14 * k, ey + uy * 14 * k, 18 * k, 18 * k, { fill, fillStyle: 'solid', strokeWidth: SW(n, k) * 0.9 });
        D.ellipse(ex + ux * 36 * k, ey + uy * 36 * k, 10 * k, 10 * k, { fill, fillStyle: 'solid', strokeWidth: SW(n, k) * 0.8 });
      }
      const t = textBlock(n.text, 24 * k, 250 * k);
      D.text(cx, cy - t.h / 2, n.text ?? '', { size: 24 * k, bold: true, maxW: 250 * k, color: ink_(n.textColor, INK) });
    },
  },
  bubble: {
    size: (n, k) => { const t = textBlock(n.text, 21 * k, n.width ?? 230 * k, !!n.bold); return [Math.max(110 * k, t.w + 44 * k), t.h + 26 * k]; },
    draw: (n, cx, cy, w, h, k) => {
      const x = cx - w / 2, y = cy - h / 2, fill = fillOf(n.color) ?? '#ffffff', sw = SW(n, k);
      D.rect(x, y, w, h, { fill, fillStyle: 'solid', strokeWidth: sw, r: 4 * k, roughness: 1 });
      const tg = sceneTarget(n.tail);
      if (tg) {
        const { side, p } = tailBase(x, y, w, h, tg[0], tg[1]), s = 13 * k, horiz = side === 't' || side === 'b';
        const a = horiz ? [p[0] - s, p[1]] : [p[0], p[1] - s], b = horiz ? [p[0] + s, p[1]] : [p[0], p[1] + s];
        D.path(`M${a[0]} ${a[1]} L${tg[0]} ${tg[1]} L${b[0]} ${b[1]}`, { fill, fillStyle: 'solid', strokeWidth: sw, roughness: 0.8 });
        // hide the bubble border under the tail's base
        D.line(a[0] + (horiz ? 3 : 0), a[1] + (horiz ? 0 : 3), b[0] - (horiz ? 3 : 0), b[1] - (horiz ? 0 : 3), { stroke: fill, strokeWidth: sw + 2, roughness: 0.2 });
      }
      const t = textBlock(n.text, 21 * k, n.width ?? 230 * k, !!n.bold);
      D.text(cx, cy - t.h / 2, n.text ?? '', { size: 21 * k, bold: !!n.bold, maxW: n.width ?? 230 * k, color: ink_(n.textColor, INK) });
    },
  },
  notepad: {
    size: (n, k) => [170 * k, 210 * k],
    draw: (n, cx, cy, w, h, k) => {
      const x = cx - w / 2, y = cy - h / 2, bg = spec.background && spec.background !== 'transparent' ? spec.background : '#ffffff';
      D.rect(x, y, w, h, { fill: '#fffbe6', fillStyle: 'solid', strokeWidth: SW(n, k) * 1.2 });
      for (let i = 0; i < 6; i++) D.ellipse(x + 18 * k + i * 27 * k, y, 14 * k, 14 * k, { fill: bg, fillStyle: 'solid', strokeWidth: 1.8 * k });
      let ly = y + 30 * k;
      if (n.text) { D.text(cx, y + 20 * k, n.text, { size: 25 * k, bold: true, color: ink_(n.color, STRONG.green) }); ly = y + 72 * k; }
      for (let i = 0; ly + i * 26 * k < y + h - 14 * k; i++) D.line(x + 20 * k, ly + i * 26 * k, x + w - 20 * k - (i % 2) * 30 * k, ly + i * 26 * k, { stroke: '#868e96', strokeWidth: 1.4 * k, roughness: 0.8 });
    },
  },
  mic: {
    size: (n, k) => [64 * k, 130 * k],
    draw: (n, cx, cy, w, h, k) => {
      const T = cy - h / 2, sw = SW(n, k);
      D.rect(cx - 20 * k, T, 40 * k, 72 * k, { r: 19 * k, fill: bold_(n.color ?? 'green'), fillStyle: 'solid', strokeWidth: sw });
      D.path(`M${cx - 31 * k} ${T + 48 * k} Q${cx} ${T + 112 * k} ${cx + 31 * k} ${T + 48 * k}`, { strokeWidth: sw });
      D.line(cx, T + 88 * k, cx, T + 122 * k, { strokeWidth: sw });
      D.line(cx - 26 * k, T + 125 * k, cx + 26 * k, T + 125 * k, { strokeWidth: sw * 1.1 });
    },
  },
  bulb: {
    size: (n, k) => [170 * k, 190 * k],
    draw: (n, cx, cy, w, h, k) => {
      const by = cy - 18 * k, sw = SW(n, k);
      for (const a of [-150, -120, -90, -60, -30]) {
        const t = (a * Math.PI) / 180;
        D.line(cx + 58 * k * Math.cos(t), by + 58 * k * Math.sin(t), cx + 82 * k * Math.cos(t), by + 82 * k * Math.sin(t), { stroke: ink_(n.color, '#f59f00'), strokeWidth: 3 * k });
      }
      D.ellipse(cx, by, 90 * k, 90 * k, { fill: bold_(n.color ?? 'yellow'), fillStyle: 'hachure', hachureGap: 6 * k, fillWeight: 2.4, strokeWidth: sw });
      D.path(`M${cx - 16 * k} ${by + 45 * k} L${cx - 12 * k} ${by + 10 * k} L${cx - 6 * k} ${by + 22 * k} L${cx} ${by + 6 * k} L${cx + 6 * k} ${by + 22 * k} L${cx + 12 * k} ${by + 10 * k} L${cx + 16 * k} ${by + 45 * k}`, { strokeWidth: sw * 0.9 });
      D.rect(cx - 18 * k, by + 45 * k, 36 * k, 28 * k, { fill: '#ced4da', fillStyle: 'solid', strokeWidth: sw });
      D.line(cx - 18 * k, by + 82 * k, cx + 18 * k, by + 82 * k, { strokeWidth: sw });
    },
  },
  sparkle: {
    size: (n, k) => [30 * k, 30 * k],
    draw: (n, cx, cy, w, h, k) => {
      const s = 14 * k, c = ink_(n.color, '#f59f00'), o = { stroke: c, strokeWidth: 3 * k, roughness: 0.8 };
      D.line(cx - s, cy, cx + s, cy, o); D.line(cx, cy - s, cx, cy + s, o);
      D.line(cx - s * 0.6, cy - s * 0.6, cx + s * 0.6, cy + s * 0.6, { ...o, strokeWidth: 2 * k }); D.line(cx - s * 0.6, cy + s * 0.6, cx + s * 0.6, cy - s * 0.6, { ...o, strokeWidth: 2 * k });
    },
  },
  doc: {
    size: (n, k) => [(130 + (n.stack ? 16 : 0)) * k, (165 + (n.stack ? 16 : 0)) * k],
    draw: (n, cx, cy, w, h, k) => {
      const sw = SW(n, k), x = cx - w / 2, y = cy - h / 2, pw = 130 * k, ph = 165 * k;
      if (n.stack) for (const off of [16, 8]) D.rect(x + off * k, y + off * k, pw, ph, { fill: '#ffffff', fillStyle: 'solid', strokeWidth: sw * 0.9 });
      D.rect(x, y, pw, ph, { fill: fillOf(n.color) ?? '#ffffff', fillStyle: 'solid', strokeWidth: sw });
      let ly = y + 26 * k;
      if (n.text) { D.text(x + pw / 2, y + 10 * k, n.text, { size: 18 * k, bold: true, maxW: pw - 20 * k }); ly = y + 50 * k + (textBlock(n.text, 18 * k, pw - 20 * k).h - lineH(18 * k)); }
      for (let i = 0; ly + i * 18 * k < y + ph - 14 * k; i++) D.line(x + 16 * k, ly + i * 18 * k, x + pw - 16 * k - ((i * 37) % 3) * 14 * k, ly + i * 18 * k, { stroke: '#868e96', strokeWidth: 1.4 * k, roughness: 0.9 });
    },
  },
  text: {
    size: (n, k) => { const t = textBlock(n.label, (n.size ?? 22) * k, n.width ?? 420, n.bold ?? true); return [Math.max(t.w, 10), t.h]; },
    draw: (n, cx, cy, w, h, k) => D.text(cx, cy - h / 2, n.label ?? '', { size: (n.size ?? 22) * k, bold: n.bold ?? true, maxW: n.width ?? 420, color: ink_(n.color, INK), rotate: n.rotate }),
  },
};

// ---------- node sizing ----------
const DEVICES = { phone: { w: 250, minH: 500, pad: 18, top: 34, r: 30 }, tablet: { w: 420, minH: 560, pad: 24, top: 30, r: 22 }, desktop: { w: 560, minH: 360, pad: 24, top: 40, r: 10 } };
const CAPTION_H = 34;
const GAP = 12;

function screenLayout(n) {
  const dev = DEVICES[n.device || 'phone'] || DEVICES.phone;
  const W = dev.w - dev.pad * 2;
  const comps = (n.components || []).map((c, i) => {
    const def = COMPONENTS[c.type];
    if (!def) { warn(`Unknown component type "${c.type}" in screen "${n.id}"`); return null; }
    return { c, def, h: def.h(c, W), id: c.id ?? `${c.type}${i}` };
  }).filter(Boolean);
  let content = comps.reduce((a, k) => a + k.h, 0) + Math.max(0, comps.length - 1) * GAP;
  const frameH = Math.max(n.minHeight ?? dev.minH, dev.top + content + dev.pad + 22);
  const flexIdx = comps.findIndex((k) => k.c.type === 'spacer' && k.c.flex);
  const extra = frameH - (dev.top + content + dev.pad + 22);
  let y = dev.top + 6;
  for (const [i, k] of comps.entries()) {
    k.y = y; // relative to frame top
    y += k.h + GAP;
    if (i === flexIdx) y += extra;
  }
  return { dev, W, comps, frameW: dev.w, frameH, hasCaption: !!n.label };
}

function nodeSize(n) {
  const kind = n.kind || (n.components ? 'screen' : 'box');
  n.kind = kind;
  if (isScene && DOODLES[kind]) { const k = n.scale ?? 1, [w, h] = DOODLES[kind].size(n, k); return [Math.round(w), Math.round(h)]; }
  if (kind === 'screen') {
    n._screen = screenLayout(n);
    n._capH = n.label ? CAPTION_H : 0;
    return [n._screen.frameW, n._screen.frameH + n._capH];
  }
  const size = n.size ?? (kind === 'note' ? 14 : 16);
  const maxText = n.width ? n.width - 32 : (kind === 'note' ? 170 : 190);
  const lines = wrap(n.label ?? '', size, maxText, kind !== 'note');
  const tw = Math.max(...lines.map((l) => measure(l, size, kind !== 'note')), 20);
  let th = lines.length * lineH(size);
  if (n.sub) th += 4 + D.textHeight(n.sub, 12, maxText);
  let w = n.width ?? Math.max(110, tw + 40), h = n.height ?? Math.max(56, th + 28);
  if (kind === 'diamond') { w = n.width ?? Math.max(150, tw * 1.55 + 40); h = n.height ?? Math.max(110, th * 2 + 40); }
  if (kind === 'ellipse' || kind === 'circle') { w = n.width ?? Math.max(120, tw * 1.35 + 30); h = n.height ?? Math.max(64, th * 1.5 + 24); if (kind === 'circle') { w = h = Math.max(w, h); } }
  if (kind === 'pill' || kind === 'start' || kind === 'end') { h = n.height ?? 48; w = n.width ?? Math.max(110, tw + 48); }
  if (kind === 'note') { w = n.width ?? Math.max(140, tw + 32); h = n.height ?? th + 28; }
  return [Math.round(w), Math.round(h)];
}

// ---------- build ELK graph ----------
const nodes = spec.nodes || [];
const byId = new Map(nodes.map((n) => [n.id, n]));
const dir = (spec.direction || 'RIGHT').toUpperCase();
const portSide = { RIGHT: 'EAST', LEFT: 'WEST', DOWN: 'SOUTH', UP: 'NORTH' }[dir] || 'EAST';

const portsByNode = new Map();
function resolveEnd(ref, role) {
  const [nid, part] = String(ref).split('#');
  const n = byId.get(nid);
  if (!n) { warn(`Edge ${role} "${ref}" references unknown node`); return null; }
  if (part && role === 'from') {
    if (!n.components) { warn(`"${ref}": only screens have components`); return { node: nid }; }
    const pid = `${nid}#${part}`;
    if (!portsByNode.has(nid)) portsByNode.set(nid, new Set());
    portsByNode.get(nid).add(part);
    return { node: nid, port: pid };
  }
  if (role === 'to' && n.components && spec.screenInputPort !== false) {
    // all edges enter a screen at the middle of its frame, not at the caption corner
    if (!portsByNode.has(nid)) portsByNode.set(nid, new Set());
    portsByNode.get(nid).add('__in');
    return { node: nid, port: `${nid}#__in` };
  }
  return { node: nid };
}

const elkNodes = new Map();
for (const n of nodes) {
  const [w, h] = nodeSize(n);
  n._w = w; n._h = h;
  elkNodes.set(n.id, { id: n.id, width: w, height: h });
}
const edges = (isMap || isScene ? [] : (spec.edges || [])).map((e, i) => ({ ...e, _id: `e${i}`, _from: resolveEnd(e.from, 'from'), _to: resolveEnd(e.to, 'to') })).filter((e) => e._from && e._to);

// component ports
for (const [nid, parts] of portsByNode) {
  const n = byId.get(nid), s = n._screen, en = elkNodes.get(nid);
  en.ports = [...parts].map((part) => {
    if (part === '__in') {
      const side = { EAST: 'WEST', WEST: 'EAST', SOUTH: 'NORTH', NORTH: 'SOUTH' }[portSide];
      // enter at the same height as the first incoming component port -> straight arrows, aligned screens
      let my = n._capH + s.frameH / 2;
      const inc = edges.find((e) => e._to.port === `${nid}#__in` && e._from.port);
      if (inc && ['EAST', 'WEST'].includes(side)) {
        const sn = byId.get(inc._from.node), part = inc._from.port.split('#')[1];
        const k = sn._screen.comps.find((k) => k.id === part || k.c.id === part);
        if (k) my = Math.min(n._capH + s.frameH - 30, Math.max(n._capH + 40, sn._capH + k.y + k.h / 2 + (n._capH - sn._capH)));
      }
      const mx = n._w / 2;
      const pos_ = { WEST: { x: -1, y: my }, EAST: { x: n._w, y: my }, NORTH: { x: mx, y: -1 }, SOUTH: { x: mx, y: n._h } }[side];
      return { id: `${nid}#__in`, width: 1, height: 1, ...pos_, layoutOptions: { 'elk.port.side': side } };
    }
    const k = s.comps.find((k) => k.id === part || k.c.id === part);
    if (!k) warn(`Screen "${nid}" has no component with id "${part}" (give the component an "id")`);
    const cy = n._capH + (k ? k.y + k.h / 2 : s.frameH / 2);
    const cx = s.dev.pad + (k ? s.W : 0);
    const side = portSide;
    const p = { id: `${nid}#${part}`, width: 1, height: 1, layoutOptions: { 'elk.port.side': side } };
    if (side === 'EAST') Object.assign(p, { x: n._w, y: cy });
    else if (side === 'WEST') Object.assign(p, { x: -1, y: cy });
    else if (side === 'SOUTH') Object.assign(p, { x: cx, y: n._h });
    else Object.assign(p, { x: cx, y: -1 });
    p._anchor = { x: k ? s.dev.pad + s.W : n._w, y: cy, part };
    return p;
  });
  en.layoutOptions = { 'elk.portConstraints': 'FIXED_POS' };
}

const groups = spec.groups || [];
const grouped = new Set();
const rootChildren = [];
for (const g of groups) {
  const kids = (g.children || []).map((id) => { grouped.add(id); return elkNodes.get(id); }).filter(Boolean);
  rootChildren.push({ id: `group:${g.id}`, children: kids, layoutOptions: { 'elk.padding': `[top=${g.label ? 52 : 28},left=28,bottom=28,right=28]`, 'elk.direction': (g.direction || dir) } });
}
for (const n of nodes) if (!grouped.has(n.id)) rootChildren.push(elkNodes.get(n.id));

const labelDims = (t) => { const lines = wrap(t, 15, 160); return { width: Math.max(...lines.map((l) => measure(l, 15))) + 16, height: lines.length * lineH(15) + 6 }; };
const elkEdges = edges.map((e) => ({
  id: e._id,
  sources: [e._from.port || e._from.node],
  targets: [e._to.port || e._to.node],
  labels: e.label ? [{ text: e.label, ...labelDims(e.label) }] : [],
}));

const spacing = spec.spacing ?? 1;
const graph = {
  id: 'root',
  layoutOptions: {
    'elk.algorithm': 'layered',
    'elk.direction': dir,
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(90 * spacing)),
    'elk.spacing.nodeNode': String(Math.round(50 * spacing)),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(Math.round(30 * spacing)),
    'elk.spacing.edgeNode': String(Math.round(26 * spacing)),
    'elk.spacing.edgeEdge': '18',
    'elk.spacing.edgeLabel': '6',
    'elk.edgeLabels.placement': 'CENTER',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
    'elk.json.edgeCoords': 'ROOT',
    'elk.json.shapeCoords': 'ROOT',
    ...(spec.wrap ? { 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.aspectRatio': String(spec.aspectRatio ?? 1.6) } : {}),
    ...(spec.elk || {}),
  },
  children: rootChildren,
  edges: elkEdges,
};

// ---------- map layout: things placed by coordinates (lon/lat or plain x/y) ----------
// Strong tones for lines, arrows and map labels (fills keep the pastel PALETTE).
const STRONG = { blue: '#1c7ed6', green: '#2b8a3e', yellow: '#e67700', red: '#c92a2a', violet: '#7048e8', orange: '#e8590c', pink: '#c2255c', teal: '#0c8599', gray: '#495057', black: INK };
const strongOf = (c) => (c ? STRONG[c] ?? c : INK);
const MAP = (() => {
  if (!isMap) return null;
  const m = spec.map || {};
  let b = m.bounds;
  if (!Array.isArray(b) || b.length !== 4) {
    warn('Map layout needs "map": { "bounds": [west, south, east, north] }');
    b = [0, 0, 100, 100];
  }
  const [west, south, east, north] = b.map(Number);
  const geo = (m.projection ?? 'geo') !== 'plain';
  const width = Number(m.width ?? 1400);
  const kx = width / (east - west);
  const ky = geo ? kx / Math.cos((((north + south) / 2) * Math.PI) / 180) : kx;
  const height = (north - south) * ky;
  return { west, south, east, north, width, height, kx, ky, cfg: m };
})();
// map coords -> canvas px (absolute: includes the OX/OY margins once they exist)
const mp = (pt) => [OX + (pt[0] - MAP.west) * MAP.kx, OY + (MAP.north - pt[1]) * MAP.ky];
const isPt = (v) => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number');

function mapLayout() {
  for (const n of nodes) {
    if (!isPt(n.at)) { warn(`Map node "${n.id}" needs "at": [lon, lat]`); continue; }
    const [x, y] = n.at;
    if (x < MAP.west || x > MAP.east || y < MAP.south || y > MAP.north) warn(`Map node "${n.id}" is outside map.bounds`);
  }
  return { width: MAP.width, height: MAP.height, children: [], edges: [] };
}

function drawMap() {
  const X0 = OX, Y0 = OY, W = MAP.width, H = MAP.height, cfg = MAP.cfg;
  const obstacles = [];  // rects {x,y,w,h} labels must avoid
  const ink = [];        // [x, y, weight]: points of lines/arrows/outlines that labels should avoid
  const sample = (pts, wgt = 1, step = 7) => { for (let i = 1; i < pts.length; i++) { const [a, b] = [pts[i - 1], pts[i]]; const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); for (let k = 0; k <= n; k++) ink.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, wgt]); } };
  // Catmull-Rom through the points: close to the curve rough.js draws, used for label avoidance
  const spline = (pts, per = 14) => {
    if (pts.length < 3) return pts;
    const out = [], P_ = [pts[0], ...pts, pts.at(-1)];
    for (let i = 1; i < P_.length - 2; i++) for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t, [p0, p1, p2, p3] = [P_[i - 1], P_[i], P_[i + 1], P_[i + 2]];
      out.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
    out.push(pts.at(-1));
    return out;
  };
  const labelsLater = [];

  // frame + sea
  const hasLand = Array.isArray(spec.land) && spec.land.length > 0;
  const sea = cfg.sea ?? (hasLand ? 'blue' : false);
  svgParts.push(`<clipPath id="mapclip"><rect x="${X0}" y="${Y0}" width="${W}" height="${H}"/></clipPath>`);
  if (sea) {
    const c = fillOf(sea);
    svgParts.push(`<rect x="${X0}" y="${Y0}" width="${W}" height="${H}" fill="${tint(c, 0.35)}"/>`);
    D.rect(X0, Y0, W, H, { stroke: 'none', fill: c, fillStyle: 'hachure', hachureGap: 14, hachureAngle: 0, fillWeight: 0.9, roughness: 0.6 });
  }
  svgParts.push('<g clip-path="url(#mapclip)">');

  // land
  for (const poly of hasLand ? spec.land : []) {
    const pts = (poly.points ?? poly).filter(isPt).map(mp);
    if (pts.length < 3) continue;
    const color = poly.color ? fillOf(poly.color) : '#f4f1e6';
    emit(gen.polygon(pts, opts({ stroke: INK, strokeWidth: 2.2, fill: color, fillStyle: 'solid', roughness: 0.7 })));
    emit(gen.polygon(pts, opts({ stroke: 'none', fill: '#c9bf9a', fillStyle: 'hachure', hachureGap: 16, fillWeight: 0.7, roughness: 0.8 })));
    sample([...pts, pts[0]], 0.25);
  }

  // areas (zones): polygon "points" or ellipse "center" + "size" [w, h] in px
  for (const a of spec.areas || []) {
    const col = a.color ?? 'green', stroke = strongOf(col);
    const o = { stroke, strokeWidth: 2, fill: fillOf(col), fillStyle: a.fillStyle ?? 'cross-hatch', hachureGap: 10, fillWeight: 1, roughness: 1.1 };
    let center;
    if (isPt(a.center)) {
      const [cx, cy] = mp(a.center), [w, h] = a.size ?? [160, 100];
      if (a.fill === false) delete o.fill;
      emit(gen.ellipse(cx, cy, w, h, opts(o)), { dashed: a.dashed ?? true });
      sample(Array.from({ length: 41 }, (_, i) => [cx + (w / 2) * Math.cos((i / 40) * 2 * Math.PI), cy + (h / 2) * Math.sin((i / 40) * 2 * Math.PI)]), 0.5);
      center = [cx, cy];
    } else {
      const pts = (a.points || []).filter(isPt).map(mp);
      if (pts.length < 3) { warn(`Area "${a.label ?? '?'}" needs "points" (3+) or "center"`); continue; }
      if (a.fill === false) delete o.fill;
      emit(gen.polygon(pts, opts(o)), { dashed: a.dashed ?? true });
      sample([...pts, pts[0]], 0.5);
      center = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    }
    if (isPt(a.labelAt)) center = mp(a.labelAt);
    if (a.label) labelsLater.push({ kind: 'fixed', at: center, text: a.label, sub: a.sub, color: stroke, size: a.size_ ?? 17 });
  }

  // lines (fronts, walls, roads, borders): no arrowhead
  for (const l of spec.lines || []) {
    const pts = (l.points || []).filter(isPt).map(mp);
    if (pts.length < 2) continue;
    const stroke = strongOf(l.color ?? 'gray');
    emit(gen.linearPath(pts, opts({ stroke, strokeWidth: l.width ?? 3, roughness: 0.7 })), { dashed: l.dashed ?? false });
    sample(pts);
    if (l.label) labelsLater.push({ kind: 'path', pts, text: l.label, color: stroke, size: 15 });
  }
  svgParts.push('</g>');
  D.rect(X0, Y0, W, H, { stroke: INK, strokeWidth: 2, roughness: 0.8 });

  // markers: compute rects first so arrows can stop at their edge
  const byNode = new Map();
  for (const n of nodes) {
    if (!isPt(n.at)) continue;
    const [cx, cy] = mp(n.at), k = n.kind;
    let r;
    if (k === 'place') r = { x: cx - 5, y: cy - 5, w: 10, h: 10, round: true };
    else if (k === 'unit') r = { x: cx - 18, y: cy - 12, w: 36, h: 24 };
    else if (k === 'badge') r = { x: cx - 16, y: cy - 16, w: 32, h: 32, round: true };
    else if (k === 'label') r = { x: cx - 1, y: cy - 1, w: 2, h: 2, round: true };
    else r = { x: cx - n._w / 2, y: cy - n._h / 2, w: n._w, h: n._h };
    byNode.set(n.id, { n, cx, cy, r });
    if (k !== 'label') obstacles.push(r);
  }

  // arrows: from/to = node id or [lon, lat]; "via" bends the path
  const endPt = (ref) => (isPt(ref) ? { p: mp(ref) } : byNode.has(ref) ? { p: [byNode.get(ref).cx, byNode.get(ref).cy], node: byNode.get(ref) } : null);
  const trim = (p, toward, node) => {
    if (!node) return p;
    const { r } = node, dx = toward[0] - p[0], dy = toward[1] - p[1], len = Math.hypot(dx, dy) || 1;
    let t;
    if (r.round) t = r.w / 2 + 4;
    else { const tx = dx ? (r.w / 2 + 4) / Math.abs(dx / len) : Infinity, ty = dy ? (r.h / 2 + 4) / Math.abs(dy / len) : Infinity; t = Math.min(tx, ty); }
    return [p[0] + (dx / len) * Math.min(t, len * 0.45), p[1] + (dy / len) * Math.min(t, len * 0.45)];
  };
  for (const e of spec.edges || []) {
    const a = endPt(e.from), b = endPt(e.to);
    if (!a || !b) { warn(`Map arrow ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}: unknown node (use a node id or [lon, lat])`); continue; }
    const via = (e.via || []).filter(isPt).map(mp);
    let pts = [a.p, ...via, b.p];
    pts[0] = trim(pts[0], pts[1], a.node);
    pts[pts.length - 1] = trim(pts.at(-1), pts.at(-2), b.node);
    const stroke = strongOf(e.color ?? 'blue'), w = e.width ?? 4;
    emit(pts.length > 2 ? gen.curve(pts, opts({ stroke, strokeWidth: w, roughness: 0.8, bowing: 0.5 })) : gen.line(...pts[0], ...pts[1], opts({ stroke, strokeWidth: w, roughness: 0.8, bowing: 0.5 })), { dashed: e.dashed });
    const curve = spline(pts);
    if (e.arrow !== false) {
      const [x2, y2] = curve.at(-1), [x1, y1] = curve.at(-2);
      const ang = Math.atan2(y2 - y1, x2 - x1), L = 10 + w * 3, sp = 0.42;
      emit(gen.polygon([[x2, y2], [x2 - L * Math.cos(ang - sp), y2 - L * Math.sin(ang - sp)], [x2 - L * Math.cos(ang + sp), y2 - L * Math.sin(ang + sp)]], opts({ stroke, fill: stroke, fillStyle: 'solid', strokeWidth: 1.5, roughness: 0.5 })));
    }
    sample(curve);
    if (e.label) labelsLater.push({ kind: 'path', pts: curve, text: e.label, color: stroke, size: 14.5 });
  }

  // markers
  for (const { n, cx, cy, r } of byNode.values()) {
    const col = n.color, stroke = strongOf(col ?? (n.kind === 'unit' ? 'orange' : 'black'));
    if (n.kind === 'place') {
      D.ellipse(cx, cy, n.size ?? 9, n.size ?? 9, { fill: INK, fillStyle: 'solid', strokeWidth: 1, roughness: 0.4 });
      if (n.label) labelsLater.push({ kind: 'point', at: [cx, cy], r, text: n.label, sub: n.sub, pos: n.labelPos, color: col ? stroke : INK, size: n.minor ? 13 : 15, bold: !n.minor });
    } else if (n.kind === 'unit') {
      D.rect(r.x, r.y, r.w, r.h, { stroke, fill: fillOf(col ?? 'orange'), fillStyle: 'solid', strokeWidth: 2, roughness: 0.6 });
      const sym = n.symbol ?? 'none';
      if (sym === 'armor') D.ellipse(cx, cy, 22, 11, { stroke, strokeWidth: 1.6, roughness: 0.4 });
      if (sym === 'infantry') { D.line(r.x, r.y, r.x + r.w, r.y + r.h, { stroke, strokeWidth: 1.6, roughness: 0.4 }); D.line(r.x, r.y + r.h, r.x + r.w, r.y, { stroke, strokeWidth: 1.6, roughness: 0.4 }); }
      if (sym === 'airborne') D.path(`M${cx - 10} ${cy + 2} Q${cx - 5} ${cy - 6} ${cx} ${cy + 2} Q${cx + 5} ${cy - 6} ${cx + 10} ${cy + 2}`, { stroke, strokeWidth: 1.6, roughness: 0.4 });
      if (n.label) labelsLater.push({ kind: 'point', at: [cx, cy], r, text: n.label, sub: n.sub, pos: n.labelPos, color: stroke, size: 13.5, bold: true });
    } else if (n.kind === 'label') {
      labelsLater.push({ kind: 'fixed', at: [cx, cy], text: n.label ?? '', sub: n.sub, color: strongOf(col ?? 'black'), size: n.size ?? 15, bold: n.bold ?? true });
    } else if (n.kind === 'badge') {
      D.ellipse(cx, cy, 30, 30, { stroke, fill: '#ffffff', fillStyle: 'solid', strokeWidth: 2.2, roughness: 0.7 });
      D.text(cx, cy - fs_(18) * 0.62, String(n.label ?? ''), { size: 18, bold: true, color: stroke });
    } else {
      // box / note / text / pill...: same look as in diagrams, centered on the coordinate
      pos.set(n.id, { x: r.x - OX, y: r.y - OY });
      drawNode(n);
    }
  }

  // legend
  if (Array.isArray(cfg.legend) && cfg.legend.length) {
    const items = cfg.legend, rowH = 30, w = Math.max(...items.map((i) => measure(i.label ?? '', 14.5))) + 70, h = items.length * rowH + 18;
    const corner = cfg.legendPos ?? 'bottom-left';
    const lx = corner.includes('right') ? X0 + W - w - 14 : X0 + 14, ly = corner.includes('top') ? Y0 + 14 : Y0 + H - h - 14;
    D.rect(lx, ly, w, h, { fill: '#ffffff', fillStyle: 'solid', strokeWidth: 1.6, roughness: 0.7, r: 6 });
    items.forEach((it, i) => {
      const cy = ly + 9 + rowH * i + rowH / 2, sx = lx + 26, c = strongOf(it.color ?? 'black');
      const type = it.type ?? (it.badge != null ? 'badge' : 'swatch');
      if (type === 'badge') { D.ellipse(sx, cy, 26, 26, { stroke: c, fill: '#fff', fillStyle: 'solid', strokeWidth: 2, roughness: 0.6 }); D.text(sx, cy - fs_(15) * 0.62, String(it.badge ?? ''), { size: 15, bold: true, color: c }); }
      else if (type === 'line' || type === 'dashed' || type === 'arrow') { D.line(sx - 14, cy, sx + 14, cy, { stroke: c, strokeWidth: type === 'arrow' ? 4 : 3, roughness: 0.4, dashed: type === 'dashed' }); if (type === 'arrow') D.poly([[sx + 6, cy - 6], [sx + 14, cy], [sx + 6, cy + 6]], { stroke: c, strokeWidth: 3, roughness: 0.3 }); }
      else D.rect(sx - 12, cy - 9, 24, 18, { stroke: c, fill: fillOf(it.color ?? 'gray'), fillStyle: 'solid', strokeWidth: 1.6, roughness: 0.5, r: 3 });
      D.text(lx + 52, cy - lineH(14.5) / 2, it.label ?? '', { size: 14.5, anchor: 'start' });
    });
    const lg = { x: lx, y: ly, w, h };
    for (const { n, r } of byNode.values()) {
      const ox = Math.max(0, Math.min(r.x + r.w, lg.x + lg.w) - Math.max(r.x, lg.x)), oy = Math.max(0, Math.min(r.y + r.h, lg.y + lg.h) - Math.max(r.y, lg.y));
      if (ox * oy > 0) warn(`Map node "${n.id}" is hidden under the legend: move it or set map.legendPos (top-left, top-right, bottom-right)`);
    }
    obstacles.push(lg);
  }

  // ---------- labels, placed last to avoid what's already drawn ----------
  const frame = { x: X0, y: Y0, w: W, h: H };
  const ov = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const outside = (r) => r.w * r.h - ov(r, frame);
  const inkIn = (r) => { let c = 0; for (const [x, y, wg] of ink) if (x > r.x - 6 && x < r.x + r.w + 6 && y > r.y - 5 && y < r.y + r.h + 5) c += wg; return c; };
  const score = (r, i) => obstacles.reduce((s, o) => s + ov(r, o), 0) * 10 + inkIn(r) * 300 + outside(r) * 1000 + i * 25;
  const block = (L) => {
    const size = L.size, bold = L.bold ?? true;
    if (L.kind !== 'fixed' && !L._wrapped) { L.text = wrap(L.text, size, L.maxW ?? 210, bold).join('\n'); L._wrapped = true; }
    const lines = String(L.text).split('\n');
    const w = Math.max(...lines.map((t) => measure(t, size, bold)), L.sub ? Math.max(...String(L.sub).split('\n').map((t) => measure(t, 12.5))) : 0);
    const h = lines.length * lineH(size) + (L.sub ? String(L.sub).split('\n').length * lineH(12.5) : 0);
    return { w, h, lines, bold };
  };
  const put = (L, rect, anchor) => {
    const x = anchor === 'start' ? rect.x : anchor === 'end' ? rect.x + rect.w : rect.x + rect.w / 2;
    let y = rect.y + D.text(x, rect.y, L.text, { size: L.size, bold: L.bold ?? true, color: L.color, anchor, halo: true });
    if (L.sub) D.text(x, y, L.sub, { size: 12.5, color: L.color === INK ? MUTED : L.color, anchor, halo: true });
    obstacles.push({ x: rect.x - 3, y: rect.y - 2, w: rect.w + 6, h: rect.h + 4 });
  };
  const POS = { e: [1, 0], w: [-1, 0], n: [0, -1], s: [0, 1], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] };
  const order = ['e', 'w', 'ne', 'se', 'nw', 'sw', 'n', 's'];
  // fixed labels first (areas), then points, then path labels
  const rank = { fixed: 0, point: 1, path: 2 };
  // short paths first: they have fewer good spots
  const plen = (L) => (L.pts ? L.pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - L.pts[i - 1][0], p[1] - L.pts[i - 1][1]) : 0), 0) : 0);
  for (const L of labelsLater.sort((a, b) => rank[a.kind] - rank[b.kind] || plen(a) - plen(b))) {
    const { w, h } = block(L);
    if (L.kind === 'fixed') { put(L, { x: L.at[0] - w / 2, y: L.at[1] - h / 2, w, h }, 'middle'); continue; }
    const cands = [];
    if (L.kind === 'point') {
      const [px, py] = L.at, gx = L.r.w / 2 + 6, gy = L.r.h / 2 + 4;
      for (const k of (L.pos ? [L.pos] : order)) {
        const [dx, dy] = POS[k] ?? POS.e;
        const x = dx > 0 ? px + gx : dx < 0 ? px - gx - w : px - w / 2;
        const y = dy > 0 ? py + gy : dy < 0 ? py - gy - h : py - h / 2;
        cands.push({ r: { x, y, w, h }, a: dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle' });
      }
    } else {
      // along a path: try points near the middle, beside the line on either side
      const pts = L.pts, segs = [];
      let tot = 0;
      for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segs.push([pts[i - 1], pts[i], tot, l]); tot += l; }
      for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
        const d = f * tot, sg = segs.find(([, , s0, l]) => d >= s0 && d <= s0 + l) ?? segs.at(-1);
        const t = sg[3] ? (d - sg[2]) / sg[3] : 0, px = sg[0][0] + (sg[1][0] - sg[0][0]) * t, py = sg[0][1] + (sg[1][1] - sg[0][1]) * t;
        const nx = -(sg[1][1] - sg[0][1]) / (sg[3] || 1), ny = (sg[1][0] - sg[0][0]) / (sg[3] || 1);
        for (const side of [1, -1]) {
          // distance along the normal so the whole rectangle clears the line (support function of the rect)
          const dd = (w / 2) * Math.abs(nx) + (h / 2) * Math.abs(ny) + 9;
          const ox = px + nx * side * dd, oy = py + ny * side * dd;
          cands.push({ r: { x: ox - w / 2, y: oy - h / 2, w, h }, a: 'middle' });
        }
      }
    }
    let best = cands[0], bs = Infinity;
    cands.forEach((c, i) => { const sc = score(c.r, i); if (sc < bs) { bs = sc; best = c; } });
    put(L, best.r, best.a);
  }
}

// ---------- scene layout: an illustrated whiteboard, everything placed by pixel coordinates ----------
// Nodes have "at": [x, y] = centre of the drawing. Doodles (DOODLES) plus every normal kind (box, note, screen...).
const sceneBox = new Map(); // id -> { cx, cy, w, h, capH, capMaxW }, scene coordinates (before margins)
const capMaxW = (n) => Math.max(n._w, 220);
function sceneCaptionH(n) {
  if (!DOODLES[n.kind] || n.kind === 'text' || !n.label) return 0;
  const mw = capMaxW(n);
  return 6 + textBlock(n.label, n.labelSize ?? 22, mw).h + (n.sub ? textBlock(n.sub, 15, mw, false).h : 0);
}
function sceneLayout() {
  let maxX = 0, maxY = 0;
  for (const n of nodes) {
    if (!isPt(n.at)) { warn(`Scene node "${n.id}" needs "at": [x, y] (pixels, centre of the drawing)`); continue; }
    const [cx, cy] = n.at, w = n._w, h = n._h, capH = sceneCaptionH(n);
    const capW = capH ? Math.max(...wrap(n.label, n.labelSize ?? 22, capMaxW(n), true).map((l) => measure(l, n.labelSize ?? 22, true))) : 0;
    sceneBox.set(n.id, { cx, cy, w, h, capH, hw: Math.max(w, capW) / 2 });
    maxX = Math.max(maxX, cx + Math.max(w, capW) / 2);
    maxY = Math.max(maxY, cy + h / 2 + capH);
    if (cx - Math.max(w, capW) / 2 < -4 || cy - h / 2 < -4) warn(`Scene node "${n.id}" sticks out past the top or left edge: increase its "at" coordinates`);
  }
  for (const e of spec.edges || []) for (const p of [e.from, e.to, ...(e.via || [])]) if (isPt(p)) { maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
  // overlapping drawings are almost always a placement mistake; "overlap": true on a node allows it
  const boxes = [...sceneBox.entries()].filter(([id]) => { const n = byId.get(id); return n.kind !== 'sparkle' && !n.overlap; })
    .map(([id, b]) => ({ id, x: b.cx - b.hw, y: b.cy - b.h / 2, w: b.hw * 2, h: b.h + b.capH }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const ov = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    if (ov > 0.06 * Math.min(a.w * a.h, b.w * b.h)) warn(`Scene nodes "${a.id}" and "${b.id}" overlap (with their captions): move one, or set "overlap": true if it's intended`);
  }
  const sc = spec.scene ?? {};
  return { width: sc.width ?? Math.ceil(maxX + 12), height: sc.height ?? Math.ceil(maxY + 12), children: [], edges: [] };
}

// Catmull-Rom points through pts (close to what rough.js curve() draws): for arrowheads and label spots.
function catmull(pts, per = 16) {
  if (pts.length < 3) return pts;
  const out = [], P = [pts[0], ...pts, pts.at(-1)];
  for (let i = 1; i < P.length - 2; i++) for (let s = 0; s < per; s++) {
    const t = s / per, t2 = t * t, t3 = t2 * t, [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    out.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
  }
  out.push(pts.at(-1));
  return out;
}

function drawScene() {
  const abs = (p) => [OX + p[0], OY + p[1]];
  sceneTarget = (ref) => {
    if (ref == null) return null;
    if (isPt(ref)) return abs(ref);
    const b = sceneBox.get(ref);
    if (b) return abs([b.cx, b.cy]);
    warn(`Target ${JSON.stringify(ref)} is not a node id or [x, y]`);
    return null;
  };
  const halo = spec.background && spec.background !== 'transparent' ? spec.background : '#ffffff';

  // drawings, in listed order (later ones on top), each with its caption underneath
  for (const n of nodes) {
    const b = sceneBox.get(n.id); if (!b) continue;
    const [cx, cy] = abs([b.cx, b.cy]);
    if (DOODLES[n.kind]) DOODLES[n.kind].draw(n, cx, cy, b.w, b.h, n.scale ?? 1);
    else { pos.set(n.id, { x: b.cx - b.w / 2, y: b.cy - b.h / 2 }); drawNode(n); }
    if (b.capH) {
      const mw = capMaxW(n);
      const y = cy + b.h / 2 + 6 + D.text(cx, cy + b.h / 2 + 6, n.label, { size: n.labelSize ?? 22, bold: true, maxW: mw, color: ink_(n.labelColor, INK) });
      if (n.sub) D.text(cx, y, n.sub, { size: 15, maxW: mw, color: MUTED });
    }
  }

  // arrows: from/to = node id or [x, y]; "via" bends them into a curve; they stop at the drawing's edge
  // the drawing plus its caption underneath, so arrows don't run over the caption
  const rectOf = (b) => ({ cx: OX + b.cx, cy: OY + b.cy + b.capH / 2, hw: Math.max(b.w / 2, b.capH ? b.hw : 0) + 8, hh: (b.h + b.capH) / 2 + 8 });
  const inside = (p, r) => r && Math.abs(p[0] - r.cx) < r.hw && Math.abs(p[1] - r.cy) < r.hh;
  // dense points along the whole path, then cut away what lies inside the start and end drawings
  const dense = (pts) => (pts.length > 2 ? catmull(pts, 24) : Array.from({ length: 41 }, (_, i) => [pts[0][0] + ((pts[1][0] - pts[0][0]) * i) / 40, pts[0][1] + ((pts[1][1] - pts[0][1]) * i) / 40]));
  const head = (tip, from, stroke, w) => {
    const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]), L = 12 + w * 2.6;
    for (const s of [-0.45, 0.45]) D.line(tip[0], tip[1], tip[0] - L * Math.cos(ang + s), tip[1] - L * Math.sin(ang + s), { stroke, strokeWidth: w, roughness: 0.8 });
  };
  for (const e of spec.edges || []) {
    const end = (ref) => (isPt(ref) ? { p: abs(ref) } : sceneBox.has(ref) ? { p: abs([sceneBox.get(ref).cx, sceneBox.get(ref).cy]), r: rectOf(sceneBox.get(ref)) } : null);
    const a = end(e.from), b = end(e.to);
    if (!a || !b) { warn(`Scene arrow ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}: unknown node (use a node id or [x, y])`); continue; }
    const ctrl = [a.p, ...(e.via || []).filter(isPt).map(abs), b.p];
    let curve = dense(ctrl), i0 = 0, i1 = curve.length - 1;
    while (i0 < i1 && inside(curve[i0], a.r)) i0++;
    while (i1 > i0 && inside(curve[i1], b.r)) i1--;
    if (i1 - i0 < 2) { warn(`Scene arrow ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)} has no room between the two drawings: move them apart`); continue; }
    curve = curve.slice(i0, i1 + 1);
    const stroke = ink_(e.color, INK), w = e.width ?? 3;
    const o = { stroke, strokeWidth: w, roughness: e.roughness ?? 1, bowing: 1 };
    if (ctrl.length > 2) { const step = Math.max(1, Math.floor(curve.length / 8)); const sparse = curve.filter((_, i) => i % step === 0); if (sparse.at(-1) !== curve.at(-1)) sparse.push(curve.at(-1)); emit(gen.curve(sparse, opts(o)), { dashed: e.dashed }); }
    else D.line(...curve[0], ...curve.at(-1), { ...o, dashed: e.dashed });
    if (e.arrow !== false) head(curve.at(-1), curve.at(-Math.min(4, curve.length)), stroke, w);
    if (e.both) head(curve[0], curve[Math.min(3, curve.length - 1)], stroke, w);
    if (e.label) {
      const size = e.labelSize ?? 20, mw = e.labelWidth ?? 260, t = textBlock(e.label, size, mw);
      let x, y;
      if (isPt(e.labelAt)) [x, y] = abs(e.labelAt);
      else {
        // middle of the arrow, pushed sideways so the text clears the line
        let tot = 0; const seg = [];
        for (let i = 1; i < curve.length; i++) { const l = Math.hypot(curve[i][0] - curve[i - 1][0], curve[i][1] - curve[i - 1][1]); seg.push([curve[i - 1], curve[i], tot, l]); tot += l; }
        const d = tot / 2, [p0, p1, s0, l] = seg.find(([, , s, len]) => d <= s + len) ?? seg.at(-1), f = l ? (d - s0) / l : 0;
        const nx = -(p1[1] - p0[1]) / (l || 1), ny = (p1[0] - p0[0]) / (l || 1), side = e.labelSide ?? 1;
        const dd = (t.w / 2) * Math.abs(nx) + (t.h / 2) * Math.abs(ny) + 16;
        x = p0[0] + (p1[0] - p0[0]) * f + nx * side * dd; y = p0[1] + (p1[1] - p0[1]) * f + ny * side * dd;
      }
      D.text(x, y - t.h / 2, e.label, { size, bold: true, maxW: mw, color: stroke, halo, rotate: e.labelRotate });
    }
  }

  // numbered step badges on top of everything
  for (const n of nodes) {
    const b = sceneBox.get(n.id); if (!b || n.step == null) continue;
    const [bx, by] = isPt(n.stepAt) ? abs(n.stepAt) : n.kind === 'text' ? abs([b.cx - b.w / 2 - 30, b.cy]) : abs([b.cx - b.w / 2 - 6, b.cy - b.h / 2 + 4]);
    const c = ink_(n.stepColor ?? spec.scene?.stepColor ?? 'violet');
    D.ellipse(bx, by, 40, 40, { fill: c, fillStyle: 'solid', stroke: c, strokeWidth: 2, roughness: 0.7 });
    D.text(bx, by - fs_(21) * 0.62, String(n.step), { size: 21, bold: true, color: '#ffffff' });
  }
}

// ---------- board layout: groups as columns (or rows), nodes in listed order, no ELK ----------
// Returns the same shape ELK does (absolute coords), so the drawing code below is shared.
function boardLayout() {
  const rowsMode = dir === 'DOWN' || dir === 'UP';
  const gapItem = Math.round(22 * spacing), gapLane = Math.round(40 * spacing);
  const lanes = groups.map((g) => ({ g, items: (g.children || []).map((id) => byId.get(id)).filter(Boolean) }));
  const loose = nodes.filter((n) => !grouped.has(n.id));
  if (loose.length) lanes.push({ g: null, items: loose });
  if (dir === 'LEFT' || dir === 'UP') lanes.reverse();
  const STRETCH = new Set(['box', 'note', 'pill', 'start', 'end', 'text']);
  const pad = (l) => ({ top: l.g ? (l.g.label ? 52 : 28) : 0, side: l.g ? 28 : 0, bottom: l.g ? 28 : 0 });
  const children = [], P = new Map();
  let cursor = 0;
  // inner size along the cross axis: column width / row height
  // columns: one shared width (widest card, or spec.columnWidth) so the board reads as a grid
  const colW = spec.columnWidth ?? Math.max(180, ...lanes.flatMap((l) => l.items.filter((n) => n.kind !== 'screen').map((n) => n._w)));
  for (const l of lanes) {
    if (!rowsMode) {
      l.inner = Math.max(colW, ...l.items.map((n) => n._w));
      for (const n of l.items) if (STRETCH.has(n.kind) && n.width == null) {
        // re-measure at the stretched width so the text uses the room (fewer wrapped lines)
        const [, h] = nodeSize({ ...n, width: l.inner, height: n.height });
        n._w = l.inner; n._h = h;
      }
      l.len = l.items.reduce((s, n) => s + n._h, 0) + gapItem * Math.max(0, l.items.length - 1);
    } else {
      l.inner = Math.max(40, ...l.items.map((n) => n._h));
      l.len = l.items.reduce((s, n) => s + n._w, 0) + gapItem * Math.max(0, l.items.length - 1);
    }
  }
  const maxLen = Math.max(0, ...lanes.map((l) => l.len));
  for (const l of lanes) {
    const p = pad(l);
    const box = rowsMode
      ? { x: 0, y: cursor, width: p.side * 2 + maxLen, height: p.top + l.inner + p.bottom }
      : { x: cursor, y: 0, width: p.side * 2 + l.inner, height: p.top + maxLen + p.bottom };
    let along = rowsMode ? p.side : p.top;
    for (const n of l.items) {
      const r = rowsMode
        ? { id: n.id, x: box.x + along, y: box.y + p.top + (l.inner - n._h) / 2, width: n._w, height: n._h }
        : { id: n.id, x: box.x + p.side + (l.inner - n._w) / 2, y: box.y + along, width: n._w, height: n._h };
      along += (rowsMode ? n._w : n._h) + gapItem;
      P.set(n.id, { ...r, lane: l, idx: l.items.indexOf(n) });
      if (!l.g) children.push(r);
    }
    if (l.g) children.push({ id: `group:${l.g.id}`, ...box, children: l.items.map((n) => { const { lane, idx, ...r } = P.get(n.id); return r; }) });
    l.box = box;
    cursor += (rowsMode ? box.height : box.width) + gapLane;
  }
  // simple orthogonal edges
  const laidE = edges.map((e) => {
    const a = P.get(e._from.node), b = P.get(e._to.node);
    let sy = a.y + a.height / 2;
    if (e._from.port) { const q = elkNodes.get(a.id).ports?.find((q) => q.id === e._from.port); if (q) sy = a.y + q.y; }
    const ac = { x: a.x + a.width / 2, y: sy }, bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    let pts;
    const sameLane = a.lane === b.lane;
    if (sameLane && Math.abs(a.idx - b.idx) > 1) {
      // detour outside the lane so the line doesn't cross the nodes in between
      if (!rowsMode) { const x = a.lane.box.x + a.lane.box.width + 10; pts = [[a.x + a.width, ac.y], [x, ac.y], [x, bc.y], [b.x + b.width, bc.y]]; }
      else { const y = a.lane.box.y + a.lane.box.height + 10; pts = [[ac.x, a.y + a.height], [ac.x, y], [bc.x, y], [bc.x, b.y + b.height]]; }
    } else if (b.x >= a.x + a.width || a.x >= b.x + b.width) {
      const fwd = b.x >= a.x + a.width, sx = fwd ? a.x + a.width : a.x, tx = fwd ? b.x : b.x + b.width, mx = (sx + tx) / 2;
      pts = [[sx, ac.y], [mx, ac.y], [mx, bc.y], [tx, bc.y]];
    } else {
      const fwd = b.y >= a.y + a.height, sy2 = fwd ? a.y + a.height : a.y, ty = fwd ? b.y : b.y + b.height, my = (sy2 + ty) / 2;
      pts = [[ac.x, sy2], [ac.x, my], [bc.x, my], [bc.x, ty]];
    }
    const P_ = pts.map(([x, y]) => ({ x, y }));
    const out = { id: e._id, sections: [{ startPoint: P_[0], bendPoints: P_.slice(1, -1), endPoint: P_.at(-1) }], labels: [] };
    if (e.label) {
      const d = labelDims(e.label), m1 = P_[1], m2 = P_[2];
      out.labels.push({ ...d, x: (m1.x + m2.x) / 2 - d.width / 2, y: (m1.y + m2.y) / 2 - d.height / 2 });
    }
    return out;
  });
  const all = [...lanes.map((l) => l.box)];
  return { width: Math.max(0, ...all.map((b) => b.x + b.width)) + 12, height: Math.max(0, ...all.map((b) => b.y + b.height)) + 12, children, edges: laidE };
}

const board = LAYOUT === 'board';
if (spec.layout && !board && !isMap && !isScene) warn(`Unknown layout "${spec.layout}" (use "board", "map", "scene" or leave it out)`);
const laid = isMap ? mapLayout() : isScene ? sceneLayout() : board ? boardLayout() : await new ELK().layout(graph);

// ---------- collect absolute positions ----------
const pos = new Map();
const groupPos = new Map();
(function walk(node) {
  for (const ch of node.children || []) {
    if (ch.id.startsWith('group:')) groupPos.set(ch.id.slice(6), ch);
    else pos.set(ch.id, ch);
    walk(ch);
  }
})(laid);

// ---------- canvas & title ----------
const M = 48;
let titleH = 0;
if (spec.title) titleH += 44;
if (spec.subtitle) titleH += 26;
if (titleH) titleH += 18;
const W_ = Math.ceil(laid.width + M * 2), H_ = Math.ceil(laid.height + M * 2 + titleH);
const OX = M, OY = M + titleH;

// ---------- node drawing ----------
function drawNode(n) {
  const p = pos.get(n.id);
  const x = OX + p.x, y = OY + p.y, w = n._w, h = n._h;
  const fill = fillOf(n.color);
  const fillStyle = n.fillStyle;
  const bold = n.kind !== 'note';
  const size = n.size ?? (n.kind === 'note' ? 14 : 16);
  const label = () => {
    const maxW = (n.kind === 'diamond' ? w * 0.62 : w - 28);
    const th = D.textHeight(n.label ?? '', size, maxW, bold) + (n.sub ? 4 + D.textHeight(n.sub, 12, maxW) : 0);
    let ty = y + h / 2 - th / 2;
    ty += D.text(x + w / 2, ty, n.label ?? '', { size, bold, maxW });
    if (n.sub) D.text(x + w / 2, ty + 4, n.sub, { size: 12, maxW, color: '#495057' });
  };
  switch (n.kind) {
    case 'screen': return drawScreen(n, x, y);
    case 'diamond': D.diamond(x, y, w, h, { fill, fillStyle }); return label();
    case 'ellipse': case 'circle': D.ellipse(x + w / 2, y + h / 2, w, h, { fill, fillStyle }); return label();
    case 'pill': case 'start': case 'end':
      D.rect(x, y, w, h, { r: h / 2, fill: fill ?? (n.kind === 'end' ? PALETTE.gray : PALETTE.green), fillStyle: fillStyle ?? 'solid', strokeWidth: n.kind === 'end' ? 2.4 : 1.6 });
      return label();
    case 'note': {
      D.rect(x, y, w, h, { fill: fill ?? '#fff3bf', fillStyle: 'solid', stroke: '#e8c547', roughness: 0.6, strokeWidth: 1.2 });
      D.path(`M${x + w - 16} ${y + h} L${x + w} ${y + h - 16}`, { stroke: '#e8c547', roughness: 0.4, strokeWidth: 1.2 });
      return label();
    }
    case 'text': return label();
    default: D.rect(x, y, w, h, { r: n.r ?? 10, fill, fillStyle, dashed: n.dashed }); return label();
  }
}

function drawScreen(n, x, y) {
  const s = n._screen, dev = s.dev;
  const fx = x, fy = y + n._capH;
  if (n.label) {
    const num = n.step != null ? `${n.step}  ` : '';
    D.text(fx + 4, y + 2, num + n.label, { size: 17, bold: true, anchor: 'start', maxW: s.frameW });
  }
  // frame
  D.rect(fx + 5, fy + 6, s.frameW, s.frameH, { r: dev.r, fill: '#dee2e6', fillStyle: 'solid', stroke: 'none', roughness: 0.3 }); // soft offset shadow
  D.rect(fx, fy, s.frameW, s.frameH, { r: dev.r, fill: n.bg ? fillOf(n.bg) : '#fff', fillStyle: 'solid', strokeWidth: 2.2, roughness: 0.9 });
  if ((n.device || 'phone') === 'phone') {
    D.rect(fx + s.frameW / 2 - 30, fy + 10, 60, 12, { r: 6, fill: INK, fillStyle: 'solid', roughness: 0.3, strokeWidth: 1 });
    D.line(fx + s.frameW / 2 - 40, fy + s.frameH - 12, fx + s.frameW / 2 + 40, fy + s.frameH - 12, { strokeWidth: 3, roughness: 0.3 });
  } else if (n.device === 'desktop') {
    D.line(fx, fy + 30, fx + s.frameW, fy + 30, { strokeWidth: 1.4, roughness: 0.5 });
    [0, 1, 2].forEach((i) => D.ellipse(fx + 18 + i * 16, fy + 15, 9, 9, { roughness: 0.3, strokeWidth: 1.1, fill: ['#ff8787', '#ffd43b', '#69db7c'][i], fillStyle: 'solid' }));
    if (n.url) { D.rect(fx + 74, fy + 7, s.frameW - 100, 16, { r: 8, roughness: 0.3, strokeWidth: 1 }); D.text(fx + 84, fy + 7, n.url, { size: 11, anchor: 'start', color: MUTED }); }
  }
  const ctx = { accent: ACCENT[n.accent || spec.accent || 'blue'] || ACCENT.blue };
  for (const k of s.comps) {
    k.def.draw(k.c, fx + dev.pad, fy + k.y, s.W, ctx);
    if (k.c.highlight) {
      D.rect(fx + dev.pad - 6, fy + k.y - 6, s.W + 12, k.h + 12, { r: 10, stroke: '#e03131', strokeWidth: 2, roughness: 1.3, dashed: true });
    }
  }
}

// ---------- edge drawing ----------
function clipToShape(pt, prev, n) {
  // move an endpoint lying on the bounding box onto a diamond/ellipse outline, along the last segment axis
  if (!n || !['diamond', 'ellipse', 'circle'].includes(n.kind)) return pt;
  const p = pos.get(n.id), cx = OX + p.x + n._w / 2, cy = OY + p.y + n._h / 2, a = n._w / 2, b = n._h / 2;
  const horizontal = Math.abs(pt[1] - prev[1]) < Math.abs(pt[0] - prev[0]);
  if (horizontal) {
    const dy = Math.min(Math.abs(pt[1] - cy), b * 0.98);
    const dx = n.kind === 'diamond' ? a * (1 - dy / b) : a * Math.sqrt(1 - (dy / b) ** 2);
    return [cx + Math.sign(prev[0] - cx || 1) * dx, pt[1]];
  }
  const dx = Math.min(Math.abs(pt[0] - cx), a * 0.98);
  const dy = n.kind === 'diamond' ? b * (1 - dx / a) : b * Math.sqrt(1 - (dx / a) ** 2);
  return [pt[0], cy + Math.sign(prev[1] - cy || 1) * dy];
}
function roundedPath(pts, r = 14) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const l1 = Math.hypot(x - px, y - py), l2 = Math.hypot(nx - x, ny - y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = x - ((x - px) / l1) * rr, ay = y - ((y - py) / l1) * rr;
    const bx = x + ((nx - x) / l2) * rr, by = y + ((ny - y) / l2) * rr;
    d += ` L${ax.toFixed(1)} ${ay.toFixed(1)} Q${x} ${y} ${bx.toFixed(1)} ${by.toFixed(1)}`;
  }
  const last = pts.at(-1);
  return d + ` L${last[0]} ${last[1]}`;
}
const laidEdges = new Map();
(function walkE(node) { for (const e of node.edges || []) laidEdges.set(e.id, e); for (const c of node.children || []) walkE(c); })(laid);


function drawEdges() {
  const labelQueue = [];
  for (const e of edges) {
    const le = laidEdges.get(e._id);
    if (!le?.sections?.length) { warn(`Edge ${e.from}→${e.to} could not be routed`); continue; }
    const sec = le.sections[0];
    let pts = [sec.startPoint, ...(sec.bendPoints || []), sec.endPoint].map((p) => [OX + p.x, OY + p.y]);
    pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.5);
    if (pts.length < 2) continue;
    pts[pts.length - 1] = clipToShape(pts.at(-1), pts.at(-2), byId.get(e._to.node));
    if (!e._from.port) pts[0] = clipToShape(pts[0], pts[1], byId.get(e._from.node));
    // component-sourced edge: start with a dot on the component
    if (e._from.port) {
      const n = byId.get(e._from.node), p = pos.get(n.id);
      const en = elkNodes.get(n.id).ports.find((q) => q.id === e._from.port);
      const ax = OX + p.x + en._anchor.x + 6, ay = pts[0][1];
      D.ellipse(ax - 6, ay, 8, 8, { fill: e.color ? ACCENT[e.color] : '#e03131', fillStyle: 'solid', stroke: e.color ? ACCENT[e.color] : '#e03131', roughness: 0.3 });
      pts.unshift([ax - 2, ay]);
    }
    const stroke = e.color ? (ACCENT[e.color] ?? e.color) : INK;
    D.path(roundedPath(pts), { stroke, strokeWidth: e.width ?? 1.8, dashed: e.dashed, roughness: 1, bowing: 0.6, single: false });
    // arrowhead (open, excalidraw-like)
    if (e.arrow !== false) {
      const [x2, y2] = pts.at(-1), [x1, y1] = pts.at(-2);
      const ang = Math.atan2(y2 - y1, x2 - x1), L = 14, spread = 0.45;
      D.poly([[x2 - L * Math.cos(ang - spread), y2 - L * Math.sin(ang - spread)], [x2, y2], [x2 - L * Math.cos(ang + spread), y2 - L * Math.sin(ang + spread)]], { stroke, strokeWidth: e.width ?? 1.8, roughness: 0.6 });
    }
    if (e.label && le.labels?.[0]) labelQueue.push({ l: le.labels[0], text: e.label, stroke });
  }
  for (const { l, text } of labelQueue) {
    const x = OX + l.x, y = OY + l.y;
    svgParts.push(`<rect x="${x}" y="${y}" width="${l.width}" height="${l.height}" rx="6" fill="${spec.background ?? '#ffffff'}" opacity="0.92"/>`);
    D.text(x + l.width / 2, y + 3, text, { size: 15, maxW: 160, color: '#343a40' });
  }
  
}

// ---------- assemble in z-order: title, groups, nodes, edges, labels ----------
if (spec.title) D.text(M, M - 6, spec.title, { size: 30, bold: true, anchor: 'start' });
if (spec.subtitle) D.text(M, M + 38, spec.subtitle, { size: 16, anchor: 'start', color: MUTED });
for (const g of isMap || isScene ? [] : groups) {
  const p = groupPos.get(g.id); if (!p) continue;
  const x = OX + p.x, y = OY + p.y;
  D.rect(x, y, p.width, p.height, { r: 16, dashed: true, roughness: 0.8, strokeWidth: 1.4, stroke: '#868e96', fill: g.color ? tint(fillOf(g.color), g.tint ?? (g.color === 'gray' ? 1 : 0.45)) : undefined, fillStyle: g.color ? 'solid' : undefined });
  if (g.label) D.text(x + 18, y + 12, g.label, { size: 17, bold: true, anchor: 'start', color: '#495057' });
}
if (isMap) drawMap();
else if (isScene) drawScene();
else {
  for (const n of nodes) if (pos.has(n.id)) drawNode(n);
  drawEdges();
}

// ---------- write SVG ----------
const b64 = (f) => fs.readFileSync(path.join(ROOT, 'assets/fonts', f)).toString('base64');
const bg = spec.background ?? '#ffffff';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W_}" height="${H_}" viewBox="0 0 ${W_} ${H_}">
<defs><style>
@font-face{font-family:'${FONT.family}';font-weight:400;src:url(data:font/woff;base64,${b64(FONT.regular)}) format('woff');}
@font-face{font-family:'${FONT.family}';font-weight:700;src:url(data:font/woff;base64,${b64(FONT.bold)}) format('woff');}
text{font-family:'${FONT.family}',cursive;}
</style></defs>
${bg === 'transparent' ? '' : `<rect width="100%" height="100%" fill="${bg}"/>`}
${svgParts.join('\n')}
</svg>`;
fs.mkdirSync(path.dirname(outBase), { recursive: true });
fs.writeFileSync(outBase + '.svg', svg);
console.log(`SVG  ${outBase}.svg  (${W_}x${H_})`);

if (wantPng) {
  try {
    // resvg (WebAssembly): no browser needed. It reads TTF/OTF, not WOFF, so unwrap the WOFF fonts in memory.
    const wasmPath = [path.join(HERE, 'resvg.wasm'), path.join(ROOT, 'node_modules/@resvg/resvg-wasm/index_bg.wasm')].find((f) => fs.existsSync(f));
    if (!wasmPath) throw new Error('resvg.wasm not found next to render.mjs');
    const wasm = fs.readFileSync(wasmPath);
    await initWasm(wasm);
    const fontBuffers = [FONT.regular, FONT.bold].map((f) => woffToSfnt(fs.readFileSync(path.join(ROOT, 'assets/fonts', f))));
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'zoom', value: scale },
      background: bg === 'transparent' ? undefined : bg,
      font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: FONT.family, cursiveFamily: FONT.family },
    });
    fs.writeFileSync(outBase + '.png', resvg.render().asPng());
    console.log(`PNG  ${outBase}.png  (@${scale}x)`);
  } catch (err) {
    console.log(`PNG skipped (${String(err?.message ?? err).split('\n')[0]})`);
  }
}
if (substituted.size) console.log(`Note: replaced symbols the font lacks: ${[...substituted].join(', ')}`);
if (warnings.length) { console.log('\nWarnings:'); for (const w of [...new Set(warnings)]) console.log('  - ' + w); }
