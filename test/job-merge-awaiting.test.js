// Job 014: auto_merge flag, approve>merged and awaiting-merge transitions. Same fake-gh
// harness as test/job.test.js (shared setup in the helpers/ file imported below).
// Part of the job-merge scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, ok, refused, noMerge, approved, awaiting } from './helpers/job-merge-harness.js';

describe('job 014: auto_merge and awaiting-merge', { concurrency: true }, () => {
  test('AC-3: auto_merge false and a failing post-sync gate ends in needs-human with no comment and no merge', async () => {
    const t = setup({ autoMerge: false });
    const id = await approved(t, ['BROKEN', 'main broke the build\n']);
    assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} needs-human`);
    const job = t.json(id);
    assert.equal(job.stage, 'needs-human');
    assert.equal(job.parked_from, 'merging');
    assert.match(job.note, /check/i);
    assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
    assert.ok(noMerge(t));
    assert.ok(!t.calls().some((c) => /ready for review|reviewer should/i.test(c.body ?? '')), 'no ready-for-review comment');
  });

  test('AC-4: awaiting-merge refuses while the PR is open, then finishes once it is merged', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    const before = t.raw(id);
    const res = await t.job(id, 'to', 'merged');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /refused:/);
    assert.match(res.stderr, /still waiting/);
    assert.equal(t.raw(id), before);
    t.setPr(31, { state: 'MERGED' });
    assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
    const job = t.json(id);
    assert.ok(Date.parse(job.finished));
    assert.match(job.note, /merged outside the factory/);
    assert.ok(!existsSync(job.worktree), 'worktree removed');
    assert.ok(noMerge(t));
  });

  test('AC-5: approve to merged needs a merged PR and never calls pr merge', async () => {
    const t = setup({ autoMerge: false });
    const id = await approved(t);
    await refused(t, id, 'to', 'merged');
    t.setPr(31, { state: 'MERGED' });
    assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
    assert.match(t.json(id).note, /merged outside the factory/);
    assert.ok(noMerge(t));
  });

  test('AC-5: approve to merged is refused when the job has no PR', async () => {
    const t = setup();
    const id = await approved(t);
    const file = join(t.root, 'factory/jobs', id, 'job.json');
    const job = JSON.parse(readFileSync(file, 'utf8'));
    job.pr = null;
    writeFileSync(file, JSON.stringify(job, null, 2));
    t.setPr(31, { state: 'MERGED' });
    await refused(t, id, 'to', 'merged');
  });

  test('AC-6: awaiting-merge escalates to needs-human only with a note', async () => {
    const t = setup({ autoMerge: false });
    const id = await awaiting(t);
    await refused(t, id, 'to', 'needs-human');
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'PR closed'));
    const job = t.json(id);
    assert.equal(job.stage, 'needs-human');
    assert.equal(job.parked_from, 'awaiting-merge');
    assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
    t.setPr(31, { state: 'MERGED' });
    assert.equal(ok(t, await t.job(id, 'to', 'merged')), `${id} merged`);
  });
});
