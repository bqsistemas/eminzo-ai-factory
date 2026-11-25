// factory/bin/related: how each related repository of `related_repos` is checked out on this machine, as JSON.
// Read-only: it runs `git rev-parse --is-inside-work-tree` and `git remote get-url origin` in the folders of the
// personal `related_checkouts`, without a shell, and never prints a remote (it can hold a token). No network, no gh.
import { statSync } from 'node:fs';

import { relatedNames, remoteSlug, validRelatedRepos } from './related-repos.js';
import { Usage, effectiveConfig, factoryRoot, isMain, run, runCli } from './util.js';

// The checkout's own origin is what identifies it; it is not the base remote of the factory.
const ORIGIN = `origin`;
const GIT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

function gitEnv() {
  const env = { ...process.env };
  for (const name of GIT_VARS) delete env[name];
  return env;
}

const git = (path, args) => run('git', ['-C', path, ...args], { env: gitEnv() });

/**
 * `ok`: a git checkout whose origin is `repo`; `mismatch`: a checkout with another origin or none; `missing`: no
 * checkout, a path that is not a folder, or a folder that is not a git work tree. `path` is null unless `ok`.
 * @returns {{ state: 'ok' | 'mismatch' | 'missing', path: string | null }}
 */
export function checkoutState(repo, checkouts) {
  const wanted = repo.toLowerCase();
  const key = checkouts && typeof checkouts === 'object' ? Object.keys(checkouts).find((k) => k.toLowerCase() === wanted) : undefined;
  const path = key === undefined ? null : checkouts[key]?.path;
  const missing = { state: 'missing', path: null };
  if (typeof path !== 'string') return missing;
  try {
    if (!statSync(path).isDirectory()) return missing;
  } catch {
    return missing;
  }
  const inside = git(path, ['rev-parse', '--is-inside-work-tree']);
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== 'true') return missing;
  const origin = git(path, ['remote', 'get-url', ORIGIN]);
  const slug = origin.error || origin.status !== 0 ? null : remoteSlug(origin.stdout.trim());
  if (slug === null || slug.toLowerCase() !== wanted) return { state: 'mismatch', path: null };
  return { state: 'ok', path };
}

/** One entry per valid `related_repos` of the effective config, in file order. */
export function relatedRepos(config) {
  const entries = validRelatedRepos(config);
  const names = relatedNames(entries.map((e) => e.repo));
  return entries.map((e, i) => ({ repo: e.repo, name: names[i], description: e.description, ...checkoutState(e.repo, config.related_checkouts) }));
}

export function main(args) {
  if (args.length) throw new Usage('related');
  const { config } = effectiveConfig(factoryRoot());
  process.stdout.write(`${JSON.stringify(relatedRepos(config))}\n`);
  return 0;
}

if (isMain(import.meta.url)) runCli(main);
