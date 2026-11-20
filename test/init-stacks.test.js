// P13: init writes factory/checks.sh, the project.md commands and selfcheck.ac_pattern per stack,
// from the same module (factory/lib/stacks.js) that `eminzo enable` uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sectionText } from '../factory/lib/project-map.js';
import { acPattern, checksFor, prepareCommand } from '../factory/lib/stacks.js';
import { configText } from '../cli/src/enable.js';
import { detectChecks } from '../cli/src/installer/checks.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = '{\n  "selfcheck": { "ac_pattern": "AC-\\\\d+" }\n}\n';
function sandbox(files, { config = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-stacks-'));
  mkdirSync(join(root, 'factory'), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    if (name.endsWith('/')) mkdirSync(join(root, name), { recursive: true });
    else writeFileSync(join(root, name), text);
  }
  if (config) writeFileSync(join(root, 'factory/config.json'), CONFIG);
  return root;
}
const init = (root) => spawnSync(join(repo, 'factory/bin/init'), [], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root, FACTORY_TODAY: '2026-11-01' } });
const checks = (root) => readFileSync(join(root, 'factory/checks.sh'), 'utf8');

test('AC-1: go.mod and no checks.sh: init writes an executable checks.sh that passes sh -n and calls go test', () => {
  const root = sandbox({ 'go.mod': 'module x\n' });
  assert.equal(init(root).status, 0);
  const file = join(root, 'factory/checks.sh');
  assert.equal(spawnSync('sh', ['-n', file]).status, 0);
  assert.match(checks(root), /^go test \.\/\.\.\.$/m);
  assert.equal(spawnSync('test', ['-x', file]).status, 0, 'executable');
});

test('AC-2: package.json: checks.sh uses the existing scripts and the package manager', () => {
  const pkg = { scripts: { test: 'jest', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'tsc' } };
  const root = sandbox({ 'package.json': JSON.stringify(pkg), 'pnpm-lock.yaml': '' });
  init(root);
  const text = checks(root);
  assert.match(text, /^pnpm run lint$/m);
  assert.match(text, /^pnpm run typecheck$/m);
  assert.match(text, /^pnpm test$/m);
  assert.match(text, /jest --findRelatedTests/);
  assert.equal(spawnSync('sh', ['-n', join(root, 'factory/checks.sh')]).status, 0);
  const plain = detectChecks({ files: ['package.json'], packageJson: { scripts: { test: 'node --test' } }, read: () => '' }).script;
  assert.doesNotMatch(plain, /@[A-Z]+@|npm run|focused:begin/, 'no placeholder left; an unknown runner always runs full');
});

test('AC-3: an existing checks.sh is left intact and init says so', () => {
  const root = sandbox({ 'go.mod': 'module x\n' });
  writeFileSync(join(root, 'factory/checks.sh'), '#!/bin/sh\nexit 0\n');
  const res = init(root);
  assert.equal(checks(root), '#!/bin/sh\nexit 0\n');
  assert.match(res.stdout, /checks\.sh already exists; left untouched/);
});

// Each fixture is a real testable setup; the stack-specific command must show in checks.sh and in project.md.
const FIXTURES = [
  ['node', { 'package.json': JSON.stringify({ scripts: { test: 'jest', start: 'node .', build: 'tsc' } }) }, 'npm test'],
  ['go', { 'go.mod': 'module x\n' }, 'go test ./...'],
  ['python', { 'pyproject.toml': '[tool.pytest.ini_options]\n' }, 'python -m pytest'],
  ['rust', { 'Cargo.toml': '[package]\n' }, 'cargo test'],
  ['ruby', { Gemfile: '', 'spec/': '' }, 'bundle exec rspec'],
  ['maven', { 'pom.xml': '<project/>' }, 'mvn -B -q test'],
  ['gradle', { 'build.gradle': '', gradlew: '' }, './gradlew test'],
];
test('AC-4: for each of the seven manifests project.md has no TODO in Commands and agrees with checks.sh', () => {
  for (const [stack, files, command] of FIXTURES) {
    const root = sandbox(files);
    assert.equal(init(root).status, 0, stack);
    const commands = sectionText(readFileSync(join(root, 'factory/project.md'), 'utf8'), 'Commands');
    assert.doesNotMatch(commands, /TODO/, stack);
    assert.ok(commands.includes(`\`${command}\``), `${stack}: project.md lacks ${command}`);
    assert.ok(checks(root).split('\n').some((l) => l === command || l.includes(`${command}; fi`)), `${stack}: checks.sh lacks ${command}`);
    assert.equal(spawnSync('sh', ['-n', join(root, 'factory/checks.sh')]).status, 0, stack);
  }
});

