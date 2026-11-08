// Check reuse: the builder nudge skips a tree that already passed, the gate records the
// head it tested, and the merge reuses that gate when the sync with the base is a no-op.
// Same fake-gh harness as test/job-merge.test.js (setup in test/helpers/check-reuse-harness.js).
// Part of the check-reuse scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo, CHECKS, git, setup, ok, building } from './helpers/check-reuse-harness.js';

test('Claude and Codex builders both run their checks through the nudge, so both record the pass', () => {
  const role = readFileSync(join(repo, 'factory/roles/builder.md'), 'utf8');
  const codex = readFileSync(join(repo, '.codex/agents/eminzo-builder.toml'), 'utf8');
  assert.match(role, /Run the repo's checks with `factory\/bin\/nudge <job-id>`/);
  assert.match(codex, /factory\/bin\/nudge <id>/);
  assert.doesNotMatch(codex, /Run `factory\/checks\.sh` in the worktree/);
});

test('checks inputs depend on the main checkout, never on which copy of the engine computes them', async () => {
  // The builder runs factory/bin/nudge from its worktree's copy; the Stop hook and the gate run
  // the main checkout's. Both must agree, or the hook reruns the whole suite for nothing.
  const copy = mkdtempSync(join(tmpdir(), 'factory-engine-copy-'));
  mkdirSync(join(copy, 'factory'), { recursive: true });
  execFileSync('cp', ['-R', join(repo, 'factory/lib'), join(copy, 'factory/lib')]);
  writeFileSync(join(copy, 'package.json'), '{"type":"module"}\n');
  const original = await import(join(repo, 'factory/lib/check-stamp.js'));
  const copied = await import(join(copy, 'factory/lib/check-stamp.js'));
  assert.equal(copied.checksInputs(repo), original.checksInputs(repo));

  const root = mkdtempSync(join(tmpdir(), 'factory-inputs-'));
  mkdirSync(join(root, 'factory/lib'), { recursive: true });
  writeFileSync(join(root, 'factory/checks.sh'), CHECKS);
  writeFileSync(join(root, 'factory/lib/gate.js'), 'v1\n');
  const before = original.checksInputs(root);
  writeFileSync(join(root, 'factory/lib/gate.js'), 'v2\n');
  assert.notEqual(original.checksInputs(root), before, 'an engine change in the main checkout counts');
});

describe('check reuse', { concurrency: true }, () => {
  test('nudge skips the checks for a tree that already passed, manual (Codex) or hook (Claude)', async () => {
    const t = setup();
    const { id, worktree } = await building(t);
    ok(await t.bin('nudge', [id]));
    assert.equal(t.runs(), 1);
    const again = await t.bin('nudge', [id]);
    assert.equal(again.status, 0);
    assert.equal(t.runs(), 1, 'a second nudge on the same tree does not run the checks');
    assert.match(again.stderr, /already passed/);

    const transcript = join(t.dir, 'builder.jsonl');
    writeFileSync(transcript, JSON.stringify({ text: `Job folder: factory/jobs/${id}/` }) + '\n');
    const hook = await t.bin('nudge', [], JSON.stringify({ agent_transcript_path: transcript, stop_hook_active: false }));
    assert.equal(hook.status, 0);
    assert.equal(t.runs(), 1, 'the Stop hook reuses the pass recorded by a manual nudge');
    assert.ok(existsSync(worktree));
  });

  test('nudge reruns when the tree changes, and skips again once the same content is committed', async () => {
    const t = setup();
    const { id, worktree } = await building(t);
    ok(await t.bin('nudge', [id]));
    writeFileSync(join(worktree, 'feature.txt'), 'feature v2\n');
    ok(await t.bin('nudge', [id]));
    assert.equal(t.runs(), 2, 'an uncommitted edit is a new tree');
    git(worktree, 'commit', '-q', '-am', 'feat: v2');
    ok(await t.bin('nudge', [id]));
    assert.equal(t.runs(), 2, 'committing the tested content keeps the same tree');
  });

  test('nudge reruns when the main checkout changes checks.sh', async () => {
    const t = setup();
    const { id } = await building(t);
    ok(await t.bin('nudge', [id]));
    writeFileSync(join(t.root, 'factory/checks.sh'), `${CHECKS}# changed\n`);
    ok(await t.bin('nudge', [id]));
    assert.equal(t.runs(), 2);
  });

  test('nudge still reports a pass when it cannot write its stamp', async () => {
    const t = setup();
    const { id } = await building(t);
    mkdirSync(t.path(id, 'nudge.json')); // a directory: the stamp cannot be written there
    const res = await t.bin('nudge', [id]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(t.runs(), 1);
  });

  test('a failing nudge exits 2, keeps the full log in the job folder and forgets the last pass', async () => {
    const t = setup();
    const { id, worktree } = await building(t);
    ok(await t.bin('nudge', [id]));
    writeFileSync(join(worktree, 'BROKEN'), 'x\n');
    const failing = await t.bin('nudge', [id]);
    assert.equal(failing.status, 2);
    assert.match(failing.stderr, /BROKEN is present/);
    assert.match(failing.stderr, /nudge\.log/);
    assert.match(t.read(id, 'nudge.log'), /checks: running[\s\S]*BROKEN is present/);
    rmSync(join(worktree, 'BROKEN'));
    ok(await t.bin('nudge', [id]));
    assert.equal(t.runs(), 3, 'after a failure the next nudge runs the checks again');
  });
});
