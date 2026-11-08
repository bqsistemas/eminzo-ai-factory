// The engine finds its own files from where it runs. An engine committed in the repo (this
// repo, a kit install) keeps using <root>/factory exactly as before; the installed `eminzo`
// CLI sets EMINZO_ENGINE to its own engine folder, and then the visual runner, the checks
// fingerprint, the dashboard assets and the command hints come from there, while the repo's
// data (config, checks.sh, jobs, board) still comes from the repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checksInputs } from '../factory/lib/check-stamp.js';
import { createDashboardServer } from '../factory/lib/dashboard.js';
import { runVisualCheck } from '../factory/lib/gate.js';
import { engineCommand, engineDir, installedEngine } from '../factory/lib/util.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const configText = readFileSync(join(repo, 'factory/config.json'), 'utf8');

/** Runs `fn` with EMINZO_ENGINE set to `dir` (or unset for null), then restores it. */
async function withEngine(dir, fn) {
  const before = process.env.EMINZO_ENGINE;
  if (dir === null) delete process.env.EMINZO_ENGINE; else process.env.EMINZO_ENGINE = dir;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.EMINZO_ENGINE; else process.env.EMINZO_ENGINE = before;
  }
}

/** A repo root with factory/config.json and checks.sh, and an engine folder outside it. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-engine-location-'));
  const root = join(dir, 'repo');
  const engine = join(dir, 'engine');
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), configText);
  writeFileSync(join(root, 'factory/checks.sh'), '#!/bin/sh\nexit 0\n');
  for (const sub of ['lib', 'bin']) mkdirSync(join(engine, sub), { recursive: true });
  writeFileSync(join(engine, 'lib/a.js'), 'export const a = 1;\n');
  writeFileSync(join(engine, 'bin/job'), '#!/bin/sh\n');
  return { dir, root, engine };
}

test('without EMINZO_ENGINE the engine is the repo\'s own factory/ folder and hints name factory/bin', async () => {
  await withEngine(null, () => {
    assert.equal(installedEngine(), null);
    assert.equal(engineDir('/some/repo'), join('/some/repo', 'factory'));
    assert.equal(engineCommand('job'), 'factory/bin/job');
  });
});

test('with EMINZO_ENGINE the engine is that folder and hints name the eminzo command', async () => {
  const { engine } = fixture();
  await withEngine(engine, () => {
    assert.equal(installedEngine(), engine);
    assert.equal(engineDir('/some/repo'), engine);
    assert.equal(engineCommand('job'), 'eminzo job');
  });
});

test('checksInputs hashes the installed engine\'s files, not the repo\'s factory/lib', async () => {
  const { root, engine } = fixture();
  await withEngine(engine, () => {
    const before = checksInputs(root);
    mkdirSync(join(root, 'factory/lib'), { recursive: true });
    writeFileSync(join(root, 'factory/lib/stray.js'), '// not the engine\n');
    assert.equal(checksInputs(root), before, 'a repo file under factory/lib is not the engine');
    writeFileSync(join(engine, 'lib/a.js'), 'export const a = 2;\n');
    assert.notEqual(checksInputs(root), before, 'an engine change invalidates a recorded pass');
    const changed = checksInputs(root);
    writeFileSync(join(root, 'factory/checks.sh'), '#!/bin/sh\nexit 1\n');
    assert.notEqual(checksInputs(root), changed, 'checks.sh still comes from the repo');
  });
});

test('checksInputs without EMINZO_ENGINE still hashes the repo\'s factory/lib and factory/bin', async () => {
  const { root } = fixture();
  await withEngine(null, () => {
    const before = checksInputs(root);
    mkdirSync(join(root, 'factory/lib'), { recursive: true });
    writeFileSync(join(root, 'factory/lib/x.js'), '// engine\n');
    assert.notEqual(checksInputs(root), before);
  });
});

test('the gate runs the installed engine\'s visual runner, never one in the repo', async () => {
  const { dir, root, engine } = fixture();
  const ranEngine = join(dir, 'ran-engine');
  const ranRepo = join(dir, 'ran-repo');
  writeFileSync(join(engine, 'bin/visual'), `#!/bin/sh\necho ran > "${ranEngine}"\nprintf 'VISUAL: PASS\\n' > "$3"\n`, { mode: 0o755 });
  mkdirSync(join(root, 'factory/bin'), { recursive: true });
  writeFileSync(join(root, 'factory/bin/visual'), `#!/bin/sh\necho ran > "${ranRepo}"\nprintf 'VISUAL: FAIL\\n' > "$3"\nexit 1\n`, { mode: 0o755 });
  const config = { visual: { start: 'x', ready_url: 'http://x/' } };
  const job = { id: '001-x', intake: { surfaces: ['ui'] } };
  const result = await withEngine(engine, () => runVisualCheck(root, config, job, join(dir, 'round-1/checks.md')));
  assert.equal(result.status, 'PASS');
  assert.equal(readFileSync(ranEngine, 'utf8').trim(), 'ran');
  assert.throws(() => readFileSync(ranRepo), 'the repo copy never runs');
});

/** GETs `path` from a dashboard server built by `make`, then closes it. */
async function get(make, path) {
  const server = make();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, text: await res.text() };
  } finally {
    await new Promise((ok) => server.close(ok));
  }
}

