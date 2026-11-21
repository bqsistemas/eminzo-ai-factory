// The installed CLI runs an engine command as `node <engine>/lib/<command>.js` (cli/src/engine.js); only a repository
// that commits its own engine uses factory/bin/<command>. So the file the CLI resolves must run the command itself.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../cli/build.mjs';
import { ENGINE_COMMANDS, JOB_ALIASES } from '../cli/src/engine.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = join(repo, 'cli/bin/eminzo.js');
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x' };
let dist;

before(() => {
  dist = join(mkdtempSync(join(tmpdir(), 'eminzo-gate-dist-')), 'dist');
  build({ out: dist });
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });

test('eminzo gate <id> through the installed CLI runs the gate and writes round-N/checks.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eminzo-gate-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\n.worktrees/\n');
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ base: 'origin/main', checks: {} }));
  writeFileSync(join(root, 'factory/checks.sh'), '#!/bin/sh\necho checks passed\n', { mode: 0o755 });
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  const id = '045-feat-x';
  const worktree = join(root, '.worktrees', id);
  git(root, 'worktree', 'add', '-q', worktree, '-b', `factory/${id}`, 'origin/main');
  mkdirSync(join(root, 'factory/jobs', id), { recursive: true });
  writeFileSync(join(root, 'factory/jobs', id, 'job.json'), JSON.stringify({ id, issue: 1, branch: `factory/${id}`, worktree, stage: 'gate', round: 1, max_rounds: 3 }));
  const env = { ...process.env, ...GIT_ENV, HOME: home, EMINZO_DIST: dist };
  for (const name of ['EMINZO_ENGINE', 'FACTORY_ROOT', 'NODE_TEST_CONTEXT']) delete env[name];

  const res = spawnSync(process.execPath, [bin, 'gate', id], { cwd: root, env, encoding: 'utf8' });
  const report = join(root, 'factory/jobs', id, 'round-1/checks.md');
  assert.equal(existsSync(report), true, `no checks.md (exit ${res.status}): ${res.stdout}${res.stderr}`);
  assert.equal(readFileSync(report, 'utf8').split('\n')[0], 'GATE: PASS');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, new RegExp(`${id} GATE: PASS`));
});

test('every engine command run by node starts its command line when the CLI runs its file', () => {
  const nodeCommands = ENGINE_COMMANDS.filter((c) => !Object.hasOwn(JOB_ALIASES, c) && !['setup', 'setup-spec-review'].includes(c));
  assert.ok(nodeCommands.includes('gate') && nodeCommands.includes('job'));
  for (const command of nodeCommands) {
    const file = join(dist, 'factory/lib', `${command}.js`); // what cli/src/engine.js runs
    assert.equal(existsSync(file), true, `${file} exists`);
    // Run as the main script it must start its CLI: a file with no isMain branch exits 0 and does nothing.
    assert.match(readFileSync(file, 'utf8'), /isMain\(import\.meta\.url\)/, `${command}.js starts its command line when it is the main script`);
  }
});
