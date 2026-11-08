// Job 018: close a job whose PR a human merged or closed at any stage. Fake-gh harness copied from test/job-merge.test.js.
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
const callNames = (t) => t.calls().map(({ args }) => args.slice(0, 2).join(' '));
const has = (t, name) => callNames(t).includes(name);

// A job in `stage` with PR 31. Round 1 gate fails, so build is round 2 and has a PR.
async function jobAt(t, stage) {
  t.issue(7, { title: 'Close me' });
  const id = ok(t, await t.job('new', '7'));
  await toGate(t, id);
  if (stage === 'gate') return id;
  if (stage === 'build') {
    t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
    ok(t, await t.job(id, 'to', 'build'));
    return id;
  }
  t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
  ok(t, await t.job(id, 'to', 'review'));
  if (stage === 'review') return id;
  for (const lens of Object.keys(t.json(id).reviews)) t.write(id, `round-1/review-${lens}.md`, 'VERDICT: PASS\n');
  ok(t, await t.job(id, 'to', 'approve'));
  t.write(id, 'decision.md', 'APPROVE\nAll good.\n');
  if (stage === 'approve') return id;
  if (stage === 'awaiting-merge') {
    const cfgPath = join(t.root, 'factory/config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.auto_merge = false;
    writeFileSync(cfgPath, JSON.stringify(cfg));
    ok(t, await t.job(id, 'to', 'merging'));
    return id;
  }
  ok(t, await t.job(id, 'to', 'needs-human', '--note', 'parked'));
  return id;
}

const issueNotes = (t) => t.state().issues[7].comments.filter((c) => c.body.startsWith('<!-- factory:note'));

describe('job 018: close a job at any stage', { concurrency: true }, () => {
  for (const stage of ['build', 'gate', 'review']) {
    test(`AC-1: ${stage} to merged finishes the job when the PR is merged`, async () => {
      const t = setup();
      const id = await jobAt(t, stage);
      t.setPr(31, { state: 'MERGED' });
      assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
      const job = t.json(id);
      assert.ok(Date.parse(job.finished));
      assert.equal(job.note, `PR #31 merged outside the factory during ${stage}`);
      assert.ok(!existsSync(job.worktree), 'worktree removed');
      assert.ok(noMerge(t));
    });
  }

  for (const stage of ['approve', 'awaiting-merge', 'needs-human']) {
    test(`AC-2: ${stage} to merged names the stage in the note`, async () => {
      const t = setup();
      const id = await jobAt(t, stage);
      t.setPr(31, { state: 'MERGED' });
      assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
      assert.equal(t.json(id).note, `PR #31 merged outside the factory during ${stage}`);
    });
  }

  for (const stage of ['build', 'gate', 'review']) {
    test(`AC-3: ${stage} to merged is refused while the PR is open`, async () => {
      const t = setup();
      const id = await jobAt(t, stage);
      const before = t.raw(id);
      const res = await t.job(id, 'to', 'merged');
      assert.equal(res.status, 1);
      assert.match(res.stderr, /refused:/);
      assert.match(res.stderr, /not MERGED/);
      assert.equal(t.raw(id), before);
    });
  }

  test('AC-3: a round-1 build job with no PR is refused without a pr view', async () => {
    const t = setup();
    t.issue(7);
    const id = ok(t, await t.job('new', '7'));
    t.write(id, 'intake.md', INTAKE('ACCEPT'));
    ok(t, await t.job(id, 'to', 'spec'));
    t.write(id, 'spec.md', '# Spec\n');
    ok(t, await t.job(id, 'to', 'build'));
    const before = t.calls().length;
    const res = await t.job(id, 'to', 'merged');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /the job has no PR/);
    assert.ok(!t.calls().slice(before).some(({ args }) => args[0] === 'pr' && args[1] === 'view'));
  });

  for (const stage of ['build', 'gate', 'review']) {
    test(`AC-4: ${stage} to rejected needs a closed PR`, async () => {
      const t = setup();
      const id = await jobAt(t, stage);
      await refused(t, id, 'to', 'rejected');
      t.setPr(31, { state: 'MERGED' });
      await refused(t, id, 'to', 'rejected');
      t.setPr(31, { state: 'CLOSED' });
      assert.equal(ok(t, await t.job(id, 'to', 'rejected')), `${id} rejected`);
      const job = t.json(id);
      assert.equal(job.note, 'PR #31 closed without merging');
      assert.ok(!existsSync(job.worktree));
      const notes = issueNotes(t);
      assert.equal(notes.length, 1);
      assert.ok(notes[0].body.startsWith(`<!-- factory:note ${id} -->`));
    });
  }

  for (const state of ['MERGED', 'CLOSED']) {
    test(`AC-5: review to needs-human with a ${state} PR skips ready and comment`, async () => {
      const t = setup();
      const id = await jobAt(t, 'review');
      t.setPr(31, { state });
      const before = t.calls().length;
      ok(t, await t.job(id, 'to', 'needs-human', '--note', 'x'));
      const job = t.json(id);
      assert.equal(job.stage, 'needs-human');
      assert.equal(job.parked_from, 'review');
      assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
      assert.equal(issueNotes(t).length, 1);
      const names = t.calls().slice(before).map(({ args }) => args.slice(0, 2).join(' '));
      assert.ok(!names.includes('pr ready') && !names.includes('pr comment'));
    });
  }

  test('AC-5: review to needs-human with an open PR readies then comments', async () => {
    const t = setup();
    const id = await jobAt(t, 'review');
    const before = t.calls().length;
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'x'));
    const names = t.calls().slice(before).map(({ args }) => args.slice(0, 2).join(' '));
    assert.ok(names.indexOf('pr ready') >= 0 && names.indexOf('pr comment') > names.indexOf('pr ready'));
  });

  for (const state of ['MERGED', 'CLOSED']) {
    test(`AC-6: approve ESCALATE with a ${state} PR still parks without ready or comment`, async () => {
      const t = setup();
      const id = await jobAt(t, 'approve');
      t.write(id, 'decision.md', 'ESCALATE\nNeeds a person.\n');
      t.setPr(31, { state });
      const before = t.calls().length;
      ok(t, await t.job(id, 'to', 'needs-human'));
      const job = t.json(id);
      assert.equal(job.stage, 'needs-human');
      assert.equal(job.decision, 'ESCALATE');
      assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
      const names = t.calls().slice(before).map(({ args }) => args.slice(0, 2).join(' '));
      assert.ok(!names.includes('pr ready') && !names.includes('pr comment'));
    });
  }

  test('AC-7: review to needs-human parks when the PR lookup fails', async () => {
    const t = setup();
    const id = await jobAt(t, 'review');
    const s = t.state();
    s.prs = [];
    writeFileSync(join(t.dir, 'gh-state.json'), JSON.stringify(s));
    const before = t.calls().length;
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'x'));
    const job = t.json(id);
    assert.equal(job.stage, 'needs-human');
    assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
    assert.equal(issueNotes(t).length, 1);
    assert.ok(!t.calls().slice(before).some(({ args }) => args[0] === 'pr' && args[1] === 'ready'));
  });

  test('AC-8: SKILL.md /eminzo-factory run covers every stage and checks before spawning', () => {
    const text = readFileSync(join(repo, '.claude/skills/eminzo-factory/SKILL.md'), 'utf8');
    const section = text.split(/^## /m).find((s) => s.startsWith('/eminzo-factory run'));
    for (const stage of ['build', 'gate', 'review', 'approve', 'awaiting-merge', 'needs-human']) {
      assert.ok(section.includes(`\`${stage}\``), stage);
    }
    assert.match(section, /to merged/);
    assert.match(section, /to rejected/);
    assert.match(section, /before spawning/i);
  });
});
