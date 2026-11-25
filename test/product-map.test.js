// The functional map of the product: a reviewed markdown file that says how the product works today, in
// functional language, with every statement labelled confirmed or assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_LINE, STALE_AFTER_DAYS, mapStatus, parseProductMap, productMapTemplate } from '../factory/lib/product-map.js';

const MAP = [
  '# Product map: Acme Shop',
  '',
  'Reviewed: 2026-11-01 by ana-p',
  '',
  '## Buy a product',
  '- A visitor can add a product to the cart without an account. [confirmed]',
  '- Paying with a gift card is possible. [assumed] (source: checkout screen)',
  '',
  '## Track an order',
  '- The buyer sees the order status in their account. [confirmed] (source: src/orders/status.js)',
].join('\n');
const DAY = 86_400_000;
const at = (iso) => Date.parse(iso);

test('parseProductMap reads an Enterprise Managed User login and refuses a malformed one', () => {
  assert.deepEqual(parseProductMap('# Product map: Shop\nReviewed: 2026-11-01 by mona-cat_octo\n').reviewed, { date: '2026-11-01', by: 'mona-cat_octo' });
  for (const by of ['ana_ab', 'ana__octo', 'ana_', 'a'.repeat(40)]) assert.equal(parseProductMap(`# Product map: Shop\nReviewed: 2026-11-01 by ${by}\n`).reviewed, null, by);
});

test('parseProductMap reads title, review line, areas, items, basis and source', () => {
  const m = parseProductMap(MAP);
  assert.equal(m.title, 'Acme Shop');
  assert.deepEqual(m.reviewed, { date: '2026-11-01', by: 'ana-p' });
  assert.deepEqual(m.problems, []);
  assert.deepEqual(m.areas.map((a) => a.name), ['Buy a product', 'Track an order']);
  assert.deepEqual(m.areas[0].items, [
    { text: 'A visitor can add a product to the cart without an account.', basis: 'confirmed', source: null, repo: null },
    { text: 'Paying with a gift card is possible.', basis: 'assumed', source: 'checkout screen', repo: null },
  ]);
  assert.equal(m.areas[1].items[0].source, 'src/orders/status.js');
});

test('parseProductMap reports what is wrong without throwing', () => {
  const m = parseProductMap('- orphan [confirmed]\n## Area\n- no label here\n- weird [maybe]\nReviewed: someday by nobody!\n');
  assert.equal(m.title, null);
  assert.equal(m.reviewed, null);
  assert.ok(m.problems.some((p) => /title/.test(p)));
  assert.ok(m.problems.some((p) => /before any area/.test(p)));
  assert.ok(m.problems.some((p) => /no label here/.test(p)));
  assert.ok(m.problems.some((p) => /weird/.test(p)));
  assert.ok(m.problems.some((p) => /Reviewed/.test(p)));
  assert.deepEqual(parseProductMap(null).areas, []);
});

test('parseProductMap accepts the Spanish and Portuguese review words', () => {
  assert.deepEqual(parseProductMap('# Mapa del producto: Tienda\nRevisado: 2026-11-01 por ana\n').reviewed, { date: '2026-11-01', by: 'ana' });
  assert.equal(parseProductMap('# Mapa do produto: Loja\nRevisado: 2026-11-01 por ana\n').title, 'Loja');
});

test('parseProductMap flags an invalid date and an empty area', () => {
  const m = parseProductMap('# Product map: x\nReviewed: 2026-13-45 by ana\n## Empty\n');
  assert.equal(m.reviewed, null);
  assert.ok(m.problems.some((p) => /Reviewed/.test(p)));
  assert.ok(m.problems.some((p) => /area "Empty" has no items/.test(p)));
});

test('productMapTemplate is a draft in en, es and pt and parses without problems', () => {
  for (const [language, first] of [['en', '# Product map: Acme'], ['es', '# Mapa del producto: Acme'], ['pt', '# Mapa do produto: Acme']]) {
    const text = productMapTemplate({ title: 'Acme', language });
    assert.ok(text.startsWith(first), language);
    const parsed = parseProductMap(text);
    assert.equal(parsed.title, 'Acme');
    assert.equal(parsed.reviewed, null);
    assert.deepEqual(parsed.problems, [], language);
    assert.equal(mapStatus(parsed, { now: at('2026-11-12') }).state, 'draft');
  }
  assert.ok(productMapTemplate({ title: 'x', language: 'zz' }).startsWith('# Product map: x'));
});

