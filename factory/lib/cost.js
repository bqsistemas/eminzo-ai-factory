// Per-job cost from Claude Code subagent transcripts (JSONL). A transcript belongs
// to a job when its first user prompt names the job folder, factory/jobs/<id>/.
// The transcript format is a Claude Code internal detail; unknown lines are skipped.
import { readdirSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { readText } from './util.js';

const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

export function entries(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a partial or foreign line
    }
  }
  return out;
}

export function promptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n');
}

/** USD of one assistant message, or null when its model has no price. */
function messageUsd(message, aliases, prices) {
  const model = typeof message.model === 'string' ? message.model : '';
  const alias = aliases.find((a) => model.includes(a));
  if (!alias) return null;
  const p = prices[alias];
  const u = message.usage;
  return (count(u.input_tokens) * p.input
    + count(u.output_tokens) * p.output
    + count(u.cache_creation_input_tokens) * p.cache_write
    + count(u.cache_read_input_tokens) * p.cache_read) / 1e6;
}

const ROLE = /^[a-z][a-z0-9-]*$/;
const UNASSIGNED = 'unassigned';
const FILE_ROLE = { 'intake.md': 'intake', 'spec.md': 'spec-writer', 'build.md': 'builder', 'decision.md': 'approver' };

/** Role from the file an agent writes: its deliverable names it. */
function roleFromFile(path) {
  const name = String(path).split('/').pop();
  if (Object.hasOwn(FILE_ROLE, name)) return FILE_ROLE[name];
  return /^review-[a-z]+\.md$/.test(name) ? name.slice(0, -3) : null;
}

/** Agent role of one transcript: metadata, then the SubagentStart hook, then the file it wrote. */
export function transcriptRole(agentType, lines) {
  if (typeof agentType === 'string' && ROLE.test(agentType)) return agentType;
  for (const e of lines) {
    const hook = e?.attachment?.hookName;
    const named = typeof hook === 'string' ? /^SubagentStart:([a-z][a-z0-9-]*)$/.exec(hook)?.[1] : null;
    if (named) return named;
  }
  for (const e of lines) {
    const blocks = e?.type === 'assistant' && Array.isArray(e.message?.content) ? e.message.content : [];
    for (const block of blocks) {
      const role = block?.type === 'tool_use' && block.name === 'Write' ? roleFromFile(block.input?.file_path) : null;
      if (role) return role;
    }
  }
  return 'unknown';
}

/** Round named by a prompt: an explicit round folder, or "Round N needs changes" (-> N + 1). */
function promptRound(text, current) {
  const folder = /Round folder: \S*?\/round-([1-9]\d*)\//.exec(text);
  if (folder) return Number(folder[1]);
  const resumed = /Round ([1-9]\d*) needs changes/.exec(text);
  return resumed ? Number(resumed[1]) + 1 : current;
}

const roundKey = (round) => (round ? String(round) : UNASSIGNED);
const byRoundOrder = (a, b) => (a === UNASSIGNED) - (b === UNASSIGNED) || Number(a) - Number(b);

