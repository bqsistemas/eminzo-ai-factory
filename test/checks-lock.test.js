// One full checks run at a time per repository: runChecks takes <root>/factory/jobs/.checks.lock around a
// full checks.sh, so jobs of the same repository do not run their suites together. The lock only delays:
// a dead holder is taken over, a long wait runs anyway, a lock that cannot be written is skipped. A run
// started from inside the checks never waits for itself. Other repositories and focused runs never wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const gateUrl = pathToFileURL(join(repo, 'factory/lib/gate.js')).href;
// argv: root, label, mode. Prints the checks output, then a JSON line with what runChecks returned.
const RUNNER = `import { runChecks } from ${JSON.stringify(gateUrl)};
const [root, label, mode] = process.argv.slice(2);
const opts = { label, ...(mode === 'focused' ? { mode, changedFiles: '/dev/null' } : {}) };
const r = runChecks(root, root, opts);
process.stdout.write(r.output);
process.stdout.write('RESULT ' + JSON.stringify({ code: r.code, waitedMs: r.waitedMs, waitedFor: r.waitedFor }) + '\\n');
process.exit(r.code);`;
const SLOW = '#!/bin/sh\necho start >> "$OUT/log"\nsleep 0.6\necho end >> "$OUT/log"\n';
const QUICK = '#!/bin/sh\necho ran >> "$OUT/log"\n';

