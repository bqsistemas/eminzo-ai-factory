// Job 064: related_checkouts, a local-only key of factory/config.local.json, and `job config` for both related keys.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_ONLY, OVERRIDABLE, Refused, effectiveConfig, validateLocal } from '../factory/lib/util.js';
import { configView } from '../factory/lib/state/queries.js';
import { teamConfig, plainRoot, writeLocal, untracked, quiet, setup, ok } from './helpers/config-local-harness.js';

const checkouts = () => ({
  'acme/payments-api': { path: '/Users/alex/code/payments-api', account: 'alex-dev' },
  'acme/web': { path: '/Users/alex/code/web' },
  'acme/ent': { path: '/Users/alex/code/ent', account: 'alex_acme' },
  'orphan/not-in-team': { path: '/Users/alex/code/orphan' },
});
const eff = (root) => effectiveConfig(root, { tracked: untracked, warn: quiet });

describe('related_checkouts', { concurrency: true }, () => {
  test('AC-4: valid checkouts, including orphans and managed-user accounts, are accepted; the lists stay as specified', () => {
    for (const team of [teamConfig(), { ...teamConfig(), related_repos: [{ repo: 'acme/web', description: 'd' }] }]) {
      const local = { language: 'en', related_checkouts: checkouts() };
      assert.doesNotThrow(() => validateLocal(team, local));
      const root = plainRoot(team);
      writeLocal(root, local);
      assert.doesNotThrow(() => eff(root));
    }
    assert.deepEqual([...OVERRIDABLE], ['concurrency', 'default_provider', 'language', 'max_rounds', 'auto_merge', 'spec_review', 'discovery', 'run_mode']);
    assert.deepEqual([...LOCAL_ONLY], ['related_checkouts']);
    assert.ok(Object.isFrozen(OVERRIDABLE) && Object.isFrozen(LOCAL_ONLY));
    for (const key of ['routing', 'related_repos', 'other']) {
      assert.throws(() => validateLocal(teamConfig(), { [key]: [] }), (e) => e instanceof Refused && e.message.startsWith(`config.local.json: ${key}: `));
    }
  });

  const rejected = {
    array: [], string: 'x', null: null,
    'checkout not object': { 'acme/x': 'p' },
    'relative path': { 'acme/x': { path: 'code/x' } },
    'tilde path': { 'acme/x': { path: '~/code/x' } },
    'bare tilde': { 'acme/x': { path: '~' } },
    'empty path': { 'acme/x': { path: '' } },
    'missing path': { 'acme/x': {} },
    'path not string': { 'acme/x': { path: 4 } },
    'account dash': { 'acme/x': { path: '/a', account: '-bad' } },
    'account dot': { 'acme/x': { path: '/a', account: 'a.b' } },
    'account space': { 'acme/x': { path: '/a', account: 'a b' } },
    'account 101': { 'acme/x': { path: '/a', account: 'a'.repeat(101) } },
    'account not string': { 'acme/x': { path: '/a', account: 1 } },
    'extra field': { 'acme/x': { path: '/a', extra: 1 } },
    'key not slug': { acme: { path: '/a' } },
  };
  for (const [name, value] of Object.entries(rejected)) {
    test(`AC-5: ${name} is refused with config.local.json: related_checkouts: `, () => {
      const local = { related_checkouts: value };
      assert.throws(() => validateLocal(teamConfig(), local), (e) => e instanceof Refused && e.message.startsWith('config.local.json: related_checkouts: ') && e.message.length > 40);
      const root = plainRoot();
      writeLocal(root, local);
      assert.throws(() => eff(root), Refused);
    });
  }

  test('AC-5: a __proto__ key is refused', () => {
    const root = plainRoot();
    writeLocal(root, '{"related_checkouts":{"__proto__":{"path":"/a"}}}');
    assert.throws(() => eff(root), (e) => e instanceof Refused && e.message.startsWith('config.local.json: related_checkouts: '));
  });

  test('AC-5: job summary exits 1 with refused: config.local.json: related_checkouts: ', async () => {
    const t = setup();
    t.local({ related_checkouts: { 'acme/x': { path: 'relative' } } });
    const res = await t.job('summary');
    assert.equal(res.status, 1);
    assert.ok(res.stderr.startsWith('refused: config.local.json: related_checkouts: '), res.stderr);
  });

  test('AC-6: it enters the effective config but is not an override; board and MCP view keep only the overrides', async () => {
    const root = plainRoot();
    const value = checkouts();
    writeLocal(root, { concurrency: 1, related_checkouts: value });
    const r = eff(root);
    assert.deepEqual(r.config.related_checkouts, value);
    assert.deepEqual(r.overrides, ['concurrency']);
    assert.deepEqual(r.localOnly, ['related_checkouts']);
    const none = plainRoot();
    assert.deepEqual(eff(none).localOnly, []);

    const t = setup();
    t.issue(7);
    t.local({ concurrency: 1, related_checkouts: value });
    const id = ok(await t.job('new', '7'));
    t.write(id, 'intake.md', 'ACCEPT\nRISK: low\nSURFACES: none\nRESCOPED: no\n\n## Scope\nx\n\n## Reason\ny\n');
    ok(await t.job(id, 'to', 'spec'));
    assert.deepEqual(t.board().config_overrides, ['concurrency']);
    assert.deepEqual(configView(t.root).config.local_overrides, ['concurrency']);
  });

  test('AC-7: job config prints both keys in file order with their origin, with and without them', async () => {
    const related = [{ repo: 'zeta/z', description: 'z' }, { repo: 'alpha/a', description: 'a' }];
    const t = setup({ team: { ...teamConfig(), related_repos: related } });
    const value = { 'acme/web': { path: '/Users/alex/code/web' } };
    t.local({ related_checkouts: value });
    const one = await t.job('config', 'related_repos');
    assert.equal(one.status, 0);
    assert.equal(one.stdout.trim(), `related_repos team ${JSON.stringify(related)}`);
    const two = await t.job('config', 'related_checkouts');
    assert.equal(two.stdout.trim(), `related_checkouts local ${JSON.stringify(value)}`);
    const all = (await t.job('config')).stdout;
    assert.ok(all.includes(`related_repos team ${JSON.stringify(related)}`) && all.includes('related_checkouts local '));

    const bare = setup();
    const plain = (await bare.job('config')).stdout;
    const r1 = await bare.job('config', 'related_repos');
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout.trim(), 'related_repos team []');
    assert.equal((await bare.job('config', 'related_checkouts')).stdout.trim(), 'related_checkouts local {}');
    assert.ok(!plain.includes('related_'), 'job config without the keys adds no lines');
    assert.equal((await bare.job('config', 'no_such_key')).status, 1);
  });

  test('AC-7: an invalid related_repos does not fail job config or job summary', async () => {
    const dup = { ...teamConfig(), related_repos: [{ repo: 'a/b', description: 'd' }, { repo: 'A/B', description: 'd' }] };
    const t = setup({ team: dup });
    assert.equal((await t.job('config')).status, 0);
    assert.equal((await t.job('summary')).status, 0);
  });
});
