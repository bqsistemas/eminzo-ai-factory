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
set -e
npm run lint
npm run typecheck
go vet ./...
npm test
`;
const LIST = ['node --test test/*.test.js', 'node --test', 'npm test', 'go test ./...', 'mvn -B -q test', './gradlew test', 'pytest -q', 7, null];

function setup({ checks = CHECKS, config = { base: 'origin/main', checks: { suite_commands: LIST } } } = {}) {
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
  'factory/checks.sh', './factory/checks.sh', '/abs/path/to/factory/checks.sh', 'sh factory/checks.sh', 'bash -x ./factory/checks.sh',
  'cd /x && sh factory/checks.sh 2>&1 | tail -20',
  'factory/bin/nudge 001-wt', './factory/bin/nudge', 'eminzo nudge 001-wt --full', 'FOO=1 eminzo nudge',
  'npm test', 'npm test 2>&1 | tail -5', 'npm test --silent', 'npm test -- --coverage', 'timeout 600 npm test',
  'CI=1 npm test > /tmp/out.log 2>&1',
  'node --test test/*.test.js', 'node --test test/*.test.js 2>&1 | rg x', 'node --test', 'node --test --test-reporter=spec',
  'go test -race ./...', 'go test ./... -count=1', 'mvn -B -q test -X', './gradlew test --info', 'pytest -q -x',
  'git status\nnpm test', 'echo hi && npm test || true',
  // cheap wrappers
  'time npm test', 'nohup npm test', 'command npm test', 'exec npm test', 'env npm test', 'env CI=1 FOO=2 npm test', 'env -i npm test', 'env -u HOME npm test',
  'time nohup env A=1 npm test', 'npm test &', 'npm test&', 'time -p npm test',
  // shell -c
  'bash -c "npm test"', 'bash -lc "npm test"', 'sh -ec "npm test"', 'zsh -c "cd x && npm test"', 'bash -lc "factory/checks.sh"', "sh -c 'time env A=1 npm test'",
];
const ALLOWED = [
  'node --test test/handoff.test.js', 'node --test test/a.test.js test/b.test.js', 'npm test -- test/foo.test.js', 'npm test -- src/a.test.js',
  'mvn -B -q test -Dtest=UserTest', './gradlew test --tests UserTest', './gradlew test --tests=UserTest', 'pytest -q tests/test_one.py', 'pytest -q -k login',
  'go test -run TestX ./...', 'go test ./pkg/one', 'npm test -- -t "name"', 'npm test -- --testNamePattern=x', 'npm test -- --grep foo', 'npm test -- -g foo',
  'time npm test -- src/a.test.js', 'env CI=1 npm test -- src/a.test.js', 'bash -lc "npm test -- src/a.test.js"',
  'git status', 'cd /tmp && ls', 'cd factory && cd ..', 'rg checks.sh docs', 'echo "do not run factory/checks.sh"', 'echo running', 'echo npm test', 'cat factory/checks.sh',
  'npm run build', 'npm run lint', 'npm run typecheck', 'go vet ./...', 'eslint src/a.js', 'git commit -m "npm test"', '',
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
  assert.match(t.call('time env A=1 go test -race ./...').stderr, /go test \.\/\.\.\./);
  assert.match(t.call('sh factory/checks.sh').stderr, /factory\/checks\.sh/);
  assert.match(t.call('eminzo nudge 1').stderr, /nudge/);
});

test('AC-3: targeted runs (a non-option argument or a test-selection option) and unrelated commands are allowed silently', () => {
  const t = setup();
  for (const command of ALLOWED) {
    const r = t.call(command);
    assert.equal(r.status, 0, `allowed: ${JSON.stringify(command)} (stderr: ${r.stderr})`);
    assert.equal(r.stderr, '', command);
  }
});

test('AC-4: only checks.suite_commands lists suite commands: nothing is derived from checks.sh, and no list means only checks.sh and the nudge', () => {
  const t = setup({ checks: CHECKS, config: { checks: { suite_commands: ['go test ./...'] } } });
  assert.equal(t.call('go test ./...').status, 2);
  assert.equal(t.call('npm test').status, 0, 'a plain line of checks.sh is not a suite command');
  assert.equal(t.call('npm run lint').status, 0);
  assert.equal(t.call('go vet ./...').status, 0);

  for (const config of [{ base: 'origin/main' }, { checks: {} }, { checks: { suite_commands: 'npm test' } }, { checks: { suite_commands: [] } }]) {
    const u = setup({ config });
    const quiet = u.call('npm test');
    assert.equal(quiet.status, 0, JSON.stringify(config));
    assert.equal(quiet.stderr, '', 'a missing list is not noise');
    assert.equal(u.call('factory/checks.sh').status, 2);
    assert.equal(u.call('eminzo nudge x').status, 2);
  }
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

  const noConfig = setup({ config: null });
  assert.equal(noConfig.call('npm test').status, 0);
  assert.equal(noConfig.call('npm test').stderr, '');
  assert.equal(noConfig.call('factory/checks.sh').status, 2, 'checks.sh and the nudge are denied without a config');

  const badConfig = setup({ config: '{nope' });
  const r = badConfig.call('git status');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /guard-tests: not enforced: .*config/);
  assert.equal(badConfig.call('factory/checks.sh').status, 2);

  const outside = mkdtempSync(join(tmpdir(), 'factory-guard-out-'));
  const away = t.call('npm test', { cwd: outside });
  assert.equal(away.status, 0);
  assert.match(away.stderr, /guard-tests: not enforced/);
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
  assert.deepEqual(config.checks.suite_commands, ['node --test test/*.test.js', 'node --test', 'npm test']);
  const template = JSON.parse(readFileSync(join(repo, 'factory/templates/config.json'), 'utf8'));
  assert.ok(!('suite_commands' in (template.checks ?? {})) || Array.isArray(template.checks.suite_commands));
});

test('AC-10: the builder runs checks only on what it touched; reviewers and the approver rely on the gate and never rerun the full checks', () => {
  const role = (name) => readFileSync(join(repo, `factory/roles/${name}.md`), 'utf8');
  const builder = role('builder');
  assert.match(builder, /lint and type checks only on the files you touched/);
  assert.match(builder, /Never run `factory\/checks\.sh`, the nudge or the repo's whole test suite/);
  for (const name of ['review-code', 'review-security', 'review-ui', 'review-ux', 'approver']) {
    const text = role(name);
    assert.match(text, /gate (already )?ran the full checks/i, name);
    assert.match(text, /never run `factory\/checks\.sh`, the nudge or the whole (test )?suite/i, name);
  }
  assert.match(role('review-code'), /only targeted tests/i);
  for (const name of ['intake', 'spec-writer']) assert.doesNotMatch(role(name), /checks\.sh|nudge|test suite/, name);
});
