// Hand-off: the texts of the brief issue and of the deliverable issues, built only behind the approval gate.
// Nothing here talks to GitHub: the Eminzo desktop creates the issues after the person confirms.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { approveBrief } from '../factory/lib/brief-approval.js';
import {
  BRIEF_ISSUE_LABEL, DELIVERABLE_LABEL, briefIssueDraft, briefIssueValidity, deliverableIssueDrafts, parseBriefIssueMarker, parseDeliverableMarker,
} from '../factory/lib/handoff.js';

const BRIEF = [
  '<!-- eminzo:brief v1 -->', '# Brief: Pending suggestions filter', '',
  '## Problem', '', 'Reviewers lose time.', '',
  '## For whom', '', 'Reviewers.', '',
  '## Expected value', '', 'Less time.', '',
  '## How it works today', '', 'Everything is mixed.', '',
  '## Scope', '', '- A filter.', '',
  '## Out of scope', '', '- Emails.', '',
  '## Acceptance criteria', '',
  '- BC-1: A reviewer sees only what is pending.',
  '- BC-2: The filter is remembered.', '',
  '## Deliverables', '',
  '- D1: Remember the filter | size: s | risk: low | covers: BC-2 | after: D3',
  '- D2: Polish the list | size: xs | risk: low | covers: BC-1 | after: D1, D3',
  '- D3: Show only pending | size: m | risk: medium | covers: BC-1',
  '',
].join('\n');
const AT = '2026-11-12T15:00:00Z';
const approved = () => approveBrief(BRIEF, { by: 'ana-p', at: AT });

test('both builders refuse a brief the gate has not opened, with the gate reason', () => {
  for (const text of [BRIEF, '# Brief: x\n', approved().replace('Less time.', 'Much less time.')]) {
    assert.throws(() => briefIssueDraft(text), /^Error: The brief (is not approved yet\.|cannot be approved yet: |changed after it was approved)/);
    assert.throws(() => deliverableIssueDrafts(text, { briefIssue: 7 }), /^Error: The brief (is not approved yet\.|cannot be approved yet: |changed after it was approved)/);
  }
});

test('the brief issue is the approved text exactly, plus one hidden line, labeled eminzo-brief', () => {
  const text = approved();
  const draft = briefIssueDraft(text);
  assert.equal(draft.title, 'Brief: Pending suggestions filter');
  assert.deepEqual(draft.labels, [BRIEF_ISSUE_LABEL]);
  assert.equal(BRIEF_ISSUE_LABEL, 'eminzo-brief');
  const hash = /sha256=([0-9a-f]{64})/.exec(text)[1];
  assert.equal(draft.body, `${text.trimEnd()}\n\n<!-- eminzo:brief-issue v1 hash=${hash} -->\n`);
  assert.deepEqual(parseBriefIssueMarker(draft.body), { hash });
  assert.equal(draft.labels.includes('factory'), false);
});

test('a brief issue body passes the approval check until anything is edited', () => {
  const body = briefIssueDraft(approved()).body;
  const ok = briefIssueValidity(body);
  assert.equal(ok.valid, true);
  assert.equal(ok.approval.by, 'ana-p');
  assert.equal(ok.approval.at, AT);
  assert.equal(briefIssueValidity(body.replace('Less time.', 'More time.')).valid, false);
  assert.match(briefIssueValidity(body.replace('Less time.', 'More time.')).reason, /changed after it was approved/);
  assert.equal(briefIssueValidity('just text').valid, false);
  const swapped = body.replace(/hash=[0-9a-f]{64} -->\n$/, `hash=${'0'.repeat(64)} -->\n`);
  assert.equal(briefIssueValidity(swapped).valid, false, 'a hidden line that points at another approval is not valid');
});

test('titles are capped', () => {
  const long = BRIEF.replace('Pending suggestions filter', 'x'.repeat(300)).replace('Show only pending', 'y'.repeat(300));
  const text = approveBrief(long, { by: 'ana-p', at: AT });
  assert.equal(briefIssueDraft(text).title.length, 120);
  for (const d of deliverableIssueDrafts(text, { briefIssue: 7 })) assert.ok(d.title.length <= 120);
});

