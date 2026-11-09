// Job 012: the factory v2 files (agents, config, skill, checks) stay wired up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENTS } from '../factory/activity.js';
import { AVATARS } from '../factory/avatars.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(repo, rel), 'utf8');
const frontmatter = (text) => text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
const field = (front, name) => front.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1].trim();

test('AC-8: eight agents; intake runs on fable without Bash, Edit or WebFetch; builder declares the nudge hook', () => {
  const dir = join(repo, '.claude/agents');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 8, 'eight agent files');

  const intake = frontmatter(read('.claude/agents/eminzo-intake.md'));
  assert.equal(field(intake, 'name'), 'eminzo-intake');
  assert.equal(field(intake, 'model'), 'fable');
  const tools = field(intake, 'tools').split(',').map((s) => s.trim());
  for (const banned of ['Bash', 'Edit', 'WebFetch']) assert.ok(!tools.includes(banned), `intake has no ${banned}`);

  const builder = frontmatter(read('.claude/agents/eminzo-builder.md'));
  assert.match(builder, /factory\/bin\/nudge/, 'builder frontmatter references factory/bin/nudge');
  assert.match(builder, /^hooks:/m, 'builder frontmatter declares hooks');

  assert.equal(Object.keys(AVATARS).length, 8);
  assert.equal(Object.keys(AGENTS).length, 8);
  assert.equal(new Set(Object.values(AVATARS).map((a) => a.color)).size, 8, 'distinct avatar colours');
  assert.equal(new Set(Object.values(AGENTS).map((a) => a.label)).size, 8, 'distinct agent labels');
  assert.equal(AGENTS.intake.label, 'Intake');
});

test('AC-8: config.json runs 3 jobs at a time and protects the spine tests; prices cover every alias', () => {
  const config = JSON.parse(read('factory/config.json'));
  assert.equal(config.concurrency, 3);
  assert.equal(config.max_rounds, 3);
  assert.equal(config.base, 'origin/main');
  assert.match(config.repo, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  for (const file of ['test/route.test.js', 'test/job.test.js', 'test/gate.test.js', 'test/cost.test.js']) {
    assert.ok(config.protected_tests.includes(file), `${file} is protected`);
    assert.ok(existsSync(join(repo, file)), `${file} exists`);
  }
  for (const alias of ['fable', 'opus', 'sonnet', 'haiku']) {
    const price = config.prices[alias];
    assert.ok(price, `price for ${alias}`);
    for (const k of ['input', 'output', 'cache_write', 'cache_read']) {
      assert.ok(Number.isFinite(price[k]) && price[k] >= 0, `${alias}.${k} is a non-negative number`);
    }
  }
  assert.equal(config.models.intake, 'fable');
});

test('AC-8: checks.sh and every factory/bin script are executable; checks.sh runs npm test', () => {
  const exec = (rel) => {
    accessSync(join(repo, rel), constants.X_OK);
    let mode = '';
    try {
      mode = execFileSync('git', ['ls-files', '-s', rel], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(' ')[0];
    } catch {
      // not a git checkout: the file-system check above is enough
    }
    if (mode) assert.equal(mode, '100755', `${rel} is committed as executable`);
  };
  exec('factory/checks.sh');
  assert.match(read('factory/checks.sh'), /^npm test\b/m);
  const bins = readdirSync(join(repo, 'factory/bin'));
  assert.deepEqual(bins.sort(), ['approve', 'dashboard', 'ensure-output', 'gate', 'init', 'job', 'nudge', 'protect-tests', 'route', 'selfcheck', 'setup', 'setup-spec-review', 'visual']);
  for (const bin of bins) {
    exec(`factory/bin/${bin}`);
    assert.ok(statSync(join(repo, 'factory/bin', bin)).isFile());
    assert.match(read(`factory/bin/${bin}`), /^#!\/bin\/sh\n/, `${bin} is a sh script`);
  }
  for (const name of ['job', 'gate', 'route', 'nudge', 'dashboard', 'init']) {
    assert.equal(
      read(`factory/bin/${name}`),
      `#!/bin/sh\nexec node "$(dirname "$0")/../lib/${name}.js" "$@"\n`,
      `${name} is the 2-line wrapper`,
    );
  }
  assert.ok(!existsSync(join(repo, 'factory/backlog.md')), 'factory/backlog.md is gone');

  // A branch cannot point `npm test` away from the full suite.
  const dir = mkdtempSync(join(tmpdir(), 'factory-checks-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/route.test.js' } }));
  const res = spawnSync('sh', [join(repo, 'factory/checks.sh')], { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status, 1, 'checks.sh refuses a changed scripts.test');
  assert.match(res.stderr, /scripts\.test/);
});

test('AC-8: SKILL.md documents the v2 commands and keeps the v1 rules', () => {
  const skill = read('.claude/skills/eminzo-factory/SKILL.md');
  for (const text of ['/eminzo-factory run', '/eminzo-factory issue', '/eminzo-factory rework', 'WAIT FOR ALL', 'run_in_background', 'SendMessage']) {
    assert.ok(skill.includes(text), `SKILL.md contains ${text}`);
  }
  for (const text of ['/factory approve', '/factory next', '/eminzo-factory next']) {
    assert.ok(!skill.includes(text), `SKILL.md does not contain ${text}`);
  }
  // approve-spec approves a spec before the build; there is still no PR approve command.
  assert.ok(!/\/eminzo-factory approve(?!-spec)/.test(skill), 'SKILL.md does not contain /eminzo-factory approve');
});

// The command is eminzo-factory only: the legacy /factory and $factory aliases are gone.
const LEGACY_COMMAND = /(^|[^\w./-])[/$]factory(?=[\s`'",):;!?*>\]]|\.(?:\s|$)|$)/m;

test('no legacy factory skill folder or /factory, $factory command is left', () => {
  for (const dir of ['.claude/skills/factory', '.agents/skills/factory']) {
    assert.ok(!existsSync(join(repo, dir)), `${dir} must not exist`);
  }
  for (const file of ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md',
    'factory/dashboard.js', 'factory/dashboard.html', 'factory/demo/jobs/003-rate-limiting/decision.md',
    'docs/codex-costs.md', 'README.md']) {
    assert.doesNotMatch(read(file), LEGACY_COMMAND, `${file} names the legacy /factory or $factory command`);
  }
});

test('AC-8: config.json has auto_merge true and SKILL.md documents auto_merge, awaiting-merge and the stale-main check', () => {
  assert.equal(JSON.parse(read('factory/config.json')).auto_merge, true);
  const skill = read('.claude/skills/eminzo-factory/SKILL.md');
  for (const text of ['git rev-list --count <base>..<branch>', 'awaiting-merge', 'auto_merge']) {
    assert.ok(skill.includes(text), `SKILL.md contains ${text}`);
  }
});
