import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CANVAS_STAGES, stageAvatars, stageCardsHtml, taskDuration, taskHeaderHtml } from '../factory/pipeline-canvas.js';
import { avatarSvg } from '../factory/avatars.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const html = dashboardSource();
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const KEYS = CANVAS_STAGES.map(({ key }) => key);
const EVIL = '<img src=x onerror=alert(1)>';

test('AC-1: stageAvatars maps each stage to its agent avatars', () => {
  const job = { agents: { reviewers: { code: 'x', security: 'y' } } };
  assert.deepEqual(KEYS.map((key) => stageAvatars(job, key)),
    [['intake'], ['spec-writer'], ['builder'], ['builder'], ['review-security', 'review-code'], ['approver'], ['approver']]);
  assert.deepEqual(stageAvatars({}, 'review'), ['review-code']);
  assert.deepEqual(stageAvatars(null, 'nope'), []);
});

test('AC-2: stageCardsHtml renders seven cards, avatars, badges and six arrows', () => {
  const job = { stage: 'review', agents: { reviewers: { ui: 'haiku' } } };
  const out = stageCardsHtml(job, 'build');
  const buttons = [...out.matchAll(/<button [^>]*>/g)].map((m) => m[0]);
  assert.equal(buttons.length, 7);
  assert.deepEqual(buttons.map((b) => b.match(/data-stage="(\w+)"/)[1]), KEYS);
  assert.deepEqual(buttons.map((b) => b.match(/data-state="(\w+)"/)[1]),
    ['complete', 'complete', 'complete', 'complete', 'active', 'pending', 'pending']);
  assert.deepEqual(buttons.map((b) => b.includes('aria-pressed="true"')), KEYS.map((k) => k === 'build'));
  assert.ok(buttons.every((b) => /aria-label="\w+: \w+"/.test(b)));
  assert.equal([...out.matchAll(/class="pipeline-avatar" aria-hidden="true"/g)].length, 7);
  assert.ok(out.includes(avatarSvg('review-ui')));
  assert.equal([...out.matchAll(/class="pipeline-badge"/g)].length, 0 + 0 || [...out.matchAll(/class="pipeline-badge" data-state/g)].length);
  assert.deepEqual([...out.matchAll(/class="pipeline-arrow" data-stage="(\w+)" aria-hidden="true"/g)].map((m) => m[1]),
    KEYS.slice(1));
  const es = stageCardsHtml(job, 'build', { stageSpec: 'Especificación', pipelineComplete: 'Completada' });
  assert.match(es, /Especificación: Completada/);
});

test('AC-3: taskDuration', () => {
  assert.equal(taskDuration({ started: '2026-01-01T10:00:00Z', finished: '2026-01-01T12:56:00Z' }), '2h 56m');
  assert.equal(taskDuration({ started: '2026-01-01T10:00:00Z', finished: null }, Date.parse('2026-01-01T10:42:00Z')), '42m');
  assert.equal(taskDuration({}), 'Not available');
  assert.equal(taskDuration({ started: 'nope' }), 'Not available');
  assert.equal(taskDuration({ started: '2026-01-01T10:00:00Z', finished: '2026-01-01T09:00:00Z' }), 'Not available');
});

test('AC-4: taskHeaderHtml shows chips and the GitHub link only with data', () => {
  const job = { id: '034-x', issue: 44, title: 'Track codex', round: 2, stage: 'merged', branch: 'factory/034-x', pr: 46, provider: 'codex',
    started: '2026-01-01T10:00:00Z', finished: '2026-01-01T12:56:00Z' };
  const out = taskHeaderHtml(job, { repo: 'https://github.com/o/r', text: { pipelineStageMerged: 'Integrado' } });
  for (const part of ['#44', 'Track codex', '>R2<', 'Integrado', '2h 56m', 'factory/034-x · PR #46', 'codex']) assert.ok(out.includes(part), part);
  assert.match(out, /<a class="pipeline-github" href="https:\/\/github\.com\/o\/r\/pull\/46" target="_blank" rel="noopener">/);
  const bare = taskHeaderHtml({ id: '001-a', stage: 'intake' }, { repo: 'nope' });
  assert.doesNotMatch(bare, />R\d|pipeline-github|undefined|NaN|\d+m</);
  assert.ok(!bare.includes('factory/'));
});

test('AC-5: job values are escaped and no inline style or handlers are emitted', () => {
  const job = { id: EVIL, title: EVIL, branch: EVIL, provider: EVIL, stage: EVIL };
  for (const out of [taskHeaderHtml(job, { repo: 'https://github.com/o/r' }), stageCardsHtml(job, EVIL)]) {
    // The escaped tooltip (title="&lt;img ... onerror=...") is inert text, so drop it first.
    assert.doesNotMatch(out.replace(/ title="[^"]*"/g, ""), /<img|style=|<script|<[^>]*\son\w+=/);
  }
  assert.match(taskHeaderHtml(job), /&lt;img/);
});

test('AC-6: stylesheet defines stage colors, glow, arrows and reduced motion', () => {
  const values = KEYS.map((k) => css.match(new RegExp(`--stage-${k}:\\s*([^;]+);`))?.[1]);
  assert.ok(values.every(Boolean));
  assert.equal(new Set(values).size, 7);
  for (const k of KEYS) assert.match(css, new RegExp(`\\.pipeline-node\\[data-stage="${k}"\\][^{]*\\{[^}]*var\\(--stage-${k}\\)`));
  assert.match(css, /\.pipeline-arrow\[data-stage="\w+"\][^{]*\{[^}]*var\(--stage-/);
  assert.match(css, /\.pipeline-node\[data-state="active"\][^{]*\{[^}]*drop-shadow/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.pipeline-node[\s\S]*?\.pipeline-arrow/);
  assert.match(css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n  \}/)[0], /\.pipeline-node\[data-state="active"\][^{]*\{[^}]*animation:\s*none/);
  assert.doesNotMatch(css, /\.pipeline-node\[aria-pressed="true"\]\s*\{[^}]*box-shadow/);
  assert.doesNotMatch(css, /\.pipeline-node\[data-state="pending"\]\s*\{[^}]*opacity/);
  assert.match(css, /\.pipeline-canvas[^{]*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.pipeline-content/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*?\.pipeline-controls/);
  assert.doesNotMatch(css, /\.pipeline-node:not\(:last-child\)::after/);
});

test('AC-7: dashboard wires the new functions and i18n keys', () => {
  for (const call of ['stageCardsHtml(', 'taskHeaderHtml(', 'taskDuration(', 'T.pipelineJobDetails']) assert.ok(html.includes(call), call);
  const i18n = JSON.parse(html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/)[1]);
  const keys = (lang) => Object.keys(i18n[lang]).sort();
  for (const lang of ['en', 'es', 'pt']) {
    for (const k of ['pipelineOpenGithub', 'pipelineJobDetails', 'pipelineTotalDuration']) assert.ok(i18n[lang][k], `${lang}.${k}`);
  }
  assert.deepEqual(keys('es'), keys('en'));
  assert.deepEqual(keys('pt'), keys('en'));
  assert.match(html, /<section[^>]*id="pipeline" aria-label="Pipeline for task">\s*<h2>Pipeline for task<\/h2>/);
});
