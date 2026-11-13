// A repository with a factory and a known set of local jobs, for the read-only state queries and `eminzo mcp`.
// Every timestamp is relative to `now`, so the same jobs answer the same questions whenever the tests run.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOUR = 3_600_000;

/** The jobs and files of the fixture, as functions of `now` (ms). */
export function fixtureJobs(now) {
  const ago = (hours) => new Date(now - hours * HOUR).toISOString();
  return {
    '150-old-merged': {
      job: { issue: 150, title: 'Export suggestions', stage: 'merged', lane: 'normal', round: 1, max_rounds: 3, provider: 'claude', pr: 151,
        intake: { decision: 'ACCEPT', risk: 'low', surfaces: [], size: 's' }, gate: 'PASS', reviews: { code: 'PASS' }, history: [], decision: 'APPROVE',
        started: ago(122), approve_entered: ago(121.5), finished: ago(120), updated: ago(120), cost_usd: 2.5, cost_status: 'available' },
      files: { 'round-1/checks.md': 'GATE: PASS\nENGINE: 0.2.1\n\nThe checks passed in 40s on commit abc1234.\n', 'round-1/review-code.md': 'VERDICT: PASS\n\nFine.\n',
        'decision.md': 'APPROVE\nThe only lens passed and the diff stays in scope.\n\n## Lessons\nNone\n' },
    },
    '155-escalated': {
      job: { issue: 155, title: 'Concurrency control on suggestions', stage: 'needs-human', lane: 'normal', round: 2, max_rounds: 3, provider: 'claude', pr: 160,
        intake: { decision: 'ACCEPT', risk: 'high', surfaces: ['security'], size: 'm' }, gate: 'PASS', reviews: { code: 'PASS', security: 'PASS' },
        history: [{ gate: 'PASS', reviews: { code: 'PASS', security: 'CHANGES' } }], decision: 'ESCALATE', parked_from: 'approve',
        note: 'the change widens who can approve suggestions', started: ago(9), approve_entered: ago(4), updated: ago(3), cost_usd: 14.2, cost_status: 'available',
        cost_by_agent: { by_role: { 'eminzo-builder': 10.1, 'eminzo-review-security': 2.05, 'eminzo-spec-writer': 2.05 } } },
      files: {
        'intake.md': 'ACCEPT\nRISK: high\nSURFACES: security\nRESCOPED: no\nSIZE: m\n',
        'round-1/checks.md': 'GATE: PASS\n\nThe checks passed in 2m 3s.\n',
        'round-1/review-code.md': 'VERDICT: PASS\n',
        'round-1/review-security.md': 'VERDICT: CHANGES\n\n- [blocker] approvals skip the role check\n  Proof: src/a.ts:10\n- [blocker] the token is logged\n  Proof: src/b.ts:4\n- [nit] naming\n',
        'round-2/checks.md': 'GATE: PASS\n\nThe checks passed in 1m 50s.\n',
        'round-2/review-code.md': 'VERDICT: PASS\n',
        'round-2/review-security.md': 'VERDICT: PASS\n',
        'decision.md': 'ESCALATE\nThe change widens who can approve suggestions, a permission change: a person decides.\n',
      },
    },
    '158-merged-recent': {
      job: { issue: 158, title: 'Fix a typo in the footer', stage: 'merged', lane: 'xs', round: 1, max_rounds: 3, provider: 'claude', pr: 159,
        intake: { decision: 'ACCEPT', risk: 'low', surfaces: [], size: 'xs' }, gate: 'PASS', reviews: { code: 'PASS' }, history: [], decision: 'APPROVE',
        started: ago(6), approve_entered: ago(5.6), finished: ago(2), updated: ago(2), cost_usd: 0.7, cost_status: 'available' },
      files: {},
    },
    '161-question': {
      job: { issue: 161, title: 'Filter rows by owner', stage: 'needs-info', lane: 'normal', round: 1, max_rounds: 3, provider: 'claude',
        intake: { decision: 'NEEDS-INFO', risk: 'medium', surfaces: ['ui'], size: 'm' }, history: [], note: 'which roles see the filter?',
        started: ago(31), updated: ago(30), cost_usd: 0, cost_status: 'available' },
      files: {},
    },
    '162-building': {
      job: { issue: 162, title: 'Optional spec review', stage: 'build', lane: 'normal', round: 3, max_rounds: 3, provider: 'claude', pr: 166,
        intake: { decision: 'ACCEPT', risk: 'medium', surfaces: [], size: 'm' }, gate: null, reviews: {},
        history: [{ gate: 'FAIL', reviews: {} }, { gate: 'PASS', reviews: { human: 'CHANGES' } }], started: ago(1), updated: ago(1 / 6), cost_usd: 6.4, cost_status: 'available' },
      files: { 'round-1/checks.md': 'GATE: FAIL\n\nThe checks failed: the checks command exited with code 1.\n', 'round-2/checks.md': 'GATE: PASS\n', 'round-2/review-human.md': 'VERDICT: CHANGES\n\nPlease rename the flag.\n' },
    },
    '163-review': {
      job: { issue: 163, title: 'Dashboard compact mode', stage: 'review', lane: 'normal', round: 1, max_rounds: 3, provider: 'codex', pr: 167,
        intake: { decision: 'ACCEPT', risk: 'low', surfaces: ['ui'], size: 's' }, gate: 'PASS', reviews: { code: 'pending', ui: 'pending' }, history: [],
        started: ago(20), updated: ago(1 / 3), cost_status: 'unavailable' },
      files: {},
    },
    '164-awaiting': {
      job: { issue: 164, title: 'Release notes page', stage: 'awaiting-merge', lane: 'normal', round: 1, max_rounds: 3, provider: 'claude', pr: 168,
        intake: { decision: 'ACCEPT', risk: 'low', surfaces: [], size: 's' }, gate: 'PASS', reviews: { code: 'PASS' }, history: [], decision: 'APPROVE',
        started: ago(30), approve_entered: ago(5.5), updated: ago(5), cost_usd: 3.1, cost_status: 'available' },
      files: {},
    },
    '165-spec-review': {
      job: { issue: 165, title: 'Notifications digest', stage: 'spec-review', lane: 'normal', round: 1, max_rounds: 3, provider: 'claude',
        intake: { decision: 'ACCEPT', risk: 'medium', surfaces: [], size: 'l' }, history: [], started: ago(52), updated: ago(50), cost_usd: 1.2, cost_status: 'available' },
      files: {},
    },
    '170-rejected': {
      job: { issue: 170, title: 'Rewrite the router', stage: 'rejected', lane: 'normal', round: 1, max_rounds: 3, provider: 'claude',
        intake: { decision: 'REJECT', risk: 'high', surfaces: [], size: 'l' }, history: [], started: ago(73), finished: ago(72), updated: ago(72), cost_usd: 0.4, cost_status: 'available' },
      files: {},
    },
  };
}

