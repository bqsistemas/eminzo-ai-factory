// What a branch changes against the base, read from git with full fidelity (modes, symlinks,
// submodules, binaries, additions, deletions), plus the path classes the approver script and the
// xs lane share. Repo-agnostic: repo specifics come from `config.approve.deny` and `protected_tests`.
import { sectionLines } from './section.js';
import { run } from './util.js';

/** Glob (`*`, `**`, `?`) to a RegExp that matches a whole repo-relative path. */
export const globRegex = (glob, flags = '') => new RegExp(`^${String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  .replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*')}$`, flags);

// Engine and control paths, and the CI files of common platforms: a change here needs a person.
export const DEFAULT_DENY = Object.freeze([
  '.github/**', '.claude/**', '.agents/**', '.codex/**',
  'factory/bin/**', 'factory/lib/**', 'factory/roles/**', 'factory/templates/**',
  'factory/config.json', 'factory/checks.sh', 'factory/project.md', 'factory/review.md',
  '.gitlab-ci.yml', '.circleci/**', '.buildkite/**', '.travis.yml', 'Jenkinsfile', 'azure-pipelines.yml',
  'bitbucket-pipelines.yml', 'appveyor.yml', '.drone.yml', 'cloudbuild.yaml', 'cloudbuild.yml',
  // Execution surfaces: files a tool runs or reads before any test does.
  '**/.npmrc', '**/.yarnrc*', '.husky/**', '**/Makefile', '**/Dockerfile*', '**/docker-compose*', '**/.gitattributes',
  '**/.gitmodules', '**/.env*', '**/*.config.js', '**/*.config.cjs', '**/*.config.mjs', '**/*.config.ts',
  '**/.eslintrc*', '**/babel.config.*', '**/tsconfig*.json',
]);

/** The path globs that always force a human or the LLM approver, plus the adapter's `config.approve.deny`. */
export function denyGlobs(config) {
  const extra = Array.isArray(config?.approve?.deny) ? config.approve.deny.filter((g) => typeof g === 'string' && g) : [];
  return [...DEFAULT_DENY, ...extra];
}

export const isDenied = (file, config) => denyGlobs(config).some((g) => globRegex(g, 'i').test(file));

