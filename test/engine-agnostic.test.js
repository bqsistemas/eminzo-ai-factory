// Step 2 of the efficiency plan (P0-7, P0-5): the engine carries no assumption about this
// repo (base branch, Claude-only folders, python), roles live in a neutral folder, the
// dashboard is served by Node, and Codex runs the checks before it writes READY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(repo, path), 'utf8');
const list = (dir, ext) => readdirSync(join(repo, dir)).filter((f) => f.endsWith(ext)).sort();
const ROLES = ['approver', 'builder', 'intake', 'review-code', 'review-security', 'review-ui', 'review-ux', 'spec-writer'];
const frontmatter = (text) => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
const body = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '');
const SKILLS = ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md'];

test('the eight role bodies live in factory/roles/ without frontmatter', () => {
  assert.deepEqual(list('factory/roles', '.md').map((f) => f.slice(0, -3)), ROLES);
  for (const role of ROLES) {
    const text = read(`factory/roles/${role}.md`);
    assert.ok(!text.startsWith('---'), `${role} body must not carry frontmatter`);
    assert.doesNotMatch(text, /\*\*Before you finish\*\*/, `${role}: the finish block comes from the template`);
    assert.match(read(`.claude/agents/eminzo-${role}.md`), /\*\*Before you finish\*\*/, `${role} wrapper has the Before you finish section`);
  }
});

test('every Claude wrapper keeps the frontmatter and only points to the neutral role body', () => {
  for (const role of ROLES) {
    const text = read(`.claude/agents/eminzo-${role}.md`);
    const front = frontmatter(text);
    for (const key of ['name', 'description', 'tools', 'model', 'hooks']) {
      assert.match(front, new RegExp(`^${key}:`, 'm'), `${role} wrapper lost ${key}`);
    }
    assert.match(front, new RegExp(`^name: eminzo-${role}$`, 'm'));
    assert.ok(body(text).includes(`factory/roles/${role}.md`), `${role} wrapper must point to its role body`);
    assert.ok(body(text).trim().split('\n').length <= 20, `${role} wrapper must stay thin`); // role pointer, rules and the generated language and finish blocks
  }
});

test('every Codex profile points to factory/roles/<role>.md and not to .claude/', () => {
  for (const role of ROLES) {
    const profile = read(`.codex/agents/eminzo-${role}.toml`);
    assert.ok(profile.includes(`factory/roles/${role}.md`), `${role} profile must point to factory/roles`);
    assert.ok(!profile.includes('.claude/'), `${role} profile must not depend on .claude/`);
  }
});

// Guard: nothing in the engine layer may name this repo's base branch or lean on Claude's folder.
const ENGINE_FILES = () => [
  ...ROLES.map((r) => `factory/roles/${r}.md`),
  ...ROLES.map((r) => `.claude/agents/eminzo-${r}.md`),
  ...ROLES.map((r) => `.codex/agents/eminzo-${r}.toml`),
  ...SKILLS,
];

test('guard: no engine file hardcodes origin/main or --base main', () => {
  for (const file of ENGINE_FILES()) {
    const text = read(file);
    assert.ok(!text.includes('origin/main'), `${file} hardcodes origin/main`);
    assert.ok(!/--base main\b/.test(text), `${file} hardcodes --base main`);
  }
});

test('guard: Codex files never read .claude/agents/', () => {
  for (const file of [...ROLES.map((r) => `.codex/agents/eminzo-${r}.toml`), '.agents/skills/eminzo-factory/SKILL.md']) {
    assert.ok(!read(file).includes('.claude/agents'), `${file} references .claude/agents`);
  }
});

test('roles take the base from the prompt instead of a literal branch', () => {
  for (const role of ['review-code', 'review-security', 'review-ui', 'review-ux', 'approver']) {
    const text = read(`factory/roles/${role}.md`);
    assert.match(text, /`Base:`/, `${role} must read the Base: line of its prompt`);
    assert.match(text, /<base>\.\.\.factory\/<job-id>|<base> factory\/<job-id>/, `${role} must diff against <base>`);
  }
  const builder = read('factory/roles/builder.md');
  assert.match(builder, /`Base branch:`/);
  assert.match(builder, /gh pr create --draft --base <base-branch>/);
  assert.match(builder, /git merge <base>/);
  assert.match(builder, /git log --oneline <base>\.\.factory\/<job-id>/);
});

