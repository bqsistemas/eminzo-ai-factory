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
    go: ['go run .', 'go test ./...', 'go build ./...'],
    rust: ['cargo run', 'cargo test', 'cargo build'],
    python: [null, 'python -m pytest', 'python -m build'],
    ruby: [null, has(files, 'spec') ? (has(files, 'test') ? 'bundle exec rspec && bundle exec rake test' : 'bundle exec rspec') : 'bundle exec rake test', null],
    maven: [null, 'mvn -B -q test', 'mvn -B -q package'],
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
 * @returns {{ stack: string, script: string }}
 */
export function checksFor(repo) {
  const stack = detectStack(repo);
  if (stack === NONE) return { stack, script: template('checks.sh') };
  const text = template(`checks/${stack}.sh`);
  const script = stack === 'node' ? nodeScript(text, repo) : stack === 'gradle' && !has(repo.files, 'gradlew') ? text.replace(/^(?!#).*$/gm, (line) => line.replaceAll('./gradlew', 'gradle')) : text;
  return { stack, script };
}
