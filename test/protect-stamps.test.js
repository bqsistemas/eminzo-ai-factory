// E5: the protect hook refuses edits to the engine-written stamp folder in the main checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const hook = join(repo, 'factory/bin/protect-tests');
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ID = '001-wt';

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-protect-stamps-')));
  const root = join(dir, 'root');
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ base: 'origin/main', protected_tests: [] }));
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const worktree = join(root, '.worktrees', ID);
  git(root, 'worktree', 'add', '-q', worktree, '-b', `factory/${ID}`, 'HEAD');
  const call = (file_path, tool_name = 'Write') => spawnSync('sh', [hook], {
    cwd: worktree, input: JSON.stringify({ tool_name, tool_input: { file_path }, cwd: worktree }), encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, FACTORY_ROOT: undefined },
  });
  return { root, worktree, call };
}

test('E5: Edit, Write and MultiEdit under factory/jobs/.stamps/ in the main checkout are denied', () => {
  const t = setup();
  for (const tool of ['Edit', 'Write', 'MultiEdit']) {
    const res = t.call(join(t.root, 'factory/jobs/.stamps/x.json'), tool);
    assert.equal(res.status, 2, tool);
    assert.match(res.stderr, /engine-written stamp; the gate ignores and the round fails/);
  }
  const nb = spawnSync('sh', [hook], {
    cwd: t.worktree, encoding: 'utf8', env: { ...process.env, ...GIT_ENV },
    input: JSON.stringify({ tool_name: 'NotebookEdit', tool_input: { notebook_path: join(t.root, 'factory/jobs/.stamps/x.ipynb') }, cwd: t.worktree }),
  });
  assert.equal(nb.status, 2);
});

test('E5: the stamp folder is denied through a relative path, a ../ path and from a worktree path', () => {
  const t = setup();
  assert.equal(t.call(join(t.root, 'factory/jobs/./.stamps/../.stamps/y.json')).status, 2);
  assert.equal(t.call(`../../factory/jobs/.stamps/${ID}.json`).status, 2);
});

test('E5: the job still writes its own build.md, and another job folder stays denied', () => {
  const t = setup();
  assert.equal(t.call(join(t.root, `factory/jobs/${ID}/build.md`)).status, 0);
  assert.equal(t.call(join(t.root, 'factory/jobs/002-other/build.md')).status, 2);
});
