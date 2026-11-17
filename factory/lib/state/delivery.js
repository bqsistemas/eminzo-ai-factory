// Delivery metrics (DORA), cost and work in progress of a period, computed from the local jobs only. One
// implementation behind `job metrics delivery` and the MCP tool `delivery_metrics`, so every dashboard reads the
// same numbers. Read-only: it reads factory/jobs and factory/config.json (for `repo`), never runs gh or git.
//
// job.js must not import this module statically: jobs.js imports job.js and calls it while loading, so a static
// import from job.js would evaluate jobs.js first and fail. job.js loads it with import() for its own command.
import { join } from 'node:path';

import { median } from '../metrics.js';
import { readText } from '../util.js';
import { isDateTime } from '../mcp/schema.js';
import { diagnosis } from './diagnosis.js';
import { jobView, readJobs } from './jobs.js';
import { periodSummary } from './queries.js';
import { quantile, round, share } from './stats.js';

export const DELIVERY_SCHEMA = 1;

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const FINISHED = new Set(['merged', 'rejected']);
const SIZES = ['xs', 's', 'm', 'l'];
const FLAGS = new Set(['--days', '--from', '--to', '--weeks']);
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An invalid argument or period; the message says why. */
export class PeriodError extends Error {}

const iso = (ms) => new Date(ms).toISOString();
const at = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};
const within = (value, from, to) => {
  const ms = at(value);
  return ms !== null && ms >= from && ms < to;
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The arguments after `delivery`: `{ options: { days?, from?, to?, weeks? }, json }`. Each flag at most once, with a value. */
export function parseDeliveryArgs(argv) {
  const options = {};
  let json = false;
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      if (json) throw new PeriodError('--json given twice');
      json = true;
    } else if (FLAGS.has(arg)) {
      if (seen.has(arg)) throw new PeriodError(`${arg} given twice`);
      seen.add(arg);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new PeriodError(`${arg} needs a value`);
      i += 1;
      const key = arg.slice(2);
      if (key === 'days' || key === 'weeks') {
        if (!/^\d+$/.test(value)) throw new PeriodError(`${arg} must be a whole number`);
        options[key] = Number(value);
      } else {
        options[key] = value;
      }
    } else {
      throw new PeriodError(`unknown argument ${JSON.stringify(arg.slice(0, 40))}`);
    }
  }
  return { options, json };
}

/** A date alone as local midnight (the next midnight for `end`), or null when it is not one. Never Date.parse: that reads UTC. */
function localDate(value, end) {
  const m = DATE_ONLY.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) throw new PeriodError(`${value} is not a date`);
  return { ms: new Date(y, mo - 1, d + (end ? 1 : 0)).getTime(), utcDay: Date.UTC(y, mo - 1, d) };
}

function boundary(value, end, name) {
  if (typeof value !== 'string') throw new PeriodError(`${name} must be a date or a date-time`);
  const date = localDate(value, end);
  if (date) return date;
  if (!isDateTime(value)) throw new PeriodError(`${name} must be an ISO 8601 date or date-time`);
  return { ms: Date.parse(value), utcDay: null };
}

/** `{ from, to, days, weeks }` (ms) of the options at `now`, or a PeriodError. */
export function resolvePeriod(options = {}, now = Date.now()) {
  const { days, from, to, weeks = 4 } = options;
  if (days !== undefined && from !== undefined) throw new PeriodError('use --days or --from, not both');
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) throw new PeriodError('days must be a whole number from 1 to 365');
  if (!Number.isInteger(weeks) || weeks < 0 || weeks > 12) throw new PeriodError('weeks must be a whole number from 0 to 12');
  const end = to === undefined ? { ms: now, utcDay: null } : boundary(to, true, 'to');
  const start = from === undefined ? { ms: end.ms - (days ?? 30) * DAY, utcDay: null } : boundary(from, false, 'from');
  if (start.ms >= end.ms) throw new PeriodError('from must be before to');
  const wholeDates = start.utcDay !== null && end.utcDay !== null;
  const length = wholeDates ? Math.round((end.utcDay - start.utcDay) / DAY) + 1 : (end.ms - start.ms) / DAY;
  if (length < 1) throw new PeriodError('the period must be at least 1 day');
  if (length > 365) throw new PeriodError('the period must be at most 365 days');
  return { from: start.ms, to: end.ms, days: wholeDates || days !== undefined ? length : round(length, 2), weeks };
}

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The local dates that overlap [a, b), the oldest first. */
function localDates(a, b) {
  const first = new Date(a);
  const out = [];
  for (let k = 0; ; k += 1) {
    const midnight = new Date(first.getFullYear(), first.getMonth(), first.getDate() + k);
    if (midnight.getTime() >= b) return out;
    out.push(dateKey(midnight.getTime()));
  }
}

/** `{ n, median, p85, max }` of the finite values; all null but `n` when there are none. */
function spreadOf(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0, median: null, p85: null, max: null };
  return { n: v.length, median: round(median(v), 1), p85: round(quantile(v, 0.85), 1), max: round(Math.max(...v), 1) };
}

