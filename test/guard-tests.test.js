// factory/bin/guard-tests: the builder's PreToolUse Bash hook. The full suite runs only in the gate, so a Bash
// command that runs factory/checks.sh, the nudge or a full-suite command is refused (exit 2 + reason on stderr).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const hook = join(repo, 'factory/bin/guard-tests');
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const CHECKS = `#!/bin/sh
# the repo's checks
set -e
expected='node --test test/*.test.js'
actual=$(node -p "require('./package.json').scripts.test")
if [ "$actual" != "$expected" ]; then
  echo "bad: $actual" >&2
  exit 1
fi
echo "running"
npm test
pytest -q
`;

function setup({ checks = CHECKS, config = { base: 'origin/main', checks: { suite_commands: ['node --test test/*.test.js', 'node --test', 7, null] } } } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-guard-')));
  const root = join(dir, 'root');
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  if (checks !== null) writeFileSync(join(root, 'factory/checks.sh'), checks);
  if (config !== null) writeFileSync(join(root, 'factory/config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  writeFileSync(join(root, 'README.md'), 'x\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const worktree = join(root, '.worktrees', '001-wt');
  git(root, 'worktree', 'add', '-q', worktree, '-b', 'factory/001-wt', 'HEAD');
  const raw = (input, cwd = worktree) => spawnSync('sh', [hook], { cwd, input, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, FACTORY_ROOT: undefined } });
  const call = (command, extra = {}) => raw(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: worktree, ...extra }));
  return { root, worktree, raw, call };
}

const DENIED = [
  'factory/checks.sh',
  './factory/checks.sh',
  '/abs/path/to/factory/checks.sh',
  'sh factory/checks.sh',
  'bash -x ./factory/checks.sh',
  'cd /x && sh factory/checks.sh 2>&1 | tail -20',
  'factory/bin/nudge 001-wt',
  './factory/bin/nudge',
  'eminzo nudge 001-wt --full',
  'FOO=1 eminzo nudge',
  'npm test',
  'npm test 2>&1 | tail -5',
  'npm test --silent',
  'timeout 600 npm test',
  'CI=1 npm test > /tmp/out.log 2>&1',
  'node --test test/*.test.js',
  'node --test test/*.test.js 2>&1 | rg x',
  'node --test',
  'node --test --test-reporter=spec',
  'cd sub; pytest -q',
  'git status\nnpm test',
  'echo hi && npm test || true',
  'bash -c "npm test"',
];
const ALLOWED = [
  'node --test test/handoff.test.js',
  'node --test test/a.test.js test/b.test.js',
  'npm test -- test/foo.test.js',
  'pytest -q tests/test_one.py',
  'git status',
  'cd /tmp && ls',
  'cd factory && cd ..',
  'rg checks.sh docs',
  'echo "do not run factory/checks.sh"',
  'echo running',
  'cat factory/checks.sh',
  'npm run build',
  '',
];

test('AC-1: the hook denies every full-suite, checks.sh and nudge command with the reason on stderr', () => {
  const t = setup();
  for (const command of DENIED) {
    const r = t.call(command);
    assert.equal(r.status, 2, `denied: ${JSON.stringify(command)} (stderr: ${r.stderr})`);
    assert.match(r.stderr, /full suite runs only in the gate/);
    assert.match(r.stderr, /test files you wrote or changed/);
  }
});

test('AC-2: the deny message names the matched command', () => {
  const t = setup();
  assert.match(t.call('node --test test/*.test.js 2>&1 | rg x').stderr, /node --test test\/\*\.test\.js/);
  assert.match(t.call('npm test').stderr, /npm test/);
  assert.match(t.call('sh factory/checks.sh').stderr, /factory\/checks\.sh/);
  assert.match(t.call('eminzo nudge 1').stderr, /nudge/);
});

test('AC-3: targeted runs and unrelated commands are allowed silently', () => {
  const t = setup();
  for (const command of ALLOWED) {
    const r = t.call(command);
    assert.equal(r.status, 0, `allowed: ${JSON.stringify(command)} (stderr: ${r.stderr})`);
    assert.equal(r.stderr, '', command);
  }
});

test('AC-3: a suite command followed by a non-flag token is targeted, and flags alone are still the suite', () => {
  const t = setup();
  assert.equal(t.call('node --test test/*.test.js extra.js').status, 0);
  assert.equal(t.call('node --test test/*.test.js --x').status, 2);
});

