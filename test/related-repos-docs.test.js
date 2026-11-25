// Job 064: the guides document related_repos and related_checkouts. Job 066: setup describes the related repositories.
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
    assert.match(row, /not in setup|setup/i);
  });
}

for (const file of ['docs/guide.md', 'cli/README.md']) {
  test(`AC-8: ${file} no longer says nothing uses the list`, () => {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /Nothing uses the list yet/);
  });
}

test('AC-8: the guide documents related, the coverage line and setup_status; docs/mcp.md has a setup_status row', () => {
  const guide = readFileSync(new URL('../docs/guide.md', import.meta.url), 'utf8');
  const setup = guide.slice(guide.indexOf('### 8. Run setup'), guide.indexOf('### 9.'));
  for (const word of ['related', 'eminzo:setup-related', 'setup_status']) assert.ok(setup.includes(word), `setup section names ${word}`);
  const row = guide.split('\n').find((l) => l.startsWith('| `eminzo doctor`'));
  assert.match(row, /related repositories[^|]*not in setup|not in setup[^|]*related repositories/i);
  assert.match(guide, /^\| `eminzo related` \|/m);
  assert.match(readFileSync(new URL('../docs/mcp.md', import.meta.url), 'utf8'), /^\| `setup_status` \|/m);
});

test('AC-8: the project template has an optional Related repositories section and REQUIRED_SECTIONS is unchanged', async () => {
  const template = readFileSync(new URL('../factory/templates/project.md', import.meta.url), 'utf8');
  const heading = template.split('\n').find((l) => l.startsWith('## Related repositories'));
  assert.ok(heading && /optional/i.test(heading), heading);
  assert.match(template, /^### <name>/m);
  assert.match(template, /<name>:<path>:<line>|<name>:src\/[^\n]*:\d+/);
  assert.match(template, /Not analysed/);
  const { REQUIRED_SECTIONS } = await import('../factory/lib/project-map.js');
  assert.ok(!REQUIRED_SECTIONS.some((s) => /related/i.test(s)));
});
