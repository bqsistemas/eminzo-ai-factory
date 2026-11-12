// `eminzo install` / `eminzo uninstall`: the "eminzo" MCP server entry in Claude Code and Codex.
//
// Only that one entry is ever added or removed, and always through each tool's own command
// (`claude mcp add|remove --scope user`, `codex mcp add|remove`), so the rest of ~/.claude.json and
// ~/.codex/config.toml is never rewritten by eminzo. The current state is only read:
//   absent   no "eminzo" entry: install adds it
//   ours     "eminzo" runs `eminzo mcp`: nothing to do
//   other    "eminzo" runs something else: the person's own entry, never touched
//   unknown  the config cannot be read: nothing is done, and the person is told
// Uninstall removes the entry only when install added it (recorded in ~/.eminzo/install.json) and it still runs
// `eminzo mcp`; an entry the person added themselves stays.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export const MCP_NAME = 'eminzo';
export const MCP_COMMAND = Object.freeze(['eminzo', 'mcp']);

export const MCP_TOOLS = Object.freeze({
  claude: Object.freeze({
    label: 'Claude Code',
    bin: 'claude',
    add: ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', ...MCP_COMMAND],
    remove: ['mcp', 'remove', '--scope', 'user', MCP_NAME],
  }),
  codex: Object.freeze({
    label: 'Codex',
    bin: 'codex',
    add: ['mcp', 'add', MCP_NAME, '--', ...MCP_COMMAND],
    remove: ['mcp', 'remove', MCP_NAME],
  }),
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameCommand = (command, args) => command === MCP_COMMAND[0] && Array.isArray(args) && args.length === 1 && args[0] === MCP_COMMAND[1];
const readOrNull = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? null : undefined; // undefined: exists but unreadable
  }
};

/** Where Claude Code keeps user-scope MCP servers: ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json. */
export const claudeConfigFile = (home, env = process.env) => join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
/** Where Codex keeps them: ~/.codex/config.toml, or $CODEX_HOME/config.toml. */
export const codexConfigFile = (home, env = process.env) => join(env.CODEX_HOME || join(home, '.codex'), 'config.toml');

/** The state of the "eminzo" entry in Claude Code's user config. */
export function claudeEntry(home, env = process.env) {
  const text = readOrNull(claudeConfigFile(home, env));
  if (text === null) return 'absent';
  if (text === undefined) return 'unknown';
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return 'unknown';
  }
  const entry = isObject(data) && isObject(data.mcpServers) ? data.mcpServers[MCP_NAME] : undefined;
  if (entry === undefined) return 'absent';
  return isObject(entry) && sameCommand(entry.command, entry.args) ? 'ours' : 'other';
}

