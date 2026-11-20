// E5: the gate reuses the builder's Stop-hook FULL pass through an engine-written stamp
// (factory/jobs/.stamps/<job-id>.json in the MAIN checkout), with safeguards: the stamp must match the
// job, round, head, tree, checks inputs and base; it is single use; the merge never reuses a gate
// that rested on a stamp; and a branch may not touch factory/jobs/.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { checksInputs, headSha, mergeBase } from '../factory/lib/check-stamp.js';
import { STAMP_TTL_MS } from '../factory/lib/stop-stamp.js';
import { git, setup, ok, building, approvedWithRealGate } from './helpers/check-reuse-harness.js';

const REUSED = /Reused the Stop-hook pass/;
const stampPath = (t, id) => join(t.root, 'factory/jobs/.stamps', `${id}.json`);

// A building job that sits in the gate stage with a PR, plus a stamp that matches it exactly.
async function gating(t) {
  const { id, worktree } = await building(t);
  t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
  t.pr(31, `factory/${id}`);
  ok(await t.job(id, 'to', 'gate'));
  const job = t.json(id);
  const stamp = {
    job: id,
    round: job.round,
    tree: git(worktree, 'rev-parse', 'HEAD^{tree}'),
    inputs: checksInputs(t.root),
    base: mergeBase(worktree, 'origin/main'),
    head: headSha(worktree),
    at: new Date().toISOString(),
    engine: null,
  };
  const put = (s = stamp, file = stampPath(t, id)) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof s === 'string' ? s : `${JSON.stringify(s)}\n`);
  };
  return { id, worktree, stamp, put };
}

