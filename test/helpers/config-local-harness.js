// Shared setup for config-local, moved out of test/config-local.test.js (D2: split by scenario).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksInputs } from '../../factory/lib/check-stamp.js';
import { LOCAL_CONFIG } from '../../factory/lib/util.js';

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

// Every run appends a line to $CHECKS_COUNT, so a test can tell whether the checks ran.
const CHECKS = `#!/bin/sh
echo run >> "$CHECKS_COUNT"
echo "checks: ok"
`;

// CommonJS on purpose: the temp folder has no package.json.
const fakeGh = (stateFile) => `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state, null, 2));
const out = (value) => process.stdout.write(JSON.stringify(value));
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const [a, b, n] = args;
const issue = state.issues[n];
const pr = state.prs.find((p) => String(p.number) === n);
if (a === 'issue' && b === 'view') { if (!issue) fail('no such issue'); out(issue); }
else if (a === 'issue' && (b === 'comment' || b === 'edit')) { if (!issue) fail('no such issue'); }
else if (a === 'pr' && b === 'list') {
  out(state.prs.filter((p) => p.headRefName === flag('--head') && p.state === 'OPEN'));
} else if (a === 'pr' && b === 'view') { if (!pr) fail('no such pr'); out(pr); }
else if (a === 'pr' && b === 'merge') { if (!pr) fail('no such pr'); pr.state = 'MERGED'; save(); }
else if (a === 'pr' && (b === 'ready' || b === 'comment')) { if (!pr) fail('no such pr'); }
`;

function runAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A team config like this repo's: language es, max_rounds 3, auto_merge true, providers claude and codex. */
function teamConfig() {
  const cfg = JSON.parse(configText);
  cfg.language = 'es';
  cfg.max_rounds = 3;
  cfg.auto_merge = true;
  cfg.concurrency = 3;
  cfg.default_provider = 'claude';
  return cfg;
}

/** A bare root (no git) with only factory/config.json. */
function plainRoot(team = teamConfig()) {
  const root = mkdtempSync(join(tmpdir(), 'factory-local-'));
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(team));
  return root;
}

const writeLocal = (root, value) => writeFileSync(join(root, LOCAL_CONFIG), typeof value === 'string' ? value : JSON.stringify(value));
const never = () => { throw new Error('tracked must not be called'); };
const untracked = () => false;
const quiet = () => {};

function setup({ team = teamConfig() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-local-cli-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\nfactory/board.json\n.worktrees/\n');
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(team));
  writeFileSync(join(root, 'factory/checks.sh'), CHECKS);
  writeFileSync(join(root, 'app.txt'), 'v1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');

  const stateFile = join(dir, 'gh-state.json');
  const gh = join(dir, 'gh');
  writeFileSync(stateFile, JSON.stringify({ viewer: 'factory-owner', issues: {}, prs: [] }));
  writeFileSync(gh, fakeGh(stateFile));
  chmodSync(gh, 0o755);
  const count = join(dir, 'checks-count');
  writeFileSync(count, '');

  const env = {
    ...process.env, ...GIT_ENV, FACTORY_ROOT: root, FACTORY_GH: gh, FACTORY_TRANSCRIPTS: join(dir, 'transcripts'), CHECKS_COUNT: count,
  };
  delete env.NODE_TEST_CONTEXT;
  const jobsDir = join(root, 'factory/jobs');
  const setState = (fn) => {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    fn(s);
    writeFileSync(stateFile, JSON.stringify(s));
  };
  return {
    dir, root, env,
    bin: (name, args) => runAsync(join(repo, 'factory/bin', name), args, { cwd: root, env }),
    job: (...args) => runAsync(join(repo, 'factory/bin/job'), args, { cwd: root, env }),
    json: (id) => JSON.parse(readFileSync(join(jobsDir, id, 'job.json'), 'utf8')),
    raw: (id) => readFileSync(join(jobsDir, id, 'job.json'), 'utf8'),
    board: () => JSON.parse(readFileSync(join(root, 'factory/board.json'), 'utf8')),
    boardPath: join(root, 'factory/board.json'),
    read: (id, rel) => readFileSync(join(jobsDir, id, rel), 'utf8'),
    write(id, rel, text) {
      const file = join(jobsDir, id, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    local: (value) => writeLocal(root, value),
    runs: () => readFileSync(count, 'utf8').split('\n').filter(Boolean).length,
    issue(n) {
      setState((s) => {
        s.issues[n] = {
          number: n, title: `Issue ${n}`, body: 'Please build it.', state: 'OPEN',
          author: { login: 'alice' }, labels: [{ name: 'factory' }], comments: [],
        };
      });
    },
    pr(number, headRefName) {
      setState((s) => {
        s.prs.push({
          number, headRefName, state: 'OPEN', isCrossRepository: false, headRepositoryOwner: { login: 'bqsistemas' },
          reviews: [], comments: [],
        });
      });
    },
    jobIds: () => (existsSync(jobsDir) ? readdirSync(jobsDir) : []),
  };
}

function ok(res) {
  assert.equal(res.status, 0, `expected success, got ${res.status}: ${res.stdout}${res.stderr}`);
  return res.stdout.trim();
}

/** A job sitting at gate after a failed round-1 gate, built by hand (no gh, no worktree). */
function gateFailedJob(t, id = '007-thing') {
  t.write(id, 'job.json', JSON.stringify({
    id, issue: 7, title: 'thing', branch: `factory/${id}`, port: 3007, stage: 'gate', round: 1, max_rounds: 3,
    provider: 'claude', agents: { builder: 'sonnet', reviewers: { code: 'haiku' } }, gate: 'pending', reviews: {}, history: [],
  }, null, 2));
  t.write(id, 'round-1/checks.md', 'GATE: FAIL\n\nchecks failed\n');
  return id;
}

const INTAKE = `ACCEPT\nRISK: low\nSURFACES: none\nRESCOPED: no\n\n## Scope\nThe toggle only.\n\n## Reason\nClear request.\n`;

// From a new issue to approve with a real gate run (so checks.md records the tested head and inputs).
async function approvedWithRealGate(t) {
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
  ok(await t.bin('gate', [id]));
  ok(await t.job(id, 'to', 'review'));
  for (const lens of Object.keys(t.json(id).reviews)) t.write(id, `round-1/review-${lens}.md`, 'VERDICT: PASS\n');
  ok(await t.job(id, 'to', 'approve'));
  t.write(id, 'decision.md', 'APPROVE\nAll good.\n');
  return id;
}

/** checksInputs as it was before job 125: config.local.json is never part of it. */
function legacyChecksInputs(root) {
  const list = (rel) => {
    try {
      return readdirSync(join(root, rel), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${rel}/${e.name}`).sort();
    } catch {
      return [];
    }
  };
  const hash = createHash('sha256');
  for (const rel of ['factory/checks.sh', 'factory/config.json', ...list('factory/lib'), ...list('factory/bin')]) {
    let bytes;
    try { bytes = readFileSync(join(root, rel)); } catch { bytes = Buffer.alloc(0); }
    hash.update(rel).update('\0').update(bytes).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

const VALID_ALL = { concurrency: 1, default_provider: 'codex', language: 'pt', max_rounds: 2, auto_merge: false };

export { repo, configText, GIT_ENV, CHECKS, fakeGh, runAsync, git, teamConfig, plainRoot, writeLocal, never, untracked, quiet, setup, ok, gateFailedJob, INTAKE, approvedWithRealGate, legacyChecksInputs, VALID_ALL };
