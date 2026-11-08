// E1: scoped checks. The nudge passes FACTORY_CHECK_MODE (focused|full) and FACTORY_CHANGED_FILES to
// factory/checks.sh; the Stop hook, `--full`, the gate and the merge always run full. A focused pass
// is recorded as focused and never counts for a full caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const configText = readFileSync(join(repo, 'factory/config.json'), 'utf8');
const ID = '007-scoped';
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x',
};

// Records every run in $OUT: the mode, whether the variable was set, and a copy of the changed-files list.
const RECORDING = `#!/bin/sh
echo "\${FACTORY_CHECK_MODE:-unset}" >> "$OUT/modes"
if [ -n "$FACTORY_CHANGED_FILES" ]; then cp "$FACTORY_CHANGED_FILES" "$OUT/changed"; else echo none > "$OUT/changed"; fi
exit 0
`;
const IGNORING = '#!/bin/sh\necho "plain checks"\nexit 0\n';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup({ checks = RECORDING, withOrigin = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-mode-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  const out = join(dir, 'out');
  mkdirSync(out);
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\n.worktrees/\nignored.log\n');
  writeFileSync(join(root, 'factory/config.json'), configText);
  writeFileSync(join(root, 'factory/checks.sh'), checks, { mode: 0o755 });
  for (const f of ['keep.txt', 'gone.txt', 'old-name.txt', 'edit.txt']) writeFileSync(join(root, f), `${f}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  const worktree = join(root, '.worktrees', ID);
  git(root, 'worktree', 'add', '-q', worktree, '-b', `factory/${ID}`, 'origin/main');
  const jobDir = join(root, 'factory/jobs', ID);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ id: ID, issue: 1, branch: `factory/${ID}`, worktree, stage: 'gate', round: 1, max_rounds: 3 }));
  if (!withOrigin) git(root, 'remote', 'remove', 'origin');
  const base = { ...process.env, ...GIT_ENV, FACTORY_ROOT: root, OUT: out };
  delete base.FACTORY_CHECK_MODE;
  delete base.FACTORY_CHANGED_FILES;
  const call = (bin, args, extra = {}, input = '') => spawnSync('sh', [join(repo, 'factory/bin', bin), ...args], { encoding: 'utf8', input, env: { ...base, ...extra } });
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: `Job folder: factory/jobs/${ID}/` } })}\n`);
  return {
    root, worktree, jobDir, out, call,
    nudge: (...args) => call('nudge', [ID, ...args]),
    hook: (extra) => call('nudge', [], extra, JSON.stringify({ transcript_path: transcript })),
    modes: () => (existsSync(join(out, 'modes')) ? readFileSync(join(out, 'modes'), 'utf8').trim().split('\n') : []),
    changed: () => readFileSync(join(out, 'changed'), 'utf8'),
  };
}

test('AC-2: focused lists exactly the paths changed against the base (committed, uncommitted, untracked, deleted, renamed), sorted, once', () => {
  const t = setup();
  const w = t.worktree;
  writeFileSync(join(w, 'committed.txt'), 'c\n');
  mkdirSync(join(w, 'sub'));
  writeFileSync(join(w, 'sub/new.txt'), 'n\n');
  git(w, 'add', '.');
  git(w, 'commit', '-q', '-m', 'work');
  writeFileSync(join(w, 'edit.txt'), 'changed\n'); // uncommitted edit
  writeFileSync(join(w, 'untracked.txt'), 'u\n');
  writeFileSync(join(w, 'ignored.log'), 'x\n'); // ignored: never listed
  writeFileSync(join(w, 'sub/new.txt'), 'edited again\n'); // committed and edited again: one line
  rmSync(join(w, 'gone.txt'));
  git(w, 'mv', 'old-name.txt', 'new-name.txt');
  const res = t.nudge();
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(t.modes(), ['focused']);
  assert.equal(t.changed(), ['committed.txt', 'edit.txt', 'gone.txt', 'new-name.txt', 'old-name.txt', 'sub/new.txt', 'untracked.txt'].join('\n') + '\n');
  assert.equal(readFileSync(join(t.jobDir, 'changed-files.txt'), 'utf8'), t.changed());
});

test('AC-2: a focused nudge with no change lists nothing, and runs focused', () => {
  const t = setup();
  assert.equal(t.nudge().status, 0);
  assert.deepEqual(t.modes(), ['focused']);
  assert.equal(t.changed(), '');
});

test('AC-2: when the changes cannot be computed (no base), the nudge runs full instead of guessing', () => {
  const t = setup({ withOrigin: false });
  writeFileSync(join(t.worktree, 'x.txt'), 'x\n');
  assert.equal(t.nudge().status, 0);
  assert.deepEqual(t.modes(), ['full']);
  assert.equal(t.changed(), 'none\n');
});

test('AC-3: --full, the Stop hook, the gate and the merge run full, even if the environment says focused', () => {
  const t = setup();
  const polluted = { FACTORY_CHECK_MODE: 'focused', FACTORY_CHANGED_FILES: join(t.out, 'forged') };
  assert.equal(t.nudge('--full').status, 0);
  writeFileSync(join(t.worktree, 'a.txt'), 'a\n'); // a new tree: nothing is reused
  assert.equal(t.call('nudge', [ID, '--full'], polluted).status, 0);
  writeFileSync(join(t.worktree, 'b.txt'), 'b\n');
  assert.equal(t.hook(polluted).status, 0);
  git(t.worktree, 'add', '.');
  git(t.worktree, 'commit', '-q', '-m', 'work');
  assert.equal(t.call('gate', [ID], polluted).status, 0);
  assert.deepEqual(t.modes(), ['full', 'full', 'full', 'full']);
  assert.equal(t.changed(), 'none\n');
});

test('AC-3: the merge-checks path (gate()) and runChecks default to full, and only the nudge asks for focused', () => {
  const gate = readFileSync(join(repo, 'factory/lib/gate.js'), 'utf8');
  assert.match(gate, /const checks = runChecks\(root, job\.worktree\);/);
  const job = readFileSync(join(repo, 'factory/lib/job.js'), 'utf8');
  assert.match(job, /runGate\(c\.root, job, file\(c, job, 'merge-checks\.md'\)\)/);
  for (const f of ['job.js', 'gate.js', 'visual.js', 'approve.js']) {
    if (existsSync(join(repo, 'factory/lib', f))) assert.doesNotMatch(readFileSync(join(repo, 'factory/lib', f), 'utf8'), /mode: 'focused'/, `${f} must not ask for focused`);
  }
});

test('AC-3: the Claude Stop hook stays the bare nudge (hook mode is full), and the generated adapter hook too', () => {
  const builder = readFileSync(join(repo, '.claude/agents/eminzo-builder.md'), 'utf8');
  assert.match(builder, /command: '"\$CLAUDE_PROJECT_DIR"\/factory\/bin\/nudge'/);
  assert.doesNotMatch(builder, /bin\/nudge[^\n]*(focused|<id>)/);
  const nudge = readFileSync(join(repo, 'factory/lib/nudge.js'), 'utf8');
  assert.match(nudge, /const wantFull = full \|\| !manual;/);
});

test('AC-1: a checks.sh that ignores the variables gives the same result in nudge, --full, the hook and the gate', () => {
  for (const [checks, code] of [[IGNORING, 0], ['#!/bin/sh\necho broken >&2\nexit 1\n', 2]]) {
    const t = setup({ checks });
    writeFileSync(join(t.worktree, 'x.txt'), 'x\n');
    assert.equal(t.nudge().status, code);
    assert.equal(t.nudge('--full').status, code);
    assert.equal(t.hook().status, code);
    git(t.worktree, 'add', '.');
    git(t.worktree, 'commit', '-q', '-m', 'work');
    assert.equal(t.call('gate', [ID]).status, code === 0 ? 0 : 1);
  }
});

test('stamp: a focused pass is reused by a focused nudge, never by --full or the Stop hook', () => {
  const t = setup();
  assert.equal(t.nudge().status, 0);
  assert.equal(JSON.parse(readFileSync(join(t.jobDir, 'nudge.json'), 'utf8')).mode, 'focused');
  assert.equal(t.nudge().status, 0);
  assert.deepEqual(t.modes(), ['focused'], 'same tree, focused again: reused');
  assert.equal(t.nudge('--full').status, 0);
  assert.deepEqual(t.modes(), ['focused', 'full'], '--full does not accept a focused pass');
  // the full pass is recorded; start over to test the hook on a focused-only stamp
  writeFileSync(join(t.worktree, 'm.txt'), 'm\n');
  assert.equal(t.nudge().status, 0);
  assert.equal(t.hook().status, 0);
  assert.deepEqual(t.modes(), ['focused', 'full', 'focused', 'full'], 'the hook does not accept a focused pass');
});

test('stamp: a full pass satisfies a later focused nudge, a full nudge and the hook', () => {
  const t = setup();
  assert.equal(t.nudge('--full').status, 0);
  assert.equal(JSON.parse(readFileSync(join(t.jobDir, 'nudge.json'), 'utf8')).mode, 'full');
  assert.equal(t.nudge().status, 0);
  assert.equal(t.nudge('--full').status, 0);
  assert.equal(t.hook().status, 0);
  assert.deepEqual(t.modes(), ['full']);
});

test('stamp: a legacy stamp without a mode counts as a full pass', () => {
  const t = setup();
  assert.equal(t.nudge('--full').status, 0);
  const file = join(t.jobDir, 'nudge.json');
  const { mode, ...legacy } = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(mode, 'full');
  writeFileSync(file, `${JSON.stringify(legacy)}\n`);
  assert.equal(t.hook().status, 0);
  assert.deepEqual(t.modes(), ['full']);
});

test('stamp: the gate never reads the nudge stamp, so a focused pass cannot weaken it', () => {
  const t = setup({ checks: '#!/bin/sh\nif [ -f BROKEN ]; then exit 1; fi\nexit 0\n' });
  assert.equal(t.nudge().status, 0);
  writeFileSync(join(t.worktree, 'BROKEN'), 'x\n');
  git(t.worktree, 'add', '.');
  git(t.worktree, 'commit', '-q', '-m', 'work');
  assert.equal(t.call('gate', [ID]).status, 1);
  assert.doesNotMatch(readFileSync(join(repo, 'factory/lib/gate.js'), 'utf8'), /nudge\.json|readStamp/);
});

test('nudge usage: --full needs a job id, extra arguments are refused', () => {
  const t = setup();
  assert.equal(t.call('nudge', ['--full']).status, 64);
  assert.equal(t.call('nudge', [ID, '--wat']).status, 64);
  assert.equal(t.call('nudge', [ID, ID]).status, 64);
});

test('AC-4: the checks.sh template passes sh -n, documents both variables, shows Node, Go and Python, and is what a stack-less repo gets', async () => {
  const file = join(repo, 'factory/templates/checks.sh');
  const text = readFileSync(file, 'utf8');
  assert.equal(spawnSync('sh', ['-n', file]).status, 0);
  for (const word of ['FACTORY_CHECK_MODE', 'FACTORY_CHANGED_FILES', 'focused', 'full', 'Node:', 'Go:', 'Python:', 'only docs changed']) assert.ok(text.includes(word), word);
  assert.doesNotMatch(text, /smoke/i);
  const { detectChecks } = await import(join(repo, 'cli/src/installer/checks.js'));
  assert.equal(detectChecks({ files: [], packageJson: null, read: () => '' }).script, text);
});

test('AC-4: the template skips the tests for a docs-only focused diff and still runs in full', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-template-'));
  const list = join(dir, 'files');
  const run = (mode, files) => {
    writeFileSync(list, files);
    return spawnSync('sh', [join(repo, 'factory/templates/checks.sh')], { encoding: 'utf8', env: { ...process.env, FACTORY_CHECK_MODE: mode, FACTORY_CHANGED_FILES: list } });
  };
  assert.match(run('focused', 'README.md\ndocs/a.md\n').stdout, /only docs changed/);
  assert.doesNotMatch(run('focused', 'README.md\nsrc/a.js\n').stdout, /only docs changed/);
  assert.doesNotMatch(run('full', 'README.md\n').stdout, /only docs changed/);
});

