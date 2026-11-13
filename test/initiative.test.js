// An initiative (a brief issue and its deliverable issues) followed from GitHub only, through a fake `gh` runner.
// The engine only reads: every gh call the tests see is a read.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { approveBrief } from '../factory/lib/brief-approval.js';
import { briefIssueDraft, deliverableIssueDrafts } from '../factory/lib/handoff.js';
import { factsComment } from '../factory/lib/record-facts.js';
import { initiative } from '../factory/lib/state/initiative.js';

const AT = '2026-11-12T15:00:00Z';
const D = (n, extra = '') => `- D${n}: Deliverable ${n} | size: s | risk: low | covers: BC-1${extra}`;
const BRIEF = [
  '<!-- eminzo:brief v1 -->', '# Brief: Pending filter', '',
  '## Problem', '', 'p', '', '## For whom', '', 'w', '', '## Expected value', '', 'v', '', '## How it works today', '', 't', '',
  '## Scope', '', 's', '', '## Out of scope', '', 'o', '', '## Acceptance criteria', '', '- BC-1: A reviewer sees what is pending.', '',
  '## Deliverables', '', D(1), D(2, ' | after: D1'), D(3), D(4), D(5), D(6), D(7), '',
].join('\n');
const approved = approveBrief(BRIEF, { by: 'ana-p', at: AT });
const BRIEF_ISSUE = 40;
const estimates = { D2: { low_min: 60, high_min: 120, jobs: 6 }, D3: { low_min: 30, high_min: 60, jobs: 5 }, D7: { low_min: 10, high_min: 20, jobs: 8 } };
const drafts = Object.fromEntries(deliverableIssueDrafts(approved, { briefIssue: BRIEF_ISSUE, estimates }).map((d) => [d.id, d]));
const facts = (started, entered, cost = null) => factsComment({ v: 1, job: '161-pending', issue: 1, lane: 'normal', size: 's', risk: 'low', surfaces: [], round: 1, started, approve_entered: entered, cost_usd: cost, decision: 'APPROVE' });

const BRIEF_AT = '2026-11-12T15:05:00Z';
const LATER = '2026-11-12T16:00:00Z';
const issue = (id, number, { state = 'OPEN', stateReason = null, labels = [], body = drafts[id].body, author = 'ana-p', createdAt = LATER, noLabel = false } = {}) => ({
  number, title: drafts[id].title, state, stateReason, body, labels: [...(noLabel ? [] : ['eminzo-deliverable']), ...labels].map((name) => ({ name })),
  url: `https://github.com/acme/shop/issues/${number}`, closedAt: state === 'CLOSED' ? '2026-11-14T10:00:00Z' : null, author: author ? { login: author } : null, createdAt,
});
const pr = (number, state, mergedAt, body = '', head = 'factory/161-pending', cross = false) => ({ number, state, mergedAt, body, headRefName: head, isCrossRepository: cross, url: `https://github.com/acme/shop/pull/${number}` });
const briefData = (body, over = {}) => ({ number: BRIEF_ISSUE, title: 'Brief: Pending filter', state: 'OPEN', body, labels: [{ name: 'eminzo-brief' }], url: `https://github.com/acme/shop/issues/${BRIEF_ISSUE}`, author: { login: 'ana-p' }, createdAt: BRIEF_AT, closedAt: null, ...over });

