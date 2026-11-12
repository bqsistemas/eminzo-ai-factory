// The questions Ask Eminzo answers about the factory, each as one pure function over the local jobs:
// how it is now, which jobs match, what waits for a person, what changed since a moment, how a period went,
// and how it is configured. Each answer carries `summary`, one plain sentence a person can read as is.
// Read-only and local: GitHub data comes from github.js.
import { effectiveConfig } from '../util.js';
import { GROUPS, findJob, jobDetail, jobView, readJobs } from './jobs.js';

const DAY = 24 * 60 * 60 * 1000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const iso = (ms) => new Date(ms).toISOString();
const at = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};
const within = (value, from, to) => {
  const ms = at(value);
  return ms !== null && ms >= from && ms < to;
};
const newestFirst = (a, b) => (at(b.updated) ?? 0) - (at(a.updated) ?? 0);
const sum = (values) => Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100;

/** A compact job line for lists: enough to name it and say where it is. */
const brief = (v) => ({ id: v.id, issue: v.issue, title: v.title, pr: v.pr, stage: v.stage, round: v.round, risk: v.risk, size: v.size, updated: v.updated });

/** "The factory now": jobs per group and stage, what runs, what waits and the last job that finished. */
export function overview(root, { now = Date.now() } = {}) {
  const views = readJobs(root).map((j) => jobView(j, now));
  const counts = Object.fromEntries(GROUPS.map((g) => [g, views.filter((v) => v.group === g).length]));
  const byStage = {};
  for (const v of views) if (v.stage) byStage[v.stage] = (byStage[v.stage] ?? 0) + 1;
  const running = views.filter((v) => v.group === 'active' && !v.waiting).sort(newestFirst).map(brief);
  const waiting = views.filter((v) => v.waiting).length;
  const finished = views.filter((v) => v.finished).sort((a, b) => (at(b.finished) ?? 0) - (at(a.finished) ?? 0));
  const last = finished[0] ? { ...brief(finished[0]), finished: finished[0].finished } : null;
  const summary = views.length
    ? `${plural(running.length, 'job')} running, ${plural(waiting, 'job')} waiting for a person, ${plural(counts.terminal, 'job')} finished (${plural(views.length, 'job')} on this machine).`
    : 'No jobs on this machine yet.';
  return { summary, jobs: views.length, counts, by_stage: byStage, running, waiting_for_people: waiting, last_finished: last };
}

/** Jobs matching every given filter, most recently updated first, at most `limit`. */
export function listJobs(root, { stage, group, lane, risk, size, since, limit = 20, now = Date.now() } = {}) {
  const from = since === undefined ? null : at(since);
  const views = readJobs(root).map((j) => jobView(j, now)).filter((v) => (stage === undefined || v.stage === stage)
    && (group === undefined || v.group === group)
    && (lane === undefined || v.lane === lane)
    && (risk === undefined || v.risk === risk)
    && (size === undefined || v.size === size)
    && (from === null || (at(v.updated) ?? 0) >= from));
  const jobs = views.sort(newestFirst).slice(0, limit).map(brief);
  const summary = views.length > jobs.length ? `${plural(views.length, 'job')} match; the ${jobs.length} most recently updated are listed.` : `${plural(views.length, 'job')} match.`;
  return { summary, total: views.length, jobs };
}

/** What every waiting job needs from a person, oldest wait first. */
export function waitingOnPeople(root, { now = Date.now() } = {}) {
  const items = readJobs(root).map((j) => jobView(j, now)).filter((v) => v.waiting).map((v) => ({
    ...brief(v),
    kind: v.waiting.kind,
    reason: v.waiting.reason,
    since: v.waiting.since,
    hours: v.waiting.since && at(v.waiting.since) !== null ? Math.round(((now - at(v.waiting.since)) / 3_600_000) * 10) / 10 : null,
  })).sort((a, b) => (at(a.since) ?? 0) - (at(b.since) ?? 0));
  const kinds = {};
  for (const item of items) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
  const summary = items.length ? `${plural(items.length, 'job')} wait for a person: ${Object.entries(kinds).map(([k, n]) => `${n} to ${k}`).join(', ')}.` : 'Nothing waits for a person.';
  return { summary, total: items.length, by_kind: kinds, items };
}

/**
 * What happened since `since` (default: 24 hours before `now`), from the jobs' own timestamps: jobs that finished,
 * jobs that now wait for a person, jobs that started and jobs that moved. Steps in between are not recorded.
 */
