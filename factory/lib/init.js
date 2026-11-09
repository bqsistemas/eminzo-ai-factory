// factory/bin/init: writes a first draft of factory/project.md from the repo when the
// file is missing, and never overwrites an existing one. Deterministic: no network, no
// LLM. It fills what the repo states (manifest, scripts, top-level layout) and leaves
// the rest for a person to complete.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DEFAULT_AC_PATTERN } from './selfcheck.js';
import { acPattern, checksFor, commands, detectStack, packageManager, scriptCommand as scriptFor, span, stacksIn } from './stacks.js';
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

/** What the stack detection reads: the root entries, package.json, and any file's text. */
function repoOf(root) {
  return {
    files: readdirSync(root),
    packageJson: readJson(join(root, 'package.json')),
    read: (f) => { try { return readFileSync(join(root, f), 'utf8'); } catch { return ''; } },
  };
}

function commandLines(root) {
  const repo = repoOf(root);
  const found = stacksIn(repo.files);
  const detected = detectStack(repo);
  const stack = detected === 'none' ? found[0] : detected;
  if (!stack) return ['- Run: none detected (no manifest found)', '- Test: none detected', '- Build: none detected'];
  const c = commands(stack, repo);
  const out = [`- Run: ${c.run}`, `- Test: ${c.test}`, `- Build: ${c.build}`];
  const others = found.filter((s) => s !== stack);
  if (others.length) out.push(`- Also found: ${others.join(', ')}. The commands above are for ${stack}; add the others here.`);
  const scripts = stack === 'node' ? repo.packageJson?.scripts ?? {} : {};
  for (const [name, body] of Object.entries(scripts)) if (!['start', 'test', 'build'].includes(name)) out.push(`- ${span(scriptFor(packageManager(repo.files), name))}: runs ${span(String(body))}`);
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

/** Whether something is at `path`, a dangling symlink included. */
const present = (path) => { try { lstatSync(path); return true; } catch { return false; } };

/** Writes factory/checks.sh (mode 0755) unless something is there. @returns {{created: boolean, path: string, stack?: string, executable?: boolean}} */
export function initChecks(root) {
  const path = join(root, 'factory/checks.sh');
  if (present(path)) {
    let executable = true;
    try { executable = (statSync(path).mode & 0o111) !== 0; } catch { /* dangling link: nothing to run */ executable = false; }
    return { created: false, path, executable };
  }
  const { stack, script } = checksFor(repoOf(root));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, script, { mode: 0o755 });
  renameSync(tmp, path);
  return { created: true, path, stack };
}

/**
 * Sets selfcheck.ac_pattern in factory/config.json to the stack's default, only while it still has the
 * generic default (a value somebody chose stays). The edit is anchored inside the "selfcheck" object, so the
 * rest of the file keeps its layout and no other key can match.
 * @returns {{changed: boolean, pattern?: string}}
 */
export function initAcPattern(root, stack) {
  const path = join(root, 'factory/config.json');
  const pattern = acPattern(stack);
  if (!existsSync(path) || pattern === DEFAULT_AC_PATTERN) return { changed: false };
  const text = readFileSync(path, 'utf8');
  if (readJson(path)?.selfcheck?.ac_pattern !== DEFAULT_AC_PATTERN) return { changed: false };
  const literal = JSON.stringify(DEFAULT_AC_PATTERN).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const re = new RegExp(`("selfcheck"\\s*:\\s*\\{[^{}]*?"ac_pattern"\\s*:\\s*)${literal}`);
  if (!re.test(text)) return { changed: false };
  writeFileSync(path, text.replace(re, (_, head) => `${head}${JSON.stringify(pattern)}`));
  return { changed: true, pattern };
}

function main(args) {
  if (args.length) throw new Usage('init');
  const today = process.env.FACTORY_TODAY || new Date().toISOString().slice(0, 10);
  const root = factoryRoot();
  const { created, path } = initProject(root, today);
  process.stdout.write(created ? `wrote ${path}; review it and fill every TODO\n` : `${path} already exists; left untouched\n`);
  const checks = initChecks(root);
  process.stdout.write(checks.created ? `wrote ${checks.path} for the ${checks.stack} stack; review it\n` : `${checks.path} already exists; left untouched\n`);
  if (!checks.created && !checks.executable) process.stdout.write(`warning: ${checks.path} is not executable; run: chmod +x factory/checks.sh\n`);
  const stack = checks.stack ?? checksFor(repoOf(root)).stack;
  const ac = initAcPattern(root, stack);
  if (ac.changed) process.stdout.write(`set selfcheck.ac_pattern to ${ac.pattern} in factory/config.json\n`);
}

if (isMain(import.meta.url)) runCli(main);
