// P7: `job metrics [--last N] [--json]` and the dashboard table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeMetrics, median } from '../factory/lib/metrics.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const repo = fileURLToPath(new URL('..', import.meta.url));

/** id: round, gates by round, reviews by round ({lens: verdict}), time_by_kind, lessons. */
const JOBS = {
  '001-a': { round: 2, gates: ['FAIL', 'PASS'], reviews: [{ code: 'CHANGES', security: 'PASS' }, { code: 'PASS' }], time: { check: 10, wait: 5, git: 1, other: 4 }, lessons: ['Run formatter.'] },
  '002-b': { round: 1, gates: ['PASS'], reviews: [{ code: 'PASS', ui: 'PASS' }], time: { check: 6, wait: 2, git: 1, other: 1 }, lessons: ['run FORMATTER'] },
  '003-c': { round: 3, gates: ['FAIL', 'FAIL', 'PASS'], reviews: [{ code: 'CHANGES' }, { code: 'CHANGES' }, { code: 'PASS' }], time: undefined, lessons: ['One-off.'] },
  '004-d': { round: 2, gates: ['PASS', 'PASS'], reviews: [{ code: 'PASS', security: 'CHANGES' }, { security: 'PASS' }], time: { check: 3 }, lessons: [] },
  '005-e': { round: 1, gates: ['PASS'], reviews: [{ code: 'PASS' }], time: undefined, lessons: [] },
};

function fixture(jobs = JOBS) {
  const root = mkdtempSync(join(tmpdir(), 'factory-metrics-'));
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ base: 'origin/main' }));
  for (const [id, j] of Object.entries(jobs)) {
    const dir = join(root, 'factory/jobs', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ id, round: j.round, stage: 'merged', ...(j.time ? { time_by_kind: j.time } : {}) }));
    j.gates.forEach((g, i) => {
      mkdirSync(join(dir, `round-${i + 1}`), { recursive: true });
      writeFileSync(join(dir, `round-${i + 1}/checks.md`), `GATE: ${g}\n`);
    });
    j.reviews.forEach((r, i) => {
      for (const [lens, verdict] of Object.entries(r)) writeFileSync(join(dir, `round-${i + 1}/review-${lens}.md`), `VERDICT: ${verdict}\n\nbody\n`);
    });
    writeFileSync(join(dir, 'decision.md'), `APPROVE\nOk.\n\n## Lessons\n${j.lessons.length ? j.lessons.map((l) => `- ${l}`).join('\n') : 'None'}\n`);
  }
  return root;
}

const job = (root, ...args) => spawnSync('sh', [join(repo, 'factory/bin/job'), ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, FACTORY_ROOT: root } });

test('P7 AC-1: on five jobs the five numbers match the expected values', () => {
  const m = computeMetrics(fixture(), 20);
  assert.equal(m.jobs, 5);
  assert.deepEqual(m.gate_pass_round1, { passed: 3, total: 5, rate: 0.6 });
  assert.deepEqual(m.rounds_per_job, { median: 2, jobs: 5 });
  assert.deepEqual(m.changes_by_lens, {
    code: { changes: 3, total: 8, rate: 0.375 },
    security: { changes: 1, total: 3, rate: 0.333 },
    ui: { changes: 0, total: 1, rate: 0 },
  });
  assert.deepEqual(m.minutes_by_kind, { check: { total: 19, jobs: 3 }, git: { total: 2, jobs: 2 }, other: { total: 5, jobs: 2 }, wait: { total: 7, jobs: 2 } });
  assert.deepEqual(m.repeated_lessons, [{ text: 'Run formatter.', count: 2 }]);
});

test('P7: --last N keeps the newest jobs, and the median of an even count is the mean of the middle two', () => {
  const m = computeMetrics(fixture(), 2);
  assert.equal(m.jobs, 2);
  assert.deepEqual(m.rounds_per_job, { median: 1.5, jobs: 2 });
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
});

test('P7 AC-2: a job without time_by_kind still counts for the other metrics', () => {
  const root = fixture({ '001-a': { ...JOBS['003-c'], time: undefined } });
  const m = computeMetrics(root, 20);
  assert.equal(m.jobs, 1);
  assert.deepEqual(m.gate_pass_round1, { passed: 0, total: 1, rate: 0 });
  assert.deepEqual(m.rounds_per_job, { median: 3, jobs: 1 });
  assert.equal(m.changes_by_lens.code.total, 3);
  assert.deepEqual(m.minutes_by_kind, {});
  const text = job(root, 'metrics');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /minutes per kind: n\/a/);
  assert.match(text.stdout, /GATE: PASS in round 1: 0\/1 \(0%\)/);
});

