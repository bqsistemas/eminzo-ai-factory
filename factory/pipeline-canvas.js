import { roundsOf, costAvailable, costLabel, formatDuration } from './activity.js';
import { avatarSvg } from './avatars.js';

export const CANVAS_STAGES = Object.freeze([
  ['intake', 'Intake'], ['spec', 'Spec'], ['build', 'Build'], ['gate', 'Gate'],
  ['review', 'Review'], ['approve', 'Approve'], ['merge', 'Merge'],
].map(([key, label]) => Object.freeze({ key, label })));

const SOURCE_STAGE = Object.freeze({
  'needs-info': 'intake', 'spec-review': 'spec', 'awaiting-merge': 'merge', 'merging': 'merge',
  'needs-human': 'needs-human', merged: 'merge',
});
const STAGE_AGENTS = Object.freeze({ intake: 'intake', spec: 'spec-writer', build: 'builder', gate: 'builder', review: 'reviewers', approve: 'approver', merge: 'approver' });
const REVIEWERS = Object.freeze(['security', 'ux', 'ui', 'code']);
const STAGE_ROLES = Object.freeze({
  intake: ['intake'], spec: ['spec-writer'], build: ['builder'], gate: [],
  review: REVIEWERS.map((lens) => `review-${lens}`), approve: ['approver'], merge: ['approver'],
});
const DASH = 'Not available';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value) => Number.isFinite(value) && value >= 0;
const display = (value) => typeof value === 'string' && value.trim() ? value : DASH;

function mappedStage(job) {
  const stage = typeof job?.stage === 'string' ? job.stage : '';
  if (stage === 'rejected') {
    if (job.intake?.decision === 'REJECT') return 'intake';
    const rounds = Array.isArray(job.history) ? job.history : [];
    const reviewEvidence = [...rounds.map((round) => round?.reviews), job.reviews]
      .filter((reviews) => isObject(reviews) && Object.keys(reviews).length > 0);
    if (reviewEvidence.length) {
      const latestReviews = reviewEvidence.at(-1);
      const routedReviewers = isObject(job.agents?.reviewers) ? Object.keys(job.agents.reviewers) : [];
      return routedReviewers.length > 0 && routedReviewers.every((name) => latestReviews[name] === 'PASS')
        ? 'approve'
        : 'review';
    }
    if (job.gate || rounds.some((round) => round?.gate)) return 'gate';
    if (job.pr || (number(job.round) && job.round > 0)) return 'build';
    if (job.intake?.decision === 'ACCEPT') return 'spec';
    return 'intake';
  }
  if (stage === 'needs-human') {
    const from = typeof job.parked_from === 'string' ? job.parked_from : '';
    const parkedStage = SOURCE_STAGE[from] || from;
    return CANVAS_STAGES.some((item) => item.key === parkedStage) ? parkedStage : 'needs-human';
  }
  const candidate = SOURCE_STAGE[stage] || stage;
  return CANVAS_STAGES.some((item) => item.key === candidate) ? candidate : 'intake';
}

// The XS lane (plan P0-6) has no spec-writer and its approver is a script, so those stages are
// drawn as skipped (dimmed), not pending. A promoted job runs the normal lane and skips nothing.
const XS_SKIPPED = Object.freeze(['spec', 'approve']);

/** `XS` for an XS job, `XS→normal` for one that was promoted, otherwise null. */
export function laneChip(job) {
  if (!isObject(job)) return null;
  if (job.lane === 'xs') return 'XS';
  return job.promoted_from === 'xs' ? 'XS→normal' : null;
}

export function derivePipeline(job) {
  const source = isObject(job) ? job : {};
  const actual = typeof source.stage === 'string' ? source.stage : '';
  const skipped = (item) => source.lane === 'xs' && XS_SKIPPED.includes(item.key);
  if (actual === 'merged') return CANVAS_STAGES.map((item) => ({ ...item, state: skipped(item) ? 'skipped' : 'complete' }));
  const key = mappedStage(source);
  const current = Math.max(0, CANVAS_STAGES.findIndex((item) => item.key === key));
  return CANVAS_STAGES.map((item, index) => ({
    ...item,
    state: skipped(item) ? 'skipped' : index < current ? 'complete' : index > current ? 'pending' :
      (actual === 'needs-human' || actual === 'needs-info' || actual === 'spec-review' || actual === 'rejected' ? 'blocked' : 'active'),
  }));
}

