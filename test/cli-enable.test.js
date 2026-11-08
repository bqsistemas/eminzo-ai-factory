// `eminzo enable` opens one pull request that adds only the repository's own factory files
// (config pinned to the engine's minor, checks.sh, a project.md draft, .gitignore lines and the
// eminzo permission) and no engine code. Each test uses a local bare origin that git reaches
// through `url.<bare>.insteadOf https://github.com/acme/shop`, and a fake gh that logs its calls.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../cli/build.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = join(repo, 'cli/bin/eminzo.js');
const version = JSON.parse(readFileSync(join(repo, 'cli/package.json'), 'utf8')).version;
const minor = `${version.split('.').slice(0, 2).join('.')}.x`;
const URL_ = 'https://github.com/acme/shop';
let dist;

before(() => {
  dist = join(mkdtempSync(join(tmpdir(), 'eminzo-enable-dist-')), 'dist');
  build({ out: dist });
});

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com',
};

function setup({ files = { 'package.json': '{"scripts":{"test":"node --test"}}\n', 'README.md': '# shop\n' } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eminzo-enable-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'shop');
  const env = { ...process.env, ...GIT_ENV, HOME: join(dir, 'home'), EMINZO_DIST: dist };
  delete env.EMINZO_ENGINE;
  delete env.FACTORY_ROOT;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'config', `url.${origin}.insteadOf`, URL_);
  git(root, 'remote', 'add', 'origin', URL_);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'remote', 'set-head', 'origin', 'main');

  const log = join(dir, 'gh.log');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "auth status") exit 0 ;;
  "pr create") echo "${URL_}/pull/7" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const run = (args = []) => spawnSync(process.execPath, [bin, 'enable', ...args], { cwd: root, env: { ...env, FACTORY_GH: gh }, encoding: 'utf8' });
  return { dir, root, origin, git, run, ghLog: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

test('enable opens one pull request with only the repository footprint', () => {
  const t = setup();
  const res = t.run();
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /https:\/\/github\.com\/acme\/shop\/pull\/7/);
  assert.match(res.stdout, /\/eminzo-factory setup/);

  const changed = t.git(t.origin, 'diff', '--name-only', 'main', 'chore/enable-factory').split('\n').sort();
  assert.deepEqual(changed, ['.claude/settings.json', '.gitignore', 'factory/checks.sh', 'factory/config.json', 'factory/project.md']);
  assert.equal(t.git(t.origin, 'log', '-1', '--format=%s', 'chore/enable-factory'), 'chore: enable software factory');

  const show = (path) => t.git(t.origin, 'show', `chore/enable-factory:${path}`);
  const config = JSON.parse(show('factory/config.json'));
  assert.equal(Object.keys(config)[0], 'engine');
  assert.equal(config.engine, minor);
  assert.equal(config.repo, URL_);
  assert.equal(config.base, 'origin/main');
  assert.match(show('factory/checks.sh'), /npm test/);
  assert.match(show('factory/project.md'), /first draft from `eminzo init`/);
  assert.match(show('.gitignore'), /factory\/jobs\//);
  assert.deepEqual(JSON.parse(show('.claude/settings.json')).permissions.allow, ['Bash(eminzo:*)']);
  assert.equal(t.git(t.origin, 'ls-tree', 'chore/enable-factory', 'factory/checks.sh').split(' ')[0], '100755');

  assert.match(t.ghLog(), /pr create --repo acme\/shop --base main --head chore\/enable-factory/);
  assert.equal(t.git(t.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'back on the default branch');
  assert.equal(t.git(t.root, 'status', '--porcelain'), '', 'the checkout is clean');
});

test('enable keeps existing .gitignore and .claude/settings.json entries', () => {
  const t = setup({ files: {
    'README.md': '# shop\n',
    '.gitignore': 'node_modules/\n',
    '.claude/settings.json': '{"model":"opus","permissions":{"allow":["Bash(npm test)"]}}\n',
  } });
  const res = t.run();
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const show = (path) => t.git(t.origin, 'show', `chore/enable-factory:${path}`);
  assert.match(show('.gitignore'), /^node_modules\/\n/);
  const settings = JSON.parse(show('.claude/settings.json'));
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.permissions.allow, ['Bash(npm test)', 'Bash(eminzo:*)']);
  assert.match(show('factory/checks.sh'), /TODO add this repo's test command/, 'no stack: a placeholder the developer completes');
});

test('enable --dry-run lists the files and changes nothing', () => {
  const t = setup();
  const res = t.run(['--dry-run']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /write factory\/config\.json/);
  assert.match(res.stdout, /dry run/);
  assert.equal(t.git(t.root, 'branch', '--list', 'chore/enable-factory'), '');
  assert.equal(existsSync(join(t.root, 'factory')), false);
});

test('enable stops on a failed preflight check, naming it, before writing anything', () => {
  const t = setup();
  writeFileSync(join(t.root, 'README.md'), '# changed\n');
  const res = t.run();
  assert.equal(res.status, 1);
  assert.match(res.stdout, /FAIL The working tree has uncommitted changes/);
  assert.equal(t.git(t.root, 'branch', '--list', 'chore/enable-factory'), '');
  assert.equal(existsSync(join(t.root, 'factory')), false);
});

test('enable refuses a repository that already has the factory', () => {
  const t = setup({ files: { 'factory/config.json': '{}\n' } });
  const res = t.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /already enabled here \(factory\/config\.json exists\)/);
});

test('enable refuses when its branch already exists', () => {
  const t = setup();
  t.git(t.root, 'branch', 'chore/enable-factory');
  const res = t.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /the branch chore\/enable-factory already exists/);
  assert.equal(statSync(join(t.root, 'README.md')).isFile(), true);
  assert.equal(existsSync(join(t.root, 'factory')), false);
});

