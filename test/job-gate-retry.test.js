// A failed gate goes back to build inside the same round: it does not burn a review round.
// `checks.max_gate_retries` (default 3) bounds how many times a job may do that, in total.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repo, setup, ok, refused, intaken, xsToBuild, xsToGate } from './helpers/lane-xs-harness.js';

const READY = 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n';

async function atGate(t) {
  const id = await intaken(t, { intake: { size: 'm' } });
  ok(t, await t.job(id, 'to', 'spec'));
  t.write(id, 'spec.md', '# Spec\n');
  ok(t, await t.job(id, 'to', 'build'));
  await xsToGate(t, id, 31, READY);
  return id;
}

const setConfig = (t, fn) => {
  const file = join(t.root, 'factory/config.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  fn(cfg);
  writeFileSync(file, JSON.stringify(cfg));
};

// The routed lenses of a ui job all review; code asks for CHANGES.
function changes(t, id) {
  for (const lens of Object.keys(t.json(id).reviews)) {
    t.write(id, `round-1/review-${lens}.md`, lens === 'code' ? 'VERDICT: CHANGES\n\n- [blocker] x.js:1 wrong\n' : 'VERDICT: PASS\n');
  }
}

// One failed gate and the way back to build: the builder then writes a fresh build.md and the job returns to gate.
async function failGate(t, id, n = 1) {
  t.write(id, `round-${t.json(id).round}/checks.md`, `GATE: FAIL\n\nattempt ${n}\n`);
  t.write(id, `round-${t.json(id).round}/checks.log`, `log ${n}\n`);
  ok(t, await t.job(id, 'to', 'build'));
}
async function backToGate(t, id) {
  t.write(id, 'build.md', READY);
  ok(t, await t.job(id, 'to', 'gate'));
}

describe('gate>build keeps the round', { concurrency: true }, () => {
  test('AC-1: the round does not advance; the counter goes up and the stage is build', async () => {
    const t = setup();
    const id = await atGate(t);
    await failGate(t, id);
    const job = t.json(id);
    assert.equal(job.stage, 'build');
    assert.equal(job.round, 1);
    assert.equal(job.gate_retries, 1);
    assert.equal(job.gate, null);
    assert.deepEqual(job.history ?? [], []);
  });

  test('AC-2: the failed report and log are archived in the same round folder, so the next gate writes a fresh checks.md', async () => {
    const t = setup();
    const id = await atGate(t);
    await failGate(t, id);
    assert.match(t.read(id, 'round-1/gate-fail-1.md'), /^GATE: FAIL\n\nattempt 1/);
    assert.equal(t.read(id, 'round-1/gate-fail-1.log'), 'log 1\n');
    assert.equal(existsSync(join(t.root, 'factory/jobs', id, 'round-1/checks.md')), false);
    assert.equal(existsSync(join(t.root, 'factory/jobs', id, 'round-1/checks.log')), false);
    await backToGate(t, id);
    await failGate(t, id, 2);
    assert.match(t.read(id, 'round-1/gate-fail-2.md'), /attempt 2/);
    assert.match(t.read(id, 'round-1/gate-fail-1.md'), /attempt 1/);
  });

  test('AC-2b: visual.md is archived as gate-fail-<k>.visual.md, so a later attempt never inherits it; context.md is rewritten by every gate and stays', async () => {
    const t = setup();
    const id = await atGate(t);
    t.write(id, 'round-1/visual.md', 'VISUAL: FAIL\n');
    t.write(id, 'round-1/context.md', 'ctx\n');
    await failGate(t, id);
    assert.equal(t.read(id, 'round-1/gate-fail-1.visual.md'), 'VISUAL: FAIL\n');
    assert.equal(existsSync(join(t.root, 'factory/jobs', id, 'round-1/visual.md')), false);
    assert.equal(t.read(id, 'round-1/context.md'), 'ctx\n');
    await backToGate(t, id);
    await failGate(t, id, 2); // no visual.md this time: nothing to archive, nothing breaks
    assert.equal(existsSync(join(t.root, 'factory/jobs', id, 'round-1/gate-fail-2.visual.md')), false);
  });

  test('AC-3: build.md moves to round-N/build-gate-fail-<k>.md and to gate needs a fresh one', async () => {
    const t = setup();
    const id = await atGate(t);
    t.write(id, 'build.md', `${READY}\n## Notes for the next round\nkeep me\n`);
    await failGate(t, id);
    assert.equal(existsSync(join(t.root, 'factory/jobs', id, 'build.md')), false);
    assert.match(t.read(id, 'round-1/build-gate-fail-1.md'), /keep me/);
    await refused(t, id, 'to', 'gate'); // no build.md
    await backToGate(t, id);
    assert.equal(t.json(id).stage, 'gate');
  });

  test('AC-4: a gate that passes after a retry continues in the same round', async () => {
    const t = setup();
    const id = await atGate(t);
    await failGate(t, id);
    await backToGate(t, id);
    t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
    ok(t, await t.job(id, 'to', 'review'));
    assert.equal(t.json(id).round, 1);
    assert.equal(t.json(id).gate, 'PASS');
  });

  test('AC-5: past checks.max_gate_retries (default 3) it is refused, naming the key and the needs-human command', async () => {
    const t = setup();
    const id = await atGate(t);
    for (let n = 1; n <= 3; n += 1) {
      await failGate(t, id, n);
      await backToGate(t, id);
    }
    assert.equal(t.json(id).gate_retries, 3);
    t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
    const before = t.raw(id);
    const res = await t.job(id, 'to', 'build');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /checks\.max_gate_retries/);
    assert.match(res.stderr, /to needs-human --note "gate failed 4 times"/);
    assert.equal(t.raw(id), before);
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'gate failed 4 times'));
  });

  test('AC-6: a custom checks.max_gate_retries is honored; an invalid one falls back to 3', async () => {
    const t = setup();
    setConfig(t, (cfg) => { cfg.checks = { ...cfg.checks, max_gate_retries: 1 }; });
    const id = await atGate(t);
    await failGate(t, id);
    await backToGate(t, id);
    t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
    const res = await t.job(id, 'to', 'build');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /checks\.max_gate_retries \(1\)/);

    const u = setup();
    setConfig(u, (cfg) => { cfg.checks = { ...cfg.checks, max_gate_retries: 'many' }; });
    const uid = await atGate(u);
    for (let n = 1; n <= 3; n += 1) { await failGate(u, uid, n); await backToGate(u, uid); }
    u.write(uid, 'round-1/checks.md', 'GATE: FAIL\n');
    assert.equal((await u.job(uid, 'to', 'build')).status, 1);
  });

  test('AC-7: the gate retries do not use max_rounds: a job at its last round still retries a gate', async () => {
    const t = setup();
    setConfig(t, (cfg) => { cfg.max_rounds = 1; });
    const id = await atGate(t);
    await failGate(t, id);
    assert.equal(t.json(id).round, 1);
    assert.equal(t.json(id).stage, 'build');
  });

  test('AC-8: review>build still advances the round and gate retries are kept', async () => {
    const t = setup();
    const id = await atGate(t);
    await failGate(t, id);
    await backToGate(t, id);
    t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
    ok(t, await t.job(id, 'to', 'review'));
    changes(t, id);
    ok(t, await t.job(id, 'to', 'build'));
    assert.equal(t.json(id).round, 2);
    assert.equal(t.json(id).gate_retries, 1);
  });

  test('AC-9: the prompt of a build after a gate retry names the report to read; a fresh round does not', async () => {
    const t = setup();
    const id = await atGate(t);
    assert.doesNotMatch(ok(t, await t.job(id, 'prompt')), /Gate failed/);
    await failGate(t, id);
    assert.match(ok(t, await t.job(id, 'prompt')), /^Gate failed: read round-1\/gate-fail-1\.md$/m);
    await backToGate(t, id);
    await failGate(t, id, 2);
    assert.match(ok(t, await t.job(id, 'prompt')), /^Gate failed: read round-1\/gate-fail-2\.md$/m);
    await backToGate(t, id);
    t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
    ok(t, await t.job(id, 'to', 'review'));
    changes(t, id);
    ok(t, await t.job(id, 'to', 'build'));
    assert.doesNotMatch(ok(t, await t.job(id, 'prompt')), /Gate failed/);
  });

  test('AC-10: a human rework of a parked job starts with a fresh gate budget', async () => {
    const t = setup();
    const id = await atGate(t);
    for (let n = 1; n <= 3; n += 1) { await failGate(t, id, n); await backToGate(t, id); }
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'gate failed 3 times'));
    ok(t, await t.job(id, 'to', 'build'));
    assert.equal(t.json(id).gate_retries, 0);
  });

  test('AC-11: the builder role and both skills describe the retry', () => {
    const read = (f) => readFileSync(join(repo, f), 'utf8');
    assert.match(read('factory/roles/builder.md'), /Gate failed: read round-<N>\/gate-fail-<k>\.md/);
    for (const f of ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md']) {
      const text = read(f);
      assert.match(text, /gate-fail-<k>\.md/, f);
      assert.match(text, /checks\.max_gate_retries/, f);
      assert.match(text, /to needs-human --note "gate failed <n> times"/, f);
      assert.doesNotMatch(text, /a gate failure uses one/, f);
    }
  });
});

