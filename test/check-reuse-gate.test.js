// Check reuse: the builder nudge skips a tree that already passed, the gate records the
// head it tested, and the merge reuses that gate when the sync with the base is a no-op.
// Same fake-gh harness as test/job-merge.test.js (setup in test/helpers/check-reuse-harness.js).
// Part of the check-reuse scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKS, git, setup, ok, building, approvedWithRealGate } from './helpers/check-reuse-harness.js';

describe('check reuse', { concurrency: true }, () => {
  test('the gate records the head and the checks inputs it tested', async () => {
    const t = setup();
    const { id, worktree } = await building(t);
    t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
    t.pr(31, `factory/${id}`);
    ok(await t.job(id, 'to', 'gate'));
    ok(await t.bin('gate', [id]));
    const checks = t.read(id, 'round-1/checks.md');
    assert.equal(checks.split('\n')[0], 'GATE: PASS');
    assert.match(checks, new RegExp(`^Tested head: ${git(worktree, 'rev-parse', 'HEAD')}$`, 'm'));
    assert.match(checks, /^Checks inputs: sha256:[0-9a-f]{64}$/m);
  });

  test('the merge reuses the round gate when the sync with the base brings nothing', async () => {
    const t = setup();
    const { id } = await approvedWithRealGate(t);
    const before = t.runs();
    assert.equal(ok(await t.job(id, 'to', 'merging')), `${id} merged`);
    assert.equal(t.runs(), before, 'no second run of the checks');
    const report = t.read(id, 'merge-checks.md');
    assert.equal(report.split('\n')[0], 'GATE: PASS');
    assert.match(report, /Reused the round-1 gate/);
  });

  test('the merge runs the gate again when the base moved', async () => {
    const t = setup();
    const { id } = await approvedWithRealGate(t);
    writeFileSync(join(t.root, 'main.txt'), 'main\n');
    git(t.root, 'add', '.');
    git(t.root, 'commit', '-q', '-m', 'feat: main moved on');
    git(t.root, 'push', '-q', 'origin', 'main');
    const before = t.runs();
    assert.equal(ok(await t.job(id, 'to', 'merging')), `${id} merged`);
    assert.equal(t.runs(), before + 1);
    assert.doesNotMatch(t.read(id, 'merge-checks.md'), /Reused/);
  });

  test('the merge runs the gate again when checks.sh changed since the round gate', async () => {
    const t = setup();
    const { id } = await approvedWithRealGate(t);
    writeFileSync(join(t.root, 'factory/checks.sh'), `${CHECKS}# changed\n`);
    const before = t.runs();
    assert.equal(ok(await t.job(id, 'to', 'merging')), `${id} merged`);
    assert.equal(t.runs(), before + 1);
  });

  test('a hand-written checks.md without a tested head never lets the merge skip the gate', async () => {
    const t = setup();
    const { id } = await building(t);
    t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
    t.pr(31, `factory/${id}`);
    ok(await t.job(id, 'to', 'gate'));
    t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
    ok(await t.job(id, 'to', 'review'));
    assert.equal(t.json(id).gated, undefined);
    for (const lens of Object.keys(t.json(id).reviews)) t.write(id, `round-1/review-${lens}.md`, 'VERDICT: PASS\n');
    ok(await t.job(id, 'to', 'approve'));
    t.write(id, 'decision.md', 'APPROVE\nAll good.\n');
    assert.equal(ok(await t.job(id, 'to', 'merging')), `${id} merged`);
    assert.equal(t.runs(), 1, 'the merge ran the gate');
  });
});
