// A job that moves to a new round keeps the previous build.md in that round's folder.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, ok, intaken, xsToBuild, xsToGate, commitInWorktree } from './helpers/lane-xs-harness.js';

async function atGate(t) {
  const id = await intaken(t, { intake: { size: 'm' } });
  ok(t, await t.job(id, 'to', 'spec'));
  t.write(id, 'spec.md', '# Spec\n');
  ok(t, await t.job(id, 'to', 'build'));
  await xsToGate(t, id);
  return id;
}

describe('build.md moves into its round folder when the next round starts', { concurrency: true }, () => {
  test('gate FAIL to build: build.md leaves the job folder for round-1/', async () => {
    const t = setup();
    const id = await atGate(t);
    const dir = join(t.root, 'factory/jobs', id);
    t.write(id, 'build.md', 'STATUS: READY\n## Notes for the next round\nkeep me\n');
    t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
    ok(t, await t.job(id, 'to', 'build'));
    assert.equal(existsSync(join(dir, 'build.md')), false);
    assert.match(readFileSync(join(dir, 'round-1/build.md'), 'utf8'), /keep me/);
  });

  test('a build.md already in round-1/ is replaced; no build.md is a no-op', async () => {
    const t = setup();
    const id = await atGate(t);
    const dir = join(t.root, 'factory/jobs', id);
    t.write(id, 'build.md', 'new\n');
    t.write(id, 'round-1/build.md', 'old\n');
    t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
    ok(t, await t.job(id, 'to', 'build'));
    assert.equal(readFileSync(join(dir, 'round-1/build.md'), 'utf8'), 'new\n');

    const t2 = setup();
    const id2 = await atGate(t2);
    rmSync(join(t2.root, 'factory/jobs', id2, 'build.md'), { force: true });
    t2.write(id2, 'round-1/checks.md', 'GATE: FAIL\n');
    ok(t2, await t2.job(id2, 'to', 'build'));
    assert.equal(existsSync(join(t2.root, 'factory/jobs', id2, 'round-1/build.md')), false);
  });

  test('a build.md that is a symlink is never moved or followed', async () => {
    const t = setup();
    const id = await atGate(t);
    const dir = join(t.root, 'factory/jobs', id);
    writeFileSync(join(t.root, 'outside.txt'), 'secret\n');
    rmSync(join(dir, 'build.md'), { force: true });
    symlinkSync(join(t.root, 'outside.txt'), join(dir, 'build.md'));
    t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
    ok(t, await t.job(id, 'to', 'build'));
    assert.equal(existsSync(join(dir, 'round-1/build.md')), false);
    assert.equal(lstatSync(join(dir, 'build.md')).isSymbolicLink(), true);
  });
});

describe('keepBuild guards and promote', { concurrency: true }, () => {
  test('a symlinked round folder or a file in its place leaves build.md where it is', async () => {
    for (const kind of ['symlink', 'file']) {
      const t = setup();
      const id = await atGate(t);
      const dir = join(t.root, 'factory/jobs', id);
      t.write(id, 'build.md', 'STATUS: READY\nmine\n');
      t.write(id, 'round-1/checks.md', 'GATE: FAIL\n');
      const away = join(t.root, `away-${kind}`);
      mkdirSync(away);
      // swap the round folder for a symlink / a file after the checks.md the transition needs
      const checks = readFileSync(join(dir, 'round-1/checks.md'), 'utf8');
      rmSync(join(dir, 'round-1'), { recursive: true });
      if (kind === 'symlink') symlinkSync(away, join(dir, 'round-1'));
      else writeFileSync(join(dir, 'round-1'), 'not a folder\n');
      if (kind === 'symlink') writeFileSync(join(away, 'checks.md'), checks);
      const res = await t.job(id, 'to', 'build');
      if (kind === 'file') assert.notEqual(res.status, 0);
      assert.match(readFileSync(join(dir, 'build.md'), 'utf8'), /mine/, kind);
      assert.equal(existsSync(join(away, 'build.md')), false, kind);
    }
  });

  test('promote moves the xs build.md to round-1/build.md', async () => {
    const t = setup();
    const id = await xsToBuild(t);
    commitInWorktree(t, id, { 'app.txt': 'changed\n' });
    t.write(id, 'build.md', 'STATUS: READY\nxs build\n');
    ok(t, await t.job(id, 'promote'));
    const dir = join(t.root, 'factory/jobs', id);
    assert.match(readFileSync(join(dir, 'round-1/build.md'), 'utf8'), /xs build/);
    assert.equal(existsSync(join(dir, 'build.md')), false);
  });
});

describe('the skills and the builder role describe the move', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const skills = ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md'];

  test('a fresh builder resumes from round-<round - 1>/build.md, never from a root build.md', () => {
    for (const p of skills) {
      const text = read(p);
      assert.match(text, /Resume: read round-<round - 1>\/build\.md \(## Notes for the next round\) and the rest of round-<round - 1>\/ first\./, p);
      assert.doesNotMatch(text, /Resume: read build\.md/, p);
    }
    assert.match(read('factory/roles/builder.md'), /start with your own `round-<N-1>\/build\.md`/);
  });

  test('delete-stale-output says the engine moves build.md at a round change', () => {
    for (const p of skills) {
      const text = read(p);
      const at = text.indexOf('rule: delete-stale-output');
      assert.ok(at >= 0, p);
      assert.match(text.slice(Math.max(0, at - 700), at + 700), /engine moves (it|`build\.md`) into `round-<n>\/`/, p);
    }
  });

  test('the spec-writer reads the xs build from round-<round - 1>/build.md, and the layout lists round-n/build.md', () => {
    assert.match(read('factory/roles/spec-writer.md'), /`round-<round - 1>\/build\.md` says what was built/);
    assert.match(read('.claude/skills/eminzo-factory/SKILL.md'), /round-N\/build\.md/);
    assert.match(read('.claude/skills/eminzo-factory/SKILL.md'), /Do not delete `build\.md` yourself/);
    assert.match(read('.agents/skills/eminzo-factory/SKILL.md'), /do not delete `build\.md`\s+yourself/);
  });
});