/** Every base failure of the local jobs: waits with the same fix issue, in any job, are one failure. */
function collectFailures(jobs) {
  const groups = new Map();
  let own = 0;
  const add = (job, entry, open) => {
    if (!isObject(entry)) return;
    const since = at(entry.since);
    if (since === null) return;
    const fix = Number.isInteger(entry.fix_issue) ? entry.fix_issue : null;
    const key = fix === null ? `own:${own++}` : `fix:${fix}`;
    const g = groups.get(key) ?? { fix_issue: fix, since, until: null, open: false, jobs: new Set() };
    g.since = Math.min(g.since, since);
    if (open) g.open = true;
    else if (at(entry.until) !== null) g.until = Math.max(g.until ?? -Infinity, at(entry.until));
    g.jobs.add(job.id);
    groups.set(key, g);
  };
  for (const job of jobs) {
    if (Array.isArray(job.base_waits)) for (const entry of job.base_waits) add(job, entry, false);
    if (isObject(job.base_wait)) add(job, job.base_wait, true);
  }
  return [...groups.values()].map((g) => ({
    fix_issue: g.fix_issue,
    since: g.since,
    until: g.open ? null : g.until,
    minutes: !g.open && g.until !== null && g.until >= g.since ? round((g.until - g.since) / 60_000, 1) : null,
    held_jobs: g.jobs.size,
  })).sort((x, y) => x.since - y.since);
}

/** One period block over [a, b); `days` is the length used for deployments per week. */
function block(ctx, a, b, days) {
  const { root, now, views, failures, fixIssues } = ctx;
  const range = { from: iso(a), to: iso(b), now };
  const summary = periodSummary(root, range);
  const diag = diagnosis(root, range);

  const deployments = views.filter((v) => v.stage === 'merged' && within(v.finished, a, b));
  const rework = deployments.filter((v) => v.issue !== null && fixIssues.has(v.issue));
  const failed = failures.filter((f) => f.since >= a && f.since < b);
  const perDay = localDates(a, b).map((date) => ({
    date,
    count: deployments.filter((v) => dateKey(at(v.finished)) === date).length,
    rework: rework.filter((v) => dateKey(at(v.finished)) === date).length,
    failures: failed.filter((f) => dateKey(f.since) === date).length,
  }));

  const finishedViews = views.filter((v) => FINISHED.has(v.stage) && within(v.finished, a, b));
  const withoutCost = (risk) => finishedViews.filter((v) => (v.risk ?? 'unknown') === risk && v.cost_usd === null).length;
  const { known, jobs_with_cost: withCost, jobs_without_cost: withoutAny } = summary.cost_usd;
  const recovered = failed.filter((f) => f.until !== null);

  return {
    deployments: {
      count: deployments.length,
      per_week: round(deployments.length / (days / 7), 1),
      days_with_deployment: perDay.filter((d) => d.count > 0).length,
      per_day: perDay,
    },
    change_lead_time: spreadOf(deployments.map((v) => v.minutes.total)),
    lead_time_parts: {
      until_approval: spreadOf(deployments.map((v) => v.minutes.until_approval)),
      after_approval: spreadOf(deployments.map((v) => v.minutes.after_approval)),
    },
    until_approval_by_size: Object.fromEntries(SIZES.map((size) => {
      const s = diag.minutes_until_approval_by_size[size];
      return [size, { n: s.n, low: s.low, median: s.typical, high: s.high }];
    })),
    failures: {
      count: failed.length,
      recovered: recovered.length,
      open: failed.length - recovered.length,
      recovery: spreadOf(recovered.map((f) => f.minutes)),
      items: failed.map((f) => ({ fix_issue: f.fix_issue, since: iso(f.since), until: f.until === null ? null : iso(f.until), minutes: f.minutes, held_jobs: f.held_jobs })),
    },
    change_fail_rate: { failures: failed.length, deployments: deployments.length, rate: share(failed.length, deployments.length) },
    deployment_rework_rate: { rework: rework.length, deployments: deployments.length, rate: share(rework.length, deployments.length) },
    finished: summary.finished,
    first_pass: { one_round: summary.rounds.one_round_jobs, finished: summary.finished.total, rate: share(summary.rounds.one_round_jobs, summary.finished.total) },
    extra_rounds: { total: summary.rounds.extra, by_cause: diag.extra_round_causes.map(({ cause, rounds }) => ({ cause, rounds })) },
    first_review_changes: diag.first_review_changes,
    escalation_by_risk: diag.escalation_by_risk,
    cost: {
      known_usd: known,
      jobs_with_cost: withCost,
      jobs_without_cost: withoutAny,
      per_job_with_cost: withCost ? round(known / withCost, 2) : null,
      by_role: diag.cost.by_role,
      by_risk: diag.cost.by_risk.map((r) => ({ ...r, jobs_without_cost: withoutCost(r.risk) })),
    },
  };
}

