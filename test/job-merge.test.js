// Job 014: auto_merge flag, approve>merged and awaiting-merge transitions. Same fake-gh
// harness as test/job.test.js (protected, so the helpers are copied, not imported).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const configText = readFileSync(join(repo, 'factory/config.json'), 'utf8');

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const CHECKS = `#!/bin/sh
echo "checks: running"
if [ -f BROKEN ]; then echo "checks: BROKEN is present"; exit 1; fi
echo "checks: ok"
`;

// CommonJS on purpose: the temp folder has no package.json.
const fakeGh = (stateFile, logFile) => `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const entry = { args };
if (flag('--body') !== undefined) entry.body = flag('--body');
if (flag('--body-file') !== undefined) entry.body = fs.readFileSync(flag('--body-file'), 'utf8');
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(entry) + '\\n');
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state, null, 2));
const out = (value) => process.stdout.write(JSON.stringify(value));
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const [a, b, n] = args;
const issue = state.issues[n];
const pr = state.prs.find((p) => String(p.number) === n);
if (a === 'issue' && b === 'view') { if (!issue) fail('no such issue'); out(issue); }
else if (a === 'issue' && b === 'comment') {
  if (!issue) fail('no such issue');
  issue.comments.push({ author: { login: state.viewer }, body: entry.body, createdAt: new Date().toISOString(), viewerDidAuthor: true });
  save();
} else if (a === 'issue' && b === 'edit') {
  if (!issue) fail('no such issue');
  if (flag('--add-label')) issue.labels.push({ name: flag('--add-label') });
  if (flag('--remove-label')) issue.labels = issue.labels.filter((l) => l.name !== flag('--remove-label'));
  save();
} else if (a === 'pr' && b === 'list') {
  out(state.prs.filter((p) => p.headRefName === flag('--head') && p.state === 'OPEN'));
} else if (a === 'pr' && b === 'view') { if (!pr) fail('no such pr'); out(pr); }
else if (a === 'pr' && b === 'merge') { if (!pr) fail('no such pr'); pr.state = 'MERGED'; save(); }
else if (a === 'pr' && (b === 'ready' || b === 'comment')) { if (!pr) fail('no such pr'); }
`;

