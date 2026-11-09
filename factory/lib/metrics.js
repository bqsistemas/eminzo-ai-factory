// `job metrics [--last N]`: numbers about the last N jobs, read from their folders. Read-only.
//   - the share of jobs whose round-1 checks.md starts `GATE: PASS`
//   - rounds per job (median of job.json `round`)
//   - the share of reviews that said `VERDICT: CHANGES`, per lens
//   - minutes per kind of work, summed from job.json `time_by_kind` (jobs without it count for the rest)
//   - lessons repeated in two or more decision.md files (see lessons.js)
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_LAST, collectLessons } from './lessons.js';
import { JOB_ID, firstLine, readText } from './util.js';

export const METRICS_SCHEMA_VERSION = 1;

const rate = (n, total) => (total ? Math.round((n / total) * 1000) / 1000 : null);
const round1 = (n) => Math.round(n * 10) / 10;

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The last `last` jobs (by id) that have a readable job.json. */
function readJobs(root, last) {
  const dir = join(root, 'factory/jobs');
  if (!existsSync(dir)) return [];
  const jobs = [];
  for (const name of readdirSync(dir).filter((n) => JOB_ID.test(n)).sort()) {
    const text = readText(join(dir, name, 'job.json'));
    if (text === null) continue;
    try {
      jobs.push({ ...JSON.parse(text), id: name });
    } catch { /* a broken job.json is skipped */ }
  }
  return jobs.slice(-last);
}

/** @returns the metrics object printed by `job metrics --json`. */
export function computeMetrics(root, last = DEFAULT_LAST) {
  const jobs = readJobs(root, last);
  let passed = 0;
  let gated = 0;
  const rounds = [];
  const lenses = {};
  const minutes = {};
  for (const job of jobs) {
    const folder = join(root, 'factory/jobs', job.id);
    const gate = firstLine(join(folder, 'round-1/checks.md'))?.match(/^GATE: (PASS|FAIL)\b/)?.[1];
    if (gate) { gated += 1; if (gate === 'PASS') passed += 1; }
    if (Number.isInteger(job.round) && job.round >= 1) rounds.push(job.round);
    for (const entry of existsSync(folder) ? readdirSync(folder).filter((n) => /^round-\d+$/.test(n)) : []) {
      for (const f of readdirSync(join(folder, entry))) {
        const lens = f.match(/^review-([a-z][\w-]*)\.md$/)?.[1];
        if (!lens || lens === 'human') continue;
        const verdict = firstLine(join(folder, entry, f))?.match(/^VERDICT: (PASS|CHANGES)\b/)?.[1];
        if (!verdict) continue;
        const l = (lenses[lens] ??= { changes: 0, total: 0 });
        l.total += 1;
        if (verdict === 'CHANGES') l.changes += 1;
      }
    }
    if (job.time_by_kind && typeof job.time_by_kind === 'object') {
      for (const [kind, value] of Object.entries(job.time_by_kind)) {
        if (!Number.isFinite(value) || value < 0) continue;
        const m = (minutes[kind] ??= { total: 0, jobs: 0 });
        m.total += value;
        m.jobs += 1;
      }
    }
  }
  return {
    version: METRICS_SCHEMA_VERSION,
    last,
    jobs: jobs.length,
    gate_pass_round1: { passed, total: gated, rate: rate(passed, gated) },
    rounds_per_job: { median: median(rounds), jobs: rounds.length },
    changes_by_lens: Object.fromEntries(Object.entries(lenses).sort(([a], [b]) => a.localeCompare(b))
      .map(([lens, { changes, total }]) => [lens, { changes, total, rate: rate(changes, total) }])),
    minutes_by_kind: Object.fromEntries(Object.entries(minutes).sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, { total, jobs: n }]) => [kind, { total: round1(total), jobs: n }])),
    repeated_lessons: collectLessons(root, last).filter((e) => e.count >= 2)
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).map((e) => ({ text: e.text, count: e.count })),
  };
}

const pct = (r) => (r === null ? 'n/a' : `${Math.round(r * 1000) / 10}%`);

/** The text form of `computeMetrics`. */
export function metricsText(m) {
  const lines = [`metrics: last ${m.last} jobs (${m.jobs} found)`];
  lines.push(`GATE: PASS in round 1: ${m.gate_pass_round1.passed}/${m.gate_pass_round1.total} (${pct(m.gate_pass_round1.rate)})`);
  lines.push(`rounds per job (median): ${m.rounds_per_job.median ?? 'n/a'}`);
  const lenses = Object.entries(m.changes_by_lens);
  lines.push(`CHANGES rate per lens: ${lenses.length ? lenses.map(([l, v]) => `${l} ${v.changes}/${v.total} (${pct(v.rate)})`).join(', ') : 'n/a'}`);
  const kinds = Object.entries(m.minutes_by_kind);
  lines.push(`minutes per kind: ${kinds.length ? kinds.map(([k, v]) => `${k} ${v.total} (${v.jobs} job${v.jobs === 1 ? '' : 's'})`).join(', ') : 'n/a (no job has time_by_kind)'}`);
  lines.push(m.repeated_lessons.length ? 'repeated lessons:' : 'repeated lessons: none');
  for (const l of m.repeated_lessons) lines.push(`  ${l.count}x ${l.text}`);
  return lines.join('\n');
}
