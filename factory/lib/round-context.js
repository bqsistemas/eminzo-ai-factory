// round-N/context.md, written by the gate: what changed, what changed this round, the ACs and
// the blockers still open from the previous round. The reviewers run in parallel; each reads
// this once instead of deriving it again. Built from git and the job files, never from an agent.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { sectionLines } from './section.js';
import { baseRef, firstLine, jobDir, readText, run } from './util.js';

const CAP = 150;
const AC_LINE = /^\s*(?:[-*]|\d+\.)\s*(?:\*\*|`)?AC-\d+/;
const BLOCKER_LINE = /^\s*[-*]\s*\[blocker\]/i;

function capped(lines, empty) {
  if (!lines.length) return [empty];
  return lines.length > CAP ? [...lines.slice(0, CAP), `- ... ${lines.length - CAP} more`] : lines;
}

/** `- <status> <path>` lines of `git diff --name-status --no-renames from..HEAD`, or null. */
function nameStatus(cwd, from) {
  const res = run('git', ['diff', '--name-status', '--no-renames', `${from}..HEAD`], { cwd });
  if (res.status !== 0) return null;
  return res.stdout.split('\n').filter(Boolean).map((line) => {
    const [status, path] = line.split('\t');
    return `- ${status[0]} ${path}`;
  });
}

/** The head recorded for the newest round before the current one (see job.js `previousHead`). */
function previousHead(job) {
  const heads = job.round_heads ?? {};
  const rounds = Object.keys(heads).map(Number).filter((n) => n < job.round).sort((a, b) => b - a);
  return rounds.length ? heads[String(rounds[0])] : undefined;
}

function acceptanceCriteria(root, job) {
  const dir = jobDir(root, job.id);
  const source = job.lane === 'xs' ? readText(join(dir, 'intake.md')) : readText(join(dir, 'spec.md'));
  const section = job.lane === 'xs' ? 'Scope' : 'Acceptance criteria';
  const lines = sectionLines(source ?? '', section) ?? [];
  return lines.map((l) => l.text.trim()).filter((t) => AC_LINE.test(t));
}

/** `[blocker]` lines of the previous round's reviews whose verdict was CHANGES, prefixed with the lens. */
function openBlockers(root, job) {
  const dir = join(jobDir(root, job.id), `round-${job.round - 1}`);
  if (job.round < 2 || !existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const lens = name.match(/^review-([a-z-]+)\.md$/)?.[1];
    if (!lens || !/^VERDICT: CHANGES\b/.test(firstLine(join(dir, name)) ?? '')) continue;
    for (const line of (readText(join(dir, name)) ?? '').split('\n')) {
      if (BLOCKER_LINE.test(line)) out.push(`- ${lens}: ${line.trim().replace(/^[-*]\s*/, '')}`);
    }
  }
  return out;
}

/** The markdown of round-N/context.md for `job` (job.json shape: id, round, worktree, lane, round_heads). */
export function roundContext(root, config, job) {
  const { base } = baseRef(config);
  const cwd = job.worktree;
  const mb = run('git', ['merge-base', base, 'HEAD'], { cwd });
  const mergeBase = mb.status === 0 ? mb.stdout.trim() : null;
  const head = run('git', ['rev-parse', 'HEAD'], { cwd });
  const whole = mergeBase ? nameStatus(cwd, mergeBase) : null;

  let roundLines;
  let headLine = [];
  if (job.round < 2) {
    roundLines = [`Round ${job.round}: the whole change.`];
  } else {
    const prev = previousHead(job);
    if (typeof prev === 'string') {
      headLine = [`Previous round head: ${prev}`];
      roundLines = nameStatus(cwd, prev) ?? ['unknown (the recorded head is not in this branch; review the full change)'];
    } else {
      headLine = ['Previous round head: unknown (review the full change)'];
      roundLines = ['unknown (review the full change)'];
    }
  }

  return [
    `# Round context (round ${job.round})`,
    '',
    `Base: ${base}${mergeBase ? ` (merge base ${mergeBase})` : ''}`,
    `Branch head: ${head.status === 0 ? head.stdout.trim() : 'unknown'}`,
    ...headLine,
    '',
    '## Changed files (whole change)',
    '',
    ...(whole ? capped(whole, 'None.') : ['unknown (git diff failed)']),
    '',
    '## Changed this round',
    '',
    ...(roundLines.length ? capped(roundLines, 'None.') : ['None.']),
    '',
    '## Acceptance criteria',
    '',
    ...capped(acceptanceCriteria(root, job), 'None found.'),
    '',
    '## Open blockers from the previous round',
    '',
    ...capped(openBlockers(root, job), 'None.'),
    '',
  ].join('\n');
}
