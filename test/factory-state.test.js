// The read-only state Ask Eminzo answers from: job views, job detail with round reasons, the six local queries
// and the GitHub queue. Every expected value below is worked out by hand from test/helpers/factory-state-fixture.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { factoryQueue } from '../factory/lib/state/github.js';
import { STAGE_GROUPS, findJob, jobView, readJobs, roundCauses, roundReason } from '../factory/lib/state/jobs.js';
import { changesSince, configView, jobByRef, listJobs, overview, periodSummary, waitingOnPeople } from '../factory/lib/state/queries.js';
import { QUEUE_ISSUES, stateFixture } from './helpers/factory-state-fixture.js';

const NOW = Date.parse('2026-11-12T15:00:00Z');
const ago = (hours) => new Date(NOW - hours * 3_600_000).toISOString();
const ids = (list) => list.map((j) => j.id);
const { root } = stateFixture({ now: NOW });

test('readJobs reads every job.json in id order and skips v1 folders and broken files', () => {
  assert.deepEqual(ids(readJobs(root)), ['150-old-merged', '155-escalated', '158-merged-recent', '161-question', '162-building', '163-review', '164-awaiting', '165-spec-review', '170-rejected']);
});

test('stage groups come from the pipeline graph', () => {
  assert.equal(STAGE_GROUPS.build, 'active');
  assert.equal(STAGE_GROUPS['awaiting-merge'], 'active');
  assert.equal(STAGE_GROUPS['needs-human'], 'parked');
  assert.equal(STAGE_GROUPS.merged, 'terminal');
});

test('jobView: where a job is, what it waits for, its times and its cost', () => {
  const jobs = readJobs(root);
  const escalated = jobView(findJob(jobs, '155'), NOW);
  assert.equal(escalated.group, 'parked');
  assert.deepEqual(escalated.waiting, { kind: 'decide', reason: 'the change widens who can approve suggestions', since: ago(3) });
  assert.deepEqual(escalated.minutes, { until_approval: 300, after_approval: null, total: 540 });
  assert.equal(escalated.cost_usd, 14.2);
  assert.equal(jobView(findJob(jobs, '163-review'), NOW).cost_usd, null, 'an unavailable cost is null, never 0');
  assert.equal(jobView(findJob(jobs, '#158'), NOW).lane, 'xs');
  assert.equal(jobView(findJob(jobs, '162'), NOW).waiting, null);
  assert.equal(findJob(jobs, '999'), null);
  assert.equal(findJob(jobs, '../etc'), null);
});

test('roundCauses names what made a round necessary as stable keys', () => {
  assert.deepEqual(roundCauses(null), []);
  assert.deepEqual(roundCauses({ gate: 'FAIL', reviews: { human: 'CHANGES', ui: { verdict: 'CHANGES' }, code: 'PASS' } }), ['gate', 'pr_comments', 'review:ui']);
  assert.deepEqual(roundCauses({ gate: 'PASS', reviews: {} }), []);
});

test('roundReason says what made a round necessary', () => {
  assert.equal(roundReason(null), null);
  assert.equal(roundReason({ gate: 'FAIL', reviews: {} }), 'gate failed');
  assert.equal(roundReason({ gate: 'PASS', reviews: { human: { verdict: 'CHANGES' } } }), 'changes requested on the pull request');
  assert.equal(roundReason({ gate: 'FAIL', reviews: { ui: 'CHANGES', code: 'PASS', security: 'CHANGES' } }), 'gate failed; changes requested by review: ui, security');
  assert.equal(roundReason({ gate: 'PASS', reviews: {} }), 'not recorded');
});

