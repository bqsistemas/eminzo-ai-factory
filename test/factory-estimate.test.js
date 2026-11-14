// "How long would this take the team?": similar finished jobs by size, risk and lane (with fallbacks), ranges
// with the number of jobs behind them, "too little history" below MIN_BASE, warnings, totals, and the history
// read from local jobs and from the facts lines of merged pull requests. Expected values are worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { factsComment, jobFacts } from '../factory/lib/record-facts.js';
import { MIN_BASE, estimateWork, humanMinutes } from '../factory/lib/state/estimate.js';
import { githubRecords, historyRecords, localRecords } from '../factory/lib/state/history.js';
import { stateFixture } from './helpers/factory-state-fixture.js';

const NOW = Date.parse('2026-11-12T15:00:00Z');

const rec = (size, risk, lane, factory, rounds, cost, wait, escalated, source = 'local') => ({ job: `j-${Math.random()}`, source, size, risk, lane, surfaces: [], rounds, factory_minutes: factory, wait_minutes: wait, cost_usd: cost, escalated });
const many = (size, risk, lane, cols) => cols.factory.map((f, i) => rec(size, risk, lane, f, cols.rounds[i], cols.cost[i], cols.wait[i], cols.escalated[i]));

const RECORDS = [
  ...many('m', 'medium', 'normal', { factory: [40, 50, 55, 60, 70, 90], rounds: [1, 1, 2, 2, 2, 3], cost: [4, 5, 6, 6, 7, 9], wait: [5, 10, 10, 20, 30, 600], escalated: [false, false, false, false, false, false] }),
  ...many('m', 'high', 'normal', { factory: [100, 120], rounds: [1, 2], cost: [15, 20], wait: [60, 300], escalated: [true, true] }),
  ...many('s', 'low', 'normal', { factory: [20, 25, 30, 35, 40], rounds: [1, 1, 1, 1, 1], cost: [1, 1.5, 2, 2, 3], wait: [5, 5, 5, 5, 5], escalated: [false, false, false, false, false] }),
  rec('s', 'low', 'xs', 10, 1, 0.5, 2, false),
  ...many('l', 'high', 'normal', { factory: [300, 350, 400], rounds: [2, 3, 3], cost: [25, 30, 40], wait: [100, 200, 900], escalated: [true, false, true] }),
];

const DELIVERABLES = [
  { title: 'Ver solo lo pendiente', size: 'm', risk: 'medium' },
  { title: 'Aviso de pendientes antiguas', size: 'm', risk: 'high' },
  { title: 'Rehacer las notificaciones', size: 'l', risk: 'high' },
  { title: 'Texto del filtro', size: 's', risk: 'low', lane: 'xs' },
];

test('humanMinutes reads like a person', () => {
  assert.equal(humanMinutes(45), '45 min');
  assert.equal(humanMinutes(125), '2.1 h');
  assert.equal(humanMinutes(null), null);
});

test('the strictest match with enough jobs gives the ranges: factory time, rounds, wait and cost', () => {
  const [first] = estimateWork(RECORDS, DELIVERABLES).deliverables;
  assert.deepEqual(first.basis, { match: 'size+risk+lane', jobs: 6, sources: ['local'] });
  assert.deepEqual(first.factory_minutes, { low: 50, typical: 60, high: 70 });
  assert.deepEqual(first.rounds, { low: 1, typical: 2, high: 2 });
  assert.deepEqual(first.wait_minutes, { typical: 20, worst: 600 });
  assert.deepEqual(first.cost_usd, { low: 5, typical: 6, high: 7 });
  assert.deepEqual(first.warnings, []);
});

test('with too few at one level it falls back to a looser one, and warns about likely escalation', () => {
  const second = estimateWork(RECORDS, DELIVERABLES).deliverables[1];
  assert.deepEqual(second.basis, { match: 'size+lane', jobs: 8, sources: ['local'] });
  assert.deepEqual(second.factory_minutes, { low: 55, typical: 70, high: 90 });
  assert.deepEqual(second.escalation, { risk: 'high', jobs: 5, escalated: 4, rate: 0.8 });
  assert.deepEqual(second.warnings, ["likely to wait for a person's decision: 4 of 5 high-risk jobs did"]);
  const fourth = estimateWork(RECORDS, DELIVERABLES).deliverables[3];
  assert.equal(fourth.basis.match, 'size');
  assert.deepEqual(fourth.factory_minutes, { low: 20, typical: 30, high: 35 });
});