test('commands follow the stack checks.sh is written for, and name the other stacks found', () => {
  const root = sandbox({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }), 'pyproject.toml': '[tool.pytest.ini_options]\n' });
  init(root);
  const commands = sectionText(readFileSync(join(root, 'factory/project.md'), 'utf8'), 'Commands');
  assert.match(commands, /- Test: `python -m pytest`/);
  assert.match(commands, /Also found: node\./);
  assert.match(checks(root), /^python -m pytest$/m);
});

test('node: extra scripts are listed with their body, no TODO', () => {
  const root = sandbox({ 'package.json': JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } }) });
  init(root);
  assert.match(sectionText(readFileSync(join(root, 'factory/project.md'), 'utf8'), 'Commands'), /- `npm run lint`: runs `eslint \.`\n/);
});

test('a backtick in a script body does not break the code span', () => {
  const root = sandbox({ 'package.json': JSON.stringify({ scripts: { test: 'jest', x: 'echo `date`' } }) });
  init(root);
  assert.match(readFileSync(join(root, 'factory/project.md'), 'utf8'), /runs `` echo `date` ``/);
});

test('yarn and bun: checks.sh and project.md name the same package manager', () => {
  for (const [lock, test, lint] of [['yarn.lock', 'yarn test', 'yarn lint'], ['bun.lock', 'bun run test', 'bun run lint'], ['bun.lockb', 'bun run test', 'bun run lint']]) {
    const root = sandbox({ 'package.json': JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint' } }), [lock]: '' });
    init(root);
    const lines = checks(root).split('\n');
    assert.ok(lines.includes(test) && lines.includes(lint), lock);
    assert.ok(readFileSync(join(root, 'factory/project.md'), 'utf8').includes(`\`${test}\``), lock);
  }
});

test('ruby needs spec/ or test/ (a Rakefile alone keeps the no-stack gate); gradle without a wrapper uses gradle', () => {
  const none = sandbox({ Gemfile: '', Rakefile: '' });
  init(none);
  assert.match(checks(none), /no test command was detected/i);
  const both = sandbox({ Gemfile: '', 'spec/': '', 'test/': '' });
  init(both);
  assert.match(checks(both), /^if \[ -d spec \]; then bundle exec rspec; fi$/m);
  assert.match(readFileSync(join(both, 'factory/project.md'), 'utf8'), /bundle exec rspec && bundle exec rake test/);
  const gradle = sandbox({ 'build.gradle': '' });
  init(gradle);
  assert.match(checks(gradle), /^gradle test$/m);
  assert.doesNotMatch(checks(gradle).replace(/^#.*$/gm, ''), /gradlew/);
});

test('a dangling symlink or a non-executable checks.sh is left alone; the second is reported', () => {
  const link = sandbox({ 'go.mod': 'module x\n' });
  symlinkSync(join(link, 'nowhere.sh'), join(link, 'factory/checks.sh'));
  const res = init(link);
  assert.match(res.stdout, /already exists; left untouched/);
  assert.equal(existsSync(join(link, 'nowhere.sh')), false);
  const plain = sandbox({ 'go.mod': 'module x\n' });
  writeFileSync(join(plain, 'factory/checks.sh'), '#!/bin/sh\n');
  chmodSync(join(plain, 'factory/checks.sh'), 0o644);
  assert.match(init(plain).stdout, /warning: .*not executable/);
});

// Runs a generated checks.sh in focused mode with fake tools on PATH. Each fake records its arguments
// (one `arg:` line each, `--` ends a call), prints $LISTED for `--listTests`, and exits with $RC.
const FAKE = `#!/bin/sh
for a in "$@"; do printf 'arg:%s\\n' "$a" >> "$OUT"; done
printf -- '--\\n' >> "$OUT"
case " $* " in *" --listTests "*) [ -z "$LISTED" ] || printf '%s\\n' "$LISTED";; esac
exit \${RC:-0}
`;
function focused(files, changed, { rc = 0, tools = ['python'], listed = '', extra = [] } = {}) {
  const root = sandbox(files);
  init(root);
  for (const name of extra) writeFileSync(join(root, name), '');
  const bin = join(root, 'fakebin');
  mkdirSync(bin);
  for (const tool of tools) writeFileSync(join(bin, tool), FAKE, { mode: 0o755 });
  const list = join(root, 'changed.txt');
  writeFileSync(list, `${changed.join('\n')}\n`);
  const out = join(root, 'out.txt');
  writeFileSync(out, '');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OUT: out, RC: String(rc), LISTED: listed, FACTORY_CHECK_MODE: 'focused', FACTORY_CHANGED_FILES: list };
  const res = spawnSync('sh', [join(root, 'factory/checks.sh')], { cwd: root, encoding: 'utf8', env });
  const calls = readFileSync(out, 'utf8').split('--\n').map((c) => c.trim()).filter(Boolean).map((c) => c.split('\n').map((l) => l.slice(4)));
  return { status: res.status, calls };
}
const PY = { 'pyproject.toml': '[tool.pytest.ini_options]\n', 'tests/': '' };
const FULL_PY = [['-m', 'pytest']];

test('python template, focused: narrows only a diff of test files; everything else runs full', () => {
  assert.deepEqual(focused(PY, ['tests/test_a.py']).calls, FULL_PY, 'the only changed test was deleted: nothing to narrow to');
  assert.deepEqual(focused(PY, ['src/app.py']).calls, FULL_PY, 'a source change runs full');
  assert.deepEqual(focused(PY, ['tests/test_a.py', 'src/app.py'], { extra: ['tests/test_a.py'] }).calls, FULL_PY, 'a mixed diff runs full');
  assert.deepEqual(focused(PY, ['tests/test_a.py'], { extra: ['tests/test_a.py'] }).calls, [['-m', 'pytest', './tests/test_a.py']]);
});

test('python template, focused: a path with spaces stays one argument and a failing exit code propagates', () => {
  const r = focused(PY, ['tests/test_a b.py'], { extra: ['tests/test_a b.py'], rc: 3 });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, [['-m', 'pytest', './tests/test_a b.py']]);
});

test('node template, focused (plain jest): no related test falls through to the full run; related tests narrow', () => {
  const files = { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'src/': '' };
  const opts = { tools: ['npx', 'npm'], extra: ['src/a.js'] };
  const none = focused(files, ['src/a.js'], opts);
  assert.deepEqual(none.calls.map((c) => c[0]), ['--no-install', 'test'], 'probe finds nothing, then npm test');
  const some = focused(files, ['src/a.js'], { ...opts, listed: 'a.test.js' });
  assert.deepEqual(some.calls[some.calls.length - 1], ['--no-install', 'jest', '--findRelatedTests', './src/a.js']);
  assert.notEqual(focused(files, ['src/a.js'], { ...opts, listed: 'a.test.js', rc: 5 }).status, 0, 'a failing run fails');
});

test('node template keeps no narrowing block when the test script has flags or another runner', () => {
  for (const test of ['jest --coverage', 'vitest run', 'node --test']) {
    const root = sandbox({ 'package.json': JSON.stringify({ scripts: { test } }) });
    init(root);
    assert.doesNotMatch(checks(root), /findRelatedTests|focused:begin/, test);
  }
});

test('enable writes the stack ac_pattern into config.json', () => {
  const template = readFileSync(join(repo, 'factory/templates/config.json'), 'utf8');
  const args = { repoUrl: 'https://github.com/o/r', defaultBranch: 'main', version: '0.1.1' };
  assert.equal(JSON.parse(configText(template, { ...args, stack: 'python' })).selfcheck.ac_pattern, '(?:AC-|test_ac_)\\d+');
  assert.equal(JSON.parse(configText(template, { ...args, stack: 'go' })).selfcheck.ac_pattern, 'AC-\\d+');
  assert.equal(JSON.parse(configText(template, args)).selfcheck.ac_pattern, 'AC-\\d+');
});

test('every per-stack template passes sh -n, reads and unsets the variables, and is generic', () => {
  const dir = join(repo, 'factory/templates/checks');
  assert.deepEqual(readdirSync(dir).sort(), ['go.sh', 'gradle.sh', 'maven.sh', 'node-affected.sh', 'node.sh', 'python.sh', 'ruby.sh', 'rust.sh']);
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.equal(spawnSync('sh', ['-n', join(dir, f)]).status, 0, f);
    assert.match(text, /^unset FACTORY_CHECK_MODE FACTORY_CHANGED_FILES( FACTORY_BASE FACTORY_HEAD)?$/m, f);
    assert.match(text, /FACTORY_CHANGED_FILES/, f);
    assert.doesNotMatch(text, /smoke|eminzo-ai/i, f);
  }
});

test('init writes the stack ac_pattern only over the generic default', () => {
  const root = sandbox({ 'pyproject.toml': '[tool.pytest.ini_options]\n' });
  init(root);
  assert.equal(JSON.parse(readFileSync(join(root, 'factory/config.json'), 'utf8')).selfcheck.ac_pattern, '(?:AC-|test_ac_)\\d+');
  assert.match(checks(root), /^python -m pytest$/m);
  const custom = sandbox({ 'pyproject.toml': '[tool.pytest.ini_options]\n' });
  writeFileSync(join(custom, 'factory/config.json'), '{"selfcheck":{"ac_pattern":"REQ-\\\\d+"}}');
  init(custom);
  assert.match(readFileSync(join(custom, 'factory/config.json'), 'utf8'), /REQ-/);
  assert.equal(existsSync(join(sandbox({ 'go.mod': 'm' }, { config: false }), 'factory/config.json')), false);
  assert.equal(acPattern('go'), 'AC-\\d+');
  const re = new RegExp(acPattern('python'), 'i');
  assert.ok(re.test('def test_ac_1():') && re.test('"""AC-1 covers"""'));
});

// ---- E2: affected checks for Nx and Turborepo ------------------------------------------------------------

const NX_PNPM = `#!/bin/sh
# The repo's deterministic checks. factory/bin/gate runs the main checkout's copy of
# this file inside a job's worktree; exit 0 means the gate passes.
# Generated by Eminzo from the files found in the repo: review it.
#
# Nx workspace: only the projects a job changed and the projects that depend on them.
# The factory sets FACTORY_BASE (the commit the job's branch left the base at) for the gate, the
# merge, the nudge and the base check, and FACTORY_HEAD (the commit to compare with) for the gate,
# the merge and the base check; without FACTORY_HEAD uncommitted files count too. Without
# FACTORY_BASE (you run this file by hand, or the job fixes the base) every project is checked.
set -e
BASE="\${FACTORY_BASE:-}"
HEAD="\${FACTORY_HEAD:-}"
# Read once, then unset, so a test that starts another factory process does not inherit them.
unset FACTORY_CHECK_MODE FACTORY_CHANGED_FILES FACTORY_BASE FACTORY_HEAD

if [ -z "$BASE" ]; then
  pnpm exec nx run-many -t lint test
elif [ -z "$HEAD" ]; then
  pnpm exec nx affected -t lint test --base="$BASE"
else
  pnpm exec nx affected -t lint test --base="$BASE" --head="$HEAD"
fi
`;

const repoOf = (files, scripts = { lint: 'nx run-many -t lint', test: 'nx run-many -t test' }, read = () => '') => ({ files, packageJson: { scripts }, read });

test('E2: an Nx workspace with pnpm, lint and test gets exactly the affected script', () => {
  assert.equal(checksFor(repoOf(['package.json', 'nx.json', 'pnpm-lock.yaml'])).script, NX_PNPM);
});

test('E2: the exec form follows the package manager', () => {
  const nx = (files) => checksFor(repoOf(['package.json', 'nx.json', ...files])).script;
  assert.match(nx(['yarn.lock']), /^ {2}yarn nx run-many -t lint test$/m);
  assert.match(nx(['package-lock.json']), /^ {2}npx --no-install nx affected -t lint test --base="\$BASE"$/m);
  assert.match(nx([]), /^ {2}npx --no-install nx run-many/m);
  assert.match(nx(['bun.lock']), /^ {2}bun run nx run-many -t lint test$/m);
  assert.doesNotMatch(nx(['bun.lockb']), /bunx/);
});

test('E2: Turborepo v2 reads tasks, v1 reads pipeline, and the filters use the base and the head', () => {
  const turbo = (json, scripts) => checksFor(repoOf(['package.json', 'turbo.json', 'pnpm-lock.yaml'], scripts, (f) => (f === 'turbo.json' ? json : ''))).script;
  const v2 = turbo(JSON.stringify({ tasks: { lint: {}, typecheck: {}, test: {}, build: {} } }), { test: 'turbo test' });
  assert.match(v2, /^# Turborepo workspace: only the packages/m);
  assert.match(v2, /^ {2}pnpm exec turbo run lint typecheck test$/m);
  assert.match(v2, /^ {2}pnpm exec turbo run lint typecheck test --filter="\.\.\.\[\$BASE\]"$/m);
  assert.match(v2, /^ {2}pnpm exec turbo run lint typecheck test --filter="\.\.\.\[\$BASE\.\.\.\$HEAD\]"$/m);
  const v1 = turbo(JSON.stringify({ pipeline: { test: {} } }), { test: 'turbo test' });
  assert.match(v1, /^ {2}pnpm exec turbo run test$/m);
  // turbo.jsonc with comments is not plain JSON: the root package.json scripts decide
  const jsonc = turbo('{ // comment\n "tasks": { "lint": {} } }', { lint: 'turbo lint', test: 'turbo test' });
  assert.match(jsonc, /^ {2}pnpm exec turbo run lint test$/m);
});

test('E2: Nx wins over Turborepo; a missing lint script leaves only test; no test target keeps today\'s script', () => {
  assert.match(checksFor(repoOf(['package.json', 'nx.json', 'turbo.json'])).script, /^# Nx workspace/m);
  assert.match(checksFor(repoOf(['package.json', 'nx.json'], { test: 'nx test' })).script, /^ {2}npx --no-install nx run-many -t test$/m);
  const none = checksFor(repoOf(['package.json', 'turbo.json'], { test: 'jest' }, (f) => (f === 'turbo.json' ? '{"tasks":{"build":{}}}' : '')));
  assert.doesNotMatch(none.script, /FACTORY_BASE/);
  assert.match(none.script, /^npm test$/m);
  assert.doesNotMatch(checksFor(repoOf(['package.json'])).script, /FACTORY_BASE/, 'a plain node repo keeps the node script');
});

test('E2: the generated script runs the tool for each environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-affected-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\necho "pnpm $*" >> "$OUT"\n', { mode: 0o755 });
  const file = join(dir, 'checks.sh');
  writeFileSync(file, NX_PNPM);
  const out = join(dir, 'out');
  const call = (env) => { spawnSync('sh', [file], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, OUT: out, ...env } }); };
  call({});
  call({ FACTORY_BASE: 'aaa' });
  call({ FACTORY_BASE: 'aaa', FACTORY_HEAD: 'bbb' });
  assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), [
    'pnpm exec nx run-many -t lint test',
    'pnpm exec nx affected -t lint test --base=aaa',
    'pnpm exec nx affected -t lint test --base=aaa --head=bbb',
  ]);
});

