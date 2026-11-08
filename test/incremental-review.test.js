// Plan P0-3 and P0-4: incremental re-review, spec deviations and the amend model.
// The job.js transitions are covered in test/job.test.js; this file covers the
// config key, the dashboard chips and the role and skill text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { roundChipsHtml, roundsOf } from '../factory/activity.js';
import { citedPaths } from '../factory/lib/job.js';
import { stageModels } from '../factory/lib/route.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
// Whitespace is collapsed so the checks do not depend on where a line wraps.
const read = (path) => readFileSync(join(repo, path), 'utf8').replace(/\s+/g, ' ');
const config = JSON.parse(readFileSync(join(repo, 'factory/config.json'), 'utf8'));
const SKILLS = ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md'];
const REVIEWERS = ['review-code', 'review-security', 'review-ui', 'review-ux'];

test('AC-4: both providers declare a spec-writer-amend model and stageModels returns it', () => {
  assert.equal(config.providers.claude.models['spec-writer-amend'], 'sonnet');
  assert.equal(config.providers.codex.models['spec-writer-amend'], 'gpt-6-luna');
  assert.equal(stageModels(config, 'codex')['spec-writer-amend'], 'gpt-6-luna');
  assert.equal(stageModels(config, 'claude')['spec-writer-amend'], 'sonnet');
});

test('AC-4: without an amend model the spec-writer model is the fallback', () => {
  const bare = { providers: { claude: { models: { intake: 'a', 'spec-writer': 'b', approver: 'c' }, routing: { builder: {}, reviewers: {} } } } };
  assert.equal(stageModels(bare, 'claude')['spec-writer-amend'], 'b');
});

test('AC-5: carried lenses render as chips that say where the verdict came from', () => {
  const row = { gate: 'PASS', reviews: { code: 'PASS' }, carried: { ui: { verdict: 'PASS', round: 1 } } };
  const html = roundChipsHtml(row);
  assert.match(html, /class="chip PASS carried"[^>]*aria-label="ui: PASS \(carried from R1\)"/);
  assert.ok(html.indexOf('>code<') < html.indexOf('>ui<'), 'ran lenses come first');
  assert.ok(!roundChipsHtml({ gate: 'PASS', reviews: { code: 'PASS' } }).includes('carried'));
  assert.ok(!roundChipsHtml({ gate: 'PASS', reviews: {}, carried: { '"><b>': { verdict: 'PASS', round: 1 } } }).includes('<b>'), 'keys are escaped');
});

test('AC-5: roundsOf keeps carried on the current round', () => {
  const carried = { ux: { verdict: 'PASS', round: 1 } };
  const rows = roundsOf({ history: [], round: 2, gate: 'PASS', reviews: { code: 'pending' }, carried });
  assert.deepEqual(rows[0].carried, carried);
});

