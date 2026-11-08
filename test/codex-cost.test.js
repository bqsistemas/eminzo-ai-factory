// Additional cost coverage: test/cost.test.js is protected and stays untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as costs from '../factory/lib/cost.js';
import { costTimeHtml } from '../factory/activity.js';
import { stageDetails } from '../factory/pipeline-canvas.js';
import { formatCost, headerStats } from '../factory/office.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const root = '/repo';
const job = { id: '034-cost', provider: 'codex', worktree: '/repo/.worktrees/034-cost' };
// Synthetic rates, not vendor prices. Codex input includes read/write cache subsets.
const price = { input: 10, cache_read: 2, cache_write: 5, output: 20 };
const prices = { model: price, free: { input: 0, cache_read: 0, cache_write: 0, output: 0 } };
const event = (type, payload) => ({ type, payload });
const context = (model = 'model') => event('turn_context', { model });
const prompt = (text) => event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const usage = (input = 1000, cached = 400, write = 100, output = 200) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write, output_tokens: output,
  reasoning_output_tokens: 50, total_tokens: input + output,
});
const snapshot = (u = usage()) => event('event_msg', { type: 'token_count', info: { total_token_usage: u, last_token_usage: usage(999999) } });
const jsonl = (rows) => rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');
const rollout = (rows = [context(), snapshot()], extra = {}) => jsonl([
  event('session_meta', { id: 'session-a', cwd: job.worktree, ...extra }), ...rows,
]);
const calculate = (files, p = prices) => costs.codexJobCost(files, job, p, root);
const expected = (500 * 10 + 400 * 2 + 100 * 5 + 200 * 20) / 1e6;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-codex-cost-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, 'root'), sessions = join(dir, 'sessions'), transcripts = join(dir, 'transcripts');
  const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  const id = job.id;
  const stored = { ...job, worktree: join(base, '.worktrees', id), stage: 'build', issue: 44, round: 1, reviews: {}, cost_usd: 0 };
  write(join(base, 'factory/config.json'), JSON.stringify({ prices: { opus: price }, providers: { codex: { prices } } }));
  write(join(base, 'factory/jobs', id, 'job.json'), JSON.stringify(stored));
  write(join(sessions, '2026/10/30/rollout.jsonl'), rollout([context(), snapshot()], { cwd: stored.worktree }));
  const cli = (...args) => spawnSync(join(repo, 'factory/bin/job'), args, {
    encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: base, FACTORY_CODEX_SESSIONS: sessions, FACTORY_TRANSCRIPTS: transcripts },
  });
  const readJob = () => JSON.parse(readFileSync(join(base, 'factory/jobs', id, 'job.json'), 'utf8'));
  return { base, sessions, transcripts, write, cli, readJob, stored };
}

test('AC-1: Codex sync prices uncached input, cache read/write and output without double-counting reasoning', (t) => {
  const f = fixture(t), res = f.cli(job.id, 'sync');
  assert.equal(res.status, 0, res.stderr);
  const j = f.readJob();
  assert.equal(j.cost_status, 'available');
  assert.ok(Math.abs(j.cost_usd - expected) < 1e-12);
  assert.match(res.stdout, /\$0\.01/);
});

test('AC-2: cumulative snapshots, duplicate rollouts, partial copies and last_token_usage never double-count', () => {
  const first = rollout([context(), snapshot(usage(500, 200, 50, 100))]);
  const full = rollout([context(), snapshot(usage(500, 200, 50, 100)), 'broken line', snapshot(), snapshot(),
    event('event_msg', { type: 'token_count', info: null })]);
  const result = calculate([first, full, full]);
  assert.equal(result.cost_status, 'available');
  assert.ok(Math.abs(result.cost_usd - expected) < 1e-12);
});

test('AC-2: cumulative deltas use the model active for each response, including model switches', () => {
  const result = calculate([rollout([context(), snapshot(usage(500, 200, 50, 100)), context('free'), snapshot()])]);
  assert.ok(Math.abs(result.cost_usd - expected / 2) < 1e-12);
  assert.equal(calculate([rollout([context('free'), snapshot()])]).cost_usd, 0, 'known zero is available');
});

