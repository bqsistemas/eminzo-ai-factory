// B2: the roles ask for readable artifacts: a summary sentence after the machine lines, a Checks table in
// build.md, and proof on every [blocker]. The parsed tokens themselves are pinned in role-contract.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const role = (name) => readFileSync(join(repo, 'factory/roles', `${name}.md`), 'utf8');

const SUMMARY = /one plain sentence/i;

test('B2 AC-1: every artifact role asks for a one-sentence summary a person can read alone', () => {
  for (const name of ['intake', 'spec-writer', 'builder', 'review-code', 'review-security', 'review-ui', 'review-ux', 'approver']) {
    assert.match(role(name), SUMMARY, `${name}.md has no summary-sentence rule`);
  }
});

test('B2 AC-1: the summary sentence comes after the machine lines, never between them', () => {
  assert.match(role('intake'), /SIZE: xs\n\n<one plain sentence/);
  for (const name of ['review-code', 'review-security', 'review-ui', 'review-ux']) {
    assert.match(role(name), /VERDICT: PASS\n\n<one plain sentence[^\n]*>\n\n# /, name);
  }
  assert.match(role('builder'), /STATUS: READY\n\n<one plain sentence[^\n]*>\n\n# Build/);
  assert.match(role('spec-writer'), /# Spec: <title>\n\n<one plain sentence/);
  assert.match(role('approver'), /second line is one plain sentence/i);
});

test('B2 AC-2: build.md has a Checks table with the last nudge result, mode, what ran and what failed', () => {
  const text = role('builder');
  assert.match(text, /## Checks\n\|[^\n]*Result[^\n]*\|/);
  assert.match(text, /nudge/i);
  assert.match(text, /mode/i);
});

test('B2 AC-3: reviewers attach proof to every [blocker]; the approver treats a bare one as not proven', () => {
  for (const name of ['review-code', 'review-security', 'review-ui', 'review-ux']) {
    const text = role(name);
    assert.match(text, /\[blocker\][^\n]*proof/i, `${name}.md`);
    assert.match(text, /file:line|`path:line`/);
    assert.match(text, /reproduce/i, `${name}.md`);
  }
  const approver = role('approver');
  assert.match(approver, /not proven/i);
  assert.match(approver, /never waives check 1/i);
  assert.match(approver, /## For the human/);
});

test('B2: roles keep the engine generic (no repo, product or suite names)', () => {
  for (const name of ['intake', 'spec-writer', 'builder', 'review-code', 'review-security', 'review-ui', 'review-ux', 'approver']) assert.doesNotMatch(role(name), /smoke|eminzo/i, name);
});

test('B2: each review role defines proof as an indented Proof: line, and a bare path:line is not proof', () => {
  for (const name of ['review-code', 'review-security', 'review-ui', 'review-ux']) {
    const text = role(name).replace(/\s+/g, ' ');
    assert.match(text, /indented `Proof:` line under its bullet/, name);
    assert.match(text, /A `path:line` on the bullet alone is not proof/, name);
    assert.match(text, /A missing `Proof:` never lowers a blocker/, name);
  }
});

test('B2: the approver never lets proof waive a CHANGES verdict, and lists blockers as proven or not proven', () => {
  const text = role('approver').replace(/\s+/g, ' ');
  assert.match(text, /Proof never waives check 1: a lens whose latest verdict is `CHANGES` is an ESCALATE/);
  assert.match(text, /\*\*proven\*\* or \*\*not proven\*\*/);
  assert.match(text, /A `path:line` on the bullet alone is not proof/);
  assert.doesNotMatch(text, /otherwise note it/i);
  assert.doesNotMatch(text, /approve[^.]*when a lens is `?CHANGES/i);
});

test('B2: intake keeps SIZE as the fifth header line and a reason for NEEDS-INFO and REJECT', () => {
  const text = role('intake');
  assert.ok(text.includes('RESCOPED: no\nSIZE: xs\n\n<one plain sentence'));
  assert.match(text.replace(/\s+/g, ' '), /NEEDS-INFO and REJECT: always/);
});

test('B2: no summary sentence may start with an uppercase word and a colon', () => {
  for (const name of ['intake', 'spec-writer', 'builder', 'review-code', 'review-security', 'review-ui', 'review-ux', 'approver']) {
    assert.match(role(name).replace(/\s+/g, ' '), /never starting with `WORD:`/, name);
  }
});
