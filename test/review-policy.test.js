// P3: an optional factory/review.md per repo that the four review lenses read after project.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initReview } from '../factory/lib/init.js';
import { createDashboardServer } from '../factory/lib/dashboard.js';

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
  }
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

function sandbox(withReview) {
  const root = mkdtempSync(join(tmpdir(), 'factory-review-prompt-'));
  const id = '007-thing';
  mkdirSync(join(root, 'factory/jobs', id), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ base: 'origin/main' }));
  if (withReview) writeFileSync(join(root, 'factory/review.md'), '# Review policy\n');
  writeFileSync(join(root, 'factory/jobs', id, 'job.json'), JSON.stringify({
    id, issue: 7, branch: `factory/${id}`, worktree: join(root, 'wt'), port: 3007, stage: 'review', round: 1,
    agents: { reviewers: { code: 'sonnet' } },
  }));
  return { root, id, prompt: () => spawnSync(join(repo, 'factory/bin/job'), [id, 'prompt'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root } }) };
}

test('P3 AC-3: the reviewer prompt names factory/review.md only when it exists', () => {
  const withFile = sandbox(true).prompt();
  assert.equal(withFile.status, 0, withFile.stderr);
  assert.match(withFile.stdout, /^Review policy: factory\/review\.md$/m);
  const without = sandbox(false).prompt();
  assert.equal(without.status, 0, without.stderr);
  assert.doesNotMatch(without.stdout, /Review policy/);
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
