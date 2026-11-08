// Plan P1-1: factory/bin/approve, the deterministic approver. APPROVE and ESCALATE write
// decision.md; anything else is "inconclusive" and writes nothing (the LLM approver runs).
// APPROVE, ESCALATE, inconclusive, refusals and full diff visibility.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeTokens } from '../factory/lib/diff.js';

import { GIT_ENV, ID, SPEC, fixture, git, inconclusive, repo } from './helpers/approve-fixture.js';

describe('bin/approve: APPROVE', () => {
  test('all checks pass: writes APPROVE with the deciding line', () => {
    const t = fixture();
    const res = t.run();
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^approve/);
    const text = t.decision();
    assert.equal(text.split('\n')[0], 'APPROVE');
    assert.match(text, /^Decided by: factory\/bin\/approve$/m);
    assert.match(text, /- \[x\] Last gate PASS/);
  });

  test('an added test, a listed modified test and a non-conflicting moved base stay inside the scope', () => {
    const t = fixture({
      base: { 'src/label.js': 'a\n', 'test/label.test.js': 't\n', 'other.txt': 'o\n' },
      branch: { 'src/label.js': 'b\n', 'test/label.test.js': 'u\n', 'test/new.test.js': 'n\n' },
      spec: SPEC('- `src/label.js:1-4`\n- `test/label.test.js`'),
      main: { 'other.txt': 'changed on main\n' },
    });
    assert.match(t.run().stdout, /^approve/);
  });

  test('a carried lens verdict from an earlier round counts', () => {
    const t = fixture({ verdicts: { code: 'PASS' }, job: { round: 2 } });
    t.write('round-2/checks.md', 'GATE: PASS\n');
    t.write('job.json', readFileSync(join(t.root, 'factory/jobs', ID, 'job.json'), 'utf8').replace('"haiku"}', '"haiku","ui":"haiku"}'));
    t.write('round-1/review-ui.md', 'VERDICT: PASS\n');
    t.write('round-2/review-code.md', 'VERDICT: PASS\n');
    assert.match(t.run().stdout, /^approve/);
  });

  test('an xs job without spec.md is judged against intake.md ## Scope', () => {
    const t = fixture({ spec: null, job: { lane: 'xs' } });
    assert.match(t.run().stdout, /^approve/);
    const out = fixture({ spec: null, job: { lane: 'xs' }, branch: { 'src/other.js': 'x\n' } });
    inconclusive(out, /outside the scope: src\/other\.js/);
  });
});

describe('bin/approve: ESCALATE (hard, deterministic blockers)', () => {
  test('a merge conflict with the base escalates with the reason', () => {
    const t = fixture({ main: { 'src/label.js': 'main\n' } });
    const res = t.run();
    assert.match(res.stdout, /^escalate: /);
    const lines = t.decision().split('\n');
    assert.equal(lines[0], 'ESCALATE');
    assert.match(lines[1], /conflict/);
    assert.match(t.decision(), /Decided by: factory\/bin\/approve/);
  });

  test('a changed runtime dependency in package.json escalates', () => {
    const t = fixture({
      spec: SPEC('- `src/label.js`\n- `package.json`'),
      branch: { 'src/label.js': 'b\n', 'package.json': '{"name":"x","dependencies":{"left-pad":"1.0.0"},"devDependencies":{}}\n' },
    });
    const res = t.run();
    assert.match(res.stdout, /^escalate: .*runtime dependenc/);
    assert.equal(t.decision().split('\n')[0], 'ESCALATE');
  });

  test('a devDependencies-only change in package.json is not an escalation, but any manifest change is inconclusive', () => {
    const t = fixture({
      spec: SPEC('- `src/label.js`\n- `package.json`'),
      branch: { 'package.json': '{"name":"x","dependencies":{},"devDependencies":{"eslint":"9.0.0"}}\n' },
    });
    inconclusive(t, /dependency manifest changed: package\.json/);
  });
});