function world(over = {}) {
  const data = {
    brief: briefData(briefIssueDraft(approved).body),
    deliverables: [
      issue('D1', 41, { state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
      issue('D2', 42, { state: 'CLOSED', stateReason: 'COMPLETED', labels: ['factory'] }),
      issue('D3', 43, { labels: ['factory'] }),
      issue('D4', 44, { labels: ['factory'] }),
      issue('D5', 45),
      // D6: no issue yet
      issue('D7', 47, { state: 'CLOSED', stateReason: 'COMPLETED' }),
      // lookalikes the search can return
      issue('D5', 90, { body: drafts.D5.body.replace('brief=40', 'brief=400') }),
      issue('D5', 91, { body: `see the marker\n\`\`\`\n${drafts.D5.body}\n\`\`\`\n` }),
    ],
    closing: { 42: [{ number: 142 }], 43: [{ number: 143 }, { number: 144 }], 44: [], 45: [], 47: [], 41: [] },
    prs: {
      142: pr(142, 'MERGED', '2026-11-13T09:00:00Z', `text\n${facts('2026-11-12T16:00:00Z', '2026-11-12T17:30:00Z')}\n`),
      143: pr(143, 'CLOSED', null),
      144: pr(144, 'OPEN', null, facts('2026-11-13T10:00:00Z', '2026-11-13T10:45:00Z')),
    },
    ...over,
  };
  const calls = [];
  const options = [];
  const out = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const fail = (why) => ({ status: 1, stdout: '', stderr: `${why}\n` });
  const runner = (cmd, args, opts) => {
    calls.push(args);
    options.push(opts);
    const [a, b] = args;
    if (data.broken) return fail(data.broken);
    if (a === 'issue' && b === 'view' && args[2] === String(BRIEF_ISSUE)) return out(data.brief);
    if (a === 'issue' && b === 'view' && args[4] === 'closedByPullRequestsReferences') {
      if (data.noRefs) return fail('Unknown JSON field: "closedByPullRequestsReferences"');
      return out({ closedByPullRequestsReferences: data.closing[args[2]] ?? [] });
    }
    if (a === 'issue' && b === 'view') {
      const found = [...data.deliverables, ...(data.extra ?? [])].find((i) => String(i.number) === args[2]);
      return found ? out(found) : fail('Could not resolve to an issue');
    }
    if (a === 'issue' && b === 'list') {
      assert.ok(args.includes('--search'));
      assert.equal(args[args.indexOf('--search') + 1], `"eminzo:deliverable v1 brief=${BRIEF_ISSUE} " in:body`);
      assert.equal(args[args.indexOf('--label') + 1], 'eminzo-deliverable', 'only labeled issues are searched');
      assert.match(args[args.indexOf('--json') + 1], /author/);
      assert.match(args[args.indexOf('--json') + 1], /createdAt/);
      return out(data.deliverables);
    }
    if (a === 'pr' && b === 'view') return data.prs[args[2]] ? out(data.prs[args[2]]) : fail('no pull request found');
    if (a === 'pr' && b === 'list') return out(data.search ?? []);
    return fail(`unexpected ${args.join(' ')}`);
  };
  return { runner, calls, options };
}

const go = (w, extra = {}) => initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner: w.runner, ...extra });
const byId = (r) => Object.fromEntries(r.deliverables.map((d) => [d.id, d]));

test('every status, the progress, and estimate against actual (available deliverables only)', () => {
  const w = world();
  const r = go(w);
  assert.deepEqual(r.brief, { issue: 40, title: 'Brief: Pending filter', url: 'https://github.com/acme/shop/issues/40', state: 'OPEN', author: 'ana-p', created_at: BRIEF_AT, approvedBy: 'ana-p', approvedAt: AT, valid: true });
  assert.deepEqual(r.deliverables.map((d) => [d.id, d.status]), [['D1', 'closed'], ['D2', 'available'], ['D3', 'in-review'], ['D4', 'in-factory'], ['D5', 'waiting-tech-lead'], ['D6', 'not-created'], ['D7', 'closed']]);
  const d = byId(r);
  assert.deepEqual(d.D2, { id: 'D2', issue: 42, title: 'Deliverable 2', url: 'https://github.com/acme/shop/issues/42', status: 'available', factory: true, after: ['D1'], pr: { number: 142, url: 'https://github.com/acme/shop/pull/142', state: 'MERGED', merged: true }, estimate: { low_min: 60, high_min: 120 }, actual_min: 90, available_at: '2026-11-13T09:00:00.000Z', cost_usd: null });
  assert.equal(d.D3.pr.number, 144, 'the open pull request wins over a closed one');
  assert.equal(d.D3.actual_min, 45);
  assert.equal(d.D5.issue, 45);
  assert.deepEqual(d.D6, { id: 'D6', issue: null, title: 'Deliverable 6', url: null, status: 'not-created', factory: false, after: [], pr: null, estimate: null, actual_min: null, available_at: null, cost_usd: null });
  assert.deepEqual(r.progress, { done: 1, total: 7 });
  // D3 has an estimate and a time, but is not available yet: only D2 is compared
  assert.deepEqual(r.estimate_vs_actual.estimated, { low_min: 60, high_min: 120 });
  assert.equal(r.estimate_vs_actual.actual_min, 90);
  assert.equal(r.estimate_vs_actual.complete, false);
  assert.deepEqual(r.estimate_vs_actual.counted, { compared: 1, of: 7 });
  assert.match(r.estimate_vs_actual.basis, /last facts line/);
  assert.match(r.summary, /1 of 7 deliverables is available/);
  for (const args of w.calls) assert.ok(['issue view', 'issue list', 'pr view', 'pr list'].includes(`${args[0]} ${args[1]}`), `a read: ${args.join(' ')}`);
  for (const o of w.options) assert.equal(o.timeout, 20_000, 'every gh call has a timeout');
  assert.ok(r.warnings.includes('#47 was closed without a merged change.'));
  assert.ok(r.warnings.includes('D6 was not found yet (GitHub search can lag a minute).'));
});

