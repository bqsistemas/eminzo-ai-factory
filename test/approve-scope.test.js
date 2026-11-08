// Plan P1-1: factory/bin/approve, the deterministic approver. APPROVE and ESCALATE write
// decision.md; anything else is "inconclusive" and writes nothing (the LLM approver runs).
// Denylist, manifests and scope tokens (adversarial review).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeTokens } from '../factory/lib/diff.js';

import { GIT_ENV, ID, SPEC, fixture, git, inconclusive, repo } from './helpers/approve-fixture.js';

describe('bin/approve: denylist, manifests and scope tokens (adversarial review)', () => {
  const listed = (...paths) => SPEC(paths.map((p) => `- \`${p}\``).join('\n'));

  for (const path of ['.github/workflows/ci.yml', '.claude/agents/x.md', '.agents/skills/a.md', '.codex/agents/a.toml', 'factory/bin/approve',
    'factory/lib/job.js', 'factory/roles/builder.md', 'factory/templates/project.md', 'factory/checks.sh', 'factory/project.md', '.gitlab-ci.yml']) {
    test(`a listed ${path} is still inconclusive (engine, CI or control path)`, () => {
      inconclusive(fixture({ spec: listed(path), branch: { [path]: 'x\n' } }), new RegExp(`engine, CI or denied path: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    });
  }

  test('other factory UI files are not denied by default, and config.approve.deny extends the list', () => {
    assert.match(fixture({ spec: listed('factory/dashboard.html'), branch: { 'factory/dashboard.html': 'x\n' } }).run().stdout, /^approve/);
    inconclusive(fixture({ spec: listed('docs/private/a.md'), branch: { 'docs/private/a.md': 'x\n' }, config: { approve: { deny: ['docs/private/**'] } } }), /denied path: docs\/private\/a\.md/);
  });

  for (const path of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'requirements-dev.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle.kts', 'Gemfile.lock', 'composer.json']) {
    test(`a changed ${path} is inconclusive`, () => {
      inconclusive(fixture({ spec: listed(path), branch: { [path]: 'x\n' } }), /dependency manifest changed/);
    });
  }

  test('a package.json that is unreadable on both sides is inconclusive, never approved', () => {
    inconclusive(fixture({
      base: { 'src/label.js': 'a\n', 'package.json': '{not json' }, spec: listed('package.json'), branch: { 'package.json': '{still not json' },
    }), /dependency manifest changed|could not read the dependencies/);
  });

  test('scope tokens: prose words, directories, globs, absolute and parent paths never widen the scope', () => {
    inconclusive(fixture({ spec: SPEC('Edit src/label.js without backticks') }), /no files listed/);
    inconclusive(fixture({ spec: SPEC('- `src/label.js`\n- `src/`') }), /names a directory, glob or unsafe path \(src\/\)/);
    inconclusive(fixture({ spec: SPEC('- `src/label.js`\n- `src/*.js`') }), /unsafe path \(src\/\*\.js\)/);
    inconclusive(fixture({ spec: SPEC('- `src/label.js`\n- `/etc/passwd`') }), /unsafe path \(\/etc\/passwd\)/);
    inconclusive(fixture({ spec: SPEC('- `src/label.js`\n- `../outside.js`') }), /unsafe path \(\.\.\/outside\.js\)/);
    assert.match(fixture({ spec: SPEC('- `src/label.js:10-20`: the label') }).run().stdout, /^approve/);
  });

  const SELECTOR = '`:root[data-theme="light"]`';

  test('AC-1: a code token in ## Design is ignored, not flagged as an unsafe path', () => {
    const res = fixture({ spec: SPEC(`- \`src/label.js\`: the label\n- ${SELECTOR}: light theme selector`) }).run();
    assert.match(res.stdout, /^approve/);
    assert.doesNotMatch(res.stdout, /unsafe path/);
  });

  test('AC-2: a code token in the lane xs intake ## Scope is ignored', () => {
    const xsJob = { lane: 'xs', intake: { decision: 'ACCEPT', risk: 'low', surfaces: ['ui'], rescoped: false, size: 'xs' } };
    const intake = `ACCEPT\nRISK: low\nSURFACES: ui\nRESCOPED: no\nSIZE: xs\n\n## Scope\n- \`src/label.js\`: the label\n- ${SELECTOR}: selector\n`;
    assert.match(fixture({ job: xsJob, spec: null, intake }).run().stdout, /^approve/);
  });

  test('AC-3: real globs and unsafe paths stay inconclusive, one case per token', () => {
    for (const token of ['src/**', '*.js', 'src/{a,b}.js', '../x', '/abs', 'dir/']) {
      const t = fixture({ spec: SPEC(`- \`src/label.js\`\n- \`${token}\``) });
      inconclusive(t, /names a directory, glob or unsafe path/);
      assert.ok(t.run().stdout.includes(token), token);
    }
  });

  test('AC-4: a code token that is also an absolute, parent or directory path stays unsafe', () => {
    const text = '- `/etc/x("y")`\n- `../a=b.js`\n- `dir(1)/`';
    assert.deepEqual(scopeTokens(`## Design\n${text}\n`, 'Design').unsafe, ['/etc/x("y")', '../a=b.js', 'dir(1)/']);
  });

  test('AC-5: a Design with only code tokens has no files and no unsafe path', () => {
    const tokens = ['`:root[data-theme="light"]`', '`fn(x)`', "`a[href='x']`", '`x=1`'].map((t) => `- ${t}`).join('\n');
    const t = fixture({ spec: SPEC(tokens) });
    inconclusive(t, /no files listed/);
    assert.doesNotMatch(t.run().stdout, /unsafe path/);
    const { files, unsafe } = scopeTokens(`## Design\n${tokens}\n`, 'Design');
    assert.equal(files.size, 0);
    assert.deepEqual(unsafe, []);
  });
});
