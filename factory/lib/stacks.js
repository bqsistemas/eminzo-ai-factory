// The one place that knows the stacks: which manifest means which stack, the commands and
// `selfcheck.ac_pattern` default of each, and the checks.sh script of each (the templates in
// factory/templates/checks/<stack>.sh). `factory/lib/init.js` (setup) and `eminzo enable`
// (cli/src/installer/checks.js) both use it. Reads only the template files; no network.
import { readFileSync } from 'node:fs';

import { DEFAULT_AC_PATTERN } from './selfcheck.js';

const template = (name) => readFileSync(new URL(`../templates/${name}`, import.meta.url), 'utf8');

export { DEFAULT_AC_PATTERN };
/** Per stack: its manifests (first match of ORDER wins) and the `selfcheck.ac_pattern` that finds an AC in its tests. */
const STACKS = {
  node: { manifests: ['package.json'], acPattern: DEFAULT_AC_PATTERN },
  go: { manifests: ['go.mod'], acPattern: DEFAULT_AC_PATTERN },
  rust: { manifests: ['Cargo.toml'], acPattern: DEFAULT_AC_PATTERN },
  // `def test_ac_1` and `AC-1` in a docstring both name AC-1 (the match is case-insensitive).
  python: { manifests: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile', 'pytest.ini', 'tox.ini', 'conftest.py'], acPattern: '(?:AC-|test_ac_)\\d+' },
  ruby: { manifests: ['Gemfile'], acPattern: DEFAULT_AC_PATTERN },
  maven: { manifests: ['pom.xml'], acPattern: DEFAULT_AC_PATTERN },
  gradle: { manifests: ['build.gradle', 'build.gradle.kts', 'gradlew'], acPattern: DEFAULT_AC_PATTERN },
};
const ORDER = Object.keys(STACKS);
const NO_TEST_PLACEHOLDER = /no test specified/i;
const NONE = 'none';

/** @typedef {{ files: string[], packageJson: object | null, read: (file: string) => string }} Repo `files` are the repo root entries. */

const has = (files, name) => files.includes(name);

/** The stacks whose manifest is in `files`, in precedence order. */
export const stacksIn = (files) => ORDER.filter((s) => STACKS[s].manifests.some((m) => has(files, m)));

export const acPattern = (stack) => STACKS[stack]?.acPattern ?? DEFAULT_AC_PATTERN;

const nodeTest = (packageJson) => {
  const test = packageJson?.scripts?.test;
  return typeof test === 'string' && test.trim() && !NO_TEST_PLACEHOLDER.test(test) ? test : null;
};

function pythonHasTests({ files, read }) {
  if (['pytest.ini', 'tox.ini', 'conftest.py'].some((f) => has(files, f))) return true;
  return ['pyproject.toml', 'setup.cfg', 'requirements.txt', 'requirements-dev.txt'].some((f) => has(files, f) && /pytest/i.test(read(f) ?? ''));
}

/** Whether the repo shows a way to run tests for `stack`: a placeholder `npm test` or a pyproject without pytest does not count. */
function testable(stack, repo) {
  if (stack === 'node') return nodeTest(repo.packageJson) !== null;
  if (stack === 'python') return pythonHasTests(repo);
  if (stack === 'ruby') return has(repo.files, 'spec') || has(repo.files, 'test');
  return true;
}

/** The stack the checks.sh is written for: the first with tests, or 'none'. */
export const detectStack = (repo) => ORDER.find((s) => stacksIn(repo.files).includes(s) && testable(s, repo)) ?? NONE;

export const packageManager = (files) => (['bun.lock', 'bun.lockb'].some((f) => has(files, f)) ? 'bun' : has(files, 'pnpm-lock.yaml') ? 'pnpm' : has(files, 'yarn.lock') ? 'yarn' : 'npm');

/** How the package manager runs the package.json script `name` (`bun test` would be bun's own runner, not the script). */
export function scriptCommand(pm, name) {
  if (pm === 'yarn') return `yarn ${name}`;
  if (pm === 'bun') return `bun run ${name}`;
  return name === 'start' || name === 'test' ? `${pm} ${name}` : `${pm} run ${name}`;
}

/** The monorepo tool of a node repo: Nx wins over Turborepo; null for neither. */
export const monorepoOf = (repo) => (has(repo.files, 'nx.json') ? 'nx' : has(repo.files, 'turbo.json') ? 'turbo' : null);

/** How the package manager runs a binary the repo already installed (never one that has to be downloaded: no `bunx`, no `npx` without `--no-install`). */
export function execCommand(pm, bin) {
  if (pm === 'pnpm') return `pnpm exec ${bin}`;
  if (pm === 'yarn') return `yarn ${bin}`;
  if (pm === 'bun') return `bun run ${bin}`;
  return `npx --no-install ${bin}`;
}

const TARGETS = ['lint', 'typecheck', 'test'];

/** Which of lint, typecheck and test the monorepo tool can run: Turborepo's tasks (v2) or pipeline (v1), Nx's root package.json scripts. */
function monorepoTargets(tool, { packageJson, read }) {
  const scripts = packageJson?.scripts ?? {};
  const fromScripts = () => TARGETS.filter((n) => Object.hasOwn(scripts, n));
  if (tool !== 'turbo') return fromScripts();
  let tasks;
  try {
    const json = JSON.parse(read('turbo.json'));
    tasks = json?.tasks ?? json?.pipeline;
  } catch {
    return fromScripts(); // turbo.json with comments is not plain JSON
  }
  return tasks && typeof tasks === 'object' ? TARGETS.filter((n) => Object.hasOwn(tasks, n)) : fromScripts();
}

/** The full-run test commands of the stacks whose command does not depend on the repo's files; checks.sh and project.md both use them. */
const TEST_COMMANDS = {
  go: ['go test ./...'],
  rust: ['cargo test'],
  python: ['python -m pytest'],
  maven: ['mvn -B -q test'],
  ruby: ['bundle exec rspec', 'bundle exec rake test'],
};

/** The affected-only script for an Nx or Turborepo workspace and the command its full run uses, or null when it has no `test` target (today's node script then). */
function affectedScript(tool, repo) {
  const targets = monorepoTargets(tool, repo);
  if (!targets.includes('test')) return null;
  const list = targets.join(' ');
  const exec = execCommand(packageManager(repo.files), tool === 'nx' ? 'nx' : 'turbo');
  const text = template('checks/node-affected.sh');
  const fill = tool === 'nx'
    ? { WORKSPACE: 'Nx workspace: only the projects a job changed and the projects that depend on them.', UNIT: 'project', ALL: `${exec} run-many -t ${list}`, SINCE: `${exec} affected -t ${list} --base="$BASE"`, RANGE: `${exec} affected -t ${list} --base="$BASE" --head="$HEAD"` }
    : { WORKSPACE: 'Turborepo workspace: only the packages a job changed and the packages that depend on them.', UNIT: 'package', ALL: `${exec} run ${list}`, SINCE: `${exec} run ${list} --filter="...[$BASE]"`, RANGE: `${exec} run ${list} --filter="...[$BASE...$HEAD]"` };
  return { script: text.replace(/@(WORKSPACE|UNIT|ALL|SINCE|RANGE)@/g, (_, key) => fill[key]), all: fill.ALL };
}

/**
 * The command that installs the dependencies in a fresh checkout, from the lockfile (node only, the
 * same precedence as `packageManager`), or null: the other stacks resolve from caches every worktree shares.
 * `files` are the repo root entries.
 */
export function prepareCommand(files) {
  if (!has(files, 'package.json')) return null;
  const pm = packageManager(files);
  if (pm === 'bun') return 'bun install --frozen-lockfile';
  if (pm === 'pnpm') return 'pnpm install --frozen-lockfile --prefer-offline';
  if (pm === 'yarn') return has(files, '.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile --prefer-offline';
  return has(files, 'package-lock.json') || has(files, 'npm-shrinkwrap.json') ? 'npm ci --prefer-offline --no-audit --no-fund' : 'npm install --no-audit --no-fund';
}

/** A Markdown code span that tolerates backticks inside. */
export const span = (text) => (text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``);

const gradleCommand = (files) => (has(files, 'gradlew') ? './gradlew' : 'gradle');

/** The Run, Test and Build commands for project.md; a string, with no placeholder. Node uses the package.json scripts that exist. */
export function commands(stack, { files, packageJson }) {
  const none = (what) => `none detected (no standard ${what} command for this stack)`;
  if (stack === 'node') {
    const scripts = packageJson?.scripts ?? {};
    const pm = packageManager(files);
    const cmd = (name) => (Object.hasOwn(scripts, name) ? span(scriptCommand(pm, name)) : `none (no \`${name}\` script in package.json)`);
    return { run: cmd('start'), test: cmd('test'), build: cmd('build') };
  }
  const table = {
    go: ['go run .', TEST_COMMANDS.go[0], 'go build ./...'],
    rust: ['cargo run', TEST_COMMANDS.rust[0], 'cargo build'],
    python: [null, TEST_COMMANDS.python[0], 'python -m build'],
    ruby: [null, has(files, 'spec') ? (has(files, 'test') ? TEST_COMMANDS.ruby.join(' && ') : TEST_COMMANDS.ruby[0]) : TEST_COMMANDS.ruby[1], null],
    maven: [null, TEST_COMMANDS.maven[0], 'mvn -B -q package'],
    gradle: [`${gradleCommand(files)} run`, `${gradleCommand(files)} test`, `${gradleCommand(files)} build`],
  }[stack];
  if (!table) return { run: none('run'), test: none('test'), build: none('build') };
  const [run, test, build] = table.map((c, i) => (c ? `\`${c}\`` : none(['run', 'test', 'build'][i])));
  return { run, test, build };
}

/** Test scripts a focused run can narrow without dropping flags or config: plain `jest` only. Anything else runs in full. */
const JEST_ONLY = /^(?:npx\s+(?:--no-install\s+)?)?jest$/;

/** The node template with this repo's scripts filled in. A line that has no value is removed. */
function nodeScript(text, { files, packageJson }) {
  const pm = packageManager(files);
  const scripts = packageJson?.scripts ?? {};
  const narrow = JEST_ONLY.test((nodeTest(packageJson) ?? '').trim());
  const fixed = text
    .replace('@STATIC@\n', ['lint', 'typecheck'].filter((n) => Object.hasOwn(scripts, n)).map((n) => `${scriptCommand(pm, n)}\n`).join(''))
    .replace('@TEST@', scriptCommand(pm, 'test'));
  return narrow ? fixed : fixed.replace(/# focused:begin\n[\s\S]*?# focused:end\n\n?/, '');
}

/**
 * The factory/checks.sh for the stack the repo shows. `none` is factory/templates/checks.sh.
 * @param {Repo} repo
 * `suite` lists the full-run test commands the script runs (the guard-tests hook refuses them for the builder),
 * from the same source as the script itself; it is empty for `none`.
 * @returns {{ stack: string, script: string, suite: string[] }}
 */
export function checksFor(repo) {
  const stack = detectStack(repo);
  if (stack === NONE) return { stack, script: template('checks.sh'), suite: [] };
  const tool = stack === 'node' ? monorepoOf(repo) : null;
  const affected = tool ? affectedScript(tool, repo) : null;
  if (affected) return { stack, script: affected.script, suite: [affected.all] };
  const text = template(`checks/${stack}.sh`);
  const script = stack === 'node' ? nodeScript(text, repo) : stack === 'gradle' && !has(repo.files, 'gradlew') ? text.replace(/^(?!#).*$/gm, (line) => line.replaceAll('./gradlew', 'gradle')) : text;
  const suite = stack === 'node' ? [scriptCommand(packageManager(repo.files), 'test')] : stack === 'gradle' ? [`${gradleCommand(repo.files)} test`] : TEST_COMMANDS[stack] ?? [];
  return { stack, script, suite };
}
