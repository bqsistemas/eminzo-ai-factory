// Golden contract: every token and heading the engine (and the desktop app) parses out of a
// factory artifact, pinned byte for byte. A readable rewrite of an engine-written artifact must
// keep this file green. The desktop reads `KEY: value` lines right below the status line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { testedBy } from '../factory/lib/check-stamp.js';
import { parseIntake } from '../factory/lib/intake.js';
import { hasLessonsSection, lessonsOf } from '../factory/lib/lessons.js';
import { sectionLines } from '../factory/lib/section.js';
import { acNumbers } from '../factory/lib/selfcheck.js';
import { visualStatus } from '../factory/lib/visual-analysis.js';
import { githubBody, parseDeviations } from '../factory/lib/job.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const HEADER = /^([A-Z][A-Z-]{1,15}):[ \t]+(\S.*)$/;

/** The desktop's view of an artifact: first line, then the KEY: value lines right under it. */
export function desktopHeader(text) {
  const lines = text.split('\n');
  const fields = {};
  for (const line of lines.slice(1)) {
    const m = HEADER.exec(line);
    if (!m) break;
    fields[m[1]] = m[2];
  }
  return { first: lines[0], fields };
}

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

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ID = '001-contract';

export function gateFixture(checks = '#!/bin/sh\necho "checks passed"\nexit 0\n') {
  const dir = mkdtempSync(join(tmpdir(), 'factory-contract-'));
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git'));
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\nfactory/board.json\n.worktrees/\n');
  writeFileSync(join(root, 'factory/config.json'), readFileSync(join(repo, 'factory/config.json'), 'utf8'));
  writeFileSync(join(root, 'factory/checks.sh'), checks);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', join(dir, 'origin.git'));
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  const worktree = join(root, '.worktrees', ID);
  git(root, 'worktree', 'add', '-q', worktree, '-b', `factory/${ID}`, 'origin/main');
  const jobDir = join(root, 'factory/jobs', ID);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ id: ID, issue: 1, branch: `factory/${ID}`, worktree, stage: 'gate', round: 1, max_rounds: 3 }));
  const env = { ...process.env, ...GIT_ENV, FACTORY_ROOT: root };
  return {
    root, worktree, jobDir, env,
    gate: (...a) => spawnSync(join(repo, 'factory/bin/gate'), [ID, ...a], { cwd: root, env, encoding: 'utf8' }),
    report: (rel = 'round-1/checks.md') => readFileSync(join(jobDir, rel), 'utf8'),
    head: () => git(worktree, 'rev-parse', 'HEAD'),
  };
}

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

export { HEADER };
