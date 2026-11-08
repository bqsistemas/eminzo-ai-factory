// Pure projection of the existing board jobs. No independent lifecycle or persistence.
import { AGENTS, STAGE_COLUMNS, activeAgents, laneTone, costAvailable, COST_TEXT_EN } from './activity.js';
import { AREAS, MAP, WAYPOINTS, SEATS, LOUNGE_SPOTS, MEETING_SEATS, SHORT } from './office-map.js';
export { AREAS, MAP, WAYPOINTS, SEATS, LOUNGE_SPOTS, MEETING_SEATS, FURNITURE, WALL_H, PARTITION, DOOR_W, layoutOffice, officeBackdrop } from './office-map.js';
export { SPRITES, CHARACTER_FOR } from './sprite-atlas.js';
export { route } from './office-navigation.js';
const isObject=v=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const positiveInt=n=>Number.isInteger(n)&&n>0;
const inside=(r,p)=>p.x>=r.x&&p.x<r.x+r.w&&p.y>=r.y&&p.y<r.y+r.h;
const REVIEWERS=['review-security','review-ux','review-ui','review-code'];
const AREA_BY_ID=new Map(AREAS.map(a=>[a.id,a]));
const AREA_OF_STAGE=new Map(AREAS.flatMap(a=>a.stages.map(s=>[s,a.id])));
const KNOWN_STAGES=new Set(STAGE_COLUMNS.map(([s])=>s));
const RUNNING_STAGES=new Set(['intake','needs-info','spec','build','gate','review','approve','merging']);
const TOKEN_AREAS=AREAS.filter(a=>!['archive','lounge','escalation'].includes(a.id)).map(a=>a.id);
export const VERBS=Object.freeze({intake:'triaging','spec-writer':'writing spec',builder:'implementing','review-security':'reviewing','review-ux':'reviewing','review-ui':'reviewing','review-code':'reviewing',approver:'approving'});
export function areaForStage(stage){return AREA_OF_STAGE.get(stage)||'research';}
export function areaTone(id){const a=AREA_BY_ID.get(id);return a?.stages.length?laneTone(a.stages[0]):'neutral';}
const finiteCost = (j) => costAvailable(j) ? j.cost_usd : 0;

/** Header tiles: total jobs, running (intake through merging), active agents, total cost. */
export function headerStats(jobs) {
  if (!Array.isArray(jobs)) return { total: 0, running: 0, agents: 0, cost: 0 };
  let running = 0, agents = 0, cost = 0;
  for (const job of jobs) {
    if (isObject(job) && (!KNOWN_STAGES.has(job.stage) || RUNNING_STAGES.has(job.stage))) running++;
    agents += activeAgents(job).length;
    cost += finiteCost(job);
  }
  const unknown = jobs.filter((j) => j?.cost_status === 'unavailable' || (j?.provider === 'codex' && !costAvailable(j))).length;
  return { total: jobs.length, running, agents, cost, ...(unknown ? { cost_unavailable: unknown } : {}) };
}

/** Legacy numeric formatting, with an explicit indicator for unknown subtotals. */
export function formatCost(n, unavailable = 0, text = COST_TEXT_EN) {
  if (unavailable > 0) return n > 0
    ? `$${n.toFixed(2)} + ${(text.costUnavailableCount ?? COST_TEXT_EN.costUnavailableCount).replace('{n}', unavailable)}`
    : (text.costUnavailable ?? COST_TEXT_EN.costUnavailable);
  return `$${(typeof n === 'number' && Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

/** Compact header cost tile parts; null unless a positive cost and unavailable count exist. */
export function costStatParts(n, unavailable, text = {}) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  if (!Number.isInteger(unavailable) || unavailable <= 0) return null;
  const fill = (t) => t.replace('{n}', unavailable);
  const amount = `$${n.toFixed(2)}`;
  const title = unavailable === 1
    ? (text.costUnavailableTitleOne ?? '1 job with unavailable cost')
    : fill(text.costUnavailableTitle ?? '{n} jobs with unavailable cost');
  const short = fill(text.costUnavailableShort ?? '{n} N/A');
  return { value: `${amount} + ${short}`, amount, short, title, label: `${amount} + ${title}` };
}

/** Bubble text for an agent given its work items `{ issue, round }`. Unknown agents give ''. */
export function bubbleText(agent, work) {
  if (typeof agent !== 'string' || !Object.hasOwn(AGENTS, agent)) return '';
  const label = SHORT[agent];
  const list = Array.isArray(work) ? work.filter(isObject) : [];
  if (!list.length) return label;
  if (list.length > 1) return `${label} · ×${list.length} · ${VERBS[agent]}`;
  const { issue, round } = list[0];
  const parts = [label];
  if (positiveInt(issue)) parts.push(`#${issue}`);
  if (positiveInt(round)) parts.push(`R${round}`);
  parts.push(VERBS[agent]);
  return parts.join(' · ');
}

