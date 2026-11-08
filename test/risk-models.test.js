// Plan P1-1: spec-writer and approver models per risk, in both providers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { route, stageModels } from '../factory/lib/route.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(readFileSync(join(repo, 'factory/config.json'), 'utf8'));

test('Claude: spec-writer sonnet on low, opus on medium and high; approver script on low and medium, opus on high', () => {
  const pick = (risk) => stageModels(config, 'claude', risk);
  assert.equal(pick('low')['spec-writer'], 'sonnet');
  assert.equal(pick('medium')['spec-writer'], 'opus');
  assert.equal(pick('high')['spec-writer'], 'opus');
  assert.equal(pick('low').approver, 'script');
  assert.equal(pick('medium').approver, 'script');
  assert.equal(pick('high').approver, 'opus');
});

test('Codex: spec-writer luna on low and medium, sol on high; approver script on low and medium, sol on high', () => {
  const pick = (risk) => stageModels(config, 'codex', risk);
  assert.equal(pick('low')['spec-writer'], 'gpt-6-luna');
  assert.equal(pick('medium')['spec-writer'], 'gpt-6-luna');
  assert.equal(pick('high')['spec-writer'], 'gpt-6.1-sol');
  assert.equal(pick('low').approver, 'script');
  assert.equal(pick('medium').approver, 'script');
  assert.equal(pick('high').approver, 'gpt-6.1-sol');
});

test('a script approver also reports the LLM approver to use when the script is inconclusive', () => {
  assert.equal(stageModels(config, 'claude', 'low')['approver-llm'], 'sonnet');
  assert.equal(stageModels(config, 'codex', 'medium')['approver-llm'], 'gpt-6-luna');
  assert.equal(stageModels(config, 'claude', 'high')['approver-llm'], undefined, 'the approver is already the LLM on high');
});

test('plain strings keep working and the default risk is medium', () => {
  const plain = { providers: { claude: { models: { intake: 'a', 'spec-writer': 'b', approver: 'c' }, routing: { builder: {}, reviewers: {} } } } };
  assert.deepEqual(stageModels(plain, 'claude', 'high'), { intake: 'a', 'spec-writer': 'b', approver: 'c', 'spec-writer-amend': 'b' });
  assert.equal(stageModels(config, 'claude')['spec-writer'], 'opus');
});

test('an object without the requested risk, or with a blank model, is an error', () => {
  const broken = { providers: { claude: { models: { intake: 'a', 'spec-writer': { low: 'x' }, approver: 'c' }, routing: { builder: {}, reviewers: {} } } } };
  assert.throws(() => stageModels(broken, 'claude', 'high'), /no model for spec-writer/);
  assert.throws(() => stageModels(config, 'claude', 'extreme'), /unknown risk/);
});

test('route keeps the builder and reviewer table untouched by the new model shapes', () => {
  assert.deepEqual(route(config, { risk: 'low', surfaces: [] }, 'codex'), { builder: 'gpt-6-luna', reviewers: { code: 'gpt-6-luna' } });
});

test('both providers declare the same lanes, and the xs lane models name a builder and a reviewer', () => {
  assert.deepEqual(config.lanes.xs, { reviewers: ['code'], spec: false, approver: 'script', max_lines: 80 });
  assert.deepEqual(config.providers.claude.lanes.xs, { builder: 'sonnet', reviewer: 'haiku' });
  assert.deepEqual(config.providers.codex.lanes.xs, { builder: 'gpt-6-luna', reviewer: 'gpt-6-luna' });
});

test('route with lane xs picks the xs builder and only the lenses the lane lists', () => {
  assert.deepEqual(route(config, { risk: 'low', surfaces: ['ui'] }, 'claude', 'xs'), { builder: 'sonnet', reviewers: { code: 'haiku' } });
  assert.deepEqual(route(config, { risk: 'low', surfaces: ['ui'] }, 'codex', 'xs'), { builder: 'gpt-6-luna', reviewers: { code: 'gpt-6-luna' } });
  assert.throws(() => route(config, { risk: 'low', surfaces: [] }, 'claude', 'huge'), /unknown lane/);
});

test('both providers use the same shape (string or risk map) for every model role', () => {
  const shape = (v) => (typeof v === 'string' ? 'string' : Object.keys(v).sort().join(','));
  for (const role of Object.keys(config.providers.claude.models)) {
    assert.equal(shape(config.providers.claude.models[role]), shape(config.providers.codex.models[role]), role);
  }
  assert.deepEqual(Object.keys(config.providers.claude.lanes), Object.keys(config.lanes));
  assert.deepEqual(Object.keys(config.providers.codex.lanes), Object.keys(config.lanes));
});
