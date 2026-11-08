// Setup is a required user-invoked command (Claude Code, Codex or Eminzo's terminal). The LLM must write useful,
// evidence-based project context, not stop at the deterministic init draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const SKILLS = {
  claude: { path: '.claude/skills/eminzo-factory/SKILL.md', cmd: '/eminzo-factory setup' },
  codex: { path: '.agents/skills/eminzo-factory/SKILL.md', cmd: '$eminzo-factory setup' },
};

for (const [provider, { path, cmd }] of Object.entries(SKILLS)) {
  const text = readFileSync(join(repo, path), 'utf8');

  test(`${provider}: ${cmd} is mandatory and refreshes project.md with technical LLM analysis`, () => {
    const at = text.indexOf('<!-- rule: setup-command -->');
    assert.ok(at >= 0, 'setup-command marker');
    const near = text.slice(at, at + 3500);
    assert.ok(near.includes(cmd), `names ${cmd}`);
    assert.match(near, /factory\/bin\/setup/);
    assert.match(near, /factory\/bin\/init/);
    assert.match(near, /mandatory|required user-run|must run|before.*factory/i);
    assert.match(near, /analy[sz].*repo|technical analysis/i);
    assert.match(near, /product|functional purpose|what the software does/i);
    assert.match(near, /users|actors|business workflow|end-to-end/i);
    assert.match(near, /README|docs|source|tests/i);
    assert.match(near, /factory\/templates\/project\.md/);
    assert.match(near, /update|refresh|replace/i);
    assert.match(near, /do not.*guess|evidence|verified/i);
    assert.match(near, /No job, issue or agent is started/);
  });

  test(`${provider}: the skill advertises setup and the preflight points to ${cmd}, not to the script`, () => {
    const front = text.split('\n---')[0];
    assert.match(front, /argument-hint:.*\bsetup\b/);
    assert.match(front, /description:.*setup/);
    assert.doesNotMatch(text, /tell the user to run `factory\/bin\/setup`/);
    assert.ok(text.includes(`run \`${cmd}\``), `the preflight tells the user to run ${cmd}`);
    assert.match(text, /lacks `<!-- eminzo:setup-complete -->`|marker is absent from `factory\/project\.md`|require `<!-- eminzo:setup-complete -->` in/);
  });
}

test('the guide lists the setup command', () => {
  const guide = readFileSync(join(repo, 'docs/factory-explicado.md'), 'utf8');
  assert.match(guide, /`\/eminzo-factory setup`/);
  assert.match(guide, /`\$eminzo-factory setup`/);
});
