// A job's files appear while board.json stays the same (a stage writes intake.md, build.md, round-N/ reviews before the stage moves).
// A file that was not written yet must not be remembered as missing, or the open job shows "not written" until a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createArtifactCache, newlyWritten } from '../factory/artifact-cache.js';

const dashboard = readFileSync(new URL('../factory/dashboard.js', import.meta.url), 'utf8');

test('a file that is not written yet is read again, and one that is written is read once', async () => {
  const disk = new Map();
  let reads = 0;
  const cache = createArtifactCache(async (url) => { reads += 1; return disk.has(url) ? disk.get(url) : null; });
  assert.equal(await cache.load('001-a/build.md', 'u1'), null);
  disk.set('u1', '# Build');
  cache.beginPoll();
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
  cache.beginPoll();
  assert.equal(await cache.load('k', 'u'), 'ok');
});

test('an empty body is not written yet, and is read again', async () => {
  let body = '';
  const cache = createArtifactCache(async () => body);
  assert.equal(await cache.load('k', 'u'), null);
  body = '# Done';
  cache.beginPoll();
  assert.equal(await cache.load('k', 'u'), '# Done');
});

test('a hit is dropped by clear, so a rewritten file is read again after a board change', async () => {
  let body = '# half';
  const cache = createArtifactCache(async () => body);
  assert.equal(await cache.load('k', 'u'), '# half');
  body = '# complete';
  assert.equal(await cache.load('k', 'u'), '# half');
  cache.clear();
  assert.equal(await cache.load('k', 'u'), '# complete');
});

test('newlyWritten finds only the files that appeared, and never asks about a job in a final stage', async () => {
  const disk = new Map([['u/spec.md', '# Spec']]);
  const cache = createArtifactCache(async (url) => disk.get(url) ?? null);
  const urlOf = (f) => `u/${f}`;
  const job = { id: '001-a', stage: 'build' };
  assert.deepEqual(await newlyWritten(job, ['spec.md', 'build.md'], cache, urlOf), [{ file: 'spec.md', text: '# Spec' }]);
  disk.set('u/build.md', '# Build');
  cache.beginPoll();
  assert.deepEqual(await newlyWritten(job, ['build.md'], cache, urlOf), [{ file: 'build.md', text: '# Build' }]);
  let reads = 0;
  const counting = createArtifactCache(async () => { reads += 1; return null; });
  for (const stage of ['merged', 'rejected', 'closed']) assert.deepEqual(await newlyWritten({ id: '002-b', stage }, ['x.md'], counting, urlOf), []);
  assert.equal(reads, 0);
});

test('a file that keeps missing is asked for less and less often', async () => {
  let reads = 0;
  const cache = createArtifactCache(async () => { reads += 1; return null; });
  const job = { id: '001-a', stage: 'build' };
  for (let i = 0; i < 40; i += 1) { cache.beginPoll(); await newlyWritten(job, ['x.md'], cache, () => 'u'); }
  assert.ok(reads >= 5 && reads <= 12, `40 polls made ${reads} reads`);
  cache.clear();
  await newlyWritten(job, ['x.md'], cache, () => 'u');
  assert.equal(reads >= 6, true);
});

test('the drawer retry updates only the button, selects with a literal comparison and is caught', () => {
  assert.doesNotMatch(dashboard, /\.file\.missing\[data-file=/);
  assert.match(dashboard, /retryMissing\(\)\.catch\(/);
  assert.match(dashboard, /cache\.clear\(\);[^\n]*\n\s*if \(openJob\) openDrawer/);
});

test('two views asking about the same file in one poll advance its back-off once', async () => {
  const run = async (viewsPerPoll) => {
    let reads = 0;
    const cache = createArtifactCache(async () => { reads += 1; return null; });
    const job = { id: '001-a', stage: 'build' };
    for (let poll = 0; poll < 40; poll += 1) {
      cache.beginPoll();
      for (let view = 0; view < viewsPerPoll; view += 1) await newlyWritten(job, ['x.md'], cache, () => 'u');
    }
    return reads;
  };
  const one = await run(1);
  const two = await run(2);
  assert.equal(two, one, 'a second view in the same poll changes nothing');
});

test('the dashboard starts a poll on the cache before it looks for missing files', () => {
  assert.match(dashboard, /cache\.beginPoll\(\)/);
});
