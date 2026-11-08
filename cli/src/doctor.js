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

/** @returns {{ level: 'ok'|'warn'|'fail', name: string, detail: string }[]} */
export function checks({ version, home, env = process.env, cwd = process.cwd() }) {
  const out = [];
  const add = (level, name, detail) => out.push({ level, name, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= MIN_NODE ? 'ok' : 'fail', 'node', major >= MIN_NODE ? process.versions.node : `${process.versions.node}; the factory needs Node.js ${MIN_NODE} or newer`);

  const git = spawnSync('git', ['--version'], { env, encoding: 'utf8' });
  add(git.status === 0 ? 'ok' : 'fail', 'git', git.status === 0 ? git.stdout.trim() : 'not found; install git');

  const gh = env.FACTORY_GH || 'gh';
  const auth = spawnSync(gh, ['auth', 'status'], { env, encoding: 'utf8' });
  if (auth.error) add('fail', 'gh', 'not found; install the GitHub CLI (https://cli.github.com)');
  else add(auth.status === 0 ? 'ok' : 'fail', 'gh', auth.status === 0 ? 'signed in' : 'not signed in; run: gh auth login');

  const found = onPath('eminzo', env);
  add(found ? 'ok' : 'fail', 'eminzo on PATH', found ?? 'not found; Claude Code and Codex call `eminzo`, so its folder must be on the PATH they start with');

  const manifest = readInstallManifest(home);
  if (!manifest) add('fail', 'adapters', 'not installed; run: eminzo install');
  else if (manifest.version === PARTIAL) add('fail', 'adapters', 'the last install skipped files; run: eminzo install --force');
  else if (manifest.version !== version) add('fail', 'adapters', `installed by eminzo ${manifest.version}, this is ${version}; run: eminzo install`);
  else {
    const missing = manifest.files.filter((f) => !existsSync(join(home, f.path))).map((f) => tilde(f.path));
    const changed = manifest.files.filter((f) => existsSync(join(home, f.path)) && sha256(readFileSync(join(home, f.path), 'utf8')) !== f.sha256).map((f) => tilde(f.path));
    if (missing.length) add('fail', 'adapters', `missing ${missing.join(', ')}; run: eminzo install`);
    else if (changed.length) add('warn', 'adapters', `changed since install: ${changed.join(', ')}`);
    else add('ok', 'adapters', `${manifest.files.length} files from eminzo ${version}`);
  }

  const root = repoRoot(cwd, env);
  if (!root) return out;
  const configFile = join(root, 'factory', 'config.json');
  if (!existsSync(configFile)) {
    add('warn', 'repository', `${root} has no factory/config.json; run /eminzo-factory enable to add the factory`);
    return out;
  }
  if (hasCommittedEngine(root)) {
    add('ok', 'engine range', 'this repository commits its own engine; eminzo runs that one');
  } else {
    try {
      const warning = checkEngineRange(JSON.parse(readFileSync(configFile, 'utf8')), version);
      add(warning ? 'warn' : 'ok', 'engine range', warning ? warning.replace(/^warning: /, '') : `eminzo ${version} satisfies factory/config.json`);
    } catch (err) {
      add('fail', 'engine range', err.message);
    }
  }
  let project = '';
  try { project = readFileSync(join(root, 'factory', 'project.md'), 'utf8'); } catch { /* missing */ }
  add(project.includes(SETUP_COMPLETE_MARKER) ? 'ok' : 'warn', 'setup', project.includes(SETUP_COMPLETE_MARKER) ? 'factory/project.md is complete' : 'not finished; run /eminzo-factory setup');
  return out;
}

/** @returns {number} exit status */
export function doctor({ version, home, env, cwd, out = process.stdout }) {
  const results = checks({ version, home, env, cwd });
  for (const { level, name, detail } of results) out.write(`${level === 'ok' ? 'ok  ' : level === 'warn' ? 'warn' : 'FAIL'}  ${name}: ${detail}\n`);
  return results.some((r) => r.level === 'fail') ? 1 : 0;
}
