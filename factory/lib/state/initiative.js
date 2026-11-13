// An initiative: a brief issue (label `eminzo-brief`) and the deliverable issues cut from it (label
// `eminzo-deliverable`), found by their hidden markers and followed from GitHub only. Read-only: every call is
// `gh issue view|list` or `gh pr view|list`; nothing is created, edited, labeled or closed here.
import { canonicalBrief } from '../brief-approval.js';
import { parseBrief } from '../brief.js';
import { briefIssueValidity, parseDeliverableMarker } from '../handoff.js';
import { safeTitle } from '../job.js';
import { parseFacts } from '../record-facts.js';
import { run } from '../util.js';
import { humanMinutes } from './estimate.js';
import { FACTORY_LABEL, ghProblem } from './github.js';
import { factsMinutes } from './history.js';

const LIST_LIMIT = 100;
const PR_LIMIT = 5;
const ISSUE_FIELDS = 'number,title,state,body,labels,url,author,createdAt,closedAt';
const LIST_FIELDS = 'number,title,state,body,labels,url,closedAt';
const PR_FIELDS = 'number,url,state,mergedAt,body';

/** gh's JSON answer, or an Error that says why it could not be read (`unknownField` when this gh lacks a field). */
function ghRead(ctx, args, what) {
  const res = ctx.runner(ctx.gh, args, { cwd: ctx.root });
  if (res.error || res.status !== 0) {
    const err = new Error(`could not read ${what} from GitHub: ${ghProblem(res)}`);
    err.unknownField = /unknown json field/i.test(String(res.stderr ?? ''));
    throw err;
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`could not read ${what} from GitHub: gh did not return JSON`);
  }
}

const names = (labels) => (Array.isArray(labels) ? labels.map((l) => l?.name).filter((n) => typeof n === 'string') : []);
const isInt = (n) => Number.isInteger(n) && n > 0;

/** Whether a text mentions `#n` as a whole issue number (not `#n0`, not `a#n`). */
function mentions(text, n) {
  const needle = `#${n}`;
  const body = String(text ?? '');
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + 1)) {
    const before = body[at - 1];
    const after = body[at + needle.length];
    if ((before === undefined || !/[\p{L}\p{N}]/u.test(before)) && (after === undefined || !(after >= '0' && after <= '9'))) return true;
  }
  return false;
}

const prView = (p) => ({ number: p.number, url: typeof p.url === 'string' ? p.url : null, state: String(p.state ?? '').toUpperCase(), merged: String(p.state).toUpperCase() === 'MERGED' || typeof p.mergedAt === 'string', body: p.body });

/** The pull requests that close an issue: through gh's closing references, or, on an older gh, by searching their text. */
function pullRequestsOf(ctx, number) {
  let refs;
  try {
    refs = ghRead(ctx, ['issue', 'view', String(number), '--json', 'closedByPullRequestsReferences'], `the pull requests of issue #${number}`).closedByPullRequestsReferences;
  } catch (err) {
    if (!err.unknownField) throw err;
    const found = ghRead(ctx, ['pr', 'list', '--state', 'all', '--limit', '30', '--search', `#${number} in:body`, '--json', PR_FIELDS], `the pull requests of issue #${number}`);
    return (Array.isArray(found) ? found : []).filter((p) => isInt(p?.number) && mentions(p.body, number)).map(prView);
  }
  const numbers = [...new Set((Array.isArray(refs) ? refs : []).map((r) => r?.number).filter(isInt))].slice(0, PR_LIMIT);
  return numbers.map((n) => prView(ghRead(ctx, ['pr', 'view', String(n), '--json', PR_FIELDS], `pull request #${n}`)));
}

/** The pull request that tells where a deliverable stands: an open one, else the latest merged one, else none. */
function chosen(prs) {
  const open = prs.filter((p) => p.state === 'OPEN').sort((a, b) => b.number - a.number)[0];
  return open ?? prs.filter((p) => p.merged).sort((a, b) => b.number - a.number)[0] ?? null;
}

function statusOf(issue, pr, hasFactory) {
  const closed = String(issue.state).toUpperCase() === 'CLOSED';
  const completed = String(issue.stateReason ?? '').toUpperCase() === 'COMPLETED';
  if (pr?.merged) return 'available';
  if (closed) return completed ? 'available' : 'closed';
  if (pr?.state === 'OPEN') return 'in-review';
  return hasFactory ? 'in-factory' : 'waiting-tech-lead';
}

