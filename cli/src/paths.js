// Where the CLI finds its own files, the repository and the user's home. Node built-ins only.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The installed package folder (cli/ in the source repo). */
export const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** This CLI's version, from its package.json. */
export const VERSION = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8')).version;

/** The commands the CLI reads and writes help for. */
export const CLI_NAME = 'eminzo';

/** An error the CLI reports as `error: <message>` and exits with `code`. */
export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/** The generated part of the package (EMINZO_DIST overrides it for tests). Refuses a missing or stale build. */
export function distDir(env = process.env) {
  const dist = env.EMINZO_DIST ? resolve(env.EMINZO_DIST) : join(CLI_ROOT, 'dist');
  const buildFile = join(dist, 'build.json');
  if (!existsSync(buildFile)) throw new CliError(`eminzo is not built (${buildFile} is missing); run: node ${join(CLI_ROOT, 'build.mjs')}`);
  const built = JSON.parse(readFileSync(buildFile, 'utf8')).version;
  if (built !== VERSION) throw new CliError(`the built engine is ${built} but the package is ${VERSION}; run: node ${join(CLI_ROOT, 'build.mjs')}`);
  return dist;
}

/** The engine folder inside the build (what EMINZO_ENGINE points to). */
export const engineFolder = (dist) => join(dist, 'factory');

/** The user's home folder (HOME wins, so tests can use a throwaway one). */
export const homeDir = (env = process.env) => env.HOME || homedir();

/** The install record's version when its last run skipped files: engine commands refuse until a full install. */
export const PARTIAL = 'partial';

/** Where install records the files it wrote. */
export const installManifestPath = (home) => join(home, '.eminzo', 'install.json');

/** The recorded install, or null when nothing was installed (or the record is unreadable). */
export function readInstallManifest(home) {
  try {
    const data = JSON.parse(readFileSync(installManifestPath(home), 'utf8'));
    return data && typeof data.version === 'string' && Array.isArray(data.files) ? data : null;
  } catch {
    return null;
  }
}

/**
 * The repository's main checkout for `cwd` (the folder holding git's common directory, so a
 * worktree resolves to its main checkout), or null outside a repository. FACTORY_ROOT wins, as in the engine.
 */
export function repoRoot(cwd = process.cwd(), env = process.env) {
  if (env.FACTORY_ROOT) return resolve(env.FACTORY_ROOT);
  const res = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, env, encoding: 'utf8' });
  return res.status === 0 ? dirname(res.stdout.trim()) : null;
}

/** True when the repository commits its own engine (this repo, a desktop kit install). */
export const hasCommittedEngine = (root) => existsSync(join(root, 'factory', 'lib', 'job.js'));

/** `~/<rel>` for messages. */
export const tilde = (rel) => `~/${rel}`;