export function changesSince(root, { since, now = Date.now() } = {}) {
  const from = since === undefined ? now - DAY : at(since);
  const views = readJobs(root).map((j) => jobView(j, now));
  const finished = views.filter((v) => within(v.finished, from, Infinity)).map((v) => ({ ...brief(v), finished: v.finished, decision: v.decision }));
  const waiting = views.filter((v) => v.waiting && within(v.updated, from, Infinity)).map((v) => ({ ...brief(v), kind: v.waiting.kind, reason: v.waiting.reason }));
  const done = new Set([...finished, ...waiting].map((v) => v.id));
  const started = views.filter((v) => !done.has(v.id) && within(v.started, from, Infinity)).map((v) => ({ ...brief(v), started: v.started }));
  const seen = new Set([...finished, ...waiting, ...started].map((v) => v.id));
  const moved = views.filter((v) => !seen.has(v.id) && within(v.updated, from, Infinity)).sort(newestFirst).map(brief);
  const parts = [
    finished.length && `${plural(finished.length, 'job')} finished`,
    waiting.length && `${plural(waiting.length, 'job')} started waiting for a person`,
    started.length && `${plural(started.length, 'job')} started`,
    moved.length && `${plural(moved.length, 'job')} moved`,
  ].filter(Boolean);
  const summary = parts.length ? `Since ${iso(from)}: ${parts.join(', ')}.` : `Nothing changed since ${iso(from)}.`;
  return { summary, since: iso(from), finished, waiting, started, moved };
}

/** How a period went (default: the 7 days before `now`): jobs started and finished, rounds, escalations and cost. */
export function periodSummary(root, { from, to, now = Date.now() } = {}) {
  const end = to === undefined ? now : at(to);
  const start = from === undefined ? end - 7 * DAY : at(from);
  const views = readJobs(root).map((j) => jobView(j, now));
  const started = views.filter((v) => within(v.started, start, end));
  const finished = views.filter((v) => within(v.finished, start, end));
  const merged = finished.filter((v) => v.stage === 'merged');
  const rejected = finished.filter((v) => v.stage === 'rejected');
  const escalated = finished.filter((v) => v.decision === 'ESCALATE');
  const rounds = finished.map((v) => v.round);
  const costs = finished.filter((v) => v.cost_usd !== null).map((v) => v.cost_usd);
  const byLane = {};
  for (const v of finished) {
    const lane = (byLane[v.lane] ??= { finished: 0, rounds: 0, cost_usd: 0 });
    lane.finished += 1;
    lane.rounds += v.round;
    if (v.cost_usd !== null) lane.cost_usd = Math.round((lane.cost_usd + v.cost_usd) * 100) / 100;
  }
  const summary = finished.length
    ? `From ${iso(start)} to ${iso(end)}: ${plural(merged.length, 'job')} merged, ${rejected.length} rejected, ${escalated.length} escalated to a person; ${plural(rounds.reduce((s, r) => s + r, 0), 'round')} in total and $${sum(costs).toFixed(2)} of known cost.`
    : `No job finished from ${iso(start)} to ${iso(end)}.`;
  return {
    summary,
    from: iso(start),
    to: iso(end),
    started: started.length,
    finished: { total: finished.length, merged: merged.length, rejected: rejected.length },
    escalated: escalated.map(brief),
    rounds: {
      total: rounds.reduce((s, r) => s + r, 0),
      extra: rounds.reduce((s, r) => s + Math.max(0, r - 1), 0),
      one_round_jobs: rounds.filter((r) => r === 1).length,
    },
    cost_usd: { known: sum(costs), jobs_with_cost: costs.length, jobs_without_cost: finished.length - costs.length },
    by_lane: byLane,
  };
}

/** One job in detail, found by job id or issue number; null when no local job matches. */
export function jobByRef(root, ref, { now = Date.now() } = {}) {
  const job = findJob(readJobs(root), ref);
  if (!job) return null;
  const detail = jobDetail(root, job, now);
  const where = detail.waiting ? `waits for a person to ${detail.waiting.kind}` : `is in ${detail.stage}`;
  const issue = detail.issue === null ? '' : ` (issue #${detail.issue})`;
  return { summary: `Job ${detail.id}${issue} ${where}, round ${detail.round}${detail.max_rounds ? ` of ${detail.max_rounds}` : ''}.`, job: detail };
}

/** The keys of the effective config a person asks about (no prices, no notification targets). */
export function configView(root) {
  const { config, overrides } = effectiveConfig(root, { warn: () => {} });
  const reviewers = Object.fromEntries(Object.entries(config.routing?.reviewers ?? {}).map(([lens, r]) => [lens, r?.always ? 'always' : r?.surface ? `surface: ${r.surface}` : 'routed']));
  const pick = (key, fallback = null) => (Object.hasOwn(config, key) ? config[key] : fallback);
  const view = {
    repo: pick('repo'),
    base: pick('base'),
    language: pick('language', 'en'),
    run_mode: pick('run_mode', 'own'),
    concurrency: pick('concurrency'),
    max_rounds: pick('max_rounds', 3),
    auto_merge: pick('auto_merge', false),
    spec_review: pick('spec_review', false),
    default_provider: pick('default_provider', 'claude'),
    providers: Object.keys(config.providers ?? {}),
    lanes: Object.keys(config.lanes ?? {}),
    reviewers,
    local_overrides: overrides,
  };
  const summary = `Up to ${view.concurrency ?? '?'} jobs at a time and ${view.max_rounds} rounds per job; auto-merge ${view.auto_merge ? 'on' : 'off'}; reviewers: ${Object.keys(reviewers).join(', ') || 'none'}.`;
  return { summary, config: view };
}
