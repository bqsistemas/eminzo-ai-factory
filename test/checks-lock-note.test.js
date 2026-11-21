// While a gate waits for the repository's checks lock, the job's own note says so (job.json and board.json,
// written through job.js's save path), and it goes back to what it was the moment the lock is taken, before
// checks.sh starts. Both gate entry points are covered: `gate <id>` and the merge gate inside `job <id> to merging`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INTAKE, approvedWithRealGate, git, ok, setup } from './helpers/config-local-harness.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const gateUrl = pathToFileURL(join(repo, 'factory/lib/gate.js')).href;
const WAITING = /^waiting for the checks of this repository: gate 044-other runs them since \d\d:\d\d$/;
// Records what the job's note was when checks.sh started: the note must be back before that.
const snapshotChecks = (tail = '') => `#!/bin/sh\necho run >> "$CHECKS_COUNT"\ncp "$FACTORY_ROOT/factory/jobs/$JOB/job.json" "$SNAP"\n${tail}echo "checks: ok"\n`;

const until = async (check, what, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A live process that is not an ancestor of anything: the other job's checks. */
function plantHolder(ctx, lockFile, label = 'gate 044-other') {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  ctx.after(() => child.kill());
  mkdirSync(join(lockFile, '..'), { recursive: true });
  writeFileSync(lockFile, JSON.stringify({ pid: child.pid, started: new Date().toISOString(), label }));
  return child;
}

/** A job at stage gate with a committed branch (what approvedWithRealGate does up to `to gate`). */
async function atGate() {
  const t = setup();
  t.issue(7);
  const id = ok(await t.job('new', '7'));
  t.write(id, 'intake.md', INTAKE);
  ok(await t.job(id, 'to', 'spec'));
  t.write(id, 'spec.md', '# Spec\n');
  ok(await t.job(id, 'to', 'build'));
  const { worktree } = t.json(id);
  writeFileSync(join(worktree, 'feature.txt'), 'feature\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'feat: branch work');
  t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
  t.pr(31, `factory/${id}`);
  ok(await t.job(id, 'to', 'gate'));
  return { t, id };
}

/** Makes the next gate of `t` use an explicit lock file (the harness's default would be no lock under a test run) and record the note at checks time. */
function arm(t, id, checks, env = {}) {
  const lock = join(t.root, 'factory/jobs/.checks.lock');
  const snap = join(t.dir, 'snap.json');
  writeFileSync(join(t.root, 'factory/checks.sh'), checks);
  Object.assign(t.env, { FACTORY_CHECKS_LOCK: lock, FACTORY_CHECKS_LOCK_POLL_MS: '30', FACTORY_CHECKS_LOCK_WAIT_MS: '30000', SNAP: snap, JOB: id }, env);
  return { lock, snapNote: () => JSON.parse(readFileSync(snap, 'utf8')).note };
}

const setNote = (t, id, note) => t.write(id, 'job.json', JSON.stringify({ ...t.json(id), note }, null, 2));
const boardNote = (t, id) => t.board().jobs.find((j) => j.id === id)?.note;

test('gate <id> shows the wait in the job note (job.json and board.json) and restores the note before checks.sh starts', async (ctx) => {
  const { t, id } = await atGate();
  const { lock, snapNote } = arm(t, id, snapshotChecks());
  setNote(t, id, 'previous note');
  const child = plantHolder(ctx, lock);
  let done = false;
  const run = t.bin('gate', [id]).then((res) => { done = true; return res; });
  await until(() => WAITING.test(t.json(id).note), 'the waiting note in job.json');
  await until(() => WAITING.test(boardNote(t, id) ?? ''), 'the waiting note in board.json'); // saved right after job.json
  assert.equal(done, false, 'the gate is still waiting');
  child.kill();
  const res = await run;
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(snapNote(), 'previous note', 'back before checks.sh started');
  assert.equal(t.json(id).note, 'previous note');
  assert.equal(boardNote(t, id), 'previous note');
  assert.match(res.stderr, /waiting for them to finish/, 'the stderr message stays');
  assert.equal(t.read(id, 'round-1/checks.md').split('\n')[0], 'GATE: PASS');
});

test('gate <id> restores the note when the wait cap runs out and the checks run anyway', async (ctx) => {
  const { t, id } = await atGate();
  const { lock, snapNote } = arm(t, id, snapshotChecks(), { FACTORY_CHECKS_LOCK_WAIT_MS: '300' });
  setNote(t, id, 'previous note');
  plantHolder(ctx, lock);
  const res = await t.bin('gate', [id]);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stderr, /running anyway/);
  assert.equal(snapNote(), 'previous note');
  assert.equal(t.json(id).note, 'previous note');
  assert.equal(boardNote(t, id), 'previous note');
});

test('gate <id> with a failing checks.sh still leaves the note as it was', async (ctx) => {
  const { t, id } = await atGate();
  const { lock, snapNote } = arm(t, id, snapshotChecks('exit 1\n'));
  setNote(t, id, '');
  const child = plantHolder(ctx, lock);
  const run = t.bin('gate', [id]);
  await until(() => WAITING.test(t.json(id).note), 'the waiting note');
  child.kill();
  const res = await run;
  assert.equal(res.status, 1);
  assert.equal(snapNote(), '');
  assert.equal(t.json(id).note, '');
  assert.equal(t.read(id, 'round-1/checks.md').split('\n')[0], 'GATE: FAIL');
});

test('a gate that does not wait never touches job.json or board.json', async () => {
  const { t, id } = await atGate();
  arm(t, id, snapshotChecks());
  setNote(t, id, 'previous note');
  const before = t.raw(id);
  const boardBefore = existsSync(t.boardPath) ? statSync(t.boardPath).mtimeMs : null;
  const res = await t.bin('gate', [id]);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(t.raw(id), before, 'job.json is byte for byte the same');
  assert.equal(existsSync(t.boardPath) ? statSync(t.boardPath).mtimeMs : null, boardBefore, 'board.json is not rewritten');
});

test('the merge gate shows the wait in the job note too, and the note moves on once the lock is taken', async (ctx) => {
  const t = setup();
  const id = await approvedWithRealGate(t);
  const { lock, snapNote } = arm(t, id, snapshotChecks());
  t.local({ concurrency: 1 }); // the round gate's inputs changed: the merge runs the checks again
  const child = plantHolder(ctx, lock);
  const run = t.job(id, 'to', 'merging');
  await until(() => WAITING.test(t.json(id).note), 'the waiting note in job.json');
  assert.equal(t.json(id).stage, 'merging');
  await until(() => WAITING.test(boardNote(t, id) ?? ''), 'the waiting note in board.json');
  child.kill();
  assert.equal(ok(await run), `${id} merged`);
  assert.match(snapNote(), /^syncing with /, 'the merge note was back before checks.sh started');
  assert.equal(existsSync(join(t.root, 'factory/jobs', id, 'merge-checks.md')), true);
});

// The hooks of runChecks: onWait when the wait starts, onAcquire before checks.sh starts (also when the wait ran out).
function hookRun(t, root, extra = {}, hooks = 'onWait: ({ holder }) => log(`wait ${holder}`), onAcquire: () => log("acquire")') {
  const runner = join(t.dir, 'hooks-runner.mjs');
  writeFileSync(runner, `import { appendFileSync } from 'node:fs';
import { runChecks } from ${JSON.stringify(gateUrl)};
const log = (line) => appendFileSync(process.env.OUT + '/log', line + '\\n');
const r = runChecks(process.argv[2], process.argv[2], { label: 'nudge x', ${hooks} });
process.exit(r.code);`);
  const env = { ...process.env, OUT: t.dir, FACTORY_CHECKS_LOCK_POLL_MS: '30', ...extra };
  for (const name of ['FACTORY_CHECKS_LOCK', 'FACTORY_CHECKS_LOCK_HELD', 'NODE_TEST_CONTEXT']) delete env[name];
  Object.assign(env, extra);
  return spawnSync(process.execPath, [runner, root], { encoding: 'utf8', env, timeout: 60_000 });
}

function hookSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lock-hooks-'));
  const root = join(dir, 'root');
  mkdirSync(join(root, 'factory/jobs'), { recursive: true });
  writeFileSync(join(root, 'factory/checks.sh'), '#!/bin/sh\necho checks >> "$OUT/log"\n', { mode: 0o755 });
  const log = () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n') : []);
  return { dir, root, log };
}

