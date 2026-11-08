// E3 + P6: nudge counts real runs of checks.sh per round and stops at checks.max_runs_per_round;
// the builder, approver and code-review roles carry the flaky-check rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deviatedACs, parseDeviations } from '../factory/lib/job.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const ID = '043-cap';
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV } });
const CAP_MSG = /cap reached: write build\.md with what is still failing/;

// A checks.sh that fails (so no stamp is ever reused) and appends a line to $CHECKS_COUNT on every real run.
function setup({ max, round = 1, checks = '#!/bin/sh\necho run >> "$CHECKS_COUNT"\nexit 1\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-nudge-cap-'));
  const root = join(dir, 'root');
  const worktree = join(dir, 'worktree');
  const jobDir = join(root, 'factory/jobs', ID);
  mkdirSync(jobDir, { recursive: true });
  const config = JSON.parse(readFileSync(join(repo, 'factory/config.json'), 'utf8'));
  delete config.checks;
  if (max !== undefined) config.checks = { max_runs_per_round: max };
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(config));
  writeFileSync(join(root, 'factory/checks.sh'), checks, { mode: 0o755 });
  mkdirSync(worktree);
  git(worktree, 'init', '-q', '-b', 'main');
  writeFileSync(join(worktree, 'a.txt'), 'x\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'init');
  const setRound = (n) => writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ id: ID, worktree, round: n }));
  setRound(round);
  const count = join(dir, 'count');
  writeFileSync(count, '');
  const env = { ...process.env, ...GIT_ENV, FACTORY_ROOT: root, CHECKS_COUNT: count };
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: `Job folder: factory/jobs/${ID}/` } })}\n`);
  return {
    jobDir,
    env,
    setRound,
    runs: () => readFileSync(count, 'utf8').split('\n').filter(Boolean).length,
    nudge: () => spawnSync('sh', [join(repo, 'factory/bin/nudge'), ID], { encoding: 'utf8', input: '', env }),
    hook: () => spawnSync('sh', [join(repo, 'factory/bin/nudge')], { encoding: 'utf8', input: JSON.stringify({ transcript_path: transcript }), env }),
    touch: () => appendFileSync(join(worktree, 'a.txt'), 'y\n'),
  };
}

test('AC-1: run N+1 of a round exits 2 with the cap message and does not run the checks', () => {
  const t = setup({ max: 3 });
  for (let i = 0; i < 3; i += 1) assert.doesNotMatch(t.nudge().stderr, CAP_MSG);
  assert.equal(t.runs(), 3);
  const res = t.nudge();
  assert.equal(res.status, 2);
  assert.match(res.stderr, CAP_MSG);
  assert.equal(t.runs(), 3);
});

test('AC-1: the default cap is 6', () => {
  const t = setup();
  for (let i = 0; i < 6; i += 1) t.nudge();
  assert.equal(t.runs(), 6);
  assert.match(t.nudge().stderr, CAP_MSG);
});

test('AC-1: in hook mode the first cap hit exits 2 (the builder sees it), later ones exit 0, and no checks run', () => {
  const t = setup({ max: 2 });
  assert.equal(t.hook().status, 2, 'a failing run keeps the builder working');
  assert.equal(t.hook().status, 2);
  const first = t.hook();
  assert.equal(first.status, 2, first.stderr);
  assert.match(first.stderr, CAP_MSG);
  assert.match(readFileSync(join(t.jobDir, 'nudge.log'), 'utf8'), CAP_MSG);
  assert.equal(JSON.parse(readFileSync(join(t.jobDir, 'nudge.json'), 'utf8')).runs.notified, true);
  const later = t.hook();
  assert.equal(later.status, 0, later.stderr);
  assert.match(later.stderr, CAP_MSG);
  assert.equal(t.hook().status, 0);
  assert.equal(t.runs(), 2);
});

test('a corrupt nudge.json resets the count instead of crashing', () => {
  for (const junk of ['null', '"text"', '[1,2]', '{not json']) {
    const t = setup({ max: 1 });
    writeFileSync(join(t.jobDir, 'nudge.json'), junk);
    const res = t.nudge();
    assert.doesNotMatch(res.stderr, /cap reached|TypeError/);
    assert.equal(t.runs(), 1, junk);
  }
});

test('a pass, then the cap, then the same tree: the reuse still exits 0', () => {
  const t = setup({ max: 1, checks: '#!/bin/sh\necho run >> "$CHECKS_COUNT"\nexit 0\n' });
  assert.equal(t.nudge().status, 0);
  assert.equal(t.nudge().status, 0, 'reused, not capped');
  assert.equal(t.hook().status, 0);
  assert.equal(t.runs(), 1);
  t.touch();
  assert.equal(t.nudge().status, 2, 'a new tree needs a run and the cap is reached');
});

test('focused and full runs both count', () => {
  const t = setup({ max: 2 });
  const full = spawnSync('sh', [join(repo, 'factory/bin/nudge'), ID, '--full'], { encoding: 'utf8', input: '', env: t.env });
  assert.equal(full.status, 2);
  assert.equal(t.nudge().status, 2);
  assert.equal(t.runs(), 2);
  assert.match(t.nudge().stderr, CAP_MSG);
  assert.equal(t.runs(), 2);
});

test('AC-2: the counter resets when the round changes', () => {
  const t = setup({ max: 2, round: 1 });
  t.nudge();
  t.nudge();
  assert.match(t.nudge().stderr, CAP_MSG);
  t.setRound(2);
  const res = t.nudge();
  assert.doesNotMatch(res.stderr, CAP_MSG);
  assert.equal(t.runs(), 3);
});

test('a reused pass does not count toward the cap', () => {
  const t = setup({ max: 2, checks: '#!/bin/sh\necho run >> "$CHECKS_COUNT"\nexit 0\n' });
  assert.equal(t.nudge().status, 0);
  for (let i = 0; i < 5; i += 1) assert.equal(t.nudge().status, 0); // same tree: reused
  assert.equal(t.runs(), 1);
  t.touch();
  assert.equal(t.nudge().status, 0, 'the second real run is still under the cap');
  assert.equal(t.runs(), 2);
  t.touch();
  const res = t.nudge();
  assert.equal(res.status, 2);
  assert.match(res.stderr, CAP_MSG);
});

test('a nudge refused by the lock does not count toward the cap', () => {
  const t = setup({ max: 1 });
  writeFileSync(join(t.jobDir, 'nudge.lock'), `${process.pid}\n`);
  for (let i = 0; i < 3; i += 1) assert.equal(t.nudge().status, 1);
  rmLock(t);
  const res = t.nudge();
  assert.doesNotMatch(res.stderr, CAP_MSG);
  assert.equal(t.runs(), 1);
});

function rmLock(t) {
  execFileSync('rm', ['-f', join(t.jobDir, 'nudge.lock')]);
}

test('AC-3: build.md with an empty or filled ## Flaky section is parsed like any other', () => {
  const flaky = '## Flaky\n- npm test -- a.test.js | timeout after 5s\nnode b.js | EADDRINUSE\n';
  for (const body of [
    `## Spec deviations\nNone\n\n## Flaky\n\n## Notes for the next round\n- x\n`,
    `## Spec deviations\nNone\n\n${flaky}\n## Notes for the next round\n- x\n`,
    `## Flaky\n\n## Spec deviations\nNone\n`,
    `## Flaky\n${flaky}\n## Spec deviations\nNone\n`,
  ]) {
    assert.deepEqual(parseDeviations(`STATUS: READY\n\n${body}`), []);
  }
  const text = `STATUS: READY\n\n## Spec deviations\nAC-2 | Design: a -> b (code round 1)\n\n${flaky}`;
  assert.deepEqual(deviatedACs(text), ['AC-2'], 'flaky lines are not read as deviations');
  // A level-3 heading stays inside the deviations section and is read as an invalid entry: why the role demands `## Flaky`.
  assert.equal(parseDeviations('## Spec deviations\nNone\n\n### Flaky\nnode b.js | EADDRINUSE\n').length, 2);
  assert.match(role('builder'), /exactly `## Flaky`/);
  assert.equal(parseDeviations(text).length, 1);
});

