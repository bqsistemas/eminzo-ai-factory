import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChecks } from '../cli/src/installer/checks.js';

const det = (files, packageJson = null, text = {}) => detectChecks({ files, packageJson, read: (f) => text[f] ?? '' });

test('a package.json test script runs through the lockfile package manager', () => {
  const pkg = { scripts: { test: 'vitest run' } };
  assert.equal(det(['package.json'], pkg).stack, 'node');
  assert.match(det(['package.json'], pkg).script, /^npm test$/m);
  assert.match(det(['package.json', 'pnpm-lock.yaml'], pkg).script, /^pnpm test$/m);
  assert.match(det(['package.json', 'yarn.lock'], pkg).script, /^yarn test$/m);
});

test('the npm "no test specified" placeholder is not a test script', () => {
  const pkg = { scripts: { test: 'echo "Error: no test specified" && exit 1' } };
  assert.equal(det(['package.json'], pkg).stack, 'none');
  assert.equal(det(['package.json'], {}).stack, 'none');
});

test('go, rust, python and jvm stacks', () => {
  assert.match(det(['go.mod']).script, /^go test \.\/\.\.\.$/m);
  assert.match(det(['Cargo.toml']).script, /^cargo test$/m);
  assert.match(det(['pyproject.toml'], null, { 'pyproject.toml': '[tool.pytest.ini_options]\n' }).script, /^python -m pytest$/m);
  assert.match(det(['pytest.ini']).script, /^python -m pytest$/m);
  assert.match(det(['requirements.txt'], null, { 'requirements.txt': 'pytest==8\n' }).script, /^python -m pytest$/m);
  assert.match(det(['pom.xml']).script, /^mvn -B -q test$/m);
  assert.match(det(['gradlew', 'build.gradle']).script, /^\.\/gradlew test$/m);
});

test('a pyproject without pytest does not pretend to have tests', () => {
  assert.equal(det(['pyproject.toml'], null, { 'pyproject.toml': '[project]\nname = "x"\n' }).stack, 'none');
});

test('every script is a strict POSIX sh script with a header comment', () => {
  for (const r of [det(['go.mod']), det(['Cargo.toml']), det([])]) {
    assert.ok(r.script.startsWith('#!/bin/sh\n'));
    assert.match(r.script, /^set -e$/m);
    assert.ok(r.script.endsWith('\n'));
  }
});

test('unknown stacks fall back to a script that says what to do and exits 0', () => {
  const r = det(['README.md']);
  assert.equal(r.stack, 'none');
  assert.match(r.script, /TODO/);
  assert.match(r.script, /^#.*no test command was detected/im);
  assert.match(r.script, /^echo .*TODO/m);
  assert.match(r.script, /^exit 0$/m);
});

test('the first matching stack wins, node before the others', () => {
  const r = det(['package.json', 'go.mod'], { scripts: { test: 'jest' } });
  assert.equal(r.stack, 'node');
});
