// Plan P2-2: the gate writes round-N/context.md once, so the reviewers running in parallel
// read the changed files, the round diff, the ACs and the open blockers instead of each
// deriving them again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { roundContext } from '../factory/lib/round-context.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

/** A root with an origin, a main checkout and a job worktree on factory/<id>. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-context-'));
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const main = join(dir, 'main');
  git(dir, 'clone', '-q', origin, main);
  writeFileSync(join(main, 'a.js'), 'a\n');
  writeFileSync(join(main, 'b.js'), 'b\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'push', '-q', 'origin', 'HEAD:main');
  const id = '001-x';
  const worktree = join(main, '.worktrees', id);
  git(main, 'worktree', 'add', '-q', '-b', `factory/${id}`, worktree, 'origin/main');
  const jobDir = join(main, 'factory/jobs', id);
  mkdirSync(join(jobDir, 'round-1'), { recursive: true });
  return { main, worktree, id, jobDir };
}

const config = { base: 'origin/main' };

test('round 1: changed files and the spec ACs; no round diff, no open blockers', () => {
  const { main, worktree, id, jobDir } = fixture();
  writeFileSync(join(worktree, 'a.js'), 'a2\n');
  writeFileSync(join(worktree, 'c.js'), 'c\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'feat: x');
  writeFileSync(join(jobDir, 'spec.md'), '# Spec: x\n\n## Acceptance criteria\n- AC-1: does a\n- **AC-2**: does c\n\n## Risks\nNone\n');
  const text = roundContext(main, config, { id, round: 1, worktree, lane: 'normal' });
  assert.match(text, /^# Round context \(round 1\)/);
  assert.match(text, /Base: origin\/main/);
  assert.match(text, /## Changed files \(whole change\)\n\n- M a\.js\n- A c\.js/);
  assert.match(text, /## Changed this round\n\nRound 1: the whole change\./);
  assert.match(text, /- AC-1: does a\n- \*\*AC-2\*\*: does c/);
  assert.match(text, /## Open blockers from the previous round\n\nNone\./);
});

test('round 2: the round diff since the recorded head, and the blockers of the lenses that asked for changes', () => {
  const { main, worktree, id, jobDir } = fixture();
  writeFileSync(join(worktree, 'a.js'), 'a2\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'feat: x');
  const head1 = git(worktree, 'rev-parse', 'HEAD');
  writeFileSync(join(worktree, 'b.js'), 'b2\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'fix: y');
  writeFileSync(join(jobDir, 'spec.md'), '# Spec: x\n\n## Acceptance criteria\n- AC-1: z\n');
  writeFileSync(join(jobDir, 'round-1/review-ui.md'), 'VERDICT: CHANGES\n\n## Findings\n- [blocker][design] `b.js:1`: clipped → wrap\n- [minor] `a.js:1`: nit\n');
  writeFileSync(join(jobDir, 'round-1/review-code.md'), 'VERDICT: PASS\n\n## Findings\n- [blocker] `a.js:1`: stale line from a PASS review\n');
  const text = roundContext(main, config, { id, round: 2, worktree, lane: 'normal', round_heads: { 1: head1 } });
  assert.match(text, /Previous round head: [0-9a-f]{40}/);
  assert.match(text, /## Changed this round\n\n- M b\.js/);
  assert.doesNotMatch(text.split('## Changed this round')[1].split('##')[0], /a\.js/);
  assert.match(text, /- ui: \[blocker\]\[design\] `b\.js:1`: clipped → wrap/);
  assert.doesNotMatch(text, /stale line from a PASS review/);
  assert.doesNotMatch(text, /nit/);
});

test('an unknown previous head says so instead of guessing; an xs job reads its ACs from intake Scope', () => {
  const { main, worktree, id, jobDir } = fixture();
  writeFileSync(join(jobDir, 'intake.md'), 'ACCEPT\nRISK: low\nSURFACES: ui\nRESCOPED: no\nSIZE: xs\n\n## Scope\n- `a.js`\n- AC-1: a says hi\n');
  const text = roundContext(main, config, { id, round: 2, worktree, lane: 'xs', round_heads: { 1: null } });
  assert.match(text, /Previous round head: unknown \(review the full change\)/);
  assert.match(text, /- AC-1: a says hi/);
});

test('the gate writes context.md next to checks.md, and never fails because of it', () => {
  const gate = readFileSync(join(repo, 'factory/lib/gate.js'), 'utf8');
  assert.match(gate, /roundContext\(/);
  assert.match(gate, /context\.md/);
});

test('reviewers and the approver read context.md first; both skills carry the round-context rule', () => {
  for (const role of ['review-code', 'review-security', 'review-ui', 'review-ux', 'approver']) {
    const text = readFileSync(join(repo, `factory/roles/${role}.md`), 'utf8');
    assert.match(text, /context\.md/, `${role} reads context.md`);
  }
  for (const path of ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md']) {
    const text = readFileSync(join(repo, path), 'utf8');
    const at = text.indexOf('<!-- rule: round-context -->');
    assert.ok(at >= 0, `${path} has the round-context marker`);
    assert.match(text.slice(at, at + 600), /context\.md/);
  }
});
