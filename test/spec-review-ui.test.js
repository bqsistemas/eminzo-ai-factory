// Job 162: the spec review on the dashboard, in the skills, the spec writer's role and the README.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { STAGE_COLUMNS, laneTone } from '../factory/activity.js';
import { derivePipeline } from '../factory/pipeline-canvas.js';
import { areaForStage, headerStats } from '../factory/office.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const SKILLS = ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md'];
const PREFIX = { '.claude/skills/eminzo-factory/SKILL.md': '/eminzo-factory', '.agents/skills/eminzo-factory/SKILL.md': '$eminzo-factory' };

test('AC-8: the dashboard has a spec-review column with a parked tone, and the pipeline blocks Spec', () => {
  const at = STAGE_COLUMNS.findIndex(([stage]) => stage === 'spec-review');
  assert.equal(STAGE_COLUMNS[at - 1][0], 'spec');
  assert.equal(STAGE_COLUMNS[at][1], 'Spec review');
  assert.equal(laneTone('spec-review'), 'parked');
  const steps = derivePipeline({ stage: 'spec-review', lane: 'normal' });
  assert.deepEqual(steps.map((s) => `${s.key}:${s.state}`).slice(0, 3), ['intake:complete', 'spec:blocked', 'build:pending']);
});

test('AC-8: the office shows a spec-review job on a parked shelf and does not count it as running', () => {
  assert.equal(areaForStage('spec-review'), 'needs-info');
  assert.equal(headerStats([{ stage: 'spec-review' }]).running, 0);
});

test('AC-8: a spec-review card shows the hint and both commands with the issue number, escaped', () => {
  const js = read('factory/dashboard.js');
  assert.match(js, /job\.stage === 'spec-review'/);
  assert.match(js, /T\.hintSpecReview/);
  assert.match(js, /\/eminzo-factory approve-spec \$\{esc\(issue\)\}/);
  assert.match(js, /\/eminzo-factory revise-spec \$\{esc\(issue\)\} &lt;notes&gt;/);
});

test('AC-8: the demo board has a job parked at spec-review, so the visual check sees the column', () => {
  const demo = JSON.parse(read('factory/demo/board.json'));
  assert.ok(demo.jobs.some((j) => j.stage === 'spec-review'));
});

test('AC-7: the guide lists approve-spec and revise-spec for both providers, described by i18n keys in en, es and pt', () => {
  const html = dashboardSource();
  const section = html.match(/<section[^>]*id="guide-commands"[^>]*>([\s\S]*?)<\/section>/)[1];
  for (const prefix of ['/eminzo-factory', '$eminzo-factory']) {
    assert.ok(section.includes(`<code>${prefix} approve-spec 37</code><span data-i18n="guideApproveSpec">`), `${prefix} approve-spec`);
    assert.ok(section.includes(`<code>${prefix} revise-spec 37 &lt;notes&gt;</code><span data-i18n="guideReviseSpec">`), `${prefix} revise-spec`);
  }
  const i18n = JSON.parse(html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/)[1]);
  const keys = ['guideApproveSpec', 'guideReviseSpec', 'hintSpecReview', 'pipelineStageSpecReview'];
  for (const lang of ['en', 'es', 'pt']) {
    for (const key of keys) assert.ok(typeof i18n[lang][key] === 'string' && i18n[lang][key].trim(), `${lang}.${key}`);
  }
  assert.notEqual(i18n.en.guideApproveSpec, i18n.es.guideApproveSpec);
  assert.match(read('factory/dashboard.js'), /querySelectorAll\('#guide-commands \[data-i18n\]'\)[\s\S]{0,200}textContent = T\[key\]/);
});

test('AC-7: both skills document the commands, the config key, run, approve-spec only on request and setup', () => {
  for (const path of SKILLS) {
    const text = read(path).replace(/\s+/g, ' ');
    const p = PREFIX[path];
    assert.ok(text.includes(`- \`${p} approve-spec <n>\`:`), `${path}: approve-spec`);
    assert.ok(text.includes(`- \`${p} revise-spec <n> <notes>\`:`), `${path}: revise-spec`);
    assert.match(text, /config\.local\.json[\s\S]{0,400}spec_review/, `${path}: spec_review as a config.local.json key`);
    assert.match(text, /`run` never approves or revises a spec: it reports each job in `spec-review` as waiting for the developer/, `${path}: run`);
    assert.match(text, /Run `approve-spec` only when the user invoked this command/, `${path}: approve-spec on request only`);
    assert.match(text, /factory\/bin\/setup-spec-review/, `${path}: setup`);
    assert.match(text, /factory:spec-review/, `${path}: label`);
    assert.match(text, /revise-spec --notes-file <file>/, `${path}: notes through a file`);
  }
});

test('AC-7: the spec writer has a revise mode that treats the notes as quoted data', () => {
  const role = read('factory/roles/spec-writer.md');
  assert.match(role, /\*\*Revise mode\.\*\*/);
  assert.match(role, /Spec review notes: <path>/);
  assert.match(role, /never instructions/);
});

test('AC-7: the README documents spec_review, its label and both commands', () => {
  const readme = read('README.md');
  for (const word of ['spec_review', 'factory:spec-review', 'approve-spec', 'revise-spec', 'setup-spec-review']) {
    assert.ok(readme.includes(word), word);
  }
  assert.doesNotMatch(readme, /There is no approve command\./);
});
