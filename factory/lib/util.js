// Shared helpers for the factory scripts: paths, config, files and child processes.
// Node 20 ESM, no dependencies.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A job id: a 3-digit (or longer) number, then a lowercase slug. Never a path. */
export const JOB_ID = /^\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A transition or request the rules do not allow. The CLI exits 1. */
export class Refused extends Error {}
/** Bad arguments. The CLI exits 2. */
export class Usage extends Error {}

/** Runs a command without a shell. Never throws; check `.status` and `.error`. */
export function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

/** Runs a command and returns stdout, or throws with its stderr. */
export function mustRun(cmd, args, opts = {}) {
  const res = run(cmd, args, opts);
  if (res.error || res.status !== 0) {
    const why = (res.stderr || res.error?.message || `exit ${res.status}`).trim().split('\n').slice(-3).join(' ');
    throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${why}`);
  }
  return res.stdout;
}

/**
 * The main checkout. FACTORY_ROOT wins; otherwise the folder holding git's common
 * directory, which is the main checkout's top level even when run from a worktree.
 */
export function factoryRoot() {
  if (process.env.FACTORY_ROOT) return resolve(process.env.FACTORY_ROOT);
  const res = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (res.status !== 0) throw new Error('not inside a git repository (set FACTORY_ROOT)');
  return dirname(res.stdout.trim());
}

/**
 * The engine folder (the one holding lib/, bin/, roles/, templates/ and the dashboard) when the
 * engine runs as the installed `eminzo` CLI, whose entry point sets EMINZO_ENGINE; null when the
 * engine is committed in the repo (this repo, a kit install), which keeps every path as before.
 */
export function installedEngine() {
  const dir = process.env.EMINZO_ENGINE;
  return dir ? resolve(dir) : null;
}

/** Where the engine's own files live: the installed engine, or <root>/factory. Repo data never comes from here. */
export function engineDir(root) {
  return installedEngine() ?? join(root, 'factory');
}

/** How a message names an engine command: `eminzo <name>` from the installed CLI, `factory/bin/<name>` otherwise. */
export function engineCommand(name) {
  return installedEngine() ? `eminzo ${name}` : `factory/bin/${name}`;
}

/** The effective config: factory/config.json plus the developer's factory/config.local.json (see effectiveConfig). */
export function loadConfig(root, opts) {
  return effectiveConfig(root, opts).config;
}

/** A per-developer, gitignored override of a few config.json keys, read from the main checkout. */
export const LOCAL_CONFIG = 'factory/config.local.json';
/** The only keys config.local.json may set. Every other key (routing, models, protected tests, ...) is team policy. */
export const OVERRIDABLE = Object.freeze(['concurrency', 'default_provider', 'language', 'max_rounds', 'auto_merge', 'spec_review']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 1;

/** Why a local value is not allowed, or null when it is. Reads the team config only through own keys. */
function localProblem(team, key, value) {
  switch (key) {
    case 'concurrency':
      return isCount(value) ? null : 'must be an integer >= 1';
    case 'language':
      return typeof value === 'string' && LANGUAGES.includes(value) ? null : `must be one of ${LANGUAGES.join(', ')}`;
    case 'max_rounds': {
      const limit = Object.hasOwn(team, 'max_rounds') ? team.max_rounds : 3;
      return isCount(value) && value <= limit ? null : `must be an integer from 1 to the team max_rounds (${JSON.stringify(limit)})`;
    }
    case 'auto_merge':
      return value === false ? null : 'can only be false (a local file may turn auto-merge off, never on)';
    case 'default_provider': {
      const providers = Object.hasOwn(team, 'providers') && isPlainObject(team.providers) ? team.providers : {};
      return typeof value === 'string' && Object.hasOwn(providers, value) ? null : 'must be a provider declared in the team providers';
    }
    case 'spec_review':
      // No limit from the team value: a developer turns the review on or off for themselves.
      return specReviewProblem(value);
    default:
      return `not an overridable key (allowed: ${OVERRIDABLE.join(', ')})`;
  }
}

/**
 * Validates a parsed config.local.json against the team config, all or nothing: returns
 * nothing when every key is allowed and every value is within its rule, or throws Refused
 * for the first bad key in file order. Never mutates either object.
 */
export function validateLocal(team, local) {
  if (!isPlainObject(local)) throw new Refused('config.local.json: must be a JSON object');
  for (const key of Object.keys(local)) {
    const problem = localProblem(isPlainObject(team) ? team : {}, OVERRIDABLE.includes(key) ? key : null, local[key]);
    if (problem) throw new Refused(`config.local.json: ${key}: ${problem}`);
  }
}

/** True when git tracks config.local.json in the root (index included). Git failing means not tracked. */
function localTracked(root) {
  const res = run('git', ['ls-files', '--error-unmatch', '--', LOCAL_CONFIG], { cwd: root });
  return !res.error && res.status === 0;
}

/**
 * factory/config.json merged with factory/config.local.json. Without the local file the team
 * config is returned as is (git is not asked). A local file tracked by git is ignored with a
 * warning: a shared file is not a local override. Otherwise it is parsed and validated whole
 * before anything is merged; any failure is a Refused. `overrides` lists the applied keys, sorted.
 * @param {{ tracked?: (root: string) => boolean, warn?: (text: string) => void }} [opts]
 * @returns {{ config: object, team: object, local: object | null, overrides: string[] }}
 */
export function effectiveConfig(root, { tracked = localTracked, warn = (text) => process.stderr.write(`${text}\n`) } = {}) {
  const team = JSON.parse(readFileSync(join(root, 'factory/config.json'), 'utf8'));
  const file = join(root, LOCAL_CONFIG);
  if (!existsSync(file)) return { config: team, team, local: null, overrides: [] };
  if (tracked(root)) {
    warn(`warning: ${LOCAL_CONFIG} is tracked by git, so it is ignored; untrack it with git rm --cached ${LOCAL_CONFIG}`);
    return { config: team, team, local: null, overrides: [] };
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Refused(`config.local.json: cannot be read (${err.code ?? err.message})`);
  }
  let local;
  try {
    local = JSON.parse(text);
  } catch (err) {
    throw new Refused(`config.local.json: not valid JSON (${err.message})`);
  }
  validateLocal(team, local);
  const overrides = Object.keys(local).sort();
  const config = { ...team };
  for (const key of overrides) config[key] = local[key];
  return { config, team, local, overrides };
}

/**
 * The base ref of the factory: `base` in config.json, shaped `<remote>/<branch>`.
 * There is no default: a repo must say where its jobs start from.
 * @returns {{base: string, remote: string, branch: string}}
 */
export function baseRef(config) {
  const base = config?.base;
  const match = typeof base === 'string' ? /^([^/\s]+)\/(\S+)$/.exec(base) : null;
  if (!match) {
    throw new Error(`factory/config.json: base must be "<remote>/<branch>", got ${JSON.stringify(base) ?? String(base)}`);
  }
  return { base, remote: match[1], branch: match[2] };
}

/** Languages the factory writes in. Missing config means English. */
export const LANGUAGES = Object.freeze(['en', 'es', 'pt']);

/** The configured language: 'en' when absent, a member of LANGUAGES, or an error. */
export function configLanguage(config) {
  const value = config?.language;
  if (value === undefined) return 'en';
  if (typeof value === 'string' && LANGUAGES.includes(value)) return value;
  throw new Error(`factory/config.json: language must be "en", "es" or "pt", got ${JSON.stringify(value) ?? String(value)}`);
}

/** The risk levels a `spec_review` list may name. */
export const SPEC_REVIEW_RISKS = Object.freeze(['low', 'medium', 'high']);

/** Why a `spec_review` value is not allowed, or null: false, true, or a list of SPEC_REVIEW_RISKS (empty means false). */
function specReviewProblem(value) {
  if (value === false || value === true) return null;
  if (Array.isArray(value) && value.every((risk) => SPEC_REVIEW_RISKS.includes(risk))) return null;
  return `must be false, true or a list of risk levels (${SPEC_REVIEW_RISKS.join(', ')})`;
}

/**
 * Whether a job of this risk stops at spec-review after the spec: the one place that reads the
 * effective `spec_review`. Missing or false: never; true: always; a list: when it names the risk.
 * Any other value is a Refused that names the key.
 */
export function specReviewFor(config, risk) {
  const value = config !== null && typeof config === 'object' && Object.hasOwn(config, 'spec_review') ? config.spec_review : false;
  const problem = specReviewProblem(value);
  if (problem) throw new Refused(`spec_review ${problem}, got ${JSON.stringify(value) ?? String(value)}`);
  if (value === true) return true;
  if (value === false) return false;
  return value.includes(risk);
}

export function jobDir(root, id) {
  if (typeof id !== 'string' || !JOB_ID.test(id)) throw new Usage(`not a job id: ${JSON.stringify(id)}`);
  return join(root, 'factory/jobs', id);
}

/** Claude Code's transcript folder for this checkout. */
export function transcriptsDir(root) {
  return process.env.FACTORY_TRANSCRIPTS || join(homedir(), '.claude/projects', root.replace(/[/.]/g, '-'));
}

/** Codex account home, with an isolated override for tests/operators. */
export function codexSessionsDir() {
  return process.env.FACTORY_CODEX_SESSIONS || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
}

export function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** First line of a file without its line ending, or null when the file is missing. */
export function firstLine(file) {
  const text = readText(file);
  return text === null ? null : text.replace(/^﻿/, '').split(/\r?\n/, 1)[0];
}

/** Writes through a temp file and a rename, so readers never see half a file. */
export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function tail(text, n) {
  return String(text).replace(/\n+$/, '').split('\n').slice(-n).join('\n');
}

export const now = () => new Date().toISOString();

/** True when this module is the script node was started with. */
export function isMain(url) {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

/** Runs a CLI main, mapping Refused/Usage/other errors to exit codes 1/2/1. */
export function runCli(main) {
  try {
    process.exitCode = main(process.argv.slice(2)) ?? 0;
  } catch (err) {
    if (err instanceof Usage) {
      process.stderr.write(`usage: ${err.message}\n`);
      process.exitCode = 2;
    } else if (err instanceof Refused) {
      process.stderr.write(`refused: ${err.message}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
  }
}

/**
 * The engine's version: EMINZO_VERSION (set by the CLI entry point), else the version the CLI build
 * recorded next to the installed engine (EMINZO_ENGINE/../build.json), else cli/package.json of the
 * repo that commits the engine. null when none can be read.
 */
/** The npm name of the engine package (cli/package.json). */
export const ENGINE_PACKAGE = '@eminzo/factory';

export function engineVersion(env = process.env, here = dirname(fileURLToPath(import.meta.url))) {
  const fromEnv = String(env.EMINZO_VERSION ?? '').trim();
  if (fromEnv) return fromEnv;
  const candidates = [
    ...(env.EMINZO_ENGINE ? [{ path: join(resolve(env.EMINZO_ENGINE), '..', 'build.json') }] : []),
    // A user repo may have its own cli/package.json: only the engine package's counts.
    { path: join(here, '..', '..', 'cli', 'package.json'), name: ENGINE_PACKAGE },
  ];
  for (const { path, name } of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      if (name && pkg.name !== name) continue;
      const version = pkg.version;
      if (typeof version === 'string' && version.trim()) return version.trim();
    } catch { /* try the next place */ }
  }
  return null;
}
