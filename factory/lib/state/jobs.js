// The factory's jobs as people ask about them: one view per job, read from factory/jobs/<id>/job.json and the
// round files beside it. Read-only and local: nothing here writes, runs git or calls GitHub.
// Shared by `eminzo mcp` (Ask Eminzo); job.js stays the only writer of job.json.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { costAvailable } from '../../activity.js';
import { buildGraph } from '../job.js';
import { compareJobIds } from '../lessons.js';
import { JOB_ID, readText } from '../util.js';

/** Stage → group (active, parked, terminal), from the pipeline graph: the one table of stages. */
export const STAGE_GROUPS = Object.freeze(Object.fromEntries(buildGraph().stages.map((s) => [s.id, s.group])));
export const STAGE_NAMES = Object.freeze(Object.keys(STAGE_GROUPS));
export const GROUPS = Object.freeze(['active', 'parked', 'terminal']);

/** What a person has to do for a job in each waiting stage. Every other stage waits for nobody. */
export const WAITING_KINDS = Object.freeze({
  'needs-human': 'decide', // escalated or stopped: a person approves, reworks or closes it
  'needs-info': 'answer', // intake asked a question on the issue
  'spec-review': 'approve-spec', // the spec waits for a developer's approval
  'awaiting-merge': 'merge', // approved, and auto_merge is off
});

const MINUTE = 60_000;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const time = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};
const minutesBetween = (from, to) => (from !== null && to !== null && to >= from ? Math.round(((to - from) / MINUTE) * 10) / 10 : null);
const intOrNull = (v) => (Number.isInteger(v) ? v : null);
const textOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Every readable job.json under factory/jobs, oldest id first. A broken or missing file is skipped. */
export function readJobs(root) {
  const dir = join(root, 'factory/jobs');
  if (!existsSync(dir)) return [];
  const jobs = [];
  for (const name of readdirSync(dir).filter((n) => JOB_ID.test(n)).sort(compareJobIds)) {
    const text = readText(join(dir, name, 'job.json'));
    if (text === null) continue;
    try {
      const job = JSON.parse(text);
      if (isObject(job)) jobs.push({ ...job, id: name });
    } catch { /* a broken job.json stays out, as on the board */ }
  }
  return jobs;
}

/** What a person must do for this job right now, or null. */
export function waitingFor(job) {
  const kind = WAITING_KINDS[job.stage];
  if (!kind) return null;
  return { kind, reason: textOrNull(job.note), since: job.updated ?? null };
}

/**
 * The view of one job a question is answered from: identity, where it is, what it waits for, how long it took
 * and what it cost. Pure: reads only the job object. Times are ISO strings; minutes are rounded to 0.1.
 */
export function jobView(job, now = Date.now()) {
  const started = time(job.started);
  const entered = time(job.approve_entered);
  const finished = time(job.finished);
  const intake = isObject(job.intake) ? job.intake : {};
  return {
    id: job.id,
    issue: intOrNull(job.issue),
    title: textOrNull(job.title),
    pr: intOrNull(job.pr),
    stage: textOrNull(job.stage),
    group: STAGE_GROUPS[job.stage] ?? null,
    lane: job.lane === 'xs' ? 'xs' : 'normal',
    size: textOrNull(intake.size),
    risk: textOrNull(intake.risk),
    surfaces: Array.isArray(intake.surfaces) ? intake.surfaces.filter((s) => typeof s === 'string') : [],
    provider: textOrNull(job.provider),
    round: intOrNull(job.round) ?? 1,
    max_rounds: intOrNull(job.max_rounds),
    gate: textOrNull(job.gate),
    reviews: isObject(job.reviews) ? job.reviews : {},
    decision: textOrNull(job.decision),
    note: textOrNull(job.note),
    waiting: waitingFor(job),
    started: job.started ?? null,
    approve_entered: job.approve_entered ?? null,
    finished: job.finished ?? null,
    updated: job.updated ?? null,
    minutes: {
      until_approval: minutesBetween(started, entered),
      after_approval: minutesBetween(entered, finished),
      total: minutesBetween(started, finished ?? now),
    },
    cost_usd: costAvailable(job) ? Math.round(job.cost_usd * 100) / 100 : null,
  };
}

