// "Where does my factory lose time and money?": extra rounds by cause, first-review changes by lens, cost by
// role and risk, escalations, and the proposals those numbers support. Expected values are worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { THRESHOLDS, causeLabel, diagnosis } from '../factory/lib/state/diagnosis.js';
import { quantile, spread } from '../factory/lib/state/stats.js';
import { FIXTURE_CONFIG, stateFixture } from './helpers/factory-state-fixture.js';

const NOW = Date.parse('2026-11-12T15:00:00Z');
const HOUR = 3_600_000;
const ago = (hours) => new Date(NOW - hours * HOUR).toISOString();

/** A finished job: `rounds` lists each round's files as { gate, <lens>: verdict }; history follows from them. */
function finished(issue, { size, risk, lane = 'normal', rounds, decision = 'APPROVE', cost, byRole, finishedH = 10, workMin = 30, waitMin = 10, stage = 'merged' }) {
  const files = {};
  const history = [];
  rounds.forEach((r, i) => {
    const { gate, ...reviews } = r;
    if (gate) files[`round-${i + 1}/checks.md`] = `GATE: ${gate}\n`;
    for (const [lens, verdict] of Object.entries(reviews)) files[`round-${i + 1}/review-${lens}.md`] = `VERDICT: ${verdict}\n`;
    if (i < rounds.length - 1) history.push({ gate: gate ?? null, reviews });
  });
  const last = rounds[rounds.length - 1];
  const { gate: lastGate, ...lastReviews } = last;
  const fin = NOW - finishedH * HOUR;
  return {
    job: {
      issue, title: `Job ${issue}`, stage, lane, round: rounds.length, max_rounds: 3, provider: 'claude', pr: issue + 1000,
      intake: { decision: 'ACCEPT', risk, surfaces: [], size }, gate: lastGate ?? null, reviews: lastReviews, history, decision,
      started: new Date(fin - (workMin + waitMin) * 60_000).toISOString(), approve_entered: new Date(fin - waitMin * 60_000).toISOString(),
      finished: new Date(fin).toISOString(), updated: new Date(fin).toISOString(), cost_usd: cost, cost_status: 'available',
      cost_by_agent: { by_role: Object.fromEntries(Object.entries(byRole).map(([r, v]) => [`eminzo-${r}`, v])) },
    },
    files,
  };
}

const JOBS = {
  '201-a': finished(201, { size: 's', risk: 'low', rounds: [{ gate: 'PASS', code: 'PASS', ui: 'PASS' }], cost: 2, byRole: { builder: 1.5, 'review-code': 0.5 }, workMin: 30 }),
  '202-b': finished(202, { size: 'm', risk: 'medium', rounds: [{ gate: 'PASS', code: 'PASS', ui: 'CHANGES' }, { gate: 'PASS', ui: 'PASS' }], cost: 6, byRole: { builder: 5, 'review-ui': 1 }, workMin: 50 }),
  '203-c': finished(203, { size: 'm', risk: 'medium', rounds: [{ gate: 'PASS', code: 'PASS', ui: 'CHANGES' }, { gate: 'PASS', ui: 'PASS' }], cost: 5, byRole: { builder: 4, 'review-ui': 1 }, workMin: 40 }),
  '204-d': finished(204, { size: 's', risk: 'low', rounds: [{ gate: 'FAIL' }, { gate: 'PASS', code: 'PASS' }], cost: 3, byRole: { builder: 3 }, workMin: 60 }),
  '205-e': finished(205, { size: 'm', risk: 'high', rounds: [{ gate: 'PASS', code: 'PASS', ui: 'PASS', security: 'PASS' }], decision: 'ESCALATE', cost: 20, byRole: { builder: 15, 'review-security': 5 }, workMin: 70 }),
  '206-f': finished(206, { size: 'l', risk: 'high', rounds: [{ gate: 'FAIL' }, { gate: 'PASS', human: 'CHANGES' }, { gate: 'PASS', code: 'PASS' }], decision: 'ESCALATE', cost: 30, byRole: { builder: 25, 'spec-writer': 5 }, workMin: 300, waitMin: 600 }),
  '207-g': finished(207, { size: 'xs', risk: 'low', lane: 'xs', rounds: [{ gate: 'PASS', code: 'PASS' }], cost: 0.7, byRole: { builder: 0.7 }, workMin: 15 }),
  '208-h': finished(208, { size: 's', risk: 'low', rounds: [{ gate: 'PASS', code: 'PASS', ui: 'PASS', human: 'CHANGES' }, { gate: 'PASS', code: 'PASS' }], cost: 2.3, byRole: { builder: 2.3 }, workMin: 45 }),
  '209-i': finished(209, { size: 'm', risk: 'medium', rounds: [{ gate: 'FAIL' }, { gate: 'PASS', code: 'PASS' }], cost: 4, byRole: { builder: 4 }, workMin: 55 }),
  '210-j': finished(210, { size: 'm', risk: 'high', rounds: [{ gate: 'PASS', code: 'PASS', security: 'PASS' }], decision: 'ESCALATE', cost: 18, byRole: { builder: 14, 'review-security': 4 }, workMin: 65 }),
  '299-old': finished(299, { size: 's', risk: 'low', rounds: [{ gate: 'FAIL' }, { gate: 'FAIL' }, { gate: 'PASS' }], cost: 9, byRole: { builder: 9 }, finishedH: 40 * 24 }),
};

