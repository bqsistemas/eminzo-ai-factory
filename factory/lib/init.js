// factory/bin/init: writes a first draft of factory/project.md from the repo when the
// file is missing, and never overwrites an existing one. Deterministic: no network, no
// LLM. It fills what the repo states (manifest, scripts, top-level layout) and leaves
// the rest for a person to complete.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Usage, engineCommand, factoryRoot, isMain, run, runCli, writeAtomic } from './util.js';

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

function stackLines(root) {
  const lines = [];
  const pkg = readJson(join(root, 'package.json'));
  if (pkg) {
    const engine = pkg.engines?.node ? ` (engines.node ${pkg.engines.node})` : '';
    lines.push(`- Node.js${engine}${pkg.type === 'module' ? ', ES modules' : ''}`);
    const deps = Object.keys(pkg.dependencies ?? {});
    const dev = Object.keys(pkg.devDependencies ?? {});
    lines.push(`- Dependencies: ${deps.length ? deps.map((d) => `\`${d}\``).join(', ') : 'none'}`);
    if (dev.length) lines.push(`- Dev dependencies: ${dev.map((d) => `\`${d}\``).join(', ')}`);
  }
  const manifests = { 'pyproject.toml': 'Python', 'requirements.txt': 'Python', 'go.mod': 'Go', 'Cargo.toml': 'Rust', Gemfile: 'Ruby', 'pom.xml': 'Java (Maven)', 'build.gradle': 'Java/Kotlin (Gradle)' };
  for (const [file, name] of Object.entries(manifests)) if (existsSync(join(root, file))) lines.push(`- ${name} (\`${file}\`)`);
  return lines.length ? lines : ['- TODO: language, runtime and dependencies.'];
}

function commandLines(root) {
  const scripts = readJson(join(root, 'package.json'))?.scripts ?? {};
  const out = [];
  for (const [label, name] of [['Run', 'start'], ['Test', 'test'], ['Build', 'build']]) {
    if (Object.hasOwn(scripts, name)) out.push(`- ${label}: \`npm ${name === 'start' || name === 'test' ? name : `run ${name}`}\``);
    else out.push(`- ${label}: TODO`);
  }
  for (const name of Object.keys(scripts)) if (!['start', 'test', 'build'].includes(name)) out.push(`- \`npm run ${name}\`: TODO what it does`);
  return out;
}

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor']);

/** Tracked top-level entries (git), or the visible ones in the folder. Sorted. */
function topLevel(root) {
  const res = run('git', ['ls-files'], { cwd: root });
  const names = new Set();
  if (res.status === 0 && res.stdout.trim()) {
    for (const path of res.stdout.split('\n').filter(Boolean)) {
      const [head, ...rest] = path.split('/');
      names.add(rest.length ? `${head}/` : head);
    }
  } else {
    for (const name of readdirSync(root)) {
      if (!name.startsWith('.') && !SKIP.has(name)) names.add(statSync(join(root, name)).isDirectory() ? `${name}/` : name);
    }
  }
  return [...names].filter((n) => !n.startsWith('.') && !SKIP.has(n.replace(/\/$/, ''))).sort();
}

/** The draft text. `today` is a YYYY-MM-DD string. */
export function renderProject(root, today) {
  const map = topLevel(root).map((name) => `- \`${name}\`: TODO what it does`);
  return [
    '# Project context',
    '',
    'Every factory agent reads this before working. Keep it short and current. The builder',
    'updates it in the same branch when a change alters the stack, the commands or the modules.',
    `This is a first draft written by \`${engineCommand('init')}\`; complete every TODO.`,
    '',
    '## Snapshot',
    '',
    `- ${today}, first draft from \`${engineCommand('init')}\`.`,
    '- TODO: what the project is, in one or two lines.',
    '',
    '## Stack',
    '',
    ...stackLines(root),
    '',
    '## Commands',
    '',
    ...commandLines(root),
    '',
    '## Module map',
    '',
    'One line per module or folder: its path in backticks, then what it does. Use a folder or a',
    'glob (`lib/*`) to cover a group. The gate flags files a job adds that no line mentions.',
    '',
    ...(map.length ? map : ['- TODO: list the modules.']),
    '',
    '## Conventions',
    '',
    '- TODO: commit style, branch naming, test layout.',
    '',
  ].join('\n');
}

/** Writes factory/project.md unless it exists. @returns {{created: boolean, path: string}} */
export function initProject(root, today) {
  const path = join(root, 'factory/project.md');
  if (existsSync(path)) return { created: false, path };
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, renderProject(root, today));
  return { created: true, path };
}

/** Copies the commented factory/review.md template unless the repo has a review.md. @returns {{created: boolean, path: string}} */
export function initReview(root) {
  const path = join(root, 'factory/review.md');
  if (existsSync(path)) return { created: false, path };
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../templates/review.md', import.meta.url)), path);
  return { created: true, path };
}

function main(args) {
  if (args.length > 1 || (args.length && args[0] !== 'review')) throw new Usage('init [review]');
  if (args[0] === 'review') {
    const review = initReview(factoryRoot());
    process.stdout.write(review.created ? `wrote ${review.path}; optional, edit or delete the sections you do not need\n` : `${review.path} already exists; left untouched\n`);
    return;
  }
  const today = process.env.FACTORY_TODAY || new Date().toISOString().slice(0, 10);
  const { created, path } = initProject(factoryRoot(), today);
  process.stdout.write(created ? `wrote ${path}; review it and fill every TODO\n` : `${path} already exists; left untouched\n`);
}

if (isMain(import.meta.url)) runCli(main);
