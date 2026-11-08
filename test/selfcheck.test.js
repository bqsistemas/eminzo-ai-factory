// `job <id> selfcheck` (factory/bin/selfcheck): the builder's deterministic check before STATUS: READY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const ID = '001-dark-mode';
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const SPEC = '# Spec: dark mode\n\n## Acceptance criteria\n- AC-1: toggles the theme\n- AC-2: remembers the choice\n';
const INTAKE = 'ACCEPT\n\n# Intake\n\n## Scope\n- AC-1: toggles the theme\n- AC-2: remembers the choice\n\n## Notes\n- AC-9: not part of the scope\n';
const MAP = '# Project\n\n## Module map\n- `src/`: the app\n\n## Conventions\nnone\n';

/** A main checkout with a bare origin, protected test, a project.md and a job worktree on its own branch. */
function setup({ config = {}, lane, spec = SPEC, intake = INTAKE, map = MAP } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-selfcheck-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(join(root, 'factory'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\nfactory/board.json\n.worktrees/\n');
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ base: 'origin/main', protected_tests: ['test/guarded.test.js'], ...config }));
  writeFileSync(join(root, 'factory/project.md'), map);
  writeFileSync(join(root, 'test/guarded.test.js'), '// guarded\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  const worktree = join(root, '.worktrees', ID);
  git(root, 'worktree', 'add', '-q', worktree, '-b', `factory/${ID}`, 'origin/main');
  const jobDir = join(root, 'factory/jobs', ID);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ id: ID, branch: `factory/${ID}`, worktree, stage: 'build', round: 1, ...(lane ? { lane } : {}) }));
  writeFileSync(join(jobDir, 'spec.md'), spec);
  writeFileSync(join(jobDir, 'intake.md'), intake);
  const env = { ...process.env, ...GIT_ENV, FACTORY_ROOT: root };
  delete env.NODE_TEST_CONTEXT;
  const commit = (files, message = 'feat: work') => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(worktree, rel)), { recursive: true });
      writeFileSync(join(worktree, rel), text);
    }
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', message);
  };
  const selfcheck = (bin = 'factory/bin/selfcheck') => spawnSync('sh', [join(repo, bin), ID], { cwd: root, env, encoding: 'utf8' });
  return { root, worktree, jobDir, env, commit, selfcheck };
}

const BOTH = "test('AC-1: toggles', () => {});\ntest('AC-2: remembers', () => {});\n";

test('AC-4: with everything in order selfcheck exits 0 and prints "selfcheck: ok"', () => {
  const t = setup();
  t.commit({ 'src/theme.js': 'export {};\n', 'test/theme.test.js': BOTH });
  const res = t.selfcheck();
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stdout.trim(), 'selfcheck: ok');
});

test('AC-2: selfcheck exits 1 and names the AC-n that has no test', () => {
  const t = setup();
  t.commit({ 'src/theme.js': 'export {};\n', 'test/theme.test.js': "test('AC-1: toggles', () => {});\n" });
  const res = t.selfcheck();
  assert.equal(res.status, 1);
  assert.match(res.stdout, /AC-2/);
  assert.doesNotMatch(res.stdout, /AC-1\b/);
  assert.doesNotMatch(res.stdout, /selfcheck: ok/);
});

test('AC-2: a test file the branch did not touch does not count, and neither does a non-test file', () => {
  const t = setup();
  t.commit({ 'src/theme.js': '// AC-1 AC-2\n', 'test/theme.test.js': "test('AC-1: toggles', () => {});\n" });
  const res = t.selfcheck();
  assert.equal(res.status, 1);
  assert.match(res.stdout, /AC-2/);
});

test('AC-3: selfcheck exits 1 when a protected test was modified, and names it', () => {
  const t = setup();
  t.commit({ 'test/theme.test.js': BOTH, 'test/guarded.test.js': '// weakened\n' });
  const res = t.selfcheck();
  assert.equal(res.status, 1);
  assert.match(res.stdout, /test\/guarded\.test\.js/);
  assert.match(res.stdout, /protected/i);
});

test('the Module map must mention a new module', () => {
  const t = setup();
  t.commit({ 'lib/newmod.js': 'export {};\n', 'test/theme.test.js': BOTH });
  const res = t.selfcheck();
  assert.equal(res.status, 1);
  assert.match(res.stdout, /Module map/);
  assert.match(res.stdout, /lib\/newmod\.js/);
  t.commit({ 'factory/project.md': MAP.replace('- `src/`: the app', '- `src/`: the app\n- `lib/`: helpers') }, 'docs: map');
  assert.equal(t.selfcheck().status, 0);
});

test('uncommitted changes in the worktree fail selfcheck', () => {
  const t = setup();
  t.commit({ 'test/theme.test.js': BOTH });
  writeFileSync(join(t.worktree, 'stray.txt'), 'x\n');
  const res = t.selfcheck();
  assert.equal(res.status, 1);
  assert.match(res.stdout, /uncommitted/i);
  assert.match(res.stdout, /stray\.txt/);
});

test('lane xs reads its ACs from intake.md ## Scope only', () => {
  const t = setup({ lane: 'xs' });
  t.commit({ 'test/theme.test.js': "test('AC-1: toggles', () => {});\n" });
  const res = t.selfcheck();
  assert.equal(res.status, 1);
  assert.match(res.stdout, /AC-2/);
  assert.doesNotMatch(res.stdout, /AC-9/);
});

test('selfcheck.ac_pattern adapts the match to other test styles (Python def test_ac_1)', () => {
  const t = setup({ config: { selfcheck: { ac_pattern: '(?:AC-|test_ac_)\\d+' } } });
  t.commit({ 'tests/test_theme.py': 'def test_ac_1():\n    pass\n' });
  const res = t.selfcheck();
  assert.equal(res.status, 1);
  assert.match(res.stdout, /AC-2/);
  t.commit({ 'tests/test_more.py': 'def test_ac_2():\n    pass\n' });
  assert.equal(t.selfcheck().status, 0);
});

test('an invalid selfcheck.ac_pattern is reported, not a crash', () => {
  const t = setup({ config: { selfcheck: { ac_pattern: '(' } } });
  t.commit({ 'test/theme.test.js': BOTH });
  const res = t.selfcheck();
  assert.equal(res.status, 1);
  assert.match(res.stdout, /ac_pattern/);
});