test('E2: prepareCommand follows the lockfile', () => {
  const p = (...files) => prepareCommand(['package.json', ...files]);
  assert.equal(p('bun.lock'), 'bun install --frozen-lockfile');
  assert.equal(p('bun.lockb'), 'bun install --frozen-lockfile');
  assert.equal(p('pnpm-lock.yaml'), 'pnpm install --frozen-lockfile --prefer-offline');
  assert.equal(p('yarn.lock', '.yarnrc.yml'), 'yarn install --immutable');
  assert.equal(p('yarn.lock'), 'yarn install --frozen-lockfile --prefer-offline');
  assert.equal(p('package-lock.json'), 'npm ci --prefer-offline --no-audit --no-fund');
  assert.equal(p('npm-shrinkwrap.json'), 'npm ci --prefer-offline --no-audit --no-fund');
  assert.equal(p(), 'npm install --no-audit --no-fund');
  assert.equal(prepareCommand(['go.mod']), null);
  assert.equal(prepareCommand([]), null);
});

test('E2: init checks prints a suggestion for an Nx repo and leaves checks.sh byte-identical', () => {
  const pkg = JSON.stringify({ scripts: { lint: 'nx run-many -t lint', test: 'nx run-many -t test' } });
  const root = sandbox({ 'package.json': pkg, 'nx.json': '{}', 'pnpm-lock.yaml': '' });
  const old = '#!/bin/sh\npnpm run lint\npnpm test\n';
  writeFileSync(join(root, 'factory/checks.sh'), old);
  const res = spawnSync(join(repo, 'factory/bin/init'), ['checks'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(checks(root), old);
  assert.match(res.stdout, /^factory\/checks\.sh already exists; left untouched$/m);
  assert.match(res.stdout, /^suggestion: this is an Nx workspace and factory\/checks\.sh checks every project on every job\./m);
  assert.ok(res.stdout.includes(NX_PNPM), 'the proposed script is printed');
  assert.match(res.stdout, /^base check prepare: pnpm install --frozen-lockfile --prefer-offline \(from pnpm-lock\.yaml; set checks\.prepare in factory\/config\.json to change it\)$/m);
});

test('E2: init checks is silent when checks.sh names FACTORY_BASE or the repo is no monorepo, and writes a missing one', () => {
  const pkg = JSON.stringify({ scripts: { lint: 'x', test: 'x' } });
  const nx = sandbox({ 'package.json': pkg, 'nx.json': '{}', 'pnpm-lock.yaml': '' });
  writeFileSync(join(nx, 'factory/checks.sh'), '#!/bin/sh\n# uses FACTORY_BASE\nexit 0\n');
  const run = (root) => spawnSync(join(repo, 'factory/bin/init'), ['checks'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root } });
  assert.doesNotMatch(run(nx).stdout, /suggestion:/);
  const plain = sandbox({ 'package.json': pkg, 'package-lock.json': '' });
  writeFileSync(join(plain, 'factory/checks.sh'), '#!/bin/sh\nexit 0\n');
  assert.doesNotMatch(run(plain).stdout, /suggestion:/);
  const fresh = sandbox({ 'package.json': pkg, 'nx.json': '{}', 'pnpm-lock.yaml': '' });
  const res = run(fresh);
  assert.match(res.stdout, /wrote .*checks\.sh for the node stack; review it/);
  assert.match(checks(fresh), /FACTORY_BASE/);
  assert.doesNotMatch(res.stdout, /suggestion:/);
});

// The guard-tests hook refuses the commands in checks.suite_commands, so setup writes the list next to the checks.sh it generates.
const suite = (root) => JSON.parse(readFileSync(join(root, 'factory/config.json'), 'utf8')).checks?.suite_commands;
const STACK_SUITES = [
  ['node npm', { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }, ['npm test']],
  ['node pnpm', { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'pnpm-lock.yaml': '' }, ['pnpm test']],
  ['node yarn', { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'yarn.lock': '' }, ['yarn test']],
  ['node bun', { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'bun.lock': '' }, ['bun run test']],
  ['go', { 'go.mod': 'module x\n' }, ['go test ./...']],
  ['python', { 'pyproject.toml': '[tool.pytest]\n', 'pytest.ini': '' }, ['python -m pytest']],
  ['rust', { 'Cargo.toml': '[package]\n' }, ['cargo test']],
  ['maven', { 'pom.xml': '<project/>' }, ['mvn -B -q test']],
  ['gradle wrapper', { 'build.gradle': '', gradlew: '' }, ['./gradlew test']],
  ['gradle', { 'build.gradle': '' }, ['gradle test']],
  ['ruby', { Gemfile: '', 'spec/': '' }, ['bundle exec rspec', 'bundle exec rake test']],
  ['nx', { 'package.json': JSON.stringify({ scripts: { test: 'nx test' } }), 'nx.json': '{}', 'pnpm-lock.yaml': '' }, ['pnpm exec nx run-many -t test']],
  ['turbo', { 'package.json': JSON.stringify({ scripts: { test: 'turbo run test' } }), 'turbo.json': '{"tasks":{"test":{}}}' }, ['npx --no-install turbo run test']],
];
for (const [name, files, expected] of STACK_SUITES) {
  test(`suite_commands: ${name}: init writes ${JSON.stringify(expected)} with the checks.sh it generates`, () => {
    const root = sandbox(files);
    assert.equal(init(root).status, 0);
    assert.deepEqual(suite(root), expected);
    assert.deepEqual(checksFor({ files: Object.keys(files).map((f) => f.replace(/\/$/, '')), packageJson: files['package.json'] ? JSON.parse(files['package.json']) : null, read: (f) => files[f] ?? '' }).suite, expected);
  });
}

test('suite_commands: an existing value is never overwritten, a hand-written checks.sh gets none, a second init changes nothing', () => {
  const mine = sandbox({ 'go.mod': 'module x\n' });
  writeFileSync(join(mine, 'factory/config.json'), '{\n  "checks": { "suite_commands": ["make test"] },\n  "selfcheck": { "ac_pattern": "AC-\\\\d+" }\n}\n');
  init(mine);
  assert.deepEqual(suite(mine), ['make test']);

  const hand = sandbox({ 'go.mod': 'module x\n' });
  writeFileSync(join(hand, 'factory/checks.sh'), '#!/bin/sh\nexit 0\n');
  init(hand);
  assert.equal(suite(hand), undefined);

  const twice = sandbox({ 'go.mod': 'module x\n' });
  init(twice);
  const before = readFileSync(join(twice, 'factory/config.json'), 'utf8');
  init(twice);
  assert.equal(readFileSync(join(twice, 'factory/config.json'), 'utf8'), before);

  const none = sandbox({ 'README.md': 'x' });
  init(none);
  assert.equal(suite(none), undefined, 'no stack, no list');
});

test('suite_commands: init keeps the layout of a config that has a checks object', () => {
  const root = sandbox({ 'go.mod': 'module x\n' });
  writeFileSync(join(root, 'factory/config.json'), '{\n  "checks": { "max_runs_per_round": 6 },\n  "selfcheck": { "ac_pattern": "AC-\\\\d+" }\n}\n');
  init(root);
  const text = readFileSync(join(root, 'factory/config.json'), 'utf8');
  assert.match(text, /"checks": \{ "suite_commands": \["go test \.\/\.\.\."\], "max_runs_per_round": 6 \}/);
  assert.deepEqual(suite(root), ['go test ./...']);
});

test('suite_commands: eminzo enable writes it into the new config.json only when it generates checks.sh', () => {
  const template = readFileSync(join(repo, 'factory/templates/config.json'), 'utf8');
  const fill = { repoUrl: 'https://github.com/a/b', defaultBranch: 'main', version: '1.2.3' };
  const checks = detectChecks({ files: ['go.mod'], packageJson: null, read: () => '' });
  assert.deepEqual(JSON.parse(configText(template, { ...fill, stack: checks.stack, suite: checks.suite })).checks.suite_commands, ['go test ./...']);
  assert.deepEqual(JSON.parse(configText(template, { ...fill, stack: checks.stack, suite: [] })).checks.suite_commands, []);
  assert.deepEqual(JSON.parse(configText(template, { ...fill })).checks.suite_commands, []);
});

// An existing checks.sh is never rewritten, so setup suggests the checks.suite_commands line instead of writing it.
const initChecksCmd = (root) => spawnSync(join(repo, 'factory/bin/init'), ['checks'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root } });
const SUGGEST = /^suggestion: add "suite_commands": (\[.*\]) to "checks" in factory\/config\.json so the builder cannot run the full suite \(the gate runs it\)$/m;

