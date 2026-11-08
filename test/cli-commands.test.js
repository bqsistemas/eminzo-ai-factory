// The eminzo command: engine commands run the packaged engine on the repo of the current
// directory (EMINZO_ENGINE set, the repo's `engine` range enforced), a repo that commits its own
// engine keeps running it, and install/uninstall/doctor/show manage the user-level adapters.
// Each test spawns cli/bin/eminzo.js with a throwaway HOME and a dist built once into a temp folder.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../cli/build.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = join(repo, 'cli/bin/eminzo.js');
const version = JSON.parse(readFileSync(join(repo, 'cli/package.json'), 'utf8')).version;
const configText = readFileSync(join(repo, 'factory/templates/config.json'), 'utf8');
let dist;

before(() => {
  dist = join(mkdtempSync(join(tmpdir(), 'eminzo-cmd-dist-')), 'dist');
  build({ out: dist });
});

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** A temp HOME and a temp folder for repos; `run` spawns eminzo there. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'eminzo-cmd-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const env = { ...process.env, ...GIT_ENV, HOME: home, EMINZO_DIST: dist };
  delete env.EMINZO_ENGINE;
  delete env.FACTORY_ROOT;
  const run = (args, { cwd = dir, extra = {} } = {}) => spawnSync(process.execPath, [bin, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  return { dir, home, env, run };
}

/** A git repo under `dir` with factory/config.json (engine range `engine`, omitted when null). */
function repoWith(dir, { engine = `${version.split('.').slice(0, 2).join('.')}.x`, config = true } = {}) {
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'factory'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: { ...process.env, ...GIT_ENV } });
  if (config) {
    const cfg = JSON.parse(configText.replace('__REPO__', 'https://github.com/acme/shop').replace('__BASE__', 'origin/main'));
    writeFileSync(join(root, 'factory/config.json'), JSON.stringify(engine === null ? cfg : { engine, ...cfg }, null, 2));
  }
  return root;
}

test('--version prints the package version; help lists the commands; an unknown command is a usage error', () => {
  const t = sandbox();
  assert.equal(t.run(['--version']).stdout.trim(), version);
  const help = t.run(['help']);
  assert.equal(help.status, 0);
  for (const cmd of ['install', 'uninstall', 'doctor', 'enable', 'show', 'job', 'setup']) assert.match(help.stdout, new RegExp(`\\b${cmd}\\b`));
  const bad = t.run(['frobnicate']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown command: frobnicate/);
});

test('an engine command outside an enabled repo says to enable the factory', () => {
  const t = sandbox();
  const root = repoWith(t.dir, { config: false });
  const res = t.run(['job', 'summary'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no factory in this repo; run \/eminzo-factory enable/);
});

test('an engine command runs the packaged engine on the repo of the current directory', () => {
  const t = sandbox();
  const root = repoWith(t.dir);
  const res = t.run(['job', 'config', 'language'], { cwd: root });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'language team "es"');
  assert.equal(res.stderr, '');
  const init = t.run(['init'], { cwd: root, extra: { FACTORY_TODAY: '2026-11-08' } });
  assert.equal(init.status, 0, init.stderr);
  assert.match(readFileSync(join(root, 'factory/project.md'), 'utf8'), /first draft from `eminzo init`/, 'the engine knows it runs as eminzo');
});

test('the repo\'s engine range is enforced; a missing range only warns', () => {
  const t = sandbox();
  const pinned = repoWith(join(t.dir, 'a'), { engine: '9.9.x' });
  const refused = t.run(['job', 'summary'], { cwd: pinned });
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes(`engine ${version} does not satisfy "9.9.x" in factory/config.json`), refused.stderr);
  const invalid = repoWith(join(t.dir, 'b'), { engine: 'latest' });
  const bad = t.run(['job', 'summary'], { cwd: invalid });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /factory\/config\.json: engine: "latest" is not a supported range/);
  const loose = repoWith(join(t.dir, 'c'), { engine: null });
  const warned = t.run(['job', 'summary'], { cwd: loose });
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, new RegExp(`warning: factory/config.json has no "engine" range; running eminzo ${version.replace(/\./g, '\\.')}`));
});

