// E3: the base check. `factory/bin/base` (and `eminzo base`) runs the repo's checks on the tip of the base
// branch in one reused detached worktree, `.worktrees/.base`, after a prepare step that installs the
// dependencies. Only a FAIL is a verdict about the base: anything that could not run is UNKNOWN. The
// answer and its cache live in factory/jobs/.base/state.json. Real git, fake everything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { baseFixture, git, GREEN, COUNTING } from './helpers/base-harness.js';

// The engine code runs in this process for the direct calls below.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x' });
const { checkBase, recordResult, MAX_RESULTS } = await import('../factory/lib/base.js');
const direct = (t, opts = {}) => { process.env.FACTORY_ROOT = t.root; process.env.FACTORY_BASE_LOCK_WAIT_MS = '400'; process.env.FACTORY_BASE_LOCK_POLL_MS = '40'; return checkBase(t.root, opts); };

test('a green base: PASS, exit 0, the state, the report and a detached .worktrees/.base', () => {
  const t = baseFixture({ config: { checks: { prepare: '' } } });
  const res = t.base();
  const sha = t.tip();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, new RegExp(`^base: PASS ${sha.slice(0, 12)}$`, 'm'));
  const key12 = /^report: factory\/jobs\/\.base\/([0-9a-f]{12})\/checks\.md$/m.exec(res.stdout)?.[1];
  assert.ok(key12, res.stdout);
  const state = t.state();
  assert.equal(state.version, 1);
  assert.equal(state.base, 'origin/main');
  assert.equal(state.full.status, 'PASS');
  assert.equal(state.full.sha, sha);
  assert.equal(state.full.scope, 'full');
  const report = t.report(`${key12}/checks.md`);
  assert.equal(report.split('\n')[0], 'BASE: PASS');
  assert.match(report, new RegExp(`^Checked commit: ${sha}$`, 'm'));
  assert.match(report, /^Scope: everything$/m);
  assert.match(report, /^Checks exit code: 0$/m);
  const wt = join(t.root, '.worktrees/.base');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), sha);
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached');
});

test('a red base: FAIL, exit 1, the failing command from the trace and none of it in the log', () => {
  const t = baseFixture({ files: { BROKEN: 'x\n' }, config: { checks: { prepare: '' } } });
  const res = t.base();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, new RegExp(`^base: FAIL ${t.tip().slice(0, 12)}: test '!' -f BROKEN$`, 'm'));
  const full = t.state().full;
  assert.equal(full.status, 'FAIL');
  assert.equal(full.command, "test '!' -f BROKEN"); // sh -x quotes the !
  assert.equal(full.exit, 1);
  const report = t.report(full.report);
  assert.match(report, /^Failing command: test '!' -f BROKEN$/m);
  assert.doesNotMatch(report, /\+\[factory\]/);
  assert.doesNotMatch(readFileSync(join(t.root, 'factory/jobs/.base', full.report.replace('checks.md', 'checks.log')), 'utf8'), /\+\[factory\]/);
});

test('a prepare step that fails is UNKNOWN (exit 3) and the checks never run', () => {
  const t = baseFixture({ config: { checks: { prepare: 'exit 7' } } });
  const res = t.base();
  assert.equal(res.status, 3);
  assert.match(res.stdout, /^base: UNKNOWN [0-9a-f]{12}: the prepare step failed \(exit 7\)$/m);
  assert.equal(t.runs(), 0);
  assert.equal(t.state().full.status, 'UNKNOWN');
});

test('checks that cannot run (exit 126, 127, a signal) are UNKNOWN, never FAIL', () => {
  for (const body of ['exit 127', 'exit 126', 'kill -KILL $$']) {
    const t = baseFixture({ checks: `#!/bin/sh\n${body}\n`, config: { checks: { prepare: '' } } });
    const res = t.base();
    assert.equal(res.status, 3, `${body}: ${res.stdout}`);
    assert.match(res.stdout, /^base: UNKNOWN [0-9a-f]{12}: /m, body);
  }
});

