// A red base never blames a job. When a job's gate fails and origin/main fails the same checks, the job is held at
// the gate (no new stage, no round spent, no builder) until the base is fixed; one fix issue is found or created.
// Only a real FAIL holds a job: an UNKNOWN answer or a passing base sends the job back to the builder as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { gateToApprove, git, ok, redBase, refused, toGate } from './helpers/red-base-harness.js';

const { waitingOnPeople } = await import('../factory/lib/state/queries.js');
const { jobView } = await import('../factory/lib/state/jobs.js');

test('main is broken: the gate failure waits at gate, spends no round, and one fix issue is created', async () => {
  const t = redBase();
  const id = await t.gated();
  assert.equal(readFileSync(join(t.root, 'factory/jobs', id, 'round-1/checks.md'), 'utf8').split('\n')[0], 'GATE: FAIL');
  const res = await t.base(id);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'wait: main is broken (#1)');
  const job = t.json(id);
  assert.equal(job.stage, 'gate');
  assert.equal(job.round, 1);
  assert.equal(job.note, 'main is broken: waiting for #1');
  assert.equal(job.base_wait.fix_issue, 1);
  assert.equal(job.base_wait.sha, git(t.root, 'rev-parse', 'origin/main'));
  assert.match(job.base_wait.since, /^\d{4}-/);
  assert.equal(t.fake.creates().length, 1);
  assert.equal(t.baseRuns(), 2, 'the first FAIL of a tip is confirmed by a second, fresh run');
  assert.equal(t.board().jobs.find((j) => j.id === id).base_wait.fix_issue, 1);
});

test('to build is refused while the job waits, and job.json is untouched', async () => {
  const t = redBase();
  const id = await t.gated();
  await t.base(id);
  await refused(t, id, 'to', 'build');
  assert.match((await t.job(id, 'to', 'build')).stderr, /waiting for #1/);
});

test('the same tip again: nothing runs and no second issue is created', async () => {
  const t = redBase();
  const id = await t.gated();
  await t.base(id);
  const before = t.raw(id);
  const res = await t.base(id);
  assert.equal(res.stdout.trim(), 'wait: main is broken (#1)');
  assert.equal(t.baseRuns(), 2);
  assert.equal(t.fake.creates().length, 1);
  assert.equal(t.raw(id), before, 'a re-check of the same tip changes nothing');
});

test('main passes at the job\'s own base: own failure, and to build is accepted', async () => {
  const t = redBase({ broken: false });
  const id = await t.gated();
  t.commit(id, { BROKEN: 'mine\n' });
  assert.equal((await t.gate(id)).status, 1);
  const res = await t.base(id);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout.trim(), /^own: origin\/main passes the same checks at [0-9a-f]{12}$/);
  assert.equal(t.json(id).base_wait, undefined);
  assert.equal(t.json(id).base_check.verdict, 'own');
  assert.equal(t.fake.creates().length, 0);
  assert.equal(ok(t, await t.job(id, 'to', 'build')), `${id} build`);
  assert.equal(t.json(id).round, 2);
});

test('a real gate report whose base question was never asked: to build is refused and names the command', async () => {
  const t = redBase({ broken: false });
  const id = await t.gated();
  t.commit(id, { BROKEN: 'mine\n' });
  await t.gate(id);
  await refused(t, id, 'to', 'build');
  assert.match((await t.job(id, 'to', 'build')).stderr, /job .* base/);
  // A report written by hand (no Tested head) is not a real gate and keeps working.
  t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
  assert.equal(ok(t, await t.job(id, 'to', 'build')), `${id} build`);
});

