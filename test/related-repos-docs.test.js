// Job 064: the guides document related_repos and related_checkouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const file of ['docs/guide.md', 'cli/README.md']) {
  test(`AC-8: ${file} documents related_repos, related_checkouts and the doctor check`, () => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(text, /related_repos/);
    assert.match(text, /related_checkouts/);
    assert.match(text, /related_checkouts[^\n]*config\.local\.json|config\.local\.json[^\n]*related_checkouts/);
    const row = text.split('\n').find((l) => l.startsWith('| `eminzo doctor`'));
    assert.match(row, /related repositories/i);
  });
}
