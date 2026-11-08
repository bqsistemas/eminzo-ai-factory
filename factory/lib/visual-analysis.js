// The visual check's pure core: no browser, no I/O. It reads the adapter block
// `config.visual`, expands the matrix, finds Chrome, analyzes a serialized snapshot
// (boxes and computed styles) and formats round-N/visual.md. Node 20 ESM.
//
// Snapshot element: { i, p (parent index, -1 at the root), sel, x, y, w, h, sw, cw,
// ox (overflow-x), to (text-overflow), color, tf (-webkit-text-fill-color), bg, bgImg, op, fs,
// fw, text, mark, dis, ign (the closest data-visual-ignore value: space or comma separated
// overflow|contrast|overlap) }.

const PER_TYPE_CAP = 10;
const DEFAULTS = Object.freeze({
  pages: ['/'], viewports: [1024], max_points: 48, ready_timeout_ms: 30000, page_timeout_ms: 15000,
  budget_ms: 120000, settle_ms: 300,
});

/** A color computed by the browser as {r,g,b,a}, or null when it is not a format we read. */
export function parseColor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(text);
  if (m) {
    const a = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  m = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/.exec(text);
  if (m) {
    const a = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
    return { r: Math.round(m[1] * 255), g: Math.round(m[2] * 255), b: Math.round(m[3] * 255), a };
  }
  return null;
}