test('AC-6: the dashboard styles the carried chip without inline styles', () => {
  assert.match(dashboardSource().replace(/\s+/g, ' '), /\.chip\.carried\s*\{/);
});

test('AC-7: every reviewer role has the repeat-review rule and judges against the spec intent', () => {
  for (const role of REVIEWERS) {
    const text = read(`factory/roles/${role}.md`);
    assert.match(text, /Your previous review: round-N\/review-/, `${role} must key on the prompt's previous review line`);
    assert.match(text, /intent of the spec's Goal and acceptance criteria/, `${role} must judge against the intent`);
    assert.match(text, /documented deviation/i, `${role} lacks the deviation rule`);
    assert.match(text, /verify each blocker you raised/i, `${role} must verify its earlier blockers`);
    if (role === 'review-security') continue;
    assert.match(text, /regressions introduced by this round's diff/, `${role} lacks the regression-only rule`);
    assert.match(text, /everything else is `\[minor\]`/, `${role} must demote other new findings`);
    assert.match(text, /First review for this lens/, `${role} must review everything on a first review`);
  }
  const security = read('factory/roles/review-security.md');
  assert.match(security, /Security is never demoted/);
  assert.ok(!/regressions introduced by this round's diff/.test(security), 'security is exempt from the regression-only rule');
  assert.match(security, /stays a blocker whenever you judge it one, no matter which lens's blocker forced it/);
  assert.match(read('factory/roles/review-code.md'), /git diff <previous-round-head>\.\.HEAD/);
  assert.match(read('factory/roles/review-code.md'), /`unknown`/);
});

test('AC-8: the builder documents deviations, the spec-writer has an amend mode, the approver escalates only on Goal changes', () => {
  const builder = read('factory/roles/builder.md');
  assert.match(builder, /## Spec deviations/);
  assert.match(builder, /AC-n \| Design: what changed → why/);
  assert.match(builder, /write `None`/i);
  const writer = read('factory/roles/spec-writer.md');
  assert.match(writer, /Mode: amend/);
  assert.match(writer, /## Amendments/);
  assert.match(writer, /- R<round> \| AC-n \| old → new \| reason/);
  assert.match(writer, /keep the first line `# Spec: /i);
  assert.match(writer, /Don't prescribe the exact rendering/);
  const approver = read('factory/roles/approver.md');
  assert.match(approver, /latest verdict/i);
  assert.match(approver, /changes the spec's Goal/);
  assert.match(approver, /decision\.md/);
});

for (const file of SKILLS) {
  test(`AC-9: ${file} states the incremental review and amend rules`, () => {
    const text = read(file);
    for (const name of ['incremental-review', 'spec-amendment']) assert.match(text, new RegExp(`<!-- rule: ${name} -->`), `${file} lacks ${name}`);
    const review = text.slice(text.indexOf('<!-- rule: incremental-review -->'));
    assert.match(review.slice(0, 2200), /latest verdict was `CHANGES`/);
    assert.match(review.slice(0, 2200), /`code`[^.]*always reruns/);
    assert.match(review.slice(0, 2200), /`security`[^.]*always reruns/);
    assert.match(review.slice(0, 2200), /Previous round head/);
    const amend = text.slice(text.indexOf('<!-- rule: spec-amendment -->'));
    assert.match(amend.slice(0, 2200), /job <id> amend/);
    assert.match(amend.slice(0, 2200), /Mode: amend/);
    assert.match(amend.slice(0, 2200), /spec-writer-amend/);
    assert.match(amend.slice(0, 2200), /before the reviewers/i);
    for (const status of ['invalid:', 'unverified:', 'escalate', 'needed:']) assert.ok(amend.slice(0, 2200).includes(status), `${file} must handle ${status}`);
    assert.match(review.slice(0, 2200), /review_paths/);
    assert.match(review.slice(0, 2200), /Carried: <lens> from R<n>/);
  });
}

test('AC-10: citedPaths accepts the usual prefixes, absolute paths and ignores prose', () => {
  const text = [
    '- [blocker] `src/a.css:2`: x', '- **web/b.html:7** y', '- "lib/c.js:3" z', "- 'lib/d.js:4'", '- [e/f.js:5] and (g/h.js:6)',
    '- /repo/wt/i/j.js:8 absolute', '- ./k.js:9', 'see section 2: not a path', 'ratio 3:4',
  ].join('\n');
  assert.deepEqual([...citedPaths(text, '/repo/wt')].sort(),
    ['e/f.js', 'g/h.js', 'i/j.js', 'k.js', 'lib/c.js', 'lib/d.js', 'src/a.css', 'web/b.html'].sort());
});

test('AC-11: this repo declares review_paths for ui and ux; the skills and the plan describe the conservative default', () => {
  for (const lens of ['ui', 'ux']) assert.ok(config.review_paths[lens].includes('factory/dashboard.html'));
  for (const file of SKILLS) assert.match(read(file), /without it, touches any file outside docs and tests/);
  assert.match(read('docs/factory-efficiency-plan.md'), /Sin el campo, el motor es conservador/);
  for (const file of SKILLS) assert.match(read(file), /The script enforces this: `to gate` and `to review` refuse/);
});
