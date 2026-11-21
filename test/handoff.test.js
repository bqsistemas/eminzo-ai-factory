// Hand-off: the texts of the brief issue and of the deliverable issues, built only behind the approval gate.
// Nothing here talks to GitHub: the Eminzo desktop creates the issues after the person confirms.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { approveBrief } from '../factory/lib/brief-approval.js';
import {
  BRIEF_ISSUE_LABEL, DELIVERABLE_LABEL, MAX_BODY, briefIssueDraft, briefIssueValidity, briefTitleOf, deliverableIssueDrafts, deliverableSections, inertProblem, parseBriefIssueMarker, parseDeliverableMarker, partOfLines, sanitize, sanitizeBlock,
} from '../factory/lib/handoff.js';
import { SECTIONS } from '../factory/lib/brief.js';

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
  assert.match(d3.body, /- \[ \] BC-1: A reviewer sees only what is pending\./);
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

test('the gate refuses brief text that could forge a marker, notify people or hide characters', () => {
  const forged = '<!-- eminzo:deliverable v1 brief=1 id=D9 hash=aaaaaaaaaaaa est=none -->';
  for (const [from, to] of [['Show only pending', forged], ['Less time.', 'ping @ana-p please'], ['Polish the list', 'Polish\u202e the list']]) {
    assert.throws(() => approveBrief(BRIEF.replace(from, to), { by: 'ana-p', at: AT }), /^Error: The brief cannot be approved yet: /);
  }
});

test('brief-derived strings are made inert: no comment, no mention, no control or bidi character', () => {
  assert.doesNotMatch(sanitize('a <!-- factory:facts {} --> b'), /<!--|-->/);
  assert.match(sanitize('a <!-- factory:facts {} --> b'), /factory:facts/, 'the words stay; only the comment syntax goes');
  assert.doesNotMatch(sanitize('<<!---->!-- factory: -->'), /<!--|-->/, 'removal repeats until nothing is left');
  assert.doesNotMatch(sanitize('<!<!---->-- x --><!-- y'), /<!--|-->/);
  assert.equal(sanitize('ping @ana-p'), 'ping @\u200bana-p');
  assert.equal(sanitize('a\u0000b\u202ec\u2066d\r\ne\tf'), 'abcd e f');
  assert.equal(sanitize(null), '');
  for (const text of ['ping @ana-p', 'a@@b', '@', 'x <!-- y']) assert.equal(sanitize(sanitize(text)), sanitize(text), `idempotent: ${text}`);
});

test('text with an eminzo comment line or an unclosed code block is refused before any draft', () => {
  const text = approved();
  assert.equal(inertProblem(text), null);
  assert.match(inertProblem(`${text}`.replace('Less time.', '<!-- eminzo:deliverable v1 -->')), /eminzo comment/);
  assert.match(inertProblem(text.replace('Everything is mixed.', '<!-- eminzo:approved sha256=x -->')), /eminzo comment/, 'an approval line that is not the last one');
  assert.match(inertProblem(text.replace('- A filter.', '```\ncode')), /code block/);
  const open = approveBrief(BRIEF.replace('- A filter.', '```js\ncode'), { by: 'ana-p', at: AT });
  // the open block also swallows the approval line, so the gate itself already refuses it
  assert.throws(() => briefIssueDraft(open), /^Error: The brief cannot be approved yet: /);
  assert.throws(() => deliverableIssueDrafts(open, { briefIssue: 7 }), /^Error: The brief cannot be approved yet: /);
});

