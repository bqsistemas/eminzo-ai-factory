// The dashboard is three files: the markup (with the i18n block and the theme init, which must
// run before the first paint), the styles and the module. An agent changing one reads one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CSS_LINK, MODULE_TAG, dashboardSource } from './helpers/dashboard-source.js';

const read = (name) => readFileSync(new URL(`../factory/${name}`, import.meta.url), 'utf8');
const html = read('dashboard.html');

test('dashboard.html links dashboard.css and loads dashboard.js, with no inline style or module', () => {
  assert.equal(html.split(CSS_LINK).length, 2, 'one stylesheet link');
  assert.equal(html.split(MODULE_TAG).length, 2, 'one module script');
  assert.doesNotMatch(html, /<style[\s>]/);
  assert.doesNotMatch(html, /<script type="module">/);
  assert.ok(html.indexOf('id="theme-init"') < html.indexOf(CSS_LINK), 'the theme init runs before the stylesheet');
  assert.match(html, /<script type="application\/json" id="i18n">/);
});

test('the styles and the module live in their own files', () => {
  assert.match(read('dashboard.css'), /:root/);
  assert.match(read('dashboard.js'), /from '\.\/activity\.js'/);
  assert.match(read('dashboard.js'), /from '\.\/pipeline-canvas\.js'/);
});

test('the reassembled source holds the markup, the styles and the module once each', () => {
  const source = dashboardSource();
  assert.equal(source.split('<style>').length, 2);
  assert.equal(source.split('<script type="module">').length, 2);
  assert.ok(source.length > html.length + 1000);
});
