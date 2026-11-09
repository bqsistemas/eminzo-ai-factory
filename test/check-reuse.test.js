// Check reuse: the builder nudge skips a tree that already passed, the gate records the
// head it tested, and the merge reuses that gate when the sync with the base is a no-op.
// Same fake-gh harness as test/job-merge.test.js (helpers copied, not imported).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// Every run appends a line to $CHECKS_COUNT, so a test can tell whether the checks ran.
const CHECKS = `#!/bin/sh
echo run >> "$CHECKS_COUNT"
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
    bin: (name, args, input) => runAsync(join(repo, 'factory/bin', name), args, { cwd: root, env, input }),
    job: (...args) => runAsync(join(repo, 'factory/bin/job'), args, { cwd: root, env }),
    json: (id) => JSON.parse(readFileSync(join(jobsDir, id, 'job.json'), 'utf8')),
    path: (id, rel) => join(jobsDir, id, rel),
    read: (id, rel) => readFileSync(join(jobsDir, id, rel), 'utf8'),
    write(id, rel, text) {
      const file = join(jobsDir, id, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
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

const INTAKE = `ACCEPT\nRISK: low\nSURFACES: none\nRESCOPED: no\n\n## Scope\nThe toggle only.\n\n## Reason\nClear request.\n`;

// A job in build with a worktree and one committed change.
async function building(t) {
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
  return { id, worktree };
}

// From build to approve with a real gate run (so checks.md records the tested head).
async function approvedWithRealGate(t) {
  const { id, worktree } = await building(t);
  t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
  t.pr(31, `factory/${id}`);
  ok(await t.job(id, 'to', 'gate'));
  ok(await t.bin('gate', [id]));
  ok(await t.job(id, 'to', 'review'));
  for (const lens of Object.keys(t.json(id).reviews)) t.write(id, `round-1/review-${lens}.md`, 'VERDICT: PASS\n');
  ok(await t.job(id, 'to', 'approve'));
  t.write(id, 'decision.md', 'APPROVE\nAll good.\n');
  return { id, worktree };
}

