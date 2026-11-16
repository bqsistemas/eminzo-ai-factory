// `eminzo install` and `eminzo uninstall`: the Claude and Codex skills and agents at user level, and the
// "eminzo" MCP server entry in both tools.
// dist/adapters/<x>/... goes to ~/.<x>/... (claude -> ~/.claude, agents -> ~/.agents, codex -> ~/.codex).
// ~/.eminzo/install.json records each file written and its hash, so a later run updates only files
// eminzo wrote and the user has not changed, and uninstall removes only those. It also records which MCP
// entries eminzo registered (mcp-register.js), so uninstall removes those and never one the person added.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { planMcp, registerMcp, unregisterMcp } from './mcp-register.js';
import { PARTIAL, installManifestPath, readInstallManifest, tilde } from './paths.js';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Folders install creates that uninstall may remove when they end up empty. */
const OWN_DIRS = ['.claude/skills/eminzo-factory', '.agents/skills/eminzo-factory', '.claude/skills/eminzo-product', '.agents/skills/eminzo-product', '.eminzo'];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** [home-relative path, content] for every generated adapter. */
export function adapterFiles(dist) {
  const root = join(dist, 'adapters');
  return walk(root).map((abs) => {
    const rel = relative(root, abs).split(sep).join('/');
    return [`.${rel}`, readFileSync(abs, 'utf8')];
  }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const readOrNull = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** What install would do with each file, without touching the disk. */
export function planInstall({ dist, home, force = false }) {
  const recorded = new Map((readInstallManifest(home)?.files ?? []).map((f) => [f.path, f.sha256]));
  const files = adapterFiles(dist);
  const plan = files.map(([path, content]) => {
    const current = readOrNull(join(home, path));
    if (current === null) return { path, content, action: 'create' };
    if (current === content) return { path, content, action: 'same' };
    const ours = recorded.get(path) === sha256(current);
    if (ours) return { path, content, action: 'update' };
    if (force) return { path, content, action: 'overwrite' };
    return { path, content, action: 'skip', reason: recorded.has(path) ? 'changed since eminzo installed it' : 'not written by eminzo' };
  });
  const wanted = new Set(files.map(([path]) => path));
  for (const [path, hash] of recorded) {
    if (wanted.has(path)) continue;
    const current = readOrNull(join(home, path));
    if (current === null) continue;
    plan.push(sha256(current) === hash ? { path, action: 'remove' } : { path, action: 'keep', reason: 'changed since eminzo installed it' });
  }
  return plan;
}

/** What install puts on this machine, shown before it does anything. */
export function installHeader({ version, dryRun = false, mcp = true }) {
  return [
    `eminzo ${version} ${dryRun ? 'would install' : 'installs'} in your home folder:`,
    '  - the eminzo-factory and eminzo-product skills and the factory agents for Claude Code (~/.claude/skills, ~/.claude/agents)',
    '  - the eminzo-factory and eminzo-product skills and the factory agents for Codex (~/.agents/skills, ~/.codex/agents)',
    mcp
      ? '  - the "eminzo" MCP server (read-only factory tools) in Claude Code and Codex'
      : '  - not the "eminzo" MCP server (--no-mcp)',
    'Only eminzo\'s own files and its "eminzo" MCP entry are added or updated; nothing else is changed.',
    '',
  ].join('\n');
}

/** @returns {number} exit status: 1 when a file was skipped */
export function install({ dist, version, home, dryRun = false, force = false, mcp = true, env = process.env, out = process.stdout }) {
  out.write(installHeader({ version, dryRun, mcp }));
  const plan = planInstall({ dist, home, force });
  for (const step of plan) {
    if (step.action === 'same') continue;
    out.write(`${step.action} ${tilde(step.path)}${step.reason ? ` (${step.reason})` : ''}\n`);
  }
  const skipped = plan.filter((s) => s.action === 'skip');
  const changed = plan.filter((s) => ['create', 'update', 'overwrite', 'remove'].includes(s.action));
  const previous = readInstallManifest(home)?.mcp ?? {};
  const mcpPlan = mcp ? planMcp({ home, env }) : [];
  if (dryRun) {
    registerMcp(mcpPlan, { env, dryRun: true, previous, out });
    out.write(`dry run: ${changed.length} file(s) would change; nothing was written\n`);
    return 0;
  }
  for (const step of plan) {
    const file = join(home, step.path);
    if (['create', 'update', 'overwrite'].includes(step.action)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, step.content);
    } else if (step.action === 'remove') {
      rmSync(file, { force: true });
    }
  }
  // Files written now are recorded with their new hash; files skipped or kept keep their earlier
  // record (so a later run still knows they were eminzo's). A run that skipped a file is partial:
  // the stale file may call commands this engine no longer has, so engine commands refuse until a full install.
  const recorded = new Map((readInstallManifest(home)?.files ?? []).map((f) => [f.path, f.sha256]));
  const written = plan.filter((s) => ['create', 'update', 'overwrite', 'same'].includes(s.action));
  const held = plan.filter((s) => ['skip', 'keep'].includes(s.action) && recorded.has(s.path));
  const owned = mcp ? registerMcp(mcpPlan, { env, previous, out }) : previous;
  const manifest = {
    version: skipped.length ? PARTIAL : version,
    files: [...written.map((s) => ({ path: s.path, sha256: sha256(s.content) })), ...held.map((s) => ({ path: s.path, sha256: recorded.get(s.path) }))],
    mcp: { claude: owned.claude === true, codex: owned.codex === true },
  };
  mkdirSync(dirname(installManifestPath(home)), { recursive: true });
  writeFileSync(installManifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!changed.length && !skipped.length) out.write(`eminzo ${version}: skill and agents are up to date\n`);
  else out.write(`eminzo ${version}: ${written.length} file(s) installed${skipped.length ? `, ${skipped.length} skipped (run eminzo install --force to overwrite them)` : ''}\n`);
  return skipped.length ? 1 : 0;
}

/** @returns {number} exit status */
export function uninstall({ home, dryRun = false, env = process.env, out = process.stdout }) {
  const manifest = readInstallManifest(home);
  if (!manifest) {
    out.write('nothing to remove: eminzo has not installed anything here\n');
    return 0;
  }
  unregisterMcp({ home, env, owned: manifest.mcp ?? {}, dryRun, out });
  for (const { path, sha256: hash } of manifest.files) {
    const current = readOrNull(join(home, path));
    if (current === null) continue;
    if (sha256(current) !== hash) {
      out.write(`keep ${tilde(path)} (changed since eminzo installed it)\n`);
      continue;
    }
    out.write(`remove ${tilde(path)}\n`);
    if (!dryRun) rmSync(join(home, path), { force: true });
  }
  if (dryRun) {
    out.write('dry run: nothing was removed\n');
    return 0;
  }
  rmSync(installManifestPath(home), { force: true });
  for (const dir of OWN_DIRS) {
    try {
      if (existsSync(join(home, dir))) rmdirSync(join(home, dir));
    } catch { /* not empty: something else lives there */ }
  }
  out.write('eminzo: skill and agents removed\n');
  return 0;
}
