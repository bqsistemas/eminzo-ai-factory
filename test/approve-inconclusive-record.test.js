// Issue 159: factory/bin/approve records every inconclusive result in job.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, ID, git, inconclusive } from './helpers/approve-fixture.js';
import { stageModels } from '../factory/lib/route.js';

const jobOf = (t) => JSON.parse(readFileSync(join(t.root, 'factory/jobs', ID, 'job.json'), 'utf8'));
const secure = () => fixture({ job: { intake: { decision: 'ACCEPT', risk: 'low', surfaces: ['security'], rescoped: false } } });

test('AC-4: an inconclusive result is recorded with round, head, reasons and flags', () => {
  const t = secure();
  inconclusive(t, /security surface/);
  const list = jobOf(t).approval_inconclusive;
  assert.equal(list.length, 1);
  const [e] = list;
  assert.equal(e.round, 1);
  assert.equal(e.head, git(t.root, 'rev-parse', `factory/${ID}`));
  assert.ok(e.at);
  const printed = t.run().stdout.replace(/^inconclusive: /, '').trim();
  assert.equal(e.reasons.join('; '), printed);
});

test('AC-5: a rerun on the same round and head replaces the entry; approve does not add one', () => {
  const t = secure();
  inconclusive(t, /security surface/);
  inconclusive(t, /security surface/);
  assert.equal(jobOf(t).approval_inconclusive.length, 1);
  const ok = fixture({ job: { approval_inconclusive: [{ round: 1, head: 'abc', at: 'x', reasons: [], flags: [] }] } });
  const res = ok.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'approve');
  assert.equal(jobOf(ok).approval_inconclusive.length, 1);
});

test('AC-6: a low-risk security job stays inconclusive and its approver-llm is sonnet', () => {
  const t = secure();
  inconclusive(t, /security surface/);
  assert.ok(jobOf(t).approval_inconclusive[0].flags.includes('security surface'));
  const config = JSON.parse(readFileSync(new URL('../factory/config.json', import.meta.url), 'utf8'));
  assert.equal(stageModels(config, 'claude', 'low')['approver-llm'], 'sonnet');
});
