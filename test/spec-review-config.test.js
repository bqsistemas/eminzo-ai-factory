// Job 162: the spec_review key. specReviewFor is the one place that answers "does this risk
// need a spec review?"; config.local.json may set the key either way (it wins over the team).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OVERRIDABLE, Refused, SPEC_REVIEW_RISKS, specReviewFor, validateLocal } from '../factory/lib/util.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const configText = readFileSync(join(repo, 'factory/config.json'), 'utf8');

function rootWith(team, local) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-spec-review-config-'));
  mkdirSync(join(dir, 'factory'), { recursive: true });
  writeFileSync(join(dir, 'factory/config.json'), JSON.stringify({ ...JSON.parse(configText), ...team }, null, 2));
  if (local !== undefined) writeFileSync(join(dir, 'factory/config.local.json'), JSON.stringify(local));
  return dir;
}

const jobCli = (dir, ...args) => spawnSync('sh', [join(repo, 'factory/bin/job'), ...args], {
  encoding: 'utf8', cwd: dir, env: { ...process.env, FACTORY_ROOT: dir },
});

test('AC-1: specReviewFor resolves missing, false, true and a list of risks', () => {
  assert.deepEqual([...SPEC_REVIEW_RISKS], ['low', 'medium', 'high']);
  for (const risk of SPEC_REVIEW_RISKS) {
    assert.equal(specReviewFor({}, risk), false, `missing, ${risk}`);
    assert.equal(specReviewFor({ spec_review: false }, risk), false, `false, ${risk}`);
    assert.equal(specReviewFor({ spec_review: true }, risk), true, `true, ${risk}`);
    assert.equal(specReviewFor({ spec_review: [] }, risk), false, `[], ${risk}`);
  }
  assert.equal(specReviewFor({ spec_review: ['high'] }, 'high'), true);
  assert.equal(specReviewFor({ spec_review: ['high'] }, 'medium'), false);
  assert.equal(specReviewFor({ spec_review: ['high'] }, 'low'), false);
  assert.equal(specReviewFor({ spec_review: ['low', 'medium'] }, 'medium'), true);
});

test('AC-1: specReviewFor refuses any other value and names spec_review', () => {
  for (const value of ['yes', ['urgent'], null, {}, 1, ['high', 3]]) {
    assert.throws(() => specReviewFor({ spec_review: value }, 'high'), (err) => err instanceof Refused && /spec_review/.test(err.message),
      JSON.stringify(value));
  }
});

test('AC-1: spec_review is overridable and validateLocal uses the same rule', () => {
  assert.ok(OVERRIDABLE.includes('spec_review'));
  const team = JSON.parse(configText);
  for (const value of [false, true, [], ['high'], ['low', 'medium', 'high']]) {
    assert.doesNotThrow(() => validateLocal(team, { spec_review: value }), JSON.stringify(value));
  }
  for (const value of ['yes', ['urgent'], null, {}, 0]) {
    assert.throws(() => validateLocal(team, { spec_review: value }), (err) => err instanceof Refused
      && err.message.startsWith('config.local.json: spec_review: '), JSON.stringify(value));
  }
});

test('AC-1: the local value wins over the team value in both directions (job config spec_review)', () => {
  let res = jobCli(rootWith({ spec_review: true }, { spec_review: false }), 'config', 'spec_review');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'spec_review local false');
  res = jobCli(rootWith({ spec_review: false }, { spec_review: ['high'] }), 'config', 'spec_review');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'spec_review local ["high"]');
  res = jobCli(rootWith({ spec_review: false }, { spec_review: true }), 'config', 'spec_review');
  assert.equal(res.stdout.trim(), 'spec_review local true');
  res = jobCli(rootWith({ spec_review: false }), 'config', 'spec_review');
  assert.equal(res.stdout.trim(), 'spec_review team false');
});

test('AC-1: a config.local.json with spec_review "yes" is refused with the key', () => {
  const res = jobCli(rootWith({ spec_review: false }, { spec_review: 'yes' }), 'config', 'spec_review');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /config\.local\.json: spec_review: /);
});

test('AC-6: config.json and the template default spec_review to false', () => {
  for (const path of ['factory/config.json', 'factory/templates/config.json']) {
    const config = JSON.parse(readFileSync(join(repo, path), 'utf8'));
    assert.equal(config.spec_review, false, path);
  }
});
