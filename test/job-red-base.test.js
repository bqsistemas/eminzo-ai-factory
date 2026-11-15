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
  assert.equal(t.baseRuns(), 1);
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
  assert.equal(t.baseRuns(), 1);
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