function setup(checks = SLOW) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-checks-lock-'));
  const out = join(dir, 'out');
  mkdirSync(out);
  const root = (name, script = checks, config) => {
    const path = join(dir, name);
    mkdirSync(join(path, 'factory/jobs'), { recursive: true });
    writeFileSync(join(path, 'factory/checks.sh'), script, { mode: 0o755 });
    if (config) writeFileSync(join(path, 'factory/config.json'), JSON.stringify(config));
    return path;
  };
  // The suite itself runs under NODE_TEST_CONTEXT (no lock by default) and may run inside a gate that holds a
  // lock: start the children from a clean slate and ask for the real default lock.
  const base = { ...process.env, OUT: out, FACTORY_CHECKS_LOCK_POLL_MS: '30' };
  for (const name of ['FACTORY_CHECKS_LOCK', 'FACTORY_CHECKS_LOCK_HELD', 'FACTORY_CHECKS_LOCK_WAIT_MS', 'NODE_TEST_CONTEXT']) delete base[name];
  const runner = join(dir, 'runner.mjs');
  writeFileSync(runner, RUNNER);
  const args = (path, label, mode) => [runner, path, label ?? '', mode ?? ''];
  const parse = (stdout) => {
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
    return line ? JSON.parse(line.slice(7)) : null;
  };
  return {
    dir, out, root, base, parse, runner,
    lockOf: (path) => join(path, 'factory/jobs/.checks.lock'),
    log: () => (existsSync(join(out, 'log')) ? readFileSync(join(out, 'log'), 'utf8').trim().split('\n') : []),
    runSync: (path, { label, mode, ...extra } = {}) => spawnSync(process.execPath, args(path, label, mode), { encoding: 'utf8', env: { ...base, ...extra }, timeout: 60_000 }),
    runAsync: (path, { label, mode, ...extra } = {}) => new Promise((resolve) => {
      const child = spawn(process.execPath, args(path, label, mode), { env: { ...base, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    }),
  };
}

const plant = (file, holder, label = 'gate 045-feat-x', started = new Date().toISOString()) => {
  mkdirSync(dirname(file), { recursive: true });
  const text = JSON.stringify({ pid: holder, started, label });
  writeFileSync(file, text);
  return text;
};

test('two full runs in one repository never overlap, and the second reports who it waited for', async () => {
  const t = setup();
  const root = t.root('a');
  const first = t.runAsync(root, { label: 'gate 001-one' });
  await new Promise((r) => setTimeout(r, 300)); // the first one holds the lock before the second starts
  const second = await t.runAsync(root, { label: 'gate 002-two' });
  const one = await first;
  assert.equal(one.code, 0);
  assert.equal(second.code, 0);
  assert.deepEqual(t.log(), ['start', 'end', 'start', 'end']);
  assert.equal(t.parse(one.stdout).waitedFor, null);
  const waited = t.parse(second.stdout);
  assert.equal(waited.waitedFor, 'gate 001-one');
  assert.ok(waited.waitedMs >= 200, `waited ${waited.waitedMs}ms`);
  assert.match(second.stderr, /the checks of this repository are running for gate 001-one \(since \d\d:\d\d:\d\d\); waiting for them to finish\. Set checks\.lock to "off" in factory\/config\.json to disable\./);
  assert.equal(second.stderr.match(/waiting for them/g).length, 1, 'said once');
  assert.equal(existsSync(t.lockOf(root)), false, 'the lock is released');
});

test('full runs in two different repositories do not wait for each other', async () => {
  const t = setup();
  const results = await Promise.all([t.runAsync(t.root('a')), t.runAsync(t.root('b'))]);
  assert.deepEqual(results.map((r) => r.code), [0, 0]);
  assert.deepEqual(t.log(), ['start', 'start', 'end', 'end']);
});

test('a focused run neither takes nor waits for the lock', () => {
  const t = setup('#!/bin/sh\ntest -e "$LOCKFILE" && echo "lock-present" >> "$OUT/log"\necho "$FACTORY_CHECK_MODE" >> "$OUT/log"\n');
  const root = t.root('a');
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const text = plant(t.lockOf(root), holder.pid);
    const res = t.runSync(root, { mode: 'focused', FACTORY_CHECKS_LOCK_WAIT_MS: '60000', LOCKFILE: join(root, 'nothing') });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(t.log(), ['focused']);
    assert.deepEqual(t.parse(res.stdout), { code: 0, waitedMs: 0, waitedFor: null });
    assert.equal(readFileSync(t.lockOf(root), 'utf8'), text, 'the holder is untouched');
  } finally {
    holder.kill();
  }
});

test('the checks see the lock held (also the file of the lock) and a failing run still releases it', () => {
  const t = setup();
  const root = t.root('a');
  writeFileSync(join(root, 'factory/checks.sh'), `#!/bin/sh\ntest -f "${join(root, 'factory/jobs/.checks.lock')}" && echo "held=$FACTORY_CHECKS_LOCK_HELD"\ntest -f "${join(root, 'factory/jobs/.checks.lock.child')}" && echo child-written\nexit 3\n`);
  const res = t.runSync(root, { label: 'base' });
  assert.equal(res.status, 3);
  assert.match(res.stdout, /held=1/);
  assert.match(res.stdout, /child-written/);
  assert.equal(existsSync(t.lockOf(root)), false);
  assert.equal(existsSync(`${t.lockOf(root)}.child`), false);
});

test('the lock is released when the run throws', () => {
  const t = setup(QUICK);
  const root = t.root('a');
  // A cwd that does not exist makes the spawn fail inside the locked section.
  const code = `import { runChecks } from ${JSON.stringify(gateUrl)};
const r = runChecks(process.argv[1], process.argv[1] + '/missing-cwd', { label: 'gate x' });
process.stdout.write(JSON.stringify({ code: r.code, failedToStart: r.failedToStart }));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code, root], { encoding: 'utf8', env: t.base });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).failedToStart, true);
  assert.equal(existsSync(t.lockOf(root)), false);
});

test('a checks run started from inside the checks does not wait for itself', () => {
  const t = setup();
  const inner = t.root('inner', '#!/bin/sh\necho inner >> "$OUT/log"\n');
  const nested = (prefix) => `#!/bin/sh\n${prefix}${JSON.stringify(process.execPath)} ${JSON.stringify(t.runner)} ${JSON.stringify(inner)} gate-inner || exit 9\necho outer >> "$OUT/log"\n`;
  const marked = t.runSync(t.root('marked', nested('')), { FACTORY_CHECKS_LOCK_WAIT_MS: '20000' });
  assert.equal(marked.status, 0, marked.stderr);
  // Without the marker (a harness that builds its own environment) the holder is still an ancestor.
  const bare = t.runSync(t.root('bare', nested('env -u FACTORY_CHECKS_LOCK_HELD ')), { FACTORY_CHECKS_LOCK_WAIT_MS: '20000' });
  assert.equal(bare.status, 0, bare.stderr);
  assert.doesNotMatch(bare.stderr, /running anyway/);
  assert.deepEqual(t.log(), ['inner', 'outer', 'inner', 'outer']);
});

test('the ancestor check alone finds a holder that is an ancestor of the run', () => {
  const t = setup(QUICK);
  const root = t.root('a');
  // This process is the holder and the parent of the child that asks for the lock; the marker is not passed.
  plant(t.lockOf(root), process.pid);
  const res = t.runSync(root, { FACTORY_CHECKS_LOCK_WAIT_MS: '20000' });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /waiting|running anyway/);
  assert.deepEqual(t.log(), ['ran']);
});