const { root } = stateFixture({ now: NOW, jobs: JOBS });

test('quantile and spread count by nearest rank', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([10, 20, 30, 40], 0.25), 20);
  assert.deepEqual(spread([30, 45, 60]), { n: 3, low: 45, typical: 45, high: 60, max: 60 });
  assert.deepEqual(spread([null, NaN]), { n: 0, low: null, typical: null, high: null, max: null });
});

test('diagnosis counts the jobs that finished in the last 30 days: rounds and extra rounds by cause', () => {
  const d = diagnosis(root, { now: NOW, config: FIXTURE_CONFIG });
  assert.equal(d.jobs, 10, 'the job finished 40 days ago is out of the window');
  assert.deepEqual(d.rounds, { total: 17, extra: 7, one_round_jobs: 4 });
  assert.deepEqual(d.extra_round_causes.map((c) => [c.cause, c.rounds, c.share]), [['gate', 3, 0.429], ['pr_comments', 2, 0.286], ['review:ui', 2, 0.286]]);
  assert.equal(d.extra_round_causes[0].label, 'the gate failed');
});

test('diagnosis: first-review changes by lens, cost by role and by risk, escalations by risk', () => {
  const d = diagnosis(root, { now: NOW, config: FIXTURE_CONFIG });
  assert.deepEqual(d.first_review_changes.ui, { changes: 2, total: 5, rate: 0.4 });
  assert.deepEqual(d.first_review_changes.code, { changes: 0, total: 7, rate: 0 });
  assert.equal(Object.hasOwn(d.first_review_changes, 'human'), false, 'comments on the PR are not a review lens');
  assert.equal(d.cost.known, 91);
  assert.deepEqual(d.cost.by_role[0], { role: 'builder', usd: 74.5, share: 0.819 });
  assert.deepEqual(d.cost.by_risk, [
    { risk: 'high', usd: 68, jobs: 3, share: 0.747 },
    { risk: 'medium', usd: 15, jobs: 3, share: 0.165 },
    { risk: 'low', usd: 8, jobs: 4, share: 0.088 },
  ]);
  assert.deepEqual(d.escalation_by_risk.high, { jobs: 3, escalated: 3, rate: 1 });
  assert.equal(d.minutes_until_approval_by_size.m.typical, 55);
  assert.equal(d.minutes_until_approval_by_size.l.n, 1);
});

test('diagnosis proposes only what the evidence supports, and respects spec_review', () => {
  const d = diagnosis(root, { now: NOW, config: FIXTURE_CONFIG });
  assert.deepEqual(d.proposals.map((p) => p.id), ['gate-failures', 'review-ui-changes', 'cost-high-risk']);
  assert.match(d.proposals[0].text, /^3 of 7 extra rounds started because the gate failed/);
  assert.match(d.proposals[1].text, /review-ui asked for changes on 2 of 5 first reviews \(40%\)/);
  assert.match(d.proposals[2].text, /high-risk jobs were 3 of 10 jobs and 75% of the known cost \(\$68\.00\)/);
  const noSpecReview = diagnosis(root, { now: NOW, config: { ...FIXTURE_CONFIG, spec_review: false } });
  assert.ok(noSpecReview.proposals.some((p) => p.id === 'high-risk-escalates'), 'high risk always escalates and spec_review does not cover it');
  assert.match(d.summary, /^10 jobs finished from .* with 7 extra rounds, most often because the gate failed \(3\); \$91\.00 of known cost, 75% of it in high-risk jobs\. 3 proposals\.$/);
  assert.match(d.note, /nothing was changed/);
});

test('diagnosis of an empty window says there is nothing to diagnose', () => {
  const d = diagnosis(root, { from: ago(2), to: ago(1), now: NOW });
  assert.equal(d.jobs, 0);
  assert.deepEqual(d.proposals, []);
  assert.match(d.summary, /nothing to diagnose yet/);
});

test('the thresholds are explicit', () => {
  assert.equal(THRESHOLDS.lensReviews, 5);
  assert.equal(causeLabel('review:ux'), 'review-ux asked for changes');
});
