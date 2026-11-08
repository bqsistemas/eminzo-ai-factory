// Codex adapter contract: keep the host-specific layer declarative and reuse the shared spine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const skillPath = join(repo, '.agents/skills/eminzo-factory/SKILL.md');
const agentsDir = join(repo, '.codex/agents');

test('Codex factory skill exposes the same commands and state invariants', () => {
  assert.equal(existsSync(skillPath), true, 'Codex factory skill is missing');
  const skill = readFileSync(skillPath, 'utf8');
  assert.match(skill, /^---\nname: eminzo-factory\n/);
  assert.match(skill, /description:\s+\S/);
  for (const command of ['$eminzo-factory run', '$eminzo-factory issue <n>', '$eminzo-factory add <feature>', '$eminzo-factory rework <n>']) {
    assert.match(skill, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const invariant of ['factory/bin/job', 'factory/bin/gate', 'factory/bin/route', 'job.json', 'board.json', 'WAIT FOR ALL']) {
    assert.match(skill, new RegExp(invariant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(skill, /--provider codex/);
  assert.match(skill, /job\.models/);
  assert.match(skill, /Claude.*Codex|Codex.*Claude/s);
});

test('Codex role profiles map one-to-one to the existing Claude role contracts', () => {
  const expected = {
    'eminzo-intake.toml': 'intake',
    'eminzo-spec-writer.toml': 'spec-writer',
    'eminzo-builder.toml': 'builder',
    'eminzo-review-security.toml': 'review-security',
    'eminzo-review-ux.toml': 'review-ux',
    'eminzo-review-ui.toml': 'review-ui',
    'eminzo-review-code.toml': 'review-code',
    'eminzo-approver.toml': 'approver',
  };
  assert.deepEqual(readdirSync(agentsDir).sort(), Object.keys(expected).sort());
  for (const [file, role] of Object.entries(expected)) {
    const profile = readFileSync(join(agentsDir, file), 'utf8');
    assert.match(profile, /^name = "eminzo-/m);
    assert.match(profile, /^description = ".+"$/m);
    assert.match(profile, /^developer_instructions = '''/m);
    assert.match(profile, new RegExp(`factory/roles/${role}\\.md`));
    assert.doesNotMatch(profile, /\b(opus|sonnet|haiku|fable)\b/, `${file} leaks Claude model aliases`);
  }
});

test('Claude adapter remains present while Codex files are additive', () => {
  assert.equal(existsSync(join(repo, '.claude/skills/eminzo-factory/SKILL.md')), true);
  assert.equal(existsSync(join(repo, 'factory/bin/job')), true);
  assert.equal(existsSync(join(repo, 'factory/bin/gate')), true);
  assert.equal(existsSync(join(repo, 'factory/bin/route')), true);
});
