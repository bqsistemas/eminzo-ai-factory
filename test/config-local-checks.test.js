// Job 125: factory/config.local.json, a per-developer override of a closed set of keys.
// Unit tests on util.js/check-stamp.js, then the CLI on a temp root with a local bare
// origin and a fake gh (setup in test/helpers/config-local-harness.js). No network.
// Part of the config-local scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checksInputs } from '../factory/lib/check-stamp.js';
import { LOCAL_CONFIG, effectiveConfig } from '../factory/lib/util.js';
import { repo, git, teamConfig, plainRoot, writeLocal, quiet, setup, ok, gateFailedJob, approvedWithRealGate } from './helpers/config-local-harness.js';

describe('config.local.json', { concurrency: true }, () => {
  test('AC-6: job <id> prompt prints Language: right after Base branch:, local first, team otherwise', async () => {
    const t = setup();
    const id = gateFailedJob(t);
    const team = ok(await t.job(id, 'prompt')).split('\n');
    assert.equal(team[team.findIndex((l) => l.startsWith('Base branch: ')) + 1], 'Language: es');
    t.local({ language: 'pt' });
    const local = ok(await t.job(id, 'prompt')).split('\n');
    assert.equal(local[local.findIndex((l) => l.startsWith('Base branch: ')) + 1], 'Language: pt');
  });

  test('AC-6: the 8 roles read the language from the prompt Language: line, not from factory/config.json', () => {
    const sentence = 'Write prose in the configured language; keep technical terms and protocol tokens in English.';
    const dir = join(repo, 'factory/roles');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 8);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      assert.ok(text.includes(sentence), `${f} keeps the sentence`);
      assert.match(text, /`Language:` line of your prompt/, `${f} names the prompt line`);
      assert.doesNotMatch(text, /Read `language` from `factory\/config\.json`/, `${f} no longer reads config.json for it`);
    }
  });

  test('AC-7: creating, changing or deleting config.local.json changes the checks inputs', () => {
    const root = plainRoot();
    const none = checksInputs(root);
    writeLocal(root, { concurrency: 1 });
    const one = checksInputs(root);
    assert.notEqual(one, none);
    writeLocal(root, { concurrency: 2 });
    const two = checksInputs(root);
    assert.notEqual(two, one);
    rmSync(join(root, LOCAL_CONFIG));
    assert.equal(checksInputs(root), none, 'back to the hash without the file');
  });

  test('AC-7: a local file written after the round gate makes the merge run the gate again', async () => {
    const t = setup();
    const id = await approvedWithRealGate(t);
    assert.ok(t.json(id).gated?.inputs, 'the round gate recorded its inputs');
    t.local({ concurrency: 1 });
    const before = t.runs();
    assert.equal(ok(await t.job(id, 'to', 'merging')), `${id} merged`);
    assert.equal(t.runs(), before + 1, 'the checks ran again');
    assert.doesNotMatch(t.read(id, 'merge-checks.md'), /Reused/);
  });

  test('AC-8: a tracked config.local.json is ignored with a warning, even when it is invalid', async () => {
    const t = setup();
    const id = gateFailedJob(t);
    t.local({ routing: {}, auto_merge: true });
    git(t.root, 'add', '-f', LOCAL_CONFIG);
    const res = await t.job(id, 'to', 'build');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /factory\/config\.local\.json/);
    assert.deepEqual(t.board().config_overrides, []);
    const cfg = ok(await t.job('config', 'auto_merge'));
    assert.equal(cfg, 'auto_merge team true');
    const eff = effectiveConfig(t.root, { warn: quiet });
    assert.deepEqual(eff.config, teamConfig());
    assert.deepEqual(eff.overrides, []);
  });

  test('AC-8: the warning goes through warn and names the file; git failing counts as untracked', () => {
    const root = plainRoot();
    writeLocal(root, { concurrency: 1 });
    const warnings = [];
    const eff = effectiveConfig(root, { tracked: () => true, warn: (text) => warnings.push(text) });
    assert.deepEqual(eff.overrides, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /factory\/config\.local\.json/);
    // A root outside git: the default tracked check fails and the file is validated as usual.
    assert.deepEqual(effectiveConfig(root, { warn: quiet }).overrides, ['concurrency']);
  });

  test('AC-9: this repo ignores factory/config.local.json', () => {
    const lines = readFileSync(join(repo, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.equal(lines.filter((l) => l.trim().replace(/^\//, '') === 'factory/config.local.json').length, 1);
  });

  test('AC-10: both orchestrator skills read concurrency with job config and show Language: in the prompt block', () => {
    for (const rel of ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md']) {
      const text = readFileSync(join(repo, rel), 'utf8');
      assert.match(text, /`factory\/bin\/job config concurrency`/, `${rel} concurrency`);
      assert.match(text, /^\s*Base branch: <branch of config\.base>\n\s*Language: <effective language>$/m, `${rel} Language: line`);
      assert.match(text, /factory\/config\.local\.json/, `${rel} names the local file`);
    }
  });
});
