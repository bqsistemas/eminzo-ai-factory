// Job 066: `factory/bin/related` reports, read-only, how each related repository is checked out on this machine.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ENGINE_COMMANDS } from '../cli/src/engine.js';

const bin = fileURLToPath(new URL('../factory/bin/related', import.meta.url));
const cli = fileURLToPath(new URL('../cli/bin/eminzo.js', import.meta.url));
const entry = (repo, description = `About ${repo}`) => ({ repo, description });

const sh = (cwd, ...args) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
};
const gitRepo = (origin) => {
  const dir = mkdtempSync(join(tmpdir(), 'related-co-'));
  sh(dir, 'init', '-q');
  if (origin) sh(dir, 'remote', 'add', 'origin', origin);
  return dir;
};
function mainRepo(related, local) {
  const root = mkdtempSync(join(tmpdir(), 'related-main-'));
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ engine: '0.2.x', repo: 'acme/main', ...(related === undefined ? {} : { related_repos: related }) }));
  if (local !== undefined) writeFileSync(join(root, 'factory/config.local.json'), typeof local === 'string' ? local : JSON.stringify(local));
  return root;
}
const related = (root, args = []) => spawnSync(bin, args, { encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root } });

describe('factory/bin/related', () => {
  test('AC-1: one entry per related repository with its state, and never a remote URL', () => {
    const ok = gitRepo('https://github.com/ACME/Payments-API.git');
    const notRepo = mkdtempSync(join(tmpdir(), 'related-plain-'));
    const other = gitRepo('https://x-access-token:s3cret@github.com/other/thing.git');
    const noOrigin = gitRepo();
    const repos = ['acme/payments-api', 'acme/none', 'acme/gone', 'acme/plain', 'acme/other', 'acme/noorigin'];
    const root = mainRepo(repos.map((r) => entry(r)), {
      related_checkouts: {
        'ACME/Payments-Api': { path: ok },
        'acme/GONE': { path: join(tmpdir(), 'does-not-exist-066') },
        'Acme/Plain': { path: notRepo },
        'acme/Other': { path: other },
        'acme/NoOrigin': { path: noOrigin },
      },
    });
    const res = related(root);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.ok(res.stdout.endsWith('\n'));
    assert.deepEqual(out.map((e) => e.repo), repos);
    for (const e of out) assert.deepEqual(Object.keys(e).sort(), ['description', 'name', 'path', 'repo', 'state']);
    assert.deepEqual(out.map((e) => e.state), ['ok', 'missing', 'missing', 'missing', 'mismatch', 'mismatch']);
    assert.deepEqual(out.map((e) => e.path), [ok, null, null, null, null, null]);
    assert.ok(!/https?:|s3cret|github\.com/.test(res.stdout), res.stdout);
  });

  test('AC-3: names are short unless they repeat; no list prints []; an invalid local config is refused', () => {
    const root = mainRepo([entry('acme/api'), entry('other/API'), entry('acme/web'), entry('ACME/Web')]);
    const res = related(root);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout).map((e) => e.name), ['acme/api', 'other/API', 'web']);
    for (const none of [undefined, []]) {
      const r = related(mainRepo(none));
      assert.equal(r.status, 0);
      assert.deepEqual(JSON.parse(r.stdout), []);
    }
    const refused = related(mainRepo([entry('acme/api')], '{ nope'));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /^refused: config\.local\.json: /);
    assert.equal(related(root, ['x']).status, 2);
  });

  test('AC-3: related is an engine command and appears in eminzo help', () => {
    assert.ok(ENGINE_COMMANDS.includes('related'));
    const help = spawnSync('node', [cli, 'help'], { encoding: 'utf8' });
    assert.match(help.stdout, /\brelated\b/);
  });
});
