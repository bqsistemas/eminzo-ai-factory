#!/usr/bin/env node
// Keeps the newest published desktop release marked "Latest".
//
// electron-updater reads /releases/latest. When a CLI release (tag vX.Y.Z) takes that slot, installed
// desktop apps stop seeing updates. Run by .github/workflows/keep-desktop-latest.yml with GH_TOKEN.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DESKTOP_TAG = /^desktop-v(\d+)\.(\d+)\.(\d+)$/;

function versionOf(tag) {
  const m = DESKTOP_TAG.exec(tag ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a, b) {
  const va = versionOf(a.tag_name);
  const vb = versionOf(b.tag_name);
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i];
  return Date.parse(b.published_at) - Date.parse(a.published_at);
}

// Highest desktop-vX.Y.Z wins, so a hotfix on an older line never takes Latest;
// published_at only breaks ties between equal versions.
export function pickDesktopLatest(releases) {
  if (!Array.isArray(releases)) return null;
  const candidates = releases.filter((r) => r && !r.draft && !r.prerelease && r.published_at && versionOf(r.tag_name));
  candidates.sort(compare);
  return candidates[0] ?? null;
}

function ghRun(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function isNotFound(e) {
  return /HTTP 404|Not Found/i.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`);
}

export function main(env, gh = ghRun, log = console.log) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
  // --paginate with --slurp yields an array of pages.
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]));
  const desktop = pickDesktopLatest(pages.flat());
  if (!desktop) {
    log('No published desktop release yet: nothing to do.');
    return 0;
  }
  let current = null;
  try {
    current = JSON.parse(gh(['api', `repos/${repo}/releases/latest`]));
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  if (current && current.id === desktop.id) {
    log(`${desktop.tag_name} is already Latest.`);
    return 0;
  }
  log(`Latest is ${current ? current.tag_name : 'unset'}; restoring ${desktop.tag_name}.`);
  gh(['api', '--method', 'PATCH', `repos/${repo}/releases/${desktop.id}`, '-f', 'make_latest=true']);
  log(`${desktop.tag_name} is Latest again.`);
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
