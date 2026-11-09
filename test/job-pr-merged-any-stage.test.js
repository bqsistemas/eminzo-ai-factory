// Job 018: close a job whose PR a human merged or closed at any stage. Fake-gh harness as test/job-merge.test.js (setup in test/helpers/job-pr-merged-harness.js).
// Part of the job-pr-merged-any-stage scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { setup, ok, refused, INTAKE, noMerge, has, jobAt } from './helpers/job-pr-merged-harness.js';

describe('job 018: close a job at any stage', { concurrency: true }, () => {
  for (const stage of ['build', 'gate', 'review']) {
    test(`AC-1: ${stage} to merged finishes the job when the PR is merged`, async () => {
      const t = setup();
      const id = await jobAt(t, stage);
      t.setPr(31, { state: 'MERGED' });
      assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
      const job = t.json(id);
      assert.ok(Date.parse(job.finished));
      assert.equal(job.note, `PR #31 merged outside the factory during ${stage}`);
      assert.ok(!existsSync(job.worktree), 'worktree removed');
      assert.ok(noMerge(t));
    });
  }

  for (const stage of ['approve', 'awaiting-merge', 'needs-human']) {
    test(`AC-2: ${stage} to merged names the stage in the note`, async () => {
      const t = setup();
      const id = await jobAt(t, stage);
      t.setPr(31, { state: 'MERGED' });
      assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
      assert.equal(t.json(id).note, `PR #31 merged outside the factory during ${stage}`);
    });
  }

  for (const stage of ['build', 'gate', 'review']) {
    test(`AC-3: ${stage} to merged is refused while the PR is open`, async () => {
      const t = setup();
      const id = await jobAt(t, stage);
      const before = t.raw(id);
      const res = await t.job(id, 'to', 'merged');
      assert.equal(res.status, 1);
      assert.match(res.stderr, /refused:/);
      assert.match(res.stderr, /not MERGED/);
      assert.equal(t.raw(id), before);
    });
  }

  test('AC-3: a round-1 build job with no PR is refused without a pr view', async () => {
    const t = setup();
    t.issue(7);
    const id = ok(t, await t.job('new', '7'));
    t.write(id, 'intake.md', INTAKE('ACCEPT'));
    ok(t, await t.job(id, 'to', 'spec'));
    t.write(id, 'spec.md', '# Spec\n');
    ok(t, await t.job(id, 'to', 'build'));
    const before = t.calls().length;
    const res = await t.job(id, 'to', 'merged');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /the job has no PR/);
    assert.ok(!t.calls().slice(before).some(({ args }) => args[0] === 'pr' && args[1] === 'view'));
  });
});
