// Which factory agents a board.json job implies are working right now, the badge
// row the dashboard shows for them, and the v2 card helpers (columns, round chips,
// issue/PR links, cost and time). Plain ES module: runs in the browser (imported by
// dashboard.html) and in Node (imported by the tests and factory/lib/job.js).

import { avatarSvg } from './avatars.js';

// Each agent's icon is its animated octopus from avatars.js: a fixed string built
// only from constants, the one thing emitted unescaped.
const agent = (name, label) => Object.freeze({ label, icon: avatarSvg(name) });

export const AGENTS = Object.freeze({
  intake: agent('intake', 'Intake'),
  'spec-writer': agent('spec-writer', 'Spec writer'),
  builder: agent('builder', 'Builder'),
  'review-security': agent('review-security', 'Security review'),
  'review-ux': agent('review-ux', 'UX review'),
  'review-ui': agent('review-ui', 'UI review'),
  'review-code': agent('review-code', 'Code review'),
  approver: agent('approver', 'Approver'),
});

/** Board columns, in pipeline order: [stage, label]. */
export const STAGE_COLUMNS = Object.freeze([
  ['intake', 'Intake'],
  ['needs-info', 'Needs info'],
  ['spec', 'Spec'],
  ['spec-review', 'Spec review'],
  ['build', 'Build'],
  ['gate', 'Gate'],
  ['review', 'Review'],
  ['approve', 'Approve'],
  ['merging', 'Merging'],
  ['awaiting-merge', 'Awaiting merge'],
  ['needs-human', 'Needs human'],
  ['merged', 'Merged'],
  ['rejected', 'Rejected'],
].map((column) => Object.freeze(column)));

/** Visual tone per stage; drives the column accent colour on the dashboard. */
export const LANE_TONES = Object.freeze({
  intake: 'pending', 'needs-info': 'pending',
  'spec-review': 'parked',
  spec: 'active', build: 'active', gate: 'active',
  review: 'review', approve: 'review', merging: 'review', 'awaiting-merge': 'review',
  merged: 'done', 'needs-human': 'parked', rejected: 'muted',
});

/** One of six fixed tone strings; unknown or non-string stages fall back to 'pending'. Never echoes its input. */
export function laneTone(stage) {
  return typeof stage === 'string' && Object.hasOwn(LANE_TONES, stage) ? LANE_TONES[stage] : 'pending';
}

const SINGLE = Object.freeze({ intake: 'intake', spec: 'spec-writer', build: 'builder', approve: 'approver' });
const LENSES = Object.freeze(['security', 'ux', 'ui', 'code']);
const GATE_STATES = new Set(['PASS', 'FAIL']);
const REVIEW_STATES = new Set(['PASS', 'CHANGES', 'pending']);
const REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
const DASH = '—';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Agent names the job's board state implies are running. Never throws; any
 * missing or malformed field yields [].
 * @param {unknown} job a board.json job
 * @returns {string[]}
 */
export function activeAgents(job) {
  if (!isObject(job) || typeof job.stage !== 'string') return [];
  if (Object.hasOwn(SINGLE, job.stage)) return [SINGLE[job.stage]];
  if (job.stage !== 'review' || !isObject(job.reviews)) return [];
  return LENSES
    .filter((lens) => Object.hasOwn(job.reviews, lens) && job.reviews[lens] === 'pending')
    .map((lens) => `review-${lens}`);
}

/**
 * Badge row for the job card, or '' when nothing is running. Only the fixed
 * AGENTS icons are emitted raw; every other interpolated value is escaped.
 * @param {unknown} job a board.json job
 * @returns {string}
 */
export function agentsHtml(job) {
  const names = activeAgents(job);
  if (!names.length) return '';
  const badges = names.map((name) => {
    const { label, icon } = AGENTS[name];
    return `<span class="agent" role="listitem" data-agent="${esc(name)}">` +
      `<span class="avatar" aria-hidden="true">${icon}</span>` +
      `<span class="agent-label">${esc(label)}</span></span>`;
  });
  return `<span class="agents" role="list" aria-label="Running agents">${badges.join('')}</span>`;
}

/**
 * One round's chips: the gate first, then one chip per review key present
 * (known lenses in a fixed order, then any others such as `human`).
 * @param {unknown} round `{ gate, reviews, carried }` from job.history or the current job;
 *   `carried` maps a lens to `{ verdict, round }` for a lens that did not rerun
 * @returns {string}
 */