// Async, so the tests below can run concurrently (each has its own temp root).
function runAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function setup({ viewer = 'factory-owner', autoMerge } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-job-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\nfactory/board.json\n.worktrees/\n');
  const cfg = JSON.parse(configText);
  delete cfg.auto_merge;
  if (autoMerge !== undefined) cfg.auto_merge = autoMerge;
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(cfg));
  writeFileSync(join(root, 'factory/checks.sh'), CHECKS);
  writeFileSync(join(root, 'app.txt'), 'v1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');

  const stateFile = join(dir, 'gh-state.json');
  const logFile = join(dir, 'gh-log.jsonl');
  const gh = join(dir, 'gh');
  writeFileSync(stateFile, JSON.stringify({ viewer, issues: {}, prs: [] }));
  writeFileSync(logFile, '');
  writeFileSync(gh, fakeGh(stateFile, logFile));
  chmodSync(gh, 0o755);

  const env = {
    ...process.env, ...GIT_ENV, FACTORY_ROOT: root, FACTORY_GH: gh, FACTORY_TRANSCRIPTS: join(dir, 'transcripts'),
  };
  const jobsDir = join(root, 'factory/jobs');
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const setState = (fn) => { const s = state(); fn(s); writeFileSync(stateFile, JSON.stringify(s)); };

  return {
    dir, root, origin, gh, env,
    job: (...args) => runAsync(join(repo, 'factory/bin/job'), args, { cwd: root, env }),
    raw: (id) => readFileSync(join(jobsDir, id, 'job.json'), 'utf8'),
    json: (id) => JSON.parse(readFileSync(join(jobsDir, id, 'job.json'), 'utf8')),
    read: (id, rel) => readFileSync(join(jobsDir, id, rel), 'utf8'),
    write(id, rel, text) {
      const file = join(jobsDir, id, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    issue(n, fields = {}) {
      setState((s) => {
        s.issues[n] = {
          number: n, title: `Issue ${n}`, body: 'Please build it.', state: 'OPEN',
          author: { login: 'alice' }, labels: [{ name: 'factory' }], comments: [], ...fields,
        };
      });
    },
    comment(n, login, body) {
      setState((s) => { s.issues[n].comments.push({ author: { login }, body, createdAt: new Date().toISOString() }); });
    },
    pr(number, headRefName, fields = {}) {
      setState((s) => {
        s.prs.push({
          number, headRefName, state: 'OPEN', isCrossRepository: false, headRepositoryOwner: { login: 'bqsistemas' },
          reviews: [], comments: [], ...fields,
        });
      });
    },
    setPr(number, fields) {
      setState((s) => { Object.assign(s.prs.find((p) => p.number === number), fields); });
    },
    state,
    calls: () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    jobIds: () => (existsSync(jobsDir) ? readdirSync(jobsDir) : [])
      .filter((d) => existsSync(join(jobsDir, d, 'job.json'))).sort(),
    board: () => JSON.parse(readFileSync(join(root, 'factory/board.json'), 'utf8')),
  };
}

// A successful transition: exit 0, and board.json lists every job.json.
function ok(t, res) {
  assert.equal(res.status, 0, `expected success, got ${res.status}: ${res.stderr}`);
  assert.deepEqual(t.board().jobs.map((j) => j.id), t.jobIds(), 'board.json lists every job.json');
  return res.stdout.trim();
}

// A refused transition: exit 1, `refused:` on stderr, job.json byte-identical.
async function refused(t, id, ...args) {
  const before = t.raw(id);
  const res = await t.job(id, ...args);
  assert.equal(res.status, 1, `expected refusal for ${args.join(' ')}, got ${res.status}: ${res.stdout}${res.stderr}`);
  assert.match(res.stderr, /^refused: /m);
  assert.equal(t.raw(id), before, `job.json byte-identical after ${args.join(' ')}`);
}

const INTAKE = (decision, risk = 'low', surfaces = 'none') =>
  `${decision}\nRISK: ${risk}\nSURFACES: ${surfaces}\nRESCOPED: no\n\n## Scope\nThe toggle only.\n\n## Reason\nClear request.\n`;

// Drives a fresh job from intake to the start of a gate check in round 1.
async function toGate(t, id, pr = 31) {
  t.write(id, 'intake.md', INTAKE('ACCEPT'));
  ok(t, await t.job(id, 'to', 'spec'));
  t.write(id, 'spec.md', '# Spec\n');
  ok(t, await t.job(id, 'to', 'build'));
  t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
  t.pr(pr, `factory/${id}`);
  ok(t, await t.job(id, 'to', 'gate'));
}

// From gate, with a passing gate and passing reviews, to approve.
async function gateToApprove(t, id) {
  const { round } = t.json(id);
  t.write(id, `round-${round}/checks.md`, 'GATE: PASS\n');
  ok(t, await t.job(id, 'to', 'review'));
  for (const lens of Object.keys(t.json(id).reviews)) {
    t.write(id, `round-${round}/review-${lens}.md`, 'VERDICT: PASS\n');
  }
  ok(t, await t.job(id, 'to', 'approve'));
}

const noMerge = (t) => !t.calls().some(({ args }) => args[0] === 'pr' && args[1] === 'merge');

function branchBehindMain(t, id, mainFile) {
  const { worktree } = t.json(id);
  writeFileSync(join(worktree, 'feature.txt'), 'feature\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'feat: branch work');
  writeFileSync(join(t.root, mainFile[0]), mainFile[1]);
  git(t.root, 'add', '.');
  git(t.root, 'commit', '-q', '-m', 'feat: main moved on');
  git(t.root, 'push', '-q', 'origin', 'main');
}

async function approved(t, mainFile = ['main.txt', 'main\n']) {
  t.issue(7, { title: 'Merge me' });
  const id = ok(t, await t.job('new', '7'));
  await toGate(t, id);
  branchBehindMain(t, id, mainFile);
  await gateToApprove(t, id);
  t.write(id, 'decision.md', 'APPROVE\nAll good.\n');
  return id;
}

// A job parked in awaiting-merge with PR 31 open.
async function awaiting(t) {
  const id = await approved(t);
  assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} awaiting-merge`);
  return id;
}

describe('job 014: auto_merge and awaiting-merge', { concurrency: true }, () => {
  for (const value of [false, 'false']) {
    test(`AC-1: auto_merge ${JSON.stringify(value)} readies the PR, comments, and parks in awaiting-merge`, async () => {
      const t = setup({ autoMerge: value });
      const id = await approved(t);
      const before = t.calls().length;
      assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} awaiting-merge`);
      const job = t.json(id);
      assert.equal(job.stage, 'awaiting-merge');
      assert.equal(job.finished, null);
      assert.match(job.note, /PR #31/);
      assert.ok(existsSync(job.worktree), 'worktree kept');
      assert.equal(git(t.origin, 'show', `factory/${id}:main.txt`), 'main', 'origin/main merged into the branch');
      assert.equal(t.read(id, 'merge-checks.md').split('\n')[0], 'GATE: PASS');
      const calls = t.calls().slice(before);
      const names = calls.map(({ args }) => args.slice(0, 3).join(' '));
      const ready = names.indexOf('pr ready 31');
      const comment = names.findIndex((n) => n === 'pr comment 31');
      assert.ok(ready >= 0 && comment > ready, 'pr ready, then pr comment');
      assert.ok(calls[comment].args.includes('--body-file'));
      assert.ok(calls[comment].body.startsWith(`<!-- factory:note ${id} -->`), 'rework ignores it');
      assert.match(calls[comment].body, /auto_merge/);
      assert.ok(noMerge(t), 'pr merge never called');
      assert.equal(t.board().jobs.find((j) => j.id === id).stage, 'awaiting-merge');
    });
  }

  for (const [label, autoMerge] of [['missing', undefined], ['true', true]]) {
    test(`AC-2: auto_merge ${label} still merges exactly the pushed commit`, async () => {
      const t = setup({ autoMerge });
      const id = await approved(t);
      const before = t.calls().length;
      assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} merged`);
      const calls = t.calls().slice(before).map(({ args }) => args);
      const ready = calls.findIndex((a) => a[0] === 'pr' && a[1] === 'ready');
      const merge = calls.findIndex((a) => a[0] === 'pr' && a[1] === 'merge');
      assert.ok(ready >= 0 && merge > ready);
      const pushed = git(t.origin, 'rev-parse', `factory/${id}`);
      assert.deepEqual(calls[merge], ['pr', 'merge', '31', '--merge', '--match-head-commit', pushed]);
    });
  }

  for (const value of [0, null, 'no']) {
    test(`AC-1: auto_merge ${JSON.stringify(value)} is treated as off`, async () => {
      const t = setup({ autoMerge: value });
      const id = await approved(t);
      assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} awaiting-merge`);
      assert.ok(noMerge(t));
    });
  }

  test('AC-3: auto_merge false and a failing post-sync gate ends in needs-human with no comment and no merge', async () => {
    const t = setup({ autoMerge: false });
    const id = await approved(t, ['BROKEN', 'main broke the build\n']);
    assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} needs-human`);
    const job = t.json(id);
    assert.equal(job.stage, 'needs-human');
    assert.equal(job.parked_from, 'merging');
    assert.match(job.note, /check/i);
    assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
    assert.ok(noMerge(t));
    assert.ok(!t.calls().some((c) => /ready for review|reviewer should/i.test(c.body ?? '')), 'no ready-for-review comment');
  });

  test('AC-4: awaiting-merge refuses while the PR is open, then finishes once it is merged', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    const before = t.raw(id);
    const res = await t.job(id, 'to', 'merged');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /refused:/);
    assert.match(res.stderr, /still waiting/);
    assert.equal(t.raw(id), before);
    t.setPr(31, { state: 'MERGED' });
    assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
    const job = t.json(id);
    assert.ok(Date.parse(job.finished));
    assert.match(job.note, /merged outside the factory/);
    assert.ok(!existsSync(job.worktree), 'worktree removed');
    assert.ok(noMerge(t));
  });

  test('AC-5: approve to merged needs a merged PR and never calls pr merge', async () => {
    const t = setup({ autoMerge: false });
    const id = await approved(t);
    await refused(t, id, 'to', 'merged');
    t.setPr(31, { state: 'MERGED' });
    assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
    assert.match(t.json(id).note, /merged outside the factory/);
    assert.ok(noMerge(t));
  });

  test('AC-5: approve to merged is refused when the job has no PR', async () => {
    const t = setup();
    const id = await approved(t);
    const file = join(t.root, 'factory/jobs', id, 'job.json');
    const job = JSON.parse(readFileSync(file, 'utf8'));
    job.pr = null;
    writeFileSync(file, JSON.stringify(job, null, 2));
    t.setPr(31, { state: 'MERGED' });
    await refused(t, id, 'to', 'merged');
  });

  test('AC-6: awaiting-merge escalates to needs-human only with a note', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    await refused(t, id, 'to', 'needs-human');
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'PR closed'));
    const job = t.json(id);
    assert.equal(job.stage, 'needs-human');
    assert.equal(job.parked_from, 'awaiting-merge');
    assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
    t.setPr(31, { state: 'MERGED' });
    assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
  });
});
