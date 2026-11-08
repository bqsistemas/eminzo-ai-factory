// Job 018: close a job whose PR a human merged or closed at any stage. Fake-gh harness as test/job-merge.test.js (setup in test/helpers/job-pr-merged-harness.js).
// Part of the job-pr-merged-any-stage scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repo, setup, ok, refused, jobAt, issueNotes } from './helpers/job-pr-merged-harness.js';

describe('job 018: close a job at any stage', { concurrency: true }, () => {
  for (const stage of ['build', 'gate', 'review']) {
    test(`AC-4: ${stage} to rejected needs a closed PR`, async () => {
      const t = setup();
      const id = await jobAt(t, stage);
      await refused(t, id, 'to', 'rejected');
      t.setPr(31, { state: 'MERGED' });
      await refused(t, id, 'to', 'rejected');
      t.setPr(31, { state: 'CLOSED' });
      assert.equal(ok(t, await t.job(id, 'to', 'rejected')), `${id} rejected`);
      const job = t.json(id);
      assert.equal(job.note, 'PR #31 closed without merging');
      assert.ok(!existsSync(job.worktree));
      const notes = issueNotes(t);
      assert.equal(notes.length, 1);
      assert.ok(notes[0].body.startsWith(`<!-- factory:note ${id} -->`));
    });
  }

  for (const state of ['MERGED', 'CLOSED']) {
    test(`AC-5: review to needs-human with a ${state} PR skips ready and comment`, async () => {
      const t = setup();
      const id = await jobAt(t, 'review');
      t.setPr(31, { state });
      const before = t.calls().length;
      ok(t, await t.job(id, 'to', 'needs-human', '--note', 'x'));
      const job = t.json(id);
      assert.equal(job.stage, 'needs-human');
      assert.equal(job.parked_from, 'review');
      assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
      assert.equal(issueNotes(t).length, 1);
      const names = t.calls().slice(before).map(({ args }) => args.slice(0, 2).join(' '));
      assert.ok(!names.includes('pr ready') && !names.includes('pr comment'));
    });
  }

  test('AC-5: review to needs-human with an open PR readies then comments', async () => {
    const t = setup();
    const id = await jobAt(t, 'review');
    const before = t.calls().length;
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'x'));
    const names = t.calls().slice(before).map(({ args }) => args.slice(0, 2).join(' '));
    assert.ok(names.indexOf('pr ready') >= 0 && names.indexOf('pr comment') > names.indexOf('pr ready'));
  });

  for (const state of ['MERGED', 'CLOSED']) {
    test(`AC-6: approve ESCALATE with a ${state} PR still parks without ready or comment`, async () => {
      const t = setup();
      const id = await jobAt(t, 'approve');
      t.write(id, 'decision.md', 'ESCALATE\nNeeds a person.\n');
      t.setPr(31, { state });
      const before = t.calls().length;
      ok(t, await t.job(id, 'to', 'needs-human'));
      const job = t.json(id);
      assert.equal(job.stage, 'needs-human');
      assert.equal(job.decision, 'ESCALATE');
      assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
      const names = t.calls().slice(before).map(({ args }) => args.slice(0, 2).join(' '));
      assert.ok(!names.includes('pr ready') && !names.includes('pr comment'));
    });
  }

  test('AC-7: review to needs-human parks when the PR lookup fails', async () => {
    const t = setup();
    const id = await jobAt(t, 'review');
    const s = t.state();
    s.prs = [];
    writeFileSync(join(t.dir, 'gh-state.json'), JSON.stringify(s));
    const before = t.calls().length;
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'x'));
    const job = t.json(id);
    assert.equal(job.stage, 'needs-human');
    assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
    assert.equal(issueNotes(t).length, 1);
    assert.ok(!t.calls().slice(before).some(({ args }) => args[0] === 'pr' && args[1] === 'ready'));
  });

  test('AC-8: SKILL.md /eminzo-factory run covers every stage and checks before spawning', () => {
    const text = readFileSync(join(repo, '.claude/skills/eminzo-factory/SKILL.md'), 'utf8');
    const section = text.split(/^## /m).find((s) => s.startsWith('/eminzo-factory run'));
    for (const stage of ['build', 'gate', 'review', 'approve', 'awaiting-merge', 'needs-human']) {
      assert.ok(section.includes(`\`${stage}\``), stage);
    }
    assert.match(section, /to merged/);
    assert.match(section, /to rejected/);
    assert.match(section, /before spawning/i);
  });
});