test('suggestion: an existing checks.sh with a known full-run command gets a suggestion for config.json, and nothing is written', () => {
  for (const [lines, expected] of [
    ['npm run lint\nnpm test\n', ['npm test']],
    ['set -e\ngo vet ./...\ngo test ./...\n', ['go test ./...']],
    ['CI=1 pnpm test > out.log 2>&1\n', ['pnpm test']],
    ['bundle exec rspec\nbundle exec rake test\n', ['bundle exec rspec', 'bundle exec rake test']],
    ['mvn -B -q test\n', ['mvn -B -q test']],
  ]) {
    const root = sandbox({ 'go.mod': 'module x\n' });
    const script = `#!/bin/sh\n${lines}`;
    writeFileSync(join(root, 'factory/checks.sh'), script);
    const configBefore = readFileSync(join(root, 'factory/config.json'), 'utf8');
    const res = initChecksCmd(root);
    assert.equal(res.status, 0, res.stderr);
    const m = SUGGEST.exec(res.stdout);
    assert.ok(m, `suggestion for ${JSON.stringify(lines)}: ${res.stdout}`);
    assert.deepEqual(JSON.parse(m[1]), expected);
    assert.equal(readFileSync(join(root, 'factory/checks.sh'), 'utf8'), script);
    assert.equal(readFileSync(join(root, 'factory/config.json'), 'utf8'), configBefore);
  }
});

