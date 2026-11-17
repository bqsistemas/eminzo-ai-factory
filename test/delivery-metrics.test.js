// `deliveryMetrics`: the DORA, cost and work-in-progress numbers of a period, from the local jobs only.
// The fixtures have fixed times and the zone is fixed, so every number below is computed by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diagnosis } from '../factory/lib/state/diagnosis.js';
import { DELIVERY_SCHEMA, PeriodError, deliveryMetrics, deliveryText, parseDeliveryArgs, resolvePeriod } from '../factory/lib/state/delivery.js';
import { periodSummary } from '../factory/lib/state/queries.js';
import { factoryTools } from '../factory/lib/mcp/tools.js';
import { ToolError } from '../factory/lib/mcp/protocol.js';
import { NOW, REPO, TZ, addJob, emptyRoot, septemberRoot, wipRoot } from './helpers/delivery-fixture.js';

process.env.TZ = TZ;

const SEPT = { from: '2026-09-01', to: '2026-09-30' };
const BLOCK_KEYS = ['deployments', 'change_lead_time', 'lead_time_parts', 'until_approval_by_size', 'failures', 'change_fail_rate', 'deployment_rework_rate', 'finished', 'first_pass', 'extra_rounds', 'first_review_changes', 'escalation_by_risk', 'cost'];
const EMPTY_SPREAD = { n: 0, median: null, p85: null, max: null };

test('AC-1: the result has schema 1, source local and every key of the contract', () => {
  const r = deliveryMetrics(septemberRoot(), { ...SEPT, now: NOW });
  assert.equal(DELIVERY_SCHEMA, 1);
  assert.equal(r.schema, 1);
  assert.equal(r.source, 'local');
  assert.equal(r.read_at, new Date(NOW).toISOString());
  assert.equal(r.repo, REPO);
  assert.equal(r.tz, TZ);
  for (const k of ['schema', 'source', 'read_at', 'repo', 'tz', 'period', 'previous', 'current', 'before', 'weeks', 'wip']) assert.ok(k in r, k);
  assert.deepEqual(Object.keys(r.current), BLOCK_KEYS);
  assert.deepEqual(Object.keys(r.before), BLOCK_KEYS);
  for (const w of r.weeks) assert.deepEqual(Object.keys(w.block), BLOCK_KEYS);
  assert.equal(deliveryMetrics(emptyRoot({ repo: null }), { now: NOW }).repo, null);
});

test('AC-1: the text summary is short, has no issue titles and warns about partial data', () => {
  const root = septemberRoot();
  const text = deliveryText(deliveryMetrics(root, { from: '2026-08-01', to: '2026-08-31', now: NOW }));
  assert.ok(text.split('\n').length <= 14, text);
  assert.doesNotMatch(text, /Held at the gate|Held one|First|Third/);
  assert.match(text, /partial/i);
  assert.throws(() => JSON.parse(text));
});

test('AC-2: deployments, lead time and per_day over a fixed period', () => {
  const { current } = deliveryMetrics(septemberRoot(), { ...SEPT, now: NOW });
  const d = current.deployments;
  assert.equal(d.count, 4); // 201, 202, 203, 211: not 204 (before), 206 (after) or 205 (rejected)
  assert.equal(current.finished.rejected, 1);
  assert.equal(current.finished.merged, 4);
  assert.equal(d.per_day.length, 30);
  assert.equal(d.per_day[0].date, '2026-09-01');
  assert.equal(d.per_day[29].date, '2026-09-30');
  assert.equal(d.per_day.reduce((s, x) => s + x.count, 0), d.count);
  assert.equal(d.days_with_deployment, d.per_day.filter((x) => x.count > 0).length);
  assert.equal(d.days_with_deployment, 4);
  assert.equal(d.per_week, 0.9); // 4 / (30 / 7)
  assert.deepEqual(d.per_day.find((x) => x.date === '2026-09-10'), { date: '2026-09-10', count: 1, rework: 0, failures: 0 });
  // 120, 100, 150 and 60 minutes: classic median, nearest-rank p85
  assert.deepEqual(current.change_lead_time, { n: 4, median: 110, p85: 150, max: 150 });
  // 202 has no approve_entered: it counts in the lead time and in neither part
  assert.deepEqual(current.lead_time_parts.until_approval, { n: 3, median: 30, p85: 60, max: 60 });
  assert.deepEqual(current.lead_time_parts.after_approval, { n: 3, median: 90, p85: 90, max: 90 });
  assert.deepEqual(current.until_approval_by_size.s, { n: 1, low: 30, median: 30, high: 30 });
  assert.equal(current.until_approval_by_size.m.n, 0); // 202 has no approve_entered
  assert.deepEqual(current.until_approval_by_size.l, { n: 1, low: 60, median: 60, high: 60 });
});