test('a repo that commits its own engine keeps running it, without EMINZO_ENGINE', () => {
  const t = sandbox();
  const root = repoWith(t.dir);
  mkdirSync(join(root, 'factory/lib'), { recursive: true });
  mkdirSync(join(root, 'factory/bin'), { recursive: true });
  writeFileSync(join(root, 'factory/lib/job.js'), '// committed engine\n');
  writeFileSync(join(root, 'factory/bin/job'), '#!/bin/sh\necho "repo engine $* ${EMINZO_ENGINE:-unset}"\n', { mode: 0o755 });
  const res = t.run(['job', 'summary'], { cwd: root, extra: { EMINZO_ENGINE: '/elsewhere' } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'repo engine summary unset');
});

test('install writes the adapters under HOME, is idempotent, and records what it wrote', () => {
  const t = sandbox();
  const dry = t.run(['install', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /create ~\/\.claude\/skills\/eminzo-factory\/SKILL\.md/);
  assert.equal(existsSync(join(t.home, '.claude')), false, 'dry run writes nothing');

  const first = t.run(['install']);
  assert.equal(first.status, 0, first.stderr);
  for (const rel of ['.claude/skills/eminzo-factory/SKILL.md', '.claude/agents/eminzo-builder.md', '.agents/skills/eminzo-factory/SKILL.md', '.codex/agents/eminzo-builder.toml']) {
    assert.ok(existsSync(join(t.home, rel)), rel);
  }
  const manifest = JSON.parse(readFileSync(join(t.home, '.eminzo/install.json'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.files.length, 18);

  const again = t.run(['install']);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^(create|update)/m);
  assert.match(again.stdout, /up to date/);
});

test('install keeps a file it did not write or that the user changed, unless --force', () => {
  const t = sandbox();
  mkdirSync(join(t.home, '.claude/agents'), { recursive: true });
  writeFileSync(join(t.home, '.claude/agents/eminzo-intake.md'), 'mine\n');
  const res = t.run(['install']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /skip ~\/\.claude\/agents\/eminzo-intake\.md \(not written by eminzo\)/);
  assert.equal(readFileSync(join(t.home, '.claude/agents/eminzo-intake.md'), 'utf8'), 'mine\n');
  assert.ok(existsSync(join(t.home, '.claude/agents/eminzo-builder.md')), 'the rest is installed');

  writeFileSync(join(t.home, '.claude/agents/eminzo-builder.md'), 'edited\n');
  const changed = t.run(['install']);
  assert.match(changed.stdout, /skip ~\/\.claude\/agents\/eminzo-builder\.md \(changed since eminzo installed it\)/);
  const forced = t.run(['install', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.notEqual(readFileSync(join(t.home, '.claude/agents/eminzo-builder.md'), 'utf8'), 'edited\n');
  assert.notEqual(readFileSync(join(t.home, '.claude/agents/eminzo-intake.md'), 'utf8'), 'mine\n');
});

test('engine commands refuse adapters installed by another version', () => {
  const t = sandbox();
  const root = repoWith(t.dir);
  mkdirSync(join(t.home, '.eminzo'), { recursive: true });
  writeFileSync(join(t.home, '.eminzo/install.json'), JSON.stringify({ version: '0.0.1', files: [] }));
  const res = t.run(['job', 'summary'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, new RegExp(`the installed skill and agents are from eminzo 0\\.0\\.1, the engine is ${version.replace(/\./g, '\\.')}; run: eminzo install`));
});

test('uninstall removes only the unchanged files install wrote', () => {
  const t = sandbox();
  t.run(['install']);
  writeFileSync(join(t.home, '.claude/agents/eminzo-builder.md'), 'edited\n');
  mkdirSync(join(t.home, '.claude/agents'), { recursive: true });
  writeFileSync(join(t.home, '.claude/agents/other.md'), 'not ours\n');
  const res = t.run(['uninstall']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /keep ~\/\.claude\/agents\/eminzo-builder\.md \(changed since eminzo installed it\)/);
  assert.equal(existsSync(join(t.home, '.claude/skills/eminzo-factory')), false);
  assert.equal(existsSync(join(t.home, '.claude/agents/eminzo-intake.md')), false);
  assert.ok(existsSync(join(t.home, '.claude/agents/eminzo-builder.md')));
  assert.ok(existsSync(join(t.home, '.claude/agents/other.md')));
  assert.equal(existsSync(join(t.home, '.eminzo/install.json')), false);
});

test('show prints an engine role or template and nothing else', () => {
  const t = sandbox();
  const role = t.run(['show', 'roles/builder.md']);
  assert.equal(role.status, 0, role.stderr);
  assert.equal(role.stdout, readFileSync(join(repo, 'factory/roles/builder.md'), 'utf8'));
  assert.equal(t.run(['show', 'templates/project.md']).status, 0);
  for (const bad of ['lib/job.js', '../factory/config.json', 'roles/../lib/job.js', 'roles/nope.md']) {
    const res = t.run(['show', bad]);
    assert.notEqual(res.status, 0, bad);
  }
});

test('doctor passes when everything is in place and names each failing check otherwise', () => {
  const t = sandbox();
  const root = repoWith(t.dir);
  const tools = join(t.dir, 'tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  symlinkSync(bin, join(tools, 'eminzo'));
  const extra = { FACTORY_GH: join(tools, 'gh'), PATH: `${tools}:${process.env.PATH}` };
  const before = t.run(['doctor'], { cwd: root, extra });
  assert.equal(before.status, 1);
  assert.match(before.stdout, /FAIL\s+adapters: not installed; run: eminzo install/);
  t.run(['install']);
  const after = t.run(['doctor'], { cwd: root, extra });
  assert.equal(after.status, 0, after.stdout);
  assert.match(after.stdout, /ok\s+engine range/);
});

test('a partial install (a skipped file) blocks engine commands until a full one', () => {
  const t = sandbox();
  const root = repoWith(t.dir);
  mkdirSync(join(t.home, '.claude/agents'), { recursive: true });
  writeFileSync(join(t.home, '.claude/agents/eminzo-intake.md'), 'mine\n');
  assert.equal(t.run(['install']).status, 1);
  assert.equal(JSON.parse(readFileSync(join(t.home, '.eminzo/install.json'), 'utf8')).version, 'partial');
  const res = t.run(['job', 'summary'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /the last eminzo install skipped files/);
  assert.equal(t.run(['install', '--force']).status, 0);
  assert.equal(t.run(['job', 'summary'], { cwd: root }).status, 0);
});

test('a SIGTERM to eminzo reaches the engine it started', async () => {
  const t = sandbox();
  const root = repoWith(t.dir);
  mkdirSync(join(root, 'factory/lib'), { recursive: true });
  mkdirSync(join(root, 'factory/bin'), { recursive: true });
  writeFileSync(join(root, 'factory/lib/job.js'), '// committed engine\n');
  const pidFile = join(t.dir, 'engine.pid');
  writeFileSync(join(root, 'factory/bin/job'), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [bin, 'job', 'summary'], { cwd: root, env: t.env, stdio: 'ignore' });
  const exited = new Promise((ok) => child.on('exit', (code, signal) => ok({ code, signal })));
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  for (let i = 0; i < 100 && !existsSync(pidFile); i += 1) await wait(50);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 143, 'eminzo exits with 128+SIGTERM');
  let alive = true;
  for (let i = 0; i < 40 && alive; i += 1) {
    try { process.kill(pid, 0); await wait(50); } catch { alive = false; }
  }
  assert.equal(alive, false, 'the engine process stopped too');
});

test('doctor --json gives each check an id and the state of the repository', () => {
  const t = sandbox();
  const root = repoWith(t.dir);
  const tools = join(t.dir, 'tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  symlinkSync(bin, join(tools, 'eminzo'));
  const extra = { FACTORY_GH: join(tools, 'gh'), PATH: `${tools}:${process.env.PATH}` };
  t.run(['install']);
  const res = t.run(['doctor', '--json'], { cwd: root, extra });
  assert.equal(res.status, 0, res.stdout);
  const out = JSON.parse(res.stdout);
  assert.equal(out.version, version);
  assert.equal(out.ok, true);
  assert.deepEqual(out.checks.map((c) => c.id), ['node', 'git', 'gh', 'path', 'adapters', 'engine', 'setup']);
  assert.ok(out.checks.every((c) => ['ok', 'warn', 'fail'].includes(c.level) && c.name && c.detail));
  assert.equal(out.repository.root, realpathSync(root));
  assert.equal(out.repository.enabled, true);
  assert.equal(out.repository.committedEngine, false);
  assert.equal(out.repository.engine, `${version.split('.').slice(0, 2).join('.')}.x`);
  assert.equal(out.repository.engineOk, true);
  assert.equal(out.repository.setup, false);

  const outside = JSON.parse(t.run(['doctor', '--json'], { cwd: t.dir, extra }).stdout);
  assert.equal(outside.repository, null);
  const bare = repoWith(join(t.dir, 'bare'), { config: false });
  const notEnabled = JSON.parse(t.run(['doctor', '--json'], { cwd: bare, extra }).stdout);
  assert.equal(notEnabled.repository.enabled, false);
  assert.equal(notEnabled.checks.find((c) => c.id === 'repository').level, 'warn');
});

test('eminzo nudge passes --full through to the engine: focused by hand, full with the flag', () => {
  const t = sandbox();
  const root = repoWith(t.dir, { engine: null });
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' }, encoding: 'utf8' });
  writeFileSync(join(root, 'factory/checks.sh'), '#!/bin/sh\necho "$FACTORY_CHECK_MODE" >> "$OUT"\n', { mode: 0o755 });
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const worktree = join(t.dir, 'wt');
  git(root, 'worktree', 'add', '-q', worktree, '-b', 'factory/007-x', 'HEAD');
  const jobDir = join(root, 'factory/jobs/007-x');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ id: '007-x', worktree }));
  const out = join(t.dir, 'modes');
  const extra = { OUT: out, FACTORY_CHECK_MODE: 'focused' };
  assert.equal(t.run(['nudge', '007-x'], { cwd: root, extra }).status, 0);
  writeFileSync(join(worktree, 'b.txt'), 'b\n'); // a new tree: nothing is reused
  const full = t.run(['nudge', '007-x', '--full'], { cwd: root, extra });
  assert.equal(full.status, 0, full.stderr);
  assert.equal(readFileSync(out, 'utf8'), 'focused\nfull\n');
});

test('eminzo selfcheck <id> is `job <id> selfcheck`; eminzo protect-tests is the builder hook', () => {
  const t = sandbox();
  const root = repoWith(t.dir, { engine: null });
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' }, encoding: 'utf8' });
  const cfg = JSON.parse(readFileSync(join(root, 'factory/config.json'), 'utf8'));
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ ...cfg, protected_tests: ['test/guarded.test.js'] }));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test/guarded.test.js'), '// guarded\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const worktree = join(t.dir, 'wt');
  git(root, 'worktree', 'add', '-q', worktree, '-b', 'factory/007-x', 'HEAD');
  const jobDir = join(root, 'factory/jobs/007-x');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ id: '007-x', worktree }));
  writeFileSync(join(jobDir, 'spec.md'), '# Spec: x\n- AC-1: a thing\n');
  writeFileSync(join(jobDir, 'plan.md'), '## Files that change\n## Order of work\n## Risks\n## Proof\n');
  const missing = t.run(['selfcheck', '007-x'], { cwd: root });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /AC-1 has no test/);
  writeFileSync(join(worktree, 'x.test.js'), "test('AC-1: a thing', () => {});\n");
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'test');
  const ok = t.run(['selfcheck', '007-x'], { cwd: root });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout.trim(), 'selfcheck: ok');
  assert.equal(t.run(['job', '007-x', 'selfcheck'], { cwd: root }).stdout.trim(), 'selfcheck: ok');
  assert.equal(t.run(['selfcheck'], { cwd: root }).status, 2);
  assert.match(t.run(['help']).stdout, /eminzo selfcheck <job-id>/);

  const hook = (file_path) => spawnSync(process.execPath, [bin, 'protect-tests'], { cwd: root, env: { ...t.env }, input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path }, cwd: worktree }), encoding: 'utf8' });
  const denied = hook(join(worktree, 'test/guarded.test.js'));
  assert.equal(denied.status, 2);
  assert.equal(denied.stderr, 'protected test; the gate fails the round\n', 'no engine-range warning before the reason');
  assert.equal(hook(join(worktree, 'src/a.js')).status, 0);
});
