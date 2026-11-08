import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dashboardSource } from './helpers/dashboard-source.js';

const html = dashboardSource();

test('AC-1: the header h1 reads exactly "AI Software Factory"', () => {
  const h1 = html.match(/<header class="top">\s*<h1>([^<]*)<\/h1>/);
  assert.ok(h1, 'h1 is the first child of header.top');
  assert.equal(h1[1], 'AI Software Factory');
});

test('AC-2: the document title reads exactly "Samuel Factory"', () => {
  assert.equal(html.match(/<title>([^<]*)<\/title>/)?.[1], 'Samuel Factory');
});

test('AC-2: the guide eyebrow reads exactly "Samuel Factory"', () => {
  assert.equal(html.match(/<span class="eyebrow">([^<]*)<\/span>/)?.[1], 'Samuel Factory');
});

test('AC-3: no "Factory Board" and no h1 reading exactly "Software Factory"', () => {
  assert.ok(!html.includes('Factory Board'));
  assert.ok(!/<h1>Software Factory<\/h1>/.test(html));
});

test('AC-4: "AI Software Factory" appears only in the header h1', () => {
  const rest = html.replace(/<header class="top">\s*<h1>[^<]*<\/h1>/, '<header class="top">');
  assert.ok(!rest.includes('AI Software Factory'));
});

test('AC-4: the i18n dictionaries do not contain the product name', () => {
  const json = html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/)[1];
  assert.ok(Object.keys(JSON.parse(json)).length > 0);
  assert.ok(!json.includes('Samuel Factory'));
  assert.ok(!json.includes('AI Software Factory'));
});