/** The shared cost_by_agent shape: sorted keys, so equal input gives equal output. */
function agentBreakdown(byRole, byRound) {
  const sortedObject = (map, compare) => Object.fromEntries([...map].sort(([a], [b]) => compare(a, b)));
  return {
    by_role: sortedObject(byRole, (a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    by_round: sortedObject(byRound, byRoundOrder),
  };
}
const add = (map, key, usd) => map.set(key, (map.get(key) ?? 0) + usd);

/**
 * USD cost of one job with its breakdown by role and by round.
 * @param {(string | {text: string, agentType?: string})[]} transcripts JSONL contents, optionally with the agent type from the transcript's .meta.json
 * @param {string} jobId
 * @param {Record<string, {input:number, output:number, cache_write:number, cache_read:number}>} prices USD per million tokens, by model alias
 * @returns {{cost_usd: number, by_role: Record<string, number>, by_round: Record<string, number>}}
 */
export function jobCostBreakdown(transcripts, jobId, prices) {
  const needle = `factory/jobs/${jobId}/`;
  const aliases = Object.keys(prices ?? {});
  const seen = new Set();
  const byRole = new Map(), byRound = new Map();
  let total = 0;
  for (const item of transcripts) {
    const text = typeof item === 'string' ? item : item?.text;
    if (!String(text).includes(needle)) continue;
    const lines = entries(text);
    const first = lines.find((e) => e?.type === 'user');
    if (!first || !promptText(first.message?.content).includes(needle)) continue;
    const role = transcriptRole(typeof item === 'string' ? undefined : item.agentType, lines);
    let round = null;
    for (const e of lines) {
      if (e?.type === 'user') round = promptRound(promptText(e.message?.content), round);
      const message = e?.type === 'assistant' ? e.message : null;
      if (!message?.usage) continue;
      if (message.id) {
        if (seen.has(message.id)) continue; // usage repeats on every content block
        seen.add(message.id);
      }
      const usd = messageUsd(message, aliases, prices);
      if (usd === null) continue;
      total += usd;
      add(byRole, role, usd);
      add(byRound, roundKey(round), usd);
    }
  }
  return { cost_usd: total, ...agentBreakdown(byRole, byRound) };
}

/** USD cost of one job (the total of jobCostBreakdown). */
export function jobCost(transcripts, jobId, prices) {
  return jobCostBreakdown(transcripts, jobId, prices).cost_usd;
}

/**
 * Usage of the orchestrator sessions: top-level session transcripts whose `subagents/`
 * folder holds at least one agent that worked on a factory job. Subagents have their own
 * transcripts, so nothing is counted twice. One session drives many jobs (and whatever
 * else its person did there), so this is reported apart and never split across jobs.
 */
export function orchestratorCost(dir, prices) {
  const aliases = Object.keys(prices ?? {});
  let sessions = 0, total = 0;
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { sessions, cost_usd: total };
  }
  for (const item of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
    const subagents = readTranscripts(join(dir, item.name.slice(0, -'.jsonl'.length)));
    const worked = subagents.some((text) => {
      const first = entries(text).find((e) => e?.type === 'user');
      return /Job folder: factory\/jobs\/\d{3,}-/.test(promptText(first?.message?.content));
    });
    if (!worked) continue;
    const text = readText(join(dir, item.name));
    if (text === null) continue;
    const seen = new Set();
    for (const e of entries(text)) {
      const message = e?.type === 'assistant' ? e.message : null;
      if (!message?.usage || (message.id && seen.has(message.id))) continue;
      if (message.id) seen.add(message.id);
      total += messageUsd(message, aliases, prices) ?? 0;
    }
    sessions += 1;
  }
  return { sessions, cost_usd: total };
}

/** Contents of every *.jsonl file inside a `subagents/` folder under `dir`. */
export function readTranscripts(dir) {
  const out = [];
  const walk = (folder, inSubagents) => {
    let items;
    try {
      items = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const path = join(folder, item.name);
      if (item.isDirectory()) walk(path, inSubagents || item.name === 'subagents');
      else if (inSubagents && item.isFile() && item.name.endsWith('.jsonl')) {
        const text = readText(path);
        if (text !== null) out.push(text);
      }
    }
  };
  walk(dir, false);
  return out;
}

/** Like readTranscripts, but each item also carries the agentType from its sibling .meta.json. */
export function readAgentTranscripts(dir) {
  const out = [];
  const walk = (folder, inSubagents) => {
    let items;
    try {
      items = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const path = join(folder, item.name);
      if (item.isDirectory()) walk(path, inSubagents || item.name === 'subagents');
      else if (inSubagents && item.isFile() && item.name.endsWith('.jsonl')) {
        const text = readText(path);
        if (text === null) continue;
        let agentType;
        try {
          agentType = JSON.parse(readText(path.replace(/\.jsonl$/, '.meta.json')) ?? '{}')?.agentType;
        } catch {
          agentType = undefined;
        }
        out.push({ text, agentType: typeof agentType === 'string' ? agentType : undefined });
      }
    }
  };
  walk(dir, false);
  return out;
}

// Codex rollouts are internal JSONL. Project only accounting metadata; never
// return prompts, tool responses, base instructions, credentials or rate limits.
function workerAssignment(text) {
  const lines = text.split(/\r?\n/);
  // A contract starts the message, not a fenced/quoted example or an explanation.
  const header = /^Job folder: factory\/jobs\/(\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*)\/[ \t]*$/.exec(lines[0]);
  if (!header) return null;
  const id = header[1];
  let branchLine = 1, round = null;
  if (lines[1]?.startsWith(`Round folder: factory/jobs/${id}/round-`)) {
    const folder = /^Round folder: factory\/jobs\/[\w-]+\/round-([1-9]\d*)\/[ \t]*$/.exec(lines[1]);
    if (folder) {
      branchLine = 2;
      round = Number(folder[1]);
    }
  }
  // The role named in the "Read factory/project.md, <role file>" line wins; only without
  // that line fall back to the first role file mentioned anywhere in the prompt.
  const roleFile = '(?:factory\\/roles|\\.claude\\/agents)\\/([a-z][a-z0-9-]*)\\.md';
  const role = new RegExp(`Read factory\\/project\\.md,\\s*${roleFile}`).exec(text)?.[1]
    ?? new RegExp(roleFile).exec(text)?.[1] ?? null;
  // A bare header is contradictory job evidence but cannot authorize usage in
  // the shared checkout. Require the matching contiguous worker branch field.
  return { id, round, role, assigned: lines[branchLine]?.trimEnd() === `Branch: factory/${id}` };
}

function codexRollout(text) {
  let meta = null, model = null, usageBeforePrompt = false, role = null, round = null;
  const jobs = new Set(), assignments = new Set(), cwds = new Set(), snapshots = [];
  for (const e of entries(text)) {
    const p = e?.payload;
    if (!p || typeof p !== 'object') continue;
    if (e.type === 'session_meta' && !meta) {
      meta = { id: p.id, cwd: p.cwd, forked_from_id: p.forked_from_id ?? null };
    } else if (e.type === 'turn_context') {
      model = typeof p.model === 'string' ? p.model : null;
      // Missing cwd in older rollouts is not evidence; an explicit malformed or
      // foreign cwd is. Keep it so a resume cannot hide another job's usage.
      if (Object.hasOwn(p, 'cwd')) cwds.add(p.cwd);
    } else if (e.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const contract = workerAssignment(promptText(p.content));
      if (contract) {
        role = contract.role ?? role;
        round = contract.round;
        jobs.add(contract.id);
        if (contract.assigned) assignments.add(contract.id);
      }
    } else if (e.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      const u = p.info.total_token_usage;
      if (!assignments.size && (u.input_tokens > 0 || u.output_tokens > 0)) usageBeforePrompt = true;
      snapshots.push({ model, role, round, usage: {
        input_tokens: u.input_tokens, cached_input_tokens: u.cached_input_tokens ?? 0,
        cache_write_input_tokens: u.cache_write_input_tokens ?? 0, output_tokens: u.output_tokens,
      } });
    }
  }
  return { meta, jobs: [...jobs], assignments: [...assignments], cwds: [...cwds], usageBeforePrompt, snapshots };
}

const within = (path, base) => typeof path === 'string' && isAbsolute(path)
  && (resolve(path) === resolve(base) || resolve(path).startsWith(`${resolve(base)}${sep}`));
const unavailable = (cost_reason) => ({ cost_usd: null, cost_status: 'unavailable', cost_reason });
const validPrice = (p) => p && ['input', 'cache_read', 'cache_write', 'output']
  .every((key) => Number.isFinite(p[key]) && p[key] >= 0);
const tokenKeys = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'];
const validUsage = (u) => tokenKeys.every((key) => Number.isSafeInteger(u[key]) && u[key] >= 0)
  && u.cached_input_tokens + u.cache_write_input_tokens <= u.input_tokens;
const magnitude = (s) => s.usage.input_tokens + s.usage.output_tokens;

/**
 * Codex cost with explicit availability. Input includes cached tokens (unlike
 * Claude); subtract read/write subsets before pricing ordinary input. Output
 * already includes reasoning. Prices are exact model IDs, USD/million tokens.
 * Cumulative snapshots are merged by session id, not filename, and priced as
 * deltas so a model switch cannot reprice earlier usage. Unknown partial costs
 * make the whole job unavailable rather than presenting an invented total.
 * Forks carry inherited prompts/counters under a new id, without a verified
 * history boundary here; fail closed rather than billing copied parent usage.
 */
export function codexJobCost(rollouts, job, prices, root) {
  const sessions = new Map();
  for (const source of rollouts) {
    const r = typeof source === 'string' ? codexRollout(source) : source;
    if (typeof r?.meta?.id !== 'string' || !r.meta.id || typeof r.meta.cwd !== 'string') continue;
    const copies = sessions.get(r.meta.id) ?? [];
    copies.push(r);
    sessions.set(r.meta.id, copies);
  }
  let total = 0, found = false;
  const byRole = new Map(), byRound = new Map();
  const worktree = job.worktree || join(root, '.worktrees', job.id);
  for (const copies of sessions.values()) {
    const relevant = copies.some((r) => within(r.meta.cwd, worktree)
      || r.cwds.some((cwd) => within(cwd, worktree))
      || (r.jobs.includes(job.id) && [r.meta.cwd, ...r.cwds].some((cwd) => within(cwd, root))));
    if (!relevant) continue;
    // A duplicate/resumed session must retain the same dedicated association.
    for (const r of copies) {
      const assigned = r.assignments.length === 1 && r.assignments[0] === job.id && !r.usageBeforePrompt;
      const allowedCwd = (cwd) => within(cwd, worktree)
        || (typeof cwd === 'string' && isAbsolute(cwd) && resolve(cwd) === resolve(root) && assigned);
      if (r.meta.forked_from_id !== null || !allowedCwd(r.meta.cwd)
        || r.cwds.some((cwd) => !allowedCwd(cwd))
        || r.jobs.some((id) => id !== job.id)) return unavailable('ambiguous_session');
    }
    const snapshots = [];
    for (const r of copies) {
      let previous = null;
      for (const snapshot of r.snapshots) {
        if (!validUsage(snapshot.usage) || (previous && tokenKeys.some((k) => snapshot.usage[k] < previous[k]))) {
          return unavailable('invalid_usage');
        }
        previous = snapshot.usage;
        snapshots.push(snapshot);
      }
    }
    // Copies may be truncated prefixes of a resumed rollout. Sorting cumulative
    // counters reconciles them; identical snapshots have a zero delta.
    snapshots.sort((a, b) => magnitude(a) - magnitude(b));
    let previous = Object.fromEntries(tokenKeys.map((k) => [k, 0])), counted = false;
    for (const snapshot of snapshots) {
      const u = Object.fromEntries(tokenKeys.map((k) => [k, snapshot.usage[k] - previous[k]]));
      if (!validUsage(u)) return unavailable('invalid_usage');
      previous = snapshot.usage;
      // A verified zero snapshot is still usage evidence, but needs a known price.
      if (counted && tokenKeys.every((k) => u[k] === 0)) continue;
      if (!snapshot.model) return unavailable('missing_model');
      const p = Object.hasOwn(prices ?? {}, snapshot.model) ? prices[snapshot.model] : null;
      if (!validPrice(p)) return unavailable('missing_price');
      const usd = ((u.input_tokens - u.cached_input_tokens - u.cache_write_input_tokens) * p.input
        + u.cached_input_tokens * p.cache_read + u.cache_write_input_tokens * p.cache_write
        + u.output_tokens * p.output) / 1e6;
      total += usd;
      add(byRole, snapshot.role ?? 'unknown', usd);
      add(byRound, roundKey(snapshot.round), usd);
      found = true;
      counted = true;
    }
  }
  if (!found) return unavailable('no_associated_usage');
  return Number.isFinite(total)
    ? { cost_usd: total, cost_status: 'available', cost_reason: null, cost_by_agent: agentBreakdown(byRole, byRound) }
    : unavailable('invalid_usage');
}

/** Read regular JSONL files recursively; do not follow symlinks. No state writes. */
export function readCodexRollouts(dir, root) {
  const out = [];
  const walk = (folder) => {
    let items;
    try { items = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const path = join(folder, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && item.name.endsWith('.jsonl')) {
        const text = readText(path);
        if (text === null) continue;
        const r = codexRollout(text);
        // A session may have entered this repo after starting elsewhere. Retain
        // that contradictory evidence so it cannot leave a known partial total.
        if (r.meta && (!root || within(r.meta.cwd, root) || r.cwds.some((cwd) => within(cwd, root)))) out.push(r);
      }
    }
  };
  walk(dir);
  return out;
}
