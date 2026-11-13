// Brief approval: a marker bound to a hash of the brief's content. Any later edit breaks the binding, and only an
// approved brief opens the gate that issue creation must pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { APPROVAL_PATTERN, approveBrief, briefHash, briefStatus, canonicalBrief } from '../factory/lib/brief-approval.js';
import { renderBrief } from '../factory/lib/brief.js';

const BRIEF = {
  title: 'Suggestion filter',
  sections: {
    problem: 'Reviewers waste time.', audience: 'Reviewers.', value: 'Less time.', today: 'Everything together.',
    scope: '- Filter.', out_of_scope: '- Email.',
  },
  criteria: [{ id: 'BC-1', text: 'A reviewer sees only what is pending.' }],
  deliverables: [{ id: 'D1', title: 'See what is pending', size: 's', risk: 'low', covers: ['BC-1'], after: [] }],
};
const READY = renderBrief(BRIEF, 'en');
const AT = '2026-11-12T15:00:00.000Z';

test('canonicalBrief ignores the marker, line endings and trailing whitespace', () => {
  const marked = `${READY.trimEnd()}\n<!-- eminzo:approved sha256=${'a'.repeat(64)} by=ana at=${AT} -->\n`;
  assert.equal(canonicalBrief(marked), canonicalBrief(READY));
  assert.equal(canonicalBrief(READY.replace(/\n/g, '\r\n')), canonicalBrief(READY));
  assert.equal(canonicalBrief(`${READY}\n\n\n`), canonicalBrief(READY));
  assert.equal(canonicalBrief(READY.replace('## Scope\n', '## Scope   \n')), canonicalBrief(READY));
  assert.notEqual(canonicalBrief(READY.replace('Filter.', 'Filter it.')), canonicalBrief(READY));
});

test('briefHash is 64 hex characters and stable', () => {
  assert.match(briefHash(READY), /^[0-9a-f]{64}$/);
  assert.equal(briefHash(READY), briefHash(`${READY}\n`));
});

test('approveBrief adds exactly one marker bound to the hash, replacing an old one', () => {
  const once = approveBrief(READY, { by: 'ana-p', at: AT });
  assert.equal(once.split('\n').filter((l) => APPROVAL_PATTERN.test(l)).length, 1);
  assert.match(once, new RegExp(`<!-- eminzo:approved sha256=${briefHash(READY)} by=ana-p at=${AT} -->`));
  const twice = approveBrief(once, { by: 'bo', at: '2026-11-13T09:00:00.000Z' });
  assert.equal(twice.split('\n').filter((l) => APPROVAL_PATTERN.test(l)).length, 1);
  assert.match(twice, /by=bo /);
  assert.equal(briefHash(twice), briefHash(READY));
});

test('approveBrief refuses a brief with problems, with a sentence a person understands', () => {
  assert.throws(() => approveBrief(READY.replace('- BC-1: A reviewer sees only what is pending.', ''), { by: 'ana', at: AT }), /The brief cannot be approved yet: /);
  assert.throws(() => approveBrief('not a brief', { by: 'ana', at: AT }), /The brief cannot be approved yet: /);
});

test('approveBrief validates who approved and when', () => {
  for (const by of ['', 'ana bo', '-ana', 'a'.repeat(40), 'ana>', undefined]) {
    assert.throws(() => approveBrief(READY, { by, at: AT }), /GitHub login/, String(by));
  }
  for (const at of ['yesterday', '', undefined, '2026-13-45T00:00:00Z']) {
    assert.throws(() => approveBrief(READY, { by: 'ana', at }), /date/, String(at));
  }
});

test('briefStatus: draft when the brief has problems', () => {
  const s = briefStatus('# Brief: x\n');
  assert.equal(s.state, 'draft');
  assert.equal(s.ok, false);
  assert.ok(s.problems.length > 0);
  assert.equal(s.can_create_issues, false);
  assert.equal(s.approval, null);
  assert.match(s.reason, /^The brief cannot be approved yet: /);
});

test('briefStatus: ready when complete and not approved', () => {
  const s = briefStatus(READY);
  assert.equal(s.state, 'ready');
  assert.equal(s.ok, true);
  assert.equal(s.can_create_issues, false);
  assert.equal(s.reason, 'The brief is not approved yet.');
});

test('briefStatus: approved only while the hash matches', () => {
  const approved = approveBrief(READY, { by: 'ana', at: AT });
  const s = briefStatus(approved);
  assert.equal(s.state, 'approved');
  assert.equal(s.can_create_issues, true);
  assert.deepEqual(s.approval, { by: 'ana', at: AT, hash: briefHash(READY) });
  assert.equal(briefStatus(approved.replace('Filter.', 'Filter it.')).state, 'changed');
  const changed = briefStatus(approved.replace('Filter.', 'Filter it.'));
  assert.equal(changed.can_create_issues, false);
  assert.equal(changed.reason, 'The brief changed after it was approved on 2026-11-12; approve it again.');
  assert.equal(changed.approval.by, 'ana');
});

test('briefStatus: a malformed marker does not approve anything', () => {
  const forged = `${READY}<!-- eminzo:approved sha256=${briefHash(READY)} by=ana -->\n`;
  assert.notEqual(briefStatus(forged).state, 'approved');
  assert.equal(briefStatus(forged).can_create_issues, false);
});

test('briefStatus: two markers are never trusted', () => {
  const approved = approveBrief(READY, { by: 'ana', at: AT });
  const doubled = `${approved}<!-- eminzo:approved sha256=${briefHash(READY)} by=bo at=${AT} -->\n`;
  const s = briefStatus(doubled);
  assert.equal(s.state, 'changed');
  assert.equal(s.can_create_issues, false);
  assert.match(s.reason, /more than one approval marker/);
});