test('only issues Eminzo created for this brief count: label, author, date, Part of line, known id, not the brief', () => {
  const forged = [
    issue('D5', 60, { author: 'mallory' }),
    issue('D5', 61, { createdAt: '2026-11-12T15:00:00Z' }),
    issue('D5', 62, { body: drafts.D5.body.replace('Part of #40', 'Part of #41') }),
    issue('D5', 63, { body: drafts.D5.body.replace('id=D5', 'id=D9') }),
    issue('D5', 64, { author: null }),
    { ...issue('D5', BRIEF_ISSUE), body: drafts.D5.body },
    issue('D5', 66, { body: drafts.D5.body.replace(/<!-- eminzo:deliverable [^>]*-->/, '<!-- eminzo:deliverable v1 brief=40 id=D5 -->') }),
  ];
  const w = world({ deliverables: [...forged, issue('D5', 45)], extra: [issue('D4', 70, { noLabel: true })] });
  const r = go(w, { known: [70] });
  assert.deepEqual(r.deliverables.filter((d) => d.status !== 'not-created').map((d) => [d.id, d.issue]), [['D5', 45]]);
  for (const n of [60, 61, 62, 63, 64, 66, 70]) {
    assert.ok(r.warnings.includes(`issue #${n} looks like a deliverable of this brief but was not created by Eminzo for it`), n);
  }
  assert.ok(r.warnings.includes(`issue #${BRIEF_ISSUE} looks like a deliverable of this brief but was not created by Eminzo for it`));
});

test('a localized Part of line is accepted', () => {
  const es = briefIssueDraft(approved).body;
  const body = drafts.D5.body.replace('Part of #40', 'Parte de #40');
  const { runner } = world({ deliverables: [issue('D5', 45, { body })], brief: briefData(es) });
  assert.equal(byId(initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner })).D5.status, 'waiting-tech-lead');
});

test('two valid issues for one deliverable: the earliest valid one counts and the others are named', () => {
  const w = world({ deliverables: [issue('D5', 46, { createdAt: '2026-11-12T17:00:00Z' }), issue('D5', 45, { createdAt: '2026-11-12T18:00:00Z' }), issue('D5', 48, { author: 'mallory', createdAt: '2026-11-12T15:30:00Z' })] });
  const r = go(w);
  assert.equal(byId(r).D5.issue, 46);
  assert.ok(r.warnings.includes('D5 has more than one issue (#46, #45); #46 is used.'));
  assert.ok(r.warnings.includes('issue #48 looks like a deliverable of this brief but was not created by Eminzo for it'));
});

test('status: available needs a completed close AND a merged pull request; reopened and unmerged closes say so', () => {
  const merged = { 142: pr(142, 'MERGED', '2026-11-13T09:00:00Z'), 144: pr(144, 'OPEN', null) };
  const cases = [
    ['closed completed with a merged change', { state: 'CLOSED', stateReason: 'COMPLETED' }, [{ number: 142 }], 'available', null],
    ['closed not planned with a merged change', { state: 'CLOSED', stateReason: 'NOT_PLANNED' }, [{ number: 142 }], 'closed', null],
    ['closed completed without a merged change', { state: 'CLOSED', stateReason: 'COMPLETED' }, [], 'closed', '#44 was closed without a merged change.'],
    ['closed without a reason', { state: 'CLOSED', stateReason: null }, [], 'closed', null],
    ['open again after a merged change', { labels: ['factory'] }, [{ number: 142 }], 'in-factory', '#44 was reopened after a merged change.'],
    ['open again, no factory label, after a merged change', {}, [{ number: 142 }], 'in-factory', '#44 was reopened after a merged change.'],
    ['open again with another change in review', { labels: ['factory'] }, [{ number: 142 }, { number: 144 }], 'in-review', '#44 was reopened after a merged change.'],
    ['open with only an open change', {}, [{ number: 144 }], 'in-review', null],
  ];
  for (const [name, over, refs, status, warning] of cases) {
    const r = go(world({ deliverables: [issue('D4', 44, over)], closing: { 44: refs }, prs: merged }));
    assert.equal(byId(r).D4.status, status, name);
    if (warning) assert.ok(r.warnings.includes(warning), name);
    else assert.equal(r.warnings.some((x) => /reopened|without a merged/.test(x)), false, name);
  }
});

