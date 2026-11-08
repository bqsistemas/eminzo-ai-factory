import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

// Key paths down to (not into) arrays and scalars; keys under repo-specific maps are values, not shape.
function shape(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => shape(v, prefix ? `${prefix}.${k}` : k));
}

test('factory/templates/config.json has the same keys as factory/config.json (no drift)', () => {
  const own = read('factory/config.json');
  const template = read('factory/templates/config.json');
  // `visual` is the one deliberate difference: this repo's points at its own dashboard demo, which other repos do not have.
  const withoutVisual = shape(own).filter((k) => k !== 'visual' && !k.startsWith('visual.'));
  assert.deepEqual(shape(template).sort(), withoutVisual.sort());
  assert.equal('visual' in template, false);
});

test('the template keeps models, lanes, routing and prices identical to this repo', () => {
  const own = read('factory/config.json');
  const template = read('factory/templates/config.json');
  for (const key of ['models', 'lanes', 'routing', 'providers', 'prices', 'concurrency', 'max_rounds', 'auto_merge', 'language', 'default_provider']) {
    assert.deepEqual(template[key], own[key], key);
  }
});

test('the template carries placeholders and nothing repo-specific', () => {
  const template = read('factory/templates/config.json');
  assert.equal(template.repo, '__REPO__');
  assert.equal(template.base, '__BASE__');
  assert.deepEqual(template.protected_tests, []);
  assert.doesNotMatch(JSON.stringify(template.review_paths), /factory\//);
});
