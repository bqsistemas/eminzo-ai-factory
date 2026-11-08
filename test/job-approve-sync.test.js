// Spine test (protected in factory/config.json): factory/bin/job, the only writer
// of job.json. Every test builds a throwaway FACTORY_ROOT: a git repo with a bare
// `origin`, a fixture checks.sh, and a fake `gh` that logs its arguments and keeps
// issue/PR state in a JSON file.
// Part of the job scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repo, git, setup, ok, refused, INTAKE, toGate, gateToApprove } from './helpers/job-harness.js';

// Every test builds its own FACTORY_ROOT, so they run concurrently.
describe('factory/bin/job', { concurrency: true }, () => {
  // Commits a file in the job's worktree, then moves origin/main ahead with another commit.
  function branchBehindMain(t, id, branchFile, mainFile) {
    const { worktree } = t.json(id);
    writeFileSync(join(worktree, branchFile[0]), branchFile[1]);
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-q', '-m', 'feat: branch work');
    writeFileSync(join(t.root, mainFile[0]), mainFile[1]);
    git(t.root, 'add', '.');
    git(t.root, 'commit', '-q', '-m', 'feat: main moved on');
    git(t.root, 'push', '-q', 'origin', 'main');
  }

  async function approvedJob(t) {
    t.issue(7, { title: 'Merge me' });
    const id = ok(t, await t.job('new', '7'));
    await toGate(t, id);
    return id;
  }

  const build = (t, id, body) => t.write(id, 'build.md', `STATUS: READY\n\n${body}\n\n## PR\n#31\n`);

  test('AC-4: APPROVE syncs origin/main into the branch, pushes only factory/<id>, re-gates and merges', async () => {
    const t = setup();
    const id = await approvedJob(t);
    branchBehindMain(t, id, ['feature.txt', 'feature\n'], ['main.txt', 'main\n']);
    await gateToApprove(t, id);
    t.write(id, 'decision.md', 'APPROVE\nAll good.\n');
    const originMain = git(t.origin, 'rev-parse', 'main');
    const before = t.calls().length;

    assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} merged`);
    const job = t.json(id);
    assert.equal(job.stage, 'merged');
    assert.ok(Date.parse(job.finished), 'finished is set');
    assert.ok(!existsSync(job.worktree), 'worktree removed');
    assert.equal(git(t.origin, 'rev-parse', 'main'), originMain, "origin's main unchanged");
    assert.equal(git(t.origin, 'show', `factory/${id}:main.txt`), 'main', 'origin/main merged into the branch');
    assert.equal(git(t.origin, 'show', `factory/${id}:feature.txt`), 'feature', 'branch work pushed');
    assert.deepEqual(git(t.origin, 'for-each-ref', '--format=%(refname)').split('\n').sort(),
      ['refs/heads/factory/' + id, 'refs/heads/main'], 'only factory/<id> was pushed');
    assert.equal(t.read(id, 'merge-checks.md').split('\n')[0], 'GATE: PASS');

    const calls = t.calls().slice(before).map(({ args }) => args);
    const ready = calls.findIndex((a) => a[0] === 'pr' && a[1] === 'ready' && a[2] === '31');
    const merge = calls.findIndex((a) => a[0] === 'pr' && a[1] === 'merge');
    assert.ok(ready >= 0 && merge > ready, 'pr ready, then pr merge');
    const pushed = git(t.origin, 'rev-parse', `factory/${id}`);
    assert.deepEqual(calls[merge], ['pr', 'merge', '31', '--merge', '--match-head-commit', pushed], 'merges exactly the gated commit');
  });

  test('AC-4: failing post-sync checks end in needs-human with a note and no pr merge', async () => {
    const t = setup();
    const id = await approvedJob(t);
    branchBehindMain(t, id, ['feature.txt', 'feature\n'], ['BROKEN', 'main broke the build\n']);
    await gateToApprove(t, id);
    t.write(id, 'decision.md', 'APPROVE\nAll good.\n');

    assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} needs-human`);
    const job = t.json(id);
    assert.equal(job.stage, 'needs-human');
    assert.match(job.note, /check/i, 'note names the failed step');
    assert.equal(job.finished, null);
    assert.equal(t.read(id, 'merge-checks.md').split('\n')[0], 'GATE: FAIL');
    assert.ok(!t.calls().some(({ args }) => args[0] === 'pr' && args[1] === 'merge'), 'pr merge never called');
    assert.ok(t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'));
  });

  test('AC-4: a conflicting sync ends in needs-human with a note and no pr merge', async () => {
    const t = setup();
    const id = await approvedJob(t);
    branchBehindMain(t, id, ['app.txt', 'branch version\n'], ['app.txt', 'main version\n']);
    await gateToApprove(t, id);
    t.write(id, 'decision.md', 'APPROVE\nAll good.\n');
    const originMain = git(t.origin, 'rev-parse', 'main');

    assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} needs-human`);
    const job = t.json(id);
    assert.equal(job.stage, 'needs-human');
    assert.match(job.note, /sync|conflict|merge/i, 'note names the failed step');
    assert.ok(!t.calls().some(({ args }) => args[0] === 'pr' && args[1] === 'merge'), 'pr merge never called');
    assert.equal(git(job.worktree, 'status', '--porcelain'), '', 'the conflicted merge was aborted');
    assert.equal(git(t.origin, 'rev-parse', 'main'), originMain, "origin's main unchanged");
  });

  test('AC-2: to gate ignores a fork PR on the same branch name, so it can never be merged', async () => {
    const t = setup();
    t.issue(7, { title: 'Dark mode toggle' });
    const id = ok(t, await t.job('new', '7'));
    t.write(id, 'intake.md', INTAKE('ACCEPT'));
    ok(t, await t.job(id, 'to', 'spec'));
    t.write(id, 'spec.md', '# Spec\n');
    ok(t, await t.job(id, 'to', 'build'));
    t.write(id, 'build.md', 'STATUS: READY\n\n## Spec deviations\nNone\n');
    t.pr(66, `factory/${id}`, { isCrossRepository: true, headRepositoryOwner: { login: 'attacker' } });
    await refused(t, id, 'to', 'gate'); // only the fork PR exists
    t.pr(67, `factory/${id}`, { isCrossRepository: false, headRepositoryOwner: { login: 'someone-else' } });
    await refused(t, id, 'to', 'gate'); // same-repo flag but another owner
    t.pr(31, `factory/${id}`);
    ok(t, await t.job(id, 'to', 'gate'));
    assert.equal(t.json(id).pr, 31, 'the same-repo PR is stored, not the fork');
    assert.ok(!t.calls().some(({ args }) => args[0] === 'pr' && args[1] === 'merge'), 'pr merge never called');
  });

  test('AC-2: REJECT ends the job with a comment, and a human merge moves a needs-human job to merged', async () => {
    const t = setup();
    t.issue(7, { title: 'Mine crypto' });
    const rejected = ok(t, await t.job('new', '7'));
    t.write(rejected, 'intake.md', INTAKE('REJECT'));
    ok(t, await t.job(rejected, 'to', 'rejected'));
    let job = t.json(rejected);
    assert.equal(job.stage, 'rejected');
    assert.ok(Date.parse(job.finished), 'finished is set');
    const comment = t.calls().find(({ args }) => args.slice(0, 3).join(' ') === 'issue comment 7');
    assert.match(comment.body, /close it/i, 'tells the author what to do');
    await refused(t, rejected, 'to', 'intake');

    t.issue(8, { title: 'Needs a human' });
    const id = ok(t, await t.job('new', '8'));
    await toGate(t, id);
    await gateToApprove(t, id);
    t.write(id, 'decision.md', 'ESCALATE\nA human should look.\n');
    ok(t, await t.job(id, 'to', 'needs-human'));
    await refused(t, id, 'to', 'merged'); // the PR is still open
    t.setPr(31, { state: 'MERGED' });
    ok(t, await t.job(id, 'to', 'merged'));
    job = t.json(id);
    assert.equal(job.stage, 'merged');
    assert.ok(Date.parse(job.finished), 'finished is set');
    assert.ok(!existsSync(job.worktree), 'worktree removed');
  });

  test('AC-3: a job parked before it has a PR resumes from the stage it stopped at', async () => {
    const t = setup();
    t.issue(7, { title: 'Blocked spec' });
    const id = ok(t, await t.job('new', '7'));
    t.write(id, 'intake.md', INTAKE('ACCEPT'));
    ok(t, await t.job(id, 'to', 'spec'));
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'spec-writer: wrote no spec.md twice'));
    assert.equal(t.json(id).parked_from, 'spec');
    const res = await t.job(id, 'to', 'build');
    assert.equal(res.status, 1);
    assert.match(res.stderr, new RegExp(`to spec`), 'the refusal names the way out');
    await refused(t, id, 'to', 'intake');
    ok(t, await t.job(id, 'to', 'spec'));
    const job = t.json(id);
    assert.equal(job.stage, 'spec');
    assert.equal(job.round, 0);
    assert.ok(!t.state().issues[7].labels.some((l) => l.name === 'factory:needs-human'), 'needs-human label removed');
  });
  // --- incremental re-review (plan P0-3) and spec deviations (plan P0-4) -------------
  // These tests are new behavior in the protected spine: from round 2 only the lenses
  // whose latest verdict is CHANGES rerun, plus code (always) and security (when routed).
});
