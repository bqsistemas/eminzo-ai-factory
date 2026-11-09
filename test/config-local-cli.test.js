// Job 125: factory/config.local.json, a per-developer override of a closed set of keys.
// Unit tests on util.js/check-stamp.js, then the CLI on a temp root with a local bare
// origin and a fake gh (setup in test/helpers/config-local-harness.js). No network.
// Part of the config-local scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Refused, effectiveConfig, validateLocal } from '../factory/lib/util.js';
import { teamConfig, plainRoot, writeLocal, untracked, quiet, setup, ok, gateFailedJob } from './helpers/config-local-harness.js';

describe('config.local.json', { concurrency: true }, () => {
  test('AC-3: job summary and job <id> to <stage> exit 1 with refused: config.local.json:, writing neither board.json nor job.json', async () => {
    const t = setup();
    const id = gateFailedJob(t);
    const before = t.raw(id);
    t.local({ concurrency: 1, routing: {} });
    for (const args of [['summary'], [id, 'to', 'build'], [id, 'prompt'], ['config']]) {
      const res = await t.job(...args);
      assert.equal(res.status, 1, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
      assert.ok(res.stderr.startsWith('refused: config.local.json: routing: '), res.stderr);
      assert.match(res.stderr, /routing: \S+/);
    }
    t.local('{ not json');
    const broken = await t.job('summary');
    assert.equal(broken.status, 1);
    assert.ok(broken.stderr.startsWith('refused: config.local.json: '), broken.stderr);
    assert.equal(t.raw(id), before, 'job.json untouched');
    assert.equal(existsSync(t.boardPath), false, 'board.json never written');
  });

  test('AC-3: validateLocal never returns a partial config', () => {
    const team = teamConfig();
    const local = { concurrency: 1, routing: {} };
    assert.throws(() => validateLocal(team, local), Refused);
    assert.equal(validateLocal(team, { concurrency: 1 }), undefined);
    assert.equal(team.concurrency, 3, 'the team config is not mutated');
  });

  for (const [key, value] of [
    ['max_rounds', 4], ['max_rounds', 2.5], ['max_rounds', 0], ['max_rounds', '2'],
    ['auto_merge', true], ['auto_merge', 'false'], ['auto_merge', 0],
    ['concurrency', 0], ['concurrency', 1.5], ['concurrency', '2'],
    ['language', 'fr'], ['language', 1],
    ['default_provider', 'nope'], ['default_provider', '__proto__'], ['default_provider', 'toString'], ['default_provider', 1],
  ]) {
    test(`AC-4: ${key}: ${JSON.stringify(value)} is refused with config.local.json: ${key}: <reason>`, () => {
      const root = plainRoot();
      writeLocal(root, { [key]: value });
      assert.throws(() => effectiveConfig(root, { tracked: untracked, warn: quiet }), (err) => {
        assert.ok(err instanceof Refused);
        assert.ok(err.message.startsWith(`config.local.json: ${key}: `), err.message);
        assert.ok(err.message.length > `config.local.json: ${key}: `.length, 'has a reason');
        return true;
      });
    });
  }

  test('AC-4: max_rounds may not exceed 3 when the team does not declare it', () => {
    const team = teamConfig();
    delete team.max_rounds;
    assert.throws(() => validateLocal(team, { max_rounds: 4 }), Refused);
    assert.equal(validateLocal(team, { max_rounds: 3 }), undefined);
  });

  test('AC-4: the CLI refuses auto_merge: true with refused: config.local.json: auto_merge:', async () => {
    const t = setup();
    t.local({ auto_merge: true });
    const res = await t.job('summary');
    assert.equal(res.status, 1);
    assert.ok(res.stderr.startsWith('refused: config.local.json: auto_merge: '), res.stderr);
  });

  test('AC-4: max_rounds: 2 and auto_merge: false are accepted, and a later job new stores max_rounds: 2', async () => {
    const t = setup();
    t.local({ max_rounds: 2, auto_merge: false });
    t.issue(9);
    const id = ok(await t.job('new', '9'));
    assert.equal(t.json(id).max_rounds, 2);
    assert.deepEqual(t.board().config_overrides, ['auto_merge', 'max_rounds']);
  });

  test('AC-5: job config prints every top-level key with its origin and effective value', async () => {
    const t = setup();
    t.local({ concurrency: 1 });
    const out = ok(await t.job('config'));
    const lines = out.split('\n');
    const team = teamConfig();
    assert.deepEqual(lines.map((l) => l.split(' ')[0]), Object.keys(team).sort());
    for (const line of lines) {
      const [key, origin, ...rest] = line.split(' ');
      assert.equal(origin, key === 'concurrency' ? 'local' : 'team', line);
      assert.deepEqual(JSON.parse(rest.join(' ')), key === 'concurrency' ? 1 : team[key], line);
    }
    assert.ok(lines.includes('concurrency local 1'));
    assert.ok(lines.includes('language team "es"'));
  });

  test('AC-5: job config <key> prints only that line; an unknown key exits 1', async () => {
    const t = setup();
    t.local({ concurrency: 1 });
    const one = await t.job('config', 'concurrency');
    assert.equal(one.status, 0, one.stderr);
    assert.equal(one.stdout, 'concurrency local 1\n');
    const teamKey = await t.job('config', 'max_rounds');
    assert.equal(teamKey.stdout, 'max_rounds team 3\n');
    const missing = await t.job('config', 'no_such_key');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^refused: /);
    const usage = await t.job('config', 'a', 'b');
    assert.equal(usage.status, 2);
    assert.equal(existsSync(t.boardPath), false, 'job config writes nothing');
  });
});
