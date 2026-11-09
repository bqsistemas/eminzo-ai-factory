// P13: init writes factory/checks.sh, the project.md commands and selfcheck.ac_pattern per stack,
// from the same module (factory/lib/stacks.js) that `eminzo enable` uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sectionText } from '../factory/lib/project-map.js';
import { acPattern } from '../factory/lib/stacks.js';
import { detectChecks } from '../cli/src/installer/checks.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = '{\n  "selfcheck": { "ac_pattern": "AC-\\\\d+" }\n}\n';
function sandbox(files, { config = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-stacks-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  spawnSync('mkdir', ['-p', join(root, 'factory')]);
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

const MANIFESTS = { 'package.json': '{"scripts":{}}', 'go.mod': 'module x\n', 'pyproject.toml': '[project]\n', 'Cargo.toml': '[package]\n', Gemfile: '', 'pom.xml': '<project/>', 'build.gradle': '' };
test('AC-4: project.md has no TODO in Commands for any of the seven manifests; the script passes sh -n', () => {
  for (const [name, text] of Object.entries(MANIFESTS)) {
    const root = sandbox({ [name]: text });
    assert.equal(init(root).status, 0, name);
    const commands = sectionText(readFileSync(join(root, 'factory/project.md'), 'utf8'), 'Commands');
    assert.doesNotMatch(commands, /TODO/, name);
    assert.match(commands, /^- Test: .+/m, name);
    assert.equal(spawnSync('sh', ['-n', join(root, 'factory/checks.sh')]).status, 0, name);
  }
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