test('mapStatus: missing, draft, reviewed and stale', () => {
  const now = at('2026-11-12T00:00:00Z');
  assert.equal(mapStatus(null, { now }).state, 'missing');
  assert.match(mapStatus(null, { now }).summary, /\/eminzo-product map/);
  assert.equal(mapStatus(parseProductMap('# Product map: x\n'), { now }).state, 'draft');
  const reviewed = mapStatus(parseProductMap(MAP), { now });
  assert.equal(reviewed.state, 'reviewed');
  assert.equal(reviewed.age_days, 11);
  assert.match(reviewed.summary, /2 areas, 3 statements \(2 confirmed, 1 assumed\)/);
  const stale = mapStatus(parseProductMap(MAP), { now: at('2026-11-01T00:00:00Z') + (STALE_AFTER_DAYS + 1) * DAY });
  assert.equal(stale.state, 'stale');
  assert.match(stale.summary, /review it again/);
  assert.equal(mapStatus(parseProductMap(MAP), { now: at('2026-11-01T00:00:00Z') + STALE_AFTER_DAYS * DAY }).state, 'reviewed');
  assert.equal(STALE_AFTER_DAYS, 90);
});

test('mapStatus: a map with problems stays a draft even when reviewed', () => {
  const bad = parseProductMap(`${MAP}\n- stray line without label`);
  assert.equal(mapStatus(bad, { now: at('2026-11-12') }).state, 'draft');
});

const timed = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

test('parseProductMap runs in linear time and rejects lines over the limit', () => {
  assert.ok(timed(() => parseProductMap(`# Product map: x\n## a\n- ${' '.repeat(200_000)}x\n`)) < 200, 'spaces');
  assert.ok(timed(() => parseProductMap(`# Product map: x\n## a\n- ${'a ['.repeat(60_000)}\n`)) < 200, 'brackets');
  assert.ok(timed(() => parseProductMap(`# Product map: x\nReviewed: ${' '.repeat(200_000)}x\n`)) < 200, 'review line');
  const long = parseProductMap(`# Product map: x\n## a\n- ${'y'.repeat(MAX_LINE)} [confirmed]\n`);
  assert.ok(long.problems.some((p) => /longer than 2000 characters/.test(p)));
  assert.deepEqual(long.areas[0].items, []);
});

test('parseProductMap keeps parsing items the same way', () => {
  const m = parseProductMap('# Product map: x\n## a\n- uses [brackets] fine [confirmed]\n- two (source: a) [assumed] (source: b)\n- [confirmed]\n- text [assumed] (source: )\n');
  assert.deepEqual(m.areas[0].items.map((i) => [i.text, i.basis, i.source]), [['uses [brackets] fine', 'confirmed', null], ['two (source: a)', 'assumed', 'b']]);
  assert.equal(m.problems.length, 2);
});

test('a duplicate Reviewed line is a problem and the first one stays', () => {
  const m = parseProductMap('# Product map: x\nReviewed: 2026-11-01 by ana\nReviewed: 2026-11-02 by bo\n## a\n- s [confirmed]\n');
  assert.deepEqual(m.reviewed, { date: '2026-11-01', by: 'ana' });
  assert.ok(m.problems.some((p) => /more than one Reviewed line/.test(p)));
});

test('a Reviewed date in the future makes the map a draft', () => {
  const now = at('2026-11-12T00:00:00Z');
  const s = mapStatus(parseProductMap(MAP.replace('2026-11-01', '2027-01-01')), { now });
  assert.equal(s.state, 'draft');
  assert.deepEqual(s.problems, ['the Reviewed date is in the future']);
  assert.match(s.summary, /in the future/);
  assert.equal(mapStatus(parseProductMap(MAP.replace('2026-11-01', '2026-11-12')), { now }).state, 'reviewed', 'today is not the future');
  assert.deepEqual(mapStatus(parseProductMap(MAP), { now }).problems, []);
});

