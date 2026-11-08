// Plan P1-1: factory/bin/approve, the deterministic approver. APPROVE and ESCALATE write
// decision.md; anything else is "inconclusive" and writes nothing (the LLM approver runs).
// Second review fixes.
// Part of the approve-review-fixes scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import { SPEC, fixture, inconclusive } from './helpers/approve-fixture.js';

describe('bin/approve: second review fixes', () => {
  const listed = (...paths) => SPEC(paths.map((p) => `- \`${p}\``).join('\n'));

  for (const path of ['.npmrc', '.yarnrc.yml', '.husky/pre-commit', 'Makefile', 'sub/Makefile', 'Dockerfile', 'Dockerfile.prod', 'docker-compose.yml', '.gitattributes',
    '.gitmodules', '.env.local', 'vite.config.js', 'app/webpack.config.cjs', 'x.config.mjs', 'y.config.ts', '.eslintrc.json', 'babel.config.json', 'tsconfig.build.json']) {
    test(`execution surface ${path} is denied`, () => {
      inconclusive(fixture({ spec: listed(path), branch: { [path]: 'x\n' } }), /denied path|sensitive path/);
    });
  }
});