describe('gate reuses the Stop-hook pass', { concurrency: true }, () => {
  test('a valid stamp: checks.sh does not run, checks.md says so, the stamp is consumed', async () => {
    const t = setup();
    const { id, stamp, put } = await gating(t);
    put();
    ok(await t.bin('gate', [id]));
    assert.equal(t.runs(), 0, 'checks.sh did not run');
    const report = t.read(id, 'round-1/checks.md');
    assert.equal(report.split('\n')[0], 'GATE: PASS');
    assert.match(report, REUSED);
    assert.ok(report.includes(stamp.at) && report.includes(stamp.tree) && report.includes(stamp.head));
    assert.match(report, new RegExp(`^Tested head: ${stamp.head}$`, 'm'));
    assert.equal(existsSync(stampPath(t, id)), false, 'single use');
  });

  test('the stamp is single use: a second gate run in the same round runs the checks', async () => {
    const t = setup();
    const { id, put } = await gating(t);
    put();
    ok(await t.bin('gate', [id]));
    assert.equal(t.runs(), 0);
    ok(await t.bin('gate', [id]));
    assert.equal(t.runs(), 1);
    assert.doesNotMatch(t.read(id, 'round-1/checks.md'), REUSED);
  });

  const mismatches = {
    'another tree': (s) => ({ ...s, tree: 'a'.repeat(40) }),
    'another head': (s) => ({ ...s, head: 'b'.repeat(40) }),
    'other checks inputs': (s) => ({ ...s, inputs: `sha256:${'c'.repeat(64)}` }),
    'another base': (s) => ({ ...s, base: 'd'.repeat(40) }),
    'a missing base': (s) => ({ ...s, base: null }),
    'another round': (s) => ({ ...s, round: 2 }),
    'another job': (s) => ({ ...s, job: '999-other' }),
    'a missing tree': (s) => ({ ...s, tree: undefined }),
  };
  for (const [name, mutate] of Object.entries(mismatches)) {
    test(`a stamp with ${name} is ignored and checks.sh runs`, async () => {
      const t = setup();
      const { id, stamp, put } = await gating(t);
      put(mutate(stamp));
      ok(await t.bin('gate', [id]));
      assert.equal(t.runs(), 1);
      assert.doesNotMatch(t.read(id, 'round-1/checks.md'), REUSED);
    });
  }

  test('a stamp older than the TTL, from the future, or without a usable time is ignored', async () => {
    const ago = (ms) => new Date(Date.now() + ms).toISOString();
    const cases = {
      'two hours old': ago(-2 * 3600_000),
      'just over an hour old': ago(-STAMP_TTL_MS - 60_000),
      'five minutes in the future': ago(5 * 60_000),
      unparseable: 'yesterday-ish',
      missing: undefined,
    };
    for (const [name, at] of Object.entries(cases)) {
      const t = setup();
      const { id, stamp, put } = await gating(t);
      put({ ...stamp, at });
      ok(await t.bin('gate', [id]));
      assert.equal(t.runs(), 1, name);
      assert.doesNotMatch(t.read(id, 'round-1/checks.md'), REUSED, name);
      assert.equal(existsSync(stampPath(t, id)), false, `${name}: the expired stamp is gone`);
    }
  });

  test('a stamp inside the TTL and the clock skew is reused', async () => {
    for (const ms of [-STAMP_TTL_MS + 120_000, 30_000]) {
      const t = setup();
      const { id, stamp, put } = await gating(t);
      put({ ...stamp, at: new Date(Date.now() + ms).toISOString() });
      ok(await t.bin('gate', [id]));
      assert.equal(t.runs(), 0, `offset ${ms}`);
    }
  });

  test('the summary sentence says the pass was reused, and a real run does not', async () => {
    const t = setup();
    const { id, put } = await gating(t);
    put();
    ok(await t.bin('gate', [id]));
    assert.match(t.read(id, 'round-1/checks.md').split('\n')[3], /^The checks passed: reused the Stop-hook pass \(checks\.sh was not run\) on commit [0-9a-f]{7}\.$/);
    ok(await t.bin('gate', [id]));
    assert.match(t.read(id, 'round-1/checks.md').split('\n')[3], /^The checks passed in \d+s on commit /);
  });

  test('a git commit --amend after the stamp (same tree, new head) is not reused', async () => {
    const t = setup();
    const { id, worktree, stamp, put } = await gating(t);
    git(worktree, 'commit', '-q', '--amend', '-m', 'feat: branch work, reworded');
    assert.equal(git(worktree, 'rev-parse', 'HEAD^{tree}'), stamp.tree, 'same tree');
    assert.notEqual(headSha(worktree), stamp.head, 'new head');
    put();
    ok(await t.bin('gate', [id]));
    assert.equal(t.runs(), 1);
    assert.doesNotMatch(t.read(id, 'round-1/checks.md'), REUSED);
  });

  test('a symlinked stamp file is never read, even when it points at a valid stamp', async () => {
    const t = setup();
    const { id, stamp, put } = await gating(t);
    const real = join(t.dir, 'elsewhere', 'valid.json');
    put(stamp, real);
    mkdirSync(dirname(stampPath(t, id)), { recursive: true });
    symlinkSync(real, stampPath(t, id));
    ok(await t.bin('gate', [id]));
    assert.equal(t.runs(), 1);
    assert.doesNotMatch(t.read(id, 'round-1/checks.md'), REUSED);
  });

  test('a symlinked .stamps folder is never read, even when it holds a valid stamp', async () => {
    const t = setup();
    const { id, stamp, put } = await gating(t);
    const realDir = join(t.dir, 'elsewhere-dir');
    put(stamp, join(realDir, `${id}.json`));
    mkdirSync(join(t.root, 'factory/jobs'), { recursive: true });
    symlinkSync(realDir, join(t.root, 'factory/jobs/.stamps'));
    ok(await t.bin('gate', [id]));
    assert.equal(t.runs(), 1);
    assert.doesNotMatch(t.read(id, 'round-1/checks.md'), REUSED);
  });

  test('a malformed stamp is ignored and checks.sh runs', async () => {
    for (const junk of ['{not json', 'null', '[1]', '"x"', '']) {
      const t = setup();
      const { id, put } = await gating(t);
      put(junk);
      ok(await t.bin('gate', [id]));
      assert.equal(t.runs(), 1, `junk ${JSON.stringify(junk)}`);
    }
  });

  test('a stamp that exists only inside the worktree is never read', async () => {
    const t = setup();
    const { id, worktree, stamp, put } = await gating(t);
    put(stamp, join(worktree, 'factory/jobs/.stamps', `${id}.json`));
    ok(await t.bin('gate', [id]));
    assert.equal(t.runs(), 1);
    assert.doesNotMatch(t.read(id, 'round-1/checks.md'), REUSED);
  });

  test('an uncommitted worktree runs the checks and still fails on the uncommitted file', async () => {
    const t = setup();
    const { id, worktree, put } = await gating(t);
    put();
    writeFileSync(join(worktree, 'loose.txt'), 'x\n');
    const res = await t.bin('gate', [id]);
    assert.equal(res.status, 1);
    assert.equal(t.runs(), 1);
    assert.match(t.read(id, 'round-1/checks.md'), /uncommitted: loose\.txt/);
  });

  test('a base_fix job never reuses a stamp', async () => {
    const t = setup();
    const { id, put } = await gating(t);
    put();
    const job = t.json(id);
    writeFileSync(t.path(id, 'job.json'), JSON.stringify({ ...job, base_fix: true }));
    ok(await t.bin('gate', [id]));
    assert.equal(t.runs(), 1);
  });

  test('the other gate steps still run on a reused pass: a protected test change fails the round', async () => {
    const t = setup();
    const cfgFile = join(t.root, 'factory/config.json');
    writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, 'utf8')), protected_tests: ['app.txt'] }));
    const { id, worktree, put } = await building(t).then(async ({ id: jobId, worktree: wt }) => {
      t.write(jobId, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
      t.pr(31, `factory/${jobId}`);
      ok(await t.job(jobId, 'to', 'gate'));
      writeFileSync(join(wt, 'app.txt'), 'tampered\n');
      git(wt, 'commit', '-q', '-am', 'touch protected');
      const put = (s) => {
        mkdirSync(join(t.root, 'factory/jobs/.stamps'), { recursive: true });
        writeFileSync(stampPath(t, jobId), `${JSON.stringify(s)}\n`);
      };
      return { id: jobId, worktree: wt, put };
    });
    put({
      job: id, round: 1, tree: git(worktree, 'rev-parse', 'HEAD^{tree}'), inputs: checksInputs(t.root),
      base: mergeBase(worktree, 'origin/main'), head: headSha(worktree), at: new Date().toISOString(), engine: null,
    });
    const res = await t.bin('gate', [id]);
    assert.equal(t.runs(), 0, 'the pass was reused');
    assert.equal(res.status, 1);
    const report = t.read(id, 'round-1/checks.md');
    assert.match(report, REUSED);
    assert.match(report, /^GATE: FAIL/);
    assert.match(report, /M app\.txt/);
  });

  test('a gate that reused a stamp is recorded, and the merge runs the checks into merge-checks.md', async () => {
    const t = setup();
    const { id, put } = await gating(t);
    put();
    ok(await t.bin('gate', [id]));
    assert.equal(t.runs(), 0);
    ok(await t.job(id, 'to', 'review'));
    assert.equal(t.json(id).gated?.reused_stamp, true);
    for (const lens of Object.keys(t.json(id).reviews)) t.write(id, `round-1/review-${lens}.md`, 'VERDICT: PASS\n');
    ok(await t.job(id, 'to', 'approve'));
    t.write(id, 'decision.md', 'APPROVE\nAll good.\n');
    assert.equal(ok(await t.job(id, 'to', 'merging')), `${id} merged`);
    assert.equal(t.runs(), 1, 'the merge ran checks.sh');
    const merge = t.read(id, 'merge-checks.md');
    assert.doesNotMatch(merge, /Reused/);
  });

  test('a normal round gate is still reused by the merge (no regression)', async () => {
    const t = setup();
    const { id } = await approvedWithRealGate(t);
    assert.equal(t.json(id).gated?.reused_stamp, undefined);
    const before = t.runs();
    ok(await t.job(id, 'to', 'merging'));
    assert.equal(t.runs(), before);
  });

  test('the merge-time gate never reuses a stamp even if one is present', async () => {
    const t = setup();
    const { id, put } = await gating(t);
    ok(await t.bin('gate', [id]));
    ok(await t.job(id, 'to', 'review'));
    for (const lens of Object.keys(t.json(id).reviews)) t.write(id, `round-1/review-${lens}.md`, 'VERDICT: PASS\n');
    ok(await t.job(id, 'to', 'approve'));
    t.write(id, 'decision.md', 'APPROVE\nAll good.\n');
    put();
    const before = t.runs();
    // move the base so the merge cannot reuse the round gate and must run the gate itself
    writeFileSync(join(t.root, 'main.txt'), 'main\n');
    git(t.root, 'add', '.');
    git(t.root, 'commit', '-q', '-m', 'feat: main moved on');
    git(t.root, 'push', '-q', 'origin', 'main');
    ok(await t.job(id, 'to', 'merging'));
    assert.equal(t.runs(), before + 1);
    assert.doesNotMatch(t.read(id, 'merge-checks.md'), REUSED);
  });
});

