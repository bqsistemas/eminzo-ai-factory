// Spine test (protected in factory/config.json): factory/bin/job, the only writer
// of job.json. Every test builds a throwaway FACTORY_ROOT: a git repo with a bare
// `origin`, a fixture checks.sh, and a fake `gh` that logs its arguments and keeps
// issue/PR state in a JSON file.
// Part of the job scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ok, refused, INTAKE } from './helpers/job-harness.js';

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

  const amendOf = async (t, id) => (await t.job(id, 'amend')).stdout.trim();

  test('AC-3: job-040 conflict. R1 ui CHANGES, R2 builder deviates because of ui, code PASS, ui PASS: reaches approve in round 2', async () => {
    const t = setup();
    const id = await accepted(t, 'ui, interaction');
    await startRound(t, id, 1);
    verdictFiles(t, id, 1, { code: 'PASS', ux: 'PASS' });
    t.write(id, 'round-1/review-ui.md', 'VERDICT: CHANGES\n\n## Findings\n- [blocker] `src/header.css:3`: AC-2: the long label overflows at 360px -> shorten it\n');
    ok(t, await t.job(id, 'to', 'build'));
    t.write(id, 'build.md', [
      'STATUS: READY', '', '# Build (round 2)', '',
      '## Spec deviations',
      'AC-2 | Design: header shows "N/A" instead of "Unavailable" -> ui round 1 blocker: the long label overflowed at 360px', '',
      '## PR', '#31', '',
    ].join('\n'));
    await refused(t, id, 'to', 'gate'); // the AC deviation is not amended yet
    const amend = await t.job(id, 'amend');
    assert.equal(amend.status, 0, amend.stderr);
    assert.equal(amend.stdout.trim(), 'needed: AC-2');
    t.write(id, 'spec.md', '# Spec\n\n## Amendments\n- R2 | AC-2 | Unavailable -> N/A | ui round 1 blocker\n');
    ok(t, await t.job(id, 'to', 'gate'));
    assert.equal((await t.job(id, 'amend')).stdout.trim(), 'none');
    await startRound(t, id, 2);
    assert.deepEqual(Object.keys(t.json(id).reviews).sort(), ['code', 'ui']);
    // The deviation was forced by ui and the Goal still holds, so code does not block on it.
    verdictFiles(t, id, 2, { code: 'PASS', ui: 'PASS' });
    ok(t, await t.job(id, 'to', 'approve'));
    const job = t.json(id);
    assert.equal(job.stage, 'approve');
    assert.equal(job.round, 2);
    assert.deepEqual(job.reviews, { code: 'PASS', ui: 'PASS' });
    assert.deepEqual(job.carried, { ux: { verdict: 'PASS', round: 1 } });
  });

  test('AC-3: job amend lists only AC deviations, ignores None, and is quiet once spec.md logs every AC of the round', async () => {
    const t = setup();
    const id = await roundTwo(t);
    build(t, id, '## Spec deviations\nNone');
    assert.equal(await amendOf(t, id), 'none');
    build(t, id, '## Spec deviations\nDesign | Used a map instead of a list in app.txt -> code round 1 blocker');
    assert.equal(await amendOf(t, id), 'none', 'a Design-only deviation does not change an AC');
    build(t, id, '## Spec deviations\n- AC-3 | Design: a -> b (code round 1)\nAC-1 | Design: c -> d (code round 1)\nDesign | e -> f in app.txt (code R1)');
    assert.equal(await amendOf(t, id), 'needed: AC-1, AC-3');
    t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n');
    assert.equal(await amendOf(t, id), 'invalid: missing Spec deviations section', 'the section is mandatory');
    t.write(id, 'build.md', 'STATUS: READY\n\n```\nunclosed fence\n\n### Spec deviations:\nNone\n');
    assert.equal(await amendOf(t, id), 'none', 'an unclosed fence does not hide the heading; a trailing colon is fine');
    t.write(id, 'build.md', 'STATUS: READY\n\n#### SPEC DEVIATIONS (round 2)\nNone\n');
    assert.equal(await amendOf(t, id), 'none', 'case-insensitive prefix match at any level');
    build(t, id, '## Spec deviations\nAC-1 | Design: c -> d (code round 1)\nAC-2 | Design: e -> f (code round 1)');
    t.write(id, 'spec.md', '# Spec\n\n## Amendments\n- R2 | AC-1 | c -> d | code blocker\n');
    assert.equal(await amendOf(t, id), 'needed: AC-2', 'every needed AC must have an entry for the round');
    t.write(id, 'spec.md', '# Spec\n\n## Amendments\n- R2 | AC-1 | c -> d | x\n- R2 | AC-2 | e -> f | x\n');
    assert.equal(await amendOf(t, id), 'none');
    t.write(id, 'spec.md', '# Spec\n\n## Amendments\n- R2 | AC-1, AC-2 | c -> d | one entry for both\n');
    assert.equal(await amendOf(t, id), 'none', 'comma-separated ids count');
    t.write(id, 'spec.md', '# Spec\n\n## Amendments\n- R1 | AC-1 | c -> d | x\n- R1 | AC-2 | e -> f | x\n');
    assert.equal(await amendOf(t, id), 'needed: AC-1, AC-2', 'an entry for another round does not count');
    t.write(id, 'spec.md', '# Spec\n\n## Notes\n- R2 | AC-1 | c -> d | outside the section\n- R2 | AC-2 | e -> f | outside\n');
    assert.equal(await amendOf(t, id), 'needed: AC-1, AC-2', 'marker-like lines outside ## Amendments do not count');
  });

  test('AC-3: amend parses the usual prefixes and heading levels, skips code fences, and fails closed on anything else', async () => {
    const t = setup();
    const id = await roundTwo(t);
    const cite = '(code round 1)';
    build(t, id, `### Spec deviations\n**AC-1** | Design: a -> b ${cite}\n\`AC-2\` | Design: a -> b ${cite}\n1. AC-3 | Design: a -> b ${cite}\n- [x] AC-4 | Design: a -> b ${cite}\n* **\`AC-5\`** | ${cite}`);
    assert.equal(await amendOf(t, id), 'needed: AC-1, AC-2, AC-3, AC-4, AC-5');
    build(t, id, `## Spec deviations\n\`\`\`\n## Not a heading\nAC-1 | Design: a -> b ${cite}\n\`\`\`\nNone`);
    assert.equal(await amendOf(t, id), 'needed: AC-1', 'a heading inside a fence does not end the section');
    // Line 1 is STATUS, line 2 is blank, line 3 is the heading: the text is line 4.
    build(t, id, '## Spec deviations\nThe builder changed the header');
    assert.equal(await amendOf(t, id), 'invalid: 4', 'free text is invalid, reported by line number');
    build(t, id, '## Spec deviations\nNone\nAC-2 changed it (code round 1)\nsome prose');
    assert.equal(await amendOf(t, id), 'invalid: 6\nneeded: AC-2');
  });

  test('AC-3: a deviation must cite a lens and an earlier round whose review has that [blocker] line; otherwise it is unverified', async () => {
    const t = setup();
    const id = await roundTwo(t);
    build(t, id, '## Spec deviations\nAC-1 | Design: a -> b (code round 1)');
    assert.equal(await amendOf(t, id), 'needed: AC-1', 'cited blocker exists');
    build(t, id, '## Spec deviations\nAC-1 | Design: a -> b (because I preferred it)');
    assert.equal(await amendOf(t, id), 'unverified: AC-1\nneeded: AC-1', 'no citation');
    build(t, id, '## Spec deviations\nAC-1 | Design: a -> b (ui round 1)');
    assert.equal(await amendOf(t, id), 'unverified: AC-1\nneeded: AC-1', 'ui has no review in round 1');
    build(t, id, '## Spec deviations\nAC-1 | Design: a -> b (code round 2)');
    assert.equal(await amendOf(t, id), 'unverified: AC-1\nneeded: AC-1', 'round 2 is not an earlier round');
    t.write(id, 'round-1/review-security.md', 'VERDICT: CHANGES\n\n- [blocker] `auth.js:9`: the token is logged\n');
    build(t, id, '## Spec deviations\nAC-3 | Design: a -> b (security round 1)');
    assert.equal(await amendOf(t, id), 'unverified: AC-3\nneeded: AC-3', 'an unrelated security blocker cannot downgrade AC-3');
    build(t, id, '## Spec deviations\nAC-3 | Design: stop logging the token in auth.js (security round 1)');
    assert.equal(await amendOf(t, id), 'needed: AC-3', 'a blocker that shares a file path with the deviation verifies it');
    t.write(id, 'round-1/review-code.md', 'VERDICT: CHANGES\n\n- [minor] `app.txt:1`: AC-1 nit\n');
    build(t, id, '## Spec deviations\nDesign | a -> b in app.txt (code round 1)');
    assert.equal(await amendOf(t, id), 'unverified: Design', 'a [minor] line is not a blocker');
  });

  test('AC-3: a deviation that names the Goal, or a Goal amendment entry, makes amend print escalate', async () => {
    const t = setup();
    const id = await roundTwo(t);
    build(t, id, '## Spec deviations\nGoal | the feature now also does Y (code round 1)');
    assert.match(await amendOf(t, id), /^escalate$/m);
    build(t, id, '## Spec deviations\nAC-1 | Design: a -> b (code round 1)');
    t.write(id, 'spec.md', '# Spec\n\n## Amendments\n- R2 | Goal | unchanged | deviation changes the Goal; a human must decide\n');
    assert.match(await amendOf(t, id), /^escalate$/m);
    t.write(id, 'spec.md', '# Spec\n\n## Amendments\n- R2 | AC-1 | a -> b | x\n');
    assert.equal(await amendOf(t, id), 'none');
  });
  // --- review hardening: prompt lines, carried reruns, unrouted lenses, head failures ---
});
