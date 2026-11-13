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
const facts = (started, entered) => factsComment({ v: 1, job: '161-pending', issue: 1, lane: 'normal', size: 's', risk: 'low', surfaces: [], round: 1, started, approve_entered: entered, cost_usd: null, decision: 'APPROVE' });

const issue = (id, number, { state = 'OPEN', stateReason = null, labels = [], body = drafts[id].body } = {}) => ({
  number, title: drafts[id].title, state, stateReason, body, labels: labels.map((name) => ({ name })), url: `https://github.com/acme/shop/issues/${number}`, closedAt: state === 'CLOSED' ? '2026-11-14T10:00:00Z' : null,
});
const pr = (number, state, mergedAt, body = '') => ({ number, state, mergedAt, body, url: `https://github.com/acme/shop/pull/${number}` });

function world(over = {}) {
  const data = {
    brief: { number: BRIEF_ISSUE, title: 'Brief: Pending filter', state: 'OPEN', body: briefIssueDraft(approved).body, labels: [{ name: 'eminzo-brief' }], url: `https://github.com/acme/shop/issues/${BRIEF_ISSUE}`, author: { login: 'ana-p' }, createdAt: '2026-11-12T15:05:00Z', closedAt: null },
    deliverables: [
      issue('D1', 41, { state: 'CLOSED', stateReason: 'NOT_PLANNED', labels: ['eminzo-deliverable'] }),
      issue('D2', 42, { state: 'CLOSED', stateReason: 'COMPLETED', labels: ['eminzo-deliverable', 'factory'] }),
      issue('D3', 43, { labels: ['eminzo-deliverable', 'factory'] }),
      issue('D4', 44, { labels: ['eminzo-deliverable', 'factory'] }),
      issue('D5', 45, { labels: ['eminzo-deliverable'] }),
      // D6: no issue yet
      issue('D7', 47, { state: 'CLOSED', stateReason: 'COMPLETED', labels: ['eminzo-deliverable'] }),
      // noise the search can return: another brief's deliverable, and a lookalike quoted in prose
      { ...issue('D5', 90, { body: drafts.D5.body.replace('brief=40', 'brief=400') }) },
      { ...issue('D5', 91, { body: `see the marker\n\`\`\`\n${drafts.D5.body}\n\`\`\`\n` }) },
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
  const out = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const fail = (why) => ({ status: 1, stdout: '', stderr: `${why}\n` });
  const runner = (cmd, args) => {
    calls.push(args);
    const [a, b] = args;
    if (data.broken) return fail(data.broken);
    if (a === 'issue' && b === 'view' && args[2] === String(BRIEF_ISSUE)) return out(data.brief);
    if (a === 'issue' && b === 'view' && args[3] === '--json' && args[4] === 'closedByPullRequestsReferences') {
      if (data.noRefs) return fail('Unknown JSON field: "closedByPullRequestsReferences"');
      return out({ closedByPullRequestsReferences: data.closing[args[2]] ?? [] });
    }
    if (a === 'issue' && b === 'view') return fail('could not resolve to an issue');
    if (a === 'issue' && b === 'list') {
      assert.ok(args.includes('--search'));
      const q = args[args.indexOf('--search') + 1];
      assert.equal(q, `"eminzo:deliverable v1 brief=${BRIEF_ISSUE} " in:body`);
      return out(data.deliverables);
    }
    if (a === 'pr' && b === 'view') return data.prs[args[2]] ? out(data.prs[args[2]]) : fail('no pull request found');
    if (a === 'pr' && b === 'list') return out(data.search ?? []);
    return fail(`unexpected ${args.join(' ')}`);
  };
  return { runner, calls };
}

const briefData = (body, over = {}) => ({ number: BRIEF_ISSUE, title: 'Brief: Pending filter', state: 'OPEN', body, labels: [], url: `https://github.com/acme/shop/issues/${BRIEF_ISSUE}`, author: { login: 'ana-p' }, createdAt: AT, closedAt: null, ...over });
const byId = (r) => Object.fromEntries(r.deliverables.map((d) => [d.id, d]));

test('every status, the progress, and estimate against actual', () => {
  const { runner, calls } = world();
  const r = initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner });
  assert.deepEqual(r.brief, { issue: 40, title: 'Brief: Pending filter', url: 'https://github.com/acme/shop/issues/40', state: 'OPEN', author: 'ana-p', created_at: '2026-11-12T15:05:00Z', approvedBy: 'ana-p', approvedAt: AT, valid: true });
  assert.deepEqual(r.deliverables.map((d) => [d.id, d.status]), [['D1', 'closed'], ['D2', 'available'], ['D3', 'in-review'], ['D4', 'in-factory'], ['D5', 'waiting-tech-lead'], ['D6', 'not-created'], ['D7', 'available']]);
  const d = byId(r);
  assert.deepEqual(d.D2, { id: 'D2', issue: 42, title: 'Deliverable 2', url: 'https://github.com/acme/shop/issues/42', status: 'available', factory: true, after: ['D1'], pr: { number: 142, url: 'https://github.com/acme/shop/pull/142', state: 'MERGED', merged: true }, estimate: { low_min: 60, high_min: 120 }, actual_min: 90 });
  assert.deepEqual(d.D3.pr, { number: 144, url: 'https://github.com/acme/shop/pull/144', state: 'OPEN', merged: false }, 'the open pull request wins over a closed one');
  assert.equal(d.D3.actual_min, 45);
  assert.equal(d.D4.pr, null);
  assert.equal(d.D5.factory, false);
  assert.equal(d.D5.issue, 45, 'a deliverable of another brief or a marker inside a code fence is not this one');
  assert.deepEqual(d.D6, { id: 'D6', issue: null, title: 'Deliverable 6', url: null, status: 'not-created', factory: false, after: [], pr: null, estimate: null, actual_min: null });
  assert.equal(d.D7.pr, null);
  assert.equal(d.D7.actual_min, null);
  assert.deepEqual(r.progress, { done: 2, total: 7 });
  // compared only where both an estimate and an actual exist: D2 (60-120 vs 90) and D3 (30-60 vs 45)
  assert.deepEqual(r.estimate_vs_actual, { estimated: { low_min: 90, high_min: 180 }, actual_min: 135, complete: false, counted: { compared: 2, of: 7 } });
  assert.match(r.summary, /2 of 7 deliverables are available/);
  assert.match(r.summary, /1 in review/);
  assert.match(r.summary, /1 not created yet/);
  for (const args of calls) assert.ok(['issue view', 'issue list', 'pr view', 'pr list'].includes(`${args[0]} ${args[1]}`), `a read: ${args.join(' ')}`);
});

