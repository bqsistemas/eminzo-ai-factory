// eminzo install registers the "eminzo" MCP server in Claude Code and Codex through their own commands, says so,
// and never changes anything else in their configs; uninstall removes only the entries install added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../cli/build.mjs';
import { install, installHeader, uninstall } from '../cli/src/install.js';
import { claudeEntry, codexEntry, findOnPath, planMcp, shown } from '../cli/src/mcp-register.js';
import { fakeAgentClis } from './helpers/fake-agent-clis.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(repo, 'cli/package.json'), 'utf8')).version;
const dist = join(mkdtempSync(join(tmpdir(), 'eminzo-mcp-dist-')), 'dist');
build({ out: dist });

/** A temp HOME with the person's own Claude and Codex configs, and PATH with the fake CLIs only. */
function machine({ claude = true, codex = true, claudeJson, codexToml } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eminzo-mcp-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.codex'), { recursive: true });
  const userClaude = claudeJson ?? { numStartups: 42, theme: 'dark', mcpServers: { github: { type: 'stdio', command: 'gh-mcp', args: [] } }, projects: { '/repo': { mcpServers: { local: { command: 'x' } } } } };
  writeFileSync(join(home, '.claude.json'), JSON.stringify(userClaude, null, 2));
  const userCodex = codexToml ?? 'model = "gpt-6"\n\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n';
  writeFileSync(join(home, '.codex/config.toml'), userCodex);
  const log = join(dir, 'calls.log');
  const env = { HOME: home, PATH: fakeAgentClis(dir, { claude, codex }), FAKE_CLI_LOG: log };
  const out = { text: '', write(s) { this.text += s; } };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const claudeConfig = () => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  const codexConfig = () => readFileSync(join(home, '.codex/config.toml'), 'utf8');
  return { dir, home, env, out, calls, claudeConfig, codexConfig, userClaude, userCodex };
}

const run = (m, opts = {}) => install({ dist, version, home: m.home, env: m.env, out: m.out, ...opts });

test('the header says everything install puts on the machine before it does anything', () => {
  const m = machine();
  run(m);
  assert.ok(m.out.text.startsWith(installHeader({ version })));
  assert.match(m.out.text, /the eminzo-factory skill and its agents for Claude Code/);
  assert.match(m.out.text, /the "eminzo" MCP server \(read-only factory tools\) in Claude Code and Codex/);
  assert.match(m.out.text, /nothing else is changed/);
  assert.match(installHeader({ version, mcp: false, dryRun: true }), /would install[\s\S]*not the "eminzo" MCP server \(--no-mcp\)/);
});

test('install adds only the eminzo entry, through each tool\'s own command, and leaves the rest as it was', () => {
  const m = machine();
  assert.equal(run(m), 0);
  assert.deepEqual(m.calls(), [
    ['claude', 'mcp', 'add', '--scope', 'user', 'eminzo', '--', 'eminzo', 'mcp'],
    ['codex', 'mcp', 'add', 'eminzo', '--', 'eminzo', 'mcp'],
  ]);
  const claude = m.claudeConfig();
  assert.deepEqual(claude.mcpServers.eminzo, { type: 'stdio', command: 'eminzo', args: ['mcp'], env: {} });
  const { eminzo, ...othersAfter } = claude.mcpServers;
  assert.deepEqual({ ...claude, mcpServers: othersAfter }, m.userClaude, 'every other key and server is unchanged');
  assert.ok(m.codexConfig().startsWith(m.userCodex), 'the Codex config only gains a table at the end');
  assert.match(m.codexConfig(), /\[mcp_servers\.eminzo\]\ncommand = "eminzo"\nargs = \["mcp"\]/);
  assert.match(m.out.text, /^register MCP server "eminzo" in Claude Code: claude mcp add --scope user eminzo -- eminzo mcp$/m);
  assert.match(m.out.text, /^register MCP server "eminzo" in Codex: codex mcp add eminzo -- eminzo mcp$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(m.home, '.eminzo/install.json'), 'utf8')).mcp, { claude: true, codex: true });
});

test('a second install changes nothing and keeps knowing the entries are eminzo\'s', () => {
  const m = machine();
  run(m);
  const before = [m.claudeConfig(), m.codexConfig()];
  m.out.text = '';
  assert.equal(run(m), 0);
  assert.equal(m.calls().length, 2, 'no new call');
  assert.deepEqual([m.claudeConfig(), m.codexConfig()], before);
  assert.doesNotMatch(m.out.text, /MCP server "eminzo"/);
  assert.deepEqual(JSON.parse(readFileSync(join(m.home, '.eminzo/install.json'), 'utf8')).mcp, { claude: true, codex: true });
});

