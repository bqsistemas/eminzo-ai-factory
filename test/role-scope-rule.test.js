// Intake and the spec writer stay inside the scope an Eminzo deliverable issue carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

test('AC-8: intake and the spec writer keep the work inside the Out of scope of a deliverable issue', () => {
  for (const role of ['intake', 'spec-writer']) {
    const text = readFileSync(join(repo, 'factory/roles', `${role}.md`), 'utf8').replace(/\s+/g, ' ');
    const rule = /- When the issue carries the Out of scope of a deliverable [^]*?(?= - |\*\*|$)/.exec(text)?.[0] ?? '';
    assert.match(rule, /Out of scope of a deliverable/, role);
    assert.match(rule, /criteria that belong to other deliverables/, role);
    assert.match(rule, /(keep|stay)[^.]* inside that Out of scope/, role);
    assert.match(rule, /criteria the issue lists are (the ones to cover|the acceptance criteria to cover)/, role);
  }
  const check = spawnSync(process.execPath, [join(repo, 'cli/scripts/sync-agents.mjs'), '--check'], { cwd: repo, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
});
