// Job 064: related_repos in factory/config.json (team), its pure validation and the doctor check.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELATED_REPOS_MAX, isRepoSlug, knownRepoNames, mainRepoSlug, relatedNames, relatedReposProblems, remoteSlug, validRelatedRepos } from '../factory/lib/related-repos.js';
import { checks, doctor } from '../cli/src/doctor.js';

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

describe('remoteSlug and the valid entries', () => {
  test('AC-2: every common remote form gives owner/name and never leaks a credential', () => {
    const forms = [
      'https://github.com/acme/payments-api', 'https://github.com/Acme/Payments-API.git', 'https://github.com/acme/payments-api.git/',
      'https://x-access-token:s3cret@github.com/acme/payments-api.git', 'git@github.com:acme/payments-api.git', 'git@github.com:acme/payments-api',
      'ssh://git@github.com/acme/payments-api.git', 'git@github-work:acme/payments-api.git',
    ];
    for (const url of forms) {
      const slug = remoteSlug(url);
      assert.equal(slug?.toLowerCase(), 'acme/payments-api', url);
      assert.ok(!slug.includes('s3cret'));
    }
    for (const url of ['', 'not a remote', 'https://github.com/acme', 'https://github.com/acme/x/y', 42, null]) assert.equal(remoteSlug(url), null, String(url));
  });

  test('AC-3: validRelatedRepos keeps the valid entries in file order and relatedNames shortens unique names', () => {
    const team = { repo: 'acme/main', related_repos: [entry('acme/api'), entry('ACME/API'), entry('acme/main'), entry('other/Api'), entry('acme/web')] };
    assert.deepEqual(validRelatedRepos(team).map((e) => e.repo), ['acme/api', 'other/Api', 'acme/web']);
    assert.deepEqual(validRelatedRepos({}), []);
    assert.deepEqual(validRelatedRepos({ related_repos: 'x' }), []);
    assert.deepEqual(relatedNames(['acme/api', 'other/API', 'acme/web']), ['acme/api', 'other/API', 'web']);
  });
});

describe('doctor related_setup check', () => {
  const MARK = '<!-- eminzo:setup-complete -->';
  function repoSetup(config, project) {
    const root = mkdtempSync(join(tmpdir(), 'related-setup-'));
    mkdirSync(join(root, 'factory'), { recursive: true });
    writeFileSync(join(root, 'factory/config.json'), JSON.stringify(config));
    if (project !== undefined) writeFileSync(join(root, 'factory/project.md'), project);
    const home = mkdtempSync(join(tmpdir(), 'related-home-'));
    const env = { ...process.env, FACTORY_ROOT: root };
    return { root, home, env, run: () => checks({ version: '0.2.9', home, env, cwd: root }) };
  }
  const cfg = { engine: '0.2.x', repo: 'acme/main', related_repos: [entry('acme/a'), entry('acme/b')] };

  test('AC-7: a partial coverage warns naming each missing slug and the setup command, and doctor still exits 0', () => {
    const { run, home, env, root } = repoSetup(cfg, `# P\n<!-- eminzo:setup-related: acme/a -->\n${MARK}\n`);
    const check = run().results.find((c) => c.id === 'related_setup');
    assert.equal(check.level, 'warn');
    assert.ok(check.detail.includes('acme/b') && !check.detail.includes('acme/a'), check.detail);
    assert.ok(check.detail.includes('/eminzo-factory setup'));
    assert.ok(!check.detail.includes('\n') && !check.detail.includes('A related service'));
    const out = { write() {} };
    const status = doctor({ version: '0.2.9', home, env, cwd: root, out });
    assert.equal(status, run().results.some((c) => c.level === 'fail') ? 1 : 0);
    assert.equal(run().results.find((c) => c.id === 'related_setup').level, 'warn');
  });

  test('AC-7: full coverage is ok; no list, an empty list or no marker adds no check', () => {
    const covered = repoSetup(cfg, `<!-- eminzo:setup-related: ACME/a acme/b -->\n${MARK}\n`).run().results.find((c) => c.id === 'related_setup');
    assert.equal(covered.level, 'ok');
    for (const [config, project] of [[{ engine: '0.2.x' }, `${MARK}\n`], [{ engine: '0.2.x', related_repos: [] }, `${MARK}\n`], [cfg, '# not finished\n']]) {
      assert.ok(!repoSetup(config, project).run().results.some((c) => c.id === 'related_setup'));
    }
    assert.deepEqual(repoSetup({ engine: '0.2.x' }, `${MARK}\n`).run().results.map((c) => c.id), ['node', 'git', 'gh', 'path', 'adapters', 'engine', 'setup']);
  });
});

describe('job 067: known repository names', () => {
  test('AC-1: knownRepoNames gives the related names in file order and the main repository last', () => {
    const team = { repo: 'https://github.com/acme/storefront-web', related_repos: [entry('acme/payments-api'), entry('acme/web'), entry('other/Web'), { repo: 'bad' }] };
    const before = JSON.stringify(team);
    assert.deepEqual(knownRepoNames(team), [
      { name: 'payments-api', repo: 'acme/payments-api' },
      { name: 'acme/web', repo: 'acme/web' },
      { name: 'other/Web', repo: 'other/Web' },
      { name: 'storefront-web', repo: null },
    ]);
    assert.equal(JSON.stringify(team), before);
    for (const empty of [{}, null, { related_repos: 'x' }]) assert.deepEqual(knownRepoNames(empty), []);
    assert.deepEqual(knownRepoNames({ repo: 'acme/Solo' }), [{ name: 'solo', repo: null }]);
  });
});
