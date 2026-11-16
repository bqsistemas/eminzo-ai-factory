// "Where does my factory lose time and money?": the finished jobs of a period read as one picture. Extra rounds
// by cause, how often each review lens asks for changes on its first review, cost by agent role and by risk,
// escalations by risk, time by size, and proposals backed by those numbers. Read-only and local.
//
// The proposals only describe a change; nothing here changes the config or a file. Each proposal needs a
// minimum of evidence (see the thresholds below) so a handful of jobs does not produce advice.
import { specReviewFor } from '../util.js';
import { jobDetail, readJobs, roundCauses } from './jobs.js';
import { share, spread } from './stats.js';

const DAY = 24 * 60 * 60 * 1000;
const FINISHED = new Set(['merged', 'rejected']);
const RISKS = ['low', 'medium', 'high'];
const SIZES = ['xs', 's', 'm', 'l'];

/** Evidence a proposal needs. */
export const THRESHOLDS = Object.freeze({
  lensChangesRate: 0.4, // a lens asks for changes on at least 40% of its first reviews...
  lensReviews: 5, // ...over at least 5 first reviews
  causeShare: 0.25, // a cause behind at least a quarter of the extra rounds...
  causeRounds: 3, // ...and at least 3 of them
  escalationRate: 0.8, // a risk level escalated at least 80% of the time...
  escalationJobs: 3, // ...over at least 3 jobs
  costShare: 0.6, // a risk level holds at least 60% of the cost...
  jobShare: 0.5, // ...while being less than half of the jobs
});

const at = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};
const money = (n) => Math.round(n * 100) / 100;
const pct = (r) => `${Math.round(r * 100)}%`;
const iso = (ms) => new Date(ms).toISOString();

/** A person's name for a cause key. */
export function causeLabel(cause) {
  if (cause === 'gate') return 'the gate failed';
  if (cause === 'pr_comments') return 'changes requested on the pull request';
  if (cause.startsWith('review:')) return `review-${cause.slice(7)} asked for changes`;
  return 'not recorded';
}

function proposals({ causes, extra, lenses, escalation, costByRisk, jobs, config }) {
  const out = [];
  const gate = causes.gate ?? 0;
  if (gate >= THRESHOLDS.causeRounds && share(gate, extra) >= THRESHOLDS.causeShare) {
    out.push({
      id: 'gate-failures',
      text: `${gate} of ${extra} extra rounds started because the gate failed. Have the builder run the focused checks (eminzo nudge <job>) before STATUS: READY, and look in checks.log for tests that fail and then pass without a change.`,
      evidence: { extra_rounds: gate, of: extra },
    });
  }
  for (const [lens, l] of Object.entries(lenses)) {
    if (l.total >= THRESHOLDS.lensReviews && l.rate >= THRESHOLDS.lensChangesRate) {
      out.push({
        id: `review-${lens}-changes`,
        text: `review-${lens} asked for changes on ${l.changes} of ${l.total} first reviews (${pct(l.rate)}). Make what it keeps finding explicit for the builder: run eminzo job lessons, or add the repeated findings to factory/project.md.`,
        evidence: { lens, changes: l.changes, first_reviews: l.total },
      });
    }
  }
  const comments = causes.pr_comments ?? 0;
  if (comments >= THRESHOLDS.causeRounds && share(comments, extra) >= THRESHOLDS.causeShare) {
    out.push({
      id: 'pr-comments',
      text: `${comments} of ${extra} extra rounds came from changes a person requested on the pull request. Agreeing on the spec before the build (spec_review) catches some of them earlier.`,
      evidence: { extra_rounds: comments, of: extra },
    });
  }
  for (const risk of RISKS) {
    const e = escalation[risk];
    let reviewed = false;
    try { reviewed = specReviewFor(config, risk); } catch { /* an invalid value is reported elsewhere */ }
    if (e && e.jobs >= THRESHOLDS.escalationJobs && e.rate >= THRESHOLDS.escalationRate && !reviewed) {
      out.push({
        id: `${risk}-risk-escalates`,
        text: `${e.escalated} of ${e.jobs} ${risk}-risk jobs ended waiting for a person's decision. If that wait is long, add "${risk}" to spec_review so the person agrees on the spec before the build instead of at the end.`,
        evidence: { risk, escalated: e.escalated, jobs: e.jobs },
      });
    }
  }
  for (const r of costByRisk) {
    if (r.share >= THRESHOLDS.costShare && share(r.jobs, jobs) < THRESHOLDS.jobShare) {
      out.push({
        id: `cost-${r.risk}-risk`,
        text: `${r.risk}-risk jobs were ${r.jobs} of ${jobs} jobs and ${pct(r.share)} of the known cost ($${r.usd.toFixed(2)}). Splitting that work into smaller, lower-risk issues is where most of the cost can move.`,
        evidence: { risk: r.risk, jobs: r.jobs, of_jobs: jobs, usd: r.usd },
      });
    }
  }
  return out;
}