/** The deliverable issues of a brief issue: marker, brief number and approval hash must all agree. */
function deliverableIssues(ctx, number, briefHash, ids, warnings) {
  const query = `"eminzo:deliverable v1 brief=${number} " in:body`;
  const base = ['issue', 'list', '--search', query, '--state', 'all', '--limit', String(LIST_LIMIT), '--json'];
  let list;
  try {
    list = ghRead(ctx, [...base, `${LIST_FIELDS},stateReason`], `the deliverables of issue #${number}`);
  } catch (err) {
    if (!err.unknownField) throw err;
    list = ghRead(ctx, [...base, LIST_FIELDS], `the deliverables of issue #${number}`);
  }
  if (!Array.isArray(list)) throw new Error(`could not read the deliverables of issue #${number} from GitHub: gh did not return a list`);
  if (list.length >= LIST_LIMIT) warnings.push(`only the first ${LIST_LIMIT} issues that mention this brief were read.`);
  const byId = new Map();
  for (const issue of list.filter((i) => isInt(i?.number)).sort((a, b) => a.number - b.number)) {
    const marker = parseDeliverableMarker(issue.body);
    if (!marker || marker.brief !== number) continue;
    if (marker.hash !== briefHash) { warnings.push(`#${issue.number} belongs to another approval of this brief and is ignored.`); continue; }
    if (!ids.has(marker.id)) { warnings.push(`#${issue.number} is ${marker.id}, which is not a deliverable of this brief, and is ignored.`); continue; }
    byId.set(marker.id, [...(byId.get(marker.id) ?? []), { issue, marker }]);
  }
  for (const [id, found] of byId) {
    if (found.length > 1) warnings.push(`${id} has more than one issue (${found.map((f) => `#${f.issue.number}`).join(', ')}); #${found[0].issue.number} is used.`);
  }
  return byId;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const SENTENCE = [['in-review', 'in review'], ['in-factory', 'in the factory'], ['waiting-tech-lead', 'waiting for the tech lead'], ['closed', 'closed without being delivered'], ['not-created', 'not created yet']];

/**
 * The state of an initiative, from GitHub alone. Throws an Error that says why gh could not answer, or that the issue is
 * not an Eminzo brief issue.
 * @param {string} root the main checkout
 * @param {{ issue: number, gh?: string, runner?: typeof run }} options
 */
export function initiative(root, { issue: number, gh = process.env.FACTORY_GH || 'gh', runner = run }) {
  const ctx = { root, gh, runner };
  const head = ghRead(ctx, ['issue', 'view', String(number), '--json', ISSUE_FIELDS], `issue #${number}`);
  if (!head || typeof head !== 'object') throw new Error(`could not read issue #${number} from GitHub: gh did not return an issue`);
  const validity = briefIssueValidity(head.body);
  if (!validity.marker) throw new Error(`Issue #${number} is not an Eminzo brief issue: it has no brief marker.`);
  const brief = parseBrief(canonicalBrief(head.body));
  const warnings = [];
  const found = deliverableIssues(ctx, number, validity.marker.hash.slice(0, 12), new Set(brief.deliverables.map((d) => d.id)), warnings);

  const deliverables = brief.deliverables.map((d) => {
    const hit = found.get(d.id)?.[0];
    if (!hit) return { id: d.id, issue: null, title: safeTitle(d.title), url: null, status: 'not-created', factory: false, after: d.after, pr: null, estimate: null, actual_min: null };
    const factory = names(hit.issue.labels).includes(FACTORY_LABEL);
    const pr = chosen(pullRequestsOf(ctx, hit.issue.number));
    const facts = pr ? parseFacts(pr.body).map(factsMinutes).filter((m) => m !== null).at(-1) ?? null : null;
    return {
      id: d.id, issue: hit.issue.number, title: safeTitle(hit.issue.title), url: typeof hit.issue.url === 'string' ? hit.issue.url : null,
      status: statusOf(hit.issue, pr, factory), factory, after: d.after,
      pr: pr ? { number: pr.number, url: pr.url, state: pr.state, merged: pr.merged } : null,
      estimate: hit.marker.est, actual_min: facts,
    };
  });

  const total = deliverables.length;
  const done = deliverables.filter((d) => d.status === 'available').length;
  // Estimated and actual are summed over the same deliverables (those with both), so the two sides are comparable.
  const compared = deliverables.filter((d) => d.estimate && d.actual_min !== null);
  const sum = (key) => Math.round(compared.reduce((s, d) => s + d[key], 0) * 10) / 10;
  const estimate_vs_actual = {
    estimated: compared.length ? { low_min: Math.round(compared.reduce((s, d) => s + d.estimate.low_min, 0) * 10) / 10, high_min: Math.round(compared.reduce((s, d) => s + d.estimate.high_min, 0) * 10) / 10 } : null,
    actual_min: compared.length ? sum('actual_min') : null,
    complete: total > 0 && deliverables.every((d) => d.status === 'available' && d.estimate && d.actual_min !== null),
    counted: { compared: compared.length, of: total },
  };

  const counts = SENTENCE.map(([status, words]) => [deliverables.filter((d) => d.status === status).length, words]).filter(([n]) => n > 0);
  const summary = [
    `Initiative #${number} "${safeTitle(head.title)}": ${done} of ${plural(total, 'deliverable', 'deliverables')} ${done === 1 ? 'is' : 'are'} available${counts.length ? `; ${counts.map(([n, words]) => `${n} ${words}`).join(', ')}` : ''}.`,
    ...(validity.valid ? [] : [`The brief issue no longer matches its approval: ${validity.reason}`]),
    ...(estimate_vs_actual.estimated ? [`Estimated ${humanMinutes(estimate_vs_actual.estimated.low_min)} to ${humanMinutes(estimate_vs_actual.estimated.high_min)}, took ${humanMinutes(estimate_vs_actual.actual_min)} until ready for approval (${plural(compared.length, 'deliverable', 'deliverables')} compared).`] : []),
  ].join(' ');

  return {
    summary,
    brief: {
      issue: number, title: safeTitle(head.title), url: typeof head.url === 'string' ? head.url : null, state: String(head.state ?? '').toUpperCase(),
      author: typeof head.author?.login === 'string' ? head.author.login : null, created_at: typeof head.createdAt === 'string' ? head.createdAt : null,
      approvedBy: validity.approval?.by ?? null, approvedAt: validity.approval?.at ?? null, valid: validity.valid,
    },
    deliverables, progress: { done, total }, estimate_vs_actual, warnings,
  };
}
