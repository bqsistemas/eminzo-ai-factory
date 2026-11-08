// P2-3: per-agent cost breakdown. jobCost (Claude subagent transcripts) and codexJobCost
// (Codex rollouts) return the same cost_by_agent shape, so providers are comparable:
//   { by_role: { <role>: usd }, by_round: { "<n>": usd, unassigned: usd } }
// Keys are sorted (roles alphabetical, rounds numeric, "unassigned" last) and the sums
// equal the job total.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexJobCost, jobCost, jobCostBreakdown, orchestratorCost, readAgentTranscripts } from '../factory/lib/cost.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

// ---- Claude -------------------------------------------------------------------------
const PRICES = { opus: { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 }, sonnet: { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 } };
const ID = '009-by-agent';
const line = (o) => JSON.stringify(o);
const user = (content) => line({ type: 'user', message: { role: 'user', content } });
// output tokens only, so the cost is easy to check: opus 25 USD/M, sonnet 15 USD/M.
const say = (id, model, output) => line({ type: 'assistant', message: { id, model, role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: output } } });
const jsonl = (...rows) => `${rows.join('\n')}\n`;
const folder = `Job folder: factory/jobs/${ID}/`;

// Builder: opus, spawned for round 1, then resumed for round 2 in the same transcript.
//   round 1: 1_000_000 out * 25 = 25 ; round 2: 400_000 out * 25 = 10
const BUILDER = {
  agentType: 'builder',
  text: jsonl(
    user(`${folder}\nRound folder: factory/jobs/${ID}/round-1/\nBranch: factory/${ID}\nFirst build.`),
    say('b1', 'claude-opus-4-5', 1_000_000),
    say('b1', 'claude-opus-4-5', 1_000_000),
    user(`Round 1 needs changes. Read factory/jobs/${ID}/round-1/, fix every finding.`),
    say('b2', 'claude-opus-4-5', 400_000),
  ),
};
// UI reviewer for round 2, no agentType metadata: the role comes from the SubagentStart hook line.
//   200_000 out * 15 = 3
const REVIEW = jsonl(
  user([{ type: 'text', text: `${folder}\nRound folder: factory/jobs/${ID}/round-2/` }]),
  line({ type: 'attachment', attachment: { type: 'hook_success', hookName: 'SubagentStart:review-ui' } }),
  say('r1', 'claude-sonnet-4-5', 200_000),
);
// Intake without a round, no metadata, no hook: the role comes from the file it wrote.
//   100_000 out * 15 = 1.5
const INTAKE = jsonl(
  user(folder),
  line({ type: 'assistant', message: { id: 'i1', model: 'claude-sonnet-4-5', role: 'assistant', usage: { input_tokens: 0, output_tokens: 100_000 },
    content: [{ type: 'tool_use', name: 'Write', input: { file_path: `/repo/factory/jobs/${ID}/intake.md`, content: 'ACCEPT' } }] } }),
);
// Another job: ignored.
const OTHER = jsonl(user('Job folder: factory/jobs/010-other/\nRound folder: factory/jobs/010-other/round-1/'), say('o1', 'claude-opus-4-5', 9_999_999));
// Nothing identifies the role.
const MYSTERY = jsonl(user(`${folder}\nRound folder: factory/jobs/${ID}/round-1/`), say('m1', 'claude-sonnet-4-5', 100_000));

test('Claude breakdown groups cost by role and by round, and sums to the job total', () => {
  const result = jobCostBreakdown([BUILDER, REVIEW, INTAKE, OTHER], ID, PRICES);
  close(result.cost_usd, 25 + 10 + 3 + 1.5);
  assert.deepEqual(Object.keys(result.by_role), ['builder', 'intake', 'review-ui']);
  close(result.by_role.builder, 35);
  close(result.by_role['review-ui'], 3);
  close(result.by_role.intake, 1.5);
  assert.deepEqual(Object.keys(result.by_round), ['1', '2', 'unassigned']);
  close(result.by_round['1'], 25);
  close(result.by_round['2'], 13);
  close(result.by_round.unassigned, 1.5);
  close(sum(result.by_role), result.cost_usd);
  close(sum(result.by_round), result.cost_usd);
});

test('a resumed builder splits its cost per round from the resume prompt', () => {
  const result = jobCostBreakdown([BUILDER], ID, PRICES);
  assert.deepEqual(result.by_round, { 1: 25, 2: 10 });
});

test('an unidentifiable agent is reported as "unknown", never dropped', () => {
  const result = jobCostBreakdown([MYSTERY], ID, PRICES);
  close(result.by_role.unknown, 1.5);
  close(result.cost_usd, 1.5);
});

