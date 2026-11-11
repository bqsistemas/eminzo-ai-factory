#!/usr/bin/env node
// Keeps the newest published desktop release marked "Latest".
//
// electron-updater reads /releases/latest. When a CLI release (tag vX.Y.Z) takes that slot, installed
// desktop apps stop seeing updates. Run by .github/workflows/keep-desktop-latest.yml with GH_TOKEN.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function pickDesktopLatest(releases) {
  if (!Array.isArray(releases)) return null;
  const candidates = releases.filter(
    (r) => r && !r.draft && !r.prerelease && typeof r.tag_name === 'string' && r.tag_name.startsWith('desktop-v') && r.published_at,
  );
  candidates.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  return candidates[0] ?? null;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main(env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
  // --paginate with --slurp yields an array of pages.
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]));
  const desktop = pickDesktopLatest(pages.flat());
  if (!desktop) {
    console.log('No published desktop release yet: nothing to do.');
    return 0;
  }
  const current = JSON.parse(gh(['api', `repos/${repo}/releases/latest`]));
  if (current.id === desktop.id) {
    console.log(`${desktop.tag_name} is already Latest.`);
    return 0;
  }
  console.log(`Latest is ${current.tag_name}; restoring ${desktop.tag_name}.`);
  gh(['api', '--method', 'PATCH', `repos/${repo}/releases/${desktop.id}`, '-f', 'make_latest=true']);
  console.log(`${desktop.tag_name} is Latest again.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.env);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
}