test('a factory:base-fix job is exempt: own with no run, and it is never held', async () => {
  const t = redBase();
  const id = await t.gated(8, { labels: ['factory', 'factory:base-fix'] });
  assert.equal(t.json(id).base_fix, true);
  assert.match(t.read(id, 'issue.md'), /^Base fix: yes \(the factory:base-fix label/m);
  const res = await t.base(id);
  assert.equal(res.stdout.trim(), 'own: this job fixes main (factory:base-fix)');
  assert.equal(t.baseRuns(), 0);
  assert.equal(t.json(id).base_wait, undefined);
  assert.equal(ok(t, await t.job(id, 'to', 'build')), `${id} build`);
});

test('a base that could not be checked never holds: own, and the reason is shown', async () => {
  const t = redBase({ prepare: 'exit 9' });
  const id = await t.gated();
  const res = await t.base(id);
  assert.equal(res.status, 0);
  assert.match(res.stdout.trim(), /^own: could not check origin\/main: the prepare step failed \(exit 9\)$/);
  assert.equal(t.json(id).base_wait, undefined);
  assert.equal(t.fake.creates().length, 0);
  assert.equal(ok(t, await t.job(id, 'to', 'build')), `${id} build`);
});

test('the checks passed and the gate failed on something else: own, nothing runs', async () => {
  const t = redBase({ broken: false });
  const id = await t.gated();
  t.commit(id, { 'x.txt': 'x\n' });
  // An uncommitted file fails the gate while the checks pass.
  writeFileSync(join(t.json(id).worktree, 'dirty.txt'), 'd\n');
  assert.equal((await t.gate(id)).status, 1);
  const res = await t.base(id);
  assert.equal(res.stdout.trim(), 'own: the checks passed; the gate failed on uncommitted changes');
  assert.equal(t.baseRuns(), 0);
});

test('refused when the job is not at gate or its report is not GATE: FAIL', async () => {
  const t = redBase({ broken: false });
  const id = await t.gated();
  const pass = await t.base(id);
  assert.equal(pass.status, 1);
  assert.match(pass.stderr, /does not start with GATE: FAIL/);
  t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
  ok(t, await t.job(id, 'to', 'review'));
  const late = await t.base(id);
  assert.equal(late.status, 1);
  assert.match(late.stderr, /is not at gate/);
});

test('lane xs: promote is refused until base has answered, then the job is held', async () => {
  const t = redBase();
  const id = await t.gated();
  const job = t.json(id);
  t.write(id, 'job.json', `${JSON.stringify({ ...job, lane: 'xs' }, null, 2)}\n`);
  await refused(t, id, 'promote');
  assert.equal((await t.base(id)).stdout.trim(), 'wait: main is broken (#1)');
  await refused(t, id, 'promote');
  assert.equal(t.json(id).stage, 'gate');
});

test('the last round waits too: the hold does not need a free round', async () => {
  const t = redBase({ maxRounds: 1 });
  const id = await t.gated();
  assert.equal(t.json(id).max_rounds, 1);
  assert.equal((await t.base(id)).stdout.trim(), 'wait: main is broken (#1)');
  assert.equal(t.json(id).stage, 'gate');
});

test('the PR is merged while the job waits: to merged clears the wait', async () => {
  const t = redBase();
  const id = await t.gated();
  await t.base(id);
  t.setPr(37, { state: 'MERGED' });
  assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
  const job = t.json(id);
  assert.equal(job.base_wait, undefined);
  assert.equal(job.base_waits.length, 1);
  assert.equal(job.base_waits[0].fix_issue, 1);
});

test('gh cannot create the issue: the job still waits, and the note says how to create it', async () => {
  const t = redBase({ issues: { failCreate: 'label not found' } });
  const id = await t.gated();
  const res = await t.base(id);
  assert.match(res.stdout.trim(), /^wait: main is broken \(no fix issue yet\)$/);
  const job = t.json(id);
  assert.equal(job.stage, 'gate');
  assert.equal(job.base_wait.fix_issue, null);
  assert.match(job.note, /^main is broken: no fix issue \(.*label not found.*\); run .*base.* fix-issue/);
  await refused(t, id, 'to', 'build');
});

test('Ask Eminzo and the summary show the job as waiting for the base, with the issue', async () => {
  const t = redBase();
  const id = await t.gated();
  await t.base(id);
  const view = jobView(t.json(id));
  assert.equal(view.waiting.kind, 'fix-base');
  assert.match(view.waiting.reason, /waiting for #1/);
  const waiting = waitingOnPeople(t.root);
  assert.equal(waiting.items[0].kind, 'fix-base');
  assert.equal(waiting.items[0].fix_issue, 1);
  const summary = (await t.job('summary')).stdout;
  assert.match(summary, new RegExp(`${id}\\s+#7\\s+gate \\(waits for main, #1\\)`));
  const graph = JSON.parse((await t.job('graph')).stdout);
  assert.ok(!graph.stages.some((s) => /base/.test(s.id)), 'no new stage');
});

// --- resume: the base passes again --------------------------------------------------------------------------

test('the fix reaches main: the base is merged into the branch and pushed, the gate re-runs and passes, and the job goes to review', async () => {
  const t = redBase();
  const id = await t.gated();
  await t.base(id);
  const fixed = t.pushMain({ BROKEN: null }, 'fix: repair main');
  const res = await t.base(id);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'resumed: GATE: PASS');
  const job = t.json(id);
  assert.equal(job.stage, 'gate');
  assert.equal(job.base_wait, undefined);
  assert.equal(job.base_waits.length, 1);
  assert.equal(job.base_waits[0].fix_issue, 1);
  assert.equal(job.note, '');
  assert.equal(job.gate, 'PASS');
  assert.equal(t.read(id, 'round-1/checks.md').split('\n')[0], 'GATE: PASS');
  assert.equal(git(job.worktree, 'merge-base', '--is-ancestor', fixed, 'HEAD') === '', true, 'the base is in the branch');
  assert.equal(git(t.origin, 'rev-parse', `factory/${id}`), git(job.worktree, 'rev-parse', 'HEAD'), 'the branch was pushed');
  assert.equal(git(t.origin, 'rev-parse', 'main'), fixed, 'the base branch is never pushed to');
  assert.equal(ok(t, await t.job(id, 'to', 'review')), `${id} review`);
});

test('the fix reaches main but the job has its own failure: resumed: GATE: FAIL, and to build is accepted', async () => {
  const t = redBase();
  const id = await t.gated();
  t.commit(id, { MINE: 'mine\n' });
  await t.gate(id);
  await t.base(id);
  t.pushMain({ BROKEN: null });
  const res = await t.base(id);
  assert.equal(res.stdout.trim(), 'resumed: GATE: FAIL');
  assert.equal(t.json(id).base_wait, undefined);
  assert.equal(t.json(id).base_check.verdict, 'own');
  assert.equal(t.read(id, 'round-1/checks.md').split('\n')[0], 'GATE: FAIL');
  assert.match((await t.base(id)).stdout, /^own: /, 'asking again repeats the answer');
  assert.equal(ok(t, await t.job(id, 'to', 'build')), `${id} build`);
  assert.equal(t.json(id).round, 2);
});

test('the fix conflicts with the job: no auto-resolve, the job goes to needs-human and the merge is aborted', async () => {
  const t = redBase();
  const id = await t.gated();
  t.commit(id, { 'app.txt': 'job version\n' });
  await t.gate(id);
  await t.base(id);
  t.pushMain({ BROKEN: null, 'app.txt': 'main version\n' });
  const res = await t.base(id);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout.trim(), /^needs-human: merge stopped at sync with origin\/main: git merge conflicts/);
  const job = t.json(id);
  assert.equal(job.stage, 'needs-human');
  assert.equal(job.base_wait, undefined);
  assert.equal(git(job.worktree, 'status', '--porcelain'), '', 'the merge was aborted');
  assert.ok(t.calls().some(({ args }) => args[0] === 'issue' && args[1] === 'edit' && args.includes('factory:needs-human')));
});

