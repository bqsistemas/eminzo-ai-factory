// Stand-ins for `claude mcp add|remove --scope user` and `codex mcp add|remove`, so install tests never touch a real
// Claude Code or Codex config. They behave like the real commands as documented: they edit only the named entry
// (Claude: the top-level mcpServers in ~/.claude.json; Codex: one [mcp_servers.<name>] table in config.toml),
// refuse to add a name that exists, and log every call to $FAKE_CLI_LOG.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(['claude', ...args]) + '\\n');
if (process.env.FAKE_CLI_FAIL === 'claude') { process.stderr.write('claude: simulated failure\\n'); process.exit(1); }
const file = path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, '.claude.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const save = (d) => fs.writeFileSync(file, JSON.stringify(d, null, 2));
if (args[0] === 'mcp' && args[1] === 'add' && args[2] === '--scope' && args[3] === 'user' && args[5] === '--') {
  const d = read(); d.mcpServers = d.mcpServers || {};
  if (d.mcpServers[args[4]]) { process.stderr.write('MCP server ' + args[4] + ' already exists in user config\\n'); process.exit(1); }
  d.mcpServers[args[4]] = { type: 'stdio', command: args[6], args: args.slice(7), env: {} }; save(d);
  process.stdout.write('Added stdio MCP server ' + args[4] + ' to user config\\n');
} else if (args[0] === 'mcp' && args[1] === 'remove' && args[2] === '--scope' && args[3] === 'user') {
  const d = read();
  if (!d.mcpServers || !d.mcpServers[args[4]]) { process.stderr.write('No user-scoped MCP server found with name: ' + args[4] + '\\n'); process.exit(1); }
  delete d.mcpServers[args[4]]; save(d);
} else { process.stderr.write('fake claude: unsupported ' + args.join(' ') + '\\n'); process.exit(2); }
`;

const CODEX = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(['codex', ...args]) + '\\n');
const dir = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
const file = path.join(dir, 'config.toml');
const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const header = (name) => new RegExp('^\\\\[mcp_servers\\\\.' + name + '\\\\]\\\\s*$', 'm');
if (args[0] === 'mcp' && args[1] === 'add' && args[3] === '--') {
  const text = read();
  if (header(args[2]).test(text)) { process.stderr.write('MCP server ' + args[2] + ' already exists\\n'); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });
  const block = '[mcp_servers.' + args[2] + ']\\ncommand = ' + JSON.stringify(args[4]) + '\\nargs = ' + JSON.stringify(args.slice(5)) + '\\n';
  fs.writeFileSync(file, text + (text && !text.endsWith('\\n') ? '\\n' : '') + (text ? '\\n' : '') + block);
  process.stdout.write("Added global MCP server '" + args[2] + "'.\\n");
} else if (args[0] === 'mcp' && args[1] === 'remove') {
  const lines = read().split('\\n');
  const start = lines.findIndex((l) => header(args[2]).test(l));
  if (start === -1) { process.stderr.write('No MCP server named ' + args[2] + '\\n'); process.exit(1); }
  let end = start + 1;
  while (end < lines.length && !/^\\[/.test(lines[end])) end += 1;
  let from = start;
  if (from > 0 && lines[from - 1] === '') from -= 1;
  lines.splice(from, end - from);
  fs.writeFileSync(file, lines.join('\\n').replace(/\\n*$/, '\\n'));
} else { process.stderr.write('fake codex: unsupported ' + args.join(' ') + '\\n'); process.exit(2); }
`;

/** Writes fake `claude` and `codex` into `<dir>/fakebin` and returns that folder (put it first on PATH). */
export function fakeAgentClis(dir, { claude = true, codex = true } = {}) {
  const bin = join(dir, 'fakebin');
  mkdirSync(bin, { recursive: true });
  if (claude) { writeFileSync(join(bin, 'claude'), CLAUDE); chmodSync(join(bin, 'claude'), 0o755); }
  if (codex) { writeFileSync(join(bin, 'codex'), CODEX); chmodSync(join(bin, 'codex'), 0o755); }
  return bin;
}
