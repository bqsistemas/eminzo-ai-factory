import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dashboardSource } from './helpers/dashboard-source.js';

const html = dashboardSource();
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const i18n = JSON.parse(html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/)[1]);
const header = html.match(/<header class="top">([\s\S]*?)<\/header>/)[1];

const media = [];
const top = css.replace(/@media[^{]*\{((?:[^{}]*\{[^}]*\})*[^{}]*)\}/g, (m, inner) => { media.push({ head: m.slice(0, m.indexOf('{')), inner }); return ''; });
const mobile = media.find((m) => /max-width:\s*640px/.test(m.head)).inner;
const decls = (src, selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...src.matchAll(new RegExp(`(?:^|[}\\s,])${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(';');
};
const rule = (s) => decls(top, s);
const mrule = (s) => decls(mobile, s);
const px = (decl, prop) => { const m = decl.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*([\\d.]+)px`)); return m ? Number(m[1]) : null; };
const radius = (s) => px(rule(s), 'border-radius');
const sumPadV = (decl) => {
  const m = decl.match(/(?:^|[;\s])padding:\s*([^;]+)/);
  const p = m[1].trim().split(/\s+/).map((v) => parseFloat(v));
  return p.length === 1 ? p[0] * 2 : p[0] + (p.length === 3 ? p[2] : p[2] ?? p[0]);
};

test('AC-1: brand block follows the h1 with an inline icon and a fixed subtitle', () => {
  assert.ok(header.trimStart().startsWith('<h1>AI Software Factory</h1>'));
  assert.match(header, /<h1>AI Software Factory<\/h1>\s*<span class="brand-icon" aria-hidden="true"><svg[\s\S]*?<\/svg><\/span>/);
  assert.match(header, /<p class="brand-sub">AI Agents · GitHub Issues → Production Ready PRs<\/p>/);
  for (const bad of [/<img/, /<link/, /\sstyle=/, /\ssrc=/, /http/]) assert.doesNotMatch(header, bad);
});

test('AC-2: stat cards have icons, text order and card styling', () => {
  const stats = header.match(/<span class="stats">([\s\S]*?)<\/span>\s*<span class="top-end">/)[1];
  let last = -1;
  for (const k of ['jobs', 'running', 'agents', 'cost']) {
    assert.equal(stats.split(`id="stat-${k}"`).length, 2, k);
    const re = new RegExp(`id="stat-${k}"[^>]*><span class="ico ico-${k}" aria-hidden="true"><svg[\\s\\S]*?</svg></span><span class="txt"><span class="v">[^<]*</span><span class="l"></span></span>`);
    assert.match(stats, re, k);
    const at = stats.indexOf(`id="stat-${k}"`);
    assert.ok(at > last); last = at;
  }
  const stat = rule('.stat');
  assert.match(stat, /background:\s*var\(--panel\)/);
  assert.match(stat, /border:\s*1px solid var\(--line\)/);
  assert.ok(radius('.stat') >= 8 && radius('.stat') <= 12);
  assert.match(rule('.stat .txt'), /flex-direction:\s*column/);
  const colors = { jobs: '--ink', running: '--pass', agents: '--active', cost: '--changes' };
  for (const [k, v] of Object.entries(colors)) assert.match(rule(`.stat .ico-${k}`), new RegExp(`color:\\s*var\\(${v}\\)`), k);
  // .stat .ico (0,2,0) must not set a color that would beat or mask the accent rules.
  assert.doesNotMatch(rule('.stat .ico'), /(?:^|[;\s])color:/);
});

test('AC-3: top-end group order and matching styles', () => {
  const end = header.match(/<span class="top-end">([\s\S]*?)<\/span>\s*<\/header>|<span class="top-end">([\s\S]*)$/);
  const body = end[1] ?? end[2];
  const order = ['id="status"', 'id="theme-toggle"', 'id="theme-icon"', 'id="demo"', 'id="parked"'].map((s) => body.indexOf(s));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), String(order));
  assert.match(body, /id="demo" hidden/);
  assert.match(body, /id="parked" href="#col-needs-human" hidden/);
  const r = radius('.stat');
  for (const s of ['.theme-toggle', '.tag', '.parked']) {
    const d = rule(s);
    assert.equal(radius(s), r, s);
    assert.match(d, /background:\s*var\(--panel\)/, s);
    assert.match(d, /border:\s*1px solid/, s);
    assert.ok(px(d, 'height') <= 32, s);
  }
});