test('product_map reports an unreadable file instead of crashing', { skip: process.getuid?.() === 0 }, async () => {
  const { chmodSync, mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { factoryTools } = await import('../factory/lib/mcp/tools.js');
  const root = mkdtempSync(join(tmpdir(), 'eminzo-map-'));
  mkdirSync(join(root, 'factory'));
  const file = join(root, 'factory/product-map.md');
  writeFileSync(file, MAP);
  chmodSync(file, 0o000);
  try {
    const tool = factoryTools({ root }).find((t) => t.name === 'product_map');
    const result = tool.run({});
    assert.equal(result.state, 'missing');
    assert.match(result.reason, /could not be read \(EACCES\)/);
    assert.match(result.summary, /cannot be used/);
  } finally {
    chmodSync(file, 0o600);
  }
});

const REPOS = [
  { name: 'payments-api', repo: 'acme/payments-api' },
  { name: 'acme/web', repo: 'acme/web' },
  { name: 'other/Web', repo: 'other/Web' },
  { name: 'storefront-web', repo: null },
];
const REVIEWED = '# Product map: Shop\nReviewed: 2026-11-01 by ana\n';
const item = (src) => `- s [assumed] (source: ${src})`;

test('AC-2: a source prefix naming a known repository sets repo and leaves source as written', () => {
  const sources = ['payments-api:src/config/retry.ts', 'PAYMENTS-API:src/x.ts', 'acme/web:src/a.ts', 'storefront-web:src/checkout/PaymentError.tsx', 'web:src/a.ts', 'billing:src/a.ts', 'Checkout screen: payment step', 'payments-api :src/x.ts', '__proto__:x'];
  const text = `${REVIEWED}## a\n${sources.map(item).join('\n')}\n- no source [confirmed]\n`;
  const m = parseProductMap(text, { repos: REPOS });
  const items = m.areas[0].items;
  assert.deepEqual(items.map((i) => i.repo), ['acme/payments-api', 'acme/payments-api', 'acme/web', null, null, null, null, null, null, null]);
  assert.deepEqual(items.slice(0, 9).map((i) => i.source), sources);
  assert.deepEqual(m.problems, []);
  assert.ok(parseProductMap(text).areas[0].items.every((i) => i.repo === null));
  assert.equal(parseProductMap(`${REVIEWED}## a\n${item('constructor:x')}\n`, { repos: [{ name: 5 }, null, { name: 'constructor', repo: 'a/b' }] }).areas[0].items[0].repo, 'a/b');
});

test('AC-3: a map without prefixes or a Repositories line is read as before', () => {
  const now = at('2026-11-12T00:00:00Z');
  const old = mapStatus(parseProductMap(MAP), { now });
  for (const parsed of [parseProductMap(MAP), parseProductMap(MAP, { repos: REPOS })]) {
    assert.equal(parsed.title, 'Acme Shop');
    assert.deepEqual(parsed.reviewed, { date: '2026-11-01', by: 'ana-p' });
    assert.deepEqual(parsed.areas.map((a) => a.name), ['Buy a product', 'Track an order']);
    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(parsed.mapped, []);
    assert.deepEqual(parsed.unknown_repos, []);
    assert.ok(parsed.areas.flatMap((a) => a.items).every((i) => i.repo === null));
    for (const repos of [undefined, REPOS]) {
      const s = mapStatus(parsed, { now, repos });
      assert.deepEqual([s.state, s.age_days, s.problems, s.summary], [old.state, old.age_days, old.problems, old.summary]);
    }
  }
});

test('AC-4: the Repositories line names the repositories the map covers', () => {
  const read = (line, extra = '') => parseProductMap(`# Product map: Shop\nReviewed: 2026-11-01 by ana\n${line}\n${extra}## a\n- s [confirmed]\n`, { repos: REPOS });
  for (const line of ['Repositories: storefront-web, payments-api', 'Repositorios: Storefront-Web, PAYMENTS-API', 'Repositórios: payments-api, payments-api', 'repositories:payments-api,,  ']) {
    const m = read(line);
    assert.deepEqual(m.mapped, ['acme/payments-api'], line);
    assert.deepEqual(m.problems, [], line);
  }
  assert.deepEqual(parseProductMap(`${REVIEWED}## a\n- s [confirmed]\n`, { repos: REPOS }).mapped, []);
  const ghost = read('Repositories: payments-api, ghost');
  assert.deepEqual(ghost.unknown_repos, ['ghost']);
  assert.equal(ghost.problems.length, 1);
  assert.match(ghost.problems[0], /ghost/);
  const two = read('Repositories: payments-api', 'Repositories: acme/web\n');
  assert.deepEqual(two.mapped, ['acme/payments-api']);
  assert.equal(two.problems.length, 1);
  assert.match(two.problems[0], /Repositories/);
  assert.deepEqual(read('Repositories:').mapped, []);
});

test('AC-5: mapStatus reports which related repositories the map covers without changing the state', () => {
  const repos = [{ name: 'payments-api', repo: 'acme/payments-api' }, { name: 'design-tokens', repo: 'acme/design-tokens' }, { name: 'storefront-web', repo: null }];
  const now = at('2026-11-12T00:00:00Z');
  const read = (line) => parseProductMap(`${REVIEWED}${line ? `${line}\n` : ''}## a\n- s [confirmed]\n`, { repos });
  const status = (line, opts = {}) => mapStatus(read(line), { now, repos, ...opts });
  assert.deepEqual(status('Repositories: storefront-web, payments-api, design-tokens').repositories, { mapped: ['acme/payments-api', 'acme/design-tokens'], not_mapped: [] });
  assert.deepEqual(status('Repositories: payments-api').repositories, { mapped: ['acme/payments-api'], not_mapped: ['acme/design-tokens'] });
  assert.deepEqual(status('').repositories, { mapped: [], not_mapped: ['acme/payments-api', 'acme/design-tokens'] });
  assert.deepEqual(mapStatus(null, { repos }).repositories, { mapped: [], not_mapped: ['acme/payments-api', 'acme/design-tokens'] });
  assert.deepEqual(status('', { repos: [repos[2]] }).repositories, { mapped: [], not_mapped: [] });
  assert.deepEqual(status('', { repos: [] }).repositories, { mapped: [], not_mapped: [] });
  const plain = mapStatus(parseProductMap(`${REVIEWED}## a\n- s [confirmed]\n`), { now });
  assert.equal(plain.state, 'reviewed');
  const same = status('Repositories: payments-api');
  assert.deepEqual([same.state, same.age_days, same.problems, same.summary], [plain.state, plain.age_days, plain.problems, plain.summary]);
  const unknown = status('Repositories: ghost');
  assert.equal(unknown.state, 'reviewed');
  assert.deepEqual(unknown.problems, []);
  assert.equal(unknown.summary, plain.summary);
  assert.equal(mapStatus(read('Repositories: payments-api\nRepositories: design-tokens'), { now, repos }).state, 'draft');
  assert.equal(status('Repositories: payments-api', { now: at('2027-06-01T00:00:00Z') }).state, 'stale');
});

test('AC-6: product_map names the repository of each source and the related repositories it covers', async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { factoryTools } = await import('../factory/lib/mcp/tools.js');
  const day = new Date().toISOString().slice(0, 10);
  const map = `# Product map: Shop\nReviewed: ${day} by ana\nRepositories: storefront-web, payments-api, ghost\n\n## Pay\n- Retries a payment. [assumed] (source: payments-api:src/config/retry.ts)\n- Shows the cart. [confirmed]\n`;
  const run = (config, withMap = true) => {
    const root = mkdtempSync(join(tmpdir(), 'eminzo-map-repos-'));
    mkdirSync(join(root, 'factory'));
    if (withMap) writeFileSync(join(root, 'factory/product-map.md'), map);
    if (config !== undefined) writeFileSync(join(root, 'factory/config.json'), typeof config === 'string' ? config : JSON.stringify(config));
    return factoryTools({ root }).find((t) => t.name === 'product_map').run({});
  };
  const team = { repo: 'acme/storefront-web', related_repos: [{ repo: 'acme/payments-api', description: 'Payments.' }, { repo: 'acme/design-tokens', description: 'Tokens.' }] };
  const r = run(team);
  assert.equal(r.state, 'reviewed');
  assert.deepEqual(r.repositories, { mapped: ['acme/payments-api'], not_mapped: ['acme/design-tokens'] });
  assert.deepEqual(r.areas[0].items.map((i) => i.repo), ['acme/payments-api', null]);
  assert.ok(r.problems.some((p) => /ghost/.test(p)));
  assert.equal('mapped' in r, false);
  assert.equal('unknown_repos' in r, false);
  for (const config of [{ repo: 'acme/storefront-web' }, undefined, '{not json']) {
    const bare = run(config);
    assert.deepEqual(bare.repositories, { mapped: [], not_mapped: [] });
    assert.equal(bare.areas[0].items[0].repo, null);
  }
  assert.deepEqual(run(team, false).repositories, { mapped: [], not_mapped: ['acme/payments-api', 'acme/design-tokens'] });
});