const role = (name) => readFileSync(join(repo, `factory/roles/${name}.md`), 'utf8');

test('AC-4: the builder, approver and code-review roles carry the rule', () => {
  const builder = role('builder');
  assert.match(builder, /at most 2 times per round/);
  assert.match(builder, /checks\.max_runs_per_round/);
  assert.match(builder, /cap reached: write build\.md with what is still failing/);
  assert.match(builder, /not in files of your diff[\s\S]*## Notes for the next round/);
  assert.match(builder, /## Flaky[\s\S]*`command \| error`/);
  assert.match(builder, /do not fix\s+it in this job/);
  assert.doesNotMatch(builder.match(/## Flaky[\s\S]{0,400}/)[0], /smoke/i);
  assert.match(role('approver'), /For the human[\s\S]*## Flaky/);
  assert.match(role('review-code'), /## Flaky[\s\S]*\[blocker\][\s\S]*diff touched/);
});

test('the added rule text avoids provider- and repo-specific words in all three roles', () => {
  for (const name of ['builder', 'approver', 'review-code']) {
    const text = role(name);
    const section = (text.match(/[^\n]*Flaky[\s\S]{0,300}/g) ?? []).join('\n');
    assert.ok(section.length > 0, name);
    assert.doesNotMatch(section, /smoke/i);
  }
});

test('config: the template and the repo config declare checks.max_runs_per_round = 6', () => {
  for (const f of ['factory/config.json', 'factory/templates/config.json']) {
    assert.equal(JSON.parse(readFileSync(join(repo, f), 'utf8')).checks.max_runs_per_round, 6);
  }
});