describe('lane xs retries the gate inside the lane', { concurrency: true }, () => {
  test('AC-1: an xs job with GATE: FAIL goes gate>build, stays xs and keeps round 1', async () => {
    const t = setup();
    const id = await xsToBuild(t);
    await xsToGate(t, id, 31, READY);
    await failGate(t, id);
    const job = t.json(id);
    assert.equal(job.stage, 'build');
    assert.equal(job.lane, 'xs');
    assert.equal(job.round, 1);
    assert.equal(job.gate_retries, 1);
    assert.match(t.read(id, 'round-1/gate-fail-1.md'), /^GATE: FAIL/);
    assert.match(ok(t, await t.job(id, 'prompt')), /^Gate failed: read round-1\/gate-fail-1\.md$/m);
    assert.match(ok(t, await t.job(id, 'prompt')), /^Lane: xs$/m);
    await backToGate(t, id);
    t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
    ok(t, await t.job(id, 'to', 'review'));
  });

  test('AC-2: past the budget the xs job is refused with the needs-human command, not promote, and goes to needs-human', async () => {
    const t = setup();
    setConfig(t, (cfg) => { cfg.checks = { ...cfg.checks, max_gate_retries: 1 }; });
    const id = await xsToBuild(t);
    await xsToGate(t, id, 31, READY);
    await failGate(t, id);
    await backToGate(t, id);
    t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
    const res = await t.job(id, 'to', 'build');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /checks\.max_gate_retries/);
    assert.match(res.stderr, /to needs-human --note "gate failed 2 times"/);
    assert.doesNotMatch(res.stderr, /promote/);
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'gate failed 2 times'));
  });

  test('AC-3: promote still works from a failed xs gate and for the other triggers; review CHANGES still refuses to build', async () => {
    const t = setup();
    const id = await xsToBuild(t);
    await xsToGate(t, id, 31, READY);
    t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
    ok(t, await t.job(id, 'promote'));
    assert.equal(t.json(id).lane, 'normal');

    const u = setup();
    const uid = await xsToBuild(u);
    await xsToGate(u, uid, 31, READY);
    u.write(uid, 'round-1/checks.md', 'GATE: PASS\n');
    ok(u, await u.job(uid, 'to', 'review'));
    u.write(uid, 'round-1/review-code.md', 'VERDICT: CHANGES\n');
    await refused(u, uid, 'to', 'build');
    assert.match((await u.job(uid, 'to', 'build')).stderr, /promote/);

    const w = setup();
    const wid = await xsToBuild(w);
    w.write(wid, 'build.md', 'STATUS: READY\n\n## Spec deviations\nAC-1 | Design: moved\n');
    w.pr(31, `factory/${wid}`);
    assert.match((await w.job(wid, 'to', 'gate')).stderr, /promote/);
  });

  test('AC-4: both skills no longer list GATE: FAIL as an xs promotion trigger', () => {
    for (const f of ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md']) {
      const text = readFileSync(join(repo, f), 'utf8');
      const rule = text.slice(text.indexOf('<!-- rule: xs-promotion -->')).slice(0, 700);
      assert.doesNotMatch(rule, /the usual way back: `GATE: FAIL`/, f);
      assert.match(rule, /VERDICT: CHANGES/, f);
      assert.match(text.slice(text.indexOf('<!-- rule: lane-xs -->')).slice(0, 2200), /gate (is )?retr/i, f);
    }
  });
});
