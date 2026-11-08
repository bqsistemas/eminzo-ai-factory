// Job 015: a human rejecting the PR (changes requested, closed). Same fake-gh
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


const review = (login, state, assoc, body = 'Please fix this.', submittedAt = '2026-01-01T00:00:00Z') =>
  ({ author: { login }, authorAssociation: assoc, state, body, submittedAt });
const names = (t, from = 0) => t.calls().slice(from).map(({ args }) => args.slice(0, 2).join(' '));
const has = (t, from, name) => names(t, from).includes(name);

describe('job 015: human rejects the PR', { concurrency: true }, () => {
  for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    test(`AC-1: a ${assoc} changes-requested review parks awaiting-merge in needs-human`, async () => {
      const t = setup({ autoMerge: false });
      const id = await awaiting(t);
      t.setPr(31, { reviews: [review('bob', 'CHANGES_REQUESTED', assoc, 'Rename the flag.')] });
      const before = t.calls().length;
      assert.equal(ok(t, await t.job(id, 'to', 'needs-human')), `${id} needs-human`);
      const job = t.json(id);
      assert.equal(job.parked_from, 'awaiting-merge');
      assert.equal(job.note, 'changes requested on PR #31');
      assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
      const calls = t.calls().slice(before);
      for (const name of ['issue comment', 'pr comment']) {
        const call = calls.find(({ args }) => args.slice(0, 2).join(' ') === name);
        assert.ok(call && call.args.includes('--body-file'), `${name} via --body-file`);
      }
      assert.ok(noMerge(t));
      ok(t, await t.job(id, 'to', 'build'));
      assert.match(t.read(id, `round-${t.json(id).round - 1}/review-human.md`), /Rename the flag\./);
    });
  }

  test('AC-1: the same no-note command parks an approve job', async () => {
    const t = setup({ autoMerge: false });
    const id = await approved(t);
    t.setPr(31, { reviews: [review('bob', 'CHANGES_REQUESTED', 'OWNER')] });
    assert.equal(ok(t, await t.job(id, 'to', 'needs-human')), `${id} needs-human`);
    const job = t.json(id);
    assert.equal(job.parked_from, 'approve');
    assert.equal(job.note, 'changes requested on PR #31');
  });

  test('AC-2: untrusted or superseded changes-requested reviews are refused', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    const before = t.calls().length;
    t.setPr(31, {
      reviews: [
        review('a', 'CHANGES_REQUESTED', 'CONTRIBUTOR'),
        review('b', 'CHANGES_REQUESTED', 'NONE'),
        review('c', 'CHANGES_REQUESTED', 'FIRST_TIME_CONTRIBUTOR'),
      ],
    });
    await refused(t, id, 'to', 'needs-human');
    t.setPr(31, {
      reviews: [
        review('bob', 'CHANGES_REQUESTED', 'OWNER', 'no', '2026-01-01T00:00:00Z'),
        review('bob', 'APPROVED', 'OWNER', 'ok', '2026-01-02T00:00:00Z'),
      ],
    });
    await refused(t, id, 'to', 'needs-human');
    t.setPr(31, {
      reviews: [
        review('bob', 'CHANGES_REQUESTED', 'OWNER', 'no', '2026-01-01T00:00:00Z'),
        review('bob', 'COMMENTED', 'OWNER', 'hm', '2026-01-02T00:00:00Z'),
      ],
    });
    // A COMMENTED review does not clear the earlier CHANGES_REQUESTED, so this one parks.
    assert.equal(ok(t, await t.job(id, 'to', 'needs-human')), `${id} needs-human`);
    const names2 = names(t, before);
    assert.ok(names2.includes('pr ready'), 'commented review does not clear the stance');
  });

  test('AC-2: a dismissed review clears an earlier changes-requested one', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    t.setPr(31, {
      reviews: [
        review('bob', 'CHANGES_REQUESTED', 'MEMBER', 'no', '2026-01-01T00:00:00Z'),
        review('bob', 'DISMISSED', 'MEMBER', '', '2026-01-02T00:00:00Z'),
      ],
    });
    await refused(t, id, 'to', 'needs-human');
  });

  for (const stage of ['awaiting-merge', 'approve', 'needs-human']) {
    test(`AC-3: a closed PR ends a ${stage} job as rejected`, async () => {
      const t = setup({ autoMerge: false });
      const id = stage === 'approve' ? await approved(t) : await awaiting(t);
      if (stage === 'needs-human') ok(t, await t.job(id, 'to', 'needs-human', '--note', 'stuck'));
      t.setPr(31, { state: 'CLOSED' });
      const before = t.calls().length;
      assert.equal(ok(t, await t.job(id, 'to', 'rejected')), `${id} rejected`);
      const job = t.json(id);
      assert.equal(job.stage, 'rejected');
      assert.ok(Date.parse(job.finished));
      assert.equal(job.note, 'PR #31 closed without merging');
      assert.ok(!existsSync(job.worktree), 'worktree removed');
      const comments = t.calls().slice(before).filter(({ args }) => args.slice(0, 2).join(' ') === 'issue comment');
      assert.equal(comments.length, 1);
      assert.ok(comments[0].args.includes('--body-file'));
      assert.ok(comments[0].body.startsWith(`<!-- factory:note ${id} -->`));
      assert.ok(noMerge(t));
    });
  }

  test('AC-4: an open PR is not rejected; merged still waits', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    const before = t.calls().length;
    await refused(t, id, 'to', 'rejected');
    assert.ok(!has(t, before, 'issue comment'));
    const res = await t.job(id, 'to', 'merged');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /still waiting/);
  });

  test('AC-5: a merged PR is not rejected but still finishes as merged', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    t.setPr(31, { state: 'MERGED' });
    await refused(t, id, 'to', 'rejected');
    assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
  });

  test('AC-5: needs-human without a PR is refused before any pr view', async () => {
    const t = setup();
    t.issue(7, { title: 'No pr' });
    const id = ok(t, await t.job('new', '7'));
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'stuck'));
    const before = t.calls().length;
    await refused(t, id, 'to', 'rejected');
    assert.ok(!has(t, before, 'pr view'));
  });

  test('AC-6: a noted park, and a no-note park from intake, behave as before', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    t.setPr(31, { reviews: [review('bob', 'CHANGES_REQUESTED', 'OWNER')] });
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'my reason'));
    assert.equal(t.json(id).note, 'my reason');
    const t2 = setup();
    t2.issue(8, { title: 'Intake' });
    const id2 = ok(t2, await t2.job('new', '8'));
    await refused(t2, id2, 'to', 'needs-human');
  });

  test('AC-7: SKILL.md describes the new parked-jobs order', () => {
    const skill = readFileSync(join(repo, '.claude/skills/eminzo-factory/SKILL.md'), 'utf8');
    const run = skill.slice(skill.indexOf('## /eminzo-factory run'), skill.indexOf('## Spawning agents'));
    assert.match(run, /to rejected/);
    assert.match(run, /to needs-human/);
    assert.match(run, /Request changes/);
    const rework = skill.slice(skill.indexOf('- `/eminzo-factory rework'), skill.indexOf('## Preflight'));
    assert.match(rework, /changes requested/);
  });
});