const time = (s) => { const t = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isNaN(t) ? Infinity : t; };

// Valid jobs, oldest first (by `started`, then id), with the fields the office needs.
function prepare(jobs) {
  if (!Array.isArray(jobs)) return [];
  const seen = new Set();
  return jobs
    .map((job, i) => {
      if (!isObject(job)) return null;
      const jobId = typeof job.id === 'string' && job.id ? job.id : `job-${i}`;
      if (seen.has(jobId)) return null;
      seen.add(jobId);
      return { job, jobId, i };
    })
    .filter(Boolean)
    .map(({ job, jobId, i }) => ({
      job, jobId, i,
      stage: KNOWN_STAGES.has(job.stage) ? job.stage : 'intake',
      issue: positiveInt(job.issue) ? job.issue : null,
      round: positiveInt(job.round) ? job.round : null,
      started: time(job.started),
    }))
    .sort((a, b) => (a.started !== b.started ? (a.started < b.started ? -1 : 1) : a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : a.i - b.i));
}

const tokenOf = (p) => ({ jobId: p.jobId, stage: p.stage, round: p.round, label: (p.issue ? `#${p.issue}` : p.jobId) + (p.round ? ` R${p.round}` : '') });

/** Full office state from board jobs. See the job spec for the shape. */
export function officeState(jobs) {
  const prepared = prepare(jobs);
  const work = Object.fromEntries(Object.keys(AGENTS).map((a) => [a, []]));
  let meeting = null;
  for (const p of prepared) {
    const active = activeAgents(p.job);
    for (const a of active) work[a].push({ jobId: p.jobId, issue: p.issue, round: p.round });
    if (!meeting && active.length >= 2 && active.every((a) => REVIEWERS.includes(a))) {
      meeting = { jobId: p.jobId, issue: p.issue, members: active };
    }
  }
  const agents = {};
  for (const a of Object.keys(AGENTS)) {
    const w = work[a];
    let place = 'lounge', node = LOUNGE_SPOTS[a], area = 'lounge';
    if (w.length) {
      const inMeeting = meeting && meeting.members.includes(a);
      place = inMeeting ? 'meeting' : 'seat';
      node = inMeeting ? MEETING_SEATS[a] : SEATS[a];
      area = AREAS.find((r) => r.id !== 'lounge' && node in WAYPOINTS.nodes && inside(r.rect, WAYPOINTS.nodes[node])).id;
    }
    agents[a] = { place, node, area, work: w, bubble: bubbleText(a, w) };
  }
  const tokens = Object.fromEntries(TOKEN_AREAS.map((id) => [id, []]));
  const escalation = [];
  const archive = { merged: 0, rejected: 0 };
  for (const p of prepared) {
    if (p.stage === 'merged') archive.merged++;
    else if (p.stage === 'rejected') archive.rejected++;
    else if (p.stage === 'needs-human') escalation.push(tokenOf(p));
    else tokens[areaForStage(p.stage)].push(tokenOf(p));
  }
  return { agents, meeting, tokens, escalation, archive, gate: gateState(prepared), merging: { status: prepared.some(p=>p.stage==='merging') ? 'merging' : 'idle', waiting: prepared.filter(p=>p.stage==='awaiting-merge').length } };
}

