// Spine test (protected in factory/config.json): factory/bin/job, the only writer
// of job.json. Every test builds a throwaway FACTORY_ROOT: a git repo with a bare
// `origin`, a fixture checks.sh, and a fake `gh` that logs its arguments and keeps
// issue/PR state in a JSON file.
// Part of the job scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, setup, ok, refused, INTAKE } from './helpers/job-harness.js';

// Every test builds its own FACTORY_ROOT, so they run concurrently.
describe('factory/bin/job', { concurrency: true }, () => {
  const startRound = async (t, id, round, checks = 'GATE: PASS\n') => {
    t.write(id, `round-${round}/checks.md`, checks);
    ok(t, await t.job(id, 'to', 'review'));
  };

  const verdictFiles = (t, id, round, verdicts) => {
    for (const [lens, v] of Object.entries(verdicts)) t.write(id, `round-${round}/review-${lens}.md`, `VERDICT: ${v}\n`);
  };

  // Intake with ui and interaction routes code, ux and ui; with security it adds security.
  async function accepted(t, surfaces) {
    t.issue(7, { title: 'Header abbreviate' });
    const id = ok(t, await t.job('new', '7'));
    t.write(id, 'intake.md', INTAKE('ACCEPT', 'low', surfaces));
    ok(t, await t.job(id, 'to', 'spec'));
    t.write(id, 'spec.md', '# Spec\n');
    ok(t, await t.job(id, 'to', 'build'));
    t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
    t.pr(31, `factory/${id}`);
    ok(t, await t.job(id, 'to', 'gate'));
    return id;
  }

  const prompt = async (t, id) => (await t.job(id, 'prompt')).stdout;

  const build = (t, id, body) => t.write(id, 'build.md', `STATUS: READY\n\n${body}\n\n## PR\n#31\n`);

  test('AC-1: from round 2 only CHANGES lenses, code and security rerun; passed lenses are carried', async () => {
    const t = setup();
    const id = await accepted(t, 'ui, security, interaction');
    assert.deepEqual(Object.keys(t.json(id).agents.reviewers).sort(), ['code', 'security', 'ui', 'ux']);
    await startRound(t, id, 1);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'security', 'ui', 'ux'], 'round 1 runs every routed lens');
    assert.deepEqual(t.json(id).carried ?? {}, {});
    verdictFiles(t, id, 1, { code: 'PASS', security: 'PASS', ux: 'PASS', ui: 'CHANGES' });
    ok(t, await t.job(id, 'to', 'build'));
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 2);
    let job = t.json(id);
    assert.deepEqual(job.reviews, { code: 'pending', security: 'pending', ui: 'pending' }, 'ux passed in R1 and does not rerun');
    assert.deepEqual(job.carried, { ux: { verdict: 'PASS', round: 1 } });
    assert.match(await prompt(t, id), /^Review lenses: code, ui, security$/m);

    verdictFiles(t, id, 2, { code: 'PASS', ui: 'PASS' });
    await refused(t, id, 'to', 'approve'); // security always reruns; its R1 PASS does not count
    verdictFiles(t, id, 2, { security: 'PASS' });
    ok(t, await t.job(id, 'to', 'approve'));
    job = t.json(id);
    assert.deepEqual(job.reviews, { code: 'PASS', security: 'PASS', ui: 'PASS' });
    assert.deepEqual(job.carried, { ux: { verdict: 'PASS', round: 1 } });
  });

  test('a ui-only job has no ux lens: round 1 runs code and ui, later rounds carry ui and never spawn ux', async () => {
    const t = setup();
    const id = await accepted(t, 'ui');
    assert.deepEqual(Object.keys(t.json(id).agents.reviewers).sort(), ['code', 'ui']);
    await startRound(t, id, 1);
    verdictFiles(t, id, 1, { code: 'PASS', ui: 'CHANGES' });
    ok(t, await t.job(id, 'to', 'build'));
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 2);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui']);
    assert.match(await prompt(t, id), /^Review lenses: code, ui$/m);
    verdictFiles(t, id, 2, { code: 'PASS', ui: 'PASS' });
    ok(t, await t.job(id, 'to', 'approve'));
    assert.equal(t.json(id).carried, undefined);
  });

  test('an old job.json that routed ux under the old rule keeps running and carrying ux', async () => {
    const t = setup();
    const id = await accepted(t, 'ui');
    const file = join(t.root, 'factory/jobs', id, 'job.json');
    const old = JSON.parse(readFileSync(file, 'utf8'));
    old.agents.reviewers = { code: old.agents.reviewers.code, ux: 'sonnet', ui: old.agents.reviewers.ui };
    writeFileSync(file, `${JSON.stringify(old, null, 2)}\n`);
    await startRound(t, id, 1);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui', 'ux']);
    verdictFiles(t, id, 1, { code: 'PASS', ux: 'PASS', ui: 'CHANGES' });
    ok(t, await t.job(id, 'to', 'build'));
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 2);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui']);
    assert.deepEqual(t.json(id).carried, { ux: { verdict: 'PASS', round: 1 } });
    assert.match(await prompt(t, id), /^Carried: ux from R1$/m);
  });

  test('AC-1: a lens that passed earlier does not need a file in later rounds; any CHANGES triggers build', async () => {
    const t = setup();
    const id = await accepted(t, 'ui, interaction');
    await startRound(t, id, 1);
    verdictFiles(t, id, 1, { code: 'PASS', ux: 'CHANGES', ui: 'PASS' });
    ok(t, await t.job(id, 'to', 'build'));
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 2);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ux']);
    verdictFiles(t, id, 2, { code: 'PASS', ux: 'CHANGES' });
    ok(t, await t.job(id, 'to', 'build')); // ux CHANGES in R2, ui carried PASS
    const job = t.json(id);
    assert.equal(job.round, 3);
    assert.deepEqual(job.history[1], { gate: 'PASS', reviews: { code: 'PASS', ux: 'CHANGES' }, carried: { ui: { verdict: 'PASS', round: 1 } } });
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 3);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ux'], 'ux CHANGES in R2 reruns in R3; ui still carried from R1');
    assert.deepEqual(t.json(id).carried, { ui: { verdict: 'PASS', round: 1 } });
  });

  test('AC-1: after a failed gate, lenses with no verdict yet still run; a human rework starts a full round', async () => {
    const t = setup();
    const id = await accepted(t, 'ui, interaction');
    t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
    ok(t, await t.job(id, 'to', 'build'));
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 2);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui', 'ux'], 'no lens was ever reviewed: all run');
    verdictFiles(t, id, 2, { code: 'PASS', ux: 'PASS', ui: 'PASS' });
    ok(t, await t.job(id, 'to', 'approve'));
    t.write(id, 'decision.md', 'ESCALATE\nA human should look.\n');
    ok(t, await t.job(id, 'to', 'needs-human'));
    t.setPr(31, { reviews: [{ author: { login: 'owner' }, authorAssociation: 'OWNER', state: 'CHANGES_REQUESTED', body: 'Rework the header.' }] });
    ok(t, await t.job(id, 'to', 'build'));
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 3);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui', 'ux'], 'a human round reruns every lens');
    assert.deepEqual(t.json(id).carried ?? {}, {});
  });

  test('AC-2: the round head is recorded at review and the prompt names the previous round head from round 2', async () => {
    const t = setup();
    const id = await accepted(t, 'none');
    const wt = t.json(id).worktree;
    assert.ok(!/^Previous round head:/m.test(await prompt(t, id)), 'round 1 has no previous head');
    writeFileSync(join(wt, 'one.txt'), '1\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'round one work');
    const head1 = git(wt, 'rev-parse', 'HEAD');
    await startRound(t, id, 1);
    assert.deepEqual(t.json(id).round_heads, { 1: head1 });
    verdictFiles(t, id, 1, { code: 'CHANGES' });
    ok(t, await t.job(id, 'to', 'build'));
    writeFileSync(join(wt, 'two.txt'), '2\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'round two work');
    assert.match(await prompt(t, id), new RegExp(`^Previous round head: ${head1}$`, 'm'));
    t.write(id, 'build.md', 'STATUS: READY\n\n## Spec deviations\nNone\n');
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 2);
    assert.deepEqual(t.json(id).round_heads, { 1: head1, 2: git(wt, 'rev-parse', 'HEAD') });
  });
});
