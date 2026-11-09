// Job 015: a human rejecting the PR (changes requested, closed). Same fake-gh
// harness as test/job-merge.test.js (setup in test/helpers/job-pr-rejection-harness.js).
// Part of the job-pr-rejection scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ok, refused, noMerge, approved, awaiting, review, names } from './helpers/job-pr-rejection-harness.js';

describe('job 015: human rejects the PR', { concurrency: true }, () => {
  for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    test(`AC-1: a ${assoc} changes-requested review parks awaiting-merge in needs-human`, async () => {
      const t = setup({ autoMerge: false });
      const id = await awaiting(t);
      t.setPr(31, { reviews: [review('bob', 'CHANGES_REQUESTED', assoc, 'Rename the flag.')] });
      const before = t.calls().length;
      assert.equal(ok(t, await t.job(id, 'to', 'needs-human')), `${id} needs-human`);
      const job = t.json(id);
      assert.equal(job.parked_from, 'awaiting-merge');
      assert.equal(job.note, 'changes requested on PR #31');
      assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
      const calls = t.calls().slice(before);
      for (const name of ['issue comment', 'pr comment']) {
        const call = calls.find(({ args }) => args.slice(0, 2).join(' ') === name);
        assert.ok(call && call.args.includes('--body-file'), `${name} via --body-file`);
      }
      assert.ok(noMerge(t));
      ok(t, await t.job(id, 'to', 'build'));
      assert.match(t.read(id, `round-${t.json(id).round - 1}/review-human.md`), /Rename the flag\./);
    });
  }

  test('AC-1: the same no-note command parks an approve job', async () => {
    const t = setup({ autoMerge: false });
    const id = await approved(t);
    t.setPr(31, { reviews: [review('bob', 'CHANGES_REQUESTED', 'OWNER')] });
    assert.equal(ok(t, await t.job(id, 'to', 'needs-human')), `${id} needs-human`);
    const job = t.json(id);
    assert.equal(job.parked_from, 'approve');
    assert.equal(job.note, 'changes requested on PR #31');
  });

  test('AC-2: untrusted or superseded changes-requested reviews are refused', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    const before = t.calls().length;
    t.setPr(31, {
      reviews: [
        review('a', 'CHANGES_REQUESTED', 'CONTRIBUTOR'),
        review('b', 'CHANGES_REQUESTED', 'NONE'),
        review('c', 'CHANGES_REQUESTED', 'FIRST_TIME_CONTRIBUTOR'),
      ],
    });
    await refused(t, id, 'to', 'needs-human');
    t.setPr(31, {
      reviews: [
        review('bob', 'CHANGES_REQUESTED', 'OWNER', 'no', '2026-01-01T00:00:00Z'),
        review('bob', 'APPROVED', 'OWNER', 'ok', '2026-01-02T00:00:00Z'),
      ],
    });
    await refused(t, id, 'to', 'needs-human');
    t.setPr(31, {
      reviews: [
        review('bob', 'CHANGES_REQUESTED', 'OWNER', 'no', '2026-01-01T00:00:00Z'),
        review('bob', 'COMMENTED', 'OWNER', 'hm', '2026-01-02T00:00:00Z'),
      ],
    });
    // A COMMENTED review does not clear the earlier CHANGES_REQUESTED, so this one parks.
    assert.equal(ok(t, await t.job(id, 'to', 'needs-human')), `${id} needs-human`);
    const names2 = names(t, before);
    assert.ok(names2.includes('pr ready'), 'commented review does not clear the stance');
  });
});
