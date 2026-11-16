// A job's files appear while board.json stays the same (a stage writes intake.md, build.md, round-N/ reviews before the stage moves).
// A file that was not written yet must not be remembered as missing, or the open job shows "not written" until a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createArtifactCache } from '../factory/artifact-cache.js';

const dashboard = readFileSync(new URL('../factory/dashboard.js', import.meta.url), 'utf8');

test('a file that is not written yet is read again, and one that is written is read once', async () => {
  const disk = new Map();
  let reads = 0;
  const cache = createArtifactCache(async (url) => { reads += 1; return disk.has(url) ? disk.get(url) : null; });
  assert.equal(await cache.load('001-a/build.md', 'u1'), null);
  disk.set('u1', '# Build');
  assert.equal(await cache.load('001-a/build.md', 'u1'), '# Build', 'the file that appeared is found without a reload');
  assert.equal(await cache.load('001-a/build.md', 'u1'), '# Build');
  assert.equal(reads, 2, 'a hit is cached');
  cache.clear();
  await cache.load('001-a/build.md', 'u1');
  assert.equal(reads, 3, 'clear forgets the hits');
});

test('a failed read counts as not written and is retried', async () => {
  let calls = 0;
  const cache = createArtifactCache(async () => { calls += 1; if (calls === 1) throw new Error('offline'); return 'ok'; });
  assert.equal(await cache.load('k', 'u'), null);
  assert.equal(await cache.load('k', 'u'), 'ok');
});

test('the dashboard reads through the cache and looks again for missing files of the open job', () => {
  assert.match(dashboard, /createArtifactCache\(/);
  assert.doesNotMatch(dashboard, /const cache = new Map\(\)/);
  assert.match(dashboard, /retryMissing\(\)/);
  assert.match(dashboard, /classList\.toggle\('pipeline-missing', !available\)/);
});