test('both skills pass Base and Base branch in the worker prompt and preflight on config.base', () => {
  for (const file of SKILLS) {
    const text = read(file);
    assert.match(text, /^\s*Base: <config\.base>$/m, `${file} prompt lacks Base:`);
    assert.match(text, /^\s*Base branch: <branch of config\.base>$/m, `${file} prompt lacks Base branch:`);
    assert.match(text, /<!-- rule: base-in-prompt -->/);
    assert.match(text, /`base` in `factory\/config\.json`/, `${file} preflight must read config.base`);
    assert.match(text, /factory\/roles\//, `${file} must name the neutral role folder`);
    assert.ok(!text.includes('http.server') && !text.includes('python'), `${file} still serves with python`);
    assert.match(text, /factory\/bin\/dashboard/, `${file} must use factory/bin/dashboard`);
  }
});

test('Codex builder reads a role that runs the checks before READY; both skills run them before to gate', () => {
  const role = read('factory/roles/builder.md');
  assert.match(read('.codex/agents/eminzo-builder.toml'), /factory\/roles\/builder\.md/);
  assert.match(role, /factory\/checks\.sh/);
  assert.match(role, /only (write|when).*STATUS: READY.*exit(s)? 0|STATUS: READY.*only.*exit(s)? 0/s);
  const codex = read('.agents/skills/eminzo-factory/SKILL.md');
  const claude = read('.claude/skills/eminzo-factory/SKILL.md');
  for (const text of [codex, claude]) assert.match(text, /<!-- rule: checks-before-gate -->/);
  assert.match(codex, /factory\/bin\/nudge/);
  assert.match(codex, /without (consuming|using) a round/);
  assert.match(claude, /Stop hook/);
});

test('both skills spawn only the routed reviewer lenses', () => {
  for (const file of SKILLS) {
    const text = read(file);
    assert.match(text, /<!-- rule: routed-reviewers-only -->/);
    assert.match(text, /keys of\s+`(job\.json\.)?agents\.reviewers`/, `${file} must name agents.reviewers keys`);
    assert.match(text, /never spawn a lens that is not a key|Never spawn a lens that is not a key/i);
  }
});

test('dashboard server: serves files, refuses traversal and non-GET, binds loopback', async () => {
  const { createDashboardServer } = await import('../factory/lib/dashboard.js');
  const server = createDashboardServer(join(repo, 'factory'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port, address } = server.address();
  assert.equal(address, '127.0.0.1');
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', body }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const page = await get('/dashboard.html');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.equal((await get('/')).status, 200, '/ serves dashboard.html');
    assert.equal((await get('/pipeline-canvas.js')).type.split(';')[0], 'text/javascript');
    for (const bad of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%00', '/lib/../../package.json', '/missing.html']) {
      assert.ok([400, 403, 404].includes((await get(bad)).status), `${bad} must not be served`);
    }
    assert.equal((await get('/dashboard.html', 'POST')).status, 405);
  } finally {
    server.close();
  }
});

test('nudge <job-id> runs the checks by hand: exit 0 on pass, 2 with the log on failure, an error without a job', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-nudge-'));
  const id = '001-manual';
  const worktree = join(root, 'wt');
  mkdirSync(worktree);
  mkdirSync(join(root, 'factory/jobs', id), { recursive: true });
  writeFileSync(join(root, 'factory/jobs', id, 'job.json'), JSON.stringify({ id, worktree }));
  const nudge = (...args) => spawnSync(join(repo, 'factory/bin/nudge'), args, { encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root } });
  writeFileSync(join(root, 'factory/checks.sh'), '#!/bin/sh\necho ok\n');
  assert.equal(nudge(id).status, 0);
  writeFileSync(join(root, 'factory/checks.sh'), '#!/bin/sh\necho "broken thing"\nexit 1\n');
  const failed = nudge(id);
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /broken thing/);
  assert.notEqual(nudge('002-missing').status, 0);
  assert.equal(nudge('not an id').status, 64);
});
