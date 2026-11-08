// `job new <n>` claims the issue only when it creates the job: it refuses an issue
// assigned to someone else or whose `factory/<id>` branch already exists on the
// remote of config.base, and assigns an unassigned issue to the gh user. Unit tests
// drive claimIssue with a recording exec; CLI tests use a fake gh and a local bare
// remote, so nothing reaches the network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { claimIssue } from '../factory/lib/claim.js';
import { Refused } from '../factory/lib/util.js';

const repo = fileURLToPath(new URL('..', import.meta.url));

// --- unit: claimIssue with an injected runner -------------------------------------

const BRANCH = 'refs/heads/factory/005-add-thing';
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', error: undefined });
const fail = (stderr = 'boom') => ({ status: 1, stdout: '', stderr, error: undefined });

/** A runner that records [cmd, ...args] and answers from `answers` by key. */
function fakeExec({ user = 'me-user', heads = '', apiUser, lsRemote, edit } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    assert.equal(typeof cmd, 'string');
    assert.ok(Array.isArray(args), 'argv, never a shell string');
    for (const a of args) assert.equal(typeof a, 'string', 'every argv entry is a string');
    calls.push([cmd, ...args]);
    if (cmd === 'gh' && args[0] === 'api') return apiUser ?? ok(`${user}\n`);
    if (cmd === 'git' && args[0] === 'ls-remote') return lsRemote ?? ok(heads);
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') return edit ?? ok();
    throw new Error(`unexpected call ${cmd} ${args.join(' ')}`);
  };
  return { exec, calls };
}

const API_USER = ['gh', 'api', 'user', '--jq', '.login'];
const LS_REMOTE = ['git', 'ls-remote', '--heads', 'origin', BRANCH];
const ASSIGN = ['gh', 'issue', 'edit', '5', '--add-assignee', '@me'];
const claim = (exec, assignees, extra = {}) => claimIssue({ n: 5, id: '005-add-thing', assignees, remote: 'origin', gh: 'gh', exec, ...extra });

describe('claimIssue', () => {
  test('AC-3/AC-8: an unassigned issue with no remote branch is assigned to @me, after ls-remote', () => {
    for (const assignees of [undefined, []]) {
      const f = fakeExec();
      assert.deepEqual(claim(f.exec, assignees), { assigned: true });
      assert.deepEqual(f.calls, [LS_REMOTE, ASSIGN], 'no api user call without assignees');
    }
  });

  test('AC-3/AC-8: an issue assigned only to the gh user (any case) is not edited', () => {
    const f = fakeExec({ user: 'Me-User' });
    assert.deepEqual(claim(f.exec, [{ login: 'me-USER' }]), { assigned: false });
    assert.deepEqual(f.calls, [API_USER, LS_REMOTE]);
  });

  test('AC-4/AC-8: an issue assigned to someone else is refused before ls-remote, with a sanitised login', () => {
    const f = fakeExec();
    assert.throws(() => claim(f.exec, [{ login: 'me-user' }, { login: 'bob$(x); rm -rf' }]), (err) => {
      assert.ok(err instanceof Refused);
      assert.equal(err.message, '#5 is assigned to bobxrm-rf');
      return true;
    });
    assert.deepEqual(f.calls, [API_USER]);
  });

  test('AC-5/AC-8: an existing factory/<id> branch on the remote is refused before assigning', () => {
    const f = fakeExec({ heads: `abc123\t${BRANCH}\n` });
    assert.throws(() => claim(f.exec, []), (err) => {
      assert.ok(err instanceof Refused);
      assert.equal(err.message, '#5 already has branch factory/005-add-thing on origin');
      return true;
    });
    assert.deepEqual(f.calls, [LS_REMOTE]);
  });

  test('AC-5: a branch that only shares the suffix is not a match', () => {
    const heads = `a1\trefs/heads/x/factory/005-add-thing\na2\trefs/heads/refs/heads/factory/005-add-thing\na3\t${BRANCH}-2\n`;
    const f = fakeExec({ heads });
    assert.deepEqual(claim(f.exec, []), { assigned: true });
    assert.deepEqual(f.calls, [LS_REMOTE, ASSIGN]);
  });

  test('AC-7: a failing gh api user, ls-remote or assignment throws an Error that is not Refused', () => {
    const cases = [
      [{ apiUser: fail('no auth') }, [{ login: 'someone' }], [API_USER]],
      [{ apiUser: ok('\n') }, [{ login: 'someone' }], [API_USER]],
      [{ apiUser: { status: null, stdout: '', stderr: '', error: new Error('ENOENT') } }, [{ login: 'x' }], [API_USER]],
      [{ lsRemote: fail('no remote') }, [], [LS_REMOTE]],
      [{ lsRemote: { status: null, stdout: '', stderr: '', error: new Error('ENOENT') } }, [], [LS_REMOTE]],
      [{ edit: fail('no permission') }, [], [LS_REMOTE, ASSIGN]],
    ];
    for (const [opts, assignees, expected] of cases) {
      const f = fakeExec(opts);
      assert.throws(() => claim(f.exec, assignees), (err) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof Refused), `not Refused: ${err.message}`);
        return true;
      });
      assert.deepEqual(f.calls, expected);
    }
  });

  test('AC-8: claim.js runs nothing itself: every command goes through the injected exec', () => {
    const src = readFileSync(join(repo, 'factory/lib/claim.js'), 'utf8');
    assert.doesNotMatch(src, /child_process|spawn|execSync|shell/);
  });
});