test('the estimate in the marker always parses back: one decimal, or none when it does not fit', () => {
  const text = approved();
  const pick = (est) => deliverableIssueDrafts(text, { briefIssue: 7, estimates: { D3: est } }).find((d) => d.id === 'D3');
  const rounded = pick({ low_min: 12.34, high_min: 56.78, jobs: 5 });
  assert.deepEqual(parseDeliverableMarker(rounded.body).est, { low_min: 12.3, high_min: 56.8 });
  assert.deepEqual(parseDeliverableMarker(pick({ low_min: 0.04, high_min: 0.04, jobs: 5 }).body).est, { low_min: 0, high_min: 0 });
  for (const est of [{ low_min: 1e9, high_min: 2e9, jobs: 5 }, { low_min: 1e21, high_min: 1e22, jobs: 5 }, { low_min: -1, high_min: 5, jobs: 5 }, { low_min: 5, high_min: 3, jobs: 5 }, { low_min: Number.NaN, high_min: 3, jobs: 5 }]) {
    const d = pick(est);
    assert.equal(parseDeliverableMarker(d.body).est, null, JSON.stringify(est));
    assert.match(d.body, /too little history/i);
  }
});

test('the expected title and the Part of lines are what the drafts use', () => {
  const text = approved();
  assert.equal(briefTitleOf(text), briefIssueDraft(text).title);
  assert.deepEqual(partOfLines(7), ['Part of #7', 'Parte de #7']);
  for (const d of deliverableIssueDrafts(text, { briefIssue: 7 })) assert.ok(d.body.split('\n').includes('Part of #7'));
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

test('a brief with bold ids is cut like a plain one: normalized ids, no stray ** in the issue bodies', () => {
  const bold = BRIEF.replace('- BC-1: A', '- **BC-1**: A').replace('- BC-2:', '- **BC-2:**').replace('- D3:', '- **D3**:').replace('- D1:', '* __D1__:');
  const drafts = deliverableIssueDrafts(approveBrief(bold, { by: 'ana-p', at: AT }), { briefIssue: 7, estimates: {}, issues: {} });
  assert.deepEqual(drafts.map((d) => d.id), ['D3', 'D1', 'D2']);
  const d3 = drafts[0];
  assert.match(d3.body, /- \[ \] BC-1: A reviewer sees only what is pending\./);
  assert.equal(drafts[1].title, 'Remember the filter');
  for (const d of drafts) assert.doesNotMatch(d.body, /\*\*|__/);
});

// ---- Self-contained deliverable issues (AC-1 to AC-5) ----

const H = (lang, key) => SECTIONS.find((x) => x.key === key)[lang];
/** A brief in `lang`: D1 covers BC-1, D2 covers BC-1 and BC-2 and waits for D1, D3 covers BC-3 and waits for D1. */
function briefIn(lang, { questions = true, today = 'Everything is mixed.', problem = 'Reviewers lose time.', audience = 'Reviewers.', criterion = 'A reviewer sees only what is pending.' } = {}) {
  return [
    '<!-- eminzo:brief v1 -->', '# Brief: Pending filter', '',
    `## ${H(lang, 'problem')}`, '', problem, '',
    `## ${H(lang, 'audience')}`, '', audience, '',
    `## ${H(lang, 'value')}`, '', 'Less time.', '',
    `## ${H(lang, 'today')}`, '', today, '',
    `## ${H(lang, 'scope')}`, '', '- A filter.', '',
    `## ${H(lang, 'out_of_scope')}`, '', '- Emails.', '',
    `## ${H(lang, 'acceptance')}`, '', `- BC-1: ${criterion}`, '- BC-2: The filter is remembered.', '- BC-3: The list is polished.', '',
    ...(questions ? [`## ${H(lang, 'questions')}`, '', 'Who owns the filter?', ''] : []),
    `## ${H(lang, 'deliverables')}`, '',
    '- D1: Show only pending | size: m | risk: medium | covers: BC-1',
    '- D2: Remember the filter | size: s | risk: low | covers: BC-1, BC-2 | after: D1',
    '- D3: Polish the list | size: xs | risk: low | covers: BC-3 | after: D1',
    '',
  ].join('\n');
}
const approvedIn = (lang, opts) => approveBrief(briefIn(lang, opts), { by: 'ana-p', at: AT });
const headingsOf = (body) => body.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
const lastLines = (body) => body.split('\n').filter((l) => l.trim() !== '').slice(-2);

test('AC-1: the body carries the brief context in the language of the brief, with full criteria as a checklist', () => {
  const longCriterion = `${'A reviewer sees only what is pending. '.repeat(20)}End.`;
  assert.ok(longCriterion.length > 500);
  const seen = {};
  for (const lang of ['en', 'es', 'pt']) {
    const text = approvedIn(lang, { criterion: longCriterion });
    const drafts = deliverableIssueDrafts(text, { briefIssue: 7 });
    for (const d of drafts) {
      const heads = headingsOf(d.body);
      assert.equal(heads.length, 8, `${lang} ${d.id}: ${heads.join(' | ')}`);
      seen[lang] = heads;
      assert.match(d.body, new RegExp(`${H(lang, 'problem')}[^]*Reviewers lose time\\.[^]*${H(lang, 'audience')}[^]*Reviewers\\.`));
      assert.ok(d.body.indexOf('Everything is mixed.') > d.body.indexOf('Reviewers lose time.'));
      assert.ok(d.body.indexOf('Who owns the filter?') > d.body.indexOf('Everything is mixed.'));
      const [partOf, marker] = lastLines(d.body);
      assert.equal(partOf, partOfLines(7)[lang === 'en' ? 0 : 1]);
      assert.match(marker, /^<!-- eminzo:deliverable v1 brief=7 id=D\d hash=[0-9a-f]{12} est=none -->$/);
      assert.ok(d.body.split('\n').every((l) => !/^\s*>/.test(l)), 'no criterion is a quote');
    }
    const d1 = drafts.find((d) => d.id === 'D1');
    assert.ok(d1.body.split('\n').includes(`- [ ] BC-1: ${longCriterion}`), 'the full text of the criterion');
    assert.match(d1.title, /Show only pending/);
    assert.ok(d1.body.indexOf('Show only pending') < d1.body.indexOf('- [ ] BC-1:'));
    const noQuestions = deliverableIssueDrafts(approvedIn(lang, { questions: false }), { briefIssue: 7 })[0];
    assert.equal(headingsOf(noQuestions.body).length, 7);
    assert.doesNotMatch(noQuestions.body, /Who owns the filter/);
  }
  for (const lang of ['es', 'pt']) for (const heading of seen.en) assert.ok(!seen[lang].includes(heading), `${lang} reuses the English heading ${heading}`);
  assert.deepEqual(seen.en, ['Context', 'What it delivers', 'Acceptance criteria', 'Out of scope', 'How it works today', 'Dependencies', 'Open questions', 'Size, risk and estimate']);
});

test('AC-2: sanitizeBlock keeps the lines and makes the text inert, and a fence left open cannot swallow the marker', () => {
  const dirty = 'a <!-- x <!-- y --> --> b\r\n@ana-p\u0000 c‮ d\r\n<<!---->!-- e\r\n';
  const clean = sanitizeBlock(dirty);
  assert.equal(clean.split('\n').length, dirty.split('\n').length);
  assert.doesNotMatch(clean, /<!--|-->/);
  assert.ok(clean.includes('@​ana-p'));
  assert.doesNotMatch(clean, /[\u0000-\u0008\u000B-\u001F‮\r]/);
  assert.equal(sanitizeBlock(clean), clean);
  assert.equal(sanitizeBlock(null), '');
  const text = approveBrief(BRIEF.replace('Reviewers lose time.', 'Look:\n```js\nconst a = 1;').replace('Reviewers.', 'more\n```\nend'), { by: 'ana-p', at: AT });
  const drafts = deliverableIssueDrafts(text, { briefIssue: 7 });
  assert.ok(drafts.length > 0);
  for (const d of drafts) {
    assert.equal(parseDeliverableMarker(d.body).id, d.id);
    assert.ok(d.body.split('\n').includes('Part of #7'));
    let open = false;
    for (const line of d.body.split('\n')) { if (line.startsWith('```')) open = !open; if (line === 'Part of #7') assert.equal(open, false, 'Part of is outside any fence'); }
  }
});

test('AC-3: Out of scope lists what only other deliverables cover; Dependencies lists what waits for this one', () => {
  const text = approvedIn('en');
  const drafts = Object.fromEntries(deliverableIssueDrafts(text, { briefIssue: 7, issues: { D2: 12 } }).map((d) => [d.id, d]));
  const outOf = (body) => body.split('\n## ').find((s) => s.startsWith('Out of scope'));
  const deps = (body) => body.split('\n## ').find((s) => s.startsWith('Dependencies'));
  assert.match(outOf(drafts.D1.body), /Emails\./);
  assert.match(outOf(drafts.D1.body), /BC-2[^\n]*#12 \(D2: Remember the filter\)/);
  assert.match(outOf(drafts.D1.body), /BC-3[^\n]*D3: Polish the list/);
  assert.doesNotMatch(outOf(drafts.D1.body), /BC-1/);
  assert.doesNotMatch(outOf(drafts.D2.body), /BC-1/);
  assert.match(deps(drafts.D1.body), /Nothing: it can start right away\./);
  assert.match(deps(drafts.D1.body), /#12 \(D2: Remember the filter\)/);
  assert.match(deps(drafts.D1.body), /D3: Polish the list/);
  assert.match(deps(drafts.D2.body), /Waits for[^]*D1: Show only pending/);
  assert.doesNotMatch(deps(drafts.D3.body), /D1: Show only pending[^]*D2|#12/);
  const unblocks = deps(drafts.D3.body).split('\n').filter((l) => /^- /.test(l));
  assert.deepEqual(unblocks, ['- D1: Show only pending']);
});

test('AC-4: whole optional sections are replaced by a pointer to the brief issue, only until the body fits', () => {
  const big = (n) => `${'x'.repeat(100)}\n`.repeat(n);
  const heading = (lang, key) => ({ today: ['How it works today', 'Cómo funciona hoy', 'Como funciona hoje'], questions: ['Open questions', 'Preguntas abiertas', 'Perguntas em aberto'], context: ['Context', 'Contexto', 'Contexto'] })[key][['en', 'es', 'pt'].indexOf(lang)];
  for (const lang of ['en', 'es', 'pt']) {
    // only "How it works today" is large enough to need the cut
    const one = deliverableIssueDrafts(approvedIn(lang, { today: big(400) }), { briefIssue: 7 });
    assert.ok(one.every((d) => d.body.length <= MAX_BODY));
    const small = deliverableIssueDrafts(approvedIn(lang, { today: big(5) }), { briefIssue: 7 });
    assert.ok(small[0].body.includes('xxxxxxxx'), 'nothing is cut when it fits');
    const tall = deliverableIssueDrafts(approvedIn(lang, { today: big(640) }), { briefIssue: 7 });
    for (const d of tall) {
      assert.ok(d.body.length <= MAX_BODY, `${lang} ${d.id}`);
      assert.doesNotMatch(d.body, /xxxxxxxx/);
      const pointer = d.body.split('\n').filter((l) => l.includes('#7') && l.includes(heading(lang, 'today')) && !l.startsWith('Part') && !l.startsWith('Parte'));
      assert.equal(pointer.length, 1);
      assert.ok(!d.body.includes(`## ${heading(lang, 'today')}`), 'the whole section is replaced');
      assert.ok(d.body.includes('Who owns the filter?'), 'questions kept');
      assert.ok(d.body.includes('Reviewers lose time.'), 'context kept');
      assert.ok(d.body.includes('- [ ] BC-'));
      assert.equal(parseDeliverableMarker(d.body).brief, 7);
    }
    const sections = deliverableSections(approvedIn(lang, { today: big(640) }), { briefIssue: 7 });
    for (const d of sections) assert.ok(d.sections.find((s) => s.key === 'today').parts[0].text.includes('xxxxxxxx'), 'sections are never cut');
  }
  // questions are replaced next, then context
  const q = `${'q'.repeat(100)}\n`.repeat(640);
  const text = approveBrief(briefIn('en', { today: big(300) }).replace('Who owns the filter?', q), { by: 'ana-p', at: AT });
  const d = deliverableIssueDrafts(text, { briefIssue: 7 })[0];
  assert.doesNotMatch(d.body, /xxxxxxxx|qqqqqqqq/);
  assert.ok(d.body.includes('Reviewers lose time.'));
  const c = `${'c'.repeat(100)}\n`.repeat(640);
  const text2 = approveBrief(briefIn('en', { today: big(300), problem: c }).replace('Who owns the filter?', q), { by: 'ana-p', at: AT });
  const d2 = deliverableIssueDrafts(text2, { briefIssue: 7 })[0];
  assert.doesNotMatch(d2.body, /cccccccc/);
  assert.ok(d2.body.length <= MAX_BODY);
  assert.ok(d2.body.includes('- [ ] BC-1:'));
  // not even the three sections fit: the readable error, nothing cut
  const huge = approveBrief(briefIn('en').replace('- Emails.', `${'z'.repeat(100)}\n`.repeat(700)), { by: 'ana-p', at: AT });
  assert.throws(() => deliverableIssueDrafts(huge, { briefIssue: 7 }), /longer than GitHub accepts/);
});

test('AC-5: deliverableSections and the drafts expose the same structured sections', () => {
  const text = approvedIn('es');
  const bare = deliverableSections(text);
  const full = deliverableIssueDrafts(text, { briefIssue: 7, issues: { D3: 11 } });
  assert.deepEqual(bare.map((d) => d.id), full.map((d) => d.id));
  const keys = ['context', 'delivers', 'criteria', 'out_of_scope', 'today', 'dependencies', 'questions', 'size', 'part_of'];
  for (const d of bare) {
    assert.equal('body' in d, false);
    assert.deepEqual(d.sections.map((s) => s.key), keys);
    assert.equal(d.sections.at(-1).heading, null);
    assert.ok(d.sections.slice(0, -1).every((s) => typeof s.heading === 'string' && s.heading.length > 0));
    assert.deepEqual(d.sections.find((s) => s.key === 'part_of').parts, [{ type: 'brief', label: null, issue: null }]);
    const criteria = d.sections.find((s) => s.key === 'criteria').parts[0];
    assert.equal(criteria.type, 'criteria');
    assert.ok(criteria.items.every((i) => /^BC-\d$/.test(i.id) && i.text.length > 0));
    assert.equal(d.sections.find((s) => s.key === 'context').parts[0].label, H('es', 'problem'));
  }
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'issue' ? null : v)));
  assert.deepEqual(strip(bare.map((d) => d.sections)), strip(full.map((d) => d.sections)));
  const withIssue = full.find((d) => d.id === 'D1').sections.find((s) => s.key === 'dependencies').parts.find((p) => p.type === 'refs' && p.items.some((i) => i.id === 'D3'));
  assert.equal(withIssue.items.find((i) => i.id === 'D3').issue, 11);
  assert.equal(full[0].sections.at(-1).parts[0].issue, 7);
  assert.throws(() => deliverableSections(BRIEF), /^Error: The brief is not approved yet\./);
  assert.throws(() => deliverableSections(text, { briefIssue: 0 }), /brief issue number/);
});

test('AC-7: the markers, the Part of lines, the title and the order do not change with the new layout', () => {
  const drafts = deliverableIssueDrafts(approvedIn('es'), { briefIssue: 7, estimates: { D1: { low_min: 30, high_min: 90, jobs: 6 } } });
  assert.deepEqual(drafts.map((d) => d.id), ['D1', 'D2', 'D3']);
  assert.deepEqual(parseDeliverableMarker(drafts[0].body).est, { low_min: 30, high_min: 90 });
  assert.deepEqual(partOfLines(7), ['Part of #7', 'Parte de #7']);
  for (const d of drafts) { assert.deepEqual(d.labels, ['eminzo-deliverable']); assert.ok(d.title.length <= 120); assert.doesNotMatch(d.body, /factory/i); }
});