test(`below ${MIN_BASE} similar jobs there is no range, only the count and the reason`, () => {
  const third = estimateWork(RECORDS, DELIVERABLES).deliverables[2];
  assert.deepEqual(third.basis, { match: null, jobs: 3, sources: [] });
  assert.equal(third.factory_minutes, null);
  assert.equal(third.cost_usd, null);
  assert.deepEqual(third.warnings, [
    'too little history: 3 finished jobs of size l, fewer than 5',
    'large: consider splitting it into smaller deliverables, which finish in fewer rounds and are easier to review',
    "likely to wait for a person's decision: 4 of 5 high-risk jobs did",
  ]);
});

test('totals add the estimated deliverables and say what is left out', () => {
  const e = estimateWork(RECORDS, DELIVERABLES, { concurrency: 3 });
  assert.deepEqual(e.total.factory_minutes, { low: 125, typical: 160, high: 195 });
  assert.deepEqual(e.total.cost_usd, { low: 12, typical: 15, high: 18 });
  assert.equal(e.total.without_estimate, 1);
  assert.match(e.total.note, /up to 3 at once/);
  assert.equal(e.summary, '4 deliverables: about 2.1 h to 3.3 h until ready for approval (typical 2.7 h) and $12.00 to $18.00; 1 without enough history. Ranges are the middle half of similar finished jobs; the wait for people is not included.');
  assert.match(e.method, /25th, 50th and 75th percentiles/);
  assert.equal(estimateWork([], [{ size: 'm', risk: 'low' }]).summary, '1 deliverable: no estimate; 1 without enough history. Ranges are the middle half of similar finished jobs; the wait for people is not included.');
});

const { root } = stateFixture({ now: NOW });

test('localRecords: merged jobs with a start and an approve time', () => {
  const records = localRecords(root);
  assert.deepEqual(records.map((r) => [r.job, r.size, r.lane, r.factory_minutes, r.wait_minutes, r.cost_usd, r.escalated]), [
    ['150-old-merged', 's', 'normal', 30, 90, 2.5, false],
    ['158-merged-recent', 'xs', 'xs', 24, 216, 0.7, false],
  ]);
});

const remoteFacts = factsComment(jobFacts({
  id: '300-remote', issue: 300, lane: 'normal', round: 2, decision: 'ESCALATE', intake: { risk: 'high', size: 'm', surfaces: ['security'] },
  started: '2026-11-01T10:00:00Z', approve_entered: '2026-11-01T11:30:00Z', cost_usd: 12, cost_status: 'available',
}));
const PRS = [
  { number: 301, mergedAt: '2026-11-01T13:30:00Z', body: `Human text\n\n${remoteFacts}\n` },
  { number: 151, mergedAt: '2026-11-07T15:00:00Z', body: factsComment(jobFacts({ id: '150-old-merged', issue: 150, started: '2026-11-07T13:00:00Z', approve_entered: '2026-11-07T13:30:00Z' })) },
  { number: 302, mergedAt: '2026-11-02T10:00:00Z', body: 'No facts here' },
];

test('githubRecords: one record per facts line of a merged PR; the wait runs to mergedAt', () => {
  const calls = [];
  const { records } = githubRecords(root, { gh: 'gh', runner: (cmd, args) => { calls.push(args); return { status: 0, stdout: JSON.stringify(PRS) }; } });
  assert.deepEqual(calls[0].slice(0, 4), ['pr', 'list', '--state', 'merged']);
  const remote = records.find((r) => r.job === '300-remote');
  assert.deepEqual([remote.source, remote.pr, remote.size, remote.risk, remote.rounds, remote.factory_minutes, remote.wait_minutes, remote.cost_usd, remote.escalated],
    ['github', 301, 'm', 'high', 2, 90, 120, 12, true]);
});

test('historyRecords: local first, GitHub only for jobs not on this machine, and a gh failure keeps the local history', () => {
  const runner = () => ({ status: 0, stdout: JSON.stringify(PRS) });
  const both = historyRecords(root, { github: true, runner });
  assert.deepEqual(both.sources, { local: 2, github: 1 });
  assert.deepEqual(both.records.map((r) => r.job), ['150-old-merged', '158-merged-recent', '300-remote']);
  const offline = historyRecords(root, { github: true, runner: () => ({ status: 1, stderr: 'gh: not logged in' }) });
  assert.deepEqual(offline.sources, { local: 2, github: 0 });
  assert.match(offline.github_error, /could not read merged pull requests from GitHub: gh: not logged in/);
  assert.deepEqual(historyRecords(root).sources, { local: 2, github: 0 });
});