/**
 * The diagnosis of the jobs that finished (merged or rejected) in [from, to), by default the last 30 days.
 * @param {string} root
 * @param {{ from?: string, to?: string, now?: number, config?: object }} [options]
 */
export function diagnosis(root, { from, to, now = Date.now(), config = {} } = {}) {
  const end = to === undefined ? now : at(to);
  const start = from === undefined ? end - 30 * DAY : at(from);
  const details = readJobs(root)
    .filter((j) => FINISHED.has(j.stage) && at(j.finished) !== null && at(j.finished) >= start && at(j.finished) < end)
    .map((j) => jobDetail(root, j, now));

  const causes = {};
  let extra = 0;
  const lenses = {};
  const byRole = {};
  const byRisk = {};
  const escalation = {};
  for (const d of details) {
    for (const r of d.rounds.slice(1)) {
      extra += 1;
      const list = roundCauses(d.rounds[r.round - 2]);
      for (const cause of list.length ? list : ['unknown']) causes[cause] = (causes[cause] ?? 0) + 1;
    }
    for (const [lens, v] of Object.entries(d.rounds[0]?.reviews ?? {})) {
      if (lens === 'human' || !['PASS', 'CHANGES'].includes(v.verdict)) continue;
      const l = (lenses[lens] ??= { changes: 0, total: 0 });
      l.total += 1;
      if (v.verdict === 'CHANGES') l.changes += 1;
    }
    for (const [role, usd] of Object.entries(d.cost_by_role)) byRole[role] = (byRole[role] ?? 0) + usd;
    const risk = d.risk ?? 'unknown';
    const r = (byRisk[risk] ??= { usd: 0, jobs: 0 });
    r.jobs += 1;
    if (d.cost_usd !== null) r.usd += d.cost_usd;
    if (d.risk) {
      const e = (escalation[d.risk] ??= { jobs: 0, escalated: 0 });
      e.jobs += 1;
      if (d.decision === 'ESCALATE') e.escalated += 1;
    }
  }
  for (const l of Object.values(lenses)) l.rate = share(l.changes, l.total);
  for (const e of Object.values(escalation)) e.rate = share(e.escalated, e.jobs);

  const known = money(details.reduce((s, d) => s + (d.cost_usd ?? 0), 0));
  const roleTotal = Object.values(byRole).reduce((s, v) => s + v, 0);
  const costByRole = Object.entries(byRole).map(([role, usd]) => ({ role, usd: money(usd), share: share(usd, roleTotal) })).sort((a, b) => b.usd - a.usd);
  const costByRisk = Object.entries(byRisk).map(([risk, v]) => ({ risk, usd: money(v.usd), jobs: v.jobs, share: share(v.usd, known) })).sort((a, b) => b.usd - a.usd);
  const extraCauses = Object.entries(causes).map(([cause, rounds]) => ({ cause, label: causeLabel(cause), rounds, share: share(rounds, extra) }))
    .sort((a, b) => b.rounds - a.rounds || a.cause.localeCompare(b.cause));
  const rounds = details.map((d) => d.round);
  const timeBySize = Object.fromEntries(SIZES.map((size) => [size, spread(details.filter((d) => d.size === size).map((d) => d.minutes.until_approval))]));

  const found = proposals({ causes, extra, lenses, escalation, costByRisk, jobs: details.length, config });
  const top = extraCauses[0];
  const summary = details.length
    ? `${details.length} jobs finished from ${iso(start)} to ${iso(end)} with ${extra} extra round${extra === 1 ? '' : 's'}`
      + `${top ? `, most often because ${top.label} (${top.rounds})` : ''}; $${known.toFixed(2)} of known cost`
      + `${costByRisk[0] ? `, ${pct(costByRisk[0].share ?? 0)} of it in ${costByRisk[0].risk}-risk jobs` : ''}. ${found.length} proposal${found.length === 1 ? '' : 's'}.`
    : `No job finished from ${iso(start)} to ${iso(end)}, so there is nothing to diagnose yet.`;

  return {
    summary,
    from: iso(start),
    to: iso(end),
    jobs: details.length,
    rounds: { total: rounds.reduce((s, r) => s + r, 0), extra, one_round_jobs: rounds.filter((r) => r === 1).length },
    extra_round_causes: extraCauses,
    first_review_changes: lenses,
    cost: { known, by_role: costByRole, by_risk: costByRisk },
    escalation_by_risk: escalation,
    minutes_until_approval_by_size: timeBySize,
    minutes_after_approval: spread(details.map((d) => d.minutes.after_approval)),
    proposals: found,
    note: 'Proposals describe a change; nothing was changed. Only jobs on this machine are counted.',
  };
}