/** Stages that no longer wait: complete, or skipped by the lane. */
const passedOver = (pipeline) => pipeline.filter((item) => item.state === 'complete' || item.state === 'skipped').length;

/** "role $x.xx, ..." for the roles of one stage, or null when job.cost_by_agent has nothing for it. */
function agentCost(job, stageKey) {
  if (!costAvailable(job) || !isObject(job.cost_by_agent) || !isObject(job.cost_by_agent.by_role)) return null;
  const byRole = job.cost_by_agent.by_role;
  const parts = (STAGE_ROLES[stageKey] || [])
    .filter((role) => Object.hasOwn(byRole, role) && Number.isFinite(byRole[role]) && byRole[role] >= 0)
    .map((role) => `${role.replace(/^review-/, '')} $${byRole[role].toFixed(2)}`);
  return parts.length ? parts.join(', ') : null;
}

/** "checks 3.0 · waits 2.0 · git 0.5 · other 0.2 min" from job.time_by_kind (job <id> profile), or null. */
export function builderTime(job, text) {
  const t = isObject(job) && isObject(job.time_by_kind) ? job.time_by_kind : null;
  if (!t) return null;
  const parts = [['check', text?.timeCheck || 'checks'], ['wait', text?.timeWait || 'waits'], ['git', text?.timeGit || 'git'], ['other', text?.timeOther || 'other']]
    .filter(([k]) => Number.isFinite(t[k]) && t[k] > 0) // a kind with no time is left out
    .map(([k, label]) => `${label} ${t[k].toFixed(1)}`);
  return parts.length ? `${parts.join(' · ')} ${text?.timeUnit || 'min'}` : null;
}

export function stageDetails(job, stageKey, now = Date.now(), text) {
  const source = isObject(job) ? job : {};
  const selected = CANVAS_STAGES.find((item) => item.key === stageKey) || CANVAS_STAGES[0];
  const pipeline = derivePipeline(source);
  const current = pipeline.find((item) => item.key === selected.key);
  const completed = passedOver(pipeline);
  const start = typeof source.started === 'string' ? Date.parse(source.started) : NaN;
  const end = typeof source.finished === 'string' ? Date.parse(source.finished) : NaN;
  const elapsed = Number.isFinite(start) && Number.isFinite(end) && end >= start ? `${Math.floor((end - start) / 60000)}m` : DASH;
  const label = costLabel(source, text);
  const cost = label === '—' ? (text?.costUnavailable || 'Cost unavailable') : label;
  const issue = Number.isInteger(source.issue) && source.issue > 0 ? `#${source.issue}` : DASH;
  const pr = Number.isInteger(source.pr) && source.pr > 0 ? `#${source.pr}` : DASH;
  const agentKey = STAGE_AGENTS[selected.key];
  const agents = isObject(source.agents) ? source.agents : {};
  const models = isObject(source.models) ? source.models : {};
  const agent = agentKey === 'reviewers'
    ? REVIEWERS.filter((name) => Object.hasOwn(agents.reviewers || {}, name)).map((name) => `${name}: ${agents.reviewers[name]}`).join(', ')
    : display(models[agentKey] || agents[agentKey]);
  const reviewers = isObject(agents.reviewers)
    ? REVIEWERS.filter((name) => Object.hasOwn(agents.reviewers, name)).map((name) => `${name}: ${agents.reviewers[name]}`).join(', ') || DASH
    : DASH;
  return {
    key: selected.key, label: selected.label, status: current.state[0].toUpperCase() + current.state.slice(1),
    issue, title: display(source.title), provider: display(source.provider), stage: display(source.stage), progress: `${completed}/${CANVAS_STAGES.length} stages`,
    duration: elapsed, cost, agentCost: agentCost(source, selected.key), builderTime: selected.key === 'build' ? builderTime(source, text) : null, agent, round: number(source.round) && source.round > 0 ? String(source.round) : DASH,
    reviewers, branch: display(source.branch), pr, note: display(source.note),
  };
}

