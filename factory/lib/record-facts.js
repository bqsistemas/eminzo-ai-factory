// The facts line of a pull request's Factory record: one hidden HTML comment with what the job's size, risk,
// rounds, times, cost and approval decision were. factory/jobs stays on the machine that ran the job; this line is how the rest of
// the team (and Ask Eminzo's estimates) learn from it. Pure: job.js writes it, readers parse it from PR bodies.
//
// Only typed fields go in: ids, numbers, enums, ISO times. Never a title, note or other free text, so the
// line cannot carry instructions and cannot close the comment early.
import { JOB_ID } from './util.js';

export const FACTS_VERSION = 1;
const OPEN = '<!-- factory:facts ';
const CLOSE = ' -->';
const LANES = new Set(['normal', 'xs']);
const RISKS = new Set(['low', 'medium', 'high']);
const SIZES = new Set(['xs', 's', 'm', 'l']);
const SURFACES = new Set(['ui', 'security', 'interaction']);
const DECISIONS = new Set(['APPROVE', 'ESCALATE']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const knownCost = (job) => job.cost_status !== 'unavailable' && typeof job.cost_usd === 'number' && Number.isFinite(job.cost_usd) && job.cost_usd >= 0;

/** The facts of one job, from job.json. */
export function jobFacts(job) {
  const intake = isObject(job.intake) ? job.intake : {};
  return {
    v: FACTS_VERSION,
    job: job.id,
    issue: Number.isInteger(job.issue) ? job.issue : null,
    lane: LANES.has(job.lane) ? job.lane : 'normal',
    size: SIZES.has(intake.size) ? intake.size : null,
    risk: RISKS.has(intake.risk) ? intake.risk : null,
    surfaces: Array.isArray(intake.surfaces) ? intake.surfaces.filter((s) => SURFACES.has(s)) : [],
    round: Number.isInteger(job.round) && job.round >= 1 ? job.round : 1,
    started: isoOrNull(job.started),
    approve_entered: isoOrNull(job.approve_entered),
    cost_usd: knownCost(job) ? Math.round(job.cost_usd * 100) / 100 : null,
    decision: DECISIONS.has(job.decision) ? job.decision : null,
  };
}

/** The hidden line for a PR body. `--` never appears raw, so the comment cannot end before its CLOSE. */
export function factsComment(facts) {
  return `${OPEN}${JSON.stringify(facts).replace(/--/g, '-\\u002d')}${CLOSE}`;
}

/** Every well-formed facts line in a PR body, in order. Malformed or unknown-version lines are skipped. */
export function parseFacts(body) {
  const found = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) continue;
    let facts;
    try {
      facts = JSON.parse(text.slice(OPEN.length, -CLOSE.length));
    } catch {
      continue;
    }
    if (!isObject(facts) || facts.v !== FACTS_VERSION || typeof facts.job !== 'string' || !JOB_ID.test(facts.job)) continue;
    found.push(facts);
  }
  return found;
}
