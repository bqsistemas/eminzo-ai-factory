// Job 014: auto_merge flag, approve>merged and awaiting-merge transitions. Same fake-gh
// harness as test/job.test.js (shared setup in the helpers/ file imported below).
// Part of the job-merge scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { git, setup, ok, noMerge, approved, awaiting } from './helpers/job-merge-harness.js';

describe('job 014: auto_merge and awaiting-merge', { concurrency: true }, () => {
  for (const value of [false, 'false']) {
    test(`AC-1: auto_merge ${JSON.stringify(value)} readies the PR, comments, and parks in awaiting-merge`, async () => {
      const t = setup({ autoMerge: value });
      const id = await approved(t);
      const before = t.calls().length;
      assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} awaiting-merge`);
      const job = t.json(id);
      assert.equal(job.stage, 'awaiting-merge');
      assert.equal(job.finished, null);
      assert.match(job.note, /PR #31/);
      assert.ok(existsSync(job.worktree), 'worktree kept');
      assert.equal(git(t.origin, 'show', `factory/${id}:main.txt`), 'main', 'origin/main merged into the branch');
      assert.equal(t.read(id, 'merge-checks.md').split('\n')[0], 'GATE: PASS');
      const calls = t.calls().slice(before);
      const names = calls.map(({ args }) => args.slice(0, 3).join(' '));
      const ready = names.indexOf('pr ready 31');
      const comment = names.findIndex((n) => n === 'pr comment 31');
      assert.ok(ready >= 0 && comment > ready, 'pr ready, then pr comment');
      assert.ok(calls[comment].args.includes('--body-file'));
      assert.ok(calls[comment].body.startsWith(`<!-- factory:note ${id} -->`), 'rework ignores it');
      assert.match(calls[comment].body, /auto_merge/);
      assert.ok(noMerge(t), 'pr merge never called');
      assert.equal(t.board().jobs.find((j) => j.id === id).stage, 'awaiting-merge');
    });
  }

  for (const [label, autoMerge] of [['missing', undefined], ['true', true]]) {
    test(`AC-2: auto_merge ${label} still merges exactly the pushed commit`, async () => {
      const t = setup({ autoMerge });
      const id = await approved(t);
      const before = t.calls().length;
      assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} merged`);
      const calls = t.calls().slice(before).map(({ args }) => args);
      const ready = calls.findIndex((a) => a[0] === 'pr' && a[1] === 'ready');
      const merge = calls.findIndex((a) => a[0] === 'pr' && a[1] === 'merge');
      assert.ok(ready >= 0 && merge > ready);
      const pushed = git(t.origin, 'rev-parse', `factory/${id}`);
      assert.deepEqual(calls[merge], ['pr', 'merge', '31', '--merge', '--match-head-commit', pushed]);
    });
  }

  for (const value of [0, null, 'no']) {
    test(`AC-1: auto_merge ${JSON.stringify(value)} is treated as off`, async () => {
      const t = setup({ autoMerge: value });
      const id = await approved(t);
      assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} awaiting-merge`);
      assert.ok(noMerge(t));
    });
  }
});