export function roundChipsHtml(round) {
  const { gate, reviews, carried } = isObject(round) ? round : {};
  const g = GATE_STATES.has(gate) ? gate : 'pending';
  const chips = [`<span class="chip gate ${g}" role="img" aria-label="gate: ${g}" title="gate: ${g}">gate</span>`];
  if (isObject(reviews)) {
    const keys = [...LENSES.filter((k) => Object.hasOwn(reviews, k)), ...Object.keys(reviews).filter((k) => !LENSES.includes(k))];
    for (const key of keys) {
      const state = REVIEW_STATES.has(reviews[key]) ? reviews[key] : '';
      const label = `${esc(key)}: ${esc(state || 'unknown')}`;
      chips.push(`<span class="chip${state ? ` ${state}` : ''}" role="img" aria-label="${label}" title="${label}">${esc(key)}</span>`);
    }
  }
  if (isObject(carried)) {
    for (const [key, mark] of Object.entries(carried)) {
      const state = isObject(mark) && REVIEW_STATES.has(mark.verdict) ? mark.verdict : '';
      const from = isObject(mark) && positiveInt(mark.round) ? ` (carried from R${mark.round})` : ' (carried)';
      const label = `${esc(key)}: ${esc(state || 'unknown')}${from}`;
      chips.push(`<span class="chip${state ? ` ${state}` : ''} carried" role="img" aria-label="${label}" title="${label}">${esc(key)}</span>`);
    }
  }
  return chips.join('');
}

const positiveInt = (n) => Number.isInteger(n) && n > 0;

/**
 * Issue and PR links for a card, or '' when the repo is not a plain GitHub URL.
 * @param {unknown} job a board.json job
 * @param {unknown} repo board.json `repo`, e.g. https://github.com/owner/name
 * @returns {string}
 */
export function linksHtml(job, repo) {
  if (!isObject(job) || typeof repo !== 'string' || !REPO.test(repo)) return '';
  const links = [];
  if (positiveInt(job.issue)) links.push(`<a class="link" href="${esc(`${repo}/issues/${job.issue}`)}" target="_blank" rel="noopener">Issue #${job.issue}</a>`);
  if (positiveInt(job.issue) && positiveInt(job.pr)) links.push(`<a class="link" href="${esc(`${repo}/pull/${job.pr}`)}" target="_blank" rel="noopener">PR #${job.pr}</a>`);
  return links.length ? `<span class="links">${links.join('')}</span>` : '';
}

/**
 * A duration as `<m>m` or `<h>h <m>m`, or '—' when it is not a valid length.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DASH;
  const minutes = Math.floor(ms / 60000);
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

/** Legacy numeric costs remain compatible; explicit unknown always wins. */
export function costAvailable(job) {
  return job?.cost_status !== 'unavailable' && (job?.provider !== 'codex' || job?.cost_status === 'available')
    && typeof job?.cost_usd === 'number' && Number.isFinite(job.cost_usd) && job.cost_usd >= 0;
}

// English defaults preserve CLI and existing helper callers. The dashboard
// supplies its selected, fixed en/es/pt dictionary; no rollout text is emitted.
export const COST_TEXT_EN = Object.freeze({
  costUnavailable: 'Cost unavailable',
  costUnavailableCount: '{n} unavailable',
  costHintDefault: 'Sync this job to check cost availability.',
  costHint_missing_price: 'Configure exact-model Codex prices in factory/config.json, then sync.',
  costHint_missing_model: 'Check the rollout model metadata, then sync.',
  costHint_no_associated_usage: 'Run a dedicated job worker, then sync after usage is recorded.',
  costHint_ambiguous_session: 'Use a dedicated, unforked session for this job; shared usage cannot be priced safely.',
  costHint_invalid_usage: 'Check rollout usage counters, then sync with valid data.',
});
const COST_HINT_KEYS = Object.freeze({
  missing_price: 'costHint_missing_price', missing_model: 'costHint_missing_model',
  no_associated_usage: 'costHint_no_associated_usage', ambiguous_session: 'costHint_ambiguous_session',
  invalid_usage: 'costHint_invalid_usage',
});
const unknownCost = (job) => job?.cost_status === 'unavailable' || (job?.provider === 'codex' && !costAvailable(job));

