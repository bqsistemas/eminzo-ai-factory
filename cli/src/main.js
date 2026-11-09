// The `eminzo` command line: engine commands, plus install/uninstall/doctor/enable/show.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliError, VERSION, distDir, engineFolder, homeDir } from './paths.js';

const HELP = `eminzo ${VERSION}: the Eminzo software factory engine

Once per machine:
  eminzo install [--dry-run] [--force]   install the Claude Code and Codex skill and agents in your home folder
  eminzo uninstall [--dry-run]           remove the files eminzo install wrote (changed files are kept)
  eminzo doctor [--json]                 check node, git, gh, the installed adapters and this repository

Once per repository (or /eminzo-factory enable in Claude Code, $eminzo-factory enable in Codex):
  eminzo enable [--dry-run] [--json]     open a pull request that adds factory/config.json, checks.sh and project.md

Day to day, in Claude Code: /eminzo-factory setup | run | issue <n> | rework <n> | xs <request> | <feature>
  | approve-spec <n> | revise-spec <n> <notes>   (Codex: $eminzo-factory ...)

Engine commands (the skill and agents call these; they run on the repository of the current directory):
  eminzo job | gate | approve | route | visual | nudge | ensure-output | protect-tests | dashboard | init | setup | setup-spec-review | profile
  eminzo selfcheck <job-id>              the builder's check before READY (same as: eminzo job <job-id> selfcheck)

Other:
  eminzo show roles/<role>.md | templates/<file>   print a role or template that ships with the engine
  eminzo --version | help
`;

const SHOWABLE = /^(roles\/[a-z0-9-]+\.md|templates\/[a-z0-9-]+\.(md|json))$/;

function flags(args, allowed) {
  const unknown = args.filter((a) => !allowed.includes(a));
  if (unknown.length) throw new CliError(`unknown option: ${unknown[0]} (accepted: ${allowed.join(', ') || 'none'})`, 2);
  return Object.fromEntries(allowed.map((f) => [f, args.includes(f)]));
}

function show(args, dist) {
  if (args.length !== 1 || !SHOWABLE.test(args[0])) throw new CliError('usage: eminzo show roles/<role>.md | templates/<file>', 2);
  const file = join(engineFolder(dist), args[0]);
  if (!existsSync(file)) throw new CliError(`the engine has no ${args[0]}`);
  process.stdout.write(readFileSync(file, 'utf8'));
  return 0;
}

/** @returns {Promise<number>} exit status */
export async function main(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const [command, ...args] = argv;
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      process.stdout.write(HELP);
      return 0;
    }
    if (command === '--version' || command === '-v' || command === 'version') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) throw new CliError(`eminzo needs Node.js 20 or newer (found ${process.versions.node})`);

    const home = homeDir(env);
    switch (command) {
      case 'install': {
        const f = flags(args, ['--dry-run', '--force']);
        const { install } = await import('./install.js');
        return install({ dist: distDir(env), version: VERSION, home, dryRun: f['--dry-run'], force: f['--force'] });
      }
      case 'uninstall': {
        const f = flags(args, ['--dry-run']);
        const { uninstall } = await import('./install.js');
        return uninstall({ home, dryRun: f['--dry-run'] });
      }
      case 'doctor': {
        const f = flags(args, ['--json']);
        const { doctor } = await import('./doctor.js');
        return doctor({ version: VERSION, home, env, cwd, json: f['--json'] });
      }
      case 'enable': {
        const f = flags(args, ['--dry-run', '--json']);
        const { enable } = await import('./enable.js');
        return await enable({ dist: distDir(env), version: VERSION, env, cwd, dryRun: f['--dry-run'], json: f['--json'] });
      }
      case 'show':
        return show(args, distDir(env));
      default: {
        const { ENGINE_COMMANDS, runEngine } = await import('./engine.js');
        if (!ENGINE_COMMANDS.includes(command)) throw new CliError(`unknown command: ${command} (run: eminzo help)`, 2);
        return await runEngine(command, args, { dist: distDir(env), version: VERSION, env, cwd });
      }
    }
  } catch (err) {
    // With --json the caller reads stdout: any failure, expected or not, is one JSON object there too.
    if ((command === 'enable' || command === 'doctor') && args.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`);
      return err instanceof CliError ? err.code : 1;
    }
    if (!(err instanceof CliError)) throw err;
    process.stderr.write(`error: ${err.message}\n`);
    return err.code;
  }
}
