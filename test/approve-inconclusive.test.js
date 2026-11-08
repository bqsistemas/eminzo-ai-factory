// Plan P1-1: factory/bin/approve, the deterministic approver. APPROVE and ESCALATE write
// decision.md; anything else is "inconclusive" and writes nothing (the LLM approver runs).
// Inconclusive: sensitive paths, risk, security surface and accepted spec deviations (split from test/approve.test.js, D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeTokens } from '../factory/lib/diff.js';

import { GIT_ENV, ID, SPEC, fixture, git, inconclusive, repo } from './helpers/approve-fixture.js';

describe('bin/approve: inconclusive (the LLM approver decides)', () => {
  for (const path of ['src/auth.js', 'src/secrets.js', 'lib/credentials.js', 'src/permissions.js', 'db/migration-3.sql', '.env.example']) {
    test(`a sensitive path (${path}) forces the LLM`, () => {
      inconclusive(fixture({ branch: { [path]: 'x\n' }, spec: SPEC(`- \`${path}\``) }), new RegExp(`sensitive path: ${path.replace(/\./g, '\\.')}`));
    });
  }

  test('risk high forces the LLM', () => {
    inconclusive(fixture({ job: { intake: { decision: 'ACCEPT', risk: 'high', surfaces: [], rescoped: false } } }), /risk high/);
  });

  test('a security surface forces the LLM', () => {
    inconclusive(fixture({ job: { intake: { decision: 'ACCEPT', risk: 'low', surfaces: ['security'], rescoped: false } } }), /security surface/);
  });

  test('an accepted spec deviation that touches an AC forces the LLM', () => {
    inconclusive(fixture({ build: 'STATUS: READY\n\n## Spec deviations\nAC-1 | ui round 1: moved\n' }), /spec deviation touches AC-1/);
  });
});