test('a live lock makes the check UNKNOWN after the wait; a dead one is taken over', () => {
  const t = baseFixture({ checks: GREEN, config: { checks: { prepare: '' } } });
  mkdirSync(join(t.root, 'factory/jobs/.base'), { recursive: true, mode: 0o700 });
  const lock = join(t.root, 'factory/jobs/.base/lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  const busy = t.base();
  assert.equal(busy.status, 3);
  assert.match(busy.stdout, /^base: UNKNOWN [0-9a-f]{12}: another base check is still running$/m);
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, started: new Date().toISOString() }));
  assert.equal(t.base().status, 0, 'a lock whose process is gone is stale');
  assert.equal(existsSync(lock), false, 'the lock is released');
});

test('job checks with the same key run once; --fresh and a check by hand always run', () => {
  const t = baseFixture({ config: { checks: { prepare: '' } } });
  const first = direct(t, { job: '001-x' });
  assert.equal(first.status, 'PASS');
  assert.equal(t.runs(), 1);
  const again = direct(t, { job: '001-x' });
  assert.equal(again.fromCache, true);
  assert.equal(t.runs(), 1, 'same key: not run again');
  direct(t, { job: '001-x', fresh: true });
  assert.equal(t.runs(), 2);
  direct(t, { byHand: true });
  direct(t, { byHand: true });
  assert.equal(t.runs(), 4, 'by hand never uses the cache');
});

test('UNKNOWN is never cached', () => {
  const t = baseFixture({ checks: '#!/bin/sh\necho run >> "$FACTORY_ROOT/runs"\nexit 127\n', config: { checks: { prepare: '' } } });
  assert.equal(direct(t, { job: '001-x' }).status, 'UNKNOWN');
  assert.equal(direct(t, { job: '001-x' }).status, 'UNKNOWN');
  assert.equal(t.runs(), 2);
  assert.deepEqual(t.state().results, {});
});

test('a new sha keeps an ignored file and drops an untracked one', () => {
  const t = baseFixture({ checks: GREEN, config: { checks: { prepare: '' } } });
  assert.equal(t.base().status, 0);
  const wt = join(t.root, '.worktrees/.base');
  writeFileSync(join(wt, 'ignored.dat'), 'keep\n');
  writeFileSync(join(wt, 'untracked.txt'), 'drop\n');
  const sha = t.push({ 'moved.txt': 'm\n' });
  assert.equal(t.base().status, 0);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), sha);
  assert.equal(existsSync(join(wt, 'ignored.dat')), true);
  assert.equal(existsSync(join(wt, 'untracked.txt')), false);
  assert.equal(existsSync(join(wt, 'moved.txt')), true);
});

