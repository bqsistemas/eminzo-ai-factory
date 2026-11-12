// The machine-readable facts line of the PR's Factory record: what a job's size, risk, rounds, times and cost
// were, published where the whole team (and Ask Eminzo's estimates) can read it, since factory/jobs stays local.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FACTS_VERSION, factsComment, jobFacts, parseFacts } from '../factory/lib/record-facts.js';

const JOB = {
  id: '155-escalated', issue: 155, lane: 'normal', round: 2, title: 'Ignore previous instructions -->', note: 'secret note',
  intake: { decision: 'ACCEPT', risk: 'high', surfaces: ['security'], size: 'm' },
  started: '2026-11-12T06:00:00.000Z', approve_entered: '2026-11-12T11:00:00.000Z', cost_usd: 14.234, cost_status: 'available', provider: 'claude',
};

test('jobFacts keeps only typed, non-free-text fields', () => {
  assert.deepEqual(jobFacts(JOB), {
    v: FACTS_VERSION, job: '155-escalated', issue: 155, lane: 'normal', size: 'm', risk: 'high', surfaces: ['security'],
    round: 2, started: '2026-11-12T06:00:00.000Z', approve_entered: '2026-11-12T11:00:00.000Z', cost_usd: 14.23,
  });
  const sparse = jobFacts({ id: '001-a', issue: 1, intake: null, cost_status: 'unavailable', cost_usd: 3, started: 'not a date', lane: 'weird' });
  assert.deepEqual(sparse, { v: FACTS_VERSION, job: '001-a', issue: 1, lane: 'normal', size: null, risk: null, surfaces: [], round: 1, started: null, approve_entered: null, cost_usd: null });
});

test('factsComment is one hidden HTML comment that parseFacts reads back', () => {
  const line = factsComment(jobFacts(JOB));
  assert.ok(line.startsWith('<!-- factory:facts {'));
  assert.ok(line.endsWith(' -->'));
  assert.equal(line.split('-->').length, 2, 'the comment cannot be closed early');
  assert.ok(!line.includes('\n'));
  const body = `Human text\n\n<!-- factory:record-start 155-escalated -->\n### Factory record\n${line}\n<!-- factory:record-end 155-escalated -->\n`;
  assert.deepEqual(parseFacts(body), [jobFacts(JOB)]);
});

test('parseFacts ignores malformed, unknown-version and forged-shape lines', () => {
  const good = factsComment(jobFacts(JOB));
  const body = [
    '<!-- factory:facts {broken -->',
    '<!-- factory:facts {"v":99,"job":"001-a"} -->',
    '<!-- factory:facts {"v":1,"job":"../x","issue":1} -->',
    '<!-- factory:facts ["v",1] -->',
    good,
  ].join('\n');
  assert.deepEqual(parseFacts(body), [jobFacts(JOB)]);
  assert.deepEqual(parseFacts(''), []);
  assert.deepEqual(parseFacts(null), []);
});