test('P7: an empty repo prints n/a instead of failing', () => {
  const root = fixture({});
  const res = job(root, 'metrics');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /GATE: PASS in round 1: 0\/0 \(n\/a\)/);
  assert.match(res.stdout, /rounds per job \(median\): n\/a/);
});

// A small JSON-schema subset: type (a name or a list), properties, required, additionalProperties, items, additionalProperties-as-schema, minimum.
function validate(value, schema, path = '$') {
  const errors = [];
  const types = [].concat(schema.type ?? []);
  const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  const actual = kind(value);
  if (types.length && !types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) return [`${path}: expected ${types.join('|')}, got ${actual}`];
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
  if (actual === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key}: missing`);
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null);
      if (sub) errors.push(...validate(v, sub, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
    }
  }
  if (actual === 'array' && schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items, `${path}[${i}]`)));
  return errors;
}

const counted = { type: 'object', required: ['changes', 'total', 'rate'], additionalProperties: false,
  properties: { changes: { type: 'integer', minimum: 0 }, total: { type: 'integer', minimum: 0 }, rate: { type: ['number', 'null'], minimum: 0 } } };
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['version', 'last', 'jobs', 'gate_pass_round1', 'rounds_per_job', 'changes_by_lens', 'minutes_by_kind', 'repeated_lessons'],
  properties: {
    version: { type: 'integer', minimum: 1 }, last: { type: 'integer', minimum: 1 }, jobs: { type: 'integer', minimum: 0 },
    gate_pass_round1: { type: 'object', required: ['passed', 'total', 'rate'], additionalProperties: false,
      properties: { passed: { type: 'integer', minimum: 0 }, total: { type: 'integer', minimum: 0 }, rate: { type: ['number', 'null'], minimum: 0 } } },
    rounds_per_job: { type: 'object', required: ['median', 'jobs'], additionalProperties: false, properties: { median: { type: ['number', 'null'], minimum: 1 }, jobs: { type: 'integer', minimum: 0 } } },
    changes_by_lens: { type: 'object', additionalProperties: counted },
    minutes_by_kind: { type: 'object', additionalProperties: { type: 'object', required: ['total', 'jobs'], additionalProperties: false, properties: { total: { type: 'number', minimum: 0 }, jobs: { type: 'integer', minimum: 1 } } } },
    repeated_lessons: { type: 'array', items: { type: 'object', required: ['text', 'count'], additionalProperties: false, properties: { text: { type: 'string' }, count: { type: 'integer', minimum: 2 } } } },
  },
};

test('P7 AC-3: --json validates against a schema, for full and for empty data', () => {
  for (const root of [fixture(), fixture({})]) {
    const res = job(root, 'metrics', '--json');
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(validate(JSON.parse(res.stdout), SCHEMA), []);
  }
  const res = job(fixture(), 'metrics', '--last', '3', '--json');
  assert.equal(JSON.parse(res.stdout).jobs, 3);
  assert.ok(validate({ version: 1 }, SCHEMA).length > 0, 'the validator rejects a broken object');
  assert.ok(validate({ ...computeMetrics(fixture()), jobs: 'x' }, SCHEMA).length > 0);
});

test('P7: job metrics refuses bad arguments', () => {
  assert.equal(job(fixture(), 'metrics', '--last', '0').status, 2);
  assert.equal(job(fixture(), 'metrics', '--bogus').status, 2);
});

test('P7 AC-4: board.json carries the metrics and the dashboard renders the table in en, es and pt', () => {
  const root = fixture();
  writeFileSync(join(root, 'factory/jobs/005-e/job.json'), JSON.stringify({ id: '005-e', issue: 5, title: 't', stage: 'merged', round: 1, worktree: null, history: [] }));
  const sync = job(root, '005-e', 'sync');
  assert.equal(sync.status, 0, sync.stderr);
  const board = JSON.parse(readFileSync(join(root, 'factory/board.json'), 'utf8'));
  assert.deepEqual(validate(board.metrics, SCHEMA), []);
  assert.equal(board.metrics.jobs, 5);
  const source = dashboardSource();
  assert.match(source, /id="metrics"/);
  assert.match(source, /function renderMetrics\(\)/);
  assert.match(source, /board\.metrics/);
  const i18n = JSON.parse(source.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/)[1]);
  const keys = Object.keys(i18n.en).filter((k) => k.startsWith('metrics'));
  assert.ok(keys.length >= 10);
  for (const lang of ['en', 'es', 'pt']) for (const key of keys) assert.ok(i18n[lang][key], `${lang}.${key}`);
  for (const key of keys) assert.ok(source.includes(`T.${key}`) || key === 'metricsTitle', key);
});
