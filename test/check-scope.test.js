// E1: the scope of the checks. The gate, the merge and the nudge tell checks.sh where the job's branch
// left the base (FACTORY_BASE) and which commit was tested (FACTORY_HEAD), so a checks.sh may run only
// what the job touched. A job that fixes the base gets neither; inherited values are always dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gateFixture } from './helpers/gate-fixture.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Appends one line per run to $FACTORY_ROOT/runs: base, head and whether each variable is set.
const DUMP = '#!/bin/sh\nprintf "base=%s head=%s\\n" "${FACTORY_BASE-unset}" "${FACTORY_HEAD-unset}" >> "$FACTORY_ROOT/runs"\nexit 0\n';
const runs = (t) => (existsSync(join(t.root, 'runs')) ? readFileSync(join(t.root, 'runs'), 'utf8').trim().split('\n') : []);

function commitOnBranch(t, name = 'work.txt') {
  writeFileSync(join(t.worktree, name), 'w\n');
  git(t.worktree, 'add', name);
  git(t.worktree, 'commit', '-q', '-m', `feat: ${name}`);
}

function moveBase(t) {
  writeFileSync(join(t.root, 'moved.txt'), 'm\n');
  git(t.root, 'add', 'moved.txt');
  git(t.root, 'commit', '-q', '-m', 'feat: base moved');
  git(t.root, 'push', '-q', 'origin', 'main');
  git(t.root, 'fetch', '-q', 'origin');
}

test('the gate passes the merge-base and the tested head, and the report names the base', () => {
  const t = gateFixture(DUMP);
  const mb = git(t.worktree, 'merge-base', 'origin/main', 'HEAD');
  moveBase(t);
  commitOnBranch(t);
  const res = t.gate();
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(runs(t), [`base=${mb} head=${t.head()}`]);
  const report = t.report();
  assert.match(report, new RegExp(`^Checks base: ${mb}$`, 'm'));
  assert.match(report, new RegExp(`^Tested head: ${t.head()}$`, 'm'));
});

test('the gate drops inherited values: a bad or foreign FACTORY_BASE never reaches checks.sh', () => {
  const t = gateFixture(DUMP);
  const mb = git(t.worktree, 'merge-base', 'origin/main', 'HEAD');
  t.env.FACTORY_BASE = 'not-a-sha; touch pwned';
  t.env.FACTORY_HEAD = 'abc';
  assert.equal(t.gate().status, 0);
  assert.deepEqual(runs(t), [`base=${mb} head=${t.head()}`]);
  assert.equal(existsSync(join(t.worktree, 'pwned')), false);
});

test('a job that fixes the base gets neither variable and the report says none', () => {
  const t = gateFixture(DUMP);
  const file = join(t.jobDir, 'job.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), base_fix: true }));
  t.env.FACTORY_BASE = '0'.repeat(40);
  assert.equal(t.gate().status, 0);
  assert.deepEqual(runs(t), ['base=unset head=unset']);
  assert.match(t.report(), /^Checks base: none$/m);
});

test('the nudge sets only FACTORY_BASE when it runs focused by hand; --full and the hook run everything', () => {
  const t = gateFixture(DUMP);
  const mb = git(t.worktree, 'merge-base', 'origin/main', 'HEAD');
  commitOnBranch(t);
  for (const args of [[], ['--full']]) {
    const res = spawnSync('sh', [join(repo, 'factory/bin/nudge'), '001-contract', ...args], { encoding: 'utf8', env: t.env });
    assert.equal(res.status, 0, res.stderr);
  }
  assert.deepEqual(runs(t), [`base=${mb} head=unset`, 'base=unset head=unset']);
});

test('a focused nudge pass is not reused once the branch has another merge-base', () => {
  const t = gateFixture(DUMP);
  const nudge = () => spawnSync('sh', [join(repo, 'factory/bin/nudge'), '001-contract'], { encoding: 'utf8', env: t.env });
  assert.equal(nudge().status, 0);
  assert.equal(nudge().status, 0);
  assert.equal(runs(t).length, 1, 'same tree and same merge-base: reused');
  git(t.root, 'commit', '-q', '--allow-empty', '-m', 'chore: empty base commit');
  git(t.root, 'push', '-q', 'origin', 'main');
  git(t.root, 'fetch', '-q', 'origin');
  git(t.worktree, 'merge', '-q', '--no-edit', 'origin/main'); // the files stay the same, the merge-base moves
  assert.equal(nudge().status, 0);
  assert.equal(runs(t).length, 2, 'another merge-base: run again');
});

test('a full nudge pass does not depend on the merge-base: it ran everything', () => {
  const t = gateFixture(DUMP);
  const nudge = () => spawnSync('sh', [join(repo, 'factory/bin/nudge'), '001-contract', '--full'], { encoding: 'utf8', env: t.env });
  assert.equal(nudge().status, 0);
  git(t.root, 'commit', '-q', '--allow-empty', '-m', 'chore: empty base commit');
  git(t.root, 'push', '-q', 'origin', 'main');
  git(t.root, 'fetch', '-q', 'origin');
  git(t.worktree, 'merge', '-q', '--no-edit', 'origin/main');
  assert.equal(nudge().status, 0);
  assert.equal(runs(t).length, 1);
});

test('merge-checks pass the new tip as the base and the merge commit as the head', () => {
  const t = gateFixture(DUMP);
  commitOnBranch(t);
  moveBase(t);
  git(t.worktree, 'merge', '-q', '--no-edit', 'origin/main'); // what merge() does before it gates
  const tip = git(t.root, 'rev-parse', 'origin/main');
  const out = join(t.jobDir, 'merge-checks.md');
  assert.equal(t.gate('--out', out).status, 0);
  assert.deepEqual(runs(t), [`base=${tip} head=${t.head()}`]);
  assert.match(readFileSync(out, 'utf8'), new RegExp(`^Checks base: ${tip}$`, 'm'));
});