test('suggestion: nothing when the key exists (even an empty list), when no known command is in checks.sh, or when checks.sh is generated', () => {
  const has = sandbox({ 'go.mod': 'module x\n' });
  writeFileSync(join(has, 'factory/checks.sh'), '#!/bin/sh\nnpm test\n');
  writeFileSync(join(has, 'factory/config.json'), '{ "checks": { "suite_commands": [] } }\n');
  assert.doesNotMatch(initChecksCmd(has).stdout, /suggestion:/);

  const unknown = sandbox({ 'go.mod': 'module x\n' });
  writeFileSync(join(unknown, 'factory/checks.sh'), '#!/bin/sh\nmake check\nnpm run lint\necho "npm test"\n');
  assert.doesNotMatch(initChecksCmd(unknown).stdout, /suggestion:/);

  const fresh = sandbox({ 'go.mod': 'module x\n' });
  const res = initChecksCmd(fresh);
  assert.match(res.stdout, /^wrote /m);
  assert.doesNotMatch(res.stdout, /suggestion:/);
});

test('suggestion: both skills tell the orchestrator to show it, like the Nx one, and never write it', () => {
  for (const f of ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md']) {
    const text = readFileSync(join(repo, f), 'utf8');
    const rule = text.slice(text.indexOf('<!-- rule: base-check -->')).slice(0, 2200);
    assert.match(rule, /suite_commands/, f);
    assert.match(rule, /Never write/i, f);
  }
});
