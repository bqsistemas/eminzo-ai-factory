// The dashboard's module: renders board.json into factory/dashboard.html.
import {
  STAGE_COLUMNS, activeAgents, ago, agentsHtml, costTimeHtml, laneTone, linksHtml, olderMergedHtml, roundChipsHtml,
  roundsOf, splitMerged,
} from './activity.js';
import { costStatParts, formatCost, headerStats } from './office.js';
import { hasMetrics, renderMetricsTable } from './metrics-table.js';
import { createOffice } from './office-renderer.js';
import { CANVAS_STAGES, artifactFiles, bindPipelineControls, branchLink, derivePipeline, githubLinks, isSafeJobId, jobsNewestFirst, laneChip, pickJobId, stageCardsHtml, stageDetails, taskDuration, taskHeaderHtml } from './pipeline-canvas.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const BASE = DEMO ? 'demo/' : '';
const REVIEWERS = ['security', 'ux', 'ui', 'code'];
const ALERT = new Set(['needs-human', 'needs-info']);
const DONE = new Set(['merged', 'rejected']);

const I18N = JSON.parse(document.getElementById('i18n').textContent);
let board = { jobs: [] }, loaded = false, lastText = '', openJob = null, openFile = null, olderOpen = false;
let selectedJobId = null, selectedStage = 'intake';
const cache = new Map();
// Board data only selects a dictionary key; it is never interpolated as markup.
let T = I18N.en;
function setLanguage() {
  const lang = Object.hasOwn(I18N, board.language) ? board.language : 'en';
  T = I18N[lang];
  document.documentElement.lang = lang;
  // Guide texts with a dictionary key; textContent only, so a translation is never parsed as markup.
  for (const node of document.querySelectorAll('#guide-commands [data-i18n]')) {
    const key = node.dataset.i18n;
    if (Object.hasOwn(T, key)) node.textContent = T[key];
  }
  syncToggle();
}
// Label names the action; the icon shows the theme you would switch to.
function syncToggle() {
  const light = window.factoryTheme?.current() === 'light';
  const label = light ? T.themeToNavy : T.themeToLight;
  const btn = document.getElementById('theme-toggle');
  btn.setAttribute('aria-label', label);
  btn.title = label;
  document.getElementById('theme-icon').textContent = light ? '☾' : '☀';
}
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function card(job) {
  const alert = job.stage === 'needs-human';
  const running = activeAgents(job).length > 0;
  const rows = roundsOf(job).map((r, i) =>
    `<div class="round"><span class="n">R${i + 1}</span>${roundChipsHtml(r)}</div>`).join('');
  const issue = Number.isInteger(job.issue) && job.issue > 0 ? job.issue : '';
  return `<article class="card ${alert ? 'alert' : ''} ${DONE.has(job.stage) ? 'merged' : ''} ${running ? 'running' : ''}" data-id="${esc(job.id)}">
    <div class="card-top">
      <button class="open" data-id="${esc(job.id)}" aria-label="Open ${esc(job.id)}">
        <span class="id">${esc(job.id)}${laneChip(job) ? `<span class="lane-chip">${esc(laneChip(job))}</span>` : ''}</span>
        <span class="title">${esc(job.title || job.id)}</span>
      </button>
      ${job.stage === 'merged' ? '<span class="done-check" aria-hidden="true"></span>' : ''}
    </div>
    ${linksHtml(job, board.repo)}
    ${agentsHtml(job)}
    ${rows ? `<div class="rounds">${rows}</div>` : ''}
    ${job.note ? `<div class="note">${esc(job.note)}</div>` : ''}
    ${alert ? `<span class="hint">${job.pr ? T.hintNeedsHumanPr : T.hintNeedsHumanNoPr}</span>
      ${issue ? `<code class="cmd">/eminzo-factory rework ${esc(issue)}</code>` : ''}` : ''}
    ${job.stage === 'spec-review' ? `<span class="hint">${T.hintSpecReview}</span>
      ${issue ? `<code class="cmd">/eminzo-factory approve-spec ${esc(issue)}</code>
      <code class="cmd">/eminzo-factory revise-spec ${esc(issue)} &lt;notes&gt;</code>` : ''}` : ''}
    ${job.stage === 'awaiting-merge' ? `<span class="hint">${T.hintAwaitingMerge}</span>` : ''}
    ${job.stage === 'needs-info' && !job.note ? `<span class="hint">${T.hintNeedsInfo}</span>` : ''}
    <div class="meta"><span class="cost-time">${costTimeHtml(job, undefined, T)}</span>
      <span class="when">${job.round ? `round ${esc(job.round)}/${esc(job.max_rounds ?? 3)} · ` : ''}${ago(job.updated)}</span></div>
  </article>`;
}

