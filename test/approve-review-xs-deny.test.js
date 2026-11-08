// Plan P1-1: factory/bin/approve, the deterministic approver. APPROVE and ESCALATE write
// decision.md; anything else is "inconclusive" and writes nothing (the LLM approver runs).
// Second review fixes.
// Part of the approve-review-fixes scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SPEC, fixture, inconclusive } from './helpers/approve-fixture.js';

describe('bin/approve: second review fixes', () => {
  const listed = (...paths) => SPEC(paths.map((p) => `- \`${p}\``).join('\n'));

  const xsJob = { lane: 'xs', intake: { decision: 'ACCEPT', risk: 'low', surfaces: ['ui'], rescoped: false, size: 'xs' } };

  test('the xs limits are re-checked at approval: file count, test count and the line cap', () => {
    const three = { 'src/label.js': 'b\n', 'src/b.js': 'x\n', 'src/c.js': 'x\n' };
    inconclusive(fixture({ job: xsJob, intake: 'ACCEPT\nRISK: low\nSURFACES: ui\nRESCOPED: no\nSIZE: xs\n\n## Scope\n- `src/label.js`\n- `src/b.js`\n- `src/c.js`\n', branch: three }), /lane xs limits not met: 3 non-test files/);
    const tests = { 'src/label.js': 'b\n', 'test/a.test.js': 'x\n', 'test/b.test.js': 'x\n', 'test/c.test.js': 'x\n' };
    inconclusive(fixture({ job: xsJob, branch: tests }), /3 test files added or modified \(max 2\)/);
    const big = { 'src/label.js': `${'line\n'.repeat(6)}` };
    inconclusive(fixture({ job: xsJob, branch: big, config: { lanes: { xs: { max_lines: 3 } } } }), /changed lines outside tests \(max 3\)/);
    assert.match(fixture({ job: xsJob, branch: big, config: { lanes: { xs: { max_lines: 10 } } } }).run().stdout, /^approve/);
  });

  test('deny matching ignores case, for the default list and for config.approve.deny', () => {
    inconclusive(fixture({ spec: listed('.GitHub/workflows/ci.yml'), branch: { '.GitHub/workflows/ci.yml': 'x\n' } }), /denied path: \.GitHub/);
    inconclusive(fixture({ spec: listed('.CLAUDE/agents/x.md'), branch: { '.CLAUDE/agents/x.md': 'x\n' } }), /denied path: \.CLAUDE\/agents/);
    inconclusive(fixture({ spec: listed('Docs/Private/a.md'), branch: { 'Docs/Private/a.md': 'x\n' }, config: { approve: { deny: ['docs/private/**'] } } }), /denied path: Docs\/Private/);
  });

  test('scope tokens come only from list items or table rows, and a negating line is ignored', () => {
    inconclusive(fixture({ spec: SPEC('Touch `src/label.js` only.') }), /no files listed/);
    inconclusive(fixture({ spec: SPEC('- `src/label.js`: the label\n- do not touch `src/extra.js`'), branch: { 'src/label.js': 'b\n', 'src/extra.js': 'x\n' } }), /outside the scope: src\/extra\.js/);
    inconclusive(fixture({ spec: SPEC("- `src/label.js`\n- `src/extra.js` except the header"), branch: { 'src/label.js': 'b\n', 'src/extra.js': 'x\n' } }), /outside the scope: src\/extra\.js/);
    assert.match(fixture({ spec: SPEC('| file | why |\n| --- | --- |\n| `src/label.js` | the label |') }).run().stdout, /^approve/);
  });
});
