import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CANVAS_STAGES, jobsNewestFirst, pickJobId, stageCardsHtml, taskHeaderHtml } from '../factory/pipeline-canvas.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const html = dashboardSource();
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const baseCss = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '');
const KEYS = CANVAS_STAGES.map(({ key }) => key);
const rule = (source, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(' ');
};

test('AC-1: jobsNewestFirst sorts numerically descending without mutating', () => {
  const input = [{ id: '001-a' }, { id: '051-b' }, { id: '010-c' }, { id: '1000-d' }];
  const copy = [...input];
  assert.deepEqual(jobsNewestFirst(input).map((j) => j.id), ['1000-d', '051-b', '010-c', '001-a']);
  assert.deepEqual(input, copy);
  assert.ok(input.every((job, i) => job === copy[i]));
  const mixed = [{ id: 'x' }, { id: 'no-prefix', issue: 5 }, { id: '003-a' }];
  assert.deepEqual(jobsNewestFirst(mixed).map((j) => j.id), ['no-prefix', '003-a', 'x']);
  assert.deepEqual(jobsNewestFirst(null), []);
  assert.deepEqual(jobsNewestFirst('x'), []);
});

test('AC-2: pickJobId keeps current, else newest, else null; dashboard wiring', () => {
  const jobs = [{ id: '001-a' }, { id: '051-b' }, { id: '010-c' }];
  assert.equal(pickJobId(jobs, '010-c'), '010-c');
  assert.equal(pickJobId(jobs, 'gone'), '051-b');
  assert.equal(pickJobId(jobs, null), '051-b');
  assert.equal(pickJobId([], 'x'), null);
  assert.match(html, /pickJobId\(/);
  assert.match(html, /jobsNewestFirst\(/);
  assert.doesNotMatch(html, /jobs\[0\]\?\.id/);
  assert.doesNotMatch(html, /jobs\.sort\(/);
  assert.doesNotMatch(html, /board\.jobs\.sort\(/);
});

test('AC-3: header title has escaped tooltip and nowrap truncation CSS', () => {
  const out = taskHeaderHtml({ id: '044-x', issue: 44, title: 'Track codex' });
  assert.match(out, /<h3 class="pipeline-task-title" title="#44 Track codex"/);
  const evil = taskHeaderHtml({ id: '1-x', issue: 1, title: '<img src=x onerror=alert(1)>' });
  assert.match(evil, /title="[^"]*&lt;img/);
  assert.doesNotMatch(evil, /<img/);
  const title = rule(baseCss, '.pipeline-task-title');
  assert.match(title, /white-space:\s*nowrap/);
  assert.match(title, /overflow:\s*hidden/);
  assert.match(title, /text-overflow:\s*ellipsis/);
  assert.match(rule(baseCss, '.pipeline-task-header'), /flex-wrap:\s*nowrap/);
  assert.match(rule(baseCss, '.pipeline-task-meta'), /flex-wrap:\s*nowrap/);
});

test('AC-4: chevron cards use clip-path on pseudo-elements and keep stage colors', () => {
  assert.match(css, /\.pipeline-node::(before|after)[^{]*\{[^}]*clip-path:\s*polygon\(/);
  for (const k of KEYS) assert.match(css, new RegExp(`\\.pipeline-node\\[data-stage="${k}"\\][^{]*\\{[^}]*var\\(--stage-${k}\\)`));
  const out = stageCardsHtml({ stage: 'build' }, 'build');
  assert.equal([...out.matchAll(/<button /g)].length, 7);
  assert.deepEqual([...out.matchAll(/<span class="pipeline-arrow" data-stage="(\w+)"/g)].map((m) => m[1]), KEYS.slice(1));
});

test('AC-5: glow uses drop-shadow, not box-shadow, on active and pressed cards', () => {
  assert.match(css, /\.pipeline-node\[data-state="active"\][^{]*\{[^}]*drop-shadow\(/);
  assert.match(css, /\.pipeline-node\[aria-pressed="true"\][^{]*\{[^}]*drop-shadow\(/);
  assert.doesNotMatch(css, /\[aria-pressed="true"\][^{]*\{[^}]*box-shadow/);
  assert.match(css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n  \}/)[0], /\.pipeline-node\[data-state="active"\][^{]*\{[^}]*animation:\s*none/);
});

test('AC-6: details use two columns, one on narrow screens', () => {
  assert.match(rule(baseCss, '.pipeline-fields'), /grid-template-columns:\s*repeat\(2, auto minmax\(0, 1fr\)\)/);
  const narrow = css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n  \}/)[0];
  assert.match(narrow, /\.pipeline-fields\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)/);
});

test('AC-7: cards are low, nowrap and never truncate the status text', () => {
  assert.match(rule(baseCss, '.pipeline-badge'), /white-space:\s*nowrap/);
  const node = rule(baseCss, '.pipeline-node');
  assert.ok(Number(node.match(/min-width:\s*(\d+)px/)[1]) >= 92);
  const pad = node.match(/padding:\s*(\d+)px/);
  assert.ok(pad && Number(pad[1]) <= 6);
  assert.match(rule(baseCss, '.pipeline-canvas'), /overflow-x:\s*auto/);
  assert.ok(stageCardsHtml({ stage: 'merged' }, 'build', { pipelineComplete: 'Completada' }).includes('Completada'));
});

test('AC-8: dashboard has no inline style attributes', () => {
  assert.doesNotMatch(html, /\sstyle=/);
});