test('a dead holder is taken over at once', () => {
  const t = setup(QUICK);
  const root = t.root('a');
  plant(t.lockOf(root), 2 ** 22 + 12345);
  const res = t.runSync(root);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(t.log(), ['ran']);
  assert.doesNotMatch(res.stderr, /waiting/);
  assert.equal(existsSync(t.lockOf(root)), false);
});

test('a lock file older than three hours is taken over even if its pid is alive', (ctx) => {
  const t = setup(QUICK);
  const root = t.root('a');
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  ctx.after(() => holder.kill());
  plant(t.lockOf(root), holder.pid, 'gate old', new Date(Date.now() - 4 * 3600 * 1000).toISOString());
  const res = t.runSync(root, { FACTORY_CHECKS_LOCK_WAIT_MS: '20000' });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(t.log(), ['ran']);
});

test('a live holder is waited for, and past the wait the checks run anyway and leave its lock alone', (ctx) => {
  const t = setup(QUICK);
  const root = t.root('a');
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' }); // alive, and not an ancestor of the run
  ctx.after(() => holder.kill());
  const held = plant(t.lockOf(root), holder.pid, 'merge 007-seven');
  const res = t.runSync(root, { FACTORY_CHECKS_LOCK_WAIT_MS: '300' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /running for merge 007-seven \(since /);
  assert.match(res.stderr, /running anyway/);
  assert.deepEqual(t.log(), ['ran']);
  assert.equal(t.parse(res.stdout).waitedFor, 'merge 007-seven');
  assert.equal(readFileSync(t.lockOf(root), 'utf8'), held);
});

test('a lock that cannot be written never fails the checks', () => {
  const t = setup(QUICK);
  const root = t.root('a');
  rmSync(join(root, 'factory/jobs'), { recursive: true });
  writeFileSync(join(root, 'factory/jobs'), 'a file where the lock folder should be');
  const res = t.runSync(root);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(t.log(), ['ran']);
});

test('the lock folder is created when the repository has no factory/jobs yet', () => {
  const t = setup(QUICK);
  const root = t.root('a');
  rmSync(join(root, 'factory/jobs'), { recursive: true });
  const res = t.runSync(root);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(t.log(), ['ran']);
  assert.ok(existsSync(join(root, 'factory/jobs')));
});

test('FACTORY_CHECKS_LOCK=off and checks.lock "off" run them at once, as before', async () => {
  const t = setup();
  const off = { FACTORY_CHECKS_LOCK: 'off' };
  await Promise.all([t.runAsync(t.root('a'), off), t.runAsync(t.root('a'), off)]);
  assert.deepEqual(t.log(), ['start', 'start', 'end', 'end']);

  const cfg = setup();
  const root = cfg.root('c', SLOW, { checks: { lock: 'off' } });
  await Promise.all([cfg.runAsync(root), cfg.runAsync(root)]);
  assert.deepEqual(cfg.log(), ['start', 'start', 'end', 'end']);
});

test('an invalid checks.lock value falls back to the repository lock', async () => {
  for (const value of ['machine', null]) {
    const t = setup();
    const root = t.root('a', SLOW, { checks: { lock: value } });
    await Promise.all([t.runAsync(root), t.runAsync(root)]);
    assert.deepEqual(t.log(), ['start', 'end', 'start', 'end'], `checks.lock ${JSON.stringify(value)}`);
  }
});

test('FACTORY_CHECKS_LOCK as a path is the lock file to use, and the default is no lock under a test run', async () => {
  const t = setup(QUICK);
  const root = t.root('a');
  const file = join(t.dir, 'custom/lock');
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    plant(file, holder.pid, 'gate custom');
    const res = await t.runAsync(root, { FACTORY_CHECKS_LOCK: file, FACTORY_CHECKS_LOCK_WAIT_MS: '200' });
    assert.match(res.stderr, /running for gate custom/);
    // Under a test run (NODE_TEST_CONTEXT) with no explicit lock, the held default lock is not even looked at.
    plant(t.lockOf(root), holder.pid, 'gate default');
    const quiet = await t.runAsync(root, { NODE_TEST_CONTEXT: 'child-v8', FACTORY_CHECKS_LOCK_WAIT_MS: '60000' });
    assert.equal(quiet.code, 0);
    assert.doesNotMatch(quiet.stderr, /waiting/);
  } finally {
    holder.kill();
  }
});

test('checks.lock is a team key: config.local.json may not set it', () => {
  const t = setup(QUICK);
  const root = t.root('a', QUICK, {});
  writeFileSync(join(root, 'factory/config.local.json'), JSON.stringify({ checks: { lock: 'off' } }));
  const code = `import { effectiveConfig } from ${JSON.stringify(pathToFileURL(join(repo, 'factory/lib/util.js')).href)};
try { effectiveConfig(process.argv[1], { warn() {} }); process.stdout.write('accepted'); } catch (err) { process.stdout.write('refused: ' + err.message); }`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code, root], { encoding: 'utf8' });
  assert.match(res.stdout, /^refused: config\.local\.json: checks/);
});

