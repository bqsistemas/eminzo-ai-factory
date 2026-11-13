// An initiative: a brief issue (label `eminzo-brief`) and the deliverable issues cut from it (label
// `eminzo-deliverable`), found by their hidden markers and followed from GitHub only. Read-only: every call is
// `gh issue view|list` or `gh pr view|list`; nothing is created, edited, labeled or closed here.
import { canonicalBrief, stripEnd } from '../brief-approval.js';
import { parseBrief } from '../brief.js';
import { briefIssueValidity, briefTitleOf, DELIVERABLE_LABEL, BRIEF_ISSUE_LABEL, parseDeliverableMarker, partOfLines } from '../handoff.js';
import { safeTitle } from '../job.js';
import { parseFacts } from '../record-facts.js';
import { run } from '../util.js';
import { humanMinutes } from './estimate.js';
import { FACTORY_LABEL, ghProblem } from './github.js';
import { factsMinutes } from './history.js';

const LIST_LIMIT = 100;
const PR_LIMIT = 5;
const SEARCH_LIMIT = 30;
export const GH_TIMEOUT_MS = 20_000;
export const MAX_GH_CALLS = 60;
export const MAX_PR_BODY = 256 * 1024;
const MAX_KNOWN = 50;
const ISSUE_FIELDS = 'number,title,state,body,labels,url,author,createdAt,closedAt';
const LIST_FIELDS = 'number,title,state,body,labels,url,closedAt,author,createdAt';
const PR_FIELDS = 'number,url,state,mergedAt,body,headRefName,isCrossRepository';
/** Only pull requests from the factory's own branches are trusted for their facts line. */
const FACTORY_BRANCH = 'factory/';
const KEYWORDS = new Set(['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved']);

class LimitReached extends Error {}

/** gh's JSON answer, or an Error that says why it could not be read (`unknownField` when this gh lacks a field). */
function ghRead(ctx, args, what) {
  if (ctx.calls >= ctx.maxCalls) throw new LimitReached('gh call limit reached');
  ctx.calls += 1;
  const res = ctx.runner(ctx.gh, args, { cwd: ctx.root, timeout: GH_TIMEOUT_MS });
  if (res.error || res.status !== 0) {
    const why = res.error?.code === 'ETIMEDOUT' ? `gh did not answer within ${GH_TIMEOUT_MS / 1000} seconds` : ghProblem(res);
    const err = new Error(`could not read ${what} from GitHub: ${why}`);
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
const time = (v) => { const ms = Date.parse(v ?? ''); return Number.isFinite(ms) ? ms : null; };

/** Whether a text closes issue `#n` with a closing keyword (`closes #n`, `Fixes: #n`...); a mere mention is not enough. */
function closes(text, n) {
  const body = String(text ?? '');
  const needle = `#${n}`;
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + 1)) {
    const after = body[at + needle.length];
    if (after !== undefined && after >= '0' && after <= '9') continue;
    let end = at;
    while (end > 0 && body[end - 1] === ' ') end -= 1;
    if (body[end - 1] === ':') { end -= 1; while (end > 0 && body[end - 1] === ' ') end -= 1; }
    let start = end;
    while (start > 0 && /[A-Za-z]/.test(body[start - 1])) start -= 1;
    if (KEYWORDS.has(body.slice(start, end).toLowerCase())) return true;
  }
  return false;
}

const prView = (p) => ({
  number: p.number, url: typeof p.url === 'string' ? p.url : null, state: String(p.state ?? '').toUpperCase(),
  merged: String(p.state).toUpperCase() === 'MERGED' || typeof p.mergedAt === 'string', mergedAt: typeof p.mergedAt === 'string' ? p.mergedAt : null, body: p.body, head: typeof p.headRefName === 'string' ? p.headRefName : '',
  // a pull request is trusted only when gh says it is from this repository: a fork can name its branch anything
  fork: p.isCrossRepository !== false,
});

/** The pull requests that close an issue: through gh's closing references, or, on an older gh, by searching for a closing keyword. */
function pullRequestsOf(ctx, number) {
  let refs;
  try {
    refs = ghRead(ctx, ['issue', 'view', String(number), '--json', 'closedByPullRequestsReferences'], `the pull requests of issue #${number}`).closedByPullRequestsReferences;
  } catch (err) {
    if (!err.unknownField) throw err;
    const found = ghRead(ctx, ['pr', 'list', '--state', 'all', '--limit', String(SEARCH_LIMIT), '--search', `#${number} in:body`, '--json', PR_FIELDS], `the pull requests of issue #${number}`);
    const list = Array.isArray(found) ? found : [];
    if (list.length >= SEARCH_LIMIT) ctx.warnings.push(`only the first ${SEARCH_LIMIT} pull requests that mention #${number} were searched.`);
    return list.filter((p) => isInt(p?.number) && closes(p.body, number)).map(prView);
  }
  const numbers = [...new Set((Array.isArray(refs) ? refs : []).map((r) => r?.number).filter(isInt))].slice(0, PR_LIMIT);
  return numbers.map((n) => prView(ghRead(ctx, ['pr', 'view', String(n), '--json', PR_FIELDS], `pull request #${n}`)));
}

