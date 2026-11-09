// engine_version in job.json, the Factory record section of the PR body, and the comment templates.
// Same fake-gh harness as test/check-reuse.test.js (helpers copied), plus PR bodies and `pr edit`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
else if (a === 'pr' && b === 'edit') {
  if (!pr) fail('no such pr');
  if (process.env.FAKE_EDIT_FAIL) fail('edit refused');
  pr.body = fs.readFileSync(flag('--body-file'), 'utf8');
  save();
} else if (a === 'pr' && (b === 'ready' || b === 'comment')) { if (!pr) fail('no such pr'); }
`;

function runAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-reuse-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\nfactory/board.json\n.worktrees/\n');
  const cfg = JSON.parse(configText);
  delete cfg.auto_merge;
  cfg.language = 'en';
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(cfg));
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

  const env = {
    ...process.env, ...GIT_ENV, FACTORY_ROOT: root, FACTORY_GH: gh, FACTORY_TRANSCRIPTS: join(dir, 'transcripts'),
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
    env,
    bin: (name, args, input) => runAsync(join(repo, 'factory/bin', name), args, { cwd: root, env, input }),
    job: (...args) => runAsync(join(repo, 'factory/bin/job'), args.filter((a) => typeof a === 'string'), { cwd: root, env }),
    json: (id) => JSON.parse(readFileSync(join(jobsDir, id, 'job.json'), 'utf8')),
    path: (id, rel) => join(jobsDir, id, rel),
    read: (id, rel) => readFileSync(join(jobsDir, id, rel), 'utf8'),
    write(id, rel, text) {
      const file = join(jobsDir, id, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    setBody: (n, body) => setState((s) => { s.prs.find((p) => p.number === n).body = body; }),
    prBody: (n) => JSON.parse(readFileSync(stateFile, 'utf8')).prs.find((p) => p.number === n).body,
    issue(n) {
      setState((s) => {
        s.issues[n] = {
          number: n, title: `Issue ${n}`, body: 'Please build it.', state: 'OPEN',
          author: { login: 'alice' }, labels: [{ name: 'factory' }], comments: [],
        };
      });
    },
    pr(number, headRefName, body = 'Human text\n\nCloses #7\n') {
      setState((s) => {
        s.prs.push({
          number, headRefName, state: 'OPEN', isCrossRepository: false, headRepositoryOwner: { login: 'bqsistemas' },
          reviews: [], comments: [], body,
        });
      });
    },
  };
}

function ok(res) {
  assert.equal(res.status, 0, `expected success, got ${res.status}: ${res.stdout}${res.stderr}`);
  return res.stdout.trim();
}

const INTAKE = `ACCEPT\nRISK: low\nSURFACES: none\nRESCOPED: no\n\n## Scope\nThe toggle only.\n\n## Reason\nClear request.\n`;


import { applyRecord, commentKinds, githubBody } from '../factory/lib/job.js';
import { engineVersion } from '../factory/lib/util.js';

const SPEC = '# Spec: toggle\n\n- AC-1: it toggles\n- AC-2: it persists\n';

