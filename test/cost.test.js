// Spine test (protected in factory/config.json): per-job cost from transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jobCost } from '../factory/lib/cost.js';

const repo = fileURLToPath(new URL('..', import.meta.url));

// USD per million tokens, chosen so the expected total is easy to check by hand.
const PRICES = {
  opus: { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  sonnet: { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
};

const user = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
const assistant = (id, model, [input, output, write, read]) => JSON.stringify({
  type: 'assistant',
  message: {
    id, model, role: 'assistant', content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: write, cache_read_input_tokens: read },
  },
});
const jsonl = (...lines) => `${lines.join('\n')}\n`;

// Job 004-dark-mode, builder transcript: string prompt.
//   msg_1 opus, repeated once per content block: (1000*5 + 2000*25 + 10000*6.25 + 50000*0.5) / 1e6 = 0.1425
//   msg_2 sonnet: (100*3 + 400*15 + 0 + 2000*0.3) / 1e6 = 0.0069
//   msg_3 unknown model: 0
const BUILDER = jsonl(
  user('Job folder: factory/jobs/004-dark-mode/\nBranch: factory/004-dark-mode\n'),
  assistant('msg_1', 'claude-opus-4-5-20251101', [1000, 2000, 10000, 50000]),
  assistant('msg_1', 'claude-opus-4-5-20251101', [1000, 2000, 10000, 50000]),
  'not json at all',
  assistant('msg_2', 'claude-sonnet-4-5', [100, 400, 0, 2000]),
  assistant('msg_3', 'claude-mystery-9', [999999, 999999, 999999, 999999]),
);
// Job 004-dark-mode, reviewer transcript: prompt as text blocks.
//   msg_4 sonnet, twice: (10*3 + 20*15 + 30*3.75 + 40*0.3) / 1e6 = 0.0004545
const REVIEWER = jsonl(
  user([{ type: 'text', text: 'Job folder: factory/jobs/004-dark-mode/\nRound folder: factory/jobs/004-dark-mode/round-1/' }]),
  assistant('msg_4', 'claude-sonnet-4-5', [10, 20, 30, 40]),
  assistant('msg_4', 'claude-sonnet-4-5', [10, 20, 30, 40]),
);
// Another job, mentioning 004 only after its first prompt: not counted.
const OTHER = jsonl(
  user('Job folder: factory/jobs/005-other/\n'),
  user('Compare with factory/jobs/004-dark-mode/'),
  assistant('msg_5', 'claude-opus-4-5', [1e6, 1e6, 1e6, 1e6]),
);
// A job whose id starts with the same words: not counted.
const NEAR = jsonl(
  user('Job folder: factory/jobs/004-dark-mode-extra/\n'),
  assistant('msg_6', 'claude-opus-4-5', [1e6, 0, 0, 0]),
);
const EXPECTED = 0.1425 + 0.0069 + 0.0004545;

test('AC-6: jobCost sums only the job transcripts, dedupes message ids, and prices models by alias', () => {
  const cost = jobCost([BUILDER, REVIEWER, OTHER, NEAR], '004-dark-mode', PRICES);
  assert.ok(Math.abs(cost - EXPECTED) < 1e-9, `cost ${cost} ≈ ${EXPECTED}`);
  assert.equal(jobCost([OTHER], '004-dark-mode', PRICES), 0);
  assert.equal(jobCost([], '004-dark-mode', PRICES), 0);
  assert.equal(jobCost(['', '\n'], '004-dark-mode', PRICES), 0);
});

function setupRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-cost-'));
  const root = join(dir, 'root');
  const transcripts = join(dir, 'transcripts');
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  write(join(root, 'factory/config.json'), JSON.stringify({ repo: 'https://github.com/example/app', prices: PRICES }));
  write(join(transcripts, 'session-1/subagents/agent-a.jsonl'), BUILDER);
  write(join(transcripts, 'session-1/subagents/agent-b.jsonl'), REVIEWER);
  write(join(transcripts, 'session-2/subagents/agent-c.jsonl'), OTHER);
  // The orchestrator's own transcript sits outside subagents/ and is ignored.
  write(join(transcripts, 'session-1.jsonl'), BUILDER.replaceAll('msg_', 'main_'));
  return { root, transcripts, write };
}

const jobJson = (fields) => JSON.stringify({
  issue: 12, title: 'Dark mode', pr: 31, round: 1, max_rounds: 3, gate: 'PASS', reviews: {}, history: [],
  decision: null, note: '', cost_usd: 0, started: '2026-11-02T14:00:00Z', finished: null, ...fields,
}, null, 2);

test('AC-6: job sync writes cost_usd from FACTORY_TRANSCRIPTS and refreshes reviews from round files', () => {
  const { root, transcripts, write } = setupRoot();
  const dir = join(root, 'factory/jobs/004-dark-mode');
  write(join(dir, 'job.json'), jobJson({ id: '004-dark-mode', stage: 'review', reviews: { code: 'pending', ui: 'pending' } }));
  write(join(dir, 'round-1/review-code.md'), 'VERDICT: PASS\n');
  write(join(dir, 'round-1/review-ui.md'), 'not a verdict\n');

  const res = spawnSync(join(repo, 'factory/bin/job'), ['004-dark-mode', 'sync'], {
    encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root, FACTORY_TRANSCRIPTS: transcripts },
  });
  assert.equal(res.status, 0, res.stderr);
  const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'));
  assert.ok(Math.abs(job.cost_usd - EXPECTED) < 1e-9, `cost_usd ${job.cost_usd}`);
  assert.deepEqual(job.reviews, { code: 'PASS', ui: 'pending' });
  const board = JSON.parse(readFileSync(join(root, 'factory/board.json'), 'utf8'));
  assert.equal(board.jobs[0].cost_usd, job.cost_usd, 'board.json regenerated');
});

test('AC-6: job summary prints one line per job with id, #issue, stage, $cost and duration, then a total', () => {
  const { root, write } = setupRoot();
  write(join(root, 'factory/jobs/004-dark-mode/job.json'), jobJson({
    id: '004-dark-mode', stage: 'merged', cost_usd: 1.844, finished: '2026-11-02T15:30:00Z',
  }));
  write(join(root, 'factory/jobs/005-csv-export/job.json'), jobJson({
    id: '005-csv-export', issue: 13, stage: 'needs-human', cost_usd: 0.5, finished: '2026-11-02T14:45:00Z',
  }));
  const res = spawnSync(join(repo, 'factory/bin/job'), ['summary'], {
    encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root },
  });
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 3, 'two jobs and a total');
  for (const part of ['004-dark-mode', '#12', 'merged', '$1.84', '1h 30m']) assert.ok(lines[0].includes(part), `${part} in ${lines[0]}`);
  for (const part of ['005-csv-export', '#13', 'needs-human', '$0.50', '45m']) assert.ok(lines[1].includes(part), `${part} in ${lines[1]}`);
  assert.match(lines[2], /total/i);
  assert.ok(lines[2].includes('$2.34'), lines[2]);
});
