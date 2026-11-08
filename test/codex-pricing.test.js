import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codexJobCost } from '../factory/lib/cost.js';

const config = JSON.parse(readFileSync(new URL('../factory/config.json', import.meta.url)));
const prices = config.providers.codex.prices;
const root = '/repo';
const job = { id: '036-pricing', worktree: `${root}/.worktrees/036-pricing` };
const usage = {
  input_tokens: 1_000_000, cached_input_tokens: 100_000,
  cache_write_input_tokens: 50_000, output_tokens: 200_000,
};
const rollout = (model) => [
  { type: 'session_meta', payload: { id: 'pricing-session', cwd: job.worktree } },
  { type: 'turn_context', payload: { model } },
  { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage } } },
].map(JSON.stringify).join('\n');

test('AC-1: Codex Luna prices match official Standard API rates', () => {
  assert.deepEqual(prices['gpt-6-luna'], { input: 0.10, output: 0.50, cache_read: 0.01, cache_write: 0.125 });
});

test('AC-2: Codex Sol prices match official Standard API rates', () => {
  assert.deepEqual(prices['gpt-6.1-sol'], { input: 2, output: 10, cache_read: 0.10, cache_write: 2.50 });
});

test('AC-3: associated Codex usage calculates job cost using configured rates and cache accounting', () => {
  const result = codexJobCost([rollout('gpt-6-luna')], job, prices, root);
  const expected = (850_000 * 0.10 + 100_000 * 0.01 + 50_000 * 0.125 + 200_000 * 0.50) / 1e6;
  assert.equal(result.cost_status, 'available');
  assert.equal(result.cost_usd, expected);
});

test('AC-4: missing session association or exact model price remains unavailable', () => {
  const unassociated = rollout('gpt-6-luna').replace(job.worktree, '/other');
  const unknownModel = rollout('unconfigured-model');
  for (const result of [
    codexJobCost([], job, prices, root),
    codexJobCost([unassociated], job, prices, root),
    codexJobCost([unknownModel], job, prices, root),
  ]) {
    assert.equal(result.cost_status, 'unavailable');
    assert.equal(result.cost_usd, null);
  }
});

test('AC-5: Claude provider pricing remains unchanged', () => {
  assert.deepEqual(config.prices, {
    fable: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
    opus: { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
    sonnet: { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
    haiku: { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
  });
});
