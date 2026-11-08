import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../cli/src/installer/preflight.js';

const ok = { isGitRepo: true, clean: true, branch: 'main', defaultBranch: 'main', remoteUrl: 'https://github.com/acme/web', ghAuthed: true, nodeMajor: 20 };
const codes = (facts) => preflight({ ...ok, ...facts }).map((p) => p.code);

test('a clean GitHub repo on its default branch with gh and Node 20 has no problems', () => {
  assert.deepEqual(preflight(ok), []);
  assert.deepEqual(preflight({ ...ok, remoteUrl: 'git@github.com:acme/web.git', nodeMajor: 22 }), []);
});

test('each missing prerequisite is its own blocking problem with a readable message', () => {
  assert.deepEqual(codes({ isGitRepo: false }), ['not-git']);
  assert.deepEqual(codes({ clean: false }), ['dirty']);
  assert.deepEqual(codes({ branch: 'feat/x' }), ['not-default-branch']);
  assert.deepEqual(codes({ remoteUrl: null }), ['no-remote']);
  assert.deepEqual(codes({ remoteUrl: 'https://gitlab.com/a/b.git' }), ['not-github']);
  assert.deepEqual(codes({ ghAuthed: false }), ['gh-auth']);
  assert.deepEqual(codes({ nodeMajor: 18 }), ['node-version']);
  assert.deepEqual(codes({ nodeMajor: null }), ['node-version']);
  for (const p of preflight({ ...ok, clean: false, ghAuthed: false })) assert.ok(p.message.length > 20 && p.message.endsWith(".") && !p.message.includes(p.code), p.code);
});

test('not a git repo is reported alone, since every other fact is meaningless then', () => {
  assert.deepEqual(codes({ isGitRepo: false, clean: false, remoteUrl: null, ghAuthed: false }), ['not-git']);
});

test('several problems are all reported in a stable order', () => {
  assert.deepEqual(codes({ clean: false, ghAuthed: false, nodeMajor: 16 }), ['dirty', 'gh-auth', 'node-version']);
});

test('messages name the branch and the node version', () => {
  assert.match(preflight({ ...ok, branch: 'feat/x' })[0].message, /feat\/x.*main/);
  assert.match(preflight({ ...ok, nodeMajor: 18 })[0].message, /18/);
});

test('planned paths that .gitignore ignores block the install, naming them, instead of being force-added', () => {
  const problems = preflight({ ...ok, ignoredPaths: ['.claude/agents/eminzo-builder.md', '.claude/skills/eminzo-factory/SKILL.md'] });
  assert.deepEqual(problems.map((p) => p.code), ['ignored-paths']);
  assert.match(problems[0].message, /\.claude\/agents\/eminzo-builder\.md/);
  assert.match(problems[0].message, /\.gitignore/);
  assert.deepEqual(codes({ ignoredPaths: [] }), []);
  const many = preflight({ ...ok, ignoredPaths: Array.from({ length: 20 }, (_, i) => `f${i}`) })[0].message;
  assert.match(many, /and 15 more/);
});

test('a default branch that could be read as an option or escape its ref is a blocking problem', () => {
  for (const bad of ['--upload-pack=x', '-x', 'a b', 'a;b', 'a..b', 'a"b', '$(x)']) {
    assert.deepEqual(codes({ defaultBranch: bad, branch: bad }), ['bad-branch'], bad);
  }
  assert.deepEqual(codes({ defaultBranch: 'release/1.2_x', branch: 'release/1.2_x' }), []);
});
