// Spine test (protected in factory/config.json): factory/bin/job, the only writer
// of job.json. Every test builds a throwaway FACTORY_ROOT: a git repo with a bare
// `origin`, a fixture checks.sh, and a fake `gh` that logs its arguments and keeps
// issue/PR state in a JSON file.
// Part of the job scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

  // A job in round 2 whose round 1 code review has a blocker the deviations can cite.
  async function roundTwo(t) {
    const id = await accepted(t, 'none');
    await startRound(t, id, 1);
    t.write(id, 'round-1/review-code.md', 'VERDICT: CHANGES\n\n- [blocker] `app.txt:1`: AC-1 AC-2 AC-3 AC-4 AC-5 wrong\n');
    ok(t, await t.job(id, 'to', 'build'));
    return id;
  }

  const build = (t, id, body) => t.write(id, 'build.md', `STATUS: READY\n\n${body}\n\n## PR\n#31\n`);

  const commitIn = (t, id, rel, text = 'x\n') => {
    const wt = t.json(id).worktree;
    mkdirSync(dirname(join(wt, rel)), { recursive: true });
    writeFileSync(join(wt, rel), text);
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', `touch ${rel}`);
  };

  const editJob = (t, id, fn) => {
    const file = join(t.root, 'factory/jobs', id, 'job.json');
    const job = JSON.parse(readFileSync(file, 'utf8'));
    fn(job);
    writeFileSync(file, `${JSON.stringify(job, null, 2)}\n`);
  };

  const setConfig = (t, fn) => {
    const file = join(t.root, 'factory/config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    fn(config);
    writeFileSync(file, JSON.stringify(config));
  };

  // Round 1 with ux PASS (citing a file), ui CHANGES, code PASS; then round 2's gate.
  async function afterRoundOne(t, id) {
    await startRound(t, id, 1);
    t.write(id, 'round-1/review-ux.md', 'VERDICT: PASS\n\n- [minor] `src/a.css:2`: nit\n');
    t.write(id, 'round-1/review-ui.md', 'VERDICT: CHANGES\n\n- [blocker] `src/b.css:1`: broken\n');
    t.write(id, 'round-1/review-code.md', 'VERDICT: PASS\n');
    ok(t, await t.job(id, 'to', 'build'));
    ok(t, await t.job(id, 'to', 'gate'));
  }

  test('AC-10: the prompt says per lens whether it has an earlier review, and which lenses are carried', async () => {
    const t = setup();
    const id = await accepted(t, 'ui, interaction');
    await afterRoundOne(t, id);
    const out = await prompt(t, id);
    assert.match(out, /^Review lenses: code, ui$/m);
    assert.match(out, /^code: Your previous review: round-1\/review-code\.md$/m);
    assert.match(out, /^ui: Your previous review: round-1\/review-ui\.md$/m);
    assert.match(out, /^Carried: ux from R1$/m);
  });

  test('AC-10: a lens reviewing for the first time at round 2 (gate failure, human rework, newly routed) gets "First review for this lens"', async () => {
    const t = setup();
    const id = await accepted(t, 'none');
    t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
    ok(t, await t.job(id, 'to', 'build'));
    assert.match(await prompt(t, id), /^code: First review for this lens$/m, 'gate failure');
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 2);
    editJob(t, id, (j) => { j.agents.reviewers.security = 'opus'; }); // security newly routed mid-job
    verdictFiles(t, id, 2, { code: 'PASS' });
    assert.match(await prompt(t, id), /^security: First review for this lens$/m, 'newly routed lens');
    await refused(t, id, 'to', 'approve'); // review-security.md is required
    verdictFiles(t, id, 2, { security: 'PASS' });
    ok(t, await t.job(id, 'to', 'approve'));
    t.write(id, 'decision.md', 'ESCALATE\nA human should look.\n');
    ok(t, await t.job(id, 'to', 'needs-human'));
    t.setPr(31, { reviews: [{ author: { login: 'owner' }, authorAssociation: 'OWNER', state: 'CHANGES_REQUESTED', body: 'Rework it.' }] });
    ok(t, await t.job(id, 'to', 'build'));
    const out = await prompt(t, id);
    assert.match(out, /^code: First review for this lens$/m, 'human rework reviews the whole change');
    assert.match(out, /^security: First review for this lens$/m);
  });

  test('AC-11: a carried lens reruns when the round diff touches a file its review cites; otherwise it stays carried', async () => {
    const t = setup();
    const id = await accepted(t, 'ui, interaction');
    await afterRoundOne(t, id);
    commitIn(t, id, 'docs/notes.md'); // documentation never wakes a carried lens
    await startRound(t, id, 2);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui']);
    assert.deepEqual(t.json(id).carried, { ux: { verdict: 'PASS', round: 1 } });
    verdictFiles(t, id, 2, { code: 'PASS', ui: 'CHANGES' });
    ok(t, await t.job(id, 'to', 'build'));
    commitIn(t, id, 'src/a.css'); // cited by ux in round 1
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 3);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui', 'ux'], 'ux reruns because src/a.css changed');
    assert.deepEqual(t.json(id).carried ?? {}, {});
  });

  test('AC-11: config.review_paths makes a carried lens rerun when the diff matches its globs', async () => {
    const t = setup();
    const id = await accepted(t, 'ui, interaction');
    setConfig(t, (cfg) => { cfg.review_paths = { ux: ['web/**/*.css', 'pages/*.html'] }; });
    await afterRoundOne(t, id);
    commitIn(t, id, 'web/deep/dir/x.css');
    await startRound(t, id, 2);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui', 'ux']);
    verdictFiles(t, id, 2, { code: 'PASS', ui: 'CHANGES', ux: 'PASS' });
    ok(t, await t.job(id, 'to', 'build'));
    commitIn(t, id, 'pages/sub/y.html'); // `pages/*.html` does not match a nested path
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 3);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui']);
    assert.deepEqual(t.json(id).carried, { ux: { verdict: 'PASS', round: 2 } });
  });

  test('AC-12: when a round head cannot be recorded the job warns and the next prompt says it is unknown, with no older head', async () => {
    const t = setup();
    const id = await accepted(t, 'ui, interaction');
    await startRound(t, id, 1); // head of round 1 recorded
    verdictFiles(t, id, 1, { code: 'PASS', ux: 'PASS', ui: 'CHANGES' });
    ok(t, await t.job(id, 'to', 'build'));
    ok(t, await t.job(id, 'to', 'gate'));
    const wt = t.json(id).worktree;
    git(t.root, 'worktree', 'remove', '--force', wt);
    t.write(id, 'round-2/checks.md', 'GATE: PASS\n');
    const res = await t.job(id, 'to', 'review');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /could not record the head of round 2/);
    assert.equal(t.json(id).round_heads[2], null);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui', 'ux'], 'round 2: no way to diff, so ux reruns');
    verdictFiles(t, id, 2, { code: 'CHANGES', ui: 'PASS', ux: 'PASS' });
    ok(t, await t.job(id, 'to', 'build'));
    const out = await prompt(t, id);
    assert.match(out, /^Previous round head: unknown \(review the full change\)$/m);
    assert.ok(!/Previous round head: [0-9a-f]{7,}/.test(out));
    assert.match(out, /^Review lenses: code, ux, ui$/m, 'with no way to diff, carried lenses rerun');
  });

  test('AC-13: a lens removed from the routing after CHANGES blocks approve until a human reworks it', async () => {
    const t = setup();
    const id = await accepted(t, 'ui, interaction');
    await startRound(t, id, 1);
    verdictFiles(t, id, 1, { code: 'PASS', ux: 'PASS' });
    t.write(id, 'round-1/review-ui.md', 'VERDICT: CHANGES\n\n- [blocker] `src/b.css:1`: broken\n');
    ok(t, await t.job(id, 'to', 'build'));
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 2);
    editJob(t, id, (j) => { delete j.agents.reviewers.ui; });
    verdictFiles(t, id, 2, { code: 'PASS', ux: 'PASS' });
    await refused(t, id, 'to', 'approve');
    const res = await t.job(id, 'to', 'approve');
    assert.match(res.stderr, /review-ui asked for CHANGES and is no longer routed/);
  });

  test('AC-14: a passed lens is carried across a gate-failure round and across a human rework round', async () => {
    const t = setup();
    const id = await accepted(t, 'ui, interaction');
    await afterRoundOne(t, id); // R2 gate
    t.write(id, 'round-2/checks.md', 'GATE: FAIL\n');
    ok(t, await t.job(id, 'to', 'build'));
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 3);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui']);
    assert.deepEqual(t.json(id).carried, { ux: { verdict: 'PASS', round: 1 } }, 'ux carried across the failed round 2');
    verdictFiles(t, id, 3, { code: 'PASS', ui: 'PASS' });
    ok(t, await t.job(id, 'to', 'approve'));
    t.write(id, 'decision.md', 'ESCALATE\nA human should look.\n');
    ok(t, await t.job(id, 'to', 'needs-human'));
    t.setPr(31, { reviews: [{ author: { login: 'owner' }, authorAssociation: 'OWNER', state: 'CHANGES_REQUESTED', body: 'Rework it.' }] });
    ok(t, await t.job(id, 'to', 'build')); // round 4, a full round
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 4);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui', 'ux']);
    verdictFiles(t, id, 4, { code: 'PASS', ux: 'PASS', ui: 'CHANGES' });
    ok(t, await t.job(id, 'to', 'build'));
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 5);
    assert.deepEqual(t.json(id).carried, { ux: { verdict: 'PASS', round: 4 } }, 'carried from the rework round, not from round 1');
  });

  test('AC-14: in the last round a rerun CHANGES cannot go back to build, and approve is allowed with the carried PASS', async () => {
    const t = setup();
    const id = await accepted(t, 'ui, interaction');
    await afterRoundOne(t, id);
    await startRound(t, id, 2);
    verdictFiles(t, id, 2, { code: 'PASS', ui: 'CHANGES' });
    ok(t, await t.job(id, 'to', 'build'));
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 3);
    assert.equal(t.json(id).round, t.json(id).max_rounds);
    verdictFiles(t, id, 3, { code: 'PASS', ui: 'CHANGES' });
    await refused(t, id, 'to', 'build');
    ok(t, await t.job(id, 'to', 'approve'));
    assert.deepEqual(t.json(id).reviews, { code: 'PASS', ui: 'CHANGES' });
  });

  test('AC-15: build>gate and gate>review refuse until the deviations are settled, naming the status', async () => {
    const t = setup();
    const id = await roundTwo(t);
    const reason = async (...args) => { const r = await t.job(id, ...args); assert.equal(r.status, 1); return r.stderr; };
    t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n');
    assert.match(await reason('to', 'gate'), /invalid: missing Spec deviations section/);
    build(t, id, '## Spec deviations\nfree text');
    assert.match(await reason('to', 'gate'), /invalid: 4/);
    build(t, id, '## Spec deviations\nAC-1 | Design: a -> b (because)');
    assert.match(await reason('to', 'gate'), /unverified: AC-1/);
    build(t, id, '## Spec deviations\nAC-1 | Design: a -> b (code round 1)');
    assert.match(await reason('to', 'gate'), /needed: AC-1/);
    build(t, id, '## Spec deviations\nGoal | the feature also does Y (code round 1)');
    assert.match(await reason('to', 'gate'), /changes the Goal.*to needs-human/s);
    build(t, id, '## Spec deviations\nNone');
    ok(t, await t.job(id, 'to', 'gate'));
    t.write(id, 'round-2/checks.md', 'GATE: PASS\n');
    build(t, id, '## Spec deviations\nAC-1 | Design: a -> b (code round 1)'); // changed after the gate, with no amend
    assert.match(await reason('to', 'review'), /needed: AC-1/);
    build(t, id, '## Spec deviations\nNone');
    ok(t, await t.job(id, 'to', 'review'));
  });

  test('AC-11: without review_paths a carried lens reruns on any non-doc, non-test change, and a renamed file counts by its old path', async () => {
    const t = setup();
    setConfig(t, (cfg) => { delete cfg.review_paths; }); // the adapter opts out of the savings
    const id = await accepted(t, 'ui, interaction');
    commitIn(t, id, 'src/a.css');
    await afterRoundOne(t, id);
    commitIn(t, id, 'test/foo.test.js');
    await startRound(t, id, 2);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui'], 'tests do not wake ux');
    verdictFiles(t, id, 2, { code: 'PASS', ui: 'CHANGES' });
    ok(t, await t.job(id, 'to', 'build'));
    commitIn(t, id, 'src/unrelated.js');
    ok(t, await t.job(id, 'to', 'gate'));
    await startRound(t, id, 3);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui', 'ux'], 'a code file wakes ux when the adapter has no review_paths');
  });

  test('AC-11: a rename is seen by both its old and its new path', async () => {
    const t = setup();
    setConfig(t, (cfg) => { cfg.review_paths = { ux: ['nothing/**'] }; }); // only the cited-path rule can wake ux
    const id = await accepted(t, 'ui, interaction');
    commitIn(t, id, 'src/a.css');
    await afterRoundOne(t, id); // ux cites src/a.css
    const wt = t.json(id).worktree;
    git(wt, 'mv', 'src/a.css', 'src/z.css');
    git(wt, 'commit', '-q', '-m', 'rename');
    await startRound(t, id, 2);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui', 'ux']);
  });
});
