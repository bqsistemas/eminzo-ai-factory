// Plan P1-1: factory/bin/approve, the deterministic approver. APPROVE and ESCALATE write
// decision.md; anything else is "inconclusive" and writes nothing (the LLM approver runs).
// Second review fixes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeTokens } from '../factory/lib/diff.js';

import { GIT_ENV, ID, SPEC, fixture, git, inconclusive, repo } from './helpers/approve-fixture.js';

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

  for (const path of ['.npmrc', '.yarnrc.yml', '.husky/pre-commit', 'Makefile', 'sub/Makefile', 'Dockerfile', 'Dockerfile.prod', 'docker-compose.yml', '.gitattributes',
    '.gitmodules', '.env.local', 'vite.config.js', 'app/webpack.config.cjs', 'x.config.mjs', 'y.config.ts', '.eslintrc.json', 'babel.config.json', 'tsconfig.build.json']) {
    test(`execution surface ${path} is denied`, () => {
      inconclusive(fixture({ spec: listed(path), branch: { [path]: 'x\n' } }), /denied path|sensitive path/);
    });
  }

  test('scope tokens come only from list items or table rows, and a negating line is ignored', () => {
    inconclusive(fixture({ spec: SPEC('Touch `src/label.js` only.') }), /no files listed/);
    inconclusive(fixture({ spec: SPEC('- `src/label.js`: the label\n- do not touch `src/extra.js`'), branch: { 'src/label.js': 'b\n', 'src/extra.js': 'x\n' } }), /outside the scope: src\/extra\.js/);
    inconclusive(fixture({ spec: SPEC("- `src/label.js`\n- `src/extra.js` except the header"), branch: { 'src/label.js': 'b\n', 'src/extra.js': 'x\n' } }), /outside the scope: src\/extra\.js/);
    assert.match(fixture({ spec: SPEC('| file | why |\n| --- | --- |\n| `src/label.js` | the label |') }).run().stdout, /^approve/);
  });
});
