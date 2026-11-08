// Job 015: a human rejecting the PR (changes requested, closed). Same fake-gh
// harness as test/job-merge.test.js (setup in test/helpers/job-pr-rejection-harness.js).
// Part of the job-pr-rejection scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repo, setup, ok, refused, noMerge, approved, awaiting, review, has } from './helpers/job-pr-rejection-harness.js';

describe('job 015: human rejects the PR', { concurrency: true }, () => {
  test('AC-2: a dismissed review clears an earlier changes-requested one', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    t.setPr(31, {
      reviews: [
        review('bob', 'CHANGES_REQUESTED', 'MEMBER', 'no', '2026-01-01T00:00:00Z'),
        review('bob', 'DISMISSED', 'MEMBER', '', '2026-01-02T00:00:00Z'),
      ],
    });
    await refused(t, id, 'to', 'needs-human');
  });

  for (const stage of ['awaiting-merge', 'approve', 'needs-human']) {
    test(`AC-3: a closed PR ends a ${stage} job as rejected`, async () => {
      const t = setup({ autoMerge: false });
      const id = stage === 'approve' ? await approved(t) : await awaiting(t);
      if (stage === 'needs-human') ok(t, await t.job(id, 'to', 'needs-human', '--note', 'stuck'));
      t.setPr(31, { state: 'CLOSED' });
      const before = t.calls().length;
      assert.equal(ok(t, await t.job(id, 'to', 'rejected')), `${id} rejected`);
      const job = t.json(id);
      assert.equal(job.stage, 'rejected');
      assert.ok(Date.parse(job.finished));
      assert.equal(job.note, 'PR #31 closed without merging');
      assert.ok(!existsSync(job.worktree), 'worktree removed');
      const comments = t.calls().slice(before).filter(({ args }) => args.slice(0, 2).join(' ') === 'issue comment');
      assert.equal(comments.length, 1);
      assert.ok(comments[0].args.includes('--body-file'));
      assert.ok(comments[0].body.startsWith(`<!-- factory:note ${id} -->`));
      assert.ok(noMerge(t));
    });
  }

  test('AC-4: an open PR is not rejected; merged still waits', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    const before = t.calls().length;
    await refused(t, id, 'to', 'rejected');
    assert.ok(!has(t, before, 'issue comment'));
    const res = await t.job(id, 'to', 'merged');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /still waiting/);
  });

  test('AC-5: a merged PR is not rejected but still finishes as merged', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    t.setPr(31, { state: 'MERGED' });
    await refused(t, id, 'to', 'rejected');
    assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
  });

  test('AC-5: needs-human without a PR is refused before any pr view', async () => {
    const t = setup();
    t.issue(7, { title: 'No pr' });
    const id = ok(t, await t.job('new', '7'));
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'stuck'));
    const before = t.calls().length;
    await refused(t, id, 'to', 'rejected');
    assert.ok(!has(t, before, 'pr view'));
  });

  test('AC-6: a noted park, and a no-note park from intake, behave as before', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    t.setPr(31, { reviews: [review('bob', 'CHANGES_REQUESTED', 'OWNER')] });
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'my reason'));
    assert.equal(t.json(id).note, 'my reason');
    const t2 = setup();
    t2.issue(8, { title: 'Intake' });
    const id2 = ok(t2, await t2.job('new', '8'));
    await refused(t2, id2, 'to', 'needs-human');
  });

  test('AC-7: SKILL.md describes the new parked-jobs order', () => {
    const skill = readFileSync(join(repo, '.claude/skills/eminzo-factory/SKILL.md'), 'utf8');
    const run = skill.slice(skill.indexOf('## /eminzo-factory run'), skill.indexOf('## Spawning agents'));
    assert.match(run, /to rejected/);
    assert.match(run, /to needs-human/);
    assert.match(run, /Request changes/);
    const rework = skill.slice(skill.indexOf('- `/eminzo-factory rework'), skill.indexOf('## Preflight'));
    assert.match(rework, /changes requested/);
  });
});
