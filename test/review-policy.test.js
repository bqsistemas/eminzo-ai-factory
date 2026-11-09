// P3: an optional factory/review.md per repo that the four review lenses read after project.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initReview } from '../factory/lib/init.js';
import { createDashboardServer } from '../factory/lib/dashboard.js';
import { DEFAULT_DENY, isDenied } from '../factory/lib/diff.js';
import { ENGINE_EXCLUDE, build } from '../cli/build.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(repo, rel), 'utf8');
const LENSES = ['code', 'security', 'ui', 'ux'];

test('P3 AC-1: each review role reads factory/review.md after project.md when it exists', () => {
  for (const lens of LENSES) {
    const role = read(`factory/roles/review-${lens}.md`);
    const project = role.indexOf('- `factory/project.md`');
    const review = role.indexOf('- `factory/review.md`, when it exists');
    assert.ok(project >= 0 && review > project, `review-${lens}.md names review.md after project.md`);
    assert.match(role, /cap on the `\[minor\]` findings/, lens);
    assert.match(role, /Without the file, nothing changes/, lens);
    assert.match(role, /Read the copy in the MAIN checkout[^\n]*never the one in the job worktree/, lens);
    assert.match(role, /never suppresses a `\[blocker\]`, a security finding or a failed acceptance criterion/, lens);
    assert.match(role, /If a `\[blocker\]` matches a skip rule, report it anyway/, lens);
  }
  assert.doesNotMatch(read('factory/roles/approver.md'), /review\.md/, 'the approver does not read the review policy');
});

test('P3: a branch that edits factory/review.md is denied like checks.sh and config.json', () => {
  assert.ok(DEFAULT_DENY.includes('factory/review.md'));
  for (const f of ['factory/review.md', 'factory/checks.sh', 'factory/config.json']) assert.equal(isDenied(f, {}), true, f);
  assert.equal(isDenied('docs/review.md', {}), false);
});

test('P3: the build keeps the repo review.md out of the engine and ships the template', () => {
  assert.ok(ENGINE_EXCLUDE.has('review.md'));
  assert.ok(existsSync(join(repo, 'factory/templates/review.md')));
  const out = mkdtempSync(join(tmpdir(), 'factory-review-build-'));
  build({ out });
  assert.equal(existsSync(join(out, 'factory/review.md')), false, 'dist/factory/review.md is absent');
  assert.equal(existsSync(join(out, 'factory/templates/review.md')), true, 'dist/factory/templates/review.md is present');
});

test('P3 AC-2: the template exists and init copies it only when review.md is absent', () => {
  const template = read('factory/templates/review.md');
  assert.match(template, /<!--/);
  assert.match(template, /Minor cap/i);
  const root = mkdtempSync(join(tmpdir(), 'factory-review-'));
  const first = initReview(root);
  assert.equal(first.created, true);
  assert.equal(readFileSync(join(root, 'factory/review.md'), 'utf8'), template);
  writeFileSync(join(root, 'factory/review.md'), 'my policy\n');
  const second = initReview(root);
  assert.equal(second.created, false);
  assert.equal(readFileSync(join(root, 'factory/review.md'), 'utf8'), 'my policy\n');
});

function sandbox(withReview, { round = 1, reviewers = { code: 'sonnet' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-review-prompt-'));
  const id = '007-thing';
  mkdirSync(join(root, 'factory/jobs', id), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ base: 'origin/main' }));
  if (withReview) writeFileSync(join(root, 'factory/review.md'), '# Review policy\n');
  writeFileSync(join(root, 'factory/jobs', id, 'job.json'), JSON.stringify({
    id, issue: 7, branch: `factory/${id}`, worktree: join(root, 'wt'), port: 3007, stage: 'review', round,
    agents: { reviewers },
  }));
  return { root, id, prompt: () => spawnSync(join(repo, 'factory/bin/job'), [id, 'prompt'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root } }) };
}

test('P3 AC-3: the reviewer prompt names factory/review.md only when it exists', () => {
  const withFile = sandbox(true).prompt();
  assert.equal(withFile.status, 0, withFile.stderr);
  assert.match(withFile.stdout, /^Review policy: factory\/review\.md \(main checkout\)$/m);
  const without = sandbox(false).prompt();
  assert.equal(without.status, 0, without.stderr);
  assert.doesNotMatch(without.stdout, /Review policy/);
});

test('P3 AC-3: no reviewer line before round 1, and none for a job with no routed reviewers', () => {
  for (const opts of [{ round: 0 }, { reviewers: {} }]) {
    const res = sandbox(true, opts).prompt();
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /Review policy/, JSON.stringify(opts));
  }
});

test('P3: the prompt points at the main checkout, not the job worktree', () => {
  const s = sandbox(true);
  const out = s.prompt().stdout;
  const worktree = out.match(/^Worktree: (.+)$/m)[1];
  assert.ok(worktree.startsWith(s.root));
  assert.doesNotMatch(out.match(/^Review policy: .+$/m)[0], new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(read('factory/roles/review-code.md'), /MAIN checkout/);
});

test('P3 AC-4: the dashboard serves factory/review.md, from the repo folder when the page comes from the engine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-review-dash-'));
  const engine = join(dir, 'engine');
  const data = join(dir, 'data');
  mkdirSync(engine);
  mkdirSync(data);
  writeFileSync(join(engine, 'dashboard.html'), '<html></html>');
  writeFileSync(join(data, 'review.md'), 'repo policy\n');
  writeFileSync(join(engine, 'review.md'), 'engine copy must not be served\n');
  for (const [server, expected] of [[createDashboardServer(data), 'repo policy\n'], [createDashboardServer(engine, { data }), 'repo policy\n']]) {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/review.md`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), expected);
    } finally {
      server.close();
    }
  }
});

test('P3 AC-2: `init review` writes only review.md, and plain `init` never does', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-review-cli-'));
  const run = (...args) => spawnSync(join(repo, 'factory/bin/init'), args, { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root } });
  assert.equal(run().status, 0);
  assert.throws(() => readFileSync(join(root, 'factory/review.md')));
  assert.equal(run('review').status, 0);
  assert.equal(readFileSync(join(root, 'factory/review.md'), 'utf8'), read('factory/templates/review.md'));
});