test('enable keeps a checks.sh or project.md the default branch already has', () => {
  const t = setup({ files: { 'README.md': '# shop\n', 'factory/checks.sh': '#!/bin/sh\nmake test\n', 'factory/project.md': '# Mine\n' } });
  const res = t.run();
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const changed = t.git(t.origin, 'diff', '--name-only', 'main', 'chore/enable-factory').split('\n').sort();
  assert.deepEqual(changed, ['.claude/settings.json', '.gitignore', 'factory/config.json']);
  assert.equal(readFileSync(join(t.root, 'factory/project.md'), 'utf8'), '# Mine\n', 'the checkout keeps the file');
});

test('enable builds on origin, not on a local default branch that is behind', () => {
  const t = setup({ files: { 'README.md': '# shop\n', '.gitignore': 'node_modules/\n' } });
  // Someone else pushes a .gitignore change; the local main does not have it.
  const other = join(t.dir, 'other');
  t.git(t.dir, 'clone', '-q', t.origin, other);
  writeFileSync(join(other, '.gitignore'), 'node_modules/\ncoverage/\n');
  t.git(other, 'commit', '-q', '-am', 'ignore coverage');
  t.git(other, 'push', '-q', 'origin', 'main');
  const res = t.run();
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const ignore = t.git(t.origin, 'show', 'chore/enable-factory:.gitignore');
  assert.match(ignore, /^node_modules\/\ncoverage\/\n/, 'the upstream line is kept');
  assert.match(ignore, /factory\/jobs\//);
});

test('enable refuses when the default branch cannot be determined', () => {
  const t = setup();
  t.git(t.root, 'remote', 'set-head', 'origin', '--delete');
  const res = t.run();
  assert.equal(res.status, 1);
  assert.match(res.stdout, /default branch of origin is unknown/);
});

test('enable names the pushed branch and the command to open the pull request when gh fails', () => {
  const t = setup();
  const failing = join(t.dir, 'gh-fail');
  writeFileSync(failing, '#!/bin/sh\ncase "$1 $2" in "auth status") exit 0 ;; *) echo "HTTP 502" >&2; exit 1 ;; esac\n', { mode: 0o755 });
  const res = spawnSync(process.execPath, [bin, 'enable'], { cwd: t.root, env: { ...process.env, ...GIT_ENV, HOME: join(t.dir, 'home'), EMINZO_DIST: dist, FACTORY_GH: failing }, encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /gh pr create failed: HTTP 502\. The branch chore\/enable-factory is pushed: open the pull request with: gh pr create --repo acme\/shop --base main --head chore\/enable-factory/);
  assert.equal(t.git(t.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('enable --json prints one JSON object: the pull request on success', () => {
  const t = setup();
  const res = t.run(['--json']);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.url, `${URL_}/pull/7`);
  assert.equal(out.repo, 'acme/shop');
  assert.equal(out.base, 'main');
  assert.equal(out.branch, 'chore/enable-factory');
  assert.equal(out.engine, minor);
  assert.equal(out.stack, 'node');
  assert.deepEqual(out.files, ['factory/config.json', 'factory/checks.sh', 'factory/project.md', '.gitignore', '.claude/settings.json']);
  assert.deepEqual(out.kept, []);
});

test('enable --json reports failed checks with their codes, and refusals as an error', () => {
  const dirty = setup();
  writeFileSync(join(dirty.root, 'README.md'), '# changed\n');
  const failed = dirty.run(['--json']);
  assert.equal(failed.status, 1);
  const out = JSON.parse(failed.stdout);
  assert.equal(out.ok, false);
  assert.deepEqual(out.problems.map((p) => p.code), ['dirty']);
  assert.match(out.problems[0].message, /uncommitted changes/);

  const enabled = setup({ files: { 'factory/config.json': '{}\n' } });
  const refused = enabled.run(['--json']);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, '');
  const err = JSON.parse(refused.stdout);
  assert.equal(err.ok, false);
  assert.match(err.error, /already enabled here/);
});

test('enable --dry-run --json lists the plan and writes nothing', () => {
  const t = setup();
  const res = t.run(['--dry-run', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.dryRun, true);
  assert.ok(out.files.includes('factory/config.json'));
  assert.equal(existsSync(join(t.root, 'factory')), false);
});