test('AC-3: a shared fix issue is one failure; rates and rework follow', () => {
  const { current, before } = deliveryMetrics(septemberRoot(), { ...SEPT, now: NOW });
  const f = current.failures;
  assert.deepEqual([f.count, f.recovered, f.open], [3, 2, 1]);
  assert.deepEqual(f.items, [
    { fix_issue: 203, since: '2026-09-05T10:00:00.000Z', until: '2026-09-05T14:00:00.000Z', minutes: 240, held_jobs: 2 },
    { fix_issue: null, since: '2026-09-07T10:00:00.000Z', until: '2026-09-07T10:30:00.000Z', minutes: 30, held_jobs: 1 },
    { fix_issue: 299, since: '2026-09-25T10:00:00.000Z', until: null, minutes: null, held_jobs: 1 },
  ]);
  assert.deepEqual(f.recovery, { n: 2, median: 135, p85: 240, max: 240 }); // the open one is not in it
  assert.deepEqual(current.change_fail_rate, { failures: 3, deployments: 4, rate: 0.75 });
  assert.deepEqual(current.deployment_rework_rate, { rework: 1, deployments: 4, rate: 0.25 }); // 203 is the fix issue
  assert.equal(current.deployments.per_day.find((x) => x.date === '2026-09-20').rework, 1);
  assert.equal(current.deployments.per_day.find((x) => x.date === '2026-09-05').failures, 1);
  assert.equal(before.failures.count, 0);
  assert.equal(before.deployments.count, 1);
  assert.equal(before.change_fail_rate.rate, 0);
});

test('AC-4: a finished job without cost is counted, never as zero', () => {
  const root = septemberRoot();
  const { current } = deliveryMetrics(root, { ...SEPT, now: NOW });
  const c = current.cost;
  assert.equal(c.known_usd, 14.25);
  assert.equal(c.jobs_with_cost, 4);
  assert.equal(c.jobs_without_cost, 1);
  assert.equal(c.per_job_with_cost, 3.56);
  assert.equal(c.by_risk.find((r) => r.risk === 'medium').jobs_without_cost, 1);
  assert.ok(c.by_risk.filter((r) => r.risk !== 'medium').every((r) => r.jobs_without_cost === 0));
  const range = { from: new Date(Date.parse('2026-09-01T06:00:00Z')).toISOString(), to: new Date(Date.parse('2026-10-01T06:00:00Z')).toISOString(), now: NOW };
  const p = periodSummary(root, range);
  const g = diagnosis(root, range);
  assert.deepEqual(current.finished, p.finished);
  assert.deepEqual(current.first_pass, { one_round: p.rounds.one_round_jobs, finished: p.finished.total, rate: 0.8 });
  assert.equal(current.extra_rounds.total, p.rounds.extra);
  assert.deepEqual(current.extra_rounds.by_cause, g.extra_round_causes.map(({ cause, rounds }) => ({ cause, rounds })));
  assert.deepEqual(current.first_review_changes, g.first_review_changes);
  assert.deepEqual(current.escalation_by_risk, g.escalation_by_risk);
  assert.deepEqual(c.by_role, g.cost.by_role);
  for (const size of ['xs', 's', 'm', 'l']) {
    const s = g.minutes_until_approval_by_size[size];
    assert.deepEqual(current.until_approval_by_size[size], { n: s.n, low: s.low, median: s.typical, high: s.high });
  }
});

