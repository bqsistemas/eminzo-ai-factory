// E2: the builder runs the nudge in the foreground and waits for it, and a job never runs two nudges at
// once. `nudge` takes <job folder>/nudge.lock (its PID) while the checks run, refuses a second nudge of
// the same job while the first is alive, takes over a lock whose process is gone, and always releases it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const ID = '042-lock';
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };

function setup({ checks = '#!/bin/sh\nexit 0\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-nudge-lock-'));
  const root = join(dir, 'root');
  const worktree = join(dir, 'worktree');
  const jobDir = join(root, 'factory/jobs', ID);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), readFileSync(join(repo, 'factory/config.json')));
  writeFileSync(join(root, 'factory/checks.sh'), checks, { mode: 0o755 });
  mkdirSync(worktree);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: worktree, env: { ...process.env, ...GIT_ENV } });
  writeFileSync(join(worktree, 'a.txt'), `${Math.random()}\n`);
  execFileSync('git', ['add', '.'], { cwd: worktree, env: { ...process.env, ...GIT_ENV } });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: worktree, env: { ...process.env, ...GIT_ENV } });
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ id: ID, worktree }));
  const nudge = () => spawnSync('sh', [join(repo, 'factory/bin/nudge'), ID], {
    encoding: 'utf8', input: '', env: { ...process.env, ...GIT_ENV, FACTORY_ROOT: root },
  });
  return { jobDir, lock: join(jobDir, 'nudge.lock'), nudge };
}

/** A PID that belonged to a process that has already exited. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
}

test('AC-1: a nudge of a job whose nudge is still running is refused and leaves that lock alone', () => {
  const t = setup();
  writeFileSync(t.lock, `${process.pid}\n`);
  const res = t.nudge();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, new RegExp(`refused: nudge running \\(pid ${process.pid}\\)`));
  assert.equal(readFileSync(t.lock, 'utf8').trim(), String(process.pid));
});

test('AC-2: a lock left by a process that is gone does not block, and the nudge releases its own', () => {
  const t = setup();
  writeFileSync(t.lock, `${deadPid()}\n`);
  const res = t.nudge();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(t.lock), false);
});

test('the lock is released after a pass and after a failure', () => {
  const pass = setup();
  assert.equal(pass.nudge().status, 0);
  assert.equal(existsSync(pass.lock), false);
  const fail = setup({ checks: '#!/bin/sh\necho broken >&2\nexit 1\n' });
  assert.equal(fail.nudge().status, 2);
  assert.equal(existsSync(fail.lock), false);
});

test('a garbled lock is treated as gone', () => {
  const t = setup();
  writeFileSync(t.lock, 'not a pid\n');
  assert.equal(t.nudge().status, 0);
  assert.equal(existsSync(t.lock), false);
});

const NO_BACKGROUND = /run_in_background|pgrep|\bsleep\b/;

test('AC-3: the builder role runs the nudge in the foreground and never says to background or poll it', () => {
  const role = readFileSync(join(repo, 'factory/roles/builder.md'), 'utf8');
  const step = role.slice(role.indexOf('3. Run the repo\'s checks'), role.indexOf('4. Visual check'));
  assert.match(step, /in the foreground/);
  assert.match(step, /refused: nudge running/);
  assert.doesNotMatch(role, NO_BACKGROUND);
});

test('AC-4: the Codex builder profile says the same', () => {
  const profile = readFileSync(join(repo, '.codex/agents/eminzo-builder.toml'), 'utf8');
  assert.match(profile, /in the foreground/);
  assert.doesNotMatch(profile, NO_BACKGROUND);
});