test('the brief issue needs the eminzo-brief label and reports a different approver', () => {
  assert.throws(() => go(world({ brief: briefData(briefIssueDraft(approved).body, { labels: [] }) })), /^Error: Issue #40 is not an Eminzo brief issue: it does not have the eminzo-brief label\.$/);
  const r = go(world({ brief: briefData(briefIssueDraft(approved).body, { author: { login: 'carlos' } }) }));
  assert.equal(r.brief.author, 'carlos');
  assert.ok(r.warnings.includes('The brief issue was created by carlos but approved by ana-p.'));
});

test('a renamed brief issue is reported, because the title is not covered by the approval', () => {
  const r = go(world({ brief: briefData(briefIssueDraft(approved).body, { title: 'Brief: something else' }) }));
  assert.ok(r.warnings.includes('The title of the brief issue was changed after it was created; the approval does not cover the title.'));
  assert.equal(go(world()).warnings.some((x) => /title of the brief issue/.test(x)), false);
});

test('a brief issue edited after approval is loud, and its edited text decides nothing', () => {
  const edited = briefIssueDraft(approved).body.replace('- D7: Deliverable 7', '- D7: Deliverable 7 edited').replace('A reviewer sees what is pending.', 'Anything.') + '';
  const extra = edited.replace('- D6: Deliverable 6 | size: s | risk: low | covers: BC-1\n', '- D6: Deliverable 6 | size: s | risk: low | covers: BC-1\n- D8: Invented | size: s | risk: low | covers: BC-1\n');
  const r = go(world({ brief: briefData(extra) }));
  assert.equal(r.brief.valid, false);
  assert.match(r.warnings[0], /^WARNING: the brief issue no longer matches its approval: The brief changed after it was approved on 2026-11-12; approve it again\. /);
  assert.deepEqual(r.deliverables.map((d) => d.id), ['D1', 'D2', 'D3', 'D4', 'D5', 'D7'], 'only the valid issues found; the text invents none and hides none');
  assert.equal(r.deliverables.some((d) => d.status === 'not-created'), false);
  assert.equal(r.estimate_vs_actual.complete, false);
  assert.equal(r.warnings.some((x) => /not found yet/.test(x)), false);
  assert.match(r.summary, /no longer matches its approval/);
});

test('a non-brief issue is refused', () => {
  assert.throws(() => go(world({ brief: briefData('hello') })), /^Error: Issue #40 is not an Eminzo brief issue/);
});

test('a deliverable the search has not shown yet is read directly when the caller knows its number', () => {
  const late = issue('D6', 49, { labels: ['factory'] });
  const r = go(world({ extra: [late] }), { known: [49, 45] });
  assert.equal(byId(r).D6.issue, 49);
  assert.equal(byId(r).D6.status, 'in-factory');
  assert.equal(r.warnings.some((x) => /D6 was not found yet/.test(x)), false);
  assert.equal(byId(r).D5.issue, 45, 'a number the search also found counts once');
  assert.throws(() => go(world(), { known: new Array(51).fill(1) }), /known/);
  assert.throws(() => go(world(), { known: ['4'] }), /known/);
});

test('trust in pull requests: closing keywords only, facts only from factory branches, capped bodies', () => {
  const facts45 = facts('2026-11-13T10:00:00Z', '2026-11-13T10:45:00Z');
  const search = [
    pr(144, 'OPEN', null, `Closes #43\n${facts45}`),
    pr(150, 'OPEN', null, 'mentions #43 only'),
    pr(151, 'OPEN', null, 'see #430, closes #4'),
    pr(152, 'MERGED', '2026-11-13T10:00:00Z', `FIXES: #43\n${facts45}`, 'someone/else'),
  ];
  const r = go(world({ noRefs: true, deliverables: [issue('D3', 43, { labels: ['factory'] })], search }));
  const d3 = byId(r).D3;
  assert.equal(d3.pr.number, 144);
  assert.equal(d3.actual_min, 45);
  // the foreign-branch PR is a closing PR, but its facts line is not trusted
  const only = go(world({ noRefs: true, deliverables: [issue('D3', 43, { state: 'CLOSED', stateReason: 'COMPLETED' })], search: [search[3]] }));
  assert.equal(byId(only).D3.status, 'available');
  assert.equal(byId(only).D3.actual_min, null);
  const huge = go(world({ deliverables: [issue('D3', 43, { state: 'CLOSED', stateReason: 'COMPLETED' })], closing: { 43: [{ number: 142 }] }, prs: { 142: pr(142, 'MERGED', '2026-11-13T09:00:00Z', `${'x\n'.repeat(200_000)}${facts45}`) } }));
  assert.equal(byId(huge).D3.actual_min, null, 'a facts line beyond 256 KiB is not read');
  const many = go(world({ noRefs: true, deliverables: [issue('D3', 43)], search: new Array(30).fill(0).map((_, i) => pr(200 + i, 'OPEN', null, 'unrelated')) }));
  assert.ok(many.warnings.includes('only the first 30 pull requests that mention #43 were searched.'));
});

test('a pull request from a fork is never trusted, even from a branch named factory/x', () => {
  const fork = pr(300, 'OPEN', null, `Closes #44\n${facts('2026-11-13T10:00:00Z', '2026-11-13T10:05:00Z')}`, 'factory/evil', true);
  const forkMerged = pr(301, 'MERGED', '2026-11-13T10:00:00Z', facts('2026-11-13T10:00:00Z', '2026-11-13T10:05:00Z'), 'factory/evil', true);
  const open = go(world({ deliverables: [issue('D4', 44, { labels: ['factory'] })], closing: { 44: [{ number: 300 }] }, prs: { 300: fork } }));
  assert.equal(byId(open).D4.status, 'in-factory', 'the fork PR cannot move it to in-review');
  assert.equal(byId(open).D4.pr, null);
  assert.ok(open.warnings.includes('pull request #300 comes from a fork and is ignored.'));
  const done = go(world({ deliverables: [issue('D4', 44, { state: 'CLOSED', stateReason: 'COMPLETED' })], closing: { 44: [{ number: 301 }] }, prs: { 301: forkMerged } }));
  assert.equal(byId(done).D4.status, 'closed', 'a fork merge cannot make it available');
  assert.equal(byId(done).D4.actual_min, null);
  const search = go(world({ noRefs: true, deliverables: [issue('D4', 44, { labels: ['factory'] })], search: [fork] }));
  assert.equal(byId(search).D4.status, 'in-factory');
  const missing = { ...pr(302, 'OPEN', null, '', 'factory/x') };
  delete missing.isCrossRepository;
  assert.equal(byId(go(world({ deliverables: [issue('D4', 44, { labels: ['factory'] })], closing: { 44: [{ number: 302 }] }, prs: { 302: missing } }))).D4.status, 'in-factory', 'an unknown origin is not trusted');
});

test('known numbers are deduplicated: no false duplicate warning', () => {
  const w = world({ deliverables: [], extra: [issue('D5', 45)] });
  const r = go(w, { known: [45, 45, 45] });
  assert.equal(byId(r).D5.issue, 45);
  assert.equal(r.warnings.some((x) => /more than one issue/.test(x)), false);
  assert.equal(w.calls.filter((a) => a[0] === 'issue' && a[1] === 'view' && a[2] === '45' && a[4] !== 'closedByPullRequestsReferences').length, 1);
});

test('a call limit that cuts the head or the list read is a readable error', () => {
  assert.throws(() => go(world(), { maxCalls: 0 }), /^Error: gh call limit reached \(0\): the initiative of issue #40 could not be read\.$/);
  assert.throws(() => go(world(), { maxCalls: 1 }), /^Error: gh call limit reached \(1\): the initiative of issue #40 could not be read\.$/);
});

test('the last facts line of the pull request gives the actual time', () => {
  const body = `${facts('2026-11-12T16:00:00Z', '2026-11-12T16:30:00Z')}\n${facts('2026-11-12T16:00:00Z', '2026-11-12T18:00:00Z')}`;
  const r = go(world({ deliverables: [issue('D2', 42, { state: 'CLOSED', stateReason: 'COMPLETED' })], closing: { 42: [{ number: 142 }] }, prs: { 142: pr(142, 'MERGED', '2026-11-13T09:00:00Z', body) } }));
  assert.equal(byId(r).D2.actual_min, 120);
});

test('the comparison is complete only when every deliverable is available and has an actual time', () => {
  const brief = approveBrief(BRIEF.split('\n').filter((l) => !/^- D[2-7]:/.test(l)).join('\n'), { by: 'ana-p', at: AT });
  const one = deliverableIssueDrafts(brief, { briefIssue: BRIEF_ISSUE, estimates: { D1: { low_min: 30, high_min: 90, jobs: 5 } } })[0];
  const w = world({ brief: briefData(briefIssueDraft(brief).body), deliverables: [{ ...issue('D1', 41, { state: 'CLOSED', stateReason: 'COMPLETED' }), body: one.body }], closing: { 41: [{ number: 142 }] } });
  const r = go(w);
  assert.deepEqual(r.estimate_vs_actual, { estimated: { low_min: 30, high_min: 90 }, actual_min: 90, complete: true, counted: { compared: 1, of: 1 }, basis: r.estimate_vs_actual.basis });
  assert.deepEqual(r.progress, { done: 1, total: 1 });
});

test('the number is checked, and the number of gh calls is capped with a warning', () => {
  for (const bad of [0, -1, 1.5, '40', null, undefined]) assert.throws(() => initiative('/repo', { issue: bad, gh: 'gh', runner: world().runner }), /issue number/);
  const w = world();
  const r = go(w, { maxCalls: 4 });
  assert.ok(w.calls.length <= 4);
  assert.ok(r.warnings.includes('gh call limit reached (4): some pull requests were not read.'));
});

test('when gh fails, the error says why', () => {
  assert.throws(() => go(world({ broken: 'HTTP 401: Bad credentials' })), /^Error: could not read issue #40 from GitHub: HTTP 401: Bad credentials$/);
  assert.throws(() => initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner: () => ({ error: Object.assign(new Error('spawn gh'), { code: 'ENOENT' }) }) }), /the GitHub CLI \(gh\) is not installed/);
  assert.throws(() => initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner: () => ({ error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }) }) }), /gh did not answer within 20 seconds/);
  assert.throws(() => initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner: () => ({ status: 0, stdout: 'not json', stderr: '' }) }), /gh did not return JSON/);
});