export function bindPipelineControls({ jobSelect, canvas, getSelection, setSelection, render }) {
  const focusStage = (stage) => canvas.querySelector(`.pipeline-node[data-stage="${stage}"]`)?.focus();
  jobSelect.addEventListener('change', (event) => {
    const selection = getSelection();
    setSelection({ ...selection, jobId: event.target.value || null });
    render();
    focusStage(getSelection().stage);
  });
  canvas.addEventListener('click', (event) => {
    const node = event.target.closest('.pipeline-node');
    if (!node) return;
    setSelection({ ...getSelection(), stage: node.dataset.stage });
    render();
    focusStage(getSelection().stage);
  });
}

export function artifactFiles(job) {
  const files = ['issue.md', 'intake.md', 'spec.md', 'build.md'];
  const rows = roundsOf(isObject(job) ? job : {}).slice(0, 50);
  rows.forEach((row, index) => {
    const round = index + 1;
    files.push(`round-${round}/checks.md`);
    const reviews = isObject(row.reviews) ? row.reviews : {};
    REVIEWERS.filter((name) => Object.hasOwn(reviews, name)).forEach((name) => files.push(`round-${round}/review-${name}.md`));
  });
  return [...files, 'decision.md', 'merge-checks.md'];
}

export function isSafeJobId(id) {
  return typeof id === 'string' && /^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

export function githubLinks(job, repo) {
  if (!isObject(job) || typeof repo !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo)) return [];
  const links = [];
  if (Number.isInteger(job.issue) && job.issue > 0) links.push({ label: `Issue #${job.issue}`, href: `${repo}/issues/${job.issue}` });
  if (Number.isInteger(job.pr) && job.pr > 0) links.push({ label: `PR #${job.pr}`, href: `${repo}/pull/${job.pr}` });
  return links;
}

export function branchLink(job, repo) {
  if (!isObject(job) || typeof job.branch !== 'string' || !/^factory\/[a-zA-Z0-9][\w.-]{0,99}$/.test(job.branch) ||
      typeof repo !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return { label: job.branch, href: `${repo}/tree/${encodeURIComponent(job.branch)}` };
}

export const STAGE_AVATARS = Object.freeze({
  intake: 'intake', spec: 'spec-writer', build: 'builder', gate: 'builder', approve: 'approver', merge: 'approver',
});

const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const pascal = (value) => String(value).split('-').filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
const STATE_GLYPH = Object.freeze({ complete: '✓', active: '●', blocked: '!', pending: '○', skipped: '–' });

export function stageAvatars(job, stageKey) {
  if (stageKey === 'review') {
    const routed = isObject(job) && isObject(job.agents) && isObject(job.agents.reviewers) ? job.agents.reviewers : {};
    const names = REVIEWERS.filter((name) => Object.hasOwn(routed, name)).map((name) => `review-${name}`);
    return names.length ? names : ['review-code'];
  }
  return typeof stageKey === 'string' && Object.hasOwn(STAGE_AVATARS, stageKey) ? [STAGE_AVATARS[stageKey]] : [];
}

export function taskDuration(job, now = Date.now()) {
  const source = isObject(job) ? job : {};
  const start = typeof source.started === 'string' ? Date.parse(source.started) : NaN;
  const end = source.finished == null ? now : typeof source.finished === 'string' ? Date.parse(source.finished) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? formatDuration(end - start) : DASH;
}

export function stageCardsHtml(job, selectedStage, text = {}) {
  const t = isObject(text) ? text : {};
  return derivePipeline(job).map((stage, index) => {
    const label = t[`stage${pascal(stage.key)}`] || stage.label;
    const state = t[`pipeline${pascal(stage.state)}`] || pascal(stage.state);
    const avatars = stageAvatars(job, stage.key).map((name) => avatarSvg(name)).join('');
    const arrow = index > 0 ? `<span class="pipeline-arrow" data-stage="${stage.key}" aria-hidden="true"></span>` : '';
    return `${arrow}<button type="button" class="pipeline-node" data-visual-check data-stage="${stage.key}" data-state="${stage.state}" aria-pressed="${stage.key === selectedStage}" aria-label="${escapeHTML(label)}: ${escapeHTML(state)}">` +
      `<span class="pipeline-node-body"><span class="pipeline-avatar" aria-hidden="true">${avatars}</span>` +
      `<span class="pipeline-node-label">${escapeHTML(label)}</span>` +
      `<span class="pipeline-badge" data-state="${stage.state}"><span aria-hidden="true">${STATE_GLYPH[stage.state]}</span> <span class="pipeline-node-state">${escapeHTML(state)}</span></span></span></button>`;
  }).join('');
}

const jobOrderKey = (job) => {
  const prefix = typeof job?.id === 'string' ? job.id.match(/^(\d+)-/) : null;
  if (prefix) return parseInt(prefix[1], 10);
  return Number.isInteger(job?.issue) && job.issue > 0 ? job.issue : -Infinity;
};

export function jobsNewestFirst(jobs) {
  if (!Array.isArray(jobs)) return [];
  return jobs.map((job, index) => ({ job, index, key: jobOrderKey(job) }))
    .sort((a, b) => (b.key === a.key ? a.index - b.index : b.key > a.key ? 1 : -1))
    .map(({ job }) => job);
}

export function pickJobId(jobs, currentId) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (list.some((job) => job?.id === currentId)) return currentId;
  return jobsNewestFirst(list)[0]?.id ?? null;
}

