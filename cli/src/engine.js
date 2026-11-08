// `eminzo <engine command>`: runs one engine script on the repository of the current directory.
// The packaged engine runs with EMINZO_ENGINE set (it then finds its own files there and names
// commands `eminzo <name>`); the repo's data still comes from the repo. A repository that commits
// its own engine keeps running that one, exactly as `factory/bin/<command>` would.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';

import { CliError, PARTIAL, engineFolder, hasCommittedEngine, homeDir, readInstallManifest, repoRoot } from './paths.js';
import { parseRange, satisfies } from './semver.js';

/** Engine commands run by node from lib/<name>.js. */
const NODE_COMMANDS = ['job', 'gate', 'approve', 'route', 'visual', 'nudge', 'ensure-output', 'protect-tests', 'dashboard', 'init'];
/** Engine commands that are shell scripts in bin/. */
const SHELL_COMMANDS = ['setup', 'setup-spec-review'];
/** Commands that are a `job` subcommand: `eminzo selfcheck <id>` runs `eminzo job <id> selfcheck`. */
export const JOB_ALIASES = Object.freeze({ selfcheck: (args) => [args[0], 'selfcheck', ...args.slice(1)] });
export const ENGINE_COMMANDS = [...NODE_COMMANDS, ...SHELL_COMMANDS, ...Object.keys(JOB_ALIASES)];

/** Signals passed on to the engine, so a hook timeout or kill that reaches eminzo also stops the engine. */
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Runs the child with the terminal's stdin/stdout/stderr (hooks read their JSON from stdin) and
 * resolves its exit status, 128+signal when it was killed. SIGKILL cannot be forwarded.
 */
function runChild(cmd, args, opts) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: 'inherit' });
    const forward = (signal) => { child.kill(signal); };
    for (const s of FORWARDED) process.on(s, forward);
    const done = () => { for (const s of FORWARDED) process.off(s, forward); };
    child.on('error', (err) => { done(); reject(new CliError(`could not start the engine: ${err.message}`)); });
    child.on('exit', (code, signal) => { done(); resolvePromise(code ?? 128 + (constants.signals[signal] ?? 0)); });
  });
}

/** Checks the repository's `engine` range against this CLI. Returns a warning to print, or null. */
export function checkEngineRange(config, version) {
  if (!Object.hasOwn(config, 'engine')) return `warning: factory/config.json has no "engine" range; running eminzo ${version}`;
  const range = config.engine;
  if (!parseRange(range)) {
    throw new CliError(`factory/config.json: engine: ${JSON.stringify(range)} is not a supported range (use 1.2.3, 1.2.x, 1.x, ^1.2.3, ~1.2.3 or >=1.2.3 <2.0.0)`);
  }
  if (!satisfies(version, range)) {
    throw new CliError(`engine ${version} does not satisfy ${JSON.stringify(range)} in factory/config.json; install a matching version (npm i -g @eminzo/factory@${range}) or change the range`);
  }
  return null;
}

/** @returns {Promise<number>} the engine's exit status */
export async function runEngine(command, args, { dist, version, env = process.env, cwd = process.cwd() }) {
  if (Object.hasOwn(JOB_ALIASES, command)) {
    if (!args.length) throw new CliError(`usage: eminzo ${command} <job-id>`, 2);
    return runEngine('job', JOB_ALIASES[command](args), { dist, version, env, cwd });
  }
  const root = repoRoot(cwd, env);
  if (!root) throw new CliError('not inside a git repository');
  const configFile = join(root, 'factory', 'config.json');
  if (!existsSync(configFile)) throw new CliError('no factory in this repo; run /eminzo-factory enable (Codex: $eminzo-factory enable)');

  if (hasCommittedEngine(root)) {
    const own = join(root, 'factory', 'bin', command);
    if (!existsSync(own)) throw new CliError(`this repository commits its own engine, which has no factory/bin/${command}`);
    const childEnv = { ...env };
    delete childEnv.EMINZO_ENGINE;
    return runChild('sh', [own, ...args], { cwd, env: childEnv });
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch (err) {
    throw new CliError(`factory/config.json is not valid JSON (${err.message})`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new CliError('factory/config.json must be a JSON object');
  const warning = checkEngineRange(config, version);
  if (warning) process.stderr.write(`${warning}\n`);

  const installed = readInstallManifest(homeDir(env));
  if (installed && installed.version === PARTIAL) {
    throw new CliError('the last eminzo install skipped files (changed by you or not written by eminzo); run: eminzo install --force, or remove those files and run eminzo install');
  }
  if (installed && installed.version !== version) {
    throw new CliError(`the installed skill and agents are from eminzo ${installed.version}, the engine is ${version}; run: eminzo install`);
  }

  const engine = engineFolder(dist);
  const childEnv = { ...env, EMINZO_ENGINE: engine, EMINZO_VERSION: version };
  return SHELL_COMMANDS.includes(command)
    ? runChild('sh', [join(engine, 'bin', command), ...args], { cwd, env: childEnv })
    : runChild(process.execPath, [join(engine, 'lib', `${command}.js`), ...args], { cwd, env: childEnv });
}
