// Renders the repository adapters (.claude/agents/*.md, .codex/agents/*.toml) from factory/roles/*.md, the provider
// templates and factory/templates/agents.json, with the same generator `eminzo install` uses (cli/src/adapters.js).
//   node cli/scripts/sync-agents.mjs           rewrite the committed adapters
//   node cli/scripts/sync-agents.mjs --check   change nothing; exit 1 when a committed file differs from the generated one
//   --root <dir>                               work on another checkout (the tests use a tampered copy)
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoAgents } from '../src/adapters.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** @returns {{ files: Record<string, string>, drifted: string[], stale: string[] }} generated files, committed ones that differ or are missing, and committed eminzo-* adapters no role generates */
export function generate(root) {
  const read = (rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n'); // a CRLF checkout must not drift
  const meta = JSON.parse(read('factory/templates/agents.json'));
  for (const role of Object.keys(meta)) if (!existsSync(join(root, `factory/roles/${role}.md`))) throw new Error(`agents.json lists "${role}" but factory/roles/${role}.md does not exist`);
  const files = repoAgents({
    meta,
    claude: read('factory/templates/agent-claude.md'),
    codex: read('factory/templates/agent-codex.toml'),
    shared: read('factory/templates/agent-shared.md'),
  });
  const drifted = Object.entries(files).filter(([rel, text]) => !existsSync(join(root, rel)) || read(rel) !== text).map(([rel]) => rel);
  const stale = [];
  for (const [dir, ext] of [['.claude/agents', '.md'], ['.codex/agents', '.toml']]) {
    if (!existsSync(join(root, dir))) continue;
    for (const f of readdirSync(join(root, dir))) if (/^eminzo-/.test(f) && f.endsWith(ext) && !(`${dir}/${f}` in files)) stale.push(`${dir}/${f}`);
  }
  return { files, drifted, stale };
}

/** @returns {{ written: string[], removed: string[], stale: string[], drifted: string[] }} in check mode nothing is touched and `drifted` and `stale` are what differs */
export function sync(root, { check = false } = {}) {
  const { files, drifted, stale } = generate(root);
  if (check) return { written: [], removed: [], drifted, stale };
  for (const rel of drifted) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), files[rel]); }
  for (const rel of stale) rmSync(join(root, rel));
  return { written: drifted, removed: stale, drifted: [], stale: [] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const at = process.argv.indexOf('--root');
  const r = sync(at > 0 ? resolve(process.argv[at + 1]) : resolve(HERE, '../..'), { check });
  if (check && (r.drifted.length || r.stale.length)) {
    const list = (title, files) => (files.length ? `${title}:\n${files.map((f) => `  ${f}`).join('\n')}\n` : '');
    process.stderr.write(`sync-agents: out of sync with factory/roles and factory/templates\n${list('differs from the generated file', r.drifted)}${list('stale (no role generates it)', r.stale)}run: npm run sync-agents\n`);
    process.exit(1);
  }
  process.stdout.write(check ? 'sync-agents: all adapters are in sync\n' : `sync-agents: ${r.written.length} file(s) rewritten, ${r.removed.length} stale removed${r.removed.map((f) => `\n  removed ${f}`).join('')}\n`);
}
