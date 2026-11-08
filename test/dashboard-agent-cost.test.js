// Per-agent cost in the pipeline inspector: shown only when job.cost_by_agent has data
// for the selected stage, so jobs synced before P2-3 (and unavailable Codex costs) look
// exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { stageDetails } from '../factory/pipeline-canvas.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const html = dashboardSource();
const job = {
  id: '009-x', stage: 'review', provider: 'claude', cost_usd: 4, cost_status: 'available',
  cost_by_agent: {
    by_role: { builder: 2.5, intake: 0.25, 'review-code': 0.75, 'review-ui': 0.5 },
    by_round: { 1: 3, 2: 1 },
  },
};

test('the stage shows the cost of its own agent', () => {
  assert.equal(stageDetails(job, 'build').agentCost, 'builder $2.50');
  assert.equal(stageDetails(job, 'intake').agentCost, 'intake $0.25');
});

test('the review stage lists every reviewer lens that has a cost', () => {
  assert.equal(stageDetails(job, 'review').agentCost, 'ui $0.50, code $0.75');
});

test('no agent cost when there is no data for the stage', () => {
  assert.equal(stageDetails(job, 'spec').agentCost, null);
  assert.equal(stageDetails(job, 'gate').agentCost, null);
  assert.equal(stageDetails({ ...job, cost_by_agent: undefined }, 'build').agentCost, null);
  assert.equal(stageDetails({ ...job, cost_by_agent: { by_role: {}, by_round: {} } }, 'build').agentCost, null);
  assert.equal(stageDetails({ ...job, cost_by_agent: 'junk' }, 'build').agentCost, null);
});

test('an unavailable job cost never shows an agent cost', () => {
  const unavailable = { ...job, provider: 'codex', cost_usd: null, cost_status: 'unavailable', cost_reason: 'ambiguous_session' };
  assert.equal(stageDetails(unavailable, 'build').agentCost, null);
});

test('malformed amounts are ignored', () => {
  const bad = { ...job, cost_by_agent: { by_role: { builder: 'x', intake: -1, 'review-ui': Infinity } } };
  assert.equal(stageDetails(bad, 'build').agentCost, null);
  assert.equal(stageDetails(bad, 'intake').agentCost, null);
  assert.equal(stageDetails(bad, 'review').agentCost, null);
});

test('the inspector renders the field only when it exists, in every language, without inline script', () => {
  assert.match(html, /\[T\.pipelineAgentCost, details\.agentCost\]/);
  assert.match(html, /details\.agentCost \? \[\[T\.pipelineAgentCost/);
  assert.equal((html.match(/"pipelineAgentCost":/g) || []).length, 3);
});