/** The job a reference names: a job id (`161-fix-login`) or an issue number (`161`, `#161`). Null when none. */
export function findJob(jobs, ref) {
  const text = String(ref ?? '').trim();
  if (JOB_ID.test(text)) return jobs.find((j) => j.id === text) ?? null;
  const issue = text.match(/^#?(\d+)$/)?.[1];
  if (!issue) return null;
  const matches = jobs.filter((j) => j.issue === Number(issue));
  return matches.length ? matches[matches.length - 1] : null;
}

/** The first line of a file, or null. */
function headLine(file) {
  const text = readText(file);
  return text === null ? null : text.replace(/^﻿/, '').split(/\r?\n/, 1)[0];
}

/** The first plain sentence after a report's machine lines (status, KEY: value lines), or null. */
function reportSentence(text) {
  if (text === null) return null;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).slice(1);
  const line = lines.find((l) => l.trim() && !/^[A-Z][A-Z _-]*:\s/.test(l) && !/^[#|>-]/.test(l.trim()));
  return line ? line.trim().slice(0, 300) : null;
}

const countBlockers = (text) => (text === null ? 0 : (text.match(/^\s*[-*]?\s*\[blocker\]/gim) ?? []).length);

/** One round as its files tell it: the gate result and each lens's verdict with its number of blockers. */
function roundFiles(folder) {
  if (!existsSync(folder)) return { gate: null, gate_summary: null, reviews: {} };
  const checks = readText(join(folder, 'checks.md'));
  const gate = checks === null ? null : (checks.match(/^GATE: (PASS|FAIL)\b/)?.[1] ?? null);
  const reviews = {};
  for (const name of readdirSync(folder).sort()) {
    const lens = name.match(/^review-([a-z][\w-]*)\.md$/)?.[1];
    if (!lens) continue;
    const text = readText(join(folder, name));
    const verdict = text?.match(/^VERDICT: (PASS|CHANGES)\b/)?.[1] ?? null;
    reviews[lens] = { verdict, blockers: countBlockers(text) };
  }
  return { gate, gate_summary: reportSentence(checks), reviews };
}

/** Why round `n` (n >= 2) ran, from what round n-1 left behind. */
export function roundReason(previous) {
  if (!previous) return null;
  const reasons = [];
  if (previous.gate === 'FAIL') reasons.push('gate failed');
  const changes = Object.entries(previous.reviews ?? {}).filter(([, v]) => (isObject(v) ? v.verdict : v) === 'CHANGES').map(([lens]) => lens);
  if (changes.includes('human')) reasons.push('changes requested on the pull request');
  const lenses = changes.filter((lens) => lens !== 'human');
  if (lenses.length) reasons.push(`changes requested by review: ${lenses.join(', ')}`);
  return reasons.length ? reasons.join('; ') : 'not recorded';
}

/**
 * Everything one job's folder says, for "why is this job in round 3" and "what did security find":
 * the view, one entry per round (gate, reviews, why it ran), the decision and the cost per agent role.
 */
export function jobDetail(root, job, now = Date.now()) {
  const folder = join(root, 'factory/jobs', job.id);
  const view = jobView(job, now);
  const history = Array.isArray(job.history) ? job.history : [];
  const rounds = [];
  for (let n = 1; n <= view.round; n += 1) {
    const files = roundFiles(join(folder, `round-${n}`));
    const recorded = n <= history.length ? history[n - 1] : n === view.round ? { gate: job.gate, reviews: job.reviews } : null;
    const reviews = { ...files.reviews };
    for (const [lens, verdict] of Object.entries(isObject(recorded?.reviews) ? recorded.reviews : {})) {
      if (!reviews[lens] && typeof verdict === 'string') reviews[lens] = { verdict, blockers: null };
    }
    rounds.push({
      round: n,
      reason: n === 1 ? 'first build' : roundReason(rounds[n - 2]),
      gate: files.gate ?? textOrNull(recorded?.gate),
      gate_summary: files.gate_summary,
      reviews,
    });
  }
  const decisionText = readText(join(folder, 'decision.md'));
  const [decisionLine = '', reasonLine = ''] = decisionText === null ? [] : decisionText.replace(/^﻿/, '').split(/\r?\n/);
  const intakeLine = headLine(join(folder, 'intake.md'));
  const byRole = isObject(job.cost_by_agent?.by_role) ? job.cost_by_agent.by_role : {};
  return {
    ...view,
    intake: { decision: intakeLine?.match(/^(ACCEPT|NEEDS-INFO|REJECT)\b/)?.[1] ?? textOrNull(job.intake?.decision), rescoped: job.intake?.rescoped === true },
    rounds,
    extra_rounds: Math.max(0, view.round - 1),
    approval: decisionText === null ? null : {
      decision: decisionLine.match(/^(APPROVE|ESCALATE)\b/)?.[1] ?? null,
      reason: textOrNull(reasonLine)?.slice(0, 400) ?? null,
    },
    cost_by_role: Object.fromEntries(Object.entries(byRole)
      .filter(([, v]) => Number.isFinite(v))
      .map(([role, v]) => [role.replace(/^eminzo-/, ''), Math.round(v * 100) / 100])),
    files: existsSync(folder) ? readdirSync(folder).filter((n) => !n.startsWith('.') && !n.endsWith('.tmp')).sort() : [],
  };
}
