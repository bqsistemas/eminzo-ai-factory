// Brief approval: a marker bound to a hash of the brief's content, who approved and when. Any later edit breaks the
// binding, and only an approved brief opens the gate that issue creation must pass. The marker detects edits; it does
// not authenticate (`by` is self-declared).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { APPROVAL_PATTERN, MAX_LINE, approveBrief, briefHash, briefStatus, canonicalBrief } from '../factory/lib/brief-approval.js';
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
const WHO = { by: 'ana-p', at: AT };
const markerLines = (t) => t.split('\n').filter((l) => APPROVAL_PATTERN.test(l));
const timed = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

test('canonicalBrief ignores the marker, line endings and trailing spaces and tabs', () => {
  const marked = `${READY.trimEnd()}\n<!-- eminzo:approved sha256=${'a'.repeat(64)} by=ana at=${AT} -->\n`;
  assert.equal(canonicalBrief(marked), canonicalBrief(READY));
  assert.equal(canonicalBrief(READY.replace(/\n/g, '\r\n')), canonicalBrief(READY));
  assert.equal(canonicalBrief(`${READY}\n\n\n`), canonicalBrief(READY));
  assert.equal(canonicalBrief(READY.replace('## Scope\n', '## Scope \t \n')), canonicalBrief(READY));
  assert.equal(canonicalBrief(`﻿${READY}`), canonicalBrief(READY), 'a leading BOM is ignored');
  assert.notEqual(canonicalBrief(READY.replace('Filter.', 'Filter it.')), canonicalBrief(READY));
});

test('canonicalBrief keeps every other whitespace edit visible', () => {
  for (const ch of [' ', ' ', '　', '​']) {
    assert.notEqual(canonicalBrief(READY.replace('## Scope\n', `## Scope${ch}\n`)), canonicalBrief(READY), JSON.stringify(ch));
  }
});

test('briefHash is 64 hex characters, stable, and bound to who and when', () => {
  assert.match(briefHash(READY, WHO), /^[0-9a-f]{64}$/);
  assert.equal(briefHash(READY, WHO), briefHash(`${READY}\n`, WHO));
  assert.notEqual(briefHash(READY, WHO), briefHash(READY, { ...WHO, by: 'ceo' }));
  assert.notEqual(briefHash(READY, WHO), briefHash(READY, { ...WHO, at: '2026-11-13T15:00:00.000Z' }));
});

test('approveBrief adds exactly one marker bound to content, who and when, replacing an old one', () => {
  const once = approveBrief(READY, WHO);
  assert.equal(markerLines(once).length, 1);
  assert.match(once, new RegExp(`<!-- eminzo:approved sha256=${briefHash(READY, WHO)} by=ana-p at=${AT} -->\\n$`));
  const twice = approveBrief(once, { by: 'bo', at: '2026-11-13T09:00:00.000Z' });
  assert.equal(markerLines(twice).length, 1);
  assert.match(twice, /by=bo /);
  assert.equal(canonicalBrief(twice), canonicalBrief(READY));
});

