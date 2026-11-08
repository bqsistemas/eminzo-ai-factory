// Pure (node:crypto, plus an injectable fs): which files make up the "kit" the installer copies into a repo, and its manifest.
// The kit is the generic engine only. The per-repo files (factory/config.json, checks.sh, project.md) are generated, and the
// runtime state (board.json, jobs/, .worktrees/) is never copied: it is gitignored instead.
import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

/** Whole directories, copied recursively. */
export const KIT_TREES = ['.claude/skills/eminzo-factory', '.agents/skills/eminzo-factory', 'factory/bin', 'factory/lib', 'factory/roles', 'factory/templates'];
/** Top-level files of a directory that match. */
export const KIT_FLAT = [
  { dir: '.claude/agents', match: /\.md$/ },
  { dir: '.codex/agents', match: /^eminzo-.*\.toml$/ },
];
// factory/activity.js and avatars.js are imported by lib/job.js; package.json marks factory/ as ES modules.
export const KIT_SINGLE = ['factory/pipeline.json', 'factory/package.json', 'factory/activity.js', 'factory/avatars.js'];
/** In a kit tree but not part of the kit: the dashboard server needs the dashboard page and assets, which the kit does not carry (Eminzo renders the dashboard itself). */
export const KIT_EXCLUDE = ['factory/bin/dashboard', 'factory/lib/dashboard.js',
  // The agent generator's inputs: only `npm run sync-agents` in this repo reads them; the installer ships the generated agents.
  'factory/templates/agents.json', 'factory/templates/agent-claude.md', 'factory/templates/agent-codex.toml', 'factory/templates/agent-shared.md'];
/**
 * Shipped in the installer bundle (so run.js can read it from kit.dir) but never copied into the target repo:
 * the installer turns it into the target's factory/config.json, and nothing in the target reads the template.
 */
export const KIT_INSTALLER_ONLY = ['factory/templates/config.json'];
/** Lines the installer adds to the target's .gitignore. */
export const KIT_RUNTIME_STATE = ['factory/board.json', 'factory/jobs/', '.worktrees/'];
/** Per-developer files, also gitignored by the installer and by an update: the engine ignores a tracked config.local.json. */
export const KIT_LOCAL_FILES = ['factory/config.local.json'];

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function entriesOf(fs, dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
}

function walk(fs, root, rel) {
  return entriesOf(fs, path.join(root, rel)).flatMap((e) => (e.isDirectory() ? walk(fs, root, `${rel}/${e.name}`) : [`${rel}/${e.name}`]));
}

/** Sorted, forward-slash paths of every kit file under `root` (the repo root, or a built kit directory: same layout). */
export function listKitFiles(root, fs = nodeFs) {
  const out = new Set();
  for (const tree of KIT_TREES) {
    for (const p of walk(fs, root, tree)) if (!KIT_EXCLUDE.includes(p) && !KIT_INSTALLER_ONLY.includes(p)) out.add(p);
  }
  for (const { dir, match } of KIT_FLAT) {
    for (const e of entriesOf(fs, path.join(root, dir))) if (!e.isDirectory() && match.test(e.name)) out.add(`${dir}/${e.name}`);
  }
  for (const file of KIT_SINGLE) {
    try { fs.readFileSync(path.join(root, file)); out.add(file); } catch { /* optional */ }
  }
  return [...out].sort();
}

/** The files the packaged installer carries: the kit plus the installer-only files that exist under `root`. */
export function listBundleFiles(root, fs = nodeFs) {
  const extra = KIT_INSTALLER_ONLY.filter((file) => {
    try { fs.readFileSync(path.join(root, file)); return true; } catch { return false; }
  });
  return [...new Set([...listKitFiles(root, fs), ...extra])].sort();
}

/** @returns {{ kitVersion: string, files: { path: string, sha256: string }[] }} */
export function buildManifest({ version, entries }) {
  const files = entries.map(({ path: p, sha256: h }) => ({ path: p, sha256: h })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = sha256(files.map((f) => `${f.path}\0${f.sha256}`).join('\n')).slice(0, 12);
  return { kitVersion: `${version}+${digest}`, files };
}

/** Reads and hashes the kit that lives in `root`. The version is the root package.json's. */
export function readKit(root, fs = nodeFs) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '0.0.0';
  const entries = listKitFiles(root, fs).map((p) => ({ path: p, sha256: sha256(fs.readFileSync(path.join(root, p))) }));
  return buildManifest({ version, entries });
}

/**
 * Where the installer reads the kit from. Dev: the repo root itself (same file list, no build step needed).
 * Packaged: <resources>/kit, built by scripts/build-kit.mjs, with its manifest.json.
 * @returns {{ dir: string, manifest: { kitVersion: string, files: { path: string, sha256: string }[] } }}
 */
export function loadKit({ isPackaged, resourcesPath, repoRoot, fs = nodeFs }) {
  if (!isPackaged) return { dir: repoRoot, manifest: readKit(repoRoot, fs) };
  if (!resourcesPath) throw new Error('resourcesPath is required when the app is packaged');
  const dir = path.join(resourcesPath, 'kit');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw new Error(`Packaged kit is missing manifest.json in ${dir}`);
  }
  return { dir, manifest };
}
