// Builds cli/dist/, the part of the npm package generated from this repo (the engine's source):
//   dist/factory/    the engine: factory/ without this repo's data or config (EMINZO_ENGINE points here)
//   dist/adapters/   the Claude and Codex skills and agents `eminzo install` copies to the home folder
//   dist/build.json  the version
// The source files are only read. Run: node cli/build.mjs (npm pack runs it through prepack).
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudeAgent, claudeSkill, codexAgent, codexSkill } from './src/adapters.js';

const CLI = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(CLI, '..');

/** Top-level entries of factory/ that belong to this repo, never to the engine. */
export const ENGINE_EXCLUDE = new Set(['jobs', 'board.json', 'config.json', 'config.local.json', 'checks.sh', 'project.md']);

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** @returns {{ out: string, version: string, adapters: string[] }} */
export function build({ repoRoot = REPO, out = join(CLI, 'dist'), version } = {}) {
  version ??= JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).version;
  rmSync(out, { recursive: true, force: true });

  // The engine: everything under factory/ except this repo's data, config and dotfiles.
  const engine = join(out, 'factory');
  mkdirSync(engine, { recursive: true });
  for (const name of readdirSync(join(repoRoot, 'factory'))) {
    if (ENGINE_EXCLUDE.has(name) || name.startsWith('.')) continue;
    cpSync(join(repoRoot, 'factory', name), join(engine, name), { recursive: true });
  }
  for (const name of readdirSync(join(engine, 'bin'))) chmodSync(join(engine, 'bin', name), statSync(join(engine, 'bin', name)).mode | 0o755);

  // The adapters, laid out as they go under the home folder (claude/ -> ~/.claude/, ...).
  const adapters = [];
  const emit = (rel, text) => { write(join(out, 'adapters', rel), text); adapters.push(rel); };
  const src = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
  emit('claude/skills/eminzo-factory/SKILL.md', claudeSkill(src('.claude/skills/eminzo-factory/SKILL.md'), { version }));
  emit('agents/skills/eminzo-factory/SKILL.md', codexSkill(src('.agents/skills/eminzo-factory/SKILL.md'), { version }));
  for (const file of readdirSync(join(repoRoot, '.claude/agents')).filter((f) => /^eminzo-.*\.md$/.test(f)).sort()) {
    const roleName = file.replace(/^eminzo-|\.md$/g, '');
    emit(`claude/agents/${file}`, claudeAgent(src(`.claude/agents/${file}`), { role: src(`factory/roles/${roleName}.md`), roleName, version }));
  }
  for (const file of readdirSync(join(repoRoot, '.codex/agents')).filter((f) => /^eminzo-.*\.toml$/.test(f)).sort()) {
    const roleName = file.replace(/^eminzo-|\.toml$/g, '');
    emit(`codex/agents/${file}`, codexAgent(src(`.codex/agents/${file}`), { role: src(`factory/roles/${roleName}.md`), roleName, version }));
  }

  write(join(out, 'build.json'), `${JSON.stringify({ version, adapters }, null, 2)}\n`);
  return { out, version, adapters };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, version, adapters } = build();
  process.stdout.write(`eminzo ${version}: engine and ${adapters.length} adapters built in ${out}\n`);
}
