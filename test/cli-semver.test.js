// The eminzo CLI checks the running engine version against the `engine` range a repository pins
// in factory/config.json. Zero dependencies: a small parser for the range forms the CLI accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRange, parseVersion, satisfies } from '../cli/src/semver.js';

test('parseVersion reads x.y.z and refuses anything else', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('0.10.0'), [0, 10, 0]);
  for (const bad of ['1.2', 'v1.2.3', '1.2.3-beta.1', '', null, '01.2.3x']) assert.equal(parseVersion(bad), null, String(bad));
});

test('an exact version matches only itself', () => {
  assert.equal(satisfies('0.4.1', '0.4.1'), true);
  assert.equal(satisfies('0.4.2', '0.4.1'), false);
});

test('x.y.x and x.y.* match any patch of that minor; x.x matches any minor of that major', () => {
  assert.equal(satisfies('0.4.0', '0.4.x'), true);
  assert.equal(satisfies('0.4.9', '0.4.*'), true);
  assert.equal(satisfies('0.5.0', '0.4.x'), false);
  assert.equal(satisfies('1.7.2', '1.x'), true);
  assert.equal(satisfies('1.7.2', '1.x.x'), true);
  assert.equal(satisfies('2.0.0', '1.x'), false);
});

test('^ follows npm: same major from 1.0.0, same minor below it', () => {
  assert.equal(satisfies('1.9.0', '^1.2.3'), true);
  assert.equal(satisfies('1.2.2', '^1.2.3'), false);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('0.4.7', '^0.4.1'), true);
  assert.equal(satisfies('0.5.0', '^0.4.1'), false);
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false, 'npm: ^0.0.z is exactly 0.0.z');
});

test('~ allows patch updates only', () => {
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
});

test('>= with an optional < upper bound', () => {
  assert.equal(satisfies('0.4.0', '>=0.4.0 <0.6.0'), true);
  assert.equal(satisfies('0.5.9', '>=0.4.0 <0.6.0'), true);
  assert.equal(satisfies('0.6.0', '>=0.4.0 <0.6.0'), false);
  assert.equal(satisfies('0.3.9', '>=0.4.0'), false);
  assert.equal(satisfies('9.0.0', '>=0.4.0'), true);
});

test('an unknown range form is refused, not treated as a match', () => {
  for (const bad of ['latest', '0.4', '>0.4.0', '0.4.x || 0.5.x', '', 42, null]) {
    assert.equal(parseRange(bad), null, String(bad));
    assert.throws(() => satisfies('0.4.0', bad), /range/);
  }
});