/** Issues the fake gh lists as open `factory` issues: 162 already has a local job, 180 and 181 do not. */
export const QUEUE_ISSUES = [
  { number: 181, title: 'Add CSV import', assignees: [], labels: [{ name: 'factory' }], createdAt: '2026-11-10T10:00:00Z', url: 'https://github.com/acme/shop/issues/181' },
  { number: 162, title: 'Optional spec review', assignees: [{ login: 'dev' }], labels: [{ name: 'factory' }], createdAt: '2026-11-01T10:00:00Z', url: 'https://github.com/acme/shop/issues/162' },
  { number: 180, title: 'Dark mode <script>alert(1)</script>', assignees: [], labels: [{ name: 'factory' }, { name: 'factory:xs' }], createdAt: '2026-11-09T10:00:00Z', url: 'https://github.com/acme/shop/issues/180' },
];

/**
 * The fake gh: lists QUEUE_ISSUES as the open `factory` issues and, for an initiative, answers from `fake-gh.json` next
 * to it ({ issues: {n: issue}, list: [issues a search returns], closing: {n: [{number}]}, prs: {n: pr} }). Anything
 * else fails, and so does any command that is not a read.
 */
const FAKE_GH = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
const data = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'fake-gh.json'), 'utf8')); } catch { return {}; } })();
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const fail = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const reads = ['issue list', 'issue view', 'pr list', 'pr view'];
if (!reads.includes(a[0] + ' ' + a[1])) fail('fake gh: not a read: ' + a.join(' '));
if (a[0] === 'issue' && a[1] === 'list' && a.includes('--search')) out(data.list || []);
else if (a[0] === 'issue' && a[1] === 'list') out(__QUEUE__);
else if (a[0] === 'issue' && a[1] === 'view' && a[4] === 'closedByPullRequestsReferences') out({ closedByPullRequestsReferences: (data.closing || {})[a[2]] || [] });
else if (a[0] === 'issue' && a[1] === 'view') { (data.issues || {})[a[2]] ? out(data.issues[a[2]]) : fail('Could not resolve to an issue with the number of ' + a[2]); }
else if (a[0] === 'pr' && a[1] === 'view') { (data.prs || {})[a[2]] ? out(data.prs[a[2]]) : fail('no pull request found for ' + a[2]); }
else fail('fake gh: unsupported ' + a.join(' '));
`;

/** The team config of the fixture repository. */
export const FIXTURE_CONFIG = {
  repo: 'https://github.com/acme/shop', base: 'origin/main', concurrency: 2, max_rounds: 3, auto_merge: false, spec_review: ['high'], language: 'es',
  default_provider: 'claude', providers: { claude: {}, codex: {} }, lanes: { xs: { reviewers: ['code'] } },
  routing: { reviewers: { code: { always: true }, ui: { surface: 'ui' }, security: { surface: 'security' } } },
  prices: { opus: { input: 4 } },
};

/**
 * A temp repository with the fixture jobs (plus a v1 folder without job.json and a broken job.json),
 * and a fake gh that lists QUEUE_ISSUES. Returns `{ root, gh }`.
 */
export function stateFixture({ now = Date.now(), jobs = fixtureJobs(now), config = FIXTURE_CONFIG } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-state-'));
  mkdirSync(join(root, 'factory/jobs'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(config, null, 2));
  for (const [id, { job, files }] of Object.entries(jobs)) {
    const dir = join(root, 'factory/jobs', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ id, ...job }, null, 2));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
  }
  mkdirSync(join(root, 'factory/jobs/149-v1-folder'), { recursive: true });
  mkdirSync(join(root, 'factory/jobs/171-broken'), { recursive: true });
  writeFileSync(join(root, 'factory/jobs/171-broken/job.json'), '{ not json');
  const gh = join(root, 'fake-gh');
  writeFileSync(gh, FAKE_GH.replace('__QUEUE__', () => JSON.stringify(JSON.stringify(QUEUE_ISSUES))));
  chmodSync(gh, 0o755);
  return { root, gh };
}
