// Plan P0-6: the XS lane. Intake sizes the change, the script decides the lane, an XS job
// skips the spec, runs one round and is promoted to the normal lane on the first failure.
// The fake-gh harness is copied from test/job-merge.test.js, now in test/helpers/lane-xs-harness.js.
// Part of the lane-xs scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideLane } from '../factory/lib/route.js';
import { git, setup, ok, refused, config, xsToBuild, xsToGate, commitInWorktree } from './helpers/lane-xs-harness.js';

describe('review fixes: the script enforces the xs limits at build to gate', { concurrency: true }, () => {
  const attacks = {
    'three non-test files': { files: { 'app.txt': 'x\n', 'b.txt': 'x\n', 'c.txt': 'x\n' }, why: /3 non-test files changed/ },
    'an added non-test file': { files: { 'new.txt': 'x\n' }, why: /added file new\.txt/ },
    'a deleted file': { files: {}, remove: ['d.txt'], why: /deleted file: d\.txt/ },
    'a manifest': { files: { 'package.json': '{}\n' }, why: /manifest or lockfile package\.json/ },
    'a lockfile': { files: { 'yarn.lock': 'x\n' }, why: /manifest or lockfile yarn\.lock/ },
    'an engine or CI path': { files: { '.github/workflows/ci.yml': 'x\n' }, why: /engine, CI or denied path \.github/ },
    'an added executable file': { files: {}, exec: 'run.sh', why: /executable file added: run\.sh/ },
    'more than the line cap': { files: { 'app.txt': 'line\n'.repeat(81) }, why: /changed lines outside tests \(max 80\)/ },
    'three added tests': { files: { 'test/a.test.js': 'x\n', 'test/b.test.js': 'x\n', 'test/c.test.js': 'x\n' }, why: /3 test files added or modified \(max 2\)/ },
    'a modified test that intake did not list': { files: { 'test/base.test.js': 'changed\n' }, why: /modified test test\/base\.test\.js is not listed/ },
    'a protected test': { files: { 'test/job.test.js': 'x\n' }, why: /protected test test\/job\.test\.js/ },
  };
  for (const [name, { files, remove, why, exec }] of Object.entries(attacks)) {
    test(`xs build to gate refuses ${name} and points to promote`, async () => {
      const t = setup();
      const id = await xsToBuild(t);
      const { worktree } = t.json(id);
      if (Object.keys(files).length || remove) commitInWorktree(t, id, files, { remove });
      if (exec) {
        writeFileSync(join(worktree, exec), 'echo\n');
        chmodSync(join(worktree, exec), 0o755);
        git(worktree, 'add', '-A');
        git(worktree, 'commit', '-q', '-m', 'feat: exec');
      }
      t.write(id, 'build.md', 'STATUS: READY\n\n## Spec deviations\nNone\n');
      t.pr(31, `factory/${id}`);
      await refused(t, id, 'to', 'gate');
      const err = (await t.job(id, 'to', 'gate')).stderr;
      assert.match(err, why);
      assert.match(err, /promote/);
      ok(t, await t.job(id, 'promote'));
    });
  }

  test('two changed files plus an added test stay inside the xs limits', async () => {
    const t = setup();
    const id = await xsToBuild(t);
    commitInWorktree(t, id, { 'app.txt': 'x\n', 'b.txt': 'x\n', 'test/new.test.js': 'x\n' });
    await xsToGate(t, id);
    assert.equal(t.json(id).stage, 'gate');
  });
});

describe('review fixes: resume paths and the lanes.xs.spec flag', { concurrency: true }, () => {
  test('needs-human to spec is refused for an xs job', async () => {
    const t = setup();
    const id = await xsToBuild(t);
    const job = t.json(id);
    t.write(id, 'job.json', JSON.stringify({ ...job, stage: 'needs-human', parked_from: 'spec', pr: null }));
    await refused(t, id, 'to', 'spec');
    assert.match((await t.job(id, 'to', 'spec')).stderr, /lane xs has no spec stage/);
  });

  test('a re-intake of a promoted job never sets lane xs again', async () => {
    const t = setup();
    const id = await xsToBuild(t);
    ok(t, await t.job(id, 'promote'));
    t.write(id, 'job.json', JSON.stringify({ ...t.json(id), stage: 'intake', round: 2 }));
    assert.equal(ok(t, await t.job(id, 'lane')), 'normal');
    await refused(t, id, 'to', 'build');
    ok(t, await t.job(id, 'to', 'spec'));
    assert.equal(t.json(id).lane, 'normal');
    assert.equal(t.json(id).promoted_from, 'xs');
  });

  test('lanes.xs.spec other than false disables the lane, with the reason', () => {
    const on = { ...config, lanes: { xs: { ...config.lanes.xs, spec: true } } };
    const out = decideLane(on, { size: 'xs', risk: 'low', surfaces: [] }, 'claude', { requested: true });
    assert.equal(out.lane, 'normal');
    assert.match(out.reason, /lanes\.xs\.spec must be false/);
  });
});

