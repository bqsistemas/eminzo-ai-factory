// Plan P1-1: factory/bin/approve, the deterministic approver. APPROVE and ESCALATE write
// decision.md; anything else is "inconclusive" and writes nothing (the LLM approver runs).
// Denylist, manifests and scope tokens (adversarial review).
// Part of the approve-scope scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import { SPEC, fixture, inconclusive } from './helpers/approve-fixture.js';

describe('bin/approve: denylist, manifests and scope tokens (adversarial review)', () => {
  const listed = (...paths) => SPEC(paths.map((p) => `- \`${p}\``).join('\n'));

  for (const path of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'requirements-dev.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle.kts', 'Gemfile.lock', 'composer.json']) {
    test(`a changed ${path} is inconclusive`, () => {
      inconclusive(fixture({ spec: listed(path), branch: { [path]: 'x\n' } }), /dependency manifest changed/);
    });
  }

  test('a package.json that is unreadable on both sides is inconclusive, never approved', () => {
    inconclusive(fixture({
      base: { 'src/label.js': 'a\n', 'package.json': '{not json' }, spec: listed('package.json'), branch: { 'package.json': '{still not json' },
    }), /dependency manifest changed|could not read the dependencies/);
  });
});
