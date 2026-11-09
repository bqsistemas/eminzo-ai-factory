// Golden contract: every token and heading the engine (and the desktop app) parses out of a
// factory artifact, pinned byte for byte. A readable rewrite of an engine-written artifact must
// keep this file green. The desktop reads `KEY: value` lines right below the status line.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';

import { testedBy } from '../factory/lib/check-stamp.js';
import { parseIntake } from '../factory/lib/intake.js';
import { hasLessonsSection, lessonsOf } from '../factory/lib/lessons.js';
import { sectionLines } from '../factory/lib/section.js';
import { acNumbers } from '../factory/lib/selfcheck.js';
import { visualStatus } from '../factory/lib/visual-analysis.js';
import { githubBody, parseDeviations } from '../factory/lib/job.js';
import { desktopHeader, gateFixture } from './helpers/gate-fixture.js';


test('contract: intake.md first lines', () => {
  const text = 'ACCEPT\nRISK: medium\nSURFACES: ui, security\nRESCOPED: yes\nSIZE: s\n\n## Scope\n- AC-1: x\n';
  assert.deepEqual(parseIntake(text), { decision: 'ACCEPT', risk: 'medium', surfaces: ['ui', 'security'], rescoped: true, size: 's' });
  assert.deepEqual(desktopHeader(text), { first: 'ACCEPT', fields: { RISK: 'medium', SURFACES: 'ui, security', RESCOPED: 'yes', SIZE: 's' } });
  for (const d of ['NEEDS-INFO', 'REJECT']) assert.equal(parseIntake(`${d}\nRISK: low\nSURFACES: none\nRESCOPED: no\n`).decision, d);
  assert.deepEqual(sectionLines(text, 'Scope').map((l) => l.text).filter(Boolean), ['- AC-1: x']);
});

test('contract: build.md status line and headings', () => {
  const text = 'STATUS: READY\n\n## Spec deviations\nAC-2: changed\nDesign: swapped\n\n## Notes for the next round\n- n\n\n## Flaky\n- t\n';
  assert.match(text.split('\n')[0], /^STATUS: (READY|BLOCKED)\b/);
  assert.deepEqual(parseDeviations(text).map((d) => [d.kind, d.ac]), [['ac', 'AC-2'], ['design', undefined]]);
  assert.ok(sectionLines(text, 'Notes for the next round'));
  assert.deepEqual(sectionLines(text, 'Flaky').map((l) => l.text).filter(Boolean), ['- t']);
  assert.equal(parseDeviations('STATUS: READY\n')[0].missing, true);
});

test('contract: spec acceptance criteria lines', () => {
  assert.deepEqual(acNumbers(['- AC-1: a', '- **AC-2**: b']), [1, 2]);
});

test('contract: review and decision first lines, lessons', () => {
  assert.match('VERDICT: CHANGES\n', /^VERDICT: (PASS|CHANGES)\b/);
  const decision = 'ESCALATE\nwhy\n\n## Lessons\n- one\n\n## For the human\n- ask\n';
  assert.match(decision, /^(APPROVE|ESCALATE)\b/);
  assert.deepEqual(lessonsOf(decision), ['one']);
  assert.ok(hasLessonsSection(decision));
  assert.ok(sectionLines(decision, 'For the human'));
});

test('contract: comment markers', () => {
  const id = '001-x';
  assert.ok(githubBody('en', 'needs-human-pr', { id, note: 'n' }).startsWith(`<!-- factory:note ${id} -->\n`));
  assert.ok(githubBody('en', 'intake', { id, decision: 'ACCEPT', header: 'h', rest: 'r' }).startsWith(`<!-- factory:intake ${id} -->\n`));
  assert.ok(githubBody('en', 'spec-review', { id, issue: 3, sha256: 'ab', spec: 's' }).startsWith(`<!-- factory:spec-review ${id} -->\n`));
});

test('contract: VISUAL first line', () => {
  for (const s of ['PASS', 'FAIL', 'SKIPPED', 'ERROR']) assert.equal(visualStatus(`VISUAL: ${s}\n\nReason: x\n`), s);
});

// --- the gate report, written by the real gate -------------------------------------------------

test('contract: checks.md keeps its status line, parsed lines and headings (PASS)', () => {
  const t = gateFixture();
  assert.equal(t.gate().status, 0);
  const text = t.report();
  assert.equal(text.split('\n')[0], 'GATE: PASS');
  assert.match(text, /^Checks exit code: 0$/m);
  assert.match(text, /^Protected test violations: none$/m);
  assert.match(text, /^Uncommitted changes: none$/m);
  assert.deepEqual(testedBy(text), { head: t.head(), inputs: testedBy(text).inputs });
  assert.match(testedBy(text).inputs, /^sha256:[0-9a-f]{64}$/);
  assert.match(text, /^## Log \(last \d+ lines\)$/m);
  assert.ok(text.includes('checks passed'));
});

test('contract: checks.md keeps the failing lines the engine and humans grep', () => {
  const t = gateFixture('#!/bin/sh\necho boom\nexit 1\n');
  assert.equal(t.gate().status, 1);
  const text = t.report();
  assert.equal(text.split('\n')[0], 'GATE: FAIL');
  assert.match(text, /^Checks exit code: 1$/m);
  assert.ok(text.includes('boom'));
});

test('contract: --out writes the same format (merge-checks.md)', () => {
  const t = gateFixture();
  t.gate('--out', join(t.jobDir, 'merge-checks.md'));
  const text = t.report('merge-checks.md');
  assert.equal(text.split('\n')[0], 'GATE: PASS');
  assert.ok(testedBy(text).head);
});

test('contract: line 2 is ENGINE: <version> and line 3 is blank, in checks.md and merge-checks.md', () => {
  const t = gateFixture();
  t.env.EMINZO_VERSION = '4.5.6';
  t.gate();
  t.gate('--out', join(t.jobDir, 'merge-checks.md'));
  for (const rel of ['round-1/checks.md', 'merge-checks.md']) {
    const lines = t.report(rel).split('\n');
    assert.match(lines[0], /^GATE: (PASS|FAIL)$/);
    assert.equal(lines[1], 'ENGINE: 4.5.6');
    assert.match(lines[1], /^ENGINE: \S+$/);
    assert.equal(lines[2], '');
  }
});

test('contract: without a version there is no ENGINE line and the old layout holds', async () => {
  const { engineLines, reusedReport } = await import('../factory/lib/report.js');
  assert.deepEqual(engineLines(null), []);
  const lines = reusedReport({ round: 1, base: 'origin/main', head: 'a'.repeat(40), inputs: `sha256:${'b'.repeat(64)}`, engine: null }).split('\n');
  assert.equal(lines[0], 'GATE: PASS');
  assert.equal(lines[1], '');
  assert.ok(!lines.some((l) => l.startsWith('ENGINE:')));
});
