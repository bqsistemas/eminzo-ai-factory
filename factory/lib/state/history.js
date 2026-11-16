// The finished jobs an estimate learns from: merged jobs on this machine, plus, when asked, the facts line of
// merged pull requests on GitHub (written by other developers' factories). One record per job, local first.
// Read-only: the only GitHub call is `gh pr list`.
import { parseFacts } from '../record-facts.js';
import { run } from '../util.js';
import { readJobs } from './jobs.js';

/** How many merged pull requests are read from GitHub at most. */
export const PR_LIMIT = 200;
const MINUTE = 60_000;

const at = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};
const minutes = (from, to) => (from !== null && to !== null && to >= from ? Math.round(((to - from) / MINUTE) * 10) / 10 : null);
const knownCost = (job) => job.cost_status !== 'unavailable' && typeof job.cost_usd === 'number' && Number.isFinite(job.cost_usd) && job.cost_usd >= 0;
const decisionOf = (d) => (d === 'ESCALATE' ? true : d === 'APPROVE' ? false : null);

/** Minutes from a facts line's start until the job was ready for approval (what an estimate measures), or null. */
export const factsMinutes = (facts) => minutes(at(facts?.started), at(facts?.approve_entered));

/** One record per merged local job that has a start and an approve time. */
export function localRecords(root) {
  return readJobs(root).filter((j) => j.stage === 'merged' && at(j.started) !== null && at(j.approve_entered) !== null).map((j) => ({
    job: j.id,
    source: 'local',
    size: j.intake?.size ?? null,
    risk: j.intake?.risk ?? null,
    lane: j.lane === 'xs' ? 'xs' : 'normal',
    surfaces: Array.isArray(j.intake?.surfaces) ? j.intake.surfaces : [],
    rounds: Number.isInteger(j.round) ? j.round : 1,
    factory_minutes: minutes(at(j.started), at(j.approve_entered)),
    wait_minutes: minutes(at(j.approve_entered), at(j.finished)),
    cost_usd: knownCost(j) ? j.cost_usd : null,
    escalated: decisionOf(j.decision),
  }));
}

/** Records from the facts lines of merged pull requests. Throws an Error that says why gh could not answer. */
export function githubRecords(root, { gh = process.env.FACTORY_GH || 'gh', runner = run } = {}) {
  const res = runner(gh, ['pr', 'list', '--state', 'merged', '--limit', String(PR_LIMIT), '--json', 'number,body,mergedAt'], { cwd: root });
  if (res.error || res.status !== 0) {
    const why = res.error ? (res.error.code === 'ENOENT' ? 'the GitHub CLI (gh) is not installed' : res.error.message) : String(res.stderr ?? '').trim().split('\n').slice(-1)[0] || `gh exited with code ${res.status}`;
    throw new Error(`could not read merged pull requests from GitHub: ${why}`);
  }
  let prs;
  try {
    prs = JSON.parse(res.stdout);
  } catch {
    throw new Error('could not read merged pull requests from GitHub: gh did not return JSON');
  }
  const records = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    for (const f of parseFacts(pr?.body)) {
      if (at(f.started) === null || at(f.approve_entered) === null) continue;
      records.push({
        job: f.job,
        source: 'github',
        pr: Number.isInteger(pr.number) ? pr.number : null,
        size: f.size ?? null,
        risk: f.risk ?? null,
        lane: f.lane === 'xs' ? 'xs' : 'normal',
        surfaces: Array.isArray(f.surfaces) ? f.surfaces : [],
        rounds: Number.isInteger(f.round) ? f.round : 1,
        factory_minutes: factsMinutes(f),
        wait_minutes: minutes(at(f.approve_entered), at(pr.mergedAt)),
        cost_usd: typeof f.cost_usd === 'number' && f.cost_usd >= 0 ? f.cost_usd : null,
        escalated: decisionOf(f.decision),
      });
    }
  }
  return { records, truncated: Array.isArray(prs) && prs.length >= PR_LIMIT };
}

/**
 * Local records, plus GitHub records for jobs not on this machine when `github` is true. A GitHub failure does
 * not lose the local history: it is reported in `github_error`.
 */
export function historyRecords(root, { github = false, gh, runner } = {}) {
  const local = localRecords(root);
  if (!github) return { records: local, sources: { local: local.length, github: 0 }, github_error: null, truncated: false };
  try {
    const seen = new Set(local.map((r) => r.job));
    const remote = githubRecords(root, { gh, runner });
    const extra = remote.records.filter((r) => !seen.has(r.job) && (seen.add(r.job), true));
    return { records: [...local, ...extra], sources: { local: local.length, github: extra.length }, github_error: null, truncated: remote.truncated };
  } catch (err) {
    return { records: local, sources: { local: local.length, github: 0 }, github_error: err.message, truncated: false };
  }
}
