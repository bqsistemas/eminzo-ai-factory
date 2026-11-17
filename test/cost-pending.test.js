// A Claude job whose cost was never synced (or whose sync found no usage) is unknown cost, never $0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { costAvailable, costLabel, costTimeHtml } from '../factory/activity.js';
import { headerStats } from '../factory/office.js';
import { stageDetails } from '../factory/pipeline-canvas.js';
import { jobView } from '../factory/lib/state/jobs.js';
import { periodSummary } from '../factory/lib/state/queries.js';
import { diagnosis } from '../factory/lib/state/diagnosis.js';
import { deliveryMetrics } from '../factory/lib/state/delivery.js';
import { jobFacts } from '../factory/lib/record-facts.js';
import { localRecords } from '../factory/lib/state/history.js';
import { setup } from './helpers/job-harness.js';
import { addJob, emptyRoot } from './helpers/delivery-fixture.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const PRICES = { opus: { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 } };
const user = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
const assistant = (id, model, [input, output]) => JSON.stringify({
  type: 'assistant',
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
});
const jsonl = (...lines) => `${lines.join('\n')}\n`;
const ID = '004-dark-mode';
const WITH_USAGE = jsonl(user(`Job folder: factory/jobs/${ID}/\n`), assistant('m1', 'claude-opus-4-5', [1000, 2000])); // 0.055
const OTHER_JOB = jsonl(user('Job folder: factory/jobs/005-other/\n'), assistant('m2', 'claude-opus-4-5', [1000, 2000]));
const NO_PRICE = jsonl(user(`Job folder: factory/jobs/${ID}/\n`), assistant('m3', 'claude-mystery-9', [1000, 2000]));

function syncRoot(transcriptFiles, jobFields) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-pending-'));
  const root = join(dir, 'root');
  const transcripts = join(dir, 'transcripts');
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  write(join(root, 'factory/config.json'), JSON.stringify({ repo: 'https://github.com/example/app', prices: PRICES }));
  mkdirSync(transcripts, { recursive: true });
  Object.entries(transcriptFiles).forEach(([name, text]) => write(join(transcripts, name), text));
  const jobFile = join(root, 'factory/jobs', ID, 'job.json');
  write(jobFile, JSON.stringify({
    id: ID, issue: 12, title: 'Dark mode', pr: 31, stage: 'review', round: 1, max_rounds: 3, provider: 'claude', gate: 'PASS',
    reviews: {}, history: [], decision: null, note: '', started: '2026-11-02T14:00:00Z', finished: null, ...jobFields,
  }));
  const sync = () => spawnSync(join(repo, 'factory/bin/job'), [ID, 'sync'], {
    encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root, FACTORY_TRANSCRIPTS: transcripts },
  });
  const summary = () => spawnSync(join(repo, 'factory/bin/job'), ['summary'], {
    encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root },
  });
  return { root, sync, summary, read: () => JSON.parse(readFileSync(jobFile, 'utf8')) };
}

test('AC-1: job new creates a Claude job as pending with no cost, and a Codex job as before', async () => {
  const t = setup();
  t.issue(5);
  t.issue(6);
  const claude = (await t.job('new', '5')).stdout.trim();
  const codex = (await t.job('new', '6', '--provider', 'codex')).stdout.trim();
  const job = t.json(claude);
  assert.equal(job.cost_usd, null);
  assert.equal(job.cost_status, 'pending');
  assert.ok(job.cost_reason === undefined || job.cost_reason === null);
  const onBoard = t.board().jobs.find((j) => j.id === claude);
  assert.equal(onBoard.cost_usd, null);
  assert.equal(onBoard.cost_status, 'pending');
  assert.equal(jobView(job).cost_usd, null);
  const other = t.json(codex);
  assert.equal(other.cost_usd, null);
  assert.equal(other.cost_status, 'unavailable');
  assert.equal(other.cost_reason, 'no_associated_usage');
});

test('AC-2: sync of a pending job with priced usage makes it available with the total', () => {
  const fx = syncRoot({ 's/subagents/a.jsonl': WITH_USAGE }, { cost_usd: null, cost_status: 'pending' });
  const res = fx.sync();
  assert.equal(res.status, 0, res.stderr);
  const job = fx.read();
  assert.equal(job.cost_status, 'available');
  assert.equal(job.cost_reason, null);
  assert.ok(Math.abs(job.cost_usd - 0.055) < 1e-9, `cost_usd ${job.cost_usd}`);
  assert.ok(job.cost_by_agent);
  assert.match(res.stdout, /\$0\.06/);
  assert.equal(jobView(job).cost_usd, 0.06);
});