export function taskHeaderHtml(job, { repo, now = Date.now(), text = {} } = {}) {
  const source = isObject(job) ? job : {};
  const t = isObject(text) ? text : {};
  const chip = (value, attrs = '') => `<span class="pipeline-chip"${attrs}>${escapeHTML(value)}</span>`;
  const issue = Number.isInteger(source.issue) && source.issue > 0
    ? `<span class="pipeline-issue-number">#${source.issue}</span> ` : '';
  const title = display(source.title) === DASH ? source.id : source.title;
  const chips = [];
  const lane = laneChip(source);
  if (lane) chips.push(chip(lane));
  if (Number.isInteger(source.round) && source.round > 0) chips.push(chip(`R${source.round}`));
  if (typeof source.stage === 'string' && source.stage) chips.push(chip(t[`pipelineStage${pascal(source.stage)}`] || source.stage));
  const duration = taskDuration(source, now);
  if (duration !== DASH) chips.push(chip(`${t.pipelineTotalDuration || 'Total duration'} ${duration}`));
  if (typeof source.branch === 'string' && source.branch) {
    chips.push(chip(`${source.branch}${Number.isInteger(source.pr) && source.pr > 0 ? ` · PR #${source.pr}` : ''}`));
  }
  if (typeof source.provider === 'string' && source.provider) chips.push(chip(source.provider));
  const pipeline = derivePipeline(source);
  const done = passedOver(pipeline);
  const percent = Math.round((done / CANVAS_STAGES.length) * 100);
  const links = githubLinks(source, repo);
  const target = links.at(-1);
  const progress = `<span class="pipeline-progress"><progress max="100" value="${percent}" aria-label="${escapeHTML(t.pipelineProgress || 'Progress')}"></progress>${escapeHTML(`${done}/${CANVAS_STAGES.length} ${t.pipelineStagesSuffix || 'stages'}`)}</span>`;
  const github = target ? `<a class="pipeline-github" href="${escapeHTML(target.href)}" target="_blank" rel="noopener">${escapeHTML(t.pipelineOpenGithub || 'Open on GitHub')}</a>` : '';
  const fullTitle = `${Number.isInteger(source.issue) && source.issue > 0 ? `#${source.issue} ` : ''}${title ?? ''}`;
  return `<h3 class="pipeline-task-title" title="${escapeHTML(fullTitle)}">${issue}${escapeHTML(title ?? '')}</h3>` +
    `<div class="pipeline-task-meta">${chips.join('')}${progress}${github}</div>`;
}
