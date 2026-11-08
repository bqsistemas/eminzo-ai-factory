import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInstall, gitignoreText, GITIGNORE_HEADER } from '../cli/src/installer/plan.js';

const kit = {
  kitVersion: '0.1.0+abc123abc123',
  files: [
    { path: '.claude/agents/eminzo-builder.md', sha256: 'h1' },
    { path: 'factory/bin/setup', sha256: 'h2' },
    { path: 'factory/lib/util.js', sha256: 'h3' },
  ],
};
const TEMPLATE = '{\n  "repo": "__REPO__",\n  "base": "__BASE__",\n  "concurrency": 3\n}\n';
const facts = (over = {}) => ({
  existing: [], gitignore: null, repoUrl: 'https://github.com/acme/web', defaultBranch: 'main',
  checksScript: '#!/bin/sh\nnpm test\n', configTemplate: TEMPLATE, ...over,
});
const ops = (over, k = kit) => planInstall(facts(over), k);
const byOp = (list, op) => list.filter((o) => o.op === op);

test('a fresh repo gets every kit file copied, the generated files written, the .gitignore appended and the manifest last', () => {
  const plan = ops();
  assert.deepEqual(byOp(plan, 'copy').map((o) => o.path), kit.files.map((f) => f.path));
  assert.deepEqual(byOp(plan, 'write').map((o) => o.path), ['factory/config.json', 'factory/checks.sh', 'factory/.manifest.json']);
  assert.equal(plan.at(-1).path, 'factory/.manifest.json');
  assert.equal(byOp(plan, 'gitignore-append').length, 1);
  assert.equal(byOp(plan, 'skip-existing').length, 0);
});

test('config.json is the template with the repo URL and the base filled in; checks.sh is the detected script, executable', () => {
  const plan = ops();
  const config = plan.find((o) => o.path === 'factory/config.json');
  assert.deepEqual(JSON.parse(config.content), { repo: 'https://github.com/acme/web', base: 'origin/main', concurrency: 3 });
  const checks = plan.find((o) => o.path === 'factory/checks.sh');
  assert.equal(checks.content, '#!/bin/sh\nnpm test\n');
  assert.equal(checks.mode, 0o755);
  assert.equal(ops({ defaultBranch: 'develop' }).find((o) => o.path === 'factory/config.json').content.includes('"origin/develop"'), true);
});

test('scripts under factory/bin are copied executable, the rest with the default mode', () => {
  const plan = ops();
  assert.equal(plan.find((o) => o.path === 'factory/bin/setup').mode, 0o755);
  assert.equal(plan.find((o) => o.path === 'factory/lib/util.js').mode, undefined);
});

test('it never overwrites: an existing file becomes skip-existing, kit files and generated files alike', () => {
  const plan = ops({ existing: ['.claude/agents/eminzo-builder.md', 'factory/config.json', 'factory/checks.sh'] });
  assert.deepEqual(byOp(plan, 'skip-existing').map((o) => o.path).sort(), ['.claude/agents/eminzo-builder.md', 'factory/checks.sh', 'factory/config.json']);
  assert.deepEqual(byOp(plan, 'copy').map((o) => o.path), ['factory/bin/setup', 'factory/lib/util.js']);
  assert.equal(plan.some((o) => (o.op === 'copy' || o.op === 'write') && o.path === 'factory/config.json'), false);
});

test('the manifest records the kit version, the hashes of what was copied and what was skipped', () => {
  const plan = ops({ existing: ['factory/lib/util.js'] });
  const m = JSON.parse(plan.at(-1).content);
  assert.equal(m.kitVersion, kit.kitVersion);
  assert.deepEqual(m.files, [{ path: '.claude/agents/eminzo-builder.md', sha256: 'h1' }, { path: 'factory/bin/setup', sha256: 'h2' }]);
  assert.deepEqual(m.skipped, ['factory/lib/util.js']);
});

test('an existing manifest is never rewritten', () => {
  const plan = ops({ existing: ['factory/.manifest.json'] });
  assert.equal(plan.some((o) => o.op === 'write' && o.path === 'factory/.manifest.json'), false);
  assert.ok(byOp(plan, 'skip-existing').some((o) => o.path === 'factory/.manifest.json'));
});

test('.gitignore: appends only the missing runtime-state lines, under a header, and creates the file when absent', () => {
  const fresh = byOp(ops(), 'gitignore-append')[0];
  assert.equal(fresh.path, '.gitignore');
  assert.equal(fresh.text, `${GITIGNORE_HEADER}\nfactory/board.json\nfactory/jobs/\n.worktrees/\nfactory/config.local.json\n`);

  const partial = byOp(ops({ gitignore: 'node_modules/\nfactory/jobs/\n' }), 'gitignore-append')[0];
  assert.equal(partial.text, `${GITIGNORE_HEADER}\nfactory/board.json\n.worktrees/\nfactory/config.local.json\n`);

  const noNewline = byOp(ops({ gitignore: 'node_modules/' }), 'gitignore-append')[0];
  assert.ok(noNewline.text.startsWith('\n'), 'starts on its own line');
});

test('.gitignore is idempotent: all lines present (even with a leading slash or CRLF) means no op', () => {
  assert.equal(byOp(ops({ gitignore: 'factory/board.json\nfactory/jobs/\n.worktrees/\nfactory/config.local.json\n' }), 'gitignore-append').length, 0);
  assert.equal(byOp(ops({ gitignore: '/factory/board.json\r\n/factory/jobs/\r\n.worktrees\r\n/factory/config.local.json\r\n' }), 'gitignore-append').length, 0);
});

const localLines = (text) => text.split(/\r?\n/).filter((l) => l.trim().replace(/^\//, '') === 'factory/config.local.json').length;

test('AC-9: the planned .gitignore ends with exactly one factory/config.local.json line: absent, missing it or already having it', () => {
  const RUNTIME = 'factory/board.json\nfactory/jobs/\n.worktrees/\n';
  for (const [name, current] of [
    ['absent', null],
    ['without the entry', 'node_modules/\n'],
    ['with only the runtime state', RUNTIME],
    ['with the entry', `node_modules/\nfactory/config.local.json\n`],
    ['with the entry and a leading slash', `${RUNTIME}/factory/config.local.json\n`],
  ]) {
    const append = byOp(ops({ gitignore: current }), 'gitignore-append')[0];
    const result = `${current ?? ''}${append?.text ?? ''}`;
    assert.equal(localLines(result), 1, `${name}: ${JSON.stringify(result)}`);
    assert.equal(gitignoreText(current), append?.text ?? null, `${name}: the exported helper plans the same text`);
  }
  assert.equal(gitignoreText(`${RUNTIME}factory/config.local.json\n`), null, 'nothing missing means null');
});

test('planning twice from the resulting state yields no copy, write or append', () => {
  const first = ops();
  const existing = first.filter((o) => o.op === 'copy' || o.op === 'write').map((o) => o.path);
  const gi = byOp(first, 'gitignore-append')[0].text;
  const second = ops({ existing, gitignore: gi });
  assert.deepEqual(second.filter((o) => o.op !== 'skip-existing'), []);
});

test('placeholders are filled everywhere and a repo URL that is not https://github.com/o/n is refused', () => {
  assert.doesNotMatch(ops().find((o) => o.path === 'factory/config.json').content, /__/);
  assert.throws(() => ops({ repoUrl: 'git@github.com:a/b.git' }), /repo URL/);
  assert.throws(() => ops({ defaultBranch: '' }), /default branch/);
  assert.throws(() => ops({ defaultBranch: 'a"b' }), /default branch/);
});
