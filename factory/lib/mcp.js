// factory/bin/mcp (installed: `eminzo mcp`): the factory's read-only tools as a Model Context Protocol server on
// stdin/stdout, for Ask Eminzo in the desktop and for any Claude Code or Codex session.
//
// No network listener and no long-lived service: the agent starts this process with the session and stops it by
// closing stdin. It reads the repository of the current directory (FACTORY_ROOT wins), writes nothing, and
// logs only to stderr, because stdout carries the protocol.
//
//   eminzo mcp          serve until stdin closes
//   eminzo mcp --help   print how to register it with Claude Code or Codex
import { createMcpServer, serveStdio } from './mcp/protocol.js';
import { INSTRUCTIONS, factoryTools } from './mcp/tools.js';
import { Usage, engineVersion, factoryRoot, isMain } from './util.js';

export const SERVER_NAME = 'eminzo';

const HELP = `eminzo mcp: the factory's read-only tools as an MCP server on stdin/stdout.

Run from inside a repository with a factory. eminzo install registers it in Claude Code and Codex;
to do it by hand:
  Claude Code: claude mcp add --scope user eminzo -- eminzo mcp
  Codex:       codex mcp add eminzo -- eminzo mcp
Or pass it to one Claude Code session (claude --mcp-config <file>) with:
  {"mcpServers": {"eminzo": {"command": "eminzo", "args": ["mcp"]}}}

Tools: factory_overview, list_jobs, job_detail, waiting_on_people, changes_since, period_summary, factory_diagnosis,
estimate_work, factory_config, factory_queue. None of them writes anything.
`;

/** The server for the repository at `root`. Exported for tests and for hosts that run it in-process. */
export function createFactoryServer({ root, now, gh, runner, log }) {
  return createMcpServer({
    name: SERVER_NAME,
    version: engineVersion() ?? '0.0.0',
    instructions: INSTRUCTIONS,
    tools: factoryTools({ root, now, gh, runner }),
    log,
  });
}

async function main(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.length) throw new Usage('mcp [--help]');
  const root = factoryRoot();
  const log = (text) => process.stderr.write(`eminzo mcp: ${text}\n`);
  await serveStdio(createFactoryServer({ root, log }));
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(err instanceof Usage ? `usage: ${err.message}\n` : `error: ${err.message}\n`);
    process.exitCode = err instanceof Usage ? 2 : 1;
  });
}