/** Parses a TOML basic string or an array of basic strings; undefined for anything else. */
function tomlValue(text) {
  const value = text.trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return undefined; }
  }
  if (value.startsWith('[')) {
    try {
      const list = JSON.parse(value);
      return Array.isArray(list) && list.every((v) => typeof v === 'string') ? list : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The state of the "eminzo" entry in Codex's config.toml (only its own table is looked at). */
export function codexEntry(home, env = process.env) {
  const text = readOrNull(codexConfigFile(home, env));
  if (text === null) return 'absent';
  if (text === undefined) return 'unknown';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[\s*mcp_servers\.(?:eminzo|"eminzo")\s*\]\s*(#.*)?$/.test(l));
  if (start === -1) return 'absent';
  const fields = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*(command|args)\s*=\s*(.+?)\s*(#.*)?$/);
    if (m) fields[m[1]] = tomlValue(m[2]);
  }
  return sameCommand(fields.command, fields.args) ? 'ours' : 'other';
}

/** The absolute path of `bin` on env.PATH, or null. */
export function findOnPath(bin, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return join(dir, bin);
    } catch { /* not here */ }
  }
  return null;
}

const ENTRY = { claude: claudeEntry, codex: codexEntry };
/** How a command reads in a message. */
export const shown = (tool) => `${MCP_TOOLS[tool].bin} ${MCP_TOOLS[tool].add.join(' ')}`;

/**
 * What install would do for each tool: `{ tool, label, state, path, action }`, action being
 * `register`, `same`, `keep` (someone else's entry), `missing` (the tool is not installed) or `unreadable`.
 */
export function planMcp({ home, env = process.env }) {
  return Object.keys(MCP_TOOLS).map((tool) => {
    const state = ENTRY[tool](home, env);
    const path = findOnPath(MCP_TOOLS[tool].bin, env);
    const action = state === 'ours' ? 'same' : state === 'other' ? 'keep' : state === 'unknown' ? 'unreadable' : path ? 'register' : 'missing';
    return { tool, label: MCP_TOOLS[tool].label, state, path, action };
  });
}

const runTool = (path, args, env) => spawnSync(path, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
const why = (res) => (res.error ? res.error.message : String(res.stderr || res.stdout || `exit ${res.status}`).trim().split('\n').slice(-1)[0]);

/**
 * Carries out the plan: registers where needed, reports every tool in one line, and returns which entries eminzo
 * now owns ({ claude, codex }), counting an entry it registered earlier and that still runs `eminzo mcp`.
 */
export function registerMcp(plan, { env = process.env, dryRun = false, previous = {}, out = process.stdout, run = runTool }) {
  const owned = {};
  for (const step of plan) {
    const label = `MCP server "${MCP_NAME}" in ${step.label}`;
    if (step.action === 'same') {
      owned[step.tool] = previous[step.tool] === true;
      continue;
    }
    owned[step.tool] = false;
    if (step.action === 'keep') {
      out.write(`keep ${label} (it runs another command; eminzo does not change it)\n`);
    } else if (step.action === 'unreadable') {
      out.write(`skip ${label} (its config could not be read; to add it yourself: ${shown(step.tool)})\n`);
    } else if (step.action === 'missing') {
      out.write(`skip ${label} (${MCP_TOOLS[step.tool].bin} is not installed; later run: ${shown(step.tool)})\n`);
    } else if (dryRun) {
      out.write(`register ${label}: ${shown(step.tool)}\n`);
    } else {
      const res = run(step.path, MCP_TOOLS[step.tool].add, env);
      if (!res.error && res.status === 0) {
        out.write(`register ${label}: ${shown(step.tool)}\n`);
        owned[step.tool] = true;
      } else {
        out.write(`warning: could not register ${label}: ${why(res)}; run it yourself: ${shown(step.tool)}\n`);
      }
    }
  }
  return owned;
}

/** Removes the entries eminzo registered (per `owned`) that still run `eminzo mcp`; reports each one. */
export function unregisterMcp({ home, env = process.env, owned = {}, dryRun = false, out = process.stdout, run = runTool }) {
  for (const tool of Object.keys(MCP_TOOLS)) {
    if (owned[tool] !== true) continue;
    const label = `MCP server "${MCP_NAME}" in ${MCP_TOOLS[tool].label}`;
    const state = ENTRY[tool](home, env);
    if (state !== 'ours') {
      if (state === 'other') out.write(`keep ${label} (changed since eminzo registered it)\n`);
      continue;
    }
    const removeCmd = `${MCP_TOOLS[tool].bin} ${MCP_TOOLS[tool].remove.join(' ')}`;
    const path = findOnPath(MCP_TOOLS[tool].bin, env);
    if (!path) {
      out.write(`keep ${label} (${MCP_TOOLS[tool].bin} is not installed; to remove it: ${removeCmd})\n`);
      continue;
    }
    if (dryRun) {
      out.write(`remove ${label}: ${removeCmd}\n`);
      continue;
    }
    const res = run(path, MCP_TOOLS[tool].remove, env);
    out.write(!res.error && res.status === 0 ? `remove ${label}: ${removeCmd}\n` : `warning: could not remove ${label}: ${why(res)}; run it yourself: ${removeCmd}\n`);
  }
}
