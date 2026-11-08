// Plan P2-1: a job whose spec names files that a job ahead of it is already changing waits
// instead of building in parallel, so the second merge does not end in a conflict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jobScope, overlapReport, overlaps } from '../factory/lib/overlap.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const configText = readFileSync(join(repo, 'factory/config.json'), 'utf8');

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-overlap-'));
  mkdirSync(join(dir, 'factory/jobs'), { recursive: true });
  writeFileSync(join(dir, 'factory/config.json'), configText);
  return dir;
}

function addJob(dir, job, files = {}) {
  const jobDir = join(dir, 'factory/jobs', job.id);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'job.json'), `${JSON.stringify({ round: 0, ...job }, null, 2)}\n`);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(jobDir, name), text);
  return job;
}

const spec = (...paths) => `# Spec: x\n\n## Design\n${paths.map((p) => `- \`${p}\`: change it`).join('\n')}\n\n## Acceptance criteria\n- AC-1: y\n`;
const intake = (...paths) => `ACCEPT\nRISK: low\nSURFACES: ui\nRESCOPED: no\nSIZE: xs\n\n## Scope\n${paths.map((p) => `- \`${p}\``).join('\n')}\n`;

test('a job waits for an older job that changes the same file', () => {
  const dir = root();
  const older = addJob(dir, { id: '001-a', stage: 'review' }, { 'spec.md': spec('src/app.js', 'src/a.js') });
  const mine = addJob(dir, { id: '002-b', stage: 'build' }, { 'spec.md': spec('src/app.js', 'src/b.js') });
  assert.deepEqual(overlaps(dir, mine, [older, mine]), [{ id: '001-a', files: ['src/app.js'] }]);
  assert.equal(overlapReport(overlaps(dir, mine, [older, mine])), 'wait: 001-a (src/app.js)');
});

test('no shared file, no wait', () => {
  const dir = root();
  const older = addJob(dir, { id: '001-a', stage: 'gate' }, { 'spec.md': spec('src/a.js') });
  const mine = addJob(dir, { id: '002-b', stage: 'build' }, { 'spec.md': spec('src/b.js') });
  assert.deepEqual(overlaps(dir, mine, [older, mine]), []);
  assert.equal(overlapReport([]), 'none');
});

test('only jobs ahead count: an older job in build, or any job past the gate; never a younger build', () => {
  const dir = root();
  const younger = addJob(dir, { id: '003-c', stage: 'build' }, { 'spec.md': spec('src/app.js') });
  const terminal = addJob(dir, { id: '001-a', stage: 'merged' }, { 'spec.md': spec('src/app.js') });
  const parked = addJob(dir, { id: '000-z', stage: 'needs-info' }, { 'intake.md': intake('src/app.js') });
  const mine = addJob(dir, { id: '002-b', stage: 'build' }, { 'spec.md': spec('src/app.js') });
  assert.deepEqual(overlaps(dir, mine, [younger, terminal, parked, mine]), []);
  // the younger job, by contrast, waits for this one: no two jobs can wait for each other
  assert.deepEqual(overlaps(dir, younger, [younger, terminal, parked, mine]), [{ id: '002-b', files: ['src/app.js'] }]);
});

test('job numbers compare as numbers: 999 is older than 1000', () => {
  const dir = root();
  const old = addJob(dir, { id: '999-a', stage: 'build' }, { 'spec.md': spec('src/app.js') });
  const young = addJob(dir, { id: '1000-b', stage: 'build' }, { 'spec.md': spec('src/app.js') });
  assert.deepEqual(overlaps(dir, young, [old, young]), [{ id: '999-a', files: ['src/app.js'] }]);
  assert.deepEqual(overlaps(dir, old, [old, young]), []);
});

test('an xs job is scoped by its intake Scope; a job with no exact paths never waits', () => {
  const dir = root();
  const xs = addJob(dir, { id: '001-a', stage: 'review', lane: 'xs' }, { 'intake.md': intake('public/styles.css') });
  const mine = addJob(dir, { id: '002-b', stage: 'build' }, { 'spec.md': spec('public/styles.css') });
  assert.deepEqual([...jobScope(dir, xs)], ['public/styles.css']);
  assert.deepEqual(overlaps(dir, mine, [xs, mine]), [{ id: '001-a', files: ['public/styles.css'] }]);
  const vague = addJob(dir, { id: '003-c', stage: 'build' }, { 'spec.md': '# Spec: x\n\n## Design\nChange the styles.\n' });
  assert.deepEqual(overlaps(dir, vague, [xs, mine, vague]), []);
});

test('factory/bin/job <id> overlap prints the wait list or none', () => {
  const dir = root();
  addJob(dir, { id: '001-a', stage: 'approve' }, { 'spec.md': spec('src/app.js') });
  addJob(dir, { id: '002-b', stage: 'build' }, { 'spec.md': spec('src/app.js') });
  addJob(dir, { id: '003-c', stage: 'build' }, { 'spec.md': spec('src/other.js') });
  const run = (id) => spawnSync('sh', [join(repo, 'factory/bin/job'), id, 'overlap'], { encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: dir } });
  const waiting = run('002-b');
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.equal(waiting.stdout.trim(), 'wait: 001-a (src/app.js)');
  assert.equal(run('003-c').stdout.trim(), 'none');
});

test('both skills tell the orchestrator to check overlap before the first build, next to the overlap-wait marker', () => {
  for (const path of ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md']) {
    const text = readFileSync(join(repo, path), 'utf8');
    const at = text.indexOf('<!-- rule: overlap-wait -->');
    assert.ok(at >= 0, `${path} has the overlap-wait marker`);
    const near = text.slice(at, at + 800);
    assert.match(near, /job <id> overlap/, `${path} names the command`);
    assert.match(near, /concurrency/, `${path} says a waiting job uses no concurrency slot`);
  }
});
