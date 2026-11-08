// Issue 159: the approver-llm model is chosen by risk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stageModels } from '../factory/lib/route.js';

const config = JSON.parse(readFileSync(new URL('../factory/config.json', import.meta.url), 'utf8'));
const cfg = (extra) => ({ providers: { claude: { models: { intake: 'a', 'spec-writer': 'b', approver: { low: 'script', medium: 'script', high: 'opus' }, ...extra }, routing: { builder: {}, reviewers: {} } } } });

test('AC-1: the repo config picks sonnet / luna on low and medium, nothing on high', () => {
  for (const r of ['low', 'medium']) {
    assert.equal(stageModels(config, 'claude', r)['approver-llm'], 'sonnet');
    assert.equal(stageModels(config, 'codex', r)['approver-llm'], 'gpt-6-luna');
  }
  assert.equal(stageModels(config, 'claude', 'high')['approver-llm'], undefined);
  assert.equal(stageModels(config, 'codex', 'high')['approver-llm'], undefined);
});

test('AC-2: without the entry approver-llm is approver.high; a string applies to every risk', () => {
  for (const p of ['claude', 'codex']) {
    const legacy = structuredClone(config);
    delete legacy.models['approver-llm'];
    delete legacy.providers[p].models['approver-llm'];
    for (const r of ['low', 'medium']) assert.equal(stageModels(legacy, p, r)['approver-llm'], legacy.providers[p].models.approver.high);
  }
  for (const r of ['low', 'medium']) assert.equal(stageModels(cfg({ 'approver-llm': 'x' }), 'claude', r)['approver-llm'], 'x');
});

test('AC-3: an invalid entry throws only when the approver is the script', () => {
  for (const bad of [{ high: 'opus' }, { low: '', medium: 'x' }, { low: 'script' }, 'script', '']) {
    assert.throws(() => stageModels(cfg({ 'approver-llm': bad }), 'claude', 'low'), /no model for approver-llm/);
    const out = stageModels(cfg({ 'approver-llm': bad }), 'claude', 'high');
    assert.equal(out['approver-llm'], undefined);
  }
});

test('AC-7: the template mirrors the config approver-llm entries', () => {
  const tpl = JSON.parse(readFileSync(new URL('../factory/templates/config.json', import.meta.url), 'utf8'));
  assert.deepEqual(tpl.models, config.models);
  assert.deepEqual(tpl.providers, config.providers);
  assert.ok(config.models['approver-llm'] && config.providers.claude.models['approver-llm'] && config.providers.codex.models['approver-llm']);
});

test('AC-8: both skills describe approver-llm by risk and approval_inconclusive', () => {
  for (const f of ['../.claude/skills/eminzo-factory/SKILL.md', '../.agents/skills/eminzo-factory/SKILL.md']) {
    const t = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(t, /approver-llm/);
    assert.match(t, /by risk/);
    assert.match(t, /approval_inconclusive/);
  }
  assert.doesNotMatch(readFileSync(new URL('../.claude/skills/eminzo-factory/SKILL.md', import.meta.url), 'utf8'), /opus \(`approver-llm`\)/);
});