test('the breakdown is deterministic: input order does not change it', () => {
  const a = jobCostBreakdown([BUILDER, REVIEW, INTAKE], ID, PRICES);
  const b = jobCostBreakdown([INTAKE, REVIEW, BUILDER], ID, PRICES);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('jobCost still returns the plain total (string transcripts keep working)', () => {
  assert.equal(typeof jobCost([BUILDER.text, REVIEW], ID, PRICES), 'number');
  close(jobCost([BUILDER.text, REVIEW], ID, PRICES), 25 + 10 + 3);
});

test('readAgentTranscripts pairs each subagent transcript with its agentType', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cost-agents-'));
  const sub = join(dir, 'session-1/subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'agent-a1.jsonl'), BUILDER.text);
  writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'builder' }));
  writeFileSync(join(sub, 'agent-a2.jsonl'), REVIEW);
  writeFileSync(join(dir, 'session-1.jsonl'), 'orchestrator, not a subagent');
  const items = readAgentTranscripts(dir).sort((a, b) => a.text.length - b.text.length);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.agentType ?? 'none').sort(), ['builder', 'none']);
  close(jobCostBreakdown(items, ID, PRICES).cost_usd, 38);
});

// ---- Codex --------------------------------------------------------------------------
const root = '/repo';
const cjob = { id: ID, provider: 'codex', worktree: `${root}/.worktrees/${ID}` };
const CPRICES = { model: { input: 10, cache_read: 2, cache_write: 5, output: 20 } };
const ev = (type, payload) => ({ type, payload });
const ctx = () => ev('turn_context', { cwd: cjob.worktree, model: 'model' });
const prompt = (text) => ev('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const snap = (input, output) => ev('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } });
const session = (id, rows) => [ev('session_meta', { id, cwd: cjob.worktree }), ...rows].map(line).join('\n');
const contract = (round, role) => `Job folder: factory/jobs/${ID}/\n${round ? `Round folder: factory/jobs/${ID}/round-${round}/\n` : ''}Branch: factory/${ID}\n\nRead factory/project.md, factory/roles/${role}.md and write the file.`;

// builder: round 1 costs 1000*10 + 100*20 = 12000 /1e6 ; round 2 (resumed contract) 500*10 + 50*20 = 6000 /1e6
const BUILD_SESSION = session('s-build', [
  prompt(contract(1, 'builder')), ctx(), snap(1000, 100),
  prompt(contract(2, 'builder')), ctx(), snap(1500, 150),
]);
// review-code, round 2: 200*10 + 20*20 = 2400 /1e6
const REVIEW_SESSION = session('s-review', [prompt(contract(2, 'review-code')), ctx(), snap(200, 20)]);
// spec-writer, no round folder: 100*10 + 10*20 = 1200 /1e6
const SPEC_SESSION = session('s-spec', [prompt(contract(0, 'spec-writer')), ctx(), snap(100, 10)]);

test('Codex breakdown has the same shape as Claude and sums to the job total', () => {
  const result = codexJobCost([BUILD_SESSION, REVIEW_SESSION, SPEC_SESSION], cjob, CPRICES, root);
  assert.equal(result.cost_status, 'available');
  const by = result.cost_by_agent;
  assert.deepEqual(Object.keys(by).sort(), ['by_role', 'by_round']);
  assert.deepEqual(Object.keys(by.by_role), ['builder', 'review-code', 'spec-writer']);
  close(by.by_role.builder, 18000 / 1e6);
  close(by.by_role['review-code'], 2400 / 1e6);
  close(by.by_role['spec-writer'], 1200 / 1e6);
  assert.deepEqual(Object.keys(by.by_round), ['1', '2', 'unassigned']);
  close(by.by_round['1'], 12000 / 1e6);
  close(by.by_round['2'], 8400 / 1e6);
  close(by.by_round.unassigned, 1200 / 1e6);
  close(sum(by.by_role), result.cost_usd);
  close(sum(by.by_round), result.cost_usd);
});

