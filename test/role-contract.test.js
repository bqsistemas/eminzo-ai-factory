// Golden list of the tokens and headings each role tells its agent to write.
// The engine and the desktop parse these byte for byte: a role rewrite may change the prose
// around them, never them. B2 rules (summary sentence, [blocker] proof) are pinned below too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const role = (name) => readFileSync(join(repo, 'factory/roles', `${name}.md`), 'utf8');

/** Every literal must appear in the role exactly as written. */
const GOLDEN = {
  intake: [
    'ACCEPT\nRISK: low\nSURFACES: ui\nRESCOPED: no\nSIZE: xs\n',
    '## Scope', '## Questions', '## Reason', '## Reclassify',
    '`ACCEPT`, `NEEDS-INFO` or `REJECT`', 'Line 5 is `xs`, `s`, `m` or `l`.',
    '- AC-1: Given ..., when ..., then ...', 'Lane request: xs',
  ],
  'spec-writer': [
    '# Spec: <title>', '## Goal', '## Scope', '## Assumptions', '## Design', '## Acceptance criteria', '## Risks',
    '## Reclassify', '## Amendments', '- AC-1: Given ..., when ..., then ...', '- R<round> | AC-n | old → new | reason',
    '- Surfaces: <ui|security|interaction>, ...',
  ],
  builder: [
    'STATUS: READY', 'STATUS: BLOCKED', '## Changes', '## Acceptance criteria', '## Checks', '## Review responses',
    '## Spec deviations', '## PR', '## Commits', '## Flaky', '## Notes for the next round',
    '## Files that change', '## Order of work', '## Risks', '## Proof',
    '`command | error`', 'AC-n | Design: what changed → why', 'VISUAL: PASS', 'selfcheck: ok',
  ],
  'review-code': ['VERDICT: PASS', 'VERDICT: CHANGES', '## Checks', '## Findings', '## Notes', '- [blocker] `path:line`', '- [minor] `path:line`'],
  'review-security': ['VERDICT: PASS', 'VERDICT: CHANGES', '## Findings', '## Notes', '- [blocker] `path:line`', '- [minor] `path:line`'],
  'review-ui': ['VERDICT: PASS', 'VERDICT: CHANGES', '## Findings', '## Notes', '- [blocker][design] `path:line`', '- [minor][ux] `path:line`'],
  'review-ux': ['VERDICT: PASS', 'VERDICT: CHANGES', '## Findings', '## Notes', '- [blocker][ux] `path:line`', '- [minor][ux] `path:line`'],
  approver: [
    'ESCALATE\n', '`APPROVE` or `ESCALATE`', '## Checks', '## Accepted deviations', '## Lessons', '## For the human',
    '`command | error`', '`VERDICT: PASS`', '`GATE: PASS`', '## Spec deviations', '## Amendments',
  ],
};

for (const [name, tokens] of Object.entries(GOLDEN)) {
  test(`golden: ${name}.md keeps every token and heading the engine parses`, () => {
    const text = role(name);
    for (const token of tokens) assert.ok(text.includes(token), `${name}.md lost ${JSON.stringify(token)}`);
  });
}
