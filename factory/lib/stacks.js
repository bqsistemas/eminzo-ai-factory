// The one place that knows the stacks: which manifest means which stack, the commands and
// `selfcheck.ac_pattern` default of each, and the checks.sh script of each (the templates in
// factory/templates/checks/<stack>.sh). `factory/lib/init.js` (setup) and `eminzo enable`
// (cli/src/installer/checks.js) both use it. Reads only the template files; no network.
import { readFileSync } from 'node:fs';

const template = (name) => readFileSync(new URL(`../templates/${name}`, import.meta.url), 'utf8');

export const DEFAULT_AC_PATTERN = 'AC-\\d+';
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
  if (stack === 'gradle') return has(repo.files, 'gradlew');
  return true;
}

/** The stack the checks.sh is written for: the first with tests, or 'none'. */
export const detectStack = (repo) => ORDER.find((s) => stacksIn(repo.files).includes(s) && testable(s, repo)) ?? NONE;

const packageManager = (files) => (has(files, 'pnpm-lock.yaml') ? 'pnpm' : has(files, 'yarn.lock') ? 'yarn' : 'npm');

/** The Run, Test and Build commands for project.md; a string, with no placeholder. Node uses the package.json scripts that exist. */
export function commands(stack, { files, packageJson }) {
  const none = (what) => `none detected (no standard ${what} command for this stack)`;
  if (stack === 'node') {
    const scripts = packageJson?.scripts ?? {};
    const cmd = (name) => (Object.hasOwn(scripts, name) ? `\`npm ${name === 'start' || name === 'test' ? name : `run ${name}`}\`` : `none (no \`${name}\` script in package.json)`);
    return { run: cmd('start'), test: cmd('test'), build: cmd('build') };
  }
  const table = {
    go: ['go run .', 'go test ./...', 'go build ./...'],
    rust: ['cargo run', 'cargo test', 'cargo build'],
    python: [null, 'python -m pytest', 'python -m build'],
    ruby: [null, has(files, 'spec') ? 'bundle exec rspec' : 'bundle exec rake test', null],
    maven: [null, 'mvn -B -q test', 'mvn -B -q package'],
    gradle: ['./gradlew run', './gradlew test', './gradlew build'],
  }[stack];
  if (!table) return { run: none('run'), test: none('test'), build: none('build') };
  const [run, test, build] = table.map((c, i) => (c ? `\`${c}\`` : none(['run', 'test', 'build'][i])));
  return { run, test, build };
}

/** The node template with this repo's scripts filled in. A line that has no value is removed. */
function nodeScript(text, { files, packageJson }) {
  const pm = packageManager(files);
  const scripts = packageJson?.scripts ?? {};
  const related = /\bvitest\b/.test(nodeTest(packageJson) ?? '') ? 'npx --no-install vitest related --run'
    : /\bjest\b/.test(nodeTest(packageJson) ?? '') ? 'npx --no-install jest --findRelatedTests' : null;
  const fixed = text
    .replace('@STATIC@\n', ['lint', 'typecheck'].filter((n) => Object.hasOwn(scripts, n)).map((n) => `${pm} run ${n}\n`).join(''))
    .replace('@TEST@', `${pm} test`)
    .replace('@RELATED@', related ?? '');
  return related ? fixed : fixed.replace(/# focused:begin\n[\s\S]*?# focused:end\n\n?/, '');
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
  return { stack, script: stack === 'node' ? nodeScript(text, repo) : text };
}
