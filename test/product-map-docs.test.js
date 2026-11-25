// Job 067: the docs describe the repository prefix, the Repositories line and the new fields of the product map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

test('AC-8: docs name the prefix, the Repositories line and the new fields', () => {
  const doc = read('docs/product-stage.md');
  const start = doc.indexOf('## The functional map');
  const rest = doc.slice(start + 1);
  const end = rest.search(/\n## (?!<)/);
  const section = doc.slice(start, end < 0 ? undefined : start + 1 + end);
  for (const word of ['<name>:', 'Repositories', 'Repositorios', 'Repositórios', '`repo`', '`repositories`', '`mapped`', '`not_mapped`']) assert.ok(section.includes(word), word);
  const row = read('docs/mcp.md').split('\n').find((l) => l.startsWith('| `product_map` |'));
  assert.ok(row, 'the product_map row');
  assert.ok(row.includes('repositories') && row.includes('repo'), 'the row names repositories and repo');
});