test('an "eminzo" entry the person set up differently is kept, and uninstall leaves it too', () => {
  const m = machine({
    claudeJson: { mcpServers: { eminzo: { command: 'node', args: ['/my/fork/mcp.js'] } } },
    codexToml: '[mcp_servers.eminzo]\ncommand = "node"\nargs = ["/my/fork/mcp.js"]\n',
  });
  assert.equal(run(m), 0);
  assert.deepEqual(m.calls(), []);
  assert.match(m.out.text, /keep MCP server "eminzo" in Claude Code \(it runs another command; eminzo does not change it\)/);
  assert.match(m.out.text, /keep MCP server "eminzo" in Codex/);
  uninstall({ home: m.home, env: m.env, out: m.out });
  assert.deepEqual(m.calls(), [], 'uninstall does not touch it either');
  assert.equal(m.claudeConfig().mcpServers.eminzo.command, 'node');
});

test('an entry the person added by hand is not removed by uninstall, because install did not add it', () => {
  const m = machine({ claudeJson: { mcpServers: { eminzo: { type: 'stdio', command: 'eminzo', args: ['mcp'] } } } });
  run(m);
  assert.deepEqual(JSON.parse(readFileSync(join(m.home, '.eminzo/install.json'), 'utf8')).mcp, { claude: false, codex: true });
  uninstall({ home: m.home, env: m.env, out: m.out });
  assert.ok(m.claudeConfig().mcpServers.eminzo, 'still there');
  assert.deepEqual(m.calls().at(-1), ['codex', 'mcp', 'remove', 'eminzo']);
});

test('uninstall removes the entries install added and gives back the configs as they were', () => {
  const m = machine();
  run(m);
  m.out.text = '';
  assert.equal(uninstall({ home: m.home, env: m.env, out: m.out }), 0);
  assert.deepEqual(m.calls().slice(2), [['claude', 'mcp', 'remove', '--scope', 'user', 'eminzo'], ['codex', 'mcp', 'remove', 'eminzo']]);
  assert.deepEqual(m.claudeConfig(), m.userClaude);
  assert.equal(m.codexConfig(), m.userCodex);
  assert.match(m.out.text, /^remove MCP server "eminzo" in Claude Code: claude mcp remove --scope user eminzo$/m);
});

test('a missing tool, a failed command, --no-mcp and --dry-run are all visible and never fail the install', () => {
  const missing = machine({ codex: false });
  assert.equal(run(missing), 0);
  assert.match(missing.out.text, /skip MCP server "eminzo" in Codex \(codex is not installed; later run: codex mcp add eminzo -- eminzo mcp\)/);
  assert.equal(codexEntry(missing.home, missing.env), 'absent');

  const failing = machine();
  failing.env.FAKE_CLI_FAIL = 'claude';
  assert.equal(run(failing), 0);
  assert.match(failing.out.text, /warning: could not register MCP server "eminzo" in Claude Code: claude: simulated failure; run it yourself: claude mcp add --scope user eminzo -- eminzo mcp/);
  assert.deepEqual(JSON.parse(readFileSync(join(failing.home, '.eminzo/install.json'), 'utf8')).mcp, { claude: false, codex: true });

  const off = machine();
  assert.equal(run(off, { mcp: false }), 0);
  assert.deepEqual(off.calls(), []);
  assert.match(off.out.text, /not the "eminzo" MCP server \(--no-mcp\)/);

  const dry = machine();
  assert.equal(run(dry, { dryRun: true }), 0);
  assert.deepEqual(dry.calls(), []);
  assert.match(dry.out.text, /register MCP server "eminzo" in Claude Code: claude mcp add/);
  assert.equal(existsSync(join(dry.home, '.eminzo/install.json')), false);
});

test('the states are read without writing: absent, ours, other, unknown', () => {
  const m = machine();
  assert.equal(claudeEntry(m.home, m.env), 'absent');
  writeFileSync(join(m.home, '.claude.json'), '{ broken');
  assert.equal(claudeEntry(m.home, m.env), 'unknown');
  assert.deepEqual(planMcp({ home: m.home, env: m.env }).map((p) => [p.tool, p.action]), [['claude', 'unreadable'], ['codex', 'register']]);
  writeFileSync(join(m.home, '.codex/config.toml'), '[mcp_servers."eminzo"]\ncommand = "eminzo" # ours\nargs = ["mcp"]\n[other]\nargs = ["x"]\n');
  assert.equal(codexEntry(m.home, m.env), 'ours');
  assert.equal(codexEntry(m.home, { ...m.env, CODEX_HOME: join(m.dir, 'nowhere') }), 'absent');
  assert.equal(findOnPath('claude', m.env), join(m.dir, 'fakebin', 'claude'));
  assert.equal(findOnPath('claude', { PATH: 'relative/dir' }), null);
  assert.equal(shown('codex'), 'codex mcp add eminzo -- eminzo mcp');
});
