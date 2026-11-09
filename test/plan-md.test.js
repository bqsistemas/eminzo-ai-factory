// P2: the builder writes plan.md before editing, and the code reviewer checks the diff against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { artifactFiles } from '../factory/pipeline-canvas.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(repo, rel), 'utf8');

test('P2 AC-2: review-code.md says the diff must match plan.md and that a plan.md over 30 lines is a [minor]', () => {
  const role = read('factory/roles/review-code.md');
  assert.match(role, /The diff matches `<job folder>\/plan\.md`/);
  assert.match(role, /or\s+`build\.md` explains the difference/);
  assert.match(role, /`plan\.md` is at most 30 lines\. A longer one is a `\[minor\]`/);
});

test('P2 AC-3: the dashboard lists plan.md among the job artifacts it serves', () => {
  assert.ok(artifactFiles({ round: 1 }).includes('plan.md'));
  assert.ok(artifactFiles({}).indexOf('plan.md') < artifactFiles({}).indexOf('build.md'));
});

test('P2 AC-4: the builder role holds the plan rule, and the review-code role checks it', () => {
  const builder = read('factory/roles/builder.md');
  for (const h of ['## Files that change', '## Order of work', '## Risks', '## Proof']) assert.ok(builder.includes(`\`${h}\``), h);
  assert.match(builder, /Before your first code edit, write `<job folder>\/plan\.md`/);
  assert.match(builder, /at most 30 lines/);
  assert.match(builder, /Update it when the code departs from it/);
  assert.match(builder, /write only your `build\.md` and `plan\.md`/);
  assert.match(read('factory/roles/review-code.md'), /plan\.md/);
});

test('P2: both providers let the builder write plan.md next to build.md, and nothing else says build.md alone', () => {
  for (const f of ['.claude/agents/eminzo-builder.md', '.codex/agents/eminzo-builder.toml']) {
    const text = read(f);
    assert.match(text, /Write only `build\.md` and `plan\.md` in the main checkout\./, f);
    assert.doesNotMatch(text, /Write only `build\.md` in the main checkout/, f);
    assert.match(text, /`plan\.md`/, f);
  }
  assert.match(read('.claude/agents/eminzo-builder.md'), /Write only your own file \(`build\.md`\) and `plan\.md` in the same folder/);
  assert.match(read('.codex/agents/eminzo-builder.toml'), /Write only `factory\/jobs\/<id>\/build\.md` and `factory\/jobs\/<id>\/plan\.md`/);
});
