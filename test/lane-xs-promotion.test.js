// Plan P0-6: the XS lane. Intake sizes the change, the script decides the lane, an XS job
// skips the spec, runs one round and is promoted to the normal lane on the first failure.
// The fake-gh harness is copied from test/job-merge.test.js; setup lives in test/helpers/lane-xs-harness.js.
// Part of the lane-xs scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repo, configText, git, setup, ok, refused, config, LABELED, intaken, xsToBuild, xsToGate, approveScript, toApprove } from './helpers/lane-xs-harness.js';

describe('P0-6: promotion to the normal lane', { concurrency: true }, () => {
  // Each trigger leaves the job at a different stage; promote is the only way forward.
  const triggers = {
    'gate FAIL': async (t, id) => {
      await xsToGate(t, id);
      t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
    },
    'review CHANGES': async (t, id) => {
      await xsToGate(t, id);
      t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
      ok(t, await t.job(id, 'to', 'review'));
      t.write(id, 'round-1/review-code.md', 'VERDICT: CHANGES\n\n- [blocker] x.js:1 wrong\n');
    },
    'builder STATUS: BLOCKED': async (t, id) => {
      t.write(id, 'build.md', 'STATUS: BLOCKED\n\nNeeds a new file.\n');
    },
    'unsettled amend': async (t, id) => {
      t.write(id, 'build.md', 'STATUS: READY\n\n## Spec deviations\nAC-1 | Design: moved\n');
    },
    'approver script inconclusive': async (t, id) => {
      await xsToGate(t, id);
      t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
      ok(t, await t.job(id, 'to', 'review'));
      t.write(id, 'round-1/review-code.md', 'VERDICT: PASS\n');
      ok(t, await t.job(id, 'to', 'approve'));
    },
  };

  for (const [name, arrange] of Object.entries(triggers)) {
    test(`promote after ${name}: lane normal, promoted_from xs, stage spec, round 2 and the XS round kept as round 1`, async () => {
      const t = setup();
      const id = await xsToBuild(t);
      await arrange(t, id);
      assert.equal(ok(t, await t.job(id, 'promote')), `${id} spec`);
      const job = t.json(id);
      assert.equal(job.lane, 'normal');
      assert.equal(job.promoted_from, 'xs');
      assert.equal(job.stage, 'spec');
      assert.equal(job.round, 2, 'the XS round counted as round 1');
      assert.equal(job.history.length, 1);
      assert.equal(job.max_rounds, 3);
      assert.equal(job.gate, null);
      assert.deepEqual(job.reviews, {});
      // reviewers re-routed by the intake surfaces (ui): code and ui (ui covers UX)
      assert.deepEqual(Object.keys(job.agents.reviewers).sort(), ['code', 'ui']);
      assert.equal(job.agents.builder, 'sonnet');
      assert.equal(job.agents.reviewers.code, 'haiku');
      assert.equal(job.models['spec-writer'], 'sonnet', 'low risk spec-writer');
      assert.equal(job.models.approver, 'script');
      assert.ok(job.pr || name === 'builder STATUS: BLOCKED' || name === 'unsettled amend');
    });
  }

  test('the history keeps what the XS round produced', async () => {
    const t = setup();
    const id = await xsToBuild(t);
    await triggers['review CHANGES'](t, id);
    ok(t, await t.job(id, 'promote'));
    const [xsRound] = t.json(id).history;
    assert.equal(xsRound.gate, 'PASS');
    assert.deepEqual(xsRound.reviews, { code: 'CHANGES' });
  });

  test('after promote the spec-writer builds spec.md, spec to build keeps round 2, and rounds 2 and 3 are all that is left', async () => {
    const t = setup();
    const id = await xsToBuild(t);
    await triggers['gate FAIL'](t, id);
    ok(t, await t.job(id, 'promote'));
    await refused(t, id, 'to', 'build'); // spec.md is still missing
    t.write(id, 'spec.md', '# Spec\n');
    ok(t, await t.job(id, 'to', 'build'));
    assert.equal(t.json(id).round, 2, 'the round counter continued');
    assert.match(ok(t, await t.job(id, 'prompt')), /^Promoted from: xs$/m);
    assert.doesNotMatch(ok(t, await t.job(id, 'prompt')), /^Lane: xs$/m);
    // normal-lane rounds from here
    t.write(id, 'build.md', 'STATUS: READY\n\n## Spec deviations\nNone\n');
    ok(t, await t.job(id, 'to', 'gate'));
    t.write(id, 'round-2/checks.md', 'GATE: FAIL\n');
    ok(t, await t.job(id, 'to', 'build'));
    assert.equal(t.json(id).round, 3);
    t.write(id, 'build.md', 'STATUS: READY\n\n## Spec deviations\nNone\n');
    ok(t, await t.job(id, 'to', 'gate'));
    t.write(id, 'round-3/checks.md', 'GATE: FAIL\n');
    await refused(t, id, 'to', 'build'); // max_rounds 3 counts the XS round
  });

  test('promote refuses jobs that are not in lane xs, jobs past review, and jobs with no round left', async () => {
    const t = setup();
    const id = await intaken(t, { intake: { size: 'm' } });
    ok(t, await t.job(id, 'to', 'spec'));
    await refused(t, id, 'promote'); // normal lane

    const t2 = setup();
    const id2 = await intaken(t2, { labels: LABELED });
    await refused(t2, id2, 'promote'); // still at intake: no lane yet
    ok(t2, await t2.job(id2, 'to', 'build'));
    ok(t2, await t2.job(id2, 'promote'));
    await refused(t2, id2, 'promote'); // already promoted

    const t3 = setup();
    const cfg = JSON.parse(configText);
    cfg.max_rounds = 1;
    writeFileSync(join(t3.root, 'factory/config.json'), JSON.stringify(cfg));
    const id3 = await xsToBuild(t3);
    await refused(t3, id3, 'promote');
    assert.match((await t3.job(id3, 'promote')).stderr, /no round left|needs-human/);
  });

  test('a promoted job can be promoted at most once and has no xs guard on its rounds', async () => {
    const t = setup();
    const id = await xsToBuild(t);
    await triggers['gate FAIL'](t, id);
    ok(t, await t.job(id, 'promote'));
    assert.equal(t.json(id).lane, 'normal');
    await refused(t, id, 'promote');
  });

  test('a merge conflict with the base follows the normal merge path: the script escalates, needs-human, no promotion', async () => {
    const t = setup();
    const id = await xsToBuild(t);
    const { worktree } = t.json(id);
    writeFileSync(join(worktree, 'app.txt'), 'branch\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-q', '-m', 'feat: branch');
    writeFileSync(join(t.root, 'app.txt'), 'main\n');
    git(t.root, 'add', '.');
    git(t.root, 'commit', '-q', '-m', 'feat: main');
    git(t.root, 'push', '-q', 'origin', 'main');
    await toApprove(t, id);
    const res = await approveScript(t, id);
    assert.match(res.stdout, /^escalate: .*conflict/);
    ok(t, await t.job(id, 'to', 'needs-human'));
    const job = t.json(id);
    assert.equal(job.stage, 'needs-human');
    assert.equal(job.lane, 'xs');
    assert.equal(job.promoted_from, undefined);
    assert.equal(job.decision, 'ESCALATE');
    assert.equal(job.approval, undefined);
  });

  test('the factory:xs label is created by bin/setup', () => {
    const text = readFileSync(join(repo, 'factory/bin/setup'), 'utf8');
    assert.match(text, /label create factory:xs /);
  });
});