/** The time until ready for approval from the LAST well-formed facts line of a factory pull request, or null. */
function actualOf(pr) {
  if (!pr || !pr.head.startsWith(FACTORY_BRANCH)) return null;
  return parseFacts(String(pr.body ?? '').slice(0, MAX_PR_BODY)).map(factsMinutes).filter((m) => m !== null).at(-1) ?? null;
}

/** The cost of a factory pull request from its LAST facts line, in cents, or null when it is not known or not a trusted number. */
function costOf(pr) {
  if (!pr || !pr.head.startsWith(FACTORY_BRANCH)) return null;
  const cost = parseFacts(String(pr.body ?? '').slice(0, MAX_PR_BODY)).at(-1)?.cost_usd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 100) / 100 : null;
}

const isoOf = (v) => { const ms = time(v); return ms === null ? null : new Date(ms).toISOString(); };

/** Where a deliverable stands, from its issue and the pull requests that close it. */
function statusOf(issue, { open, merged }, hasFactory, warnings) {
  const closed = String(issue.state).toUpperCase() === 'CLOSED';
  const reason = String(issue.stateReason ?? '').toUpperCase();
  if (closed) {
    if (reason !== 'COMPLETED') return 'closed';
    if (merged) return 'available';
    warnings.push(`#${issue.number} was closed without a merged change.`);
    return 'closed';
  }
  if (merged) warnings.push(`#${issue.number} was reopened after a merged change.`);
  if (open) return 'in-review';
  return merged || hasFactory ? 'in-factory' : 'waiting-tech-lead';
}

const LOOKALIKE = (n) => `issue #${n} looks like a deliverable of this brief but was not created by Eminzo for it`;

/**
 * Whether an issue is a deliverable Eminzo created for this brief: the label, the brief issue's author, created after it,
 * the `Part of` line of the template, a marker of this brief and approval, and (when the brief text is trusted) a known id.
 * `{ marker }` when it is; `{ lookalike: true }` when it carries our marker but fails a rule; `{}` when it is not about us.
 */
function assess(issue, ctx) {
  const body = String(issue.body ?? '');
  if (!body.includes('<!-- eminzo:deliverable')) return {};
  const marker = parseDeliverableMarker(body);
  if (marker && marker.brief !== ctx.number) return {};
  const lines = body.split('\n').map(stripEnd);
  const created = time(issue.createdAt);
  const ok = issue.number !== ctx.number
    && names(issue.labels).includes(DELIVERABLE_LABEL)
    && ctx.author !== null && issue.author?.login === ctx.author
    && created !== null && ctx.createdAt !== null && created > ctx.createdAt
    && partOfLines(ctx.number).some((l) => lines.includes(l))
    && marker !== null && marker.hash === ctx.hash
    && (ctx.ids === null || ctx.ids.has(marker.id));
  return ok ? { marker } : { lookalike: true };
}