test('AC-4: a period without jobs has zero counts, null rates and empty spreads', () => {
  const { current, weeks, wip } = deliveryMetrics(emptyRoot(), { days: 10, now: NOW });
  assert.equal(current.deployments.count, 0);
  assert.equal(current.deployments.per_week, 0);
  assert.equal(current.deployments.per_day.length, 11);
  assert.deepEqual(current.change_lead_time, EMPTY_SPREAD);
  assert.deepEqual(current.lead_time_parts, { until_approval: EMPTY_SPREAD, after_approval: EMPTY_SPREAD });
  assert.deepEqual(current.failures, { count: 0, recovered: 0, open: 0, recovery: EMPTY_SPREAD, items: [] });
  assert.deepEqual(current.change_fail_rate, { failures: 0, deployments: 0, rate: null });
  assert.deepEqual(current.deployment_rework_rate, { rework: 0, deployments: 0, rate: null });
  assert.deepEqual(current.first_pass, { one_round: 0, finished: 0, rate: null });
  assert.equal(current.cost.per_job_with_cost, null);
  assert.deepEqual([current.cost.known_usd, current.cost.jobs_with_cost, current.cost.jobs_without_cost], [0, 0, 0]);
  assert.equal(weeks.length, 4);
  assert.deepEqual(wip, { count: 0, items: [] });
});

test('AC-5: dates are local midnights; previous and weeks follow the period', () => {
  const r = deliveryMetrics(septemberRoot(), { ...SEPT, weeks: 3, now: NOW });
  assert.equal(r.period.from, '2026-09-01T06:00:00.000Z'); // local midnight in UTC-6, not 00:00Z
  assert.equal(r.period.to, '2026-10-01T06:00:00.000Z'); // the next midnight: both dates are included
  assert.equal(r.period.days, 30);
  assert.deepEqual([r.previous.from, r.previous.to], ['2026-08-02T06:00:00.000Z', '2026-09-01T06:00:00.000Z']);
  assert.deepEqual(r.weeks.map((w) => [w.from, w.to]), [
    ['2026-09-10T06:00:00.000Z', '2026-09-17T06:00:00.000Z'],
    ['2026-09-17T06:00:00.000Z', '2026-09-24T06:00:00.000Z'],
    ['2026-09-24T06:00:00.000Z', '2026-10-01T06:00:00.000Z'],
  ]);
  assert.equal(r.weeks[1].block.deployments.count, 2); // 203 and 211
  assert.equal(deliveryMetrics(septemberRoot(), { ...SEPT, now: NOW }).weeks.length, 4);
  assert.deepEqual(deliveryMetrics(septemberRoot(), { ...SEPT, weeks: 0, now: NOW }).weeks, []);
});

test('AC-5: a period that starts before the first job is partial', () => {
  const r = deliveryMetrics(septemberRoot(), { from: '2026-08-01', to: '2026-08-31', now: NOW });
  assert.equal(r.period.data_starts, '2026-08-20T08:00:00.000Z');
  assert.equal(r.period.partial, true);
  assert.equal(r.previous.partial, true);
  assert.equal(deliveryMetrics(septemberRoot(), { ...SEPT, now: NOW }).period.partial, false);
  const none = deliveryMetrics(emptyRoot(), { now: NOW });
  assert.deepEqual([none.period.data_starts, none.period.partial], [null, false]);
});

test('AC-5: the period rules reject what they must', () => {
  const bad = (options) => assert.throws(() => resolvePeriod(options, NOW), PeriodError, JSON.stringify(options));
  bad({ days: 7, from: '2026-09-01' });
  bad({ from: '2026-09-05', to: '2026-09-01' });
  bad({ from: '2026-09-01T10:00:00Z', to: '2026-09-01T10:00:00Z' });
  bad({ from: '2026-09-01T10:00:00Z', to: '2026-09-01T20:00:00Z' }); // under a day
  bad({ from: '2025-01-01', to: '2026-09-01' }); // over 365 days
  bad({ days: 0 });
  bad({ days: 366 });
  bad({ weeks: 13 });
  bad({ weeks: -1 });
  bad({ from: '2026-02-30' }); // a date that does not exist
  bad({ from: 'yesterday' });
  assert.deepEqual(resolvePeriod({ from: '2026-01-01', to: '2026-12-31' }, NOW).days, 365);
  assert.equal(resolvePeriod({}, NOW).days, 30);
  assert.equal(resolvePeriod({}, NOW).weeks, 4);
  assert.equal(resolvePeriod({}, NOW).to, NOW);
  assert.equal(resolvePeriod({ days: 7 }, NOW).from, NOW - 7 * 86_400_000);
});