// The metrics table: values come from board.metrics (numbers and lesson text); metrics-table.js sets text only.
function renderMetrics() {
  const m = board.metrics;
  const box = $('metrics');
  box.hidden = !hasMetrics(m);
  if (box.hidden) return;
  $('metrics-title').textContent = T.metricsTitle.replace('{n}', () => m.last);
  renderMetricsTable(document, $('metrics-table'), m, T);
}

function render() {
  setLanguage();
  renderMetrics();
  const jobs = board.jobs || [];
  selectedJobId = pickJobId(jobs, selectedJobId);
  renderPipeline();
  $('board').classList.toggle('empty-board', !jobs.length);
  if (!jobs.length) {
    $('board').innerHTML = `<div class="empty">${T.emptyBoard}
      ${DEMO ? '' : `<a class="empty-action" href="/__eminzo/go/terminal">${T.openTerminal}</a>`}
      ${DEMO ? '' : `<br><br>${T.demoLink}`}</div>`;
    return;
  }
  const known = new Set(STAGE_COLUMNS.map(s => s[0]));
  $('board').innerHTML = STAGE_COLUMNS.map(([key, label]) => {
    const list = jobs.filter(j => (known.has(j.stage) ? j.stage : 'intake') === key);
    let body = list.map(card).join('');
    if (key === 'merged') {
      const { recent, older } = splitMerged(list);
      body = recent.map(card).join('') + olderMergedHtml(older, T.olderMerged.replace('{n}', older.length), olderOpen, undefined, T);
    }
    return `<section class="col tone-${laneTone(key)} ${ALERT.has(key) && list.length ? 'alert' : ''} ${list.length ? '' : 'quiet'}" id="col-${esc(key)}" aria-label="${esc(label)}">
      <h2><span class="dot" aria-hidden="true"></span><span class="lane-title">${label}</span><span class="count">${list.length}</span></h2>
      ${list.length ? `<div class="lane">${body}</div>` : ''}</section>`;
  }).join('');
  const human = jobs.filter(j => j.stage === 'needs-human').length;
  const info = jobs.filter(j => j.stage === 'needs-info').length;
  const parked = $('parked');
  parked.hidden = !(human + info);
  parked.href = human ? '#col-needs-human' : '#col-needs-info';
  parked.textContent = [human && T.parkedHuman.replace('{n}', human).replace('{s}', human === 1 ? 's' : ''), info && T.parkedInfo.replace('{n}', info)]
    .filter(Boolean).join(' · ');
}