test('AC-3: sync with no priced usage leaves the job pending, never $0.00; an available cost is kept', () => {
  const cases = {
    'empty folder': {},
    'only another job': { 's/subagents/a.jsonl': OTHER_JOB },
    'only an unpriced model': { 's/subagents/a.jsonl': NO_PRICE },
  };
  for (const [name, files] of Object.entries(cases)) {
    for (const fields of [{ cost_usd: null, cost_status: 'pending' }, { cost_usd: 0 }]) {
      const fx = syncRoot(files, fields);
      const res = fx.sync();
      assert.equal(res.status, 0, res.stderr);
      const job = fx.read();
      assert.equal(job.cost_status, 'pending', name);
      assert.equal(job.cost_usd, null, name);
      assert.equal(job.cost_by_agent, undefined, name);
      assert.doesNotMatch(res.stdout, /\$0\.00/, name);
      assert.doesNotMatch(fx.summary().stdout, /\$0\.00/, name);
    }
  }
  const by = { builder: { usd: 1.5 } };
  const fx = syncRoot({}, { cost_usd: 1.5, cost_status: 'available', cost_reason: null, cost_by_agent: by });
  assert.equal(fx.sync().status, 0);
  const job = fx.read();
  assert.equal(job.cost_usd, 1.5);
  assert.equal(job.cost_status, 'available');
  assert.equal(job.cost_reason, null);
  assert.deepEqual(job.cost_by_agent, by);
});

test('AC-4: provider claude resets the cost to pending; provider codex stays unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-pending-switch-'));
  const root = join(dir, 'root');
  mkdirSync(join(root, 'factory/jobs', ID), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), readFileSync(join(repo, 'factory/config.json')));
  const jobFile = join(root, 'factory/jobs', ID, 'job.json');
  writeFileSync(jobFile, JSON.stringify({
    id: ID, issue: 42, title: 'Switch', pr: 7, stage: 'build', round: 1, max_rounds: 3, provider: 'codex', lane: 'normal',
    intake: { decision: 'ACCEPT', rescoped: false, risk: 'low', surfaces: [], size: 's' }, agents: null, models: {},
    gate: null, reviews: {}, history: [], decision: null, note: '', parked_from: null,
    cost_usd: null, cost_status: 'unavailable', cost_reason: 'no_associated_usage', cost_by_agent: { builder: { usd: 1 } },
    started: '2026-11-01T00:00:00.000Z', finished: null, updated: '2026-11-01T00:00:00.000Z',
  }));
  const run = (...args) => spawnSync(join(repo, 'factory/bin/job'), [ID, ...args], { encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root } });
  const read = () => JSON.parse(readFileSync(jobFile, 'utf8'));
  assert.equal(run('provider', 'claude').status, 0);
  let job = read();
  assert.equal(job.cost_status, 'pending');
  assert.equal(job.cost_usd, null);
  assert.equal(job.cost_reason, undefined);
  assert.equal(job.cost_by_agent, undefined);
  assert.equal(job.provider_switches.at(-1).cost_usd, null);
  assert.equal(run('provider', 'codex').status, 0);
  job = read();
  assert.equal(job.cost_status, 'unavailable');
  assert.equal(job.cost_reason, 'no_associated_usage');
});

test('AC-5: a pending job is unknown cost in the card, inspector and header, never $0.00', () => {
  const unavailable = { provider: 'claude', cost_status: 'unavailable', cost_usd: null };
  for (const cost_usd of [null, 3]) {
    const job = { provider: 'claude', cost_status: 'pending', cost_usd };
    assert.equal(costAvailable(job), false);
    assert.equal(costLabel(job), costLabel(unavailable));
    assert.equal(stageDetails(job, 'build').cost, stageDetails(unavailable, 'build').cost);
    assert.doesNotMatch(costTimeHtml(job), /\$0\.00/);
    assert.doesNotMatch(costLabel(job), /\$0\.00/);
    assert.doesNotMatch(stageDetails(job, 'build').cost, /\$0\.00/);
    const stats = headerStats([job, { cost_usd: 2 }]);
    assert.equal(stats.cost, 2);
    assert.equal(stats.cost_unavailable, 1);
  }
  assert.equal(costLabel({ cost_usd: 0 }), '$0.00');
  assert.equal(costLabel({ cost_status: 'available', cost_usd: 0 }), '$0.00');
  assert.equal(costAvailable({ cost_usd: 0 }), true);
  assert.equal(costAvailable({ provider: 'codex', cost_status: 'unavailable', cost_usd: null }), false);
  assert.equal(headerStats([{ provider: 'codex', cost_status: 'unavailable', cost_usd: null }]).cost_unavailable, 1);
});

