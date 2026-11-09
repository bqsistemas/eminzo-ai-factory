// `job lessons [--last N]`: the lessons the approver wrote into the last N decision.md files become the
// `## Things the builder gets wrong` section of factory/project.md, on a branch, as a pull request that a
// human merges. The PR touches project.md and nothing else. Reads job folders only; writes no job state.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sectionLines } from './section.js';
import { JOB_ID, Refused, Usage, baseRef, mustRun, readText, run, writeAtomic } from './util.js';

export const LESSONS_HEADING = 'Things the builder gets wrong';
export const MAX_LESSON_LINES = 15;
export const DEFAULT_LAST = 20;
const NONE = 'none';

/** Case and punctuation do not make two lessons different. */
export function normalizeLesson(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Strips the list marker, checkbox and emphasis a lesson line may carry. */
function cleanLine(line) {
  return line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '').replace(/\*\*|__/g, '').trim();
}

export const MAX_LESSON_CHARS = 200;

/**
 * A lesson ends up in project.md, which every builder reads, so only plain one-line text gets through: whitespace is
 * collapsed and the line is cut at 200 characters; a line that starts with `#`, or holds a comment marker, `<`, a
 * backtick or a markdown link or image, is dropped. Returns null for a dropped lesson.
 */
export function sanitizeLesson(text) {
  const line = String(text).replace(/\s+/g, ' ').trim();
  if (!line || line.startsWith('#')) return null;
  if (/<!--|-->|<|`|!?\[[^\]]*\]\(|\]\[|^\s*\[[^\]]*\]:\s/.test(line)) return null;
  return line.length > MAX_LESSON_CHARS ? `${line.slice(0, MAX_LESSON_CHARS - 1).trimEnd()}…` : line;
}

/** The lessons of one decision.md: its `## Lessons` lines, sanitized, without `None` and blanks. */
export function lessonsOf(decisionText) {
  const lines = sectionLines(decisionText, 'Lessons');
  if (!lines) return [];
  return lines.map((l) => sanitizeLesson(cleanLine(l.text))).filter((t) => t && normalizeLesson(t) !== NONE);
}

/** True when decision.md has a `## Lessons` section with at least one non-blank line. */
export function hasLessonsSection(decisionText) {
  const lines = sectionLines(decisionText, 'Lessons');
  return Boolean(lines?.some((l) => l.text.trim()));
}

/** Job ids in numeric order: `999-y` before `1000-x`; equal numbers fall back to the name. */
export function compareJobIds(a, b) {
  return (parseInt(a, 10) - parseInt(b, 10)) || (a < b ? -1 : a > b ? 1 : 0);
}

/** The ids of the last `last` jobs that have a decision.md, oldest first. */
function jobIds(root, last) {
  const dir = join(root, 'factory/jobs');
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir).filter((n) => JOB_ID.test(n) && existsSync(join(dir, n, 'decision.md'))).sort(compareJobIds);
  return ids.slice(-last);
}

/**
 * Lessons of the last N jobs, deduplicated by normalized text: `{ key, text, count }`, with `text` the first
 * wording seen and `count` the number of times the lesson appears (once per job at most).
 */
export function collectLessons(root, last = DEFAULT_LAST) {
  const byKey = new Map();
  jobIds(root, last).forEach((id, order) => {
    const seen = new Set();
    for (const text of lessonsOf(readText(join(root, 'factory/jobs', id, 'decision.md')))) {
      const key = normalizeLesson(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const entry = byKey.get(key) ?? { key, text, count: 0, order };
      entry.count += 1;
      entry.order = order;
      byKey.set(key, entry);
    }
  });
  return [...byKey.values()];
}

const FENCE = /^\s*(```|~~~)/;

/** `{ start, end }` line indexes of the level-2 lessons section (heading to the next `#`/`##` heading), outside code fences; null if absent. */
function locateSection(lines) {
  let fenced = false;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (start < 0) {
      const m = /^##\s+(.*?)\s*#*\s*$/.exec(lines[i]);
      if (m && m[1].toLowerCase().startsWith(LESSONS_HEADING.toLowerCase())) start = i;
    } else if (/^#{1,2}\s/.test(lines[i])) {
      return { start, end: i };
    }
  }
  return start < 0 ? null : { start, end: lines.length };
}

/** The list lines currently in the project.md section, without comments, fences and prose. */
export function existingLessons(markdown) {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const where = locateSection(lines);
  if (!where) return [];
  const out = [];
  let comment = false;
  let fenced = false;
  for (const raw of lines.slice(where.start + 1, where.end)) {
    if (FENCE.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    let line = raw;
    if (comment) {
      const close = line.indexOf('-->');
      if (close < 0) continue;
      comment = false;
      line = line.slice(close + 3);
    }
    for (let open = line.indexOf('<!--'); open >= 0; open = line.indexOf('<!--')) {
      const close = line.indexOf('-->', open + 4);
      if (close < 0) { comment = true; line = line.slice(0, open); break; }
      line = line.slice(0, open) + line.slice(close + 3);
    }
    if (!/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) continue;
    const text = sanitizeLesson(cleanLine(line));
    if (text) out.push(text);
  }
  return out;
}

/** Most repeated first, then the most recent; lines already in project.md count once and rank last among equals. */
export function rankLessons(collected, existing = []) {
  const byKey = new Map(collected.map((e) => [e.key, e]));
  for (const text of existing) {
    const key = normalizeLesson(text);
    if (key && !byKey.has(key)) byKey.set(key, { key, text, count: 1, order: -1 });
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || b.order - a.order || a.key.localeCompare(b.key))
    .slice(0, MAX_LESSON_LINES);
}

/** project.md with the section replaced (or appended); the heading plus at most 15 bullets, no blank line inside. */
export function applyLessons(markdown, entries) {
  const section = [`## ${LESSONS_HEADING}`, ...entries.map((e) => `- ${e.text}`)];
  const lines = markdown.replace(/\r/g, '').split('\n');
  const where = locateSection(lines);
  if (!where) return `${markdown.replace(/\s+$/, '')}\n\n${section.join('\n')}\n`;
  const tail = lines.slice(where.end);
  return [...lines.slice(0, where.start), ...section, ...(tail.length ? ['', ...tail] : [''])].join('\n');
}

/** `--last N` parsed from the arguments after `lessons`. */
export function parseLast(args, usage) {
  if (args.length === 0) return DEFAULT_LAST;
  if (args.length === 2 && args[0] === '--last' && /^[1-9]\d*$/.test(args[1])) return Number(args[1]);
  throw new Usage(usage);
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * Collects the lessons, rewrites project.md on a new branch cut from `config.base` (in a temporary worktree, so the
 * main checkout is never touched), pushes it and opens the PR with gh. Returns the lines to print.
 */
export function lessonsCommand({ root, config, gh }, last) {
  const { base, remote } = baseRef(config);
  const collected = collectLessons(root, last);
  // Nothing would change: answer before fetching or creating anything.
  const local = readText(join(root, 'factory/project.md'));
  if (local !== null) {
    const ranked = rankLessons(collected, existingLessons(local));
    if (!ranked.length) return 'no lessons: nothing to write';
    if (applyLessons(local, ranked) === local) return 'lessons: project.md is already up to date';
  } else if (!collected.length) {
    return 'no lessons: nothing to write';
  }
  const git = (args, cwd = root) => mustRun('git', args, { cwd });
  const dir = mkdtempSync(join(tmpdir(), 'eminzo-lessons-'));
  const wt = join(dir, 'wt');
  const branch = `factory/lessons-${stamp()}-${randomBytes(3).toString('hex')}`;
  let created = false;
  try {
    const fetch = run('git', ['fetch', remote], { cwd: root });
    if (fetch.status !== 0) throw new Refused(`git fetch ${remote} failed: ${(fetch.stderr || '').trim().split('\n').pop()}`);
    git(['worktree', 'add', '-q', '-b', branch, wt, base]);
    created = true;
    const projectFile = join(wt, 'factory/project.md');
    const current = readText(projectFile);
    if (current === null) throw new Refused(`${base} has no factory/project.md`);
    const ranked = rankLessons(collected, existingLessons(current));
    if (!ranked.length) return 'no lessons: nothing to write';
    const next = applyLessons(current, ranked);
    if (next === current) return 'lessons: project.md is already up to date';
    writeAtomic(projectFile, next);
    const changed = git(['status', '--porcelain'], wt).split('\n').filter(Boolean).map((l) => l.slice(3));
    if (changed.length !== 1 || changed[0] !== 'factory/project.md') throw new Refused(`expected to change only factory/project.md, got: ${changed.join(', ')}`);
    git(['add', '--', 'factory/project.md'], wt);
    git(['commit', '-q', '-m', 'docs(factory): update lessons the builder gets wrong'], wt);
    git(['push', '-q', remote, `refs/heads/${branch}:refs/heads/${branch}`], wt);
    const body = join(dir, 'body.md');
    writeFileSync(body, [
      `Updates \`## ${LESSONS_HEADING}\` in \`factory/project.md\` from the \`## Lessons\` of the last ${last} job decisions.`,
      '', `${ranked.length} line${ranked.length === 1 ? '' : 's'}, the most repeated first. Only \`factory/project.md\` changes. A human merges this.`, '',
    ].join('\n'));
    let url;
    try {
      url = mustRun(gh, ['pr', 'create', '--base', base.slice(remote.length + 1), '--head', branch,
        '--title', 'docs(factory): update lessons the builder gets wrong', '--body-file', body], { cwd: root }).trim();
    } catch (err) {
      const del = run('git', ['push', remote, '--delete', branch], { cwd: wt });
      throw new Refused(`${err.message}${del.status === 0 ? `; the pushed branch ${branch} was deleted` : `; the branch ${branch} is still on ${remote}: delete it with git push ${remote} --delete ${branch}`}`);
    }
    return `lessons: ${ranked.length} line${ranked.length === 1 ? '' : 's'} written to factory/project.md on ${branch}\n${url}`;
  } finally {
    run('git', ['worktree', 'remove', '--force', wt], { cwd: root });
    run('git', ['worktree', 'prune'], { cwd: root });
    if (created) run('git', ['branch', '-D', branch], { cwd: root });
    rmSync(dir, { recursive: true, force: true });
  }
}
