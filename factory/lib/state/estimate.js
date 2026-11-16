// "How long would this take the team?": for each proposed deliverable, the finished jobs most like it, and what
// they took: the time from start until ready for approval (pauses and waits in between included), rounds, the wait for a person after approval, cost, and how often jobs
// of that risk waited for a person's decision. Always a range with the number of jobs behind it, never a date.
// Pure: the history comes from history.js, the deliverables from the caller (sizes and risks set the way intake
// sets them). Knows nothing about the repository's language or framework.
import { round, share, spread } from './stats.js';

/** Fewest similar jobs a range is given from; below it the answer is "too little history". */
export const MIN_BASE = 5;

/** Matching levels, strictest first: the first one with MIN_BASE jobs is used. */
export const LEVELS = Object.freeze([
  Object.freeze({ match: 'size+risk+lane', keys: ['size', 'risk', 'lane'] }),
  Object.freeze({ match: 'size+lane', keys: ['size', 'lane'] }),
  Object.freeze({ match: 'size', keys: ['size'] }),
]);

/** Above this escalation rate a deliverable gets a warning that it will probably wait for a person's decision. */
export const ESCALATION_WARNING = 0.5;

const range = (s) => (s.n ? { low: s.low, typical: s.typical, high: s.high } : null);

/** A duration as a person reads it: "45 min", "1.5 h". */
export function humanMinutes(m) {
  if (m === null || m === undefined) return null;
  return m < 90 ? `${Math.round(m)} min` : `${round(m / 60, 1)} h`;
}

function similar(records, d) {
  const want = { size: d.size, risk: d.risk, lane: d.lane ?? 'normal' };
  for (const level of LEVELS) {
    const found = records.filter((r) => level.keys.every((k) => r[k] === want[k]));
    if (found.length >= MIN_BASE) return { level: level.match, found };
  }
  return { level: null, found: records.filter((r) => r.size === want.size) };
}

function estimateOne(records, d, index) {
  const { level, found } = similar(records, d);
  const lane = d.lane ?? 'normal';
  const sameRisk = records.filter((r) => r.risk === d.risk && r.escalated !== null);
  const escalated = sameRisk.filter((r) => r.escalated).length;
  const escalation = { risk: d.risk, jobs: sameRisk.length, escalated, rate: share(escalated, sameRisk.length) };
  const base = level === null ? [] : found;
  const factory = spread(base.map((r) => r.factory_minutes));
  const rounds = spread(base.map((r) => r.rounds), 0);
  const cost = spread(base.map((r) => r.cost_usd), 2);
  const wait = spread(base.map((r) => r.wait_minutes));
  const warnings = [];
  if (level === null) warnings.push(`too little history: ${found.length} finished job${found.length === 1 ? '' : 's'} of size ${d.size}, fewer than ${MIN_BASE}`);
  if (d.size === 'l') warnings.push('large: consider splitting it into smaller deliverables, which finish in fewer rounds and are easier to review');
  if (escalation.jobs >= MIN_BASE && escalation.rate >= ESCALATION_WARNING) {
    warnings.push(`likely to wait for a person's decision: ${escalated} of ${sameRisk.length} ${d.risk}-risk jobs did`);
  }
  return {
    index,
    title: d.title ?? null,
    size: d.size,
    risk: d.risk,
    lane,
    basis: { match: level, jobs: level === null ? found.length : base.length, sources: [...new Set(base.map((r) => r.source))].sort() },
    factory_minutes: range(factory),
    rounds: range(rounds),
    wait_minutes: wait.n ? { typical: wait.typical, worst: wait.max } : null,
    cost_usd: cost.n ? range(cost) : null,
    escalation,
    warnings,
  };
}

const total = (items, key) => {
  const list = items.map((i) => i[key]).filter(Boolean);
  if (!list.length) return null;
  const add = (k) => round(list.reduce((s, r) => s + (r[k] ?? 0), 0), key === 'cost_usd' ? 2 : 1);
  return { low: add('low'), typical: add('typical'), high: add('high') };
};

/**
 * The estimate of a list of deliverables against finished-job records.
 * @param {object[]} records from history.js
 * @param {{ title?: string, size: string, risk: string, lane?: string }[]} deliverables
 * @param {{ concurrency?: number }} [options]
 */
export function estimateWork(records, deliverables, { concurrency = null } = {}) {
  const items = deliverables.map((d, i) => estimateOne(records, d, i + 1));
  const estimated = items.filter((i) => i.factory_minutes);
  const factory = total(estimated, 'factory_minutes');
  const cost = total(estimated, 'cost_usd');
  const missing = items.length - estimated.length;
  const head = `${items.length} deliverable${items.length === 1 ? '' : 's'}`;
  const body = factory
    ? `about ${humanMinutes(factory.low)} to ${humanMinutes(factory.high)} until ready for approval (typical ${humanMinutes(factory.typical)})`
      + `${cost ? ` and $${cost.low.toFixed(2)} to $${cost.high.toFixed(2)}` : ''}`
    : 'no estimate';
  const summary = `${head}: ${body}${missing ? `; ${missing} without enough history` : ''}.`
    + ' Ranges are the middle half of similar finished jobs; the wait for people is not included.';
  return {
    summary,
    deliverables: items,
    total: {
      factory_minutes: factory,
      cost_usd: cost,
      estimated: estimated.length,
      without_estimate: missing,
      note: 'Totals add the deliverables one after another. Deliverables that do not depend on each other can run at the same time'
        + `${concurrency ? `, up to ${concurrency} at once` : ''}. The wait for people (approval, merge) is not included.`,
    },
    history: { jobs: records.length, min_base: MIN_BASE, levels: LEVELS.map((l) => l.match) },
    method: 'For each deliverable, finished jobs with the same size, risk and lane; if fewer than 5, the same size and lane; then the same size. Low, typical and high are the 25th, 50th and 75th percentiles (nearest rank). factory_minutes runs from the job start until it was ready for approval, so pauses and waits in between count.',
  };
}
