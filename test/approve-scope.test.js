// Plan P1-1: factory/bin/approve, the deterministic approver. APPROVE and ESCALATE write
// decision.md; anything else is "inconclusive" and writes nothing (the LLM approver runs).
// Denylist, manifests and scope tokens (adversarial review).
// Part of the approve-scope scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SPEC, fixture, inconclusive } from './helpers/approve-fixture.js';

describe('bin/approve: denylist, manifests and scope tokens (adversarial review)', () => {
  const listed = (...paths) => SPEC(paths.map((p) => `- \`${p}\``).join('\n'));

  for (const path of ['.github/workflows/ci.yml', '.claude/agents/x.md', '.agents/skills/a.md', '.codex/agents/a.toml', 'factory/bin/approve',
    'factory/lib/job.js', 'factory/roles/builder.md', 'factory/templates/project.md', 'factory/checks.sh', 'factory/project.md', '.gitlab-ci.yml']) {
    test(`a listed ${path} is still inconclusive (engine, CI or control path)`, () => {
      inconclusive(fixture({ spec: listed(path), branch: { [path]: 'x\n' } }), new RegExp(`engine, CI or denied path: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    });
  }

  test('other factory UI files are not denied by default, and config.approve.deny extends the list', () => {
    assert.match(fixture({ spec: listed('factory/dashboard.html'), branch: { 'factory/dashboard.html': 'x\n' } }).run().stdout, /^approve/);
    inconclusive(fixture({ spec: listed('docs/private/a.md'), branch: { 'docs/private/a.md': 'x\n' }, config: { approve: { deny: ['docs/private/**'] } } }), /denied path: docs\/private\/a\.md/);
  });
});
