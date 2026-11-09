// Job 125: factory/config.local.json, a per-developer override of a closed set of keys.
// Unit tests on util.js/check-stamp.js, then the CLI on a temp root with a local bare
// origin and a fake gh (the harness of test/check-reuse.test.js, copied). No network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checksInputs } from '../factory/lib/check-stamp.js';
import { LOCAL_CONFIG, OVERRIDABLE, Refused, effectiveConfig, loadConfig, validateLocal } from '../factory/lib/util.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const configText = readFileSync(join(repo, 'factory/config.json'), 'utf8');

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

// Every run appends a line to $CHECKS_COUNT, so a test can tell whether the checks ran.
const CHECKS = `#!/bin/sh
echo run >> "$CHECKS_COUNT"
echo "checks: ok"
`;

// CommonJS on purpose: the temp folder has no package.json.
const fakeGh = (stateFile) => `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state, null, 2));
const out = (value) => process.stdout.write(JSON.stringify(value));
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const [a, b, n] = args;
const issue = state.issues[n];
const pr = state.prs.find((p) => String(p.number) === n);
if (a === 'issue' && b === 'view') { if (!issue) fail('no such issue'); out(issue); }
else if (a === 'issue' && (b === 'comment' || b === 'edit')) { if (!issue) fail('no such issue'); }
else if (a === 'pr' && b === 'list') {
  out(state.prs.filter((p) => p.headRefName === flag('--head') && p.state === 'OPEN'));
} else if (a === 'pr' && b === 'view') { if (!pr) fail('no such pr'); out(pr); }
else if (a === 'pr' && b === 'merge') { if (!pr) fail('no such pr'); pr.state = 'MERGED'; save(); }
else if (a === 'pr' && (b === 'ready' || b === 'comment')) { if (!pr) fail('no such pr'); }
`;

function runAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A team config like this repo's: language es, max_rounds 3, auto_merge true, providers claude and codex. */
function teamConfig() {
  const cfg = JSON.parse(configText);
  cfg.language = 'es';
  cfg.max_rounds = 3;
  cfg.auto_merge = true;
  cfg.concurrency = 3;
  cfg.default_provider = 'claude';
  return cfg;
}

/** A bare root (no git) with only factory/config.json. */
function plainRoot(team = teamConfig()) {
  const root = mkdtempSync(join(tmpdir(), 'factory-local-'));
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(team));
  return root;
}

const writeLocal = (root, value) => writeFileSync(join(root, LOCAL_CONFIG), typeof value === 'string' ? value : JSON.stringify(value));
const never = () => { throw new Error('tracked must not be called'); };
const untracked = () => false;
const quiet = () => {};