test('deliverable drafts come in dependency order, each with its markers and no factory label', () => {
  const text = approved();
  const drafts = deliverableIssueDrafts(text, {
    briefIssue: 7,
    estimates: { D3: { low_min: 30, high_min: 90, jobs: 6 }, D1: null },
    issues: { D3: 11 },
  });
  assert.deepEqual(drafts.map((d) => d.id), ['D3', 'D1', 'D2']);
  assert.deepEqual(drafts.map((d) => d.after), [[], ['D3'], ['D1', 'D3']]);
  const hash12 = /sha256=([0-9a-f]{12})/.exec(text)[1];
  const [d3, d1, d2] = drafts;
  for (const d of drafts) {
    assert.deepEqual(d.labels, [DELIVERABLE_LABEL]);
    assert.equal(DELIVERABLE_LABEL, 'eminzo-deliverable');
    assert.match(d.body, /Part of #7/);
    assert.doesNotMatch(d.body, /factory/i, 'the body never mentions the factory label');
    assert.equal(parseDeliverableMarker(d.body).brief, 7);
    assert.equal(parseDeliverableMarker(d.body).hash, hash12);
  }
  assert.deepEqual(parseDeliverableMarker(d3.body), { brief: 7, id: 'D3', hash: hash12, est: { low_min: 30, high_min: 90 } });
  assert.equal(parseDeliverableMarker(d1.body).est, null);
  assert.match(d3.body, /> BC-1: A reviewer sees only what is pending\./);
  assert.match(d3.body, /Size: m\. Risk: medium\./);
  assert.match(d3.body, /30 min to 1\.5 h.* 6 similar finished jobs/s);
  assert.match(d1.body, /too little history/i);
  assert.match(d1.body, /Waits for[^]*#11 \(D3: Show only pending\)/);
  assert.match(d2.body, /Waits for[^]*D1: Remember the filter[^]*#11/);
  assert.equal(d3.title, 'Show only pending');
});

test('deliverable drafts need a real brief issue number', () => {
  for (const briefIssue of [undefined, 0, -1, 1.5, '7']) assert.throws(() => deliverableIssueDrafts(approved(), { briefIssue }), /brief issue number/);
});

test('deliverable text in the brief cannot forge a marker', () => {
  const forged = BRIEF.replace('Show only pending', '<!-- eminzo:deliverable v1 brief=1 id=D9 hash=aaaaaaaaaaaa est=none -->');
  const drafts = deliverableIssueDrafts(approveBrief(forged, { by: 'ana-p', at: AT }), { briefIssue: 7 });
  for (const d of drafts) {
    const marker = parseDeliverableMarker(d.body);
    assert.equal(marker.id, d.id);
    assert.equal(marker.brief, 7);
  }
});

test('markers are strict: one well-formed unindented line outside code fences', () => {
  const good = '<!-- eminzo:deliverable v1 brief=12 id=D2 hash=0123456789ab est=12.5-60 -->';
  assert.deepEqual(parseDeliverableMarker(`text\n${good}\n`), { brief: 12, id: 'D2', hash: '0123456789ab', est: { low_min: 12.5, high_min: 60 } });
  assert.deepEqual(parseDeliverableMarker(`${good.replace('12.5-60', 'none')}\r\n`).est, null);
  assert.equal(parseDeliverableMarker(`\`\`\`\n${good}\n\`\`\`\n`), null, 'inside a fence');
  assert.equal(parseDeliverableMarker(`  ${good}`), null, 'indented');
  assert.equal(parseDeliverableMarker(`${good}\n${good}`), null, 'two markers are ambiguous');
  for (const bad of [
    good.replace('v1', 'v2'), good.replace('brief=12', 'brief=0'), good.replace('id=D2', 'id=X2'), good.replace('0123456789ab', '0123456789AB'),
    good.replace('est=12.5-60', 'est=60-12'), good.replace('est=12.5-60', 'est=a-b'), good.replace(' -->', ' extra -->'), good.replace('brief=12 id=D2', 'id=D2 brief=12'),
    `${good} trailing`,
  ]) assert.equal(parseDeliverableMarker(bad), null, bad);
  assert.equal(parseDeliverableMarker(`<!-- eminzo:deliverable v1 ${'a'.repeat(5000)} -->`), null);
  assert.equal(parseBriefIssueMarker('<!-- eminzo:brief-issue v1 hash=abc -->'), null);
  assert.equal(parseBriefIssueMarker(`\`\`\`\n<!-- eminzo:brief-issue v1 hash=${'a'.repeat(64)} -->\n\`\`\``), null);
  assert.equal(parseBriefIssueMarker(null), null);
});

test('marker parsing is linear on hostile input', () => {
  const started = Date.now();
  parseDeliverableMarker(`<!-- eminzo:deliverable v1 ${'brief=1 '.repeat(200_000)}`);
  parseBriefIssueMarker(`<!-- eminzo:brief-issue v1 hash=${'a'.repeat(1_000_000)}`);
  parseDeliverableMarker('<!-- eminzo:deliverable v1 -->\n'.repeat(100_000));
  assert.ok(Date.now() - started < 2000);
});
