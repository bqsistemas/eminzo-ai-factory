// Plan P1-5 and P1-6: intake classifies without deep exploration, and the spec writer, who
// does explore, may widen (never narrow) the surfaces, which re-routes the reviewers at
// `spec → build`. The builder leaves notes for the next round so a fresh builder (Codex,
// or a new session) does not re-read everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reclassifiedSurfaces } from '../factory/lib/job.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const configText = readFileSync(join(repo, 'factory/config.json'), 'utf8');

function jobAtSpec(specText, intakeOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-reclassify-'));
  mkdirSync(join(dir, 'factory/jobs/001-x'), { recursive: true });
  writeFileSync(join(dir, 'factory/config.json'), configText);
  const job = {
    id: '001-x', issue: 1, title: 'x', stage: 'spec', round: 0, max_rounds: 3, provider: 'claude', lane: 'normal',
    intake: { decision: 'ACCEPT', rescoped: false, risk: 'medium', surfaces: [], ...intakeOverrides },
    agents: { builder: 'sonnet', reviewers: { code: 'sonnet' } },
    models: { builder: 'sonnet', reviewers: { code: 'sonnet' } },
  };
  writeFileSync(join(dir, 'factory/jobs/001-x/job.json'), JSON.stringify(job));
  writeFileSync(join(dir, 'factory/jobs/001-x/spec.md'), specText);
  return dir;
}

const toBuild = (dir) => spawnSync('sh', [join(repo, 'factory/bin/job'), '001-x', 'to', 'build'], { encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: dir } });
const readJob = (dir) => JSON.parse(readFileSync(join(dir, 'factory/jobs/001-x/job.json'), 'utf8'));

test('reclassifiedSurfaces reads the Surfaces line of ## Reclassify', () => {
  assert.deepEqual(reclassifiedSurfaces('# Spec: x\n\n## Reclassify\n- Surfaces: ui, security\n'), ['ui', 'security']);
  assert.deepEqual(reclassifiedSurfaces('# Spec: x\n\n## Reclassify\nSurfaces: none\n'), []);
  assert.deepEqual(reclassifiedSurfaces('# Spec: x\n\n## Design\n- `a.js`\n'), []);
});

test('the spec writer widens the surfaces: spec → build re-routes the reviewers and records it', () => {
  const dir = jobAtSpec('# Spec: x\n\n## Reclassify\n- Surfaces: security\n- Why: it parses a header from the request\n');
  const res = toBuild(dir);
  assert.equal(res.status, 0, res.stderr);
  const job = readJob(dir);
  assert.deepEqual(job.intake.surfaces, ['security']);
  assert.ok(job.agents.reviewers.security, 'security reviewer routed');
  assert.ok(job.agents.reviewers.code, 'code reviewer kept');
  assert.deepEqual(job.reclassified, { from: [], to: ['security'] });
});

test('a reclassification never narrows the surfaces intake chose', () => {
  const dir = jobAtSpec('# Spec: x\n\n## Reclassify\n- Surfaces: none\n', { surfaces: ['ui'] });
  assert.equal(toBuild(dir).status, 0);
  const job = readJob(dir);
  assert.deepEqual(job.intake.surfaces, ['ui']);
  assert.equal(job.reclassified, undefined);
});

test('an unknown surface in ## Reclassify is refused, so the spec writer fixes it', () => {
  const dir = jobAtSpec('# Spec: x\n\n## Reclassify\n- Surfaces: database\n');
  const res = toBuild(dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /unknown surface/);
  assert.equal(readJob(dir).stage, 'spec');
});

test('intake classifies without deep exploration; the spec writer may reclassify', () => {
  const intake = readFileSync(join(repo, 'factory/roles/intake.md'), 'utf8');
  assert.doesNotMatch(intake, /Search the repo before you decide/);
  assert.match(intake, /Module map/);
  const spec = readFileSync(join(repo, 'factory/roles/spec-writer.md'), 'utf8');
  assert.match(spec, /## Reclassify/);
  assert.match(spec, /never narrow/i);
});

test('the builder leaves notes for the next round, and both skills resume a fresh builder from them', () => {
  const builder = readFileSync(join(repo, 'factory/roles/builder.md'), 'utf8');
  assert.match(builder, /## Notes for the next round/);
  for (const path of ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md']) {
    const text = readFileSync(join(repo, path), 'utf8');
    const at = text.indexOf('<!-- rule: builder-handoff -->');
    assert.ok(at >= 0, `${path} has the builder-handoff marker`);
    assert.match(text.slice(at, at + 700), /Notes for the next round/);
  }
});
