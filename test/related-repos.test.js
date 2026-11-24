// Job 064: related_repos in factory/config.json (team), its pure validation and the doctor check.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELATED_REPOS_MAX, isRepoSlug, mainRepoSlug, relatedReposProblems } from '../factory/lib/related-repos.js';
import { checks } from '../cli/src/doctor.js';

const entry = (repo, description = 'A related service.') => ({ repo, description });
const base = (list) => ({ repo: 'https://github.com/Acme/Main.git', related_repos: list });
const valid = [entry('acme/payments-api'), entry('my-org/web.app_v2-x'), entry('other/tools')];

describe('related_repos validation', () => {
  test('AC-1: a missing key, or 20 valid entries with a 500 character description, give no problems and leave team untouched', () => {
    assert.deepEqual(relatedReposProblems({ repo: 'acme/main' }), []);
    const twenty = Array.from({ length: RELATED_REPOS_MAX }, (_, i) => entry(`my-org/na.me_x-${i}`, `  ${'é'.repeat(500)}  `));
    const team = base(twenty);
    const copy = structuredClone(team);
    assert.deepEqual(relatedReposProblems(team), []);
    assert.deepEqual(team, copy);
    assert.equal(RELATED_REPOS_MAX, 20);
    assert.ok(isRepoSlug('a-b/c.d_e-f'));
  });

  const bad = {
    'owner with underscore': entry('ac_me/x'),
    'owner with dot': entry('ac.me/x'),
    'no slash': entry('acme'),
    'two slashes': entry('acme/x/y'),
    'empty name': entry('acme/'),
    'name ..': entry('acme/..'),
    'name .': entry('acme/.'),
    'duplicate by case': entry('ACME/Payments-API'),
    'the main repo': entry('ACME/main'),
    'empty description': entry('acme/ok', ''),
    'blank description': entry('acme/ok', '   '),
    'description 501': entry('acme/ok', 'x'.repeat(501)),
    'description not a string': { repo: 'acme/ok', description: 5 },
    'extra field': { repo: 'acme/ok', description: 'd', extra: 1 },
    'missing field': { repo: 'acme/ok' },
    'not an object': 'acme/ok',
    'null entry': null,
  };
  for (const [name, item] of Object.entries(bad)) {
    test(`AC-2: ${name} is exactly one problem at its index`, () => {
      const list = [entry('acme/payments-api'), item, entry('acme/last')];
      const problems = relatedReposProblems(base(list));
      assert.equal(problems.length, 1, JSON.stringify(problems));
      assert.equal(problems[0].index, 1);
      assert.equal(problems[0].repo, typeof item?.repo === 'string' ? item.repo : null);
      assert.ok(problems[0].reason.length > 0);
    });
  }

  test('AC-2: 21 entries or a value that is not an array is a problem with index null', () => {
    const many = Array.from({ length: 21 }, (_, i) => entry(`o/r${i}`));
    for (const value of [many, {}, 'x', 3]) {
      const problems = relatedReposProblems(base(value));
      assert.equal(problems.length, 1);
      assert.equal(problems[0].index, null);
    }
  });

  test('AC-2: mainRepoSlug reads URL or slug, lowercase, and nothing else', () => {
    assert.equal(mainRepoSlug({ repo: 'https://github.com/Acme/Main.git' }), 'acme/main');
    assert.equal(mainRepoSlug({ repo: 'Acme/Main' }), 'acme/main');
    assert.equal(mainRepoSlug({ repo: 'git@x:y' }), null);
    assert.equal(mainRepoSlug({}), null);
  });
});

function repoWith(config) {
  const root = mkdtempSync(join(tmpdir(), 'related-doctor-'));
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  const home = mkdtempSync(join(tmpdir(), 'related-home-'));
  const env = { ...process.env, FACTORY_ROOT: root };
  return () => checks({ version: '0.2.9', home, env, cwd: root });
}

describe('doctor related_repos check', () => {
  test('AC-3: an invalid entry is a warn naming the repo and the reason, never failing the exit', () => {
    const { results } = repoWith({ engine: '0.2.x', repo: 'acme/main', related_repos: [entry('acme/ok'), entry('ac_me/x', 'SECRET TEXT')] })();
    const check = results.find((c) => c.id === 'related_repos');
    assert.equal(check.level, 'warn');
    assert.ok(check.detail.includes('"ac_me/x"'), check.detail);
    assert.ok(!check.detail.includes('SECRET'), 'description is never printed');
    assert.ok(!check.detail.includes('\n'));
  });

  test('AC-3: valid entries give ok, and without the key the check ids are the same as before', () => {
    const ok = repoWith({ engine: '0.2.x', related_repos: valid })().results.find((c) => c.id === 'related_repos');
    assert.equal(ok.level, 'ok');
    const ids = repoWith({ engine: '0.2.x' })().results.map((c) => c.id);
    assert.deepEqual(ids, ['node', 'git', 'gh', 'path', 'adapters', 'engine', 'setup']);
    const unparsable = repoWith('{ nope')().results.map((c) => c.id);
    assert.ok(!unparsable.includes('related_repos'));
  });
});