test('jobByRef: every round with why it ran, the gate, verdicts with blockers, the decision and cost per role', () => {
  const { summary, job } = jobByRef(root, '#155', { now: NOW });
  assert.equal(summary, 'Job 155-escalated (issue #155) waits for a person to decide, round 2 of 3.');
  assert.deepEqual(job.rounds, [
    { round: 1, reason: 'first build', gate: 'PASS', gate_summary: 'The checks passed in 2m 3s.', reviews: { code: { verdict: 'PASS', blockers: 0 }, security: { verdict: 'CHANGES', blockers: 2 } } },
    { round: 2, reason: 'changes requested by review: security', gate: 'PASS', gate_summary: 'The checks passed in 1m 50s.', reviews: { code: { verdict: 'PASS', blockers: 0 }, security: { verdict: 'PASS', blockers: 0 } } },
  ]);
  assert.equal(job.extra_rounds, 1);
  assert.deepEqual(job.approval, { decision: 'ESCALATE', reason: 'The change widens who can approve suggestions, a permission change: a person decides.' });
  assert.deepEqual(job.cost_by_role, { builder: 10.1, 'review-security': 2.05, 'spec-writer': 2.05 });
  assert.deepEqual(job.intake, { decision: 'ACCEPT', rescoped: false });
});

test('jobByRef: a round without files falls back to job.json, and the reasons chain through the rounds', () => {
  const { job } = jobByRef(root, '162-building', { now: NOW });
  assert.deepEqual(job.rounds.map((r) => [r.round, r.reason, r.gate]), [
    [1, 'first build', 'FAIL'],
    [2, 'gate failed', 'PASS'],
    [3, 'changes requested on the pull request', null],
  ]);
  assert.deepEqual(job.rounds[1].reviews, { human: { verdict: 'CHANGES', blockers: 0 } });
  assert.equal(jobByRef(root, '999', { now: NOW }), null);
  assert.equal(jobByRef(root, '150', { now: NOW }).summary, 'Job 150-old-merged (issue #150) finished as merged, round 1 of 3.');
  assert.equal(jobByRef(root, '162', { now: NOW }).summary, 'Job 162-building (issue #162) is in build, round 3 of 3.');
});

test('overview: running, waiting and finished counts and the last job that finished', () => {
  const o = overview(root, { now: NOW });
  assert.equal(o.summary, '2 jobs running, 4 jobs waiting for a person, 3 jobs finished (9 jobs on this machine).');
  assert.deepEqual(o.counts, { active: 3, parked: 3, terminal: 3 });
  assert.deepEqual(ids(o.running), ['162-building', '163-review']);
  assert.equal(o.waiting_for_people, 4);
  assert.equal(o.last_finished.id, '158-merged-recent');
  assert.equal(o.by_stage['needs-human'], 1);
});

test('listJobs filters by every field given, newest update first, and says when it cut the list', () => {
  assert.deepEqual(ids(listJobs(root, { risk: 'high', now: NOW }).jobs), ['155-escalated', '170-rejected']);
  const parked = listJobs(root, { group: 'parked', limit: 2, now: NOW });
  assert.equal(parked.total, 3);
  assert.deepEqual(ids(parked.jobs), ['155-escalated', '161-question']);
  assert.equal(parked.summary, '3 jobs match; the 2 most recently updated are listed.');
  assert.deepEqual(ids(listJobs(root, { since: ago(4), now: NOW }).jobs), ['162-building', '163-review', '158-merged-recent', '155-escalated']);
  assert.deepEqual(ids(listJobs(root, { lane: 'xs', stage: 'merged', now: NOW }).jobs), ['158-merged-recent']);
  assert.equal(listJobs(root, { size: 'xs', risk: 'high', now: NOW }).summary, '0 jobs match.');
});

test('waitingOnPeople: what each waiting job needs, oldest wait first', () => {
  const w = waitingOnPeople(root, { now: NOW });
  assert.deepEqual(w.items.map((i) => [i.id, i.kind, i.hours]), [
    ['165-spec-review', 'approve-spec', 50],
    ['161-question', 'answer', 30],
    ['164-awaiting', 'merge', 5],
    ['155-escalated', 'decide', 3],
  ]);
  assert.equal(w.items[1].reason, 'which roles see the filter?');
  assert.equal(w.summary, '4 jobs wait for a person: 1 to approve-spec, 1 to answer, 1 to merge, 1 to decide.');
});

