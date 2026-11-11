#!/usr/bin/env node
// Creates the GitHub Release for the CLI version in cli/package.json.
//
// The release is ALWAYS created with --latest=false: the desktop app updates through
// /releases/latest, so a CLI release must never become "Latest".
// This script never runs `npm publish`; see docs/releasing.md.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const SEMVER = /^\d+\.\d+\.\d+$/;

export function planCliRelease({ version, branch, clean, localTags = [], remoteTags = [], headSha, tagSha, notesFile } = {}) {
  const errors = [];
  if (typeof version === 'string' && version.startsWith('desktop-')) {
    errors.push(`"${version}" is a desktop version: desktop- tags are released by the desktop repo, never with release:cli.`);
  } else if (typeof version !== 'string' || !SEMVER.test(version)) {
    errors.push(`cli/package.json version must be X.Y.Z, got ${JSON.stringify(version)}.`);
  }
  if (errors.length) return { ok: false, errors, command: null };

  const tag = `v${version}`;
  if (branch !== 'main') errors.push(`Releases are cut from main; the current branch is ${JSON.stringify(branch)}.`);
  if (!clean) errors.push('The working tree is not clean: commit or stash uncommitted changes first.');
  if (!localTags.includes(tag)) {
    errors.push(`Tag ${tag} does not exist locally. Create it on the release commit: git tag -a ${tag} -m "eminzo ${version}"`);
  }
  if (!remoteTags.includes(tag)) {
    errors.push(`Tag ${tag} is not on origin. Push it: git push origin ${tag}`);
  }
  if (localTags.includes(tag) && tagSha !== headSha) {
    errors.push(`Tag ${tag} does not point at HEAD (${String(tagSha).slice(0, 7)} vs ${String(headSha).slice(0, 7)}). Release from the tagged commit.`);
  }
  if (errors.length) return { ok: false, errors, command: null };

  const command = ['gh', 'release', 'create', tag, '--latest=false', '--title', `CLI ${tag}`, '--verify-tag'];
  if (notesFile) command.push('--notes-file', notesFile);
  else command.push('--generate-notes');
  return { ok: true, errors: [], command };
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function gather(root, notesFile) {
  const version = JSON.parse(readFileSync(resolve(root, 'cli/package.json'), 'utf8')).version;
  const tag = `v${version}`;
  const localTags = git(['tag', '--list', 'v*'], root).split('\n').filter(Boolean);
  const remoteTags = git(['ls-remote', '--tags', '--refs', 'origin', 'v*'], root)
    .split('\n').filter(Boolean).map((l) => l.split('\trefs/tags/')[1]);
  let tagSha = null;
  if (localTags.includes(tag)) tagSha = git(['rev-list', '-n', '1', tag], root);
  return {
    version,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], root),
    clean: git(['status', '--porcelain', '--untracked-files=no'], root) === '',
    localTags,
    remoteTags,
    headSha: git(['rev-parse', 'HEAD'], root),
    tagSha,
    notesFile,
  };
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const i = argv.indexOf('--notes-file');
  const notesFile = i >= 0 ? argv[i + 1] : undefined;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const plan = planCliRelease(gather(root, notesFile));
  if (!plan.ok) {
    for (const e of plan.errors) console.error(`error: ${e}`);
    return 1;
  }
  const [cmd, ...args] = plan.command;
  const shown = plan.command.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
  if (dryRun) {
    console.log(shown);
    return 0;
  }
  console.log(shown);
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
  console.log('GitHub Release created. npm publish is a separate, manual step (docs/releasing.md).');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
}