test('a job.json that points the worktree anywhere else is refused: nothing is merged or pushed', async () => {
  const t = redBase();
  const id = await t.gated();
  await t.base(id);
  t.pushMain({ BROKEN: null });
  const before = git(t.root, 'rev-parse', 'HEAD');
  const job = t.json(id);
  t.write(id, 'job.json', `${JSON.stringify({ ...job, worktree: t.root }, null, 2)}\n`);
  const res = await t.base(id);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^refused: .*worktree/m);
  assert.equal(git(t.root, 'rev-parse', 'HEAD'), before);
});

test('the merge finds the base red: it stops at the post-sync checks and names the broken base and its issue', async () => {
  const t = redBase({ broken: false });
  t.issue(7, { title: 'Merge me' });
  const id = ok(t, await t.job('new', '7'));
  await toGate(t, id);
  t.commit(id, { 'feature.txt': 'f\n' });
  await gateToApprove(t, id);
  t.write(id, 'decision.md', 'APPROVE\nAll good.\n');
  t.pushMain({ BROKEN: 'x\n' }, 'feat: someone broke main');
  const res = await t.job(id, 'to', 'merging');
  assert.equal(res.status, 0, res.stderr);
  const job = t.json(id);
  assert.equal(job.stage, 'needs-human');
  assert.match(job.note, /merge stopped at post-sync checks: main is broken \(#1\); see merge-checks\.md/);
  assert.equal(t.fake.creates().length, 1);
});

// --- review fixes: when a job is merged, held or released --------------------------------------------------------

test('a job that was never held and failed on its own code gets no merge, no push and no re-gate when main is green and ahead', async () => {
  const t = redBase({ broken: false });
  const id = await t.gated();
  t.commit(id, { MINE: 'mine\n' });
  await t.gate(id);
  t.pushMain({ 'other.txt': 'main moved on\n' }, 'feat: main moves');
  const branchBefore = git(t.json(id).worktree, 'rev-parse', 'HEAD');
  const res = await t.base(id);
  assert.match(res.stdout.trim(), /^own: /);
  assert.equal(git(t.json(id).worktree, 'rev-parse', 'HEAD'), branchBefore, 'nothing was merged');
  assert.throws(() => git(t.origin, 'rev-parse', '--verify', '--quiet', `factory/${id}`), 'nothing was pushed');
  assert.equal(t.read(id, 'round-1/checks.md').split('\n')[0], 'GATE: FAIL');
  assert.equal(ok(t, await t.job(id, 'to', 'build')), `${id} build`);
});

test('a held job whose re-check cannot run stays held and tries again on the next run', async () => {
  const t = redBase();
  const id = await t.gated();
  await t.base(id);
  const held = t.json(id).base_wait;
  t.pushMain({ 'factory/config.json': JSON.stringify({ ...JSON.parse(readFileSync(join(t.root, 'factory/config.json'), 'utf8')), checks: { prepare: 'exit 9' } }) }, 'chore: broken prepare');
  const res = await t.base(id);
  assert.match(res.stdout.trim(), /^wait: main is broken \(#1\)$/);
  const job = t.json(id);
  assert.equal(job.stage, 'gate');
  assert.equal(job.base_wait.since, held.since);
  assert.equal(job.base_waits, undefined, 'the wait did not end');
  assert.equal(t.fake.creates().length, 1);
});

test('a held job whose base is still red at a new tip refreshes the sha and creates no second issue', async () => {
  const t = redBase();
  const id = await t.gated();
  await t.base(id);
  const tip = t.pushMain({ 'other.txt': 'x\n' }, 'chore: another commit, still red');
  const res = await t.base(id);
  assert.equal(res.stdout.trim(), 'wait: main is broken (#1)');
  assert.equal(t.json(id).base_wait.sha, tip);
  assert.equal(t.fake.creates().length, 1);
  assert.equal(t.baseRuns(), 4, 'a new tip is confirmed too');
});

test('--fresh on a held job runs the check again', async () => {
  const t = redBase();
  const id = await t.gated();
  await t.base(id);
  assert.equal(t.baseRuns(), 2);
  const res = await t.base(id, '--fresh');
  assert.equal(res.stdout.trim(), 'wait: main is broken (#1)');
  assert.equal(t.baseRuns(), 3);
});

test('needs-human and rework from a held job end the wait and keep it in base_waits', async () => {
  const t = redBase();
  const id = await t.gated();
  await t.base(id);
  assert.equal(ok(t, await t.job(id, 'to', 'needs-human', '--note', 'a person looked')), `${id} needs-human`);
  let job = t.json(id);
  assert.equal(job.base_wait, undefined);
  assert.equal(job.base_waits.length, 1);
  t.setPr(37, { reviews: [], comments: [] });
  ok(t, await t.job(id, 'to', 'build'));
  job = t.json(id);
  assert.equal(job.stage, 'build');
  assert.equal(job.base_wait, undefined);
});

test('when the resume escalates a job, its PR record is refreshed like any other transition', async () => {
  const t = redBase();
  const id = await t.gated();
  t.commit(id, { 'app.txt': 'job version\n' });
  await t.gate(id);
  await t.base(id);
  t.setPr(37, { body: 'Human text\n' });
  t.pushMain({ BROKEN: null, 'app.txt': 'main version\n' });
  const before = t.calls().length;
  assert.match((await t.base(id)).stdout, /^needs-human: /);
  assert.ok(t.calls().slice(before).some(({ args }) => args[0] === 'pr' && args[1] === 'edit'), 'the PR body gets its Factory record');
});

// --- review fixes: a flaky failure never holds a job or opens a public issue ----------------------------------------

const FLAKY = `#!/bin/sh
case "$PWD" in */.worktrees/.base) echo run >> "$FACTORY_ROOT/base-runs"; n=$(wc -l < "$FACTORY_ROOT/base-runs"); [ "$n" -le 1 ] && exit 1; exit 0 ;; esac
test ! -f BROKEN
`;

test('a failure that does not repeat holds nobody and opens no issue: the base is run again before the first hold', async () => {
  const t = redBase();
  const id = await t.gated();
  writeFileSync(join(t.root, 'factory/checks.sh'), FLAKY, { mode: 0o755 });
  const res = await t.base(id);
  assert.match(res.stdout.trim(), /^own: origin\/main passes the same checks at /);
  assert.equal(t.baseRuns(), 2);
  assert.equal(t.json(id).base_wait, undefined);
  assert.equal(t.fake.creates().length, 0);
});

test('a held job is checked again after an hour even when the tip did not move', async () => {
  const t = redBase();
  const id = await t.gated();
  await t.base(id);
  assert.equal(t.baseRuns(), 2);
  const job = t.json(id);
  job.base_wait.at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  t.write(id, 'job.json', `${JSON.stringify(job, null, 2)}\n`);
  const stateFile = join(t.root, 'factory/jobs/.base/state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  for (const rec of [state.full, ...Object.values(state.results)]) if (rec) rec.at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  writeFileSync(stateFile, JSON.stringify(state));
  assert.equal((await t.base(id)).stdout.trim(), 'wait: main is broken (#1)');
  assert.equal(t.baseRuns(), 3, 'one more run, and no confirmation: the tip is the one that was held');
  assert.equal(t.fake.creates().length, 1);
});

test('a failure that a second run already confirmed is not run again for the next job, and its timestamp is not rewritten', async () => {
  const t = redBase();
  const first = await t.gated(7);
  await t.base(first);
  assert.equal(t.baseRuns(), 2);
  const stateFile = join(t.root, 'factory/jobs/.base/state.json');
  const before = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(Object.values(before.results)[0].confirmed, true);
  const second = await t.gated(8);
  const res = await t.base(second);
  assert.equal(res.stdout.trim(), 'wait: main is broken (#1)');
  assert.equal(t.baseRuns(), 2, 'no run for the second job');
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).results, before.results, 'nothing rewritten');
  assert.equal(t.fake.creates().length, 1);
});

test('the overview counts a held job apart from the jobs that wait for a person', async () => {
  const { overview } = await import('../factory/lib/state/queries.js');
  const t = redBase();
  const id = await t.gated();
  await t.base(id);
  const o = overview(t.root);
  assert.match(o.summary, /0 jobs waiting for a person · 1 job waiting for the base branch to be fixed/);
  assert.equal(o.waiting_for_people, 0);
  assert.equal(o.waiting_for_base, 1);
});