async function building(t) {
  t.issue(7);
  const id = ok(await t.job('new', '7'));
  t.write(id, 'intake.md', INTAKE);
  ok(await t.job(id, 'to', 'spec'));
  t.write(id, 'spec.md', SPEC);
  ok(await t.job(id, 'to', 'build'));
  const { worktree } = t.json(id);
  writeFileSync(join(worktree, 'feature.txt'), 'feature\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'feat: branch work');
  return id;
}

const gateAndReview = async (t, id) => {
  t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
  t.write(id, 'plan.md', '## Approach\nx\n');
  t.pr(31, `factory/${id}`);
  ok(await t.job(id, 'to', 'gate'));
  ok(await t.bin('gate', [id]));
  ok(await t.job(id, 'to', 'review'));
  for (const lens of Object.keys(t.json(id).reviews)) t.write(id, `round-1/review-${lens}.md`, 'VERDICT: PASS\n');
};

test('engine_version is recorded at job creation and refreshed when a round starts', async () => {
  const t = setup();
  t.env.EMINZO_VERSION = '7.7.7';
  const id = await building(t);
  assert.equal(t.json(id).engine_version, '7.7.7');
  t.write(id, 'build.md', 'STATUS: READY\n\n## Spec deviations\nNone\n');
  t.pr(31, `factory/${id}`);
  ok(await t.job(id, 'to', 'gate'));
  writeFileSync(join(t.json(id).worktree, 'BROKEN'), 'x\n');
  git(t.json(id).worktree, 'add', '.');
  git(t.json(id).worktree, 'commit', '-q', '-m', 'break');
  writeFileSync(join(t.root, 'factory/checks.sh'), '#!/bin/sh\nexit 1\n');
  await t.bin('gate', [id]);
  t.env.EMINZO_VERSION = '8.0.0';
  ok(await t.job(id, 'to', 'build'));
  assert.equal(t.json(id).round, 2);
  assert.equal(t.json(id).engine_version, '8.0.0');
});

test('engine_version falls back to the package version when EMINZO_VERSION is unset', async () => {
  const t = setup();
  delete t.env.EMINZO_VERSION;
  const id = await building(t);
  assert.equal(t.json(id).engine_version, engineVersion({}));
  assert.match(t.json(id).engine_version, /^\d+\.\d+\.\d+/);
});

test('the PR body gets one Factory record section, replaced in place, human text kept', async () => {
  const t = setup();
  t.env.EMINZO_VERSION = '1.2.3';
  const id = await building(t);
  await gateAndReview(t, id);
  const first = t.prBody(31);
  assert.ok(first.startsWith('Human text\n\nCloses #7\n'), 'human text first and untouched');
  assert.match(first, new RegExp(`<!-- factory:record-start ${id} -->[\\s\\S]*<!-- factory:record-end ${id} -->`));
  assert.match(first, /### Factory record/);
  assert.match(first, /\| Intake \| ACCEPT, risk low \|/);
  assert.match(first, /\| Spec \| 2 acceptance criteria \|/);
  assert.match(first, /\| Plan \| plan\.md written \|/);
  assert.match(first, /\| Checks \| GATE: PASS \(round 1\) \|/);
  assert.match(first, /\| Reviews \| code: pending/);
  assert.match(first, /Engine 1\.2\.3/);

  ok(await t.job(id, 'to', 'approve'));
  const second = t.prBody(31);
  assert.match(second, /\| Reviews \| code: PASS/);
  assert.equal(second.split('factory:record-start').length, 2, 'replaced, not appended');
  assert.equal(second.split('Human text').length, 2);
  assert.ok(second.startsWith('Human text\n\nCloses #7\n'));
});

test('a human edit outside the markers survives the next update', async () => {
  const t = setup();
  const id = await building(t);
  await gateAndReview(t, id);
  t.setBody(31, `${t.prBody(31)}\nAdded by a person\n`);
  ok(await t.job(id, 'to', 'approve'));
  const body = t.prBody(31);
  assert.ok(body.includes('Added by a person'));
  assert.equal(body.split('factory:record-start').length, 2);
});

test('a refused PR body edit never stops the transition', async () => {
  const t = setup();
  t.env.FAKE_EDIT_FAIL = '1';
  const id = await building(t);
  await gateAndReview(t, id);
  assert.equal(t.json(id).stage, 'review');
  assert.equal(t.prBody(31), 'Human text\n\nCloses #7\n');
});

test('applyRecord: appends once, replaces in place, tolerates dollar signs', () => {
  const sec = (x) => `<!-- factory:record-start j -->\n${x}\n<!-- factory:record-end j -->`;
  assert.equal(applyRecord('', sec('a'), 'j'), `${sec('a')}\n`);
  assert.equal(applyRecord('Hi\n', sec('a'), 'j'), `Hi\n\n${sec('a')}\n`);
  const once = applyRecord('Hi\n', sec('a'), 'j');
  assert.equal(applyRecord(once, sec('b $& $1'), 'j'), `Hi\n\n${sec('b $& $1')}\n`);
  assert.equal(applyRecord(`before ${sec('old')} after`, sec('new'), 'j'), `before ${sec('new')} after`);
});

test('comment templates: en, es and pt share the same kinds, markers and no stray placeholders', () => {
  const kinds = commentKinds('en');
  assert.ok(kinds.length >= 7);
  assert.deepEqual(commentKinds('es'), kinds);
  assert.deepEqual(commentKinds('pt'), kinds);
  const params = {
    id: '001-x', note: 'n', pr: 3, issue: 4, sha256: 'ab', spec: 's', decision: 'ESCALATE\nwhy\n', header: 'h', rest: 'r',
    round: 1, engine: '1.0.0', intakeDecision: 'ACCEPT', risk: 'low', acs: 2, plan: true, gate: 'PASS', reviews: 'code: PASS', approval: 'ESCALATE',
  };
  for (const lang of ['en', 'es', 'pt']) {
    for (const kind of kinds) {
      const body = githubBody(lang, kind, params);
      assert.match(body, /<!-- factory:[a-z-]+ 001-x -->/, `${lang}/${kind} has a marker`);
      assert.doesNotMatch(body, /undefined|\[object/, `${lang}/${kind} renders every field`);
    }
  }
});

test('the decision comment opens with one plain sentence after its marker and keeps decision.md whole', () => {
  const body = githubBody('en', 'decision', { id: '001-x', decision: 'ESCALATE\nwhy\n' });
  const lines = body.split('\n');
  assert.equal(lines[0], '<!-- factory:decision 001-x -->');
  assert.match(lines[1], /^The approver escalated this job: a person decides\.$/);
  assert.ok(body.includes('ESCALATE\nwhy'));
});