// --- CLI: factory/bin/job new with a fake gh and a bare remote ---------------------

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

// CommonJS on purpose: the temp folder has no package.json.
const fakeGh = (stateFile, logFile) => `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state, null, 2));
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const [a, b, n] = args;
const issue = state.issues[n];
if (a === 'api' && b === 'user') {
  if (state.apiUserFails) fail('gh: not logged in');
  process.stdout.write(state.viewer + '\\n');
} else if (a === 'issue' && b === 'view') {
  if (!issue) fail('no such issue');
  process.stdout.write(JSON.stringify(issue));
} else if (a === 'issue' && b === 'edit') {
  if (!issue) fail('no such issue');
  if (flag('--add-assignee')) {
    if (state.editFails) fail('cannot assign');
    if (fs.existsSync(state.jobsDir + '/' + state.expectId + '/job.json')) {
      state.assignedAfterJob = true;
    }
    issue.assignees = [...(issue.assignees || []), { login: state.viewer }];
  }
  save();
} else {
  fail('unexpected gh ' + args.join(' '));
}
`;

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

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function setup({ base = 'origin/main' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-guard-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\nfactory/board.json\n.worktrees/\n');
  const config = { ...JSON.parse(readFileSync(join(repo, 'factory/config.json'), 'utf8')), base };
  delete config.notifications;
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(root, 'app.txt'), 'v1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');

  const jobsDir = join(root, 'factory/jobs');
  const stateFile = join(dir, 'gh-state.json');
  const logFile = join(dir, 'gh-log.jsonl');
  const gh = join(dir, 'gh');
  writeFileSync(stateFile, JSON.stringify({ viewer: 'me-user', issues: {}, jobsDir, expectId: '005-add-thing' }));
  writeFileSync(logFile, '');
  writeFileSync(gh, fakeGh(stateFile, logFile));
  chmodSync(gh, 0o755);
  const env = { ...process.env, ...GIT_ENV, FACTORY_ROOT: root, FACTORY_GH: gh, FACTORY_TRANSCRIPTS: join(dir, 'transcripts') };
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const setState = (fn) => { const s = state(); fn(s); writeFileSync(stateFile, JSON.stringify(s)); };
  const boardFile = join(root, 'factory/board.json');
  return {
    root, origin, jobsDir, state, setState,
    job: (...args) => runAsync(join(repo, 'factory/bin/job'), args, { cwd: root, env }),
    issue(n, fields = {}) {
      setState((s) => {
        s.issues[n] = {
          number: n, title: 'Add thing', body: 'Please.', state: 'OPEN', author: { login: 'alice' },
          labels: [{ name: 'factory' }], comments: [], ...fields,
        };
      });
    },
    pushBranch: (ref) => git(root, 'push', '-q', 'origin', `HEAD:${ref}`),
    calls: () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    board: () => (existsSync(boardFile) ? readFileSync(boardFile, 'utf8') : null),
  };
}

const assignCalls = (t) => t.calls().filter((args) => args.includes('--add-assignee'));
const ID = '005-add-thing';