test('AC-3: exact worktree or dedicated job prompt associates only the correct repository/job/session', () => {
  const dedicated = rollout([prompt('Instructions with factory/jobs/999-other/ only as prose'),
    prompt('Job folder: factory/jobs/034-cost/\nBranch: factory/034-cost'), context(), snapshot()], { cwd: root });
  const unrelated = [
    rollout([context(), snapshot()], { cwd: '/repo/.worktrees/034-cost-extra', id: 'near' }),
    rollout([prompt('Job folder: factory/jobs/034-cost/'), context(), snapshot()], { cwd: '/other', id: 'foreign' }),
    rollout([prompt('Compare factory/jobs/034-cost/'), context(), snapshot()], { cwd: root, id: 'mention' }),
    rollout([context(), snapshot()], { cwd: '/repo/.worktrees/999-other', id: 'other' }),
  ];
  assert.ok(Math.abs(calculate([dedicated, ...unrelated]).cost_usd - expected) < 1e-12);
  assert.equal(calculate(unrelated).cost_status, 'unavailable');
  assert.ok(Math.abs(calculate([dedicated, rollout([], { id: 'unused' })]).cost_usd - expected) < 1e-12);
});

test('AC-3: conflicting evidence, shared sessions and usage preceding job assignment are not attributed', () => {
  for (const rows of [
    [prompt('Job folder: factory/jobs/999-other/'), context(), snapshot()],
    [prompt('Job folder: factory/jobs/034-cost/'), context(), snapshot(), prompt('Job folder: factory/jobs/999-other/'), snapshot()],
  ]) assert.equal(calculate([rollout(rows)]).cost_status, 'unavailable');
  const late = rollout([context(), snapshot(), prompt('Job folder: factory/jobs/034-cost/'), snapshot()], { cwd: root });
  assert.equal(calculate([late]).cost_status, 'unavailable');
  const copiedConflict = rollout([context(), snapshot()], { cwd: '/repo/.worktrees/999-other' });
  assert.equal(calculate([rollout(), copiedConflict]).cost_status, 'unavailable');
});

test('AC-4: missing prices/models/usage and invalid counters yield null, not a fabricated zero', () => {
  const files = [rollout()];
  for (const result of [calculate(files, {}), calculate([]), calculate([rollout([snapshot()])]),
    calculate([rollout([context(), snapshot({ ...usage(), cached_input_tokens: 2000 })])]),
    calculate([rollout([context(), snapshot(usage()), snapshot(usage(1, 0, 0, 0))])]),
    calculate(files, { model: { ...price, input: -1 } }),
  ]) {
    assert.equal(result.cost_status, 'unavailable');
    assert.equal(result.cost_usd, null);
    assert.ok(result.cost_reason);
  }
  assert.equal(calculate(files, {}).cost_reason, 'missing_price');
  assert.equal(calculate([rollout([context('model-not-an-alias'), snapshot()])]).cost_status, 'unavailable');
  assert.equal(calculate([rollout(), rollout([context('unknown'), snapshot()], { id: 'unknown-session' })]).cost_usd, null);
});

test('AC-4: sync persists unavailable state in job and board without leaking rollout text', (t) => {
  const f = fixture(t);
  f.write(join(f.base, 'factory/config.json'), JSON.stringify({ providers: { codex: { prices: {} } } }));
  const res = f.cli(job.id, 'sync');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /unavailable/);
  assert.doesNotMatch(res.stdout, /\$0\.00/);
  const j = f.readJob();
  assert.equal(j.cost_usd, null);
  assert.equal(j.cost_status, 'unavailable');
  assert.equal(j.cost_reason, 'missing_price');
  const summary = f.cli('summary');
  assert.doesNotMatch(summary.stdout, /\$0\.00/);
  const board = JSON.parse(readFileSync(join(f.base, 'factory/board.json'), 'utf8'));
  assert.equal(board.jobs[0].cost_usd, null);
  assert.equal(board.jobs[0].cost_status, j.cost_status);
  assert.equal(board.jobs[0].cost_reason, j.cost_reason);
});