test('runChecks calls onWait when the wait starts and onAcquire before checks.sh starts', (ctx) => {
  const t = hookSetup();
  // An orphaned sleep: it ends by itself and nobody has to reap it, so its lock is stale afterwards.
  const pid = Number(execFileSync('sh', ['-c', 'sleep 0.8 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }));
  ctx.after(() => { try { process.kill(pid); } catch { /* gone */ } });
  writeFileSync(join(t.root, 'factory/jobs/.checks.lock'), JSON.stringify({ pid, started: new Date().toISOString(), label: 'gate 044-other' }));
  const res = hookRun(t, t.root, { FACTORY_CHECKS_LOCK_WAIT_MS: '20000' });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(t.log(), ['wait gate 044-other', 'acquire', 'checks']);
});

test('runChecks calls onAcquire also when the wait cap runs out, and never calls either without a wait', (ctx) => {
  const t = hookSetup();
  const child = plantHolder(ctx, join(t.root, 'factory/jobs/.checks.lock'));
  assert.equal(hookRun(t, t.root, { FACTORY_CHECKS_LOCK_WAIT_MS: '300' }).status, 0);
  assert.deepEqual(t.log(), ['wait gate 044-other', 'acquire', 'checks']);
  child.kill();
  const quiet = hookSetup();
  assert.equal(hookRun(quiet, quiet.root).status, 0);
  assert.deepEqual(quiet.log(), ['checks']);
});

test('a hook that throws never fails the checks', (ctx) => {
  const t = hookSetup();
  plantHolder(ctx, join(t.root, 'factory/jobs/.checks.lock'));
  const res = hookRun(t, t.root, { FACTORY_CHECKS_LOCK_WAIT_MS: '300' }, 'onWait: () => { throw new Error("boom"); }, onAcquire: () => { log("acquire"); throw new Error("boom"); }');
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(t.log(), ['acquire', 'checks']);
});

// gate.js must not import job.js (job.js imports gate.js): a graph that enters one and reaches the other again fails at load time.
test('every module that can start a gate loads on its own, whichever it enters first', () => {
  for (const file of ['gate.js', 'gate-cli.js', 'job.js', 'stacks.js', 'base.js', 'nudge.js']) {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(repo, 'factory/lib', file)).href)});`], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${file}: ${res.stderr}`);
  }
});
