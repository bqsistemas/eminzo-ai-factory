// The functional map of the product: a reviewed markdown file that says how the product works today, in
// functional language, with every statement labelled confirmed or assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STALE_AFTER_DAYS, mapStatus, parseProductMap, productMapTemplate } from '../factory/lib/product-map.js';

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

test('parseProductMap reads title, review line, areas, items, basis and source', () => {
  const m = parseProductMap(MAP);
  assert.equal(m.title, 'Acme Shop');
  assert.deepEqual(m.reviewed, { date: '2026-11-01', by: 'ana-p' });
  assert.deepEqual(m.problems, []);
  assert.deepEqual(m.areas.map((a) => a.name), ['Buy a product', 'Track an order']);
  assert.deepEqual(m.areas[0].items, [
    { text: 'A visitor can add a product to the cart without an account.', basis: 'confirmed', source: null },
    { text: 'Paying with a gift card is possible.', basis: 'assumed', source: 'checkout screen' },
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