const channel = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast ratio of two opaque colors. */
export function contrastRatio(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const over = (top, below) => ({
  r: top.r * top.a + below.r * (1 - top.a),
  g: top.g * top.a + below.g * (1 - top.a),
  b: top.b * top.a + below.b * (1 - top.a),
});
const rounded = ({ r, g, b }) => ({ r: Math.round(r), g: Math.round(g), b: Math.round(b) });

const ignores = (e, check) => String(e.ign ?? '').split(/[\s,]+/).includes(check);

/**
 * The opaque color behind element `index`. A heuristic on purpose: it walks the ancestor
 * chain only, so an overlay, a sibling or a pseudo-element painted behind the text is not
 * seen (use data-visual-ignore="contrast" for those). It is: its own and its ancestors' translucent
 * backgrounds composited, on a white canvas. null when a background image or gradient
 * sits in the way (the real color is unknown, so no verdict).
 */
export function effectiveBackground(els, index) {
  const layers = [];
  for (let at = index; at >= 0 && els[at]; at = els[at].p) {
    const e = els[at];
    if (e.bgImg) return null;
    const c = parseColor(e.bg);
    if (c && c.a > 0) {
      layers.push(c);
      if (c.a >= 1) break;
    }
  }
  let acc = { r: 255, g: 255, b: 255 };
  for (const layer of layers.reverse()) acc = over(layer, acc);
  return rounded(acc);
}

const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const isLarge = (fs, fw) => fs >= 24 || (fs >= 18.66 && fw >= 700);

function cap(list, type) {
  if (list.length <= PER_TYPE_CAP) return list;
  const rest = list.length - PER_TYPE_CAP;
  return [...list.slice(0, PER_TYPE_CAP), { type, selector: '', detail: `${rest} more ${type} findings not shown` }];
}

function overflowFindings(els) {
  const out = [];
  for (const e of els) {
    // w <= 2 is the visually-hidden idiom (a 1px clipped box): intentional, not a defect.
    if (ignores(e, 'overflow')) continue;
    if ((e.ox === 'hidden' || e.ox === 'clip') && e.w > 2 && e.cw > 0 && e.sw > e.cw + 1 && e.to !== 'ellipsis') {
      out.push({ type: 'overflow', selector: e.sel, detail: `scrollWidth ${e.sw} > clientWidth ${e.cw} (overflow-x ${e.ox})` });
    }
  }
  return cap(out, 'overflow');
}

function pageScrollFinding(snapshot) {
  const vw = snapshot.viewport.w;
  if (!(snapshot.doc.sw > vw + 1)) return [];
  const els = snapshot.els;
  // html (parent -1) and body (parent html) propagate overflow to the viewport; they do not clip.
  const clips = (e) => {
    for (let at = e.p; at >= 0; at = els[at].p) {
      const a = els[at];
      if (a.p >= 0 && els[a.p].p >= 0 && a.ox !== 'visible') return true;
    }
    return false;
  };
  const outside = els.filter((e) => e.w > 0 && e.h > 0 && e.x + e.w > vw + 1 && !clips(e));
  const names = outside.slice(0, 5).map((e) => `\`${e.sel}\` right edge ${Math.round(e.x + e.w)}`);
  return [{
    type: 'page-scroll', selector: 'html',
    detail: `document scrollWidth ${snapshot.doc.sw} > viewport ${vw}${names.length ? `; sticks out: ${names.join(', ')}` : ''}`,
  }];
}

function contrastFindings(els) {
  const out = [];
  els.forEach((e, index) => {
    if (!e.text || e.dis || ignores(e, 'contrast')) return;
    if (e.w <= 2 || e.h <= 2) return; // visually-hidden idiom
    // -webkit-text-fill-color paints the glyphs when it is set, whatever `color` says.
    const fg = parseColor(e.tf) ?? parseColor(e.color);
    if (!fg) return;
    const bg = effectiveBackground(els, index);
    if (!bg) return;
    let opacity = 1;
    for (let at = index; at >= 0 && els[at]; at = els[at].p) opacity *= Number.isFinite(els[at].op) ? els[at].op : 1;
    if (fg.a * opacity < 0.05) return; // invisible text: no contrast to judge
    const solid = rounded(over({ ...fg, a: fg.a * opacity }, bg));
    const ratio = contrastRatio(solid, bg);
    const need = isLarge(e.fs, e.fw) ? 3 : 4.5;
    if (ratio < need) {
      out.push({ type: 'contrast', selector: e.sel, detail: `${ratio.toFixed(2)}:1 < ${need}:1 (text ${hex(solid)} on ${hex(bg)}, ${e.fs}px)` });
    }
  });
  return cap(out, 'contrast');
}

function contains(els, outer, inner) {
  for (let at = inner.p; at >= 0 && els[at]; at = els[at].p) if (at === outer.i) return true;
  return false;
}

function overlapFindings(els) {
  const marked = els.filter((e) => e.mark && e.w > 0 && e.h > 0);
  const out = [];
  for (let a = 0; a < marked.length; a++) {
    for (let b = a + 1; b < marked.length; b++) {
      const [p, q] = [marked[a], marked[b]];
      if (contains(els, p, q) || contains(els, q, p) || ignores(p, 'overlap') || ignores(q, 'overlap')) continue;
      const w = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const h = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      if (w > 1 && h > 1) out.push({ type: 'overlap', selector: p.sel, detail: `overlaps \`${q.sel}\` by ${Math.round(w)}x${Math.round(h)}px` });
    }
  }
  return cap(out, 'overlap');
}

function motionFindings(snapshot) {
  if (!snapshot.reducedMotion) return [];
  return cap((snapshot.anims ?? []).map((a) => ({
    type: 'motion', selector: a.sel, detail: `CSS animation \`${a.name}\` still running with prefers-reduced-motion: reduce`,
  })), 'motion');
}

/** All findings of one snapshot: page scroll, overflow, contrast, overlap and motion. */
export function analyzeSnapshot(snapshot) {
  const els = snapshot.els ?? [];
  return [
    ...pageScrollFinding({ ...snapshot, els }),
    ...overflowFindings(els),
    ...contrastFindings(els),
    ...overlapFindings(els),
    ...motionFindings(snapshot),
  ];
}

/** Notes about a snapshot the analysis could not fully cover. */
export function snapshotNotes(snapshot) {
  return snapshot.truncated
    ? ['element cap reached: only the first elements of the page were analyzed (Shadow DOM and iframes are never walked)']
    : [];
}

/**
 * The status of a run from its per-point results ({findings, rendered}). ERROR when no page
 * rendered at all (the check could not look); FAIL when a point produced findings, a page
 * that fails to load among passing ones included; PASS otherwise.
 */
export function overallStatus(results) {
  if (!results.length || !results.some((r) => r.rendered)) return 'ERROR';
  return results.some((r) => r.findings.length) ? 'FAIL' : 'PASS';
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const positiveInts = (v) => Array.isArray(v) && v.length > 0 && v.every((n) => Number.isInteger(n) && n > 0);

/**
 * The adapter's `visual` block with defaults, or an error naming what is wrong.
 *
 *   start, ready_url ({port} is the job's port), pages, viewports, locales, themes,
 *   fixture {url, file}, locale (how to apply a locale: {param}, {header: true} or
 *   {json: {url, key}}), theme (how to apply a theme: {media} or {attribute}),
 *   max_points, ready_timeout_ms, page_timeout_ms, budget_ms, settle_ms.
 */
export function validateVisualConfig(raw) {
  const fail = (msg) => { throw new Error(`factory/config.json visual: ${msg}`); };
  if (!isPlainObject(raw)) fail('must be an object');
  if (typeof raw.start !== 'string' || !raw.start.trim()) fail('start must be a command string');
  if (typeof raw.ready_url !== 'string' || !/^https?:\/\//.test(raw.ready_url)) fail('ready_url must be an http(s) URL (use {port})');
  const cfg = { ...DEFAULTS, ...raw };
  if (!Array.isArray(cfg.pages) || !cfg.pages.length || !cfg.pages.every((p) => typeof p === 'string' && p.startsWith('/'))) {
    fail('pages must be a non-empty list of paths starting with "/"');
  }
  if (!positiveInts(cfg.viewports)) fail('viewports must be a non-empty list of positive integers (px)');
  for (const key of ['max_points', 'ready_timeout_ms', 'page_timeout_ms', 'budget_ms', 'settle_ms']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < (key === 'settle_ms' ? 0 : 1)) fail(`${key} must be an integer`);
  }
  for (const key of ['locales', 'themes']) {
    if (raw[key] === undefined) cfg[key] = [];
    else if (!Array.isArray(cfg[key]) || !cfg[key].every((v) => typeof v === 'string' && v)) fail(`${key} must be a list of strings`);
  }
  if (cfg.locales.length) {
    const l = cfg.locale;
    const ok = isPlainObject(l) && (
      (typeof l.param === 'string' && l.param) || l.header === true
      || (isPlainObject(l.json) && typeof l.json.url === 'string' && typeof l.json.key === 'string')
    );
    if (!ok && (cfg.locales.length > 1 || l !== undefined)) fail('locale must say how to apply locales: {"param": name}, {"header": true} or {"json": {"url", "key"}}');
    if (!ok) cfg.locales = [];
  }
  if (cfg.themes.length) {
    const t = cfg.theme;
    const ok = isPlainObject(t) && (t.media === 'prefers-color-scheme' || (typeof t.attribute === 'string' && t.attribute));
    if (!ok && (cfg.themes.length > 1 || t !== undefined)) fail('theme must say how to apply themes: {"media": "prefers-color-scheme"} or {"attribute": name}');
    if (!ok) cfg.themes = [];
  }
  if (cfg.fixture !== null && cfg.fixture !== undefined) {
    if (!isPlainObject(cfg.fixture) || typeof cfg.fixture.url !== 'string' || typeof cfg.fixture.file !== 'string') fail('fixture must be null or {"url", "file"}');
  } else cfg.fixture = null;
  return cfg;
}

/** The points to visit: pages x viewports x locales x themes, cut at max_points. */
export function buildMatrix(cfg) {
  const points = [];
  for (const page of cfg.pages) {
    for (const viewport of cfg.viewports) {
      for (const locale of cfg.locales.length ? cfg.locales : [null]) {
        for (const theme of cfg.themes.length ? cfg.themes : [null]) points.push({ page, viewport, locale, theme });
      }
    }
  }
  return { points: points.slice(0, cfg.max_points), total: points.length, truncated: points.length > cfg.max_points };
}

/** The system Chrome or Chromium: CHROME_PATH first, then the common install paths. */
export function findChrome({ env = process.env, exists, platform = process.platform }) {
  const common = platform === 'darwin'
    ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
    : [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/snap/bin/chromium', '/usr/bin/microsoft-edge',
    ];
  // FACTORY_VISUAL_NO_SYSTEM_CHROME is a test seam: only CHROME_PATH counts.
  const candidates = env.FACTORY_VISUAL_NO_SYSTEM_CHROME ? [env.CHROME_PATH] : [env.CHROME_PATH, ...common];
  for (const path of candidates) if (path && exists(path)) return path;
  return null;
}

const pointLabel = (p) => [p.page, `${p.viewport}px`, p.locale, p.theme].filter((v) => v !== null && v !== undefined).join(' · ');

/** round-N/visual.md. The first line is the status; findings are grouped per matrix point. */
export function formatReport({ status, reason, matrix, results = [], notes = [] }) {
  const lines = [`VISUAL: ${status}`, ''];
  if (reason) lines.push(`Reason: ${reason}`, '');
  if (matrix) {
    const dirty = results.filter((r) => r.findings.length);
    lines.push(`Matrix: ${matrix.points.length} of ${matrix.total} points checked${matrix.truncated ? ' (cut at max_points)' : ''}; ${dirty.length} with findings.`, '');
  }
  for (const note of notes) lines.push(`Note: ${note}`);
  if (notes.length) lines.push('');
  for (const r of results) {
    if (!r.findings.length) continue;
    lines.push(`## ${pointLabel(r.point)}`, '');
    for (const f of r.findings) lines.push(f.selector ? `- ${f.type} \`${f.selector}\`: ${f.detail}` : `- ${f.type}: ${f.detail}`);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** PASS, FAIL, SKIPPED or ERROR from the first line of a visual.md, or null when it is not one. */
export function visualStatus(text) {
  const m = /^VISUAL: (PASS|FAIL|SKIPPED|ERROR)\s*$/.exec(String(text ?? '').replace(/^﻿/, '').split(/\r?\n/, 1)[0]);
  return m ? m[1] : null;
}
