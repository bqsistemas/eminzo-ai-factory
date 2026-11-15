// Fixture for the red-base tests (hold and resume): the job harness (a real repo, a bare origin and a fake gh for
// issues and PRs) plus a fake gh that also answers `issue list --label` and `issue create` (the fix issue), and a
// checks.sh that fails while BROKEN exists and counts the runs it makes in the base worktree. Never talks to GitHub.
import { spawn } from 'node:child_process';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fakeGhIssues } from './fake-gh-issues.js';
import { INTAKE, git, ok, repo, setup, toGate } from './job-harness.js';

export { INTAKE, git, ok, repo, toGate };
export { refused } from './job-harness.js';

const CHECKS = `#!/bin/sh
case "$PWD" in */.worktrees/.base) echo run >> "$FACTORY_ROOT/base-runs" ;; esac
echo "checks: running"
if [ -f BROKEN ]; then echo "checks: BROKEN is present"; exit 1; fi
echo "checks: ok"
`;

const run = (cmd, args, opts) => new Promise((resolve) => {
  const child = spawn(cmd, args, opts);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

/**
 * @param {{ broken?: boolean, prepare?: string, maxRounds?: number, issues?: object }} [options]
 *   `broken` commits BROKEN to main before any job exists; `prepare` is checks.prepare; `issues` go to the fake issue gh.
 */
export function redBase({ broken = true, prepare = '', maxRounds, issues } = {}) {
  const t = setup();
  const config = JSON.parse(readFileSync(join(t.root, 'factory/config.json'), 'utf8'));
  config.checks = { ...config.checks, prepare };
  if (maxRounds) config.max_rounds = maxRounds;
  writeFileSync(join(t.root, 'factory/config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(t.root, 'factory/checks.sh'), CHECKS, { mode: 0o755 });
  if (broken) writeFileSync(join(t.root, 'BROKEN'), 'x\n');
  git(t.root, 'add', '.');
  git(t.root, 'commit', '-q', '-m', 'chore: checks');
  git(t.root, 'push', '-q', 'origin', 'main');
  git(t.root, 'fetch', '-q', 'origin');

  const fake = fakeGhIssues(join(t.dir, 'fake'), issues);
  const jobsGh = join(t.dir, 'gh-jobs');
  renameSync(t.gh, jobsGh);
  writeFileSync(t.gh, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const target = args[0] === 'issue' && (args[1] === 'list' || args[1] === 'create') ? ${JSON.stringify(fake.gh)} : ${JSON.stringify(jobsGh)};
process.exit(spawnSync(target, args, { stdio: 'inherit' }).status ?? 1);
`);
  chmodSync(t.gh, 0o755);

  return {
    ...t,
    fake,
    gate: (id) => run(join(repo, 'factory/bin/gate'), [id], { cwd: t.root, env: t.env }),
    base: (id, ...extra) => t.job(id, 'base', ...extra),
    /** How many times checks.sh ran in the base worktree. */
    baseRuns() {
      try { return readFileSync(join(t.root, 'base-runs'), 'utf8').trim().split('\n').length; } catch { return 0; }
    },
    /** Commits `files` on main (null removes) and pushes it. Returns the new sha. */
    pushMain(files, message = 'fix: main') {
      for (const [name, text] of Object.entries(files)) {
        if (text === null) git(t.root, 'rm', '-q', '-f', name);
        else { writeFileSync(join(t.root, name), text); git(t.root, 'add', name); }
      }
      git(t.root, 'commit', '-q', '--allow-empty', '-m', message);
      git(t.root, 'push', '-q', 'origin', 'main');
      git(t.root, 'fetch', '-q', 'origin');
      return git(t.root, 'rev-parse', 'HEAD');
    },
    /** Commits `files` in the job's worktree. */
    commit(id, files, message = 'feat: job work') {
      const { worktree } = t.json(id);
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(worktree, name), text);
        git(worktree, 'add', name);
      }
      git(worktree, 'commit', '-q', '-m', message);
    },
    /** A job at gate in round 1 with a real gate report (GATE: FAIL when main is broken). */
    async gated(n = 7, { labels } = {}) {
      t.issue(n, { title: 'Fix me', ...(labels ? { labels: labels.map((name) => ({ name })) } : {}) });
      const id = ok(t, await t.job('new', String(n)));
      await toGate(t, id, 30 + n);
      await run(join(repo, 'factory/bin/gate'), [id], { cwd: t.root, env: t.env });
      return id;
    },
  };
}