test('the dashboard serves its page from the engine and board.json and jobs/ from the repo', async () => {
  const { root, engine } = fixture();
  const data = join(root, 'factory');
  writeFileSync(join(engine, 'dashboard.html'), 'engine page');
  writeFileSync(join(data, 'dashboard.html'), 'repo page');
  writeFileSync(join(engine, 'board.json'), '{"from":"engine"}');
  writeFileSync(join(data, 'board.json'), '{"from":"repo"}');
  mkdirSync(join(data, 'jobs/001-x'), { recursive: true });
  writeFileSync(join(data, 'jobs/001-x/spec.md'), 'repo spec');
  const make = () => createDashboardServer(engine, { data });
  assert.equal((await get(make, '/dashboard.html')).text, 'engine page');
  assert.equal((await get(make, '/')).text, 'engine page');
  assert.equal((await get(make, '/board.json')).text, '{"from":"repo"}');
  assert.equal((await get(make, '/jobs/001-x/spec.md')).text, 'repo spec');
  assert.equal((await get(make, '/jobs/../config.json')).status, 404);
  assert.equal((await get(make, '/config.json')).status, 404, 'repo files other than the board and jobs are not served');
});

test('the dashboard without a data folder serves everything from one folder, as before', async () => {
  const { root } = fixture();
  const dir = join(root, 'factory');
  writeFileSync(join(dir, 'dashboard.html'), 'page');
  writeFileSync(join(dir, 'board.json'), '{}');
  const make = () => createDashboardServer(dir);
  assert.equal((await get(make, '/dashboard.html')).text, 'page');
  assert.equal((await get(make, '/board.json')).text, '{}');
});

test('no factory/lib file builds an engine path by joining a root with factory/bin, lib, roles or templates', () => {
  const lib = join(repo, 'factory/lib');
  const offenders = readdirSync(lib).filter((f) => f.endsWith('.js'))
    .filter((f) => /join\([^)]*['"`]factory\/(bin|lib|roles|templates)\b/.test(readFileSync(join(lib, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('job.js hints never hardcode factory/bin/job; they go through engineCommand', () => {
  const lines = readFileSync(join(repo, 'factory/lib/job.js'), 'utf8').split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l) && /factory\/bin\/job \$\{/.test(l));
  assert.deepEqual(lines, []);
});

test('a refusal names `eminzo job` under the installed engine and `factory/bin/job` otherwise', () => {
  const { root, engine } = fixture();
  const id = '007-spec-review';
  const jobDir = join(root, 'factory/jobs', id);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'spec.md'), '# Spec\n');
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({
    id, issue: 7, title: 'x', pr: null, branch: `factory/${id}`, worktree: join(root, 'wt'), port: 3001,
    stage: 'spec-review', round: 0, max_rounds: 3, provider: 'claude', lane: 'normal',
    intake: { decision: 'ACCEPT', rescoped: false, risk: 'high', surfaces: [] },
  }));
  writeFileSync(join(root, 'factory/config.local.json'), JSON.stringify({ spec_review: true }));
  const toBuild = (engineFolder) => {
    const env = { ...process.env, FACTORY_ROOT: root };
    if (engineFolder) env.EMINZO_ENGINE = engineFolder; else delete env.EMINZO_ENGINE;
    return spawnSync(process.execPath, [join(repo, 'factory/lib/job.js'), id, 'to', 'build'], { encoding: 'utf8', cwd: root, env });
  };
  const inRepo = toBuild(null);
  assert.equal(inRepo.status, 1, inRepo.stderr);
  assert.match(inRepo.stderr, new RegExp(`factory/bin/job ${id} approve-spec`));
  const installed = toBuild(engine);
  assert.equal(installed.status, 1, installed.stderr);
  assert.match(installed.stderr, new RegExp(`eminzo job ${id} approve-spec`));
});
