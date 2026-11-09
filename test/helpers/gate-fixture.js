// Shared fixture for the gate-report tests: a main checkout, a bare origin and one job worktree.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const HEADER = /^([A-Z][A-Z-]{1,15}):[ \t]+(\S.*)$/;

/** The desktop's view of an artifact: first line, then the KEY: value lines right under it. */
export function desktopHeader(text) {
  const lines = text.split('\n');
  const fields = {};
  for (const line of lines.slice(1)) {
    const m = HEADER.exec(line);
    if (!m) break;
    fields[m[1]] = m[2];
  }
  return { first: lines[0], fields };
}

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ID = '001-contract';

export function gateFixture(checks = '#!/bin/sh\necho "checks passed"\nexit 0\n') {
  const dir = mkdtempSync(join(tmpdir(), 'factory-contract-'));
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git'));
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\nfactory/board.json\n.worktrees/\n');
  writeFileSync(join(root, 'factory/config.json'), readFileSync(join(repo, 'factory/config.json'), 'utf8'));
  writeFileSync(join(root, 'factory/checks.sh'), checks);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', join(dir, 'origin.git'));
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  const worktree = join(root, '.worktrees', ID);
  git(root, 'worktree', 'add', '-q', worktree, '-b', `factory/${ID}`, 'origin/main');
  const jobDir = join(root, 'factory/jobs', ID);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ id: ID, issue: 1, branch: `factory/${ID}`, worktree, stage: 'gate', round: 1, max_rounds: 3 }));
  const env = { ...process.env, ...GIT_ENV, FACTORY_ROOT: root };
  return {
    root, worktree, jobDir, env,
    gate: (...a) => spawnSync(join(repo, 'factory/bin/gate'), [ID, ...a], { cwd: root, env, encoding: 'utf8' }),
    report: (rel = 'round-1/checks.md') => readFileSync(join(jobDir, rel), 'utf8'),
    head: () => git(worktree, 'rev-parse', 'HEAD'),
  };
}