test('changesSince: finished, newly waiting, started and moved, each job once', () => {
  const c = changesSince(root, { now: NOW });
  assert.equal(c.since, ago(24));
  assert.deepEqual(ids(c.finished), ['158-merged-recent']);
  assert.deepEqual(ids(c.waiting), ['155-escalated', '164-awaiting']);
  assert.deepEqual(ids(c.started), ['162-building', '163-review']);
  assert.deepEqual(ids(c.moved), []);
  assert.equal(c.summary, `Since ${ago(24)}: 1 job finished, 2 jobs started waiting for a person, 2 jobs started.`);
  assert.equal(changesSince(root, { since: new Date(NOW).toISOString(), now: NOW }).summary, `Nothing changed since ${new Date(NOW).toISOString()}.`);
});

test('periodSummary: the last 7 days by default, or any window', () => {
  const p = periodSummary(root, { now: NOW });
  assert.deepEqual(p.finished, { total: 3, merged: 2, rejected: 1 });
  assert.equal(p.started, 9);
  assert.deepEqual(p.rounds, { total: 3, extra: 0, one_round_jobs: 3 });
  assert.deepEqual(p.cost_usd, { known: 3.6, jobs_with_cost: 3, jobs_without_cost: 0 });
  assert.deepEqual(p.by_lane, { normal: { finished: 2, rounds: 2, cost_usd: 2.9 }, xs: { finished: 1, rounds: 1, cost_usd: 0.7 } });
  assert.match(p.summary, /2 jobs merged, 1 rejected, 0 escalated to a person; 3 rounds in total and \$3\.60 of known cost\./);
  const window = periodSummary(root, { from: ago(80), to: ago(1), now: NOW });
  assert.deepEqual(window.finished, { total: 2, merged: 1, rejected: 1 });
  assert.match(periodSummary(root, { from: ago(1), to: ago(0.5), now: NOW }).summary, /^No job finished/);
});

test('configView: the keys people ask about, the local overrides, and no prices', () => {
  const { config, summary } = configView(root);
  assert.deepEqual(config, {
    repo: 'https://github.com/acme/shop', base: 'origin/main', language: 'es', run_mode: 'own', concurrency: 2, max_rounds: 3,
    auto_merge: false, spec_review: ['high'], default_provider: 'claude', providers: ['claude', 'codex'], lanes: ['xs'],
    reviewers: { code: 'always', ui: 'surface: ui', security: 'surface: security' }, local_overrides: [],
  });
  assert.equal(summary, 'Up to 2 jobs at a time and 3 rounds per job; auto-merge off; reviewers: code, ui, security.');
  const { root: local } = stateFixture({ now: NOW });
  writeFileSync(join(local, 'factory/config.local.json'), JSON.stringify({ max_rounds: 2 }));
  assert.deepEqual(configView(local).config.local_overrides, ['max_rounds']);
  assert.equal(configView(local).config.max_rounds, 2);
});

test('factoryQueue: open factory issues no local job took, oldest first, titles made safe', () => {
  const calls = [];
  const runner = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: JSON.stringify(QUEUE_ISSUES) }; };
  const q = factoryQueue(root, { gh: 'gh', runner });
  assert.deepEqual(calls[0].slice(0, 7), ['gh', 'issue', 'list', '--label', 'factory', '--state', 'open']);
  assert.deepEqual(q.items.map((i) => i.issue), [180, 181]);
  assert.ok(!q.items[0].title.includes('<'), 'markup is stripped from titles');
  assert.deepEqual(q.items[0].labels, ['factory', 'factory:xs']);
  assert.equal(q.summary, '2 open factory issues not taken by a job on this machine.');
});

test('factoryQueue: gh failures become a message a person can act on', () => {
  assert.throws(() => factoryQueue(root, { runner: () => ({ status: 1, stderr: 'warning\ngh: To get started, run gh auth login\n' }) }), /could not read the queue from GitHub: gh: To get started, run gh auth login/);
  assert.throws(() => factoryQueue(root, { runner: () => ({ error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }) }), /the GitHub CLI \(gh\) is not installed/);
  assert.throws(() => factoryQueue(root, { runner: () => ({ status: 0, stdout: 'oops' }) }), /gh did not return JSON/);
});