describe('factory/bin/job new claims the issue', { concurrency: true }, () => {
  test('AC-3: an unassigned issue is assigned to @me before job.json exists, and the job starts at intake', async () => {
    const t = setup();
    t.issue(5);
    const res = await t.job('new', '5');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `${ID}\n`);
    assert.deepEqual(assignCalls(t), [['issue', 'edit', '5', '--add-assignee', '@me']]);
    assert.equal(t.state().assignedAfterJob, undefined, 'the assignment ran before job.json was written');
    const job = JSON.parse(readFileSync(join(t.jobsDir, ID, 'job.json'), 'utf8'));
    assert.equal(job.stage, 'intake');
    assert.equal(job.issue, 5);
    assert.ok(!t.calls().some((args) => args[0] === 'api'), 'no api user call without assignees');
  });

  test('AC-3: an issue already assigned only to the gh user (other case) creates the job without --add-assignee', async () => {
    const t = setup();
    t.issue(5, { assignees: [{ login: 'ME-User' }] });
    const res = await t.job('new', '5');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `${ID}\n`);
    assert.deepEqual(assignCalls(t), []);
    assert.ok(existsSync(join(t.jobsDir, ID, 'job.json')));
  });

  test('AC-4: an issue assigned to someone else is refused, with a sanitised login, and nothing is written', async () => {
    const t = setup();
    t.issue(5, { assignees: [{ login: 'bob$(touch x);' }] });
    const board = t.board();
    const res = await t.job('new', '5');
    assert.equal(res.status, 1);
    assert.equal(res.stderr, 'refused: #5 is assigned to bobtouchx\n');
    assert.ok(!existsSync(join(t.jobsDir, ID)), 'no job folder, issue.md or job.json');
    assert.equal(t.board(), board, 'board.json unchanged');
    assert.deepEqual(assignCalls(t), []);
  });

  test('AC-5: an existing factory/<id> branch on the base remote is refused and nothing is written', async () => {
    const t = setup();
    t.issue(5);
    t.pushBranch(`refs/heads/factory/${ID}`);
    const board = t.board();
    const res = await t.job('new', '5');
    assert.equal(res.status, 1);
    assert.equal(res.stderr, `refused: #5 already has branch factory/${ID} on origin\n`);
    assert.ok(!existsSync(join(t.jobsDir, ID)));
    assert.equal(t.board(), board);
    assert.deepEqual(assignCalls(t), []);
  });

  test('AC-5: a branch that only shares the suffix does not refuse', async () => {
    const t = setup();
    t.issue(5);
    t.pushBranch(`refs/heads/x/factory/${ID}`);
    t.pushBranch(`refs/heads/refs/heads/factory/${ID}`);
    const res = await t.job('new', '5');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `${ID}\n`);
    assert.equal(assignCalls(t).length, 1);
  });

  test('AC-6: an existing local job is returned again with no new gh call, even once claimed elsewhere', async () => {
    const t = setup();
    t.issue(5);
    const first = await t.job('new', '5');
    assert.equal(first.status, 0, first.stderr);
    t.setState((s) => { s.issues[5].assignees = [{ login: 'someone-else' }]; });
    t.pushBranch(`refs/heads/factory/${ID}`);
    const before = t.calls().length;
    const again = await t.job('new', '5');
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, `${ID}\n`);
    assert.equal(t.calls().length, before, 'no new gh call');
    assert.deepEqual(readdirSync(t.jobsDir), [ID], 'still one job');
  });

  test('AC-7: a failing gh api user, ls-remote or assignment exits non-zero and creates no job', async () => {
    const cases = [
      ['api user', (t) => { t.issue(5, { assignees: [{ login: 'x' }] }); t.setState((s) => { s.apiUserFails = true; }); }, {}],
      ['ls-remote', (t) => { t.issue(5); }, { base: 'nowhere/main' }],
      ['assign', (t) => { t.issue(5); t.setState((s) => { s.editFails = true; }); }, {}],
    ];
    for (const [name, arrange, opts] of cases) {
      const t = setup(opts);
      arrange(t);
      const res = await t.job('new', '5');
      assert.notEqual(res.status, 0, `${name}: non-zero exit`);
      assert.match(res.stderr, /^error: /, `${name}: an error, not a refusal: ${res.stderr}`);
      assert.ok(!existsSync(join(t.jobsDir, ID)), `${name}: no job folder`);
    }
  });
});