test('AC-6: facts and local records give no cost for a pending job', () => {
  const root = emptyRoot();
  const base = { stage: 'merged', started: '2026-09-10T10:00:00.000Z', approve_entered: '2026-09-10T10:30:00.000Z', finished: '2026-09-10T12:00:00.000Z' };
  const jobs = {
    '101-null': { ...base, issue: 1, cost_status: 'pending', cost_usd: null },
    '102-old': { ...base, issue: 2, cost_status: 'pending', cost_usd: 4 },
    '103-legacy': { ...base, issue: 3, cost_status: undefined, cost_usd: 2.5 },
    '104-available': { ...base, issue: 4, cost_status: 'available', cost_usd: 1 },
  };
  for (const [id, fields] of Object.entries(jobs)) addJob(root, id, { id, ...fields });
  const costs = Object.fromEntries(localRecords(root).map((r) => [r.job ?? r.id, r.cost_usd]));
  assert.deepEqual(Object.values(costs).sort(), [1, 2.5, null, null].sort());
  assert.equal(jobFacts({ id: 'x', ...jobs['101-null'] }).cost_usd, null);
  assert.equal(jobFacts({ id: 'x', ...jobs['102-old'] }).cost_usd, null);
  assert.equal(jobFacts({ id: 'x', ...jobs['103-legacy'] }).cost_usd, 2.5);
  assert.equal(jobFacts({ id: 'x', ...jobs['104-available'] }).cost_usd, 1);
});

test('AC-7: a mixed period counts pending and unavailable jobs as without cost, in every delivery reader', () => {
  const root = emptyRoot();
  const mk = (issue, fields) => ({
    issue, title: `Job ${issue}`, stage: 'merged', started: '2026-09-10T10:00:00.000Z', approve_entered: '2026-09-10T10:30:00.000Z',
    finished: '2026-09-10T12:00:00.000Z', updated: '2026-09-10T12:00:00.000Z', intake: { decision: 'ACCEPT', risk: 'low', surfaces: [], size: 's' }, ...fields,
  });
  addJob(root, '101-pending', mk(101, { cost_status: 'pending', cost_usd: null }));
  addJob(root, '102-available', mk(102, { cost_status: 'available', cost_usd: 1.25 }));
  addJob(root, '103-codex', mk(103, { provider: 'codex', cost_status: 'unavailable', cost_usd: null, cost_reason: 'no_associated_usage' }));
  const period = { from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z', now: Date.parse('2026-10-02T12:00:00Z') };
  assert.deepEqual(periodSummary(root, period).cost_usd, { known: 1.25, jobs_with_cost: 1, jobs_without_cost: 2 });
  assert.equal(diagnosis(root, period).cost.known, 1.25);
  const cost = deliveryMetrics(root, { from: '2026-09-01', to: '2026-09-30', now: period.now }).current.cost;
  assert.equal(cost.known_usd, 1.25);
  assert.equal(cost.jobs_with_cost, 1);
  assert.equal(cost.jobs_without_cost, 2);
  const res = spawnSync('sh', [join(repo, 'factory/bin/job'), 'metrics', 'delivery', '--json', '--from', '2026-09-01', '--to', '2026-09-30'], {
    encoding: 'utf8', cwd: root, env: { ...process.env, FACTORY_ROOT: root, TZ: 'America/Costa_Rica' },
  });
  assert.equal(res.status, 0, res.stderr);
  const cli = JSON.parse(res.stdout).current.cost;
  assert.deepEqual([cli.known_usd, cli.jobs_with_cost, cli.jobs_without_cost], [1.25, 1, 2]);
});

test('AC-8: the repo declares the dashboard pages that factory/bin/visual checks (run by the builder and the gate)', () => {
  const config = JSON.parse(readFileSync(join(repo, 'factory/config.json'), 'utf8'));
  assert.ok(Array.isArray(config.visual?.pages) && config.visual.pages.length > 0);
});
