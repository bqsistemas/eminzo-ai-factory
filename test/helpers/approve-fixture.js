// Shared fixture for the factory/bin/approve tests (split across test/approve*.test.js so
// the runner can execute them in parallel processes).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeTokens } from '../../factory/lib/diff.js';

export const repo = fileURLToPath(new URL('../..', import.meta.url));
export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
};
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const ID = '012-rename-label';

export const SPEC = (design = '- `src/label.js`: the label') => `# Spec: Rename\n\n## Goal\nRename.\n\n## Design\n${design}\n\n## Acceptance criteria\n- AC-1: x\n`;

/**
 * A repo whose branch factory/<ID> changes `branch` files over a base that has `base` files, with the
 * job folder at stage approve. `main` files are committed on main after the branch left it.
 */
export function fixture({
  base = { 'src/label.js': 'a\n', 'package.json': '{"name":"x","dependencies":{},"devDependencies":{}}\n' },
  branch = { 'src/label.js': 'b\n' }, main = null,
  spec = SPEC(), intake = 'ACCEPT\nRISK: low\nSURFACES: ui\nRESCOPED: no\nSIZE: xs\n\n## Scope\n- `src/label.js`: the label\n',
  job = {}, config = {}, edit = null, verdicts = { code: 'PASS' }, gate = 'GATE: PASS', build = 'STATUS: READY\n\n## Spec deviations\nNone\n',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-approve-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  const put = (files) => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
  };
  const cfg = { base: 'origin/main', protected_tests: ['test/job.test.js'], ...config };
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(cfg));
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\nfactory/config.json\n');
  put(base);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'switch', '-q', '-c', `factory/${ID}`);
  put(branch);
  if (edit) edit(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'feat: change');
  git(root, 'switch', '-q', 'main');
  if (main) {
    put(main);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'feat: main moved');
    git(root, 'push', '-q', 'origin', 'main');
  }
  git(root, 'fetch', '-q', 'origin');

  const head = git(root, 'rev-parse', `factory/${ID}`);
  const jobDir = join(root, 'factory/jobs', ID);
  const write = (rel, text) => { mkdirSync(dirname(join(jobDir, rel)), { recursive: true }); writeFileSync(join(jobDir, rel), text); };
  const data = {
    id: ID, issue: 12, stage: 'approve', round: 1, max_rounds: 3, lane: 'normal', round_heads: { 1: head, 2: head },
    intake: { decision: 'ACCEPT', risk: 'low', surfaces: ['ui'], rescoped: false },
    agents: { builder: 'sonnet', reviewers: Object.fromEntries(Object.keys(verdicts).map((l) => [l, 'haiku'])) },
    ...job,
  };
  write('job.json', JSON.stringify(data));
  if (spec !== null) write('spec.md', spec);
  write('intake.md', intake);
  write('build.md', build);
  write('round-1/checks.md', `${gate}\n`);
  for (const [lens, v] of Object.entries(verdicts)) write(`round-1/review-${lens}.md`, `VERDICT: ${v}\n`);
  const run = () => spawnSync(join(repo, 'factory/bin/approve'), [ID], { cwd: root, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, FACTORY_ROOT: root } });
  return { root, write, run, decision: () => (existsSync(join(jobDir, 'decision.md')) ? readFileSync(join(jobDir, 'decision.md'), 'utf8') : null) };
}

export const inconclusive = (t, pattern) => {
  const res = t.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^inconclusive: /);
  assert.match(res.stdout, pattern);
  assert.equal(t.decision(), null, 'inconclusive writes nothing');
};
