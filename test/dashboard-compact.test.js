import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { splitMerged, olderMergedHtml } from '../factory/activity.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const html = dashboardSource();
const demo = JSON.parse(await readFile(new URL('../factory/demo/board.json', import.meta.url), 'utf8'));
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const i18n = JSON.parse(html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/)[1]);
const renderBody = script.match(/function render\(\)\s*\{([\s\S]*?)\n\}/)[1];

// Split the stylesheet into top-level text and the contents of @media blocks.
const media = [];
const top = css.replace(/@media[^{]*\{((?:[^{}]*\{[^}]*\})*[^{}]*)\}/g, (m, inner) => { media.push({ head: m.slice(0, m.indexOf('{')), inner }); return ''; });
const decls = (src, selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...src.matchAll(new RegExp(`(?:^|[}\\s,])${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(';');
};
const rule = (s) => decls(top, s);
const mobile = media.find((m) => /max-width:\s*640px/.test(m.head)).inner;

const job = (id, extra = {}) => ({ id, title: `T ${id}`, stage: 'merged', ...extra });

test('AC-1: i18n has no columns, shares keys with olderMerged, render uses STAGE_COLUMNS labels', () => {
  const keys = Object.keys(i18n.en).sort();
  assert.ok(keys.includes('olderMerged'));
  for (const l of ['en', 'es', 'pt']) {
    assert.ok(!('columns' in i18n[l]));
    assert.deepEqual(Object.keys(i18n[l]).sort(), keys);
    assert.match(i18n[l].olderMerged, /\{n\}/);
  }
  assert.doesNotMatch(renderBody, /T\.columns/);
  assert.match(script, /STAGE_COLUMNS\.map\(\(\[key, label\]\)/);
  assert.match(renderBody, /aria-label="\$\{esc\(label\)\}"/);
  assert.match(renderBody, /class="lane-title">\$\{label\}/);
});

test('AC-2: splitMerged orders by recency and splits', () => {
  const jobs = [
    job('nodate'),
    job('b', { finished: '2026-01-02T00:00:00Z' }),
    job('c', { updated: '2026-01-04T00:00:00Z', finished: 'junk' }),
    job('a', { finished: '2026-01-05T00:00:00Z', updated: '2026-01-01T00:00:00Z' }),
    job('d', { finished: '2026-01-03T00:00:00Z' }),
  ];
  const { recent, older } = splitMerged(jobs);
  assert.deepEqual(recent.map((j) => j.id), ['a', 'c', 'd']);
  assert.deepEqual(older.map((j) => j.id), ['b', 'nodate']);
  assert.deepEqual(splitMerged(jobs.slice(0, 2)).older, []);
  assert.equal(splitMerged(jobs, 1).recent.length, 1);
  assert.deepEqual(splitMerged(null), { recent: [], older: [] });
});

test('AC-3: olderMergedHtml renders escaped one-line rows', () => {
  const out = olderMergedHtml([job('x1', { title: 'One' }), { id: 'x2' }], '+2 older', false);
  assert.equal(out.match(/<details class="older">/g).length, 1);
  assert.doesNotMatch(out, /<details[^>]* open/);
  assert.match(out, /<summary>\+2 older<\/summary>/);
  const rows = [...out.matchAll(/<button type="button" class="row" data-id="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['x1', 'x2']);
  assert.match(out, /x2<\/span> <span class="row-title">x2</);
  assert.match(olderMergedHtml([job('x1')], 'l', true), /<details class="older" open>/);
  assert.equal(olderMergedHtml([], 'x', false), '');
  const evil = '<img src=x onerror=alert(1)>';
  const bad = olderMergedHtml([{ id: evil, title: evil }], evil, false);
  assert.ok(!bad.includes('<img'));
});

test('AC-4: dashboard wires the older group, row clicks and toggle capture', () => {
  assert.match(script, /import \{[^}]*\bsplitMerged\b[^}]*\bolderMergedHtml\b[^}]*\} from '\.\/activity\.js'|import \{[^}]*\bolderMergedHtml\b[^}]*\bsplitMerged\b[^}]*\} from '\.\/activity\.js'/);
  assert.match(renderBody, /splitMerged\(/);
  assert.match(renderBody, /olderMergedHtml\(older, T\.olderMerged\.replace\([^\n]*olderOpen, undefined, T\)/);
  assert.match(script, /closest\('\.card, \.row'\)/);
  assert.match(script, /addEventListener\('toggle'[\s\S]*?olderOpen = [\s\S]*?,\s*true\)/);
  assert.match(rule('.row:focus-visible'), /outline/);
  assert.match(rule('.older summary:focus-visible'), /outline/);
  assert.ok(demo.jobs.filter((j) => j.stage === 'merged').length >= 5);
});

test('AC-5: one-page layout rules', () => {
  const body = rule('body');
  assert.match(body, /display:\s*flex/);
  assert.match(body, /flex-direction:\s*column/);
  assert.match(body, /height:\s*100d?vh/);
  assert.match(body, /overflow:\s*hidden/);
  const board = rule('.board');
  assert.match(board, /overflow-x:\s*auto/);
  assert.match(board, /overflow-y:\s*hidden/);
  assert.match(board, /min-height:\s*0/);
  assert.match(rule('.lane'), /overflow-y:\s*auto/);
  assert.match(rule('.lane'), /min-height:\s*0/);
  assert.match(rule('.col'), /min-height:\s*0/);
  assert.ok(Number(rule('.col').match(/min-width:\s*(\d+)px/)[1]) <= 180);
  assert.match(decls(mobile, 'body'), /overflow:\s*(visible|auto)/);
  assert.match(decls(mobile, '.board'), /flex-direction:\s*column/);
});

test('AC-6: empty lanes collapse to a rail', () => {
  assert.match(renderBody, /list\.length \? ''\s*:\s*'quiet'/);
  assert.match(renderBody, /\$\{list\.length \? `<div class="lane">/);
  assert.match(rule('.col.quiet'), /flex:\s*0 0 auto/);
  assert.ok(Number(rule('.col.quiet').match(/[^-]width:\s*(\d+)px/)[1]) <= 48);
  assert.match(rule('.col.quiet h2'), /writing-mode:\s*vertical-rl/);
  assert.match(decls(mobile, '.col.quiet h2'), /writing-mode:\s*horizontal-tb/);
});

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('AC-7: compact sizes and AA contrast in both themes', () => {
  for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(Number(m[1]) >= 11, m[0]);
  for (const m of css.matchAll(/[;{\s]font:\s*(?:\d+\s+)?([\d.]+)px/g)) assert.ok(Number(m[1]) >= 11, m[0]);
  assert.match(rule('body'), /font:\s*13px/);
  const pad = rule('.card').match(/padding:\s*(\d+)px\s+(\d+)px/);
  assert.ok(Number(pad[1]) <= 8 && Number(pad[2]) <= 10);
  const themes = {
    navy: css.match(/:root, :root\[data-theme="navy"\]\s*\{([^}]*)\}/)[1],
    light: css.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)[1],
  };
  for (const [name, block] of Object.entries(themes)) {
    const v = (k) => block.match(new RegExp(`${k}:\\s*(#[0-9a-fA-F]{6})`))[1];
    const pairs = [];
    for (const fg of ['--ink', '--muted']) for (const bg of ['--bg', '--col', '--panel']) pairs.push([fg, bg]);
    pairs.push(['--pass', '--pass-bg'], ['--changes', '--changes-bg'], ['--alert', '--alert-bg'], ['--alert', '--col']);
    for (const [fg, bg] of pairs) assert.ok(ratio(v(fg), v(bg)) >= 4.5, `${name} ${fg}/${bg}`);
  }
});

test('AC-8: closed drawer casts no shadow', () => {
  assert.doesNotMatch(rule('.drawer'), /box-shadow:\s+(?!none)/);
  assert.match(rule('.drawer.open'), /box-shadow:[^;]*var\(--shadow\)/);
});