test('approveBrief refuses a brief with problems, with a sentence a person understands', () => {
  assert.throws(() => approveBrief(READY.replace('- BC-1: A reviewer sees only what is pending.', ''), WHO), /The brief cannot be approved yet: /);
  assert.throws(() => approveBrief('not a brief', WHO), /The brief cannot be approved yet: /);
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

test('briefStatus: approved only while content, who and when still match', () => {
  const approved = approveBrief(READY, WHO);
  const s = briefStatus(approved);
  assert.equal(s.state, 'approved');
  assert.equal(s.can_create_issues, true);
  assert.deepEqual(s.approval, { by: 'ana-p', at: AT, hash: briefHash(READY, WHO) });
  const changed = briefStatus(approved.replace('Filter.', 'Filter it.'));
  assert.equal(changed.state, 'changed');
  assert.equal(changed.can_create_issues, false);
  assert.equal(changed.reason, 'The brief changed after it was approved on 2026-11-12; approve it again.');
  assert.equal(changed.approval.by, 'ana-p');
});

test('briefStatus: editing who approved or when breaks the approval', () => {
  const approved = approveBrief(READY, WHO);
  const byTampered = briefStatus(approved.replace('by=ana-p', 'by=ceo'));
  assert.equal(byTampered.state, 'changed');
  assert.equal(byTampered.can_create_issues, false);
  const atTampered = briefStatus(approved.replace(AT, '2026-11-01T08:00:00.000Z'));
  assert.equal(atTampered.state, 'changed');
  assert.equal(atTampered.can_create_issues, false);
});

test('briefStatus: a well-formed marker with the wrong hash on an unedited body is changed', () => {
  const forged = `${canonicalBrief(READY)}\n\n<!-- eminzo:approved sha256=${'0'.repeat(64)} by=ana at=${AT} -->\n`;
  const s = briefStatus(forged);
  assert.equal(s.state, 'changed');
  assert.equal(s.can_create_issues, false);
});

test('briefStatus: a malformed marker never approves (uppercase hash, no date, bad date)', () => {
  const body = canonicalBrief(READY);
  const good = briefHash(READY, WHO);
  for (const line of [
    `<!-- eminzo:approved sha256=${good.toUpperCase()} by=ana-p at=${AT} -->`,
    `<!-- eminzo:approved sha256=${good} by=ana-p -->`,
    `<!-- eminzo:approved sha256=${good} by=ana-p at=2026-13-45T00:00:00Z -->`,
    `  <!-- eminzo:approved sha256=${good} by=ana-p at=${AT} -->`,
  ]) {
    const s = briefStatus(`${body}\n\n${line}\n`);
    assert.notEqual(s.state, 'approved', line);
    assert.equal(s.can_create_issues, false, line);
  }
  assert.match(briefStatus(`${body}\n\n<!-- eminzo:approved sha256=${good.toUpperCase()} by=ana-p at=${AT} -->\n`).reason, /not valid/);
});

test('briefStatus: content after the marker, or two markers, is never trusted', () => {
  const approved = approveBrief(READY, WHO);
  const after = briefStatus(`${approved}\nA note added later.\n`);
  assert.equal(after.state, 'changed');
  assert.equal(after.can_create_issues, false);
  assert.match(after.reason, /end of the brief/);
  const doubled = briefStatus(`${approved}<!-- eminzo:approved sha256=${briefHash(READY, WHO)} by=ana-p at=${AT} -->\n`);
  assert.equal(doubled.state, 'changed');
  assert.equal(doubled.can_create_issues, false);
  assert.match(doubled.reason, /more than one approval marker/);
});

test('a marker-like line inside a code fence or indented is the person\'s content and is never removed', () => {
  const fenced = READY.replace('- Filter.', `- Filter.\n\n\`\`\`\n<!-- eminzo:approved sha256=${'a'.repeat(64)} by=ana at=${AT} -->\n\`\`\``);
  assert.match(canonicalBrief(fenced), /```\n<!-- eminzo:approved/);
  assert.throws(() => approveBrief(fenced, WHO), /HTML comments are not allowed in a brief/, 'a comment is never part of an approved brief, fenced or not');
  const indented = READY.replace('- Filter.', `- Filter.\n\n    <!-- eminzo:approved sha256=${'a'.repeat(64)} by=ana at=${AT} -->`);
  assert.throws(() => approveBrief(indented, WHO), /not valid/);
});

test('a line over the limit blocks approval and is rejected without a regex scan', () => {
  const long = READY.replace('- Filter.', `- Filter ${'x'.repeat(MAX_LINE)}`);
  const s = briefStatus(long);
  assert.equal(s.state, 'draft');
  assert.match(s.problems[0], /longer than 10000 characters/);
  assert.throws(() => approveBrief(long, WHO), /longer than 10000 characters/);
});

test('canonicalBrief and briefStatus run in linear time on pathological input', () => {
  const spaces = `# Brief: x\n${' '.repeat(200_000)}x`;
  assert.ok(timed(() => canonicalBrief(spaces)) < 200, 'canonicalBrief');
  assert.ok(timed(() => briefStatus(spaces)) < 200, 'briefStatus');
  const blanks = `# Brief: x\n${'\n \t'.repeat(60_000)}x`;
  assert.ok(timed(() => canonicalBrief(blanks)) < 200, 'blank lines');
  assert.ok(timed(() => briefStatus(`# Brief: x\n${'<!-- eminzo:approved '.repeat(9_000)}`)) < 200, 'marker-like noise');
});

test('the hash is still computed over the brief text: a brief approved before bold ids were read stays approved', () => {
  const bold = READY.replace('- BC-1:', '- **BC-1**:').replace('- D1:', '- **D1**:');
  const marked = approveBrief(bold, WHO);
  assert.match(marked, /^- \*\*BC-1\*\*: /m, 'the text is kept as written');
  assert.match(marked, new RegExp(`sha256=${briefHash(bold, WHO)} `));
  assert.equal(briefStatus(marked).state, 'approved');
  // the hash of the plain text is exactly what it was: sha256(canonical text + "\n" + by + "\n" + at)
  assert.equal(briefHash(READY, WHO), createHash('sha256').update(`${canonicalBrief(READY)}\n${WHO.by}\n${WHO.at}`, 'utf8').digest('hex'));
  assert.notEqual(briefHash(bold, WHO), briefHash(READY, WHO), 'the hash binds the text, not the normalized ids');
});