// The gate report: a job that waited says so, and its checks step does not count the wait.
function gateSetup(checks) {
  const t = setup(checks);
  const root = t.root('main');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = join(t.dir, 'origin.git');
  git(t.dir, 'init', '-q', '--bare', '-b', 'main', origin);
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\n.worktrees/\n');
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ base: 'origin/main', checks: {} }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  const id = '045-feat-x';
  const worktree = join(root, '.worktrees', id);
  git(root, 'worktree', 'add', '-q', worktree, '-b', `factory/${id}`, 'origin/main');
  mkdirSync(join(root, 'factory/jobs', id), { recursive: true });
  writeFileSync(join(root, 'factory/jobs', id, 'job.json'), JSON.stringify({ id, issue: 1, branch: `factory/${id}`, worktree, stage: 'gate', round: 1, max_rounds: 3 }));
  const gate = (extra = {}) => spawnSync(join(repo, 'factory/bin/gate'), [id], { cwd: root, encoding: 'utf8', env: { ...t.base, FACTORY_ROOT: root, ...extra } });
  return { ...t, root, id, gate, report: () => readFileSync(join(root, 'factory/jobs', id, 'round-1/checks.md'), 'utf8') };
}

test('the gate report names the wait and the checks step excludes it', async (ctx) => {
  const g = gateSetup('#!/bin/sh\necho ran >> "$OUT/log"\n');
  // An orphaned sleep: it ends by itself after 1.4s and nobody has to reap it, so its lock is stale from then on.
  const pid = Number(execFileSync('sh', ['-c', 'sleep 1.4 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }));
  ctx.after(() => { try { process.kill(pid); } catch { /* gone */ } });
  plant(g.lockOf(g.root), pid, 'gate 044-other');
  const res = g.gate({ FACTORY_CHECKS_LOCK_WAIT_MS: '20000' });
  assert.equal(res.status, 0, res.stderr);
  const report = g.report();
  assert.match(report, /^Waited for the checks lock: \d+s \(gate 044-other\)$/m);
  assert.match(res.stderr, /running for gate 044-other/);
  const step = report.match(/Checks \(full mode\) \| exit 0 in (\d+)s/);
  assert.ok(step, report);
  assert.ok(Number(step[1]) <= 1, `the wait is not in the checks time: ${step[0]}`);
});

test('the gate report has no waiting line when it did not wait', () => {
  const g = gateSetup('#!/bin/sh\nexit 0\n');
  const res = g.gate();
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(g.report(), /Waited for the checks lock/);
});