/** The `repo` of the team's factory/config.json, or null. The one file read besides factory/jobs. */
function repoOf(root) {
  const text = readText(join(root, 'factory/config.json'));
  if (text === null) return null;
  try {
    const repo = JSON.parse(text)?.repo;
    return typeof repo === 'string' && repo.trim() ? repo : null;
  } catch {
    return null;
  }
}

/** Jobs that are not finished, oldest first, with what each waits for. */
function workInProgress(views, now) {
  const items = views.filter((v) => v.stage !== 'merged' && v.stage !== 'rejected').map((v) => {
    const started = at(v.started);
    return {
      id: v.id,
      issue: v.issue,
      title: v.title,
      stage: v.stage,
      risk: v.risk,
      size: v.size,
      age_minutes: started === null ? null : round(Math.max(0, now - started) / 60_000, 1),
      waiting: v.waiting ? { kind: v.waiting.kind, updated: v.updated } : null,
      base_wait: v.waiting?.kind === 'fix-base' ? { since: v.waiting.since, fix_issue: v.waiting.fix_issue } : null,
    };
  });
  items.sort((x, y) => (x.age_minutes === null) - (y.age_minutes === null) || (y.age_minutes ?? 0) - (x.age_minutes ?? 0));
  return { count: items.length, items };
}

/**
 * The delivery metrics (schema 1) of a period, read from the jobs of `root`. Throws PeriodError for an invalid period.
 * @param {string} root
 * @param {{ days?: number, from?: string, to?: string, weeks?: number, now?: number }} [options]
 */
export function deliveryMetrics(root, { days, from, to, weeks, now = Date.now() } = {}) {
  const period = resolvePeriod({ days, from, to, weeks }, now);
  const jobs = readJobs(root);
  const views = jobs.map((j) => jobView(j, now));
  const failures = collectFailures(jobs);
  const ctx = { root, now, views, failures, fixIssues: new Set(failures.filter((f) => f.fix_issue !== null).map((f) => f.fix_issue)) };
  const starts = views.map((v) => at(v.started)).filter((ms) => ms !== null);
  const dataStarts = starts.length ? Math.min(...starts) : null;
  const length = period.to - period.from;
  const prevFrom = period.from - length;
  const buckets = Array.from({ length: period.weeks }, (_, i) => {
    const bFrom = period.to - (period.weeks - i) * WEEK;
    return { from: iso(bFrom), to: iso(bFrom + WEEK), block: block(ctx, bFrom, bFrom + WEEK, 7) };
  });
  return {
    schema: DELIVERY_SCHEMA,
    source: 'local',
    read_at: iso(now),
    repo: repoOf(root),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    period: { from: iso(period.from), to: iso(period.to), days: period.days, data_starts: dataStarts === null ? null : iso(dataStarts), partial: dataStarts !== null && period.from < dataStarts },
    previous: { from: iso(prevFrom), to: iso(period.from), partial: dataStarts !== null && prevFrom < dataStarts },
    current: block(ctx, period.from, period.to, period.days),
    before: block(ctx, prevFrom, period.from, period.days),
    weeks: buckets,
    wip: workInProgress(views, now),
  };
}

const pct = (r) => (r === null ? 'n/a' : `${Math.round(r * 1000) / 10}%`);
const mins = (m) => (m === null ? 'n/a' : m >= 120 ? `${round(m / 60, 1)} h` : `${m} min`);

/** A short human summary: numbers and dates only, never issue titles (untrusted text). */
export function deliveryText(result) {
  const { current: c, previous, period } = result;
  const lines = [
    `Delivery metrics (local jobs, ${result.tz}): ${period.from} to ${period.to} (${period.days} days)`,
    `Deployments: ${c.deployments.count} (${c.deployments.per_week} per week, on ${c.deployments.days_with_deployment} days); the period before: ${result.before.deployments.count}`,
    `Change lead time: median ${mins(c.change_lead_time.median)}, p85 ${mins(c.change_lead_time.p85)} over ${c.change_lead_time.n} deployments`,
    `Failures: ${c.failures.count} (${c.failures.open} open), change fail rate ${pct(c.change_fail_rate.rate)}; recovery median ${mins(c.failures.recovery.median)}; rework rate ${pct(c.deployment_rework_rate.rate)}`,
    `Finished: ${c.finished.merged} merged, ${c.finished.rejected} rejected; first pass ${pct(c.first_pass.rate)}; ${c.extra_rounds.total} extra rounds`,
    `Cost: $${c.cost.known_usd.toFixed(2)} known over ${c.cost.jobs_with_cost} jobs; ${c.cost.jobs_without_cost} without cost data`,
    `In progress now: ${result.wip.count} jobs`,
  ];
  if (period.partial || previous.partial) {
    lines.push(`Note: partial data, local jobs start at ${period.data_starts ?? 'n/a'}; ${period.partial ? 'the period' : 'the period before'} begins earlier, so numbers are incomplete.`);
  }
  return lines.join('\n');
}