function gateState(prepared) {
  const lit=prepared.some(p=>p.stage==='gate');
  let result=null,best=-Infinity;
  for(const p of prepared) {
    if(p.stage==='merged'||p.stage==='rejected')continue;
    const history=Array.isArray(p.job.history)?p.job.history:[];
    const verdict=['PASS','FAIL'].includes(p.job.gate)?p.job.gate:history.filter(h=>isObject(h)&&['PASS','FAIL'].includes(h.gate)).at(-1)?.gate;
    if(!verdict)continue;
    const parsed=Date.parse(p.job.updated),t=Number.isNaN(parsed)?-Infinity:parsed;
    if(result===null||t>best){result=verdict;best=t;}
  }
  return {lit,result,status:lit?'running':result||'idle'};
}

/** One entry per clickable thing: agents with work, tokens, and areas with jobs. Each opens a job. */
export function hitTargets(state, jobs) {
  const out = [];
  const lbl = (n) => (positiveInt(n) ? `#${n}` : 'job');
  if (isObject(state) && isObject(state.agents)) {
    for (const a of Object.keys(AGENTS)) {
      const w = state.agents[a]?.work;
      if (Array.isArray(w) && w.length) {
        out.push({ kind: 'agent', key: a, jobId: w[0].jobId, label: `${AGENTS[a].label}, ${lbl(w[0].issue)}, open job` });
      }
    }
  }
  const prepared = prepare(jobs);
  const byId = new Map(prepared.map((p) => [p.jobId, p]));
  const tokenLists = [...TOKEN_AREAS.map((id) => state?.tokens?.[id]), state?.escalation];
  for (const list of tokenLists) {
    if (!Array.isArray(list)) continue;
    for (const t of list) out.push({ kind: 'token', key: t.jobId, jobId: t.jobId, label: `${lbl(byId.get(t.jobId)?.issue)}, open job` });
  }
  const oldest = new Map();
  for (const p of prepared) {
    const id = areaForStage(p.stage);
    if (!oldest.has(id)) oldest.set(id, p);
  }
  for (const area of AREAS) {
    const p = oldest.get(area.id);
    if (p) out.push({ kind: 'area', key: area.id, jobId: p.jobId, label: `${area.label}, ${lbl(p.issue)}, open oldest job` });
  }
  const oldestStage=new Map();
  for(const p of prepared) if(!oldestStage.has(p.stage))oldestStage.set(p.stage,p);
  for(const [stage,p] of oldestStage) if(!['merged','rejected'].includes(stage))out.push({kind:'stage',key:stage,jobId:p.jobId,label:`${stage}, ${lbl(p.issue)}, open oldest job`});
  return out;
}

/** Plain-text lines describing the office, for a screen-reader live region. */
export function describeOffice(state) {
  const lines = [];
  if (!isObject(state) || !isObject(state.agents)) return lines;
  for (const a of Object.keys(AGENTS)) {
    const s = state.agents[a];
    if (!s) continue;
    const area = AREA_BY_ID.get(s.area)?.label ?? 'Lounge';
    const w = Array.isArray(s.work) ? s.work : [];
    const items = w.map((x) => [positiveInt(x.issue) && `#${x.issue}`, positiveInt(x.round) && `R${x.round}`].filter(Boolean).join(' ')).filter(Boolean);
    lines.push(`${AGENTS[a].label} in ${area}: ${w.length ? `${items.join(', ')} ${VERBS[a]}`.trim() : 'idle'}`);
  }
  if (state.meeting) {
    const names = (state.meeting.members || []).filter((m) => Object.hasOwn(AGENTS, m)).map((m) => AGENTS[m].label);
    lines.push(`Review meeting${positiveInt(state.meeting.issue) ? ` for #${state.meeting.issue}` : ''}: ${names.join(', ')}`);
  }
  if (state.escalation?.length) lines.push(`Escalation: ${state.escalation.map((t) => t.label).join(', ')}`);
  if (state.archive && (state.archive.merged || state.archive.rejected)) {
    lines.push(`Archive: ${state.archive.merged} merged, ${state.archive.rejected} rejected`);
  }
  return lines;
}
