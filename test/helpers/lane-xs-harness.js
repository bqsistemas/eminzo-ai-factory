// Shared setup for test/lane-xs.test.js, moved out of test/lane-xs.test.js (D2: split by scenario).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
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
  for (const f of ['b.txt', 'c.txt', 'd.txt']) writeFileSync(join(root, f), 'v1\n');
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'test/base.test.js'), 'orig\n');
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



const config = JSON.parse(configText);
const INTAKE = ({ risk = 'low', surfaces = 'ui', size = 'xs', body = '' } = {}) =>
  `ACCEPT\nRISK: ${risk}\nSURFACES: ${surfaces}\nRESCOPED: no${size ? `\nSIZE: ${size}` : ''}\n\n## Scope\nRename the label.\n- \`app.txt\`: the label\n- AC-1: the header says Gasto.\n\n## Reason\nTiny.\n${body}`;
const LABELED = [{ name: 'factory' }, { name: 'factory:xs' }];

// A new job whose intake is accepted; returns the id (still at the intake stage).
async function intaken(t, { labels, body, intake } = {}) {
  t.issue(7, { title: 'Rename cost', ...(labels ? { labels } : {}), ...(body ? { body } : {}) });
  const id = ok(t, await t.job('new', '7'));
  t.write(id, 'intake.md', INTAKE(intake));
  return id;
}

async function xsToBuild(t, opts = {}) {
  const id = await intaken(t, { labels: LABELED, ...opts });
  assert.equal(ok(t, await t.job(id, 'to', 'build')), `${id} build`);
  return id;
}

async function xsToGate(t, id, pr = 31, build = 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n') {
  t.write(id, 'build.md', build);
  t.pr(pr, `factory/${id}`);
  ok(t, await t.job(id, 'to', 'gate'));
}

// Runs factory/bin/approve for a job in the test repo.
const approveScript = (t, id) => runAsync(join(repo, 'factory/bin/approve'), [id], { cwd: t.root, env: t.env });

// gate, review and approve for an xs job whose build has already been committed in the worktree.
async function toApprove(t, id) {
  await xsToGate(t, id);
  t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
  ok(t, await t.job(id, 'to', 'review'));
  t.write(id, 'round-1/review-code.md', 'VERDICT: PASS\n');
  ok(t, await t.job(id, 'to', 'approve'));
}


// Commits `files` in the job's worktree (the branch factory/<id>), the way a builder would.
function commitInWorktree(t, id, files, { remove = [] } = {}) {
  const { worktree } = t.json(id);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, rel)), { recursive: true });
    writeFileSync(join(worktree, rel), text);
  }
  for (const rel of remove) git(worktree, 'rm', '-q', rel);
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'feat: change');
}

export { repo, configText, GIT_ENV, CHECKS, fakeGh, runAsync, git, setup, ok, refused, config, INTAKE, LABELED, intaken, xsToBuild, xsToGate, approveScript, toApprove, commitInWorktree };