test('AC-3: the generated Claude builder (eminzo install) has a bare `eminzo nudge` Stop hook, which is the full checks', async () => {
  const { claudeAgent } = await import(join(repo, 'cli/src/adapters.js'));
  const source = readFileSync(join(repo, '.claude/agents/eminzo-builder.md'), 'utf8');
  const out = claudeAgent(source, { role: readFileSync(join(repo, 'factory/roles/builder.md'), 'utf8'), roleName: 'builder', version: '1.0.0' });
  assert.match(out, /^\s+command: 'eminzo nudge'$/m);
  assert.doesNotMatch(out, /eminzo nudge[^\n]*focused/);
  assert.match(out, /eminzo nudge <job-id>/); // the builder's own, focused, run
});

test('the providers say it: Claude hook is full, Codex orchestrator runs --full, builders run focused', () => {
  const read = (f) => readFileSync(join(repo, f), 'utf8');
  const codexSkill = read('.agents/skills/eminzo-factory/SKILL.md');
  assert.match(codexSkill, /run `factory\/bin\/nudge <id> --full`/);
  assert.match(read('.claude/skills/eminzo-factory/SKILL.md'), /always the full checks/);
  assert.match(read('.codex/agents/eminzo-builder.toml'), /`factory\/bin\/nudge <id>` in the foreground/);
  assert.doesNotMatch(read('.codex/agents/eminzo-builder.toml'), /nudge <id> --full/);
  assert.match(read('factory/roles/builder.md'), /full checks before the gate[\s\S]*not the final word/);
});

test('the engine and roles stay generic: no repo, product or suite names in the scoped-checks code', () => {
  for (const f of ['factory/lib/nudge.js', 'factory/lib/check-stamp.js', 'factory/lib/gate.js', 'factory/roles/builder.md', 'factory/templates/checks.sh']) {
    assert.doesNotMatch(readFileSync(join(repo, f), 'utf8'), /smoke|eminzo-ai-factory|bqsistemas/i, f);
  }
});