test('AC-4: statLive i18n and status dot colors', () => {
  const keys = Object.keys(i18n.en).sort();
  for (const l of ['en', 'es', 'pt']) {
    assert.match(i18n[l].statusLive, /\{ago\}/, l);
    assert.deepEqual(Object.keys(i18n[l]).sort(), keys, l);
  }
  assert.equal(i18n.es.statusLive, 'En vivo · actualizado {ago}');
  assert.match(script, /T\.statusLive\.replace\('\{ago\}'/);
  assert.doesNotMatch(script, /live · updated/);
  assert.match(decls(top, '.status::before'), /background:\s*var\(--pass\)/);
  assert.match(decls(top, '.status.off::before'), /background:\s*var\(--alert\)/);
});

test('AC-5: desktop height budget', () => {
  const t = rule('.top');
  assert.match(t, /display:\s*grid/);
  const rows = t.match(/grid-template-rows:\s*([^;]+)/)[1].trim().split(/\s+/).map((v) => parseFloat(v));
  assert.ok(rows.every(Number.isFinite));
  assert.ok(rows.reduce((a, b) => a + b, 0) <= 32);
  assert.ok(sumPadV(t) <= 8);
  for (const s of ['.stat', '.theme-toggle', '.tag', '.parked', '.brand-icon']) assert.ok(px(rule(s), 'height') <= 32, s);
  assert.ok(px(rule('.top h1'), 'line-height') + px(rule('.brand-sub'), 'line-height') <= 32);
  assert.match(rule('.stats'), /flex-wrap:\s*nowrap/);
});

test('AC-6: mobile header stays compact', () => {
  const t = mrule('.top');
  assert.match(t, /display:\s*flex/);
  assert.match(t, /flex-wrap:\s*wrap/);
  assert.ok((px(t, 'row-gap') ?? px(t, 'gap')) <= 12);
  assert.ok(sumPadV(t) <= 12);
  assert.match(mrule('.brand-sub'), /display:\s*none/);
  assert.match(mrule('.stat .ico'), /display:\s*none/);
  assert.ok(px(mrule('.stat'), 'height') <= 24);
  assert.match(mrule('.stats'), /flex-wrap:\s*wrap/);
});

test('AC-7: header rules use no literal hex colors', () => {
  const sel = /^\s*(\.top\b|\.brand-|\.stat|\.ico|\.top-end|\.status|\.theme-toggle|\.tag|\.parked)[^{]*\{([^}]*)\}/gm;
  let n = 0;
  for (const src of [top, mobile]) for (const m of src.matchAll(sel)) { n++; assert.doesNotMatch(m[2], /#[0-9a-fA-F]{3,8}\b/, m[1]); }
  assert.ok(n > 10);
});

test('hidden badges stay hidden despite their display rules', () => {
  assert.match(rule('.tag'), /display:\s*inline-flex/);
  assert.match(rule('.tag[hidden]'), /display:\s*none/);
  assert.match(rule('.parked[hidden]'), /display:\s*none/);
});

test('tablet: stats take their own full-width row at 900px and below', () => {
  const tablet = media.find((m) => /max-width:\s*900px/.test(m.head)).inner;
  assert.match(decls(tablet, '.stats'), /grid-column:\s*1 \/ -1/);
});

const themeBlocks = {
  navy: css.match(/:root,\s*:root\[data-theme="navy"\]\s*\{([^}]*)\}/)[1],
  light: css.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)[1],
};
const prop = (block, name) => (block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`)) || [])[1];
const hue = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('AC-1 (blue) hex: both themes define --brand-icon as a 6-digit hex', () => {
  for (const t of ['navy', 'light']) assert.ok(prop(themeBlocks[t], '--brand-icon'), t);
});

test('AC-1 (blue) hue: --brand-icon is a saturated blue in both themes', () => {
  const sat = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
  };
  for (const t of ['navy', 'light']) {
    const hex = prop(themeBlocks[t], '--brand-icon');
    const h = hue(hex);
    assert.ok(h >= 200 && h <= 240, `${t} hue ${h}`);
    assert.ok(sat(hex) >= 0.6, `${t} saturation ${sat(hex)}`);
  }
});

test('AC-2 (blue): --brand-icon has at least 3:1 contrast against --bg in each theme', () => {
  for (const t of ['navy', 'light']) {
    const c = contrast(prop(themeBlocks[t], '--brand-icon'), prop(themeBlocks[t], '--bg'));
    assert.ok(c >= 3, `${t} contrast ${c}`);
  }
});

test('AC-3 (blue) rule: .brand-icon colors itself with --brand-icon', () => {
  const d = rule('.brand-icon');
  assert.match(d, /color:\s*var\(--brand-icon\)/);
  assert.doesNotMatch(d, /var\(--active\)/);
});

test('AC-3 (blue) active: --active and .stat .ico-agents are unchanged', () => {
  assert.equal(prop(themeBlocks.navy, '--active'), '#1e6bff');
  assert.match(rule('.stat .ico-agents'), /color:\s*var\(--active\)/);
});