test('Codex breakdown is deterministic across rollout order', () => {
  const a = codexJobCost([BUILD_SESSION, REVIEW_SESSION, SPEC_SESSION], cjob, CPRICES, root);
  const b = codexJobCost([SPEC_SESSION, REVIEW_SESSION, BUILD_SESSION], cjob, CPRICES, root);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('an unavailable Codex cost carries no breakdown', () => {
  const result = codexJobCost([], cjob, CPRICES, root);
  assert.equal(result.cost_status, 'unavailable');
  assert.equal(Object.hasOwn(result, 'cost_by_agent'), false);
});

// ---- job sync -----------------------------------------------------------------------
function syncFixture(job, config) {
  const base = mkdtempSync(join(tmpdir(), 'cost-sync-'));
  const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  const jobFile = join(base, 'factory/jobs', job.id, 'job.json');
  put(jobFile, JSON.stringify({ stage: 'build', round: 1, reviews: {}, ...job, worktree: join(base, '.worktrees', job.id) }));
  put(join(base, 'factory/config.json'), JSON.stringify(config));
  const run = (env) => spawnSync(fileURLToPath(new URL('../factory/bin/job', import.meta.url)), [job.id, 'sync'], {
    encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: base, ...env },
  });
  return { base, put, run, read: () => JSON.parse(readFileSync(jobFile, 'utf8')) };
}

test('job sync persists cost_by_agent for a Claude job and keeps the existing fields', () => {
  const fx = syncFixture({ id: ID, provider: 'claude', title: 'T', issue: 9 }, { prices: PRICES });
  const sub = join(fx.base, 'transcripts/session/subagents');
  fx.put(join(sub, 'agent-1.jsonl'), BUILDER.text);
  fx.put(join(sub, 'agent-1.meta.json'), JSON.stringify({ agentType: 'builder' }));
  fx.put(join(sub, 'agent-2.jsonl'), REVIEW);
  const res = fx.run({ FACTORY_TRANSCRIPTS: join(fx.base, 'transcripts') });
  assert.equal(res.status, 0, res.stderr);
  const job = fx.read();
  close(job.cost_usd, 38);
  assert.equal(job.cost_status, 'available');
  assert.equal(job.title, 'T');
  assert.deepEqual(Object.keys(job.cost_by_agent), ['by_role', 'by_round']);
  close(job.cost_by_agent.by_role.builder, 35);
  close(job.cost_by_agent.by_role['review-ui'], 3);
  close(sum(job.cost_by_agent.by_round), job.cost_usd);
});

test('job sync persists cost_by_agent for a Codex job and drops it when the cost turns unavailable', () => {
  const fx = syncFixture({ id: ID, provider: 'codex' }, { providers: { codex: { prices: CPRICES } } });
  const sessions = join(fx.base, 'sessions');
  const wt = join(fx.base, '.worktrees', ID);
  const rows = (cwd, extra = []) => session('s-build', [prompt(contract(1, 'builder')), ev('turn_context', { cwd, model: 'model' }), snap(1000, 100), ...extra])
    .replace(`"cwd":"${cjob.worktree}"`, `"cwd":"${cwd}"`);
  fx.put(join(sessions, 'rollout.jsonl'), rows(wt));
  assert.equal(fx.run({ FACTORY_CODEX_SESSIONS: sessions }).status, 0);
  let job = fx.read();
  assert.equal(job.cost_status, 'available');
  close(job.cost_by_agent.by_role.builder, 12000 / 1e6);
  // The price disappears: unavailable, and the stale breakdown must go with it.
  fx.put(join(fx.base, 'factory/config.json'), JSON.stringify({ providers: { codex: { prices: {} } } }));
  assert.equal(fx.run({ FACTORY_CODEX_SESSIONS: sessions }).status, 0);
  job = fx.read();
  assert.equal(job.cost_status, 'unavailable');
  assert.equal(Object.hasOwn(job, 'cost_by_agent'), false);
});

// ---- orchestrator session -----------------------------------------------------------
// A session counts as an orchestrator only when it spawned subagents that worked on a
// factory job. Its own usage (the subagents have separate transcripts) is reported on its
// own, never attributed to one job: one session drives many jobs and anything else the
// person did there.
function orchestratorFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cost-orch-'));
  const put = (file, text) => { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); };
  // orchestrator: 300_000 out * 15 = 4.5, the message repeats once per content block
  put('orch.jsonl', jsonl(user('/eminzo-factory run'), say('x1', 'claude-sonnet-4-5', 300_000), say('x1', 'claude-sonnet-4-5', 300_000)));
  put('orch/subagents/agent-1.jsonl', BUILDER.text);
  // an unrelated session with subagents that never touched a job: not an orchestrator
  put('other.jsonl', jsonl(user('hi'), say('y1', 'claude-sonnet-4-5', 1_000_000)));
  put('other/subagents/agent-1.jsonl', jsonl(user('Explore the repo'), say('y2', 'claude-sonnet-4-5', 5)));
  // a session without subagents: not an orchestrator
  put('solo.jsonl', jsonl(user('hi'), say('z1', 'claude-sonnet-4-5', 1_000_000)));
  return dir;
}

test('orchestratorCost sums only sessions that spawned factory job agents', () => {
  const result = orchestratorCost(orchestratorFixture(), PRICES);
  assert.equal(result.sessions, 1);
  close(result.cost_usd, 4.5);
});

test('orchestratorCost reports nothing for a missing folder', () => {
  assert.deepEqual(orchestratorCost(join(tmpdir(), 'cost-orch-does-not-exist'), PRICES), { sessions: 0, cost_usd: 0 });
});

test('job summary --orchestrator prints the orchestrator line, and the plain summary is unchanged', () => {
  const fx = syncFixture({ id: ID, provider: 'claude', title: 'T', issue: 9 }, { prices: PRICES });
  const env = { FACTORY_TRANSCRIPTS: orchestratorFixture() };
  const run = (...args) => spawnSync(fileURLToPath(new URL('../factory/bin/job', import.meta.url)), args, {
    encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: fx.base, ...env },
  });
  const plain = run('summary');
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /orchestrator/i);
  const withOrch = run('summary', '--orchestrator');
  assert.equal(withOrch.status, 0, withOrch.stderr);
  assert.ok(withOrch.stdout.startsWith(plain.stdout));
  assert.match(withOrch.stdout, /orchestrator sessions: 1, \$4\.50/);
  assert.match(withOrch.stdout, /not attributed to any job/);
});