test('an available deliverable says when it became available and what it cost, from the trusted pull request', () => {
  const merged = (body, head, cross) => world({ deliverables: [issue('D2', 42, { state: 'CLOSED', stateReason: 'COMPLETED' })], closing: { 42: [{ number: 142 }] }, prs: { 142: pr(142, 'MERGED', '2026-11-13T09:00:00Z', body, head, cross) } });
  const line = facts('2026-11-12T16:00:00Z', '2026-11-12T17:30:00Z', 1.234);
  const ok = byId(go(merged(line)));
  assert.equal(ok.D2.available_at, '2026-11-13T09:00:00.000Z', 'the merge time of the pull request');
  assert.equal(ok.D2.cost_usd, 1.23, 'the cost of the last facts line, in cents');
  assert.equal(byId(go(merged(line, 'feature/x'))).D2.cost_usd, null, 'not a factory branch: not trusted');
  assert.equal(byId(go(merged(line, 'factory/161-pending', true))).D2.status, 'closed', 'a fork is ignored altogether');
  for (const bad of [-1, 'free', Number.NaN]) assert.equal(byId(go(merged(facts('2026-11-12T16:00:00Z', '2026-11-12T17:30:00Z', bad)))).D2.cost_usd, null);
  const two = byId(go(merged(`${facts('2026-11-12T16:00:00Z', '2026-11-12T16:30:00Z', 5)}\n${line}`)));
  assert.equal(two.D2.cost_usd, 1.23, 'the LAST facts line counts');
});

test('the language of the approved brief is reported, null when its text is not trusted', () => {
  assert.equal(go(world()).language, 'en');
  const edited = go(world({ brief: briefData(`${briefIssueDraft(approved).body}\nedited`) }));
  assert.equal(edited.language, null);
});
