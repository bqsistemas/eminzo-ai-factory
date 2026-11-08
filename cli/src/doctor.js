// `eminzo doctor`: checks what the factory needs on this machine and, inside a repository, that
// the repository can run this engine. Prints one line per check; exits 1 when any check fails.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { checkEngineRange } from './engine.js';
import { PARTIAL, hasCommittedEngine, readInstallManifest, repoRoot, tilde } from './paths.js';

const MIN_NODE = 20;
const SETUP_COMPLETE_MARKER = '<!-- eminzo:setup-complete -->';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function onPath(name, env) {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch { /* not here */ }
  }
  return null;
}

/**
 * Every check, with a stable `id` for tools that read `eminzo doctor --json` (node, git, gh, path, adapters,
 * repository, engine, setup), and the state of the repository of `cwd` (null outside a repository).
 * @returns {{ results: { id: string, level: 'ok'|'warn'|'fail', name: string, detail: string }[],
 *   repository: { root: string, enabled: boolean, committedEngine: boolean, engine: string | null, engineOk: boolean | null, setup: boolean } | null }}
 */
export function checks({ version, home, env = process.env, cwd = process.cwd() }) {
  const out = [];
  const add = (id, level, name, detail) => out.push({ id, level, name, detail });
  const done = (repository = null) => ({ results: out, repository });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= MIN_NODE ? 'ok' : 'fail', 'node', major >= MIN_NODE ? process.versions.node : `${process.versions.node}; the factory needs Node.js ${MIN_NODE} or newer`);

  const git = spawnSync('git', ['--version'], { env, encoding: 'utf8' });
  add('git', git.status === 0 ? 'ok' : 'fail', 'git', git.status === 0 ? git.stdout.trim() : 'not found; install git');

  const gh = env.FACTORY_GH || 'gh';
  const auth = spawnSync(gh, ['auth', 'status'], { env, encoding: 'utf8' });
  if (auth.error) add('gh', 'fail', 'gh', 'not found; install the GitHub CLI (https://cli.github.com)');
  else add('gh', auth.status === 0 ? 'ok' : 'fail', 'gh', auth.status === 0 ? 'signed in' : 'not signed in; run: gh auth login');

  const found = onPath('eminzo', env);
  add('path', found ? 'ok' : 'fail', 'eminzo on PATH', found ?? 'not found; Claude Code and Codex call `eminzo`, so its folder must be on the PATH they start with');

  const manifest = readInstallManifest(home);
  if (!manifest) add('adapters', 'fail', 'adapters', 'not installed; run: eminzo install');
  else if (manifest.version === PARTIAL) add('adapters', 'fail', 'adapters', 'the last install skipped files; run: eminzo install --force');
  else if (manifest.version !== version) add('adapters', 'fail', 'adapters', `installed by eminzo ${manifest.version}, this is ${version}; run: eminzo install`);
  else {
    const missing = manifest.files.filter((f) => !existsSync(join(home, f.path))).map((f) => tilde(f.path));
    const changed = manifest.files.filter((f) => existsSync(join(home, f.path)) && sha256(readFileSync(join(home, f.path), 'utf8')) !== f.sha256).map((f) => tilde(f.path));
    if (missing.length) add('adapters', 'fail', 'adapters', `missing ${missing.join(', ')}; run: eminzo install`);
    else if (changed.length) add('adapters', 'warn', 'adapters', `changed since install: ${changed.join(', ')}`);
    else add('adapters', 'ok', 'adapters', `${manifest.files.length} files from eminzo ${version}`);
  }

  const root = repoRoot(cwd, env);
  if (!root) return done();
  const configFile = join(root, 'factory', 'config.json');
  const repository = { root, enabled: false, committedEngine: hasCommittedEngine(root), engine: null, engineOk: null, setup: false };
  if (!existsSync(configFile)) {
    add('repository', 'warn', 'repository', `${root} has no factory/config.json; run /eminzo-factory enable to add the factory`);
    return done(repository);
  }
  repository.enabled = true;
  if (repository.committedEngine) {
    add('engine', 'ok', 'engine range', 'this repository commits its own engine; eminzo runs that one');
    repository.engineOk = true;
  } else {
    try {
      const config = JSON.parse(readFileSync(configFile, 'utf8'));
      repository.engine = typeof config?.engine === 'string' ? config.engine : null;
      const warning = checkEngineRange(config, version);
      repository.engineOk = true;
      add('engine', warning ? 'warn' : 'ok', 'engine range', warning ? warning.replace(/^warning: /, '') : `eminzo ${version} satisfies factory/config.json`);
    } catch (err) {
      repository.engineOk = false;
      add('engine', 'fail', 'engine range', err.message);
    }
  }
  let project = '';
  try { project = readFileSync(join(root, 'factory', 'project.md'), 'utf8'); } catch { /* missing */ }
  repository.setup = project.includes(SETUP_COMPLETE_MARKER);
  add('setup', repository.setup ? 'ok' : 'warn', 'setup', repository.setup ? 'factory/project.md is complete' : 'not finished; run /eminzo-factory setup');
  return done(repository);
}

/** @returns {number} exit status: 1 when any check fails */
export function doctor({ version, home, env, cwd, json = false, out = process.stdout }) {
  const { results, repository } = checks({ version, home, env, cwd });
  const failed = results.some((r) => r.level === 'fail');
  if (json) {
    out.write(`${JSON.stringify({ version, ok: !failed, checks: results, repository })}\n`);
  } else {
    for (const { level, name, detail } of results) out.write(`${level === 'ok' ? 'ok  ' : level === 'warn' ? 'warn' : 'FAIL'}  ${name}: ${detail}\n`);
  }
  return failed ? 1 : 0;
}