/** The deliverable issues of a brief issue that pass `assess`, by id; the lookalikes only produce warnings. */
function deliverableIssues(ctx, known) {
  const base = ['issue', 'list', '--search', `"eminzo:deliverable v1 brief=${ctx.number} " in:body`, '--label', DELIVERABLE_LABEL, '--state', 'all', '--limit', String(LIST_LIMIT), '--json'];
  let list;
  try {
    list = ghRead(ctx, [...base, `${LIST_FIELDS},stateReason`], `the deliverables of issue #${ctx.number}`);
  } catch (err) {
    if (!err.unknownField) throw err;
    list = ghRead(ctx, [...base, LIST_FIELDS], `the deliverables of issue #${ctx.number}`);
  }
  if (!Array.isArray(list)) throw new Error(`could not read the deliverables of issue #${ctx.number} from GitHub: gh did not return a list`);
  if (list.length >= LIST_LIMIT) ctx.warnings.push(`only the first ${LIST_LIMIT} issues that mention this brief were read.`);
  const candidates = list.filter((i) => isInt(i?.number));
  const seen = new Set(candidates.map((i) => i.number));
  for (const n of [...new Set(known)].filter((k) => !seen.has(k))) {
    seen.add(n);
    try {
      const fields = ISSUE_FIELDS.replace('closedAt', 'closedAt,stateReason');
      let one;
      try {
        one = ghRead(ctx, ['issue', 'view', String(n), '--json', fields], `issue #${n}`);
      } catch (err) {
        if (!err.unknownField) throw err;
        one = ghRead(ctx, ['issue', 'view', String(n), '--json', ISSUE_FIELDS], `issue #${n}`);
      }
      if (one && isInt(one.number)) candidates.push(one);
    } catch (err) {
      if (err instanceof LimitReached) { ctx.limited = true; break; }
      ctx.warnings.push(`${err.message}.`);
    }
  }
  const byId = new Map();
  const ordered = candidates.sort((a, b) => (time(a.createdAt) ?? 0) - (time(b.createdAt) ?? 0) || a.number - b.number);
  for (const issue of ordered) {
    const { marker, lookalike } = assess(issue, ctx);
    if (lookalike) ctx.warnings.push(LOOKALIKE(issue.number));
    if (marker) byId.set(marker.id, [...(byId.get(marker.id) ?? []), { issue, marker }]);
  }
  for (const [id, found] of byId) {
    if (found.length > 1) ctx.warnings.push(`${id} has more than one issue (${found.map((f) => `#${f.issue.number}`).join(', ')}); #${found[0].issue.number} is used.`);
  }
  return byId;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const SENTENCE = [['in-review', 'in review'], ['in-factory', 'in the factory'], ['waiting-tech-lead', 'waiting for the tech lead'], ['closed', 'closed without being delivered'], ['not-created', 'not created yet']];

/**
 * The state of an initiative, from GitHub alone. Throws an Error that says why gh could not answer, or that the issue is
 * not an Eminzo brief issue. Only issues Eminzo created for this brief count (see `assess`).
 * @param {string} root the main checkout
 * @param {{ issue: number, known?: number[], gh?: string, runner?: typeof run, maxCalls?: number }} options
 *   `known`: numbers of deliverable issues the caller created, read directly because GitHub's search can lag a minute.
 */
export function initiative(root, { issue: number, known = [], gh = process.env.FACTORY_GH || 'gh', runner = run, maxCalls = MAX_GH_CALLS }) {
  if (!isInt(number)) throw new Error('initiative needs the brief issue number (a positive integer).');
  if (!Array.isArray(known) || known.length > MAX_KNOWN || !known.every(isInt)) throw new Error(`known must be a list of up to ${MAX_KNOWN} issue numbers.`);
  const warnings = [];
  const ctx = { root, gh, runner, maxCalls, calls: 0, warnings, number, limited: false };
  try {
    return read(ctx, number, known, warnings, maxCalls);
  } catch (err) {
    if (err instanceof LimitReached) throw new Error(`gh call limit reached (${maxCalls}): the initiative of issue #${number} could not be read.`);
    throw err;
  }
}

function read(ctx, number, known, warnings, maxCalls) {
  const head = ghRead(ctx, ['issue', 'view', String(number), '--json', ISSUE_FIELDS], `issue #${number}`);
  if (!head || typeof head !== 'object') throw new Error(`could not read issue #${number} from GitHub: gh did not return an issue`);
  if (!names(head.labels).includes(BRIEF_ISSUE_LABEL)) throw new Error(`Issue #${number} is not an Eminzo brief issue: it does not have the ${BRIEF_ISSUE_LABEL} label.`);
  const validity = briefIssueValidity(head.body);
  if (!validity.marker) throw new Error(`Issue #${number} is not an Eminzo brief issue: it has no brief marker.`);
  const author = typeof head.author?.login === 'string' ? head.author.login : null;
  if (!validity.valid) {
    warnings.push(`WARNING: the brief issue no longer matches its approval: ${validity.reason} Its text may have been edited, so it does not decide which deliverables exist; only the deliverable issues found are listed.`);
  } else if (head.title !== briefTitleOf(validity.text)) {
    warnings.push('The title of the brief issue was changed after it was created; the approval does not cover the title.');
  }
  if (author && validity.approval && author !== validity.approval.by) warnings.push(`The brief issue was created by ${author} but approved by ${validity.approval.by}.`);

  const brief = validity.valid ? parseBrief(canonicalBrief(validity.text)) : null;
  Object.assign(ctx, { author, createdAt: time(head.createdAt), hash: validity.marker.hash.slice(0, 12), ids: brief ? new Set(brief.deliverables.map((d) => d.id)) : null });
  const found = deliverableIssues(ctx, known);

  const describe = (id, hit, after) => {
    const factory = names(hit.issue.labels).includes(FACTORY_LABEL);
    let prs = [];
    try {
      prs = pullRequestsOf(ctx, hit.issue.number);
    } catch (err) {
      if (!(err instanceof LimitReached)) throw err;
      ctx.limited = true;
    }
    for (const p of prs.filter((x) => x.fork)) warnings.push(`pull request #${p.number} comes from a fork and is ignored.`);
    prs = prs.filter((p) => !p.fork);
    const open = prs.filter((p) => p.state === 'OPEN').sort((a, b) => b.number - a.number)[0] ?? null;
    const merged = prs.filter((p) => p.merged).sort((a, b) => b.number - a.number)[0] ?? null;
    const pr = open ?? merged;
    const status = statusOf(hit.issue, { open, merged }, factory, warnings);
    return {
      id, issue: hit.issue.number, title: safeTitle(hit.issue.title), url: typeof hit.issue.url === 'string' ? hit.issue.url : null,
      status, factory, after,
      pr: pr ? { number: pr.number, url: pr.url, state: pr.state, merged: pr.merged } : null,
      estimate: hit.marker.est, actual_min: actualOf(pr),
      // when it became available: the merge of the pull request that closes it, else the time the issue was closed
      available_at: status === 'available' ? isoOf(merged?.mergedAt) ?? isoOf(hit.issue.closedAt) : null,
      cost_usd: costOf(pr),
    };
  };
  const idNumber = (id) => Number(id.slice(1));
  const deliverables = brief
    ? brief.deliverables.map((d) => {
      const hit = found.get(d.id)?.[0];
      if (hit) return describe(d.id, hit, d.after);
      warnings.push(`${d.id} was not found yet (GitHub search can lag a minute).`);
      return { id: d.id, issue: null, title: safeTitle(d.title), url: null, status: 'not-created', factory: false, after: d.after, pr: null, estimate: null, actual_min: null, available_at: null, cost_usd: null };
    })
    : [...found].sort(([a], [b]) => idNumber(a) - idNumber(b)).map(([id, hits]) => describe(id, hits[0], []));
  if (ctx.limited) warnings.push(`gh call limit reached (${maxCalls}): some pull requests were not read.`);

  const total = deliverables.length;
  const done = deliverables.filter((d) => d.status === 'available').length;
  // Estimate and actual are summed over the same deliverables: those that are available and have both.
  const compared = deliverables.filter((d) => d.status === 'available' && d.estimate && d.actual_min !== null);
  const round = (n) => Math.round(n * 10) / 10;
  const estimate_vs_actual = {
    estimated: compared.length ? { low_min: round(compared.reduce((s, d) => s + d.estimate.low_min, 0)), high_min: round(compared.reduce((s, d) => s + d.estimate.high_min, 0)) } : null,
    actual_min: compared.length ? round(compared.reduce((s, d) => s + d.actual_min, 0)) : null,
    complete: validity.valid && total > 0 && deliverables.every((d) => d.status === 'available' && d.estimate && d.actual_min !== null),
    counted: { compared: compared.length, of: total },
    basis: 'Only available deliverables are compared. The actual time is measured from the last facts line of the pull request (job start until ready for approval), the same way an estimate is; the wait for people is not included.',
  };

  const counts = SENTENCE.map(([status, words]) => [deliverables.filter((d) => d.status === status).length, words]).filter(([n]) => n > 0);
  const summary = [
    `Initiative #${number} "${safeTitle(head.title)}": ${done} of ${plural(total, 'deliverable', 'deliverables')} ${done === 1 ? 'is' : 'are'} available${counts.length ? `; ${counts.map(([n, words]) => `${n} ${words}`).join(', ')}` : ''}.`,
    ...(validity.valid ? [] : [`The brief issue no longer matches its approval (${validity.reason}), so only the deliverable issues found are listed.`]),
    ...(estimate_vs_actual.estimated ? [`Estimated ${humanMinutes(estimate_vs_actual.estimated.low_min)} to ${humanMinutes(estimate_vs_actual.estimated.high_min)}, took ${humanMinutes(estimate_vs_actual.actual_min)} until ready for approval (${plural(compared.length, 'deliverable', 'deliverables')} compared).`] : []),
  ].join(' ');

  return {
    summary,
    language: brief ? brief.language : null,
    brief: {
      issue: number, title: safeTitle(head.title), url: typeof head.url === 'string' ? head.url : null, state: String(head.state ?? '').toUpperCase(),
      author, created_at: typeof head.createdAt === 'string' ? head.createdAt : null,
      approvedBy: validity.approval?.by ?? null, approvedAt: validity.approval?.at ?? null, valid: validity.valid,
    },
    deliverables, progress: { done, total }, estimate_vs_actual, warnings,
  };
}