// `test/`, `tests/` and `spec/` count only at the repo root (`src/spec/x.js` is code); `__tests__/` at any depth.
const TESTS = [/^(tests?|spec)\//i, /(^|\/)__tests__\//i, /\.(test|spec)\.[\w]+$/i];
export const isTestFile = (file) => TESTS.some((re) => re.test(file));

export const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/;
export const MANIFESTS = /(^|\/)(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|setup\.py|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|Gemfile[\w.-]*|composer\.json|mix\.exs|pubspec\.yaml)$/;
export const isManifest = (file) => MANIFESTS.test(file) || LOCKFILES.test(file);

/**
 * Every changed path of `base...branch` as `{ path, status, oldMode, newMode, binary }`.
 * Renames are reported as a deletion plus an addition. Returns null when git cannot say.
 */
export function diffEntries(cwd, base, branch) {
  const range = `${base}...${branch}`;
  const raw = run('git', ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', range], { cwd });
  const stat = run('git', ['diff', '--numstat', '-z', '--no-renames', range], { cwd });
  if (raw.status !== 0 || stat.status !== 0) return null;
  const parts = raw.stdout.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = parts[i].match(/^:(\d+) (\d+) \w+ \w+ (\w)$/);
    if (!m) return null;
    entries.push({ path: parts[i + 1], status: m[3], oldMode: m[1], newMode: m[2], binary: false, added: 0, deleted: 0 });
  }
  for (const line of stat.stdout.split('\0').filter(Boolean)) {
    const m = line.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    const entry = entries.find((e) => e.path === m[3]);
    if (!entry) continue;
    if (m[1] === '-' && m[2] === '-') entry.binary = true;
    else { entry.added = Number(m[1]); entry.deleted = Number(m[2]); }
  }
  return entries;
}

/** Why an entry cannot be judged by a script, or null: modes, symlinks, submodules, binaries, deletions. */
export function opaqueReason({ path, status, oldMode, newMode, binary }) {
  if ([oldMode, newMode].includes('160000')) return `submodule change: ${path}`;
  if ([oldMode, newMode].includes('120000')) return `symlink change: ${path}`;
  if (status === 'D') return `deleted file: ${path}`;
  if (status === 'A' && newMode === '100755') return `executable file added: ${path}`;
  if (status !== 'A' && oldMode !== newMode) return `mode change: ${path}`;
  if (binary) return `binary file: ${path}`;
  return null;
}

export const MAX_XS_FILES = 2;
export const DEFAULT_XS_MAX_LINES = 80;

/**
 * Why a diff is not an XS change, from the diff alone: at most two changed non-test files and two
 * added or modified tests, none added or deleted, no manifest, engine/CI/denied path or protected
 * test, nothing opaque, and at most `lanes.xs.max_lines` added plus deleted lines outside tests.
 */
export function xsLimitProblems(entries, config) {
  const problems = [];
  const code = entries.filter((e) => !isTestFile(e.path));
  if (code.length > MAX_XS_FILES) problems.push(`${code.length} non-test files changed (max ${MAX_XS_FILES})`);
  const tests = entries.filter((e) => isTestFile(e.path) && e.status !== 'D');
  if (tests.length > MAX_XS_FILES) problems.push(`${tests.length} test files added or modified (max ${MAX_XS_FILES})`);
  const cap = Number.isInteger(config?.lanes?.xs?.max_lines) ? config.lanes.xs.max_lines : DEFAULT_XS_MAX_LINES;
  const lines = code.reduce((n, e) => n + e.added + e.deleted, 0);
  if (lines > cap) problems.push(`${lines} changed lines outside tests (max ${cap})`);
  for (const e of entries) {
    if (e.status === 'A' && !isTestFile(e.path)) problems.push(`added file ${e.path}`);
    const opaque = opaqueReason(e);
    if (opaque) problems.push(opaque);
    if (isManifest(e.path)) problems.push(`manifest or lockfile ${e.path}`);
    if (isDenied(e.path, config)) problems.push(`engine, CI or denied path ${e.path}`);
    if ((config?.protected_tests ?? []).includes(e.path)) problems.push(`protected test ${e.path}`);
  }
  return [...new Set(problems)];
}

const LIST_LINE = /^\s*(?:[-*+]|\d+[.)]|\|)\s/;
const NEGATED = /\b(?:not|do not|don't|dont|without|except)\b/i;

/**
 * The exact files a spec section names: backticked repo-relative paths (optionally `:start-end`) on
 * list items or table rows. Prose lines are ignored, and so is a line that negates the path (`not`,
 * `do not`, `don't`, `without`, `except`). A directory, glob, absolute or `..` path is collected in
 * `unsafe`. A token with code marks (`=`, a quote, a parenthesis, or a leading `:`) is code, not a
 * path: it is ignored and never listed, unless it is also absolute, has a `..` segment or ends in `/`. Known limit: a negation the regex does not know can still list a path; the script then
 * only widens the scope to a file the section names on purpose.
 */
export function scopeTokens(text, title) {
  const lines = (sectionLines(text, title) ?? []).map((l) => l.text);
  const files = new Set();
  const unsafe = [];
  for (const line of lines) {
    if (!LIST_LINE.test(line) || NEGATED.test(line)) continue;
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const token = m[1].trim().replace(/:\d+(?:-\d+)?$/, '');
      if (!/[\w]/.test(token) || /\s/.test(token)) continue; // code, not a path
      if (/^\/|(^|\/)\.\.(\/|$)|\/$/.test(token)) unsafe.push(token);
      else if (/[="'()]|^:/.test(token)) continue; // code (selector, call, assignment), not a path
      else if (/[*?[\]{}]/.test(token)) unsafe.push(token);
      else if (/^[\w.@-]+(?:\/[\w.@-]+)*$/.test(token.replace(/^\.\//, '')) && (token.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(token))) {
        files.add(token.replace(/^\.\//, ''));
      }
    }
  }
  return { files, unsafe };
}
