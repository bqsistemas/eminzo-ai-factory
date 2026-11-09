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
import { acPattern } from '../factory/lib/stacks.js';
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
  assert.deepEqual(readdirSync(dir).sort(), ['go.sh', 'gradle.sh', 'maven.sh', 'node.sh', 'python.sh', 'ruby.sh', 'rust.sh']);
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.equal(spawnSync('sh', ['-n', join(dir, f)]).status, 0, f);
    assert.match(text, /^unset FACTORY_CHECK_MODE FACTORY_CHANGED_FILES$/m, f);
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
