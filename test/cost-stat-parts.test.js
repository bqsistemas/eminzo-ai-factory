import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { costStatParts } from '../factory/office.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const html = dashboardSource();
const dict = JSON.parse(html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/)[1]);

test('AC-1: costStatParts gives compact value, title and label per language', () => {
  const es = costStatParts(91.58, 4, dict.es);
  assert.equal(es.value, '$91.58 + 4 N/D');
  assert.equal(es.title, '4 jobs con costo no disponible');
  assert.equal(es.label, '$91.58 + 4 jobs con costo no disponible');
  assert.equal(costStatParts(91.58, 4, dict.en).value, '$91.58 + 4 N/A');
  assert.equal(costStatParts(91.58, 4, dict.pt).value, '$91.58 + 4 N/D');
});

test('AC-2: singular title uses costUnavailableTitleOne', () => {
  for (const l of ['en', 'es', 'pt']) assert.equal(costStatParts(2, 1, dict[l]).title, dict[l].costUnavailableTitleOne);
  assert.equal(costStatParts(2, 1, dict.en).title, '1 job with unavailable cost');
});

test('AC-3: null for invalid inputs and English fallbacks without dictionary', () => {
  assert.equal(costStatParts(2, 0, dict.en), null);
  assert.equal(costStatParts(0, 3, dict.en), null);
  assert.equal(costStatParts(2, undefined, dict.en), null);
  const p = costStatParts(5, 2);
  assert.equal(p.value, '$5.00 + 2 N/A');
  assert.equal(p.title, '2 jobs with unavailable cost');
});

test('AC-4: dictionaries carry the new keys and keep the old ones', () => {
  const want = {
    en: ['{n} N/A', '{n} jobs with unavailable cost', '1 job with unavailable cost', 'Cost unavailable', '{n} unavailable'],
    es: ['{n} N/D', '{n} jobs con costo no disponible', '1 job con costo no disponible', 'Costo no disponible', '{n} no disponibles'],
    pt: ['{n} N/D', '{n} jobs com custo indisponível', '1 job com custo indisponível', 'Custo indisponível', '{n} indisponíveis'],
  };
  for (const [l, [a, b, c, d, e]] of Object.entries(want)) {
    assert.equal(dict[l].costUnavailableShort, a);
    assert.equal(dict[l].costUnavailableTitle, b);
    assert.equal(dict[l].costUnavailableTitleOne, c);
    assert.equal(dict[l].costUnavailable, d);
    assert.equal(dict[l].costUnavailableCount, e);
  }
});

test('AC-5: dashboard wires costStatParts, title and aria-label', () => {
  assert.match(html, /import \{[^}]*costStatParts[^}]*\} from '\.\/office\.js'/);
  assert.match(html, /costStatParts\(s\.cost, s\.cost_unavailable, T\)/);
  assert.match(html, /setAttribute\('title', costParts\.title\)/);
  assert.match(html, /setAttribute\('aria-label', costParts\.label\)/);
  assert.match(html, /removeAttribute\('title'\)/);
  assert.match(html, /removeAttribute\('aria-label'\)/);
});

test('AC-5: header keeps the amount in the value and the suffix on the label, with role group', () => {
  assert.match(html, /costParts\.amount/);
  assert.match(html, /setAttribute\('role', 'group'\)/);
  assert.match(html, /removeAttribute\('role'\)/);
});
