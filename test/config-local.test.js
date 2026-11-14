// Job 125: factory/config.local.json, a per-developer override of a closed set of keys.
// Unit tests on util.js/check-stamp.js, then the CLI on a temp root with a local bare
// origin and a fake gh (setup in test/helpers/config-local-harness.js). No network.
// Part of the config-local scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checksInputs } from '../factory/lib/check-stamp.js';
import { OVERRIDABLE, Refused, effectiveConfig, loadConfig, validateLocal } from '../factory/lib/util.js';
import { teamConfig, plainRoot, writeLocal, never, untracked, quiet, setup, ok, gateFailedJob, legacyChecksInputs, VALID_ALL } from './helpers/config-local-harness.js';

describe('config.local.json', { concurrency: true }, () => {
  test('AC-1: without a local file the config is the team one, the checks hash is unchanged and git is never asked', () => {
    const team = teamConfig();
    const root = plainRoot(team);
    assert.deepEqual(loadConfig(root, { tracked: never }), team);
    const eff = effectiveConfig(root, { tracked: never });
    assert.deepEqual(eff.config, team);
    assert.deepEqual(eff.overrides, []);
    assert.equal(checksInputs(root), legacyChecksInputs(root));
  });

  test('AC-1: job <id> to <stage> without a local file writes config_overrides: [] to the board', async () => {
    const t = setup();
    const id = gateFailedJob(t);
    assert.equal(ok(await t.job(id, 'to', 'build')), `${id} build`);
    const board = t.board();
    assert.deepEqual(board.config_overrides, []);
    assert.equal(board.language, 'es');
  });

  test('AC-2: every allowed key takes its local value, the rest stays the team value', () => {
    const team = teamConfig();
    const root = plainRoot(team);
    writeLocal(root, VALID_ALL);
    const { config, overrides } = effectiveConfig(root, { tracked: untracked, warn: quiet });
    for (const [key, value] of Object.entries(VALID_ALL)) assert.deepEqual(config[key], value, key);
    for (const key of Object.keys(team).filter((k) => !OVERRIDABLE.includes(k))) assert.deepEqual(config[key], team[key], key);
    assert.deepEqual(overrides, [...Object.keys(VALID_ALL)].sort());
    assert.deepEqual(OVERRIDABLE, ['concurrency', 'default_provider', 'language', 'max_rounds', 'auto_merge', 'spec_review', 'discovery']);
    assert.ok(Object.isFrozen(OVERRIDABLE));
  });

  test('AC-2: the board lists the overridden keys, sorted, and uses the local language', async () => {
    const t = setup();
    const id = gateFailedJob(t);
    t.local(VALID_ALL);
    assert.equal(ok(await t.job(id, 'to', 'build')), `${id} build`);
    const board = t.board();
    assert.deepEqual(board.config_overrides, ['auto_merge', 'concurrency', 'default_provider', 'language', 'max_rounds']);
    assert.equal(board.language, 'pt');
  });

  test('AC-2: a local value equal to the team value still counts as local; an empty object overrides nothing', () => {
    const root = plainRoot();
    writeLocal(root, { concurrency: 3 });
    assert.deepEqual(effectiveConfig(root, { tracked: untracked, warn: quiet }).overrides, ['concurrency']);
    writeLocal(root, {});
    assert.deepEqual(effectiveConfig(root, { tracked: untracked, warn: quiet }).overrides, []);
  });

  for (const [name, local, key] of [
    ['routing', { concurrency: 1, routing: {} }, 'routing'],
    ['protected_tests', { language: 'en', protected_tests: [] }, 'protected_tests'],
    ['__proto__', '{"concurrency":1,"__proto__":{"auto_merge":true}}', '__proto__'],
    ['constructor', { constructor: 1 }, 'constructor'],
    ['toString', { toString: 'x' }, 'toString'],
  ]) {
    test(`AC-3: a key outside the allowlist (${name}) is refused and nothing is applied`, () => {
      const root = plainRoot();
      writeLocal(root, local);
      assert.throws(() => effectiveConfig(root, { tracked: untracked, warn: quiet }), (err) => {
        assert.ok(err instanceof Refused, 'a Refused');
        assert.ok(err.message.startsWith(`config.local.json: ${key}: `), err.message);
        return true;
      });
      const parsed = typeof local === 'string' ? JSON.parse(local) : local;
      assert.throws(() => validateLocal(teamConfig(), parsed), Refused);
    });
  }

  for (const [name, text] of [['invalid JSON', '{ concurrency: 1'], ['an array', '[1]'], ['null', 'null'], ['a string', '"x"']]) {
    test(`AC-3: a local file that is ${name} is refused with a config.local.json: reason`, () => {
      const root = plainRoot();
      writeLocal(root, text);
      assert.throws(() => effectiveConfig(root, { tracked: untracked, warn: quiet }), (err) => {
        assert.ok(err instanceof Refused);
        assert.match(err.message, /^config\.local\.json: \S/);
        return true;
      });
    });
  }
});