test('the comparison is complete only when every deliverable is available and has an actual time', () => {
  const only = [issue('D1', 41, { state: 'CLOSED', stateReason: 'COMPLETED' })];
  const brief = approveBrief(BRIEF.split('\n').filter((l) => !/^- D[2-7]:/.test(l)).join('\n'), { by: 'ana-p', at: AT });
  const one = deliverableIssueDrafts(brief, { briefIssue: BRIEF_ISSUE, estimates: { D1: { low_min: 30, high_min: 90, jobs: 5 } } })[0];
  only[0].body = one.body;
  const { runner } = world({ brief: briefData(briefIssueDraft(brief).body), deliverables: only, closing: { 41: [{ number: 142 }] } });
  const r = initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner });
  assert.deepEqual(r.estimate_vs_actual, { estimated: { low_min: 30, high_min: 90 }, actual_min: 90, complete: true, counted: { compared: 1, of: 1 } });
  assert.deepEqual(r.progress, { done: 1, total: 1 });
});

test('a merged pull request makes it available even when the issue is still open', () => {
  const { runner } = world({ deliverables: [issue('D4', 44, { labels: ['factory'] })], closing: { 44: [{ number: 142 }] } });
  assert.equal(byId(initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner })).D4.status, 'available');
});

test('a closed issue without a reason and without a pull request is closed, not available', () => {
  const { runner } = world({ deliverables: [issue('D1', 41, { state: 'CLOSED', stateReason: null })] });
  assert.equal(byId(initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner })).D1.status, 'closed');
});

test('two issues for one deliverable: the lowest number counts and a warning says so', () => {
  const { runner } = world({ deliverables: [issue('D5', 46), issue('D5', 45)] });
  const r = initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner });
  assert.equal(byId(r).D5.issue, 45);
  assert.deepEqual(r.warnings, ['D5 has more than one issue (#45, #46); #45 is used.']);
});

test('a brief issue edited after approval is not valid, and a non-brief issue is refused', () => {
  const { runner } = world({ brief: briefData(briefIssueDraft(approved).body.replace('A reviewer sees what is pending.', 'Anything.'), { author: null }) });
  const r = initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner });
  assert.equal(r.brief.valid, false);
  assert.equal(r.brief.author, null);
  const plain = world({ brief: briefData('hello') });
  assert.throws(() => initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner: plain.runner }), /^Error: Issue #40 is not an Eminzo brief issue/);
});

test('deliverables from another approval of the same issue number are ignored with a warning', () => {
  const stale = issue('D5', 45, { body: drafts.D5.body.replace(/hash=[0-9a-f]{12}/, 'hash=000000000000') });
  const { runner } = world({ deliverables: [stale] });
  const r = initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner });
  assert.equal(byId(r).D5.status, 'not-created');
  assert.match(r.warnings[0], /^#45 belongs to another approval of this brief and is ignored\.$/);
});

test('older gh without closedByPullRequestsReferences: pull requests are searched by the issue number', () => {
  const { runner } = world({ noRefs: true, deliverables: [issue('D3', 43, { labels: ['factory'] })], search: [pr(144, 'OPEN', null, `Closes #43\n${facts('2026-11-13T10:00:00Z', '2026-11-13T10:45:00Z')}`), pr(150, 'OPEN', null, 'mentions #430')] });
  const d3 = byId(initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner })).D3;
  assert.equal(d3.status, 'in-review');
  assert.equal(d3.pr.number, 144);
});

test('when gh fails, the error says why', () => {
  assert.throws(() => initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner: world({ broken: 'HTTP 401: Bad credentials' }).runner }), /^Error: could not read issue #40 from GitHub: HTTP 401: Bad credentials$/);
  assert.throws(() => initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner: () => ({ error: Object.assign(new Error('spawn gh'), { code: 'ENOENT' }) }) }), /the GitHub CLI \(gh\) is not installed/);
  assert.throws(() => initiative('/repo', { issue: BRIEF_ISSUE, gh: 'gh', runner: () => ({ status: 0, stdout: 'not json', stderr: '' }) }), /gh did not return JSON/);
});
