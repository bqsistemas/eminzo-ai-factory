// factory/bin/protect-tests: the PreToolUse hook that stops the builder editing a protected test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
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
const REASON = 'protected test; the gate fails the round';

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-protect-')));
  const root = join(dir, 'root');
  mkdirSync(join(root, 'factory'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ base: 'origin/main', protected_tests: ['test/guarded.test.js', './test/other.test.js'] }));
  writeFileSync(join(root, 'test/guarded.test.js'), '// guarded\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const worktree = join(root, '.worktrees', 'wt');
  git(root, 'worktree', 'add', '-q', worktree, '-b', 'factory/wt', 'HEAD');
  const call = (input, cwd = worktree) => spawnSync('sh', [hook], { cwd, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...GIT_ENV, FACTORY_ROOT: undefined } });
  return { dir, root, worktree, call };
}

test('AC-1: the hook denies a protected path with the reason and allows every other path', () => {
  const t = setup();
  for (const [tool_name, key] of [['Edit', 'file_path'], ['Write', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']]) {
    const denied = t.call({ tool_name, tool_input: { [key]: join(t.worktree, 'test/guarded.test.js') }, cwd: t.worktree });
    assert.equal(denied.status, 2, `${tool_name} denied`);
    assert.equal(denied.stderr.trim(), REASON);
  }
  const allowed = t.call({ tool_name: 'Edit', tool_input: { file_path: join(t.worktree, 'src/app.js') }, cwd: t.worktree });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stderr, '');
  assert.equal(t.call({ tool_name: 'Edit', tool_input: { file_path: join(t.worktree, 'test/guarded.test.js.bak') } }).status, 0);
});

test('AC-1: relative paths resolve against the hook cwd, and the main checkout copy is protected too', () => {
  const t = setup();
  assert.equal(t.call({ tool_name: 'Write', tool_input: { file_path: 'test/guarded.test.js' }, cwd: t.worktree }).status, 2);
  assert.equal(t.call({ tool_name: 'Write', tool_input: { file_path: join(t.root, 'test/guarded.test.js') }, cwd: t.worktree }).status, 2);
  assert.equal(t.call({ tool_name: 'Write', tool_input: { file_path: join(t.worktree, 'test/./other.test.js') }, cwd: t.worktree }).status, 2, 'a ./ entry and a dotted path still match');
  assert.equal(t.call({ tool_name: 'Write', tool_input: { file_path: join(t.worktree, 'src/../test/guarded.test.js') }, cwd: t.worktree }).status, 2);
});

test('AC-1: the same name in another folder, a file outside any repo and a non-file tool are allowed', () => {
  const t = setup();
  assert.equal(t.call({ tool_name: 'Edit', tool_input: { file_path: join(t.worktree, 'sub/test/guarded.test.js') } }).status, 0);
  assert.equal(t.call({ tool_name: 'Write', tool_input: { file_path: join(t.dir, 'notes.txt') } }, t.dir).status, 0);
  assert.equal(t.call({ tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'nowhere/deep/x.txt') } }, t.dir).status, 0);
  assert.equal(t.call({ tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0);
});

test('malformed input or a repo without config fails open (the gate is the backstop)', () => {
  const t = setup();
  const bad = spawnSync('sh', [hook], { cwd: t.worktree, input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  const bare = mkdtempSync(join(tmpdir(), 'factory-protect-bare-'));
  git(bare, 'init', '-q', '-b', 'main');
  assert.equal(t.call({ tool_name: 'Edit', tool_input: { file_path: join(bare, 'test/guarded.test.js') } }, bare).status, 0);
});

test('only the Claude builder declares the hook; Codex profiles have none and the gate stays their backstop', () => {
  const builder = readFileSync(join(repo, '.claude/agents/eminzo-builder.md'), 'utf8');
  assert.match(builder, /PreToolUse:\n    - matcher: Edit\|Write\|MultiEdit\|NotebookEdit\n      hooks:\n        - type: command\n          command: '"\$CLAUDE_PROJECT_DIR"\/factory\/bin\/protect-tests'/);
  for (const f of readdirSync(join(repo, '.claude/agents')).filter((n) => n !== 'eminzo-builder.md')) {
    assert.doesNotMatch(readFileSync(join(repo, '.claude/agents', f), 'utf8'), /protect-tests/, f);
  }
  for (const f of readdirSync(join(repo, '.codex/agents'))) assert.doesNotMatch(readFileSync(join(repo, '.codex/agents', f), 'utf8'), /protect-tests|PreToolUse/, f);
});
