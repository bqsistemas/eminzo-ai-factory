import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import { STAGE_COLUMNS, laneTone } from '../factory/activity.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const html = dashboardSource();
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const fnBody = (name) => script.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
const rawRule = (selector) => css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1];
const rule = (selector) =>
  css.match(new RegExp(`(?:^|[}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1];
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

test('AC-1: laneTone groups every stage into a fixed tone and falls back to pending', () => {
  const expected = {
    intake: 'pending', 'needs-info': 'pending', 'spec-review': 'parked',
    spec: 'active', build: 'active', gate: 'active',
    review: 'review', approve: 'review', merging: 'review', 'awaiting-merge': 'review',
    merged: 'done', 'needs-human': 'parked', rejected: 'muted',
  };
  for (const [stage] of STAGE_COLUMNS) assert.equal(laneTone(stage), expected[stage], stage);
  for (const v of ['shipping-to-mars', '<img src=x onerror=alert(1)>', null, undefined, 42]) {
    assert.equal(laneTone(v), 'pending');
  }
});

test('AC-2: navy theme variables, a light theme, accent per tone', () => {
  const root = rawRule(':root, :root\\[data-theme="navy"\\]');
  assert.ok(root, 'navy rule');
  assert.match(root, /color-scheme:\s*dark/);
  assert.match(rawRule(':root\\[data-theme="light"\\]') ?? '', /color-scheme:\s*light/);
  const bg = root.match(/--bg:\s*(#[0-9a-f]{6})/i)[1];
  const lo = rgb('#0b1220'), hi = rgb('#111a2e'), v = rgb(bg);
  v.forEach((c, i) => assert.ok(c >= lo[i] && c <= hi[i], `--bg channel ${i}`));
  assert.match(root, /--muted:\s*#94a3b8/i);
  const accents = { active: '#1e6bff', review: '#8b5cf6', done: '#22c55e', parked: '#f87171' };
  for (const [tone, color] of Object.entries(accents)) {
    assert.match(rule(`.col.tone-${tone}`) ?? '', new RegExp(`--accent:\\s*${color}`, 'i'), tone);
  }
  for (const tone of ['pending', 'muted']) assert.match(rule(`.col.tone-${tone}`) ?? '', /--accent:/, tone);
});

test('AC-3: column and card shapes plus dot, count and done-check rules', () => {
  const col = rule('.col');
  const radius = Number(col.match(/border-radius:\s*(\d+)px/)[1]);
  assert.ok(radius >= 14 && radius <= 16);
  assert.match(col, /border:\s*1px/);
  assert.match(rule('.card'), /border-radius:\s*12px/);
  for (const s of ['.dot', '.count', '.done-check']) assert.ok(rule(s) || css.includes(`${s}`), s);
  assert.ok(rule('.count'));
  assert.ok(rule('.done-check'));
});

test('AC-4: render() uses laneTone and the new header markup', () => {
  assert.match(script, /import\s*\{[^}]*\blaneTone\b[^}]*\}\s*from\s*['"]\.\/activity\.js['"]/);
  const body = fnBody('render');
  assert.match(body, /tone-\$\{laneTone\(key\)\}/);
  assert.match(body, /class="dot" aria-hidden="true"/);
  assert.match(body, /class="lane-title"/);
  assert.match(body, /class="count">\$\{list\.length\}/);
  assert.match(body, /STAGE_COLUMNS/);
  assert.match(body, /known\.has\(j\.stage\) \? j\.stage : 'intake'/);
});

test('AC-5: card() keeps its content and only checks merged cards', () => {
  const body = fnBody('card');
  for (const s of ['linksHtml(', 'agentsHtml(job)', 'roundChipsHtml(', 'costTimeHtml(job, undefined, T)', 'esc(job.note)', 'ago(job.updated)',
    'T.hintNeedsHumanPr', 'T.hintNeedsHumanNoPr', 'T.hintAwaitingMerge', 'T.hintNeedsInfo', '/eminzo-factory rework']) {
    assert.ok(body.includes(s), s);
  }
  assert.match(body, /job\.stage === 'merged'[^\n]*done-check[^\n]*aria-hidden="true"/);
  assert.equal(body.match(/done-check/g).length, 1);
});

test('AC-6: no reference sample content leaks into card() or render()', () => {
  for (const name of ['card', 'render']) {
    const body = fnBody(name);
    for (const bad of ['%', 'P1', 'P2', 'P3', 'T-0', '⋯', '<progress']) assert.ok(!body.includes(bad), `${name} has ${bad}`);
    assert.doesNotMatch(body, /class="[^"]*\b(priority|progress)\b/);
    assert.doesNotMatch(body, />\s*\+\s*</);
  }
});

test('AC-7: responsive, scroll, focus and i18n are intact', () => {
  assert.match(css, /@media \(max-width: 640px\)\s*\{[^@]*\.board\s*\{[^}]*flex-direction:\s*column/);
  assert.ok(rule('.col.quiet'));
  assert.match(rule('.board'), /overflow-x:\s*auto/);
  assert.match(rule('.card .open:focus-visible'), /outline/);
  const i18n = JSON.parse(html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/)[1]);
  const keys = Object.keys(i18n.en).sort();
  const existingKeys = ['demoLink', 'emptyBoard', 'hintAwaitingMerge', 'hintNeedsHumanNoPr',
    'hintNeedsHumanPr', 'hintNeedsInfo', 'notWritten', 'olderMerged', 'parkedHuman', 'parkedInfo', 'statAgents', 'statCost',
    'statJobs', 'statRunning', 'statusLive', 'themeToLight', 'themeToNavy'];
  for (const key of existingKeys) assert.ok(keys.includes(key), `missing existing translation ${key}`);
  for (const l of ['es', 'pt']) assert.deepEqual(Object.keys(i18n[l]).sort(), keys);
});

// --- theme toggle ---------------------------------------------------------------

const initScript = html.match(/<script id="theme-init">([\s\S]*?)<\/script>/)?.[1];

// Runs the real head script against a fake browser.
function boot({ stored, osLight = false, storageThrows = false, setThrows = false }) {
  const attrs = {};
  const writes = [];
  const win = {
    matchMedia: (q) => ({ matches: osLight && q.includes('light') }),
  };
  Object.defineProperty(win, 'localStorage', {
    get() {
      if (storageThrows) throw new Error('SecurityError');
      return {
        getItem: () => stored ?? null,
        setItem: (k, v) => { if (setThrows) throw new Error('QuotaExceeded'); writes.push([k, v]); },
      };
    },
  });
  const document = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k] ?? null } };
  win.window = win;
  win.document = document;
  vm.runInNewContext(initScript, win);
  return { win, attrs, writes };
}

test('theme: the head script runs before the style and the board', () => {
  assert.ok(initScript);
  assert.ok(html.indexOf('id="theme-init"') < html.indexOf('<style>'));
  assert.ok(html.indexOf('id="theme-init"') < html.indexOf('id="board"'));
});

test('theme: first visit follows the OS setting', () => {
  assert.equal(boot({ osLight: true }).attrs['data-theme'], 'light');
  assert.equal(boot({ osLight: false }).attrs['data-theme'], 'navy');
});

test('theme: the persisted choice wins over the OS default', () => {
  assert.equal(boot({ stored: 'navy', osLight: true }).attrs['data-theme'], 'navy');
  assert.equal(boot({ stored: 'light', osLight: false }).attrs['data-theme'], 'light');
  assert.equal(boot({ stored: 'purple', osLight: true }).attrs['data-theme'], 'light', 'junk value is ignored');
});

test('theme: set() applies and stores the choice; junk is rejected', () => {
  const { win, attrs, writes } = boot({ osLight: false });
  win.factoryTheme.set('light');
  assert.equal(attrs['data-theme'], 'light');
  assert.deepEqual(writes, [['factory-theme', 'light']]);
  win.factoryTheme.set('<img>');
  assert.equal(attrs['data-theme'], 'light');
  assert.equal(win.factoryTheme.current(), 'light');
});

test('theme: an unavailable localStorage does not break the page', () => {
  const a = boot({ storageThrows: true, osLight: true });
  assert.equal(a.attrs['data-theme'], 'light');
  a.win.factoryTheme.set('navy');
  assert.equal(a.attrs['data-theme'], 'navy');
  const b = boot({ setThrows: true });
  b.win.factoryTheme.set('light');
  assert.equal(b.win.factoryTheme.current(), 'light');
});

test('theme: the toggle has an accessible, translated name and sits in the header', () => {
  const header = html.match(/<header class="top">([\s\S]*?)<\/header>/)[1];
  assert.match(header, /<button[^>]*id="theme-toggle"[^>]*type="button"/);
  assert.match(script, /setAttribute\('aria-label', label\)/);
  const i18n = JSON.parse(html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/)[1]);
  for (const l of ['en', 'es', 'pt']) {
    assert.ok(i18n[l].themeToLight && i18n[l].themeToNavy, l);
  }
  assert.ok(rule('.theme-toggle:focus-visible') ?? css.includes('.theme-toggle:focus-visible'));
});
