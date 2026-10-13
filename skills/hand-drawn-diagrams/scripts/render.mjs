#!/usr/bin/env node
// Hand-drawn diagram renderer: JSON spec -> ELK layout -> rough.js SVG (+ optional PNG).
// Usage: node scripts/render.mjs <spec.json> [--out out/name] [--no-png] [--scale 2]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rough from 'roughjs';
import ELK from 'elkjs/lib/elk.bundled.js';
import opentype from 'opentype.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

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
const warnings = [];
const warn = (m) => warnings.push(m);

const fontKey = (spec.font || 'kalam').toLowerCase();
const FONT = FONTS[fontKey] || FONTS.kalam;
const loadFont = (f) => { const b = fs.readFileSync(path.join(ROOT, 'assets/fonts', f)); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const fontRegular = loadFont(FONT.regular);
const fontBold = loadFont(FONT.bold);
const fs_ = (s) => s * FONT.scale; // font-size scaling per family

function measure(str, size, bold = false) {
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
    const lines = o.maxW ? wrap(str, size, o.maxW, bold) : String(str).split('\n');
    const lh = lineH(size);
    lines.forEach((ln, i) => {
      const by = y + i * lh + fs_(size) * 0.95;
      const deco = o.underline ? ' text-decoration="underline"' : '';
      svgParts.push(`<text x="${x}" y="${by.toFixed(1)}" font-size="${fs_(size).toFixed(1)}" text-anchor="${anchor}" fill="${o.color ?? INK}"${bold ? ' font-weight="700"' : ''}${deco}>${esc(ln)}</text>`);
    });
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
  const frameH = Math.max(dev.minH, dev.top + content + dev.pad + 22);
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
const edges = (spec.edges || []).map((e, i) => ({ ...e, _id: `e${i}`, _from: resolveEnd(e.from, 'from'), _to: resolveEnd(e.to, 'to') })).filter((e) => e._from && e._to);

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

const elk = new ELK();
const laid = await elk.layout(graph);

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
for (const g of groups) {
  const p = groupPos.get(g.id); if (!p) continue;
  const x = OX + p.x, y = OY + p.y;
  D.rect(x, y, p.width, p.height, { r: 16, dashed: true, roughness: 0.8, strokeWidth: 1.4, stroke: '#868e96', fill: g.color ? fillOf(g.color) : undefined, fillStyle: g.color ? 'solid' : undefined });
  if (g.label) D.text(x + 18, y + 12, g.label, { size: 17, bold: true, anchor: 'start', color: '#495057' });
}
for (const n of nodes) if (pos.has(n.id)) drawNode(n);
drawEdges();

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
    const { chromium } = await import('playwright');
    let browser;
    try { browser = await chromium.launch(); } catch (e) {
      // version mismatch between playwright and installed browsers: use any Chromium we can find
      const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(process.env.HOME || '', '.cache/ms-playwright')].filter(Boolean);
      const cands = [];
      for (const r of roots) { try { for (const d of fs.readdirSync(r)) for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) { const f = path.join(r, d, sub); if (fs.existsSync(f)) cands.push(f); } } catch {} }
      for (const bin of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) if (fs.existsSync(bin)) cands.push(bin);
      if (!cands.length) throw e;
      browser = await chromium.launch({ executablePath: cands[0] });
    }
    const page = await browser.newPage({ viewport: { width: W_, height: H_ }, deviceScaleFactor: scale });
    await page.setContent(`<html><body style="margin:0;background:${bg === 'transparent' ? 'transparent' : bg}">${svg}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    await page.locator('svg').screenshot({ path: outBase + '.png', omitBackground: bg === 'transparent' });
    await browser.close();
    console.log(`PNG  ${outBase}.png  (@${scale}x)`);
  } catch (err) {
    console.log(`PNG skipped (Playwright/Chromium not available: ${err.message.split('\n')[0]})`);
  }
}
if (warnings.length) { console.log('\nWarnings:'); for (const w of [...new Set(warnings)]) console.log('  - ' + w); }
