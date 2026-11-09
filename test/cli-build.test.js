// cli/build.mjs turns this repo's engine and adapters into the npm package's dist/: the engine
// (everything the kit carries under factory/, plus the dashboard) and the Claude and Codex adapters rewritten to call
// `eminzo <command>` with each role embedded. The source files are never changed.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../cli/build.mjs';
import { listKitFiles } from '../cli/src/installer/kit.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(repo, 'cli/package.json'), 'utf8')).version;
let out;

before(() => {
  out = join(mkdtempSync(join(tmpdir(), 'eminzo-build-')), 'dist');
  build({ out });
});

const read = (rel) => readFileSync(join(out, rel), 'utf8');
const ENGINE_PATH = /factory\/(bin|lib|roles|templates)\//;
const ROLES = readdirSync(join(repo, 'factory/roles')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));

test('the engine carries every factory/ file of the kit, the dashboard and the config template', () => {
  const kitEngine = listKitFiles(repo).filter((p) => p.startsWith('factory/'));
  assert.ok(kitEngine.length > 20);
  for (const p of kitEngine) assert.ok(existsSync(join(out, p)), `${p} is in the engine`);
  for (const p of ['factory/dashboard.html', 'factory/dashboard.js', 'factory/lib/dashboard.js', 'factory/bin/dashboard', 'factory/templates/config.json']) {
    assert.ok(existsSync(join(out, p)), `${p} is in the engine`);
  }
});

test('the engine never carries this repo\'s data or config', () => {
  for (const p of ['factory/jobs', 'factory/board.json', 'factory/config.json', 'factory/config.local.json', 'factory/checks.sh', 'factory/project.md']) {
    assert.equal(existsSync(join(out, p)), false, `${p} is not shipped`);
  }
});

test('the installer modules enable uses ship in the package source', () => {
  const files = JSON.parse(readFileSync(join(repo, 'cli/package.json'), 'utf8')).files;
  assert.ok(files.includes('src/'));
  for (const f of ['preflight.js', 'remote.js', 'checks.js', 'plan.js', 'kit.js']) assert.ok(existsSync(join(repo, 'cli/src/installer', f)), f);
});

test('the build records its version', () => {
  assert.equal(JSON.parse(read('build.json')).version, version);
});

for (const [skill, cmd] of [['claude/skills/eminzo-factory/SKILL.md', '/eminzo-factory'], ['agents/skills/eminzo-factory/SKILL.md', '$eminzo-factory']]) {
  test(`${skill}: calls eminzo, documents enable, and is stamped with the version`, () => {
    const text = read(join('adapters', skill));
    assert.doesNotMatch(text, ENGINE_PATH);
    assert.match(text, /eminzo job /);
    assert.match(text, /^argument-hint: enable \| setup \| run/m);
    assert.ok(text.includes(`${cmd} enable`), 'the enable command is documented');
    assert.ok(text.includes('eminzo enable'), 'enable runs the CLI');
    assert.ok(text.includes(`eminzo ${version}`), 'stamped with the version');
    assert.ok(text.includes('eminzo show templates/project.md'), 'setup gets the project template from the engine');
    for (const command of ['run', 'issue <n>', 'rework <n>', 'approve-spec <n>', 'revise-spec <n> <notes>', 'xs <request>', 'setup']) {
      assert.ok(text.includes(command), `still documents ${command}`);
    }
  });
}

test('every Claude agent is generated, embeds its role and runs its hooks through eminzo', () => {
  const agents = readdirSync(join(out, 'adapters/claude/agents')).sort();
  assert.deepEqual(agents, readdirSync(join(repo, '.claude/agents')).filter((f) => f.endsWith('.md')).sort());
  for (const role of ROLES) {
    const text = read(`adapters/claude/agents/eminzo-${role}.md`);
    assert.doesNotMatch(text, ENGINE_PATH, role);
    assert.doesNotMatch(text, /CLAUDE_PROJECT_DIR/, role);
    assert.match(text, /^---\nname: eminzo-/, `${role} keeps its frontmatter`);
    assert.match(text, /command: .*eminzo ensure-output/, `${role} hook`);
    const roleBody = readFileSync(join(repo, 'factory/roles', `${role}.md`), 'utf8').replace(/factory\/bin\/([a-z][a-z-]*)/g, 'eminzo $1');
    assert.ok(text.includes(roleBody.trim()), `${role} embeds its role`);
    assert.ok(text.includes(`eminzo ${version}`), `${role} is stamped`);
  }
  assert.match(read('adapters/claude/agents/eminzo-builder.md'), /command: 'eminzo nudge'/);
  assert.match(read('adapters/claude/agents/eminzo-builder.md'), /PreToolUse:\n    - matcher: Edit\|Write\|MultiEdit\|NotebookEdit\n      hooks:\n        - type: command\n          command: 'eminzo protect-tests'/);
  for (const role of ROLES.filter((r) => r !== 'builder')) assert.doesNotMatch(read(`adapters/claude/agents/eminzo-${role}.md`), /PreToolUse/, role);
});

test('every Codex agent is generated, embeds its role and keeps a valid literal string', () => {
  const agents = readdirSync(join(out, 'adapters/codex/agents')).sort();
  assert.deepEqual(agents, readdirSync(join(repo, '.codex/agents')).filter((f) => /^eminzo-.*\.toml$/.test(f)).sort());
  for (const role of ROLES) {
    const text = read(`adapters/codex/agents/eminzo-${role}.toml`);
    assert.doesNotMatch(text, ENGINE_PATH, role);
    assert.equal(text.split("'''").length, 3, `${role}: one ''' literal string`);
    assert.match(text, new RegExp(`^# Generated by eminzo ${version.replace(/\./g, '\\.')}`));
    const roleBody = readFileSync(join(repo, 'factory/roles', `${role}.md`), 'utf8').replace(/factory\/bin\/([a-z][a-z-]*)/g, 'eminzo $1');
    assert.ok(text.includes(roleBody.trim()), `${role} embeds its role`);
  }
});

test('the build never touches the source adapters or roles', () => {
  const skill = readFileSync(join(repo, '.claude/skills/eminzo-factory/SKILL.md'), 'utf8');
  assert.match(skill, /factory\/bin\/job/);
  assert.match(readFileSync(join(repo, '.claude/agents/eminzo-builder.md'), 'utf8'), /factory\/roles\/builder\.md/);
});