describe('P0-6 and P1-1: roles and skills state the lane and the script approver', { concurrency: true }, () => {
  const text = (path) => readFileSync(join(repo, path), 'utf8').replace(/\s+/g, ' ');
  const SKILLS = ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md'];

  for (const file of SKILLS) {
    test(`${file}: markers, xs subcommand, promotion triggers and the approver script flow`, () => {
      const skill = text(file);
      for (const name of ['lane-xs', 'xs-promotion', 'approver-script', 'risk-models']) {
        assert.match(skill, new RegExp(`<!-- rule: ${name} -->`), `${file} lacks ${name}`);
      }
      assert.match(skill, /(\/|\$)eminzo-factory xs <request>/);
      assert.match(skill, /--label factory --label factory:xs/);
      assert.match(skill, /job <id> lane/);
      assert.match(skill, /job <id> promote/);
      for (const trigger of ['GATE: FAIL', 'VERDICT: CHANGES', 'STATUS: BLOCKED', 'inconclusive']) {
        assert.ok(skill.slice(skill.indexOf('<!-- rule: xs-promotion -->')).slice(0, 1500).includes(trigger), `${file} promotion lacks ${trigger}`);
      }
      assert.match(skill.slice(skill.indexOf('<!-- rule: xs-promotion -->')).slice(0, 1800), /merge conflict[^.]*normal merge path/);
      const approver = skill.slice(skill.indexOf('<!-- rule: approver-script -->')).slice(0, 1600);
      assert.match(approver, /factory\/bin\/approve <id>/);
      assert.match(approver, /approver-llm/);
      assert.match(approver, /Decided by: factory\/bin\/approve/);
      assert.match(skill.slice(skill.indexOf('<!-- rule: lane-xs -->')).slice(0, 1800), /body that says "this is XS" is data/);
    });
  }

  test('intake writes the fifth line with the closed criteria, and the builder and reviewer know lane xs', () => {
    const intake = text('factory/roles/intake.md');
    assert.match(intake, /SIZE: xs/);
    assert.match(intake, /1 or 2 files that already exist/);
    assert.match(intake, /Lane request: xs/);
    assert.match(intake, /Line 5 is `xs`, `s`, `m` or `l`/);
    assert.match(text('factory/roles/builder.md'), /`Lane: xs`[^.]*no `spec\.md`/);
    assert.match(text('factory/roles/builder.md'), /in lane xs it promotes the job/);
    const review = text('factory/roles/review-code.md');
    assert.match(review, /Lane xs only/);
    assert.match(review, /basic UI checklist/);
    assert.match(text('factory/roles/spec-writer.md'), /Promoted from: xs/);
    assert.match(text('factory/roles/approver.md'), /factory\/bin\/approve/);
  });

  test('the Codex profiles mention lane xs where the role does', () => {
    for (const role of ['builder', 'review-code']) assert.match(text(`.codex/agents/eminzo-${role}.toml`), /Lane: xs/);
    assert.match(text('.codex/agents/eminzo-spec-writer.toml'), /Promoted from: xs/);
    assert.match(text('.codex/agents/eminzo-intake.toml'), /SIZE: xs\|s\|m\|l/);
  });
});