describe('bin/approve: inconclusive (the LLM approver decides)', () => {
  test('a file outside the spec Design, and unknown files, make it inconclusive', () => {
    inconclusive(fixture({ branch: { 'src/label.js': 'b\n', 'docs/notes.md': 'n\n' } }), /outside the scope: docs\/notes\.md/);
  });

  test('a spec with no Design files cannot be checked', () => {
    inconclusive(fixture({ spec: '# Spec: x\n\n## Goal\nx\n' }), /no files listed/);
  });

  test('a protected test in the diff forces the LLM', () => {
    inconclusive(fixture({
      base: { 'src/label.js': 'a\n', 'test/job.test.js': 't\n' }, branch: { 'test/job.test.js': 'u\n' },
      spec: SPEC('- `test/job.test.js`'),
    }), /protected test: test\/job\.test\.js/);
  });

  for (const path of ['src/auth.js', 'src/secrets.js', 'lib/credentials.js', 'src/permissions.js', 'db/migration-3.sql', '.env.example']) {
    test(`a sensitive path (${path}) forces the LLM`, () => {
      inconclusive(fixture({ branch: { [path]: 'x\n' }, spec: SPEC(`- \`${path}\``) }), new RegExp(`sensitive path: ${path.replace(/\./g, '\\.')}`));
    });
  }

  test('risk high forces the LLM', () => {
    inconclusive(fixture({ job: { intake: { decision: 'ACCEPT', risk: 'high', surfaces: [], rescoped: false } } }), /risk high/);
  });

  test('a security surface forces the LLM', () => {
    inconclusive(fixture({ job: { intake: { decision: 'ACCEPT', risk: 'low', surfaces: ['security'], rescoped: false } } }), /security surface/);
  });

  test('an accepted spec deviation that touches an AC forces the LLM', () => {
    inconclusive(fixture({ build: 'STATUS: READY\n\n## Spec deviations\nAC-1 | ui round 1: moved\n' }), /spec deviation touches AC-1/);
  });

  test('a changed manifest the script cannot read (requirements.txt) forces the LLM', () => {
    inconclusive(fixture({
      base: { 'src/label.js': 'a\n', 'requirements.txt': 'a==1\n' }, branch: { 'requirements.txt': 'a==1\nb==2\n' },
      spec: SPEC('- `requirements.txt`'),
    }), /dependency manifest changed: requirements\.txt/);
  });

  test('a lens whose latest verdict is CHANGES, a missing review, and a failed gate are not approvals', () => {
    inconclusive(fixture({ verdicts: { code: 'CHANGES' } }), /code latest verdict is CHANGES/);
    const missing = fixture({ verdicts: { code: 'PASS' }, job: { agents: { builder: 'sonnet', reviewers: { code: 'h', ux: 'h' } } } });
    inconclusive(missing, /ux has no verdict/);
    inconclusive(fixture({ gate: 'GATE: FAIL' }), /last gate is not PASS/);
  });

  test('an empty diff is inconclusive', () => {
    inconclusive(fixture({ branch: {} }), /empty|no changes/);
  });
});

describe('bin/approve: refusals', () => {
  test('it refuses a job that is not at the approve stage and an unknown job', () => {
    const t = fixture({ job: { stage: 'review' } });
    const res = t.run();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^refused: /);
    assert.equal(t.decision(), null);
    const none = spawnSync(join(repo, 'factory/bin/approve'), ['999-none'], { cwd: t.root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: t.root } });
    assert.notEqual(none.status, 0);
  });
});

describe('bin/approve: full diff visibility (adversarial review)', () => {
  const listed = (...paths) => SPEC(paths.map((p) => `- \`${p}\``).join('\n'));

  test('a mode change is inconclusive', () => {
    inconclusive(fixture({ branch: {}, edit: (r) => chmodSync(join(r, 'src/label.js'), 0o755) }), /mode change: src\/label\.js/);
  });

  test('a symlink, even to a listed path, is inconclusive', () => {
    inconclusive(fixture({
      spec: listed('src/link.js'), branch: {}, edit: (r) => symlinkSync('/etc/passwd', join(r, 'src/link.js')),
    }), /symlink change: src\/link\.js/);
  });

  test('a binary file is inconclusive', () => {
    inconclusive(fixture({
      spec: listed('src/img.bin'), branch: {}, edit: (r) => writeFileSync(join(r, 'src/img.bin'), Buffer.from([0, 1, 2, 0, 255])),
    }), /binary file: src\/img\.bin/);
  });

  test('a deleted file and a deleted test are inconclusive', () => {
    inconclusive(fixture({ spec: listed('src/label.js'), branch: {}, edit: (r) => rmSync(join(r, 'src/label.js')) }), /deleted file: src\/label\.js/);
    inconclusive(fixture({
      base: { 'src/label.js': 'a\n', 'test/label.test.js': 't\n' }, spec: listed('src/label.js', 'test/label.test.js'),
      edit: (r) => rmSync(join(r, 'test/label.test.js')),
    }), /deleted file: test\/label\.test\.js/);
  });

  test('an added file is in scope only when its exact path is listed; an added test is always allowed', () => {
    inconclusive(fixture({ branch: { 'src/label.js': 'b\n', 'src/extra.js': 'x\n' } }), /outside the scope: src\/extra\.js/);
    assert.match(fixture({ spec: listed('src/label.js', 'src/extra.js'), branch: { 'src/label.js': 'b\n', 'src/extra.js': 'x\n' } }).run().stdout, /^approve/);
    assert.match(fixture({ branch: { 'src/label.js': 'b\n', 'test/extra.test.js': 'x\n' } }).run().stdout, /^approve/);
  });

  test('a modified test is inconclusive unless its exact path is listed', () => {
    const base = { 'src/label.js': 'a\n', 'test/label.test.js': 't\n' };
    inconclusive(fixture({ base, branch: { 'src/label.js': 'b\n', 'test/label.test.js': 'u\n' } }), /outside the scope: test\/label\.test\.js/);
  });
});
