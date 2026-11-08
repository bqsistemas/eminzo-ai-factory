// Plan P1-1: factory/bin/approve, the deterministic approver. APPROVE and ESCALATE write
// decision.md; anything else is "inconclusive" and writes nothing (the LLM approver runs).
// Second review fixes.
// Part of the approve-review-fixes scenarios, split by scenario (D2).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ID, SPEC, fixture, inconclusive } from './helpers/approve-fixture.js';

describe('bin/approve: second review fixes', () => {
  const listed = (...paths) => SPEC(paths.map((p) => `- \`${p}\``).join('\n'));

  const jobJson = (t) => JSON.parse(readFileSync(join(t.root, 'factory/jobs', ID, 'job.json'), 'utf8'));

  const xsJob = { lane: 'xs', intake: { decision: 'ACCEPT', risk: 'low', surfaces: ['ui'], rescoped: false, size: 'xs' } };

  test('APPROVE is recorded in job.json by job.js with the script, the head and a time; other results record nothing', () => {
    const t = fixture();
    assert.match(t.run().stdout, /^approve/);
    const { approval, round_heads: heads } = jobJson(t);
    assert.equal(approval.by, 'script');
    assert.equal(approval.head, heads[1]);
    assert.ok(Date.parse(approval.at));
    const none = fixture({ main: { 'src/label.js': 'main\n' } });
    none.run();
    assert.equal(jobJson(none).approval, undefined);
  });

  test('a branch head that is not the head reviewed in this round is inconclusive', () => {
    inconclusive(fixture({ job: { round_heads: { 1: '0'.repeat(40) } } }), /recorded at review/);
    inconclusive(fixture({ job: { round_heads: {} } }), /recorded at review/);
  });

  test('isTestFile: only a root test/, tests/ or spec/ directory counts, __tests__ anywhere, and *.test.* names', () => {
    inconclusive(fixture({ branch: { 'src/label.js': 'b\n', 'src/spec/x.js': 'x\n' } }), /outside the scope: src\/spec\/x\.js/);
    inconclusive(fixture({ branch: { 'src/label.js': 'b\n', 'lib/test/x.js': 'x\n' } }), /outside the scope: lib\/test\/x\.js/);
    for (const ok of ['spec/x.js', 'tests/x.js', 'src/__tests__/a.js', 'src/a.test.js', 'src/b.spec.ts']) {
      assert.match(fixture({ branch: { 'src/label.js': 'b\n', [ok]: 'x\n' } }).run().stdout, /^approve/, ok);
    }
  });

  test('an added executable file is inconclusive in every lane', () => {
    inconclusive(fixture({ spec: listed('src/run.sh'), branch: {}, edit: (r) => { writeFileSync(join(r, 'src/run.sh'), 'echo\n'); chmodSync(join(r, 'src/run.sh'), 0o755); } }), /executable file added: src\/run\.sh/);
  });

  test('the scope source is chosen by lane: xs reads intake, normal reads the spec even when only one exists', () => {
    const xs = fixture({ job: xsJob, spec: listed('src/other.js') });
    assert.match(xs.run().stdout, /^approve/);
    inconclusive(fixture({ spec: null }), /no files listed in the spec's ## Design/);
    inconclusive(fixture({ spec: listed('src/other.js') }), /outside the scope: src\/label\.js/);
  });
});