function setup({ team = teamConfig() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-local-cli-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\nfactory/board.json\n.worktrees/\n');
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(team));
  writeFileSync(join(root, 'factory/checks.sh'), CHECKS);
  writeFileSync(join(root, 'app.txt'), 'v1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');

  const stateFile = join(dir, 'gh-state.json');
  const gh = join(dir, 'gh');
  writeFileSync(stateFile, JSON.stringify({ viewer: 'factory-owner', issues: {}, prs: [] }));
  writeFileSync(gh, fakeGh(stateFile));
  chmodSync(gh, 0o755);
  const count = join(dir, 'checks-count');
  writeFileSync(count, '');

  const env = {
    ...process.env, ...GIT_ENV, FACTORY_ROOT: root, FACTORY_GH: gh, FACTORY_TRANSCRIPTS: join(dir, 'transcripts'), CHECKS_COUNT: count,
  };
  delete env.NODE_TEST_CONTEXT;
  const jobsDir = join(root, 'factory/jobs');
  const setState = (fn) => {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    fn(s);
    writeFileSync(stateFile, JSON.stringify(s));
  };
  return {
    dir, root, env,
    bin: (name, args) => runAsync(join(repo, 'factory/bin', name), args, { cwd: root, env }),
    job: (...args) => runAsync(join(repo, 'factory/bin/job'), args, { cwd: root, env }),
    json: (id) => JSON.parse(readFileSync(join(jobsDir, id, 'job.json'), 'utf8')),
    raw: (id) => readFileSync(join(jobsDir, id, 'job.json'), 'utf8'),
    board: () => JSON.parse(readFileSync(join(root, 'factory/board.json'), 'utf8')),
    boardPath: join(root, 'factory/board.json'),
    read: (id, rel) => readFileSync(join(jobsDir, id, rel), 'utf8'),
    write(id, rel, text) {
      const file = join(jobsDir, id, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    local: (value) => writeLocal(root, value),
    runs: () => readFileSync(count, 'utf8').split('\n').filter(Boolean).length,
    issue(n) {
      setState((s) => {
        s.issues[n] = {
          number: n, title: `Issue ${n}`, body: 'Please build it.', state: 'OPEN',
          author: { login: 'alice' }, labels: [{ name: 'factory' }], comments: [],
        };
      });
    },
    pr(number, headRefName) {
      setState((s) => {
        s.prs.push({
          number, headRefName, state: 'OPEN', isCrossRepository: false, headRepositoryOwner: { login: 'bqsistemas' },
          reviews: [], comments: [],
        });
      });
    },
    jobIds: () => (existsSync(jobsDir) ? readdirSync(jobsDir) : []),
  };
}

function ok(res) {
  assert.equal(res.status, 0, `expected success, got ${res.status}: ${res.stdout}${res.stderr}`);
  return res.stdout.trim();
}

/** A job sitting at gate after a failed round-1 gate, built by hand (no gh, no worktree). */
function gateFailedJob(t, id = '007-thing') {
  t.write(id, 'job.json', JSON.stringify({
    id, issue: 7, title: 'thing', branch: `factory/${id}`, port: 3007, stage: 'gate', round: 1, max_rounds: 3,
    provider: 'claude', agents: { builder: 'sonnet', reviewers: { code: 'haiku' } }, gate: 'pending', reviews: {}, history: [],
  }, null, 2));
  t.write(id, 'round-1/checks.md', 'GATE: FAIL\n\nchecks failed\n');
  return id;
}

const INTAKE = `ACCEPT\nRISK: low\nSURFACES: none\nRESCOPED: no\n\n## Scope\nThe toggle only.\n\n## Reason\nClear request.\n`;

// From a new issue to approve with a real gate run (so checks.md records the tested head and inputs).
async function approvedWithRealGate(t) {
  t.issue(7);
  const id = ok(await t.job('new', '7'));
  t.write(id, 'intake.md', INTAKE);
  ok(await t.job(id, 'to', 'spec'));
  t.write(id, 'spec.md', '# Spec\n');
  ok(await t.job(id, 'to', 'build'));
  const { worktree } = t.json(id);
  writeFileSync(join(worktree, 'feature.txt'), 'feature\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'feat: branch work');
  t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
  t.pr(31, `factory/${id}`);
  ok(await t.job(id, 'to', 'gate'));
  ok(await t.bin('gate', [id]));
  ok(await t.job(id, 'to', 'review'));
  for (const lens of Object.keys(t.json(id).reviews)) t.write(id, `round-1/review-${lens}.md`, 'VERDICT: PASS\n');
  ok(await t.job(id, 'to', 'approve'));
  t.write(id, 'decision.md', 'APPROVE\nAll good.\n');
  return id;
}

/** checksInputs as it was before job 125: config.local.json is never part of it. */
function legacyChecksInputs(root) {
  const list = (rel) => {
    try {
      return readdirSync(join(root, rel), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${rel}/${e.name}`).sort();
    } catch {
      return [];
    }
  };
  const hash = createHash('sha256');
  for (const rel of ['factory/checks.sh', 'factory/config.json', ...list('factory/lib'), ...list('factory/bin')]) {
    let bytes;
    try { bytes = readFileSync(join(root, rel)); } catch { bytes = Buffer.alloc(0); }
    hash.update(rel).update('\0').update(bytes).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

const VALID_ALL = { concurrency: 1, default_provider: 'codex', language: 'pt', max_rounds: 2, auto_merge: false };

describe('config.local.json', { concurrency: true }, () => {
  test('AC-1: without a local file the config is the team one, the checks hash is unchanged and git is never asked', () => {
    const team = teamConfig();
    const root = plainRoot(team);
    assert.deepEqual(loadConfig(root, { tracked: never }), team);
    const eff = effectiveConfig(root, { tracked: never });
    assert.deepEqual(eff.config, team);
    assert.deepEqual(eff.overrides, []);
    assert.equal(checksInputs(root), legacyChecksInputs(root));
  });

  test('AC-1: job <id> to <stage> without a local file writes config_overrides: [] to the board', async () => {
    const t = setup();
    const id = gateFailedJob(t);
    assert.equal(ok(await t.job(id, 'to', 'build')), `${id} build`);
    const board = t.board();
    assert.deepEqual(board.config_overrides, []);
    assert.equal(board.language, 'es');
  });

  test('AC-2: every allowed key takes its local value, the rest stays the team value', () => {
    const team = teamConfig();
    const root = plainRoot(team);
    writeLocal(root, VALID_ALL);
    const { config, overrides } = effectiveConfig(root, { tracked: untracked, warn: quiet });
    for (const [key, value] of Object.entries(VALID_ALL)) assert.deepEqual(config[key], value, key);
    for (const key of Object.keys(team).filter((k) => !OVERRIDABLE.includes(k))) assert.deepEqual(config[key], team[key], key);
    assert.deepEqual(overrides, [...Object.keys(VALID_ALL)].sort());
    assert.deepEqual(OVERRIDABLE, ['concurrency', 'default_provider', 'language', 'max_rounds', 'auto_merge', 'spec_review']);
    assert.ok(Object.isFrozen(OVERRIDABLE));
  });

  test('AC-2: the board lists the overridden keys, sorted, and uses the local language', async () => {
    const t = setup();
    const id = gateFailedJob(t);
    t.local(VALID_ALL);
    assert.equal(ok(await t.job(id, 'to', 'build')), `${id} build`);
    const board = t.board();
    assert.deepEqual(board.config_overrides, ['auto_merge', 'concurrency', 'default_provider', 'language', 'max_rounds']);
    assert.equal(board.language, 'pt');
  });

  test('AC-2: a local value equal to the team value still counts as local; an empty object overrides nothing', () => {
    const root = plainRoot();
    writeLocal(root, { concurrency: 3 });
    assert.deepEqual(effectiveConfig(root, { tracked: untracked, warn: quiet }).overrides, ['concurrency']);
    writeLocal(root, {});
    assert.deepEqual(effectiveConfig(root, { tracked: untracked, warn: quiet }).overrides, []);
  });

  for (const [name, local, key] of [
    ['routing', { concurrency: 1, routing: {} }, 'routing'],
    ['protected_tests', { language: 'en', protected_tests: [] }, 'protected_tests'],
    ['__proto__', '{"concurrency":1,"__proto__":{"auto_merge":true}}', '__proto__'],
    ['constructor', { constructor: 1 }, 'constructor'],
    ['toString', { toString: 'x' }, 'toString'],
  ]) {
    test(`AC-3: a key outside the allowlist (${name}) is refused and nothing is applied`, () => {
      const root = plainRoot();
      writeLocal(root, local);
      assert.throws(() => effectiveConfig(root, { tracked: untracked, warn: quiet }), (err) => {
        assert.ok(err instanceof Refused, 'a Refused');
        assert.ok(err.message.startsWith(`config.local.json: ${key}: `), err.message);
        return true;
      });
      const parsed = typeof local === 'string' ? JSON.parse(local) : local;
      assert.throws(() => validateLocal(teamConfig(), parsed), Refused);
    });
  }

  for (const [name, text] of [['invalid JSON', '{ concurrency: 1'], ['an array', '[1]'], ['null', 'null'], ['a string', '"x"']]) {
    test(`AC-3: a local file that is ${name} is refused with a config.local.json: reason`, () => {
      const root = plainRoot();
      writeLocal(root, text);
      assert.throws(() => effectiveConfig(root, { tracked: untracked, warn: quiet }), (err) => {
        assert.ok(err instanceof Refused);
        assert.match(err.message, /^config\.local\.json: \S/);
        return true;
      });
    });
  }

  test('AC-3: job summary and job <id> to <stage> exit 1 with refused: config.local.json:, writing neither board.json nor job.json', async () => {
    const t = setup();
    const id = gateFailedJob(t);
    const before = t.raw(id);
    t.local({ concurrency: 1, routing: {} });
    for (const args of [['summary'], [id, 'to', 'build'], [id, 'prompt'], ['config']]) {
      const res = await t.job(...args);
      assert.equal(res.status, 1, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
      assert.ok(res.stderr.startsWith('refused: config.local.json: routing: '), res.stderr);
      assert.match(res.stderr, /routing: \S+/);
    }
    t.local('{ not json');
    const broken = await t.job('summary');
    assert.equal(broken.status, 1);
    assert.ok(broken.stderr.startsWith('refused: config.local.json: '), broken.stderr);
    assert.equal(t.raw(id), before, 'job.json untouched');
    assert.equal(existsSync(t.boardPath), false, 'board.json never written');
  });

  test('AC-3: validateLocal never returns a partial config', () => {
    const team = teamConfig();
    const local = { concurrency: 1, routing: {} };
    assert.throws(() => validateLocal(team, local), Refused);
    assert.equal(validateLocal(team, { concurrency: 1 }), undefined);
    assert.equal(team.concurrency, 3, 'the team config is not mutated');
  });

  for (const [key, value] of [
    ['max_rounds', 4], ['max_rounds', 2.5], ['max_rounds', 0], ['max_rounds', '2'],
    ['auto_merge', true], ['auto_merge', 'false'], ['auto_merge', 0],
    ['concurrency', 0], ['concurrency', 1.5], ['concurrency', '2'],
    ['language', 'fr'], ['language', 1],
    ['default_provider', 'nope'], ['default_provider', '__proto__'], ['default_provider', 'toString'], ['default_provider', 1],
  ]) {
    test(`AC-4: ${key}: ${JSON.stringify(value)} is refused with config.local.json: ${key}: <reason>`, () => {
      const root = plainRoot();
      writeLocal(root, { [key]: value });
      assert.throws(() => effectiveConfig(root, { tracked: untracked, warn: quiet }), (err) => {
        assert.ok(err instanceof Refused);
        assert.ok(err.message.startsWith(`config.local.json: ${key}: `), err.message);
        assert.ok(err.message.length > `config.local.json: ${key}: `.length, 'has a reason');
        return true;
      });
    });
  }

  test('AC-4: max_rounds may not exceed 3 when the team does not declare it', () => {
    const team = teamConfig();
    delete team.max_rounds;
    assert.throws(() => validateLocal(team, { max_rounds: 4 }), Refused);
    assert.equal(validateLocal(team, { max_rounds: 3 }), undefined);
  });

  test('AC-4: the CLI refuses auto_merge: true with refused: config.local.json: auto_merge:', async () => {
    const t = setup();
    t.local({ auto_merge: true });
    const res = await t.job('summary');
    assert.equal(res.status, 1);
    assert.ok(res.stderr.startsWith('refused: config.local.json: auto_merge: '), res.stderr);
  });

  test('AC-4: max_rounds: 2 and auto_merge: false are accepted, and a later job new stores max_rounds: 2', async () => {
    const t = setup();
    t.local({ max_rounds: 2, auto_merge: false });
    t.issue(9);
    const id = ok(await t.job('new', '9'));
    assert.equal(t.json(id).max_rounds, 2);
    assert.deepEqual(t.board().config_overrides, ['auto_merge', 'max_rounds']);
  });

  test('AC-5: job config prints every top-level key with its origin and effective value', async () => {
    const t = setup();
    t.local({ concurrency: 1 });
    const out = ok(await t.job('config'));
    const lines = out.split('\n');
    const team = teamConfig();
    assert.deepEqual(lines.map((l) => l.split(' ')[0]), Object.keys(team).sort());
    for (const line of lines) {
      const [key, origin, ...rest] = line.split(' ');
      assert.equal(origin, key === 'concurrency' ? 'local' : 'team', line);
      assert.deepEqual(JSON.parse(rest.join(' ')), key === 'concurrency' ? 1 : team[key], line);
    }
    assert.ok(lines.includes('concurrency local 1'));
    assert.ok(lines.includes('language team "es"'));
  });

  test('AC-5: job config <key> prints only that line; an unknown key exits 1', async () => {
    const t = setup();
    t.local({ concurrency: 1 });
    const one = await t.job('config', 'concurrency');
    assert.equal(one.status, 0, one.stderr);
    assert.equal(one.stdout, 'concurrency local 1\n');
    const teamKey = await t.job('config', 'max_rounds');
    assert.equal(teamKey.stdout, 'max_rounds team 3\n');
    const missing = await t.job('config', 'no_such_key');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^refused: /);
    const usage = await t.job('config', 'a', 'b');
    assert.equal(usage.status, 2);
    assert.equal(existsSync(t.boardPath), false, 'job config writes nothing');
  });

  test('AC-6: job <id> prompt prints Language: right after Base branch:, local first, team otherwise', async () => {
    const t = setup();
    const id = gateFailedJob(t);
    const team = ok(await t.job(id, 'prompt')).split('\n');
    assert.equal(team[team.findIndex((l) => l.startsWith('Base branch: ')) + 1], 'Language: es');
    t.local({ language: 'pt' });
    const local = ok(await t.job(id, 'prompt')).split('\n');
    assert.equal(local[local.findIndex((l) => l.startsWith('Base branch: ')) + 1], 'Language: pt');
  });

  test('AC-6: the 8 roles read the language from the prompt Language: line, not from factory/config.json', () => {
    const sentence = 'Write prose in the configured language; keep technical terms and protocol tokens in English.';
    // The language paragraph is generated into every agent (factory/templates/agent-shared.md), not written in the roles.
    const files = readdirSync(join(repo, 'factory/roles')).filter((f) => f.endsWith('.md')).flatMap((f) => [`.claude/agents/eminzo-${f}`, `.codex/agents/eminzo-${f.replace(/\.md$/, '.toml')}`]);
    assert.equal(files.length, 16);
    for (const f of files) {
      const text = readFileSync(join(repo, f), 'utf8');
      assert.ok(text.includes(sentence), `${f} keeps the sentence`);
      assert.match(text, /`Language:` line of your prompt/, `${f} names the prompt line`);
      assert.doesNotMatch(text, /Read `language` from `factory\/config\.json`/, `${f} no longer reads config.json for it`);
    }
  });

  test('AC-7: creating, changing or deleting config.local.json changes the checks inputs', () => {
    const root = plainRoot();
    const none = checksInputs(root);
    writeLocal(root, { concurrency: 1 });
    const one = checksInputs(root);
    assert.notEqual(one, none);
    writeLocal(root, { concurrency: 2 });
    const two = checksInputs(root);
    assert.notEqual(two, one);
    rmSync(join(root, LOCAL_CONFIG));
    assert.equal(checksInputs(root), none, 'back to the hash without the file');
  });

  test('AC-7: a local file written after the round gate makes the merge run the gate again', async () => {
    const t = setup();
    const id = await approvedWithRealGate(t);
    assert.ok(t.json(id).gated?.inputs, 'the round gate recorded its inputs');
    t.local({ concurrency: 1 });
    const before = t.runs();
    assert.equal(ok(await t.job(id, 'to', 'merging')), `${id} merged`);
    assert.equal(t.runs(), before + 1, 'the checks ran again');
    assert.doesNotMatch(t.read(id, 'merge-checks.md'), /Reused/);
  });

  test('AC-8: a tracked config.local.json is ignored with a warning, even when it is invalid', async () => {
    const t = setup();
    const id = gateFailedJob(t);
    t.local({ routing: {}, auto_merge: true });
    git(t.root, 'add', '-f', LOCAL_CONFIG);
    const res = await t.job(id, 'to', 'build');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /factory\/config\.local\.json/);
    assert.deepEqual(t.board().config_overrides, []);
    const cfg = ok(await t.job('config', 'auto_merge'));
    assert.equal(cfg, 'auto_merge team true');
    const eff = effectiveConfig(t.root, { warn: quiet });
    assert.deepEqual(eff.config, teamConfig());
    assert.deepEqual(eff.overrides, []);
  });

  test('AC-8: the warning goes through warn and names the file; git failing counts as untracked', () => {
    const root = plainRoot();
    writeLocal(root, { concurrency: 1 });
    const warnings = [];
    const eff = effectiveConfig(root, { tracked: () => true, warn: (text) => warnings.push(text) });
    assert.deepEqual(eff.overrides, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /factory\/config\.local\.json/);
    // A root outside git: the default tracked check fails and the file is validated as usual.
    assert.deepEqual(effectiveConfig(root, { warn: quiet }).overrides, ['concurrency']);
  });

  test('AC-9: this repo ignores factory/config.local.json', () => {
    const lines = readFileSync(join(repo, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.equal(lines.filter((l) => l.trim().replace(/^\//, '') === 'factory/config.local.json').length, 1);
  });

  test('AC-10: both orchestrator skills read concurrency with job config and show Language: in the prompt block', () => {
    for (const rel of ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md']) {
      const text = readFileSync(join(repo, rel), 'utf8');
      assert.match(text, /`factory\/bin\/job config concurrency`/, `${rel} concurrency`);
      assert.match(text, /^\s*Base branch: <branch of config\.base>\n\s*Language: <effective language>$/m, `${rel} Language: line`);
      assert.match(text, /factory\/config\.local\.json/, `${rel} names the local file`);
    }
  });
});
