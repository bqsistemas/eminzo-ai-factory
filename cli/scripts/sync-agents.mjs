// Renders the repository adapters (.claude/agents/*.md, .codex/agents/*.toml) from factory/roles/*.md, the provider
// templates and factory/templates/agents.json, with the same generator `eminzo install` uses (cli/src/adapters.js).
//   node cli/scripts/sync-agents.mjs           rewrite the committed adapters
//   node cli/scripts/sync-agents.mjs --check   change nothing; exit 1 when a committed file differs from the generated one
//   --root <dir>                               work on another checkout (the tests use a tampered copy)
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoAgents } from '../src/adapters.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** @returns {{ files: Record<string, string>, drifted: string[] }} generated files and the committed ones that differ */
export function generate(root) {
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  const files = repoAgents({
    meta: JSON.parse(read('factory/templates/agents.json')),
    claude: read('factory/templates/agent-claude.md'),
    codex: read('factory/templates/agent-codex.toml'),
    shared: read('factory/templates/agent-shared.md'),
  });
  const drifted = Object.entries(files).filter(([rel, text]) => !existsSync(join(root, rel)) || read(rel) !== text).map(([rel]) => rel);
  // A committed eminzo-* adapter with no entry in agents.json would never be regenerated or checked.
  for (const [dir, ext] of [['.claude/agents', '.md'], ['.codex/agents', '.toml']]) {
    if (!existsSync(join(root, dir))) continue;
    for (const f of readdirSync(join(root, dir))) if (/^eminzo-/.test(f) && f.endsWith(ext) && !(`${dir}/${f}` in files)) drifted.push(`${dir}/${f}`);
  }
  return { files, drifted };
}

export function sync(root, { check = false } = {}) {
  const { files, drifted } = generate(root);
  if (!check) {
    for (const rel of drifted) if (rel in files) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), files[rel]); }
  }
  return drifted;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const at = process.argv.indexOf('--root');
  const drifted = sync(at > 0 ? resolve(process.argv[at + 1]) : resolve(HERE, '../..'), { check });
  if (check && drifted.length) {
    process.stderr.write(`sync-agents: out of sync with factory/roles and factory/templates:\n${drifted.map((f) => `  ${f}`).join('\n')}\nrun: npm run sync-agents\n`);
    process.exit(1);
  }
  process.stdout.write(check ? 'sync-agents: all adapters are in sync\n' : `sync-agents: ${drifted.length} file(s) rewritten\n`);
}