test('Claude and Codex builders both run their checks through the nudge, so both record the pass', () => {
  const role = readFileSync(join(repo, 'factory/roles/builder.md'), 'utf8');
  const codex = readFileSync(join(repo, '.codex/agents/eminzo-builder.toml'), 'utf8');
  assert.match(role, /Run the repo's checks with `factory\/bin\/nudge <job-id>`/);
  assert.match(codex, /factory\/roles\/builder\.md/); // the profile reads the role that names the nudge
  assert.doesNotMatch(codex, /Run `factory\/checks\.sh` in the worktree/);
});

test('checks inputs depend on the main checkout, never on which copy of the engine computes them', async () => {
  // The builder runs factory/bin/nudge from its worktree's copy; the Stop hook and the gate run
  // the main checkout's. Both must agree, or the hook reruns the whole suite for nothing.
  const copy = mkdtempSync(join(tmpdir(), 'factory-engine-copy-'));
  mkdirSync(join(copy, 'factory'), { recursive: true });
  execFileSync('cp', ['-R', join(repo, 'factory/lib'), join(copy, 'factory/lib')]);
  writeFileSync(join(copy, 'package.json'), '{"type":"module"}\n');
  const original = await import(join(repo, 'factory/lib/check-stamp.js'));
  const copied = await import(join(copy, 'factory/lib/check-stamp.js'));
  assert.equal(copied.checksInputs(repo), original.checksInputs(repo));

  const root = mkdtempSync(join(tmpdir(), 'factory-inputs-'));
  mkdirSync(join(root, 'factory/lib'), { recursive: true });
  writeFileSync(join(root, 'factory/checks.sh'), CHECKS);
  writeFileSync(join(root, 'factory/lib/gate.js'), 'v1\n');
  const before = original.checksInputs(root);
  writeFileSync(join(root, 'factory/lib/gate.js'), 'v2\n');
  assert.notEqual(original.checksInputs(root), before, 'an engine change in the main checkout counts');
});

describe('check reuse', { concurrency: true }, () => {
  test('nudge skips the checks for a tree that already passed, manual (Codex) or hook (Claude)', async () => {
    const t = setup();
    const { id, worktree } = await building(t);
    ok(await t.bin('nudge', [id, '--full'])); // a focused pass is not reusable by the hook (test/check-mode.test.js)
    assert.equal(t.runs(), 1);
    const again = await t.bin('nudge', [id]);
    assert.equal(again.status, 0);
    assert.equal(t.runs(), 1, 'a second nudge on the same tree does not run the checks');
    assert.match(again.stderr, /already passed/);

    const transcript = join(t.dir, 'builder.jsonl');
    writeFileSync(transcript, JSON.stringify({ text: `Job folder: factory/jobs/${id}/` }) + '\n');
    const hook = await t.bin('nudge', [], JSON.stringify({ agent_transcript_path: transcript, stop_hook_active: false }));
    assert.equal(hook.status, 0);
    assert.equal(t.runs(), 1, 'the Stop hook reuses the pass recorded by a manual nudge');
    assert.ok(existsSync(worktree));
  });

  test('nudge reruns when the tree changes, and skips again once the same content is committed', async () => {
    const t = setup();
    const { id, worktree } = await building(t);
    ok(await t.bin('nudge', [id]));
    writeFileSync(join(worktree, 'feature.txt'), 'feature v2\n');
    ok(await t.bin('nudge', [id]));
    assert.equal(t.runs(), 2, 'an uncommitted edit is a new tree');
    git(worktree, 'commit', '-q', '-am', 'feat: v2');
    ok(await t.bin('nudge', [id]));
    assert.equal(t.runs(), 2, 'committing the tested content keeps the same tree');
  });

  test('nudge reruns when the main checkout changes checks.sh', async () => {
    const t = setup();
    const { id } = await building(t);
    ok(await t.bin('nudge', [id]));
    writeFileSync(join(t.root, 'factory/checks.sh'), `${CHECKS}# changed\n`);
    ok(await t.bin('nudge', [id]));
    assert.equal(t.runs(), 2);
  });

  test('nudge still reports a pass when it cannot write its stamp', async () => {
    const t = setup();
    const { id } = await building(t);
    mkdirSync(t.path(id, 'nudge.json')); // a directory: the stamp cannot be written there
    const res = await t.bin('nudge', [id]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(t.runs(), 1);
  });

  test('a failing nudge exits 2, keeps the full log in the job folder and forgets the last pass', async () => {
    const t = setup();
    const { id, worktree } = await building(t);
    ok(await t.bin('nudge', [id]));
    writeFileSync(join(worktree, 'BROKEN'), 'x\n');
    const failing = await t.bin('nudge', [id]);
    assert.equal(failing.status, 2);
    assert.match(failing.stderr, /BROKEN is present/);
    assert.match(failing.stderr, /nudge\.log/);
    assert.match(t.read(id, 'nudge.log'), /checks: running[\s\S]*BROKEN is present/);
    rmSync(join(worktree, 'BROKEN'));
    ok(await t.bin('nudge', [id]));
    assert.equal(t.runs(), 3, 'after a failure the next nudge runs the checks again');
  });

  test('the gate records the head and the checks inputs it tested', async () => {
    const t = setup();
    const { id, worktree } = await building(t);
    t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
    t.pr(31, `factory/${id}`);
    ok(await t.job(id, 'to', 'gate'));
    ok(await t.bin('gate', [id]));
    const checks = t.read(id, 'round-1/checks.md');
    assert.equal(checks.split('\n')[0], 'GATE: PASS');
    assert.match(checks, new RegExp(`^Tested head: ${git(worktree, 'rev-parse', 'HEAD')}$`, 'm'));
    assert.match(checks, /^Checks inputs: sha256:[0-9a-f]{64}$/m);
  });

  test('the merge reuses the round gate when the sync with the base brings nothing', async () => {
    const t = setup();
    const { id } = await approvedWithRealGate(t);
    const before = t.runs();
    assert.equal(ok(await t.job(id, 'to', 'merging')), `${id} merged`);
    assert.equal(t.runs(), before, 'no second run of the checks');
    const report = t.read(id, 'merge-checks.md');
    assert.equal(report.split('\n')[0], 'GATE: PASS');
    assert.match(report, /Reused the round-1 gate/);
  });

  test('the merge runs the gate again when the base moved', async () => {
    const t = setup();
    const { id } = await approvedWithRealGate(t);
    writeFileSync(join(t.root, 'main.txt'), 'main\n');
    git(t.root, 'add', '.');
    git(t.root, 'commit', '-q', '-m', 'feat: main moved on');
    git(t.root, 'push', '-q', 'origin', 'main');
    const before = t.runs();
    assert.equal(ok(await t.job(id, 'to', 'merging')), `${id} merged`);
    assert.equal(t.runs(), before + 1);
    assert.doesNotMatch(t.read(id, 'merge-checks.md'), /Reused/);
  });

  test('the merge-checks run full with a polluted environment: checks.sh sees mode full and no list', async () => {
    const t = setup();
    const { id } = await approvedWithRealGate(t);
    const seen = join(t.dir, 'seen');
    writeFileSync(join(t.root, 'factory/checks.sh'), `#!/bin/sh\necho "$FACTORY_CHECK_MODE|\${FACTORY_CHANGED_FILES:-none}" >> "${seen}"\n`, { mode: 0o755 });
    Object.assign(t.env, { FACTORY_CHECK_MODE: 'focused', FACTORY_CHANGED_FILES: '/x' });
    assert.equal(ok(await t.job(id, 'to', 'merging')), `${id} merged`);
    assert.equal(readFileSync(seen, 'utf8'), 'full|none\n');
  });

  test('the merge runs the gate again when checks.sh changed since the round gate', async () => {
    const t = setup();
    const { id } = await approvedWithRealGate(t);
    writeFileSync(join(t.root, 'factory/checks.sh'), `${CHECKS}# changed\n`);
    const before = t.runs();
    assert.equal(ok(await t.job(id, 'to', 'merging')), `${id} merged`);
    assert.equal(t.runs(), before + 1);
  });

  test('a hand-written checks.md without a tested head never lets the merge skip the gate', async () => {
    const t = setup();
    const { id } = await building(t);
    t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
    t.pr(31, `factory/${id}`);
    ok(await t.job(id, 'to', 'gate'));
    t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
    ok(await t.job(id, 'to', 'review'));
    assert.equal(t.json(id).gated, undefined);
    for (const lens of Object.keys(t.json(id).reviews)) t.write(id, `round-1/review-${lens}.md`, 'VERDICT: PASS\n');
    ok(await t.job(id, 'to', 'approve'));
    t.write(id, 'decision.md', 'APPROVE\nAll good.\n');
    assert.equal(ok(await t.job(id, 'to', 'merging')), `${id} merged`);
    assert.equal(t.runs(), 1, 'the merge ran the gate');
  });
});