test('AC-4: the config list comes from checks.suite_commands and checks.sh only lists its plain commands', () => {
  const t = setup({ checks: '#!/bin/sh\nmake check\n', config: { checks: { suite_commands: ['go test ./...'] } } });
  assert.equal(t.call('go test ./...').status, 2);
  assert.equal(t.call('go test ./pkg/one').status, 0);
  assert.equal(t.call('make check').status, 2);
  assert.equal(t.call('make build').status, 0);
  const plain = setup({ checks: CHECKS });
  assert.equal(plain.call('echo running').status, 0, 'echo is never a suite command');
  assert.equal(plain.call('set -e').status, 0);
  assert.equal(plain.call('exit 1').status, 0);
});

test('AC-5: the hook only looks at Bash commands', () => {
  const t = setup();
  assert.equal(t.raw(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'x', command: 'npm test' }, cwd: t.worktree })).status, 0);
  assert.equal(t.raw(JSON.stringify({ tool_name: 'Bash', tool_input: {}, cwd: t.worktree })).status, 0);
});

test('AC-6: it fails open with a note when it cannot decide', () => {
  const t = setup();
  const bad = t.raw('not json');
  assert.equal(bad.status, 0);
  assert.match(bad.stderr, /^guard-tests: not enforced: .+/m);

  const noChecks = setup({ checks: null, config: { checks: { suite_commands: ['go test ./...'] } } });
  assert.equal(noChecks.call('go test ./...').status, 2, 'the config list still applies without checks.sh');
  assert.equal(noChecks.call('npm test').status, 0);
  assert.match(noChecks.call('npm test').stderr, /guard-tests: not enforced: .*checks\.sh/);

  const noConfig = setup({ config: null });
  const r = noConfig.call('npm test');
  assert.equal(r.status, 2, 'checks.sh alone still guards');
  assert.match(noConfig.call('git status').stderr, /guard-tests: not enforced: .*config/);

  const badConfig = setup({ config: '{nope' });
  assert.equal(badConfig.call('git status').status, 0);
  assert.match(badConfig.call('git status').stderr, /guard-tests: not enforced: .*config/);

  const outside = mkdtempSync(join(tmpdir(), 'factory-guard-out-'));
  const away = t.call('npm test', { cwd: outside });
  assert.equal(away.status, 0);
  assert.match(away.stderr, /guard-tests: not enforced/);
});

test('AC-7: checks.sh and nudge are still denied when the config has no suite_commands, and a non-array list is ignored', () => {
  const t = setup({ config: { checks: { suite_commands: 'npm test' } } });
  assert.equal(t.call('factory/bin/nudge 1').status, 2);
  assert.equal(t.call('npm test').status, 2, 'checks.sh lists npm test');
});

test('AC-8: the generated Claude builder agent has the PreToolUse Bash hook; the other roles do not', () => {
  const builder = readFileSync(join(repo, '.claude/agents/eminzo-builder.md'), 'utf8');
  assert.match(builder, /PreToolUse:[\s\S]*- matcher: Bash\n {6}hooks:\n {8}- type: command\n {10}command: '"\$CLAUDE_PROJECT_DIR"\/factory\/bin\/guard-tests'/);
  for (const role of ['intake', 'spec-writer', 'review-code', 'review-security', 'review-ui', 'review-ux', 'approver']) {
    assert.doesNotMatch(readFileSync(join(repo, `.claude/agents/eminzo-${role}.md`), 'utf8'), /guard-tests/, role);
  }
  const codex = readFileSync(join(repo, '.codex/agents/eminzo-builder.toml'), 'utf8');
  assert.doesNotMatch(codex, /guard-tests/);
});

test('AC-9: this repo declares its full-suite commands in factory/config.json', () => {
  const config = JSON.parse(readFileSync(join(repo, 'factory/config.json'), 'utf8'));
  assert.deepEqual(config.checks.suite_commands, ['node --test test/*.test.js', 'node --test']);
  const template = JSON.parse(readFileSync(join(repo, 'factory/templates/config.json'), 'utf8'));
  assert.ok(!('suite_commands' in (template.checks ?? {})) || Array.isArray(template.checks.suite_commands));
});