async function poll() {
  try {
    const res = await fetch(BASE + 'board.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 404 ? 'no board.json yet. Run /eminzo-factory run to create it' : `HTTP ${res.status}`);
    const text = await res.text();
    const status = $('status');
    status.className = 'status';
    if (text !== lastText) {
      board = JSON.parse(text);   // a half-written file throws and keeps the last good board
      lastText = text;
      render();
      loaded = true;
      renderStats();
      renderOffice();
      if (openJob) { cache.clear(); openDrawer(openJob, openFile); }
    }
    status.textContent = T.statusLive.replace('{ago}', ago(board.updated) || 'just now');
  } catch (err) {
    if (err instanceof SyntaxError && lastText) return;   // mid-write; try again next poll
    const status = $('status');
    status.className = 'status off';
    status.textContent = location.protocol === 'file:'
      ? 'serve this folder: factory/bin/dashboard'
      : String(err.message || err);
    if (!lastText) render();
  }
}

// --- drawer -----------------------------------------------------------------

function filesOf(job) {
  // Allowlisted Markdown artifacts: issue.md, intake.md, spec.md, plan.md, build.md, checks.md, reviews, decision.md, and merge-checks.md.
  return artifactFiles(job);
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderPipeline() {
  const jobs = Array.isArray(board.jobs) ? board.jobs : [];
  const selectedJob = jobs.find((job) => job.id === selectedJobId);
  $('pipeline-job-label').textContent = T.pipelineJob;
  $('pipeline-job').setAttribute('aria-label', T.pipelineJob);
  $('pipeline-canvas').setAttribute('aria-label', T.pipelineStages);
  const jobSelect = $('pipeline-job');
  jobSelect.innerHTML = jobsNewestFirst(jobs).map((job) => `<option value="${escapeHTML(job.id)}">${escapeHTML(job.title || job.id || 'Job')}</option>`).join('');
  jobSelect.disabled = jobs.length === 0;
  if (selectedJob) jobSelect.value = selectedJob.id;
  const stageLabel = (stage) => T[`stage${stage.key[0].toUpperCase()}${stage.key.slice(1)}`] || stage.label;
  const stateLabel = (state) => T[`pipeline${state[0].toUpperCase()}${state.slice(1)}`] || state;
  const taskHeader = $('pipeline-task-header');
  const stage = CANVAS_STAGES.some((s) => s.key === selectedStage) ? selectedStage : 'intake';
  const pipelinePanel = $('pipeline');
  const pipelineCanvas = $('pipeline-canvas');
  const inspector = $('pipeline-inspector');
  pipelinePanel.classList.toggle('is-empty', !selectedJob);
  taskHeader.hidden = !selectedJob;
  pipelineCanvas.hidden = !selectedJob;
  inspector.classList.toggle('pipeline-empty', !selectedJob);
  pipelineCanvas.innerHTML = stageCardsHtml(selectedJob, stage, T);
  if (!selectedJob) {
    taskHeader.innerHTML = `<h3 class="pipeline-task-title">${escapeHTML(T.pipelineNoJobs)}</h3>`;
    inspector.innerHTML = `<p class="pipeline-missing">${escapeHTML(T.pipelineNoJobs)}</p>`;
    return;
  }
  const details = stageDetails(selectedJob, stage, undefined, T);
  const localizedStatus = stateLabel(details.status.toLowerCase());
  const localizedProgress = details.progress.replace(/ stages$/, ` ${T.pipelineStagesSuffix}`).replace('Not available', T.pipelineUnavailable);
  const stageValueKey = `pipelineStage${details.stage.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}`;
  const stageValue = T[stageValueKey] || details.stage;
  taskHeader.innerHTML = taskHeaderHtml(selectedJob, { repo: board.repo, text: T });
  const fields = [[T.pipelineIssue, details.issue], [T.pipelineStage, stageValue], [T.pipelineStatus, localizedStatus], [T.pipelineProgress, localizedProgress],
    [T.pipelineTitle, details.title], [T.pipelineProvider, details.provider], [T.pipelineDuration, taskDuration(selectedJob)], [T.pipelineCost, details.cost], ...(details.agentCost ? [[T.pipelineAgentCost, details.agentCost]] : []), [T.pipelineAgent, details.agent], [T.pipelineRound, details.round],
    [T.pipelineReviewers, details.reviewers], [T.pipelineBranch, details.branch], [T.pipelinePr, details.pr], [T.pipelineNote, details.note]]
    .map(([label, value]) => [label, value === 'Not available' ? T.pipelineUnavailable : value]);
  const links = githubLinks(selectedJob, board.repo);
  const files = filesOf(selectedJob);
  const branch = branchLink(selectedJob, board.repo);
  inspector.dataset.jobId = selectedJob.id;
  const selectedStageDef = CANVAS_STAGES.find((stage) => stage.key === details.key) || CANVAS_STAGES[0];
  inspector.innerHTML = `<h3>${escapeHTML(T.pipelineJobDetails)} · ${escapeHTML(stageLabel(selectedStageDef))}</h3>
    <dl class="pipeline-fields">${fields.map(([label, value]) => `<div class="pipeline-field"><dt>${escapeHTML(label)}</dt><dd class="${value === T.pipelineUnavailable ? 'pipeline-missing' : ''}">${label === T.pipelineBranch && branch ? `<a href="${escapeHTML(branch.href)}" target="_blank" rel="noopener">${escapeHTML(branch.label)}</a>` : escapeHTML(value)}</dd></div>`).join('')}</dl>
    <div class="pipeline-links">${links.length ? links.map((link) => `<a href="${escapeHTML(link.href)}" target="_blank" rel="noopener">${escapeHTML(link.label)}</a>`).join('') : `<span class="pipeline-missing">${escapeHTML(T.pipelineGithubUnavailable)}</span>`}</div>
    <div class="pipeline-artifacts" aria-label="${escapeHTML(T.pipelineArtifacts)}">${files.map((artifact) => `<button type="button" class="pipeline-artifact" data-artifact="${escapeHTML(artifact)}" disabled aria-disabled="true"><span>${escapeHTML(artifact)}</span> <span class="artifact-status">${escapeHTML(T.pipelineChecking)}</span></button>`).join('')}</div>`;
  updatePipelineArtifacts(selectedJob, files);
}

async function updatePipelineArtifacts(job, files) {
  const results = await Promise.all(files.map((file) => load(job, file)));
  const inspector = $('pipeline-inspector');
  if (selectedJobId !== job.id || inspector.dataset.jobId !== job.id) return;
  inspector.querySelectorAll('[data-artifact]').forEach((button) => {
    const index = files.indexOf(button.dataset.artifact);
    const available = index >= 0 && results[index] !== null;
    button.disabled = !available;
    button.setAttribute('aria-disabled', String(!available));
    button.querySelector('.artifact-status').textContent = available ? T.pipelineAvailable : T.pipelineNotWritten;
    if (!available) button.classList.add('pipeline-missing');
  });
}

bindPipelineControls({
  jobSelect: $('pipeline-job'), canvas: $('pipeline-canvas'),
  getSelection: () => ({ jobId: selectedJobId, stage: selectedStage }),
  setSelection: ({ jobId, stage }) => { selectedJobId = jobId; selectedStage = stage; },
  render: renderPipeline,
});
$('pipeline-inspector').addEventListener('click', (event) => {
  const button = event.target.closest('[data-artifact]');
  if (!button || !selectedJobId) return;
  const selectedJob = (board.jobs || []).find((job) => job.id === selectedJobId);
  if (selectedJob && artifactFiles(selectedJob).includes(button.dataset.artifact)) openDrawer(selectedJob.id, button.dataset.artifact);
});

async function load(job, file) {
  if (!isSafeJobId(job?.id) || !filesOf(job).includes(file)) return null;
  const key = `${job.id}/${file}`;
  if (!cache.has(key)) {
    cache.set(key, fetch(`${BASE}jobs/${encodeURIComponent(job.id)}/${file}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.text() : null)).catch(() => null));
  }
  return cache.get(key);
}

let returnFocus = null;
let guideReturnFocus = null;

async function openDrawer(id, file) {
  const job = (board.jobs || []).find(j => j.id === id);
  if (!job) return closeDrawer();
  const opening = !$('drawer').classList.contains('open');
  if (opening) returnFocus = document.activeElement;
  openJob = id;
  $('d-id').textContent = `${job.id} · ${job.branch || ''} · ${job.stage}`;
  $('d-title').textContent = job.title || job.id;
  $('d-links').innerHTML = linksHtml(job, board.repo);
  $('d-summary').innerHTML = card(job);
  const files = filesOf(job);
  const texts = await Promise.all(files.map(f => load(job, f)));
  if (openJob !== id) return;
  const existing = files.filter((f, i) => texts[i] !== null);
  openFile = file && files.includes(file) ? file : existing[existing.length - 1] || files[0];
  $('files').innerHTML = files.map((f, i) =>
    `<button class="file ${texts[i] === null ? 'missing' : ''}" role="tab" data-file="${esc(f)}" aria-controls="doc"
      aria-selected="${f === openFile}" tabindex="${f === openFile ? 0 : -1}">${esc(f)}</button>`).join('');
  const text = texts[files.indexOf(openFile)];
  $('doc').innerHTML = text === null ? `<p class="missing-doc">${T.notWritten}</p>` : md(text);
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('scrim').classList.add('open');
  if (opening) $('close').focus();
}

function closeDrawer() {
  const wasOpen = $('drawer').classList.contains('open');
  openJob = openFile = null;
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').classList.remove('open');
  if (wasOpen && returnFocus && document.contains(returnFocus)) returnFocus.focus();
  returnFocus = null;
}

function openGuide() {
  if ($('guide').classList.contains('open')) return;
  if ($('drawer').classList.contains('open')) closeDrawer();
  guideReturnFocus = document.activeElement;
  $('guide').classList.add('open');
  $('guide').setAttribute('aria-hidden', 'false');
  $('guide-toggle').setAttribute('aria-expanded', 'true');
  $('scrim').classList.add('open');
  $('guide-close').focus();
}

function closeGuide() {
  const wasOpen = $('guide').classList.contains('open');
  $('guide').classList.remove('open');
  $('guide').setAttribute('aria-hidden', 'true');
  $('guide-toggle').setAttribute('aria-expanded', 'false');
  $('scrim').classList.remove('open');
  if (wasOpen && guideReturnFocus && document.contains(guideReturnFocus)) guideReturnFocus.focus();
  guideReturnFocus = null;
}

$('board').addEventListener('click', e => {
  if (e.target.closest('a')) return;   // issue and PR links open GitHub
  const c = e.target.closest('.card, .row');
  if (c) openDrawer(c.dataset.id);
});
// toggle does not bubble, so listen in the capture phase; keeps "+N older" open across polls.
$('board').addEventListener('toggle', e => {
  if (e.target.matches?.('details.older')) olderOpen = e.target.open;
}, true);
$('files').addEventListener('click', e => {
  const f = e.target.closest('.file');
  if (f) openDrawer(openJob, f.dataset.file);
});
$('files').addEventListener('keydown', async e => {   // arrow keys move between tabs
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tabs = [...$('files').querySelectorAll('.file')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].dataset.file;
  await openDrawer(openJob, next);
  $('files').querySelector(`[data-file="${CSS.escape(next)}"]`)?.focus();
});
$('close').addEventListener('click', closeDrawer);
$('guide-toggle').addEventListener('click', openGuide);
$('guide-close').addEventListener('click', closeGuide);
$('scrim').addEventListener('click', () => {
  if ($('guide').classList.contains('open')) closeGuide();
  else closeDrawer();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if ($('guide').classList.contains('open')) closeGuide();
  else closeDrawer();
});

// --- tiny markdown renderer (headings, lists, tables, code, quotes) ---------

const TONE = {
  PASS: 'good', APPROVE: 'good', READY: 'good', ACCEPT: 'good',
  CHANGES: 'warn', 'NEEDS-INFO': 'warn', ESCALATE: 'bad', BLOCKED: 'bad', FAIL: 'bad', REJECT: 'bad',
};

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) =>
      /^(https?:\/\/|#)/.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : m);
}

function table(rows) {
  const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const body = rows.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r)).map(cells);
  const [head, ...rest] = body;
  return `<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead>
    <tbody>${rest.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function md(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  const out = [];
  const LIST = /^\s*([-*]|\d+\.)\s+/;
  const START = /^(```|#{1,4}\s|\s*\||>|-{3,}\s*$)/;
  let i = 0;
  const first = (lines[0] || '').match(/^(?:(VERDICT|STATUS|GATE):\s*)?(PASS|FAIL|CHANGES|APPROVE|ESCALATE|READY|BLOCKED|ACCEPT|NEEDS-INFO|REJECT)(?![\w-])/);
  if (first) { out.push(`<span class="verdict ${TONE[first[2]]}">${esc(lines[0])}</span>`); i = 1; }
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (!l.trim()) { i++; continue; }
    if (/^```/.test(l)) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if ((m = l.match(/^(#{1,4})\s+(.*)/))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++;
    } else if (/^-{3,}\s*$/.test(l)) {
      out.push('<hr>'); i++;
    } else if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      out.push(table(rows));
    } else if (LIST.test(l)) {
      const tag = /^\s*\d+\./.test(l) ? 'ol' : 'ul', items = [];
      while (i < lines.length && LIST.test(lines[i])) items.push(lines[i++].replace(LIST, ''));
      out.push(`<${tag}>${items.map(t => `<li>${inline(t).replace(/^\[([ xX])\]\s/, (_, c) => (c === ' ' ? '☐ ' : '☑ '))}</li>`).join('')}</${tag}>`);
    } else if (/^>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
    } else {
      const buf = [l];
      for (i++; i < lines.length && lines[i].trim() && !START.test(lines[i]) && !LIST.test(lines[i]); i++) buf.push(lines[i]);
      out.push(`<p>${inline(buf.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}

// ---- header stats and the pixel-art Agent Office --------------------------------------
// Board data only reaches the canvas through fillText and the hotspots through
// setAttribute; nothing here is interpolated into markup.
function renderStats() {
  const s = headerStats(board.jobs);
  const costParts = costStatParts(s.cost, s.cost_unavailable, T);
  const tiles = { 'stat-jobs': [s.total, T.statJobs], 'stat-running': [s.running, T.statRunning],
    'stat-agents': [s.agents, T.statAgents], 'stat-cost': [costParts ? costParts.amount : s.cost_unavailable ? formatCost(s.cost, s.cost_unavailable, T) : formatCost(s.cost, s.cost_unavailable), T.statCost] };
  for (const [id, [value, label]] of Object.entries(tiles)) {
    const tile = $(id);
    tile.querySelector('.v').textContent = loaded ? String(value) : '–';
    tile.querySelector('.l').textContent = label;
  }
  const costTile = $('stat-cost');
  if (loaded && costParts) {
    // Keep the amount in the value and put the short suffix on the narrower label line.
    costTile.querySelector('.v').textContent = costParts.amount;
    costTile.querySelector('.l').textContent = `${T.statCost} · ${costParts.short}`;
    costTile.setAttribute('role', 'group');
    costTile.setAttribute('title', costParts.title);
    costTile.setAttribute('aria-label', costParts.label);
  } else {
    costTile.removeAttribute('role');
    costTile.removeAttribute('title');
    costTile.removeAttribute('aria-label');
  }
}

const officeView = createOffice({
  stage: $('office-stage'), canvas: $('office-canvas'), hits: $('office-hits'),
  live: $('office-live'), status: $('office-status'), openJob: (id) => openDrawer(id),
});
function renderOffice() { officeView.update(board.jobs); }
renderStats();
renderOffice();

$('theme-toggle').addEventListener('click', () => {
  window.factoryTheme?.set(window.factoryTheme.current() === 'light' ? 'navy' : 'light');
  syncToggle();
});
syncToggle();
$('demo').hidden = !DEMO;
poll();
setInterval(poll, 2000);
