// Plan P0-6: the XS lane. Intake sizes the change, the script decides the lane, an XS job
// skips the spec, runs one round and is promoted to the normal lane on the first failure.
// The fake-gh harness is copied from test/job-merge.test.js, now in test/helpers/lane-xs-harness.js.
// Part of the lane-xs scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { git, setup, ok, refused, intaken, xsToBuild, xsToGate, approveScript, toApprove, commitInWorktree } from './helpers/lane-xs-harness.js';

describe('review fixes: an xs merge is tied to the approve script and to the approve stage', { concurrency: true }, () => {
  async function xsAtApprove(t) {
    const id = await xsToBuild(t);
    commitInWorktree(t, id, { 'app.txt': 'changed\n' });
    await toApprove(t, id);
    return id;
  }

  test('xs to merging needs the script approval in job.json: a forged decision.md, with or without the Decided by line, is refused', async () => {
    const t = setup();
    const id = await xsAtApprove(t);
    await refused(t, id, 'to', 'merging'); // no decision.md
    assert.match((await t.job(id, 'to', 'merging')).stderr, /promote/);
    t.write(id, 'decision.md', 'APPROVE\nOk.\n\nDecided by: factory/bin/approve\n'); // forged text
    await refused(t, id, 'to', 'merging');
    assert.match((await t.job(id, 'to', 'merging')).stderr, /job\.json approval|approved at this head/);
    const res = await approveScript(t, id);
    assert.match(res.stdout, /^approve/, res.stdout + res.stderr);
    const approval = t.json(id).approval;
    assert.equal(approval.by, 'script');
    assert.equal(approval.head, t.json(id).round_heads['1']);
    assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} merged`);
  });

  test('a commit pushed after review is refused at merging in the xs lane, and the way back is build', async () => {
    const t = setup();
    const id = await xsAtApprove(t);
    assert.match((await approveScript(t, id)).stdout, /^approve/);
    commitInWorktree(t, id, { 'b.txt': 'sneaked in after review\n' });
    await refused(t, id, 'to', 'merging');
    const err = (await t.job(id, 'to', 'merging')).stderr;
    assert.match(err, /not the head reviewed in round 1/);
    assert.match(err, /to build/);
  });

  test('the same head binding holds in the normal lane for an LLM decision', async () => {
    const t = setup();
    const id = await intaken(t, { intake: { size: 'm' } });
    ok(t, await t.job(id, 'to', 'spec'));
    t.write(id, 'spec.md', '# Spec\n');
    ok(t, await t.job(id, 'to', 'build'));
    await xsToGate(t, id);
    t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
    ok(t, await t.job(id, 'to', 'review'));
    for (const lens of Object.keys(t.json(id).reviews)) t.write(id, `round-${1}/review-${lens}.md`, 'VERDICT: PASS\n');
    ok(t, await t.job(id, 'to', 'approve'));
    commitInWorktree(t, id, { 'b.txt': 'late\n' });
    t.write(id, 'decision.md', 'APPROVE\nllm said yes\n');
    await refused(t, id, 'to', 'merging');
    assert.match((await t.job(id, 'to', 'merging')).stderr, /not the head reviewed/);
  });

  test('the xs limits are re-checked at approve to merging', async () => {
    const t = setup();
    const id = await xsAtApprove(t);
    assert.match((await approveScript(t, id)).stdout, /^approve/);
    // the approval stays recorded, but the diff now breaks the limits: head moved, so the head check fires first;
    // forge the reviewed head to prove the limits check stands on its own
    commitInWorktree(t, id, { 'b.txt': 'x\n', 'c.txt': 'x\n' });
    const head = git(t.json(id).worktree, 'rev-parse', 'HEAD');
    const job = t.json(id);
    t.write(id, 'job.json', JSON.stringify({ ...job, round_heads: { 1: head }, approval: { by: 'script', head, at: new Date().toISOString() } }));
    await refused(t, id, 'to', 'merging');
    assert.match((await t.job(id, 'to', 'merging')).stderr, /lane xs limits not met \(3 non-test files/);
  });

  test('job.approval is cleared wherever decision.md is cleared', async () => {
    const t = setup();
    const id = await xsAtApprove(t);
    assert.match((await approveScript(t, id)).stdout, /^approve/);
    assert.ok(t.json(id).approval);
    ok(t, await t.job(id, 'promote'));
    assert.equal(t.json(id).approval, undefined);
  });

  test('approve to promote is a valid path and deletes the decision', async () => {
    const t = setup();
    const id = await xsAtApprove(t);
    t.write(id, 'decision.md', 'APPROVE\nOk.\n\nDecided by: factory/bin/approve\n');
    ok(t, await t.job(id, 'promote'));
    assert.equal(existsSync(join(t.root, 'factory/jobs', id, 'decision.md')), false);
  });

  test('a stale decision.md is deleted on review to approve, and on every way back to build (any lane)', async () => {
    const t = setup();
    const id = await xsToBuild(t);
    await xsToGate(t, id);
    t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
    ok(t, await t.job(id, 'to', 'review'));
    t.write(id, 'round-1/review-code.md', 'VERDICT: PASS\n');
    t.write(id, 'decision.md', 'APPROVE\nstale\n\nDecided by: factory/bin/approve\n');
    ok(t, await t.job(id, 'to', 'approve'));
    assert.equal(existsSync(join(t.root, 'factory/jobs', id, 'decision.md')), false);

    const t2 = setup();
    const id2 = await intaken(t2, { intake: { size: 'm' } });
    ok(t2, await t2.job(id2, 'to', 'spec'));
    t2.write(id2, 'spec.md', '# Spec\n');
    t2.write(id2, 'decision.md', 'APPROVE\nstale\n');
    ok(t2, await t2.job(id2, 'to', 'build'));
    assert.equal(existsSync(join(t2.root, 'factory/jobs', id2, 'decision.md')), false, 'spec to build');
    await xsToGate(t2, id2);
    t2.write(id2, 'round-1/checks.md', 'GATE: FAIL\n');
    t2.write(id2, 'decision.md', 'APPROVE\nstale\n');
    ok(t2, await t2.job(id2, 'to', 'build'));
    assert.equal(existsSync(join(t2.root, 'factory/jobs', id2, 'decision.md')), false, 'gate to build');
  });

  test('approve to merging refuses a decision older than the approve stage', async () => {
    const t = setup();
    const id = await intaken(t, { intake: { size: 'm' } });
    ok(t, await t.job(id, 'to', 'spec'));
    t.write(id, 'spec.md', '# Spec\n');
    ok(t, await t.job(id, 'to', 'build'));
    await xsToGate(t, id);
    t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
    ok(t, await t.job(id, 'to', 'review'));
    for (const lens of Object.keys(t.json(id).reviews)) t.write(id, `round-1/review-${lens}.md`, 'VERDICT: PASS\n');
    ok(t, await t.job(id, 'to', 'approve'));
    assert.ok(t.json(id).approve_entered);
    t.write(id, 'decision.md', 'APPROVE\nold\n');
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(t.root, 'factory/jobs', id, 'decision.md'), old, old);
    await refused(t, id, 'to', 'merging');
    assert.match((await t.job(id, 'to', 'merging')).stderr, /older than the approve stage/);
    t.write(id, 'decision.md', 'APPROVE\nfresh\n');
    assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} merged`);
  });
});