describe('gate rejects a branch that touches factory/jobs/', { concurrency: true }, () => {
  const REASON = /factory\/jobs\//;
  test('adding, modifying, deleting or renaming a path under factory/jobs fails the round with the reason', async () => {
    const t = setup();
    const { id, worktree } = await gating(t);
    mkdirSync(join(worktree, 'factory/jobs/.stamps'), { recursive: true });
    writeFileSync(join(worktree, 'factory/jobs/.stamps/x.json'), '{}\n');
    git(worktree, 'add', '-f', '-A');
    git(worktree, 'commit', '-q', '-m', 'sneak');
    const res = await t.bin('gate', [id]);
    assert.equal(res.status, 1);
    const report = t.read(id, 'round-1/checks.md');
    assert.equal(report.split('\n')[0], 'GATE: FAIL');
    assert.match(report, /factory\/jobs\/\.stamps\/x\.json/);
    assert.match(report, /touches factory\/jobs\//i);
    assert.match(report, REASON);
  });

  test('a deletion or rename of a tracked factory/jobs path is reported through its old path', async () => {
    const t = setup();
    const dir = join(t.dir, 'rename-repo');
    mkdirSync(join(dir, 'factory/jobs'), { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'factory/jobs/old.txt'), 'x\n');
    writeFileSync(join(dir, 'factory/jobs/gone.txt'), 'y\n');
    git(dir, 'add', '-f', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'topic');
    git(dir, 'mv', 'factory/jobs/old.txt', 'moved.txt');
    git(dir, 'rm', '-q', 'factory/jobs/gone.txt');
    git(dir, 'commit', '-q', '-m', 'move and delete');
    const { jobsFolderChanges } = await import('../factory/lib/gate.js');
    assert.deepEqual(jobsFolderChanges(dir, 'main'), ['factory/jobs/gone.txt', 'factory/jobs/old.txt']);
  });

  test('factory/demo/jobs is a different path and stays allowed', async () => {
    const t = setup();
    const { id, worktree } = await gating(t);
    mkdirSync(join(worktree, 'factory/demo/jobs/001-x'), { recursive: true });
    writeFileSync(join(worktree, 'factory/demo/jobs/001-x/build.md'), 'demo\n');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'demo');
    const res = await t.bin('gate', [id]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(t.read(id, 'round-1/checks.md'), /^GATE: PASS/);
  });

  test('the rule ignores case: Factory/Jobs and FACTORY/JOBS are caught, factory/demo/jobs in any case is not', async () => {
    const t = setup();
    const { jobsFolderChanges } = await import('../factory/lib/gate.js');
    // One repository per path: on a case-insensitive volume `Factory/Jobs` and `FACTORY/JOBS` are one folder.
    const changed = (path, n) => {
      const repoDir = join(t.dir, `case-repo-${n}`);
      mkdirSync(repoDir, { recursive: true });
      git(repoDir, 'init', '-q', '-b', 'main');
      writeFileSync(join(repoDir, 'a.txt'), 'a\n');
      git(repoDir, 'add', '.');
      git(repoDir, 'commit', '-q', '-m', 'base');
      git(repoDir, 'checkout', '-q', '-b', 'topic');
      mkdirSync(join(repoDir, dirname(path)), { recursive: true });
      writeFileSync(join(repoDir, path), 'x\n');
      git(repoDir, 'add', '-f', '-A');
      git(repoDir, 'commit', '-q', '-m', 'case');
      return jobsFolderChanges(repoDir, 'main');
    };
    const caught = ['Factory/Jobs/a.json', 'FACTORY/JOBS/.stamps/b.json', 'factory/JOBS/c.json', 'FaCtOrY/jObS/d.json'];
    caught.forEach((p, i) => assert.deepEqual(changed(p, i), [p], p));
    ['FACTORY/DEMO/JOBS/ok.md', 'Factory/Demo/jobs/ok2.md', 'factory/demo/jobs/ok3.md'].forEach((p, i) => assert.deepEqual(changed(p, 10 + i), [], p));
  });

  test('a clean branch reports no factory/jobs changes', async () => {
    const t = setup();
    const { id } = await gating(t);
    ok(await t.bin('gate', [id]));
    assert.match(t.read(id, 'round-1/checks.md'), /^Factory jobs folder changes: none$/m);
  });
});

describe('nudge writes the stamp', { concurrency: true }, () => {
  test('a full PASS writes the stamp; every field is truthful', async () => {
    const t = setup();
    const { id, worktree } = await building(t);
    ok(await t.bin('nudge', [id, '--full']));
    assert.equal(t.runs(), 1);
    const s = JSON.parse(readFileSync(stampPath(t, id), 'utf8'));
    assert.equal(s.job, id);
    assert.equal(s.round, t.json(id).round);
    assert.equal(s.tree, git(worktree, 'rev-parse', 'HEAD^{tree}'));
    assert.equal(s.head, headSha(worktree));
    assert.equal(s.inputs, checksInputs(t.root));
    assert.equal(s.base, mergeBase(worktree, 'origin/main'));
    assert.ok(Number.isFinite(Date.parse(s.at)));
    assert.ok('engine' in s);
  });

  test('a focused PASS does not write a stamp', async () => {
    const t = setup();
    const { id } = await building(t);
    ok(await t.bin('nudge', [id]));
    assert.equal(existsSync(stampPath(t, id)), false);
  });

  test('a full FAIL removes an existing stamp', async () => {
    const t = setup();
    const { id, worktree } = await building(t);
    ok(await t.bin('nudge', [id, '--full']));
    assert.ok(existsSync(stampPath(t, id)));
    writeFileSync(join(worktree, 'BROKEN'), 'x\n');
    const res = await t.bin('nudge', [id, '--full']);
    assert.equal(res.status, 2);
    assert.equal(existsSync(stampPath(t, id)), false);
  });

  test('a pass reused from nudge.json does not create a stamp', async () => {
    const t = setup();
    const { id } = await building(t);
    ok(await t.bin('nudge', [id, '--full']));
    const { rmSync } = await import('node:fs');
    rmSync(stampPath(t, id));
    ok(await t.bin('nudge', [id, '--full']));
    assert.equal(t.runs(), 1, 'reused, not run again');
    assert.equal(existsSync(stampPath(t, id)), false);
  });

  // A checks.sh that changes the worktree or its head while it runs: what the pass vouches for is no longer what is there.
  const withChecks = (t, body) => writeFileSync(join(t.root, 'factory/checks.sh'), `#!/bin/sh\necho run >> "$CHECKS_COUNT"\n${body}\nexit 0\n`);

  test('no stamp when the checks change the worktree tree while they run', async () => {
    const t = setup();
    const { id } = await building(t);
    withChecks(t, 'echo generated > generated.txt');
    ok(await t.bin('nudge', [id, '--full']));
    assert.equal(t.runs(), 1);
    assert.equal(existsSync(stampPath(t, id)), false);
  });

  test('no stamp when the checks move the head (same tree, new commit) while they run', async () => {
    const t = setup();
    const { id, worktree } = await building(t);
    withChecks(t, 'git commit -q --allow-empty -m "moved during the run"');
    const before = headSha(worktree);
    ok(await t.bin('nudge', [id, '--full']));
    assert.notEqual(headSha(worktree), before, 'the head moved');
    assert.equal(existsSync(stampPath(t, id)), false);
  });

  test('a run that leaves tree and head alone still writes the stamp', async () => {
    const t = setup();
    const { id } = await building(t);
    withChecks(t, 'true');
    ok(await t.bin('nudge', [id, '--full']));
    assert.ok(existsSync(stampPath(t, id)));
  });

  test('the real flow: nudge --full then gate reuses the pass', async () => {
    const t = setup();
    const { id } = await building(t);
    t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
    t.pr(31, `factory/${id}`);
    ok(await t.job(id, 'to', 'gate'));
    ok(await t.bin('nudge', [id, '--full']));
    ok(await t.bin('gate', [id]));
    assert.equal(t.runs(), 1, 'only the nudge ran checks.sh');
    assert.match(t.read(id, 'round-1/checks.md'), REUSED);
  });

  test('the stamp folder is never taken for a job by the listers', async () => {
    const t = setup();
    const { id } = await building(t);
    ok(await t.bin('nudge', [id, '--full']));
    assert.ok(existsSync(stampPath(t, id)));
    assert.deepEqual(readdirSync(join(t.root, 'factory/jobs')).filter((n) => /^\d{3,}-/.test(n)), [id]);
    const { resolveRequest } = await import('../factory/lib/dashboard.js');
    assert.equal(await resolveRequest(join(t.root, 'factory'), `/jobs/.stamps/${id}.json`), null);
    const { JOB_ID } = await import('../factory/lib/util.js');
    assert.equal(JOB_ID.test('.stamps'), false);
  });
});