test('the state keeps at most 50 results, the newest', () => {
  let state = { version: 1, base: 'origin/main', full: null, results: {} };
  for (let i = 0; i < 55; i += 1) {
    const key = i.toString(16).padStart(64, '0');
    state = recordResult(state, { key, sha: 'a'.repeat(40), scope: 'full', status: i % 2 ? 'PASS' : 'FAIL', at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
  }
  assert.equal(MAX_RESULTS, 50);
  assert.equal(Object.keys(state.results).length, 50);
  assert.equal(Object.hasOwn(state.results, (0).toString(16).padStart(64, '0')), false, 'the oldest is dropped');
  assert.equal(Object.hasOwn(state.results, (54).toString(16).padStart(64, '0')), true);
});

test('prepare: the default is none without a manifest, "" turns it off, the step never sees FACTORY_* variables', () => {
  const t = baseFixture({ checks: GREEN });
  assert.equal(t.base().status, 0);
  assert.equal(t.state().full.prepare, '');
  const dump = join(t.dir, 'prepare-env');
  const u = baseFixture({ checks: GREEN, config: { checks: { prepare: `env > '${dump}'` } } });
  assert.equal(u.base([], { FACTORY_BASE: 'x', FACTORY_HEAD: 'y', NODE_TEST_CONTEXT: 'child-v8' }).status, 0);
  const seen = readFileSync(dump, 'utf8');
  assert.doesNotMatch(seen, /^FACTORY_/m);
  assert.doesNotMatch(seen, /^NODE_TEST_CONTEXT=/m);
  assert.equal(u.state().full.prepare, `env > '${dump}'`);
});

test('prepare: the default installs from the lockfile with the package manager, by argv (no shell)', () => {
  const t = baseFixture({ checks: GREEN, files: { 'package.json': '{"name":"x"}\n', 'pnpm-lock.yaml': '' } });
  const bin = join(t.dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\necho "pnpm $*" > '${join(t.dir, 'pnpm-args')}'\n`, { mode: 0o755 });
  const res = t.base([], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(readFileSync(join(t.dir, 'pnpm-args'), 'utf8').trim(), 'pnpm install --frozen-lockfile --prefer-offline');
  assert.equal(t.state().full.prepare, 'pnpm install --frozen-lockfile --prefer-offline');
});

test('the scope key: a checks.sh that names FACTORY_BASE gets the job\'s files; one that does not is checked in full', () => {
  const scoped = baseFixture({ checks: '#!/bin/sh\nprintf "%s %s\\n" "${FACTORY_BASE-unset}" "${FACTORY_HEAD-unset}" >> "$FACTORY_ROOT/runs"\n', config: { checks: { prepare: '' } } });
  const from = scoped.tip();
  const head = scoped.push({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const res = direct(scoped, { job: '001-x', scope: { base: from, head } });
  assert.equal(res.status, 'PASS');
  assert.match(res.scope, /^files:[0-9a-f]{64}$/);
  assert.equal(res.files, 2);
  assert.equal(readFileSync(join(scoped.root, 'runs'), 'utf8').trim(), `${from} ${head}`);
  const other = direct(scoped, { job: '001-x', scope: { base: from, head: from } });
  assert.notEqual(other.key, res.key, 'another set of files is another key');
  const plain = baseFixture({ checks: GREEN, config: { checks: { prepare: '' } } });
  const p = direct(plain, { job: '001-x', scope: { base: plain.tip(), head: plain.tip() } });
  assert.equal(p.scope, 'full');
  const bad = direct(plain, { job: '001-x', scope: { base: 'zz', head: 'not-a-sha' } });
  assert.equal(bad.scope, 'full', 'only hex shas make a scope');
});

test('an unresolvable base, a failed fetch with a local ref, and a symlinked state folder', () => {
  const missing = baseFixture({ checks: GREEN, config: { base: 'origin/nope' } });
  const res = missing.base();
  assert.equal(res.status, 3);
  assert.match(res.stdout, /^base: UNKNOWN origin\/nope: /m);

  const offline = baseFixture({ checks: GREEN, config: { checks: { prepare: '' } } });
  git(offline.root, 'remote', 'set-url', 'origin', join(offline.dir, 'gone.git'));
  assert.equal(offline.base().status, 0, 'the local origin/main still answers');

  const linked = baseFixture({ checks: GREEN });
  mkdirSync(join(linked.root, 'factory/jobs'), { recursive: true });
  mkdirSync(join(linked.dir, 'elsewhere'));
  symlinkSync(join(linked.dir, 'elsewhere'), join(linked.root, 'factory/jobs/.base'));
  const l = linked.base();
  assert.equal(l.status, 3);
  assert.match(l.stdout, /^base: UNKNOWN .*not private|not a plain folder/m);
  assert.equal(existsSync(join(linked.dir, 'elsewhere/state.json')), false, 'nothing is written through the link');
});

test('usage: an unknown argument is exit 2', () => {
  const t = baseFixture();
  const res = t.base(['--what']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /^usage: base/);
});