test('AC-5: a daylight saving change does not move a whole-date period out of its limits', () => {
  const before = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const p = resolvePeriod({ from: '2026-03-01', to: '2026-03-31' }, NOW); // the clocks change on 8 March
    assert.equal(p.days, 31);
    assert.equal(new Date(p.from).getHours(), 0);
    assert.equal(new Date(p.to).getHours(), 0);
  } finally {
    process.env.TZ = before;
  }
});

test('AC-5: the flags are parsed strictly', () => {
  assert.deepEqual(parseDeliveryArgs(['--days', '7', '--weeks', '2', '--json']), { options: { days: 7, weeks: 2 }, json: true });
  assert.deepEqual(parseDeliveryArgs(['--from', '2026-09-01', '--to', '2026-09-30']), { options: { from: '2026-09-01', to: '2026-09-30' }, json: false });
  for (const argv of [['--days'], ['--days', '7', '--days', '8'], ['--days', 'x'], ['--days', '1.5'], ['--days', '-3'], ['--weeks', '+2'], ['--nope', '1'], ['stray'], ['--json', '--json'], ['--from', '--json']]) {
    assert.throws(() => parseDeliveryArgs(argv), PeriodError, JSON.stringify(argv));
  }
});

test('AC-6: work in progress lists the open jobs oldest first, with what each waits for', () => {
  const { wip } = deliveryMetrics(wipRoot(), { now: NOW });
  assert.equal(wip.count, 3);
  assert.deepEqual(wip.items.map((i) => i.id), ['303-held', '301-human', '302-build']);
  const by = Object.fromEntries(wip.items.map((i) => [i.issue, i]));
  assert.deepEqual(Object.keys(by[301]), ['id', 'issue', 'title', 'stage', 'risk', 'size', 'age_minutes', 'waiting', 'base_wait']);
  assert.equal(by[301].age_minutes, 360);
  assert.deepEqual(by[301].waiting, { kind: 'decide', updated: '2026-10-02T09:00:00.000Z' });
  assert.equal(by[301].base_wait, null);
  assert.equal(by[302].age_minutes, 60);
  assert.equal(by[302].waiting, null);
  assert.equal(by[303].age_minutes, 1440);
  assert.deepEqual(by[303].waiting, { kind: 'fix-base', updated: '2026-10-02T10:30:00.000Z' });
  assert.deepEqual(by[303].base_wait, { since: '2026-10-02T10:00:00.000Z', fix_issue: 77 });
  assert.deepEqual([by[303].stage, by[303].risk, by[303].size, by[303].title], ['gate', 'medium', 'm', 'Held at the gate']);
});

test('AC-6: a job without a valid started has a null age and goes last', () => {
  const root = wipRoot();
  addJob(root, '306-nostart', { issue: 306, title: 'No start', stage: 'build', updated: '2026-10-02T11:30:00.000Z' });
  const { wip, period } = deliveryMetrics(root, { now: NOW });
  assert.equal(wip.items.at(-1).id, '306-nostart');
  assert.equal(wip.items.at(-1).age_minutes, null);
  assert.equal(period.data_starts, '2026-10-01T08:00:00.000Z');
});

test('AC-8: the tool answers exactly what the command computes', () => {
  const root = septemberRoot();
  const tool = factoryTools({ root, now: () => NOW }).find((t) => t.name === 'delivery_metrics');
  assert.ok(tool);
  const got = tool.run({ days: 7, weeks: 2 });
  assert.deepStrictEqual(got, deliveryMetrics(root, { days: 7, weeks: 2, now: NOW }));
  assert.equal(got.source, 'local');
  assert.equal(got.read_at, new Date(NOW).toISOString());
  assert.ok(!('summary' in got));
  assert.deepEqual(tool.validate({ days: 7, from: '2026-09-01' }), []); // the schema allows it; the answer refuses it
  assert.throws(() => tool.run({ days: 7, from: '2026-09-01' }), ToolError);
  assert.ok(tool.validate({ days: 400 }).length > 0);
  assert.ok(tool.validate({ weeks: 13 }).length > 0);
  assert.ok(tool.validate({ path: '/etc' }).length > 0);
  assert.equal(tool.annotations.readOnlyHint, true);
});