test('AC-5: legacy Claude sync retains its alias, message dedupe and numeric zero behavior', (t) => {
  const f = fixture(t);
  f.write(join(f.base, 'factory/jobs', job.id, 'job.json'), JSON.stringify({ ...f.stored, provider: 'claude' }));
  const message = { type: 'assistant', message: { id: 'm1', model: 'claude-opus-4', usage: { input_tokens: 1000, output_tokens: 200 } } };
  f.write(join(f.transcripts, 'session/subagents/agent.jsonl'), jsonl([
    { type: 'user', message: { content: `Job folder: factory/jobs/${job.id}/` } }, message, message,
  ]));
  assert.equal(f.cli(job.id, 'sync').status, 0);
  assert.equal(f.readJob().cost_usd, 0.014);
  assert.equal(costs.jobCost([], job.id, { opus: price }), 0);
});

test('AC-6: cards, pipeline details, summary and header totals distinguish unavailable from genuine zero', (t) => {
  const f = fixture(t);
  const unknown = { ...f.stored, cost_status: 'unavailable', cost_usd: null };
  f.write(join(f.base, 'factory/jobs', job.id, 'job.json'), JSON.stringify(unknown));
  f.write(join(f.base, 'factory/jobs/035-known/job.json'), JSON.stringify({ id: '035-known', cost_usd: 2, stage: 'merged' }));
  const res = f.cli('summary');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout.split('\n')[0], /unavailable/);
  assert.match(res.stdout, /total:.*\$2\.00.*1.*unavailable/);
  assert.doesNotMatch(costTimeHtml(unknown), /\$0\.00/);
  assert.match(costTimeHtml(unknown), /unavailable/i);
  assert.match(stageDetails(unknown, 'build').cost, /unavailable/i);
  // Even a stale numeric value must not override explicit unavailability.
  assert.match(costTimeHtml({ ...unknown, cost_usd: 0 }), /unavailable/i);
  const s = headerStats([unknown, { cost_usd: 2 }]);
  assert.equal(s.cost, 2);
  assert.equal(s.cost_unavailable, 1);
  assert.match(formatCost(s.cost, s.cost_unavailable), /\$2\.00.*unavailable/);
  assert.match(formatCost(0, 1), /unavailable/);
  assert.doesNotMatch(formatCost(0, 1), /\$0\.00/);
  assert.match(costTimeHtml({ cost_status: 'available', cost_usd: 0 }), /\$0\.00/);
  assert.equal(stageDetails({ cost_usd: 0 }, 'build').cost, '$0.00');
  const dashboard = dashboardSource();
  assert.match(dashboard, /formatCost\(s\.cost, s\.cost_unavailable\)/);
});

test('AC-7: repeated Codex sync is idempotent and board mirrors job state', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) {
    assert.equal(f.cli(job.id, 'sync').status, 0);
    const j = f.readJob();
    assert.ok(Math.abs(j.cost_usd - expected) < 1e-12);
    const board = JSON.parse(readFileSync(join(f.base, 'factory/board.json'), 'utf8'));
    assert.deepEqual(board.jobs[0], j);
  }
});

test('AC-3: rollout discovery recurses through JSONL files but never follows symlinks or exports messages', (t) => {
  const f = fixture(t);
  symlinkSync(f.sessions, join(f.sessions, 'cycle'));
  f.write(join(f.sessions, 'not-a-rollout.txt'), 'secret');
  f.write(join(f.sessions, '2026/10/30/rollout.jsonl'), rollout([
    prompt('Job folder: factory/jobs/034-cost/\nsecret'), context(), snapshot(),
    event('response_item', { type: 'function_call_output', output: 'secret' }),
  ], { base_instructions: 'secret', cwd: f.stored.worktree }));
  const parsed = costs.readCodexRollouts(f.sessions);
  assert.equal(parsed.length, 1);
  assert.doesNotMatch(JSON.stringify(parsed), /last_token_usage|secret/);
});