export function costLabel(job, text = COST_TEXT_EN) {
  if (unknownCost(job)) return text.costUnavailable ?? COST_TEXT_EN.costUnavailable;
  return costAvailable(job) ? `$${job.cost_usd.toFixed(2)}` : DASH;
}

/**
 * Cost and elapsed time for a card: `$1.84` and the time from `started` to
 * `finished` (or `now`). Missing or invalid values render as '—'.
 * @param {unknown} job a board.json job
 * @param {number|Date} [now]
 * @param {object} [text] selected dashboard dictionary (English by default)
 * @returns {string}
 */
export function costTimeHtml(job, now = Date.now(), text = COST_TEXT_EN) {
  const j = isObject(job) ? job : {};
  const cost = costLabel(j, text);
  const key = typeof j.cost_reason === 'string' && Object.hasOwn(COST_HINT_KEYS, j.cost_reason)
    ? COST_HINT_KEYS[j.cost_reason] : 'costHintDefault';
  const reason = text[key] ?? COST_TEXT_EN[key];
  const hint = unknownCost(j) ? `${cost}. ${reason}` : null;
  const start = typeof j.started === 'string' ? Date.parse(j.started) : NaN;
  const end = typeof j.finished === 'string' ? Date.parse(j.finished) : Number(now);
  return `<span class="cost" title="${esc(hint ?? 'cost')}"${hint ? ` aria-label="${esc(hint)}"` : ''}>${esc(cost)}</span>` +
    `<span class="time" title="time">${esc(formatDuration(end - start))}</span>`;
}

const recency = (job) => {
  for (const key of ['finished', 'updated']) {
    const t = Date.parse(job?.[key]);
    if (!Number.isNaN(t)) return t;
  }
  return -Infinity;
};

/** Newest-first split of merged jobs: the first `keep` are `recent`, the rest `older`. Never throws. */
export function splitMerged(jobs, keep = 3) {
  if (!Array.isArray(jobs)) return { recent: [], older: [] };
  const n = Number.isInteger(keep) && keep >= 0 ? keep : 3;
  const sorted = jobs
    .map((job, i) => ({ job, i, t: recency(job) }))
    .sort((a, b) => (a.t === b.t ? a.i - b.i : a.t > b.t ? -1 : 1))
    .map((e) => e.job);
  return { recent: sorted.slice(0, n), older: sorted.slice(n) };
}

/**
 * Relative time like `5m ago`, or '' when `iso` is missing or unparsable. Never throws.
 * @param {unknown} iso
 * @param {number} [now]
 * @returns {string}
 */
export function ago(iso, now = Date.now()) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Number(now) - t) / 1000);
  if (Number.isNaN(s)) return '';
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * One entry per round: history first, then the current round once it has a gate or reviews.
 * @param {unknown} job a board.json job
 * @returns {object[]}
 */
export function roundsOf(job) {
  if (!isObject(job)) return [];
  const rows = (Array.isArray(job.history) ? job.history : []).filter(isObject);
  const reviews = isObject(job.reviews) ? job.reviews : {};
  if (job.round >= 1 && (job.gate || Object.keys(reviews).length)) {
    rows.push({ gate: job.gate, reviews, ...(isObject(job.carried) && Object.keys(job.carried).length ? { carried: job.carried } : {}) });
  }
  return rows;
}

/** Collapsed "+N older" group of one-line rows that open the drawer. Every value is escaped. */
export function olderMergedHtml(jobs, label, open, now = Date.now(), text = COST_TEXT_EN) {
  if (!Array.isArray(jobs) || !jobs.length) return '';
  const rows = jobs.map((j) => {
    const title = esc(j?.title || j?.id);
    const rounds = roundsOf(j);
    const meta = (rounds.length ? `<span class="n">R${rounds.length}</span>${roundChipsHtml(rounds[rounds.length - 1])}` : '') +
      `<span class="cost-time">${costTimeHtml(j, now, text)}</span><span class="when">${esc(ago(j?.updated, now))}</span>`;
    return `<li><button type="button" class="row" data-id="${esc(j?.id)}" title="${title}">` +
      `<span class="id">${esc(j?.id)}</span> <span class="row-title">${title}</span>` +
      `<span class="row-meta" aria-hidden="true">${meta}</span></button></li>`;
  }).join('');
  return `<details class="older"${open ? ' open' : ''}><summary>${esc(label)}</summary><ul class="rows">${rows}</ul></details>`;
}
