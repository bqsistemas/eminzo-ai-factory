// Shared fixture for the base-check tests: a main checkout (factory/config.json, factory/checks.sh), a bare
// origin, and helpers to move origin/main and to run `factory/bin/base` on it. Never talks to GitHub.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = fileURLToPath(new URL('../..', import.meta.url));
export const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x' };
export const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A checks.sh that counts its runs in $FACTORY_ROOT/runs and fails while BROKEN exists in the checked tree. */
export const COUNTING = '#!/bin/sh\necho run >> "$FACTORY_ROOT/runs"\ntest ! -f BROKEN\n';
export const GREEN = '#!/bin/sh\necho "checks passed"\nexit 0\n';

/**
 * @param {{ checks?: string, config?: object, files?: Record<string,string> }} [options] `config` is merged into
 *   factory/config.json (`checks: { prepare }` for the prepare step); `files` are committed to main.
 */
export function baseFixture({ checks = COUNTING, config = {}, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-base-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\nfactory/board.json\n.worktrees/\nignored.dat\n');
  const base = JSON.parse(readFileSync(join(repo, 'factory/config.json'), 'utf8'));
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ ...base, language: 'en', ...config }, null, 2));
  writeFileSync(join(root, 'factory/checks.sh'), checks, { mode: 0o755 });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  const env = { ...process.env, ...GIT_ENV, FACTORY_ROOT: root, FACTORY_BASE_LOCK_WAIT_MS: '400', FACTORY_BASE_LOCK_POLL_MS: '40' };
  delete env.FACTORY_BASE;
  delete env.FACTORY_HEAD;
  delete env.EMINZO_ENGINE;
  return {
    dir, root, origin, env,
    /** Commits `files` on main and pushes it, so origin/main moves. Returns the new sha. */
    push(files = {}, message = 'chore: move main') {
      for (const [name, text] of Object.entries(files)) {
        if (text === null) git(root, 'rm', '-q', '-f', name);
        else { writeFileSync(join(root, name), text); git(root, 'add', name); }
      }
      git(root, 'commit', '-q', '--allow-empty', '-m', message);
      git(root, 'push', '-q', 'origin', 'main');
      git(root, 'fetch', '-q', 'origin');
      return git(root, 'rev-parse', 'HEAD');
    },
    bin: (name, args = [], extra = {}) => spawnSync('sh', [join(repo, 'factory/bin', name), ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' }),
    base: (args = [], extra = {}) => spawnSync('sh', [join(repo, 'factory/bin/base'), ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' }),
    runs: () => (existsSync(join(root, 'runs')) ? readFileSync(join(root, 'runs'), 'utf8').trim().split('\n').length : 0),
    state: () => JSON.parse(readFileSync(join(root, 'factory/jobs/.base/state.json'), 'utf8')),
    report: (rel) => readFileSync(join(root, 'factory/jobs/.base', rel), 'utf8'),
    tip: () => git(root, 'rev-parse', 'origin/main'),
  };
}
