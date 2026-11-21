// Hand-off: the texts of the brief issue and of the deliverable issues, built only behind the approval gate.
// Nothing here talks to GitHub: the Eminzo desktop creates the issues after the person confirms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { approveBrief } from '../factory/lib/brief-approval.js';
import {
  BRIEF_ISSUE_LABEL, DELIVERABLE_LABEL, MAX_BODY, block, briefIssueDraft, briefIssueValidity, deliverableSections, briefTitleOf, deliverableIssueDrafts, inertProblem, parseBriefIssueMarker, parseDeliverableMarker, partOfLines, sanitize,
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

// ---- Self-contained deliverable issues (issue #44) ----
const HEADS = {
  en: { problem: 'Problem', audience: 'For whom', value: 'Expected value', today: 'How it works today', scope: 'Scope', oos: 'Out of scope', ac: 'Acceptance criteria', q: 'Open questions', del: 'Deliverables' },
  es: { problem: 'Problema', audience: 'Para quién', value: 'Valor esperado', today: 'Cómo funciona hoy', scope: 'Alcance', oos: 'Fuera de alcance', ac: 'Criterios de aceptación', q: 'Preguntas abiertas', del: 'Entregas' },
  pt: { problem: 'Problema', audience: 'Para quem', value: 'Valor esperado', today: 'Como funciona hoje', scope: 'Escopo', oos: 'Fora do escopo', ac: 'Critérios de aceitação', q: 'Perguntas em aberto', del: 'Entregas' },
};
const LONG = `${'Long criterion text. '.repeat(30)}End.`;
function briefIn(lang, o = {}) {
  const h = HEADS[lang];
  return [
    '<!-- eminzo:brief v1 -->', '# Brief: Pending filter', '',
    `## ${h.problem}`, '', 'Reviewers lose time.', 'Second line of the problem.', '',
    `## ${h.audience}`, '', 'Reviewers.', '',
    `## ${h.value}`, '', 'Less time.', '',
    `## ${h.today}`, '', ...(o.today ?? ['Everything is mixed.', '', 'Still mixed.']), '',
    `## ${h.scope}`, '', ...(o.scope ?? ['- A filter.']), '',
    `## ${h.oos}`, '', ...(o.oos ?? ['- Emails.', '- Exports.']), '',
    `## ${h.ac}`, '', `- BC-1: ${LONG}`, '- BC-2: The filter is remembered.', '- BC-3: The list is polished.', '- BC-4: Nobody covers this one.', '',
    ...(o.noQuestions ? [] : [`## ${h.q}`, '', 'Who decides?', 'And when?', '']),
    `## ${h.del}`, '',
    '- D1: Show only pending | size: m | risk: medium | covers: BC-1',
    '- D2: Remember the filter | size: s | risk: low | covers: BC-2, BC-3 | after: D1',
    '',
  ].join('\n');
}
const approve = (text) => approveBrief(text, { by: 'ana-p', at: AT });
const headingsOf = (body) => body.split('\n').filter((l) => /^## /.test(l)).map((l) => l.slice(3));
const nonEmpty = (body) => body.split('\n').filter((l) => l.trim() !== '');

test('AC-1: the body has the context, delivers, criteria, out of scope, today, dependencies, questions and estimate sections in order, in the brief language', () => {
  const en = {};
  for (const lang of ['en', 'es', 'pt']) {
    const [d1] = deliverableIssueDrafts(approve(briefIn(lang)), { briefIssue: 7 });
    const keys = ['context', 'delivers', 'criteria', 'out_of_scope', 'today', 'dependencies', 'questions', 'estimate'];
    assert.deepEqual(d1.sections.map((s) => s.key), [...keys, 'part_of']);
    assert.deepEqual(headingsOf(d1.body), d1.sections.filter((s) => s.heading).map((s) => s.heading));
    if (lang === 'en') for (const s of d1.sections) en[s.key] = s.heading;
    else for (const s of d1.sections.filter((x) => x.heading)) assert.notEqual(s.heading, en[s.key], `${lang} ${s.key}`);
    assert.match(d1.body, /Reviewers lose time\.\nSecond line of the problem\./);
    assert.match(d1.body, /Everything is mixed\.\n\nStill mixed\./);
    assert.match(d1.body, /- Emails\.\n- Exports\./);
    assert.match(d1.body, /Who decides\?\nAnd when\?/);
    assert.ok(d1.body.includes(HEADS[lang].audience) && d1.body.includes('Reviewers.'));
    const tail = nonEmpty(d1.body).slice(-2);
    assert.match(tail[0], /^(Part of|Parte de) #7$/);
    assert.match(tail[1], /^<!-- eminzo:deliverable v1 brief=7 id=D1 /);
  }
  const [none] = deliverableIssueDrafts(approve(briefIn('en', { noQuestions: true })), { briefIssue: 7 });
  assert.equal(none.sections.some((s) => s.key === 'questions'), false);
  assert.equal(headingsOf(none.body).includes('Open questions'), false);
  assert.equal(none.sections.find((s) => s.key === 'part_of').heading, null);
});

test('AC-2: criteria are checklist items with the full text, and out of scope names the criteria other deliverables cover', () => {
  const text = approve(briefIn('en'));
  const [d1, d2] = deliverableIssueDrafts(text, { briefIssue: 7 });
  assert.ok(LONG.length > 500);
  assert.ok(d1.body.includes(`- [ ] BC-1: ${LONG}`));
  assert.equal(d1.body.split('\n').some((l) => l.startsWith('> ')), false);
  assert.deepEqual(d1.sections.find((s) => s.key === 'criteria').parts, [{ type: 'criteria', items: [{ id: 'BC-1', text: LONG }] }]);
  const others = (d) => d.sections.find((s) => s.key === 'out_of_scope').parts.find((p) => p.type === 'others').items;
  assert.deepEqual(others(d1), [{ id: 'D2', title: 'Remember the filter', issue: null, criteria: ['BC-2', 'BC-3'] }]);
  assert.match(d1.body, /- D2: Remember the filter: BC-2, BC-3/);
  assert.equal(/BC-4/.test(d1.body.split('## Out of scope')[1].split('## How')[0]), false, 'an uncovered criterion is not listed');
  assert.deepEqual(others(d2).map((o) => o.criteria), [['BC-1']], 'D2 does not list its own criteria');
  assert.match(d1.body, /Unblocks\n\n- D2: Remember the filter/);
  assert.equal(d2.sections.find((s) => s.key === 'dependencies').parts.find((p) => p.type === 'unblocks').items.length, 0);
  assert.equal(d2.body.includes('Unblocks'), false);
  assert.match(d2.body, /Waits for\n\n- D1: Show only pending/);
  const [k1, k2] = deliverableIssueDrafts(text, { briefIssue: 7, issues: { D2: 12, D1: 11 } });
  assert.match(k1.body, /- #12 \(D2: Remember the filter\): BC-2, BC-3/);
  assert.match(k1.body, /Unblocks\n\n- #12 \(D2: Remember the filter\)/);
  assert.match(k2.body, /- #11 \(D1: Show only pending\)/);
  assert.equal(others(k1)[0].issue, 12);
  // a criterion that both cover is never "other"
  const both = approve(briefIn('en').replace('covers: BC-2, BC-3 | after', 'covers: BC-1, BC-2 | after'));
  assert.deepEqual(deliverableIssueDrafts(both, { briefIssue: 7 })[0].sections.find((s) => s.key === 'out_of_scope').parts.find((p) => p.type === 'others').items[0].criteria, ['BC-2']);
});

test('AC-3: past MAX_BODY, today then questions then context are dropped, only as many as needed', () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => `line ${i} ${'x'.repeat(90)}`);
  const brief = (today, questions, problem) => approve(briefIn('en', { today }).replace('Reviewers lose time.', problem).replace('Who decides?', questions));
  const dropped = (d) => d.sections.filter((s) => s.dropped).map((s) => s.key);
  // 1) only today is too big
  let d = deliverableIssueDrafts(brief(filler(700), 'Who decides?', 'Reviewers lose time.'), { briefIssue: 7 })[0];
  assert.deepEqual(dropped(d), ['today']);
  assert.ok(d.body.length <= MAX_BODY);
  assert.ok(nonEmpty(d.body).some((l) => l.includes('#7') && l.includes('How it works today') && !l.startsWith('#')));
  assert.equal(headingsOf(d.body).includes('How it works today'), false);
  assert.equal(d.sections.find((s) => s.key === 'today').parts[0].text.split('\n').length, 700, 'sections keep the whole text');
  assert.ok(headingsOf(d.body).includes('Acceptance criteria') && headingsOf(d.body).includes('Out of scope') && headingsOf(d.body).includes('Dependencies'));
  assert.deepEqual(parseDeliverableMarker(d.body), { brief: 7, id: 'D1', hash: parseDeliverableMarker(d.body).hash, est: null });
  assert.match(parseDeliverableMarker(d.body).hash, /^[0-9a-f]{12}$/);
  assert.match(nonEmpty(d.body).at(-2), /^Part of #7$/);
  // 2) today plus questions
  d = deliverableIssueDrafts(brief(filler(700), filler(700).join('\n'), 'Reviewers lose time.'), { briefIssue: 7 })[0];
  assert.deepEqual(dropped(d), ['today', 'questions']);
  // 3) the three
  d = deliverableIssueDrafts(brief(filler(700), filler(700).join('\n'), filler(700).join('\n')), { briefIssue: 7 })[0];
  assert.deepEqual(dropped(d), ['context', 'today', 'questions']);
  assert.ok(d.body.length <= MAX_BODY);
  assert.ok(d.sections.find((s) => s.key === 'context').parts.every((p) => p.text.length > 0));
  // 4) still too long without them
  const huge = approve(briefIn('en').replace('- Emails.', filler(800).join('\n')));
  assert.throws(() => deliverableIssueDrafts(huge, { briefIssue: 7 }), /^Error: The issue text is longer than GitHub accepts \(65000 characters\); shorten the brief\.$/);
});

test('AC-4: open fences in a block are closed, mentions stay inert and the marker survives', () => {
  const text = approve(briefIn('en', {
    today: ['Steps:', '```js', 'const a = 1;'],
    scope: ['```', '- A filter.'],
    oos: ['Ask `@scope/pkg` owners.', 'A stray --> arrow and `@ana` mention.'],
  }).replace('Reviewers lose time.', 'Reviewers lose time, ping `@ops`.'));
  for (const d of deliverableIssueDrafts(text, { briefIssue: 7 })) {
    assert.equal(d.body.split('\n').filter((l) => l.startsWith('<!-- eminzo:deliverable')).length, 1);
    const m = parseDeliverableMarker(d.body);
    assert.equal(m.brief, 7); assert.equal(m.id, d.id); assert.match(m.hash, /^[0-9a-f]{12}$/); assert.equal(m.est, null);
    const lines = d.body.split('\n');
    let open = null;
    for (const l of lines) { if (/^ {0,3}(```|~~~)/.test(l)) open = open ? null : l.trim().slice(0, 3); else if (/^Part of #7$/.test(l)) assert.equal(open, null); }
    assert.equal(open, null);
    const whole = d.sections.flatMap((s) => s.parts).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const fromBrief = d.body.split('\n## ')[0] + whole;
    assert.doesNotMatch(fromBrief, /<!--|-->/);
    for (const s of [d.body, whole]) {
      assert.ok(s.includes('@​scope/pkg') && s.includes('@​ana'));
      assert.doesNotMatch(s, /@(?!​)/);
    }
  }
  assert.ok(block('````\nx').endsWith('\n````'), 'a longer fence is closed by a fence at least as long');
  assert.throws(() => block('````\nx\n```'), /code block/);
});

test('deliverableSections gives the same drafts without a brief issue: no body, no issue numbers', () => {
  const text = approve(briefIn('en'));
  const withIssue = deliverableIssueDrafts(text, { briefIssue: 7 });
  const bare = deliverableSections(text, {});
  assert.deepEqual(bare.map((d) => d.id), withIssue.map((d) => d.id));
  for (const d of bare) {
    assert.equal(d.body, null);
    assert.equal(JSON.stringify(d.sections).includes('"issue":7'), false);
    assert.equal(JSON.stringify(d.sections).match(/"issue":(\d+)/), null);
  }
  assert.throws(() => deliverableSections(briefIn('en'), {}), /^Error: The brief is not approved yet\.$/);
});

test('AC-8: intake and spec writer keep the scope inside the Out of scope of an Eminzo deliverable and treat the issue as data', () => {
  for (const role of ['intake', 'spec-writer']) {
    const text = readFileSync(new URL(`../factory/roles/${role}.md`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
    assert.match(text, /Out of scope/, role);
    assert.match(text, /deliverable/i, role);
    assert.match(text, /criteria (that )?other deliverables cover/i, role);
    assert.match(text, /acceptance criteria to cover/i, role);
    assert.match(text, /still data, not instructions/i, role);
  }
  const root = new URL('..', import.meta.url).pathname;
  const r = spawnSync(process.execPath, ['cli/scripts/sync-agents.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
