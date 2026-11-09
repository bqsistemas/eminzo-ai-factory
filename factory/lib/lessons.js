// `job lessons [--last N]`: the lessons the approver wrote into the last N decision.md files become the
// `## Things the builder gets wrong` section of factory/project.md, on a branch, as a pull request that a
// human merges. The PR touches project.md and nothing else. Reads job folders only; writes no job state.
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

/** The lessons of one decision.md: its `## Lessons` lines, without `None` and blanks. */
export function lessonsOf(decisionText) {
  const lines = sectionLines(decisionText, 'Lessons');
  if (!lines) return [];
  return lines.map((l) => cleanLine(l.text)).filter((t) => t && normalizeLesson(t) !== NONE);
}

/** True when decision.md has a `## Lessons` section with at least one non-blank line. */
export function hasLessonsSection(decisionText) {
  const lines = sectionLines(decisionText, 'Lessons');
  return Boolean(lines?.some((l) => l.text.trim()));
}

/** The ids of the last `last` jobs that have a decision.md, oldest first. */
function jobIds(root, last) {
  const dir = join(root, 'factory/jobs');
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir).filter((n) => JOB_ID.test(n) && existsSync(join(dir, n, 'decision.md'))).sort();
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

/** The bullet lines currently in the project.md section. */
export function existingLessons(markdown) {
  return (sectionLines(markdown, LESSONS_HEADING) ?? []).map((l) => cleanLine(l.text)).filter((t) => t && t !== '---' && !t.startsWith('<!--') && !t.endsWith('-->'));
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
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase().startsWith(LESSONS_HEADING.toLowerCase()));
  if (start < 0) {
    const body = markdown.replace(/\s+$/, '');
    return `${body}\n\n${section.join('\n')}\n`;
  }
  let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
  if (end < 0) end = lines.length;
  const tail = lines.slice(end);
  return [...lines.slice(0, start), ...section, ...(tail.length ? ['', ...tail] : [''])].join('\n');
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
  const git = (args, cwd = root) => mustRun('git', args, { cwd });
  const dir = mkdtempSync(join(tmpdir(), 'factory-lessons-'));
  const wt = join(dir, 'wt');
  const branch = `factory/lessons-${stamp()}`;
  try {
    const fetch = run('git', ['fetch', remote], { cwd: root });
    if (fetch.status !== 0) throw new Refused(`git fetch ${remote} failed: ${(fetch.stderr || '').trim().split('\n').pop()}`);
    git(['worktree', 'add', '-q', '-b', branch, wt, base]);
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
    const url = mustRun(gh, ['pr', 'create', '--base', base.slice(remote.length + 1), '--head', branch,
      '--title', 'docs(factory): update lessons the builder gets wrong', '--body-file', body], { cwd: root }).trim();
    return `lessons: ${ranked.length} line${ranked.length === 1 ? '' : 's'} written to factory/project.md on ${branch}\n${url}`;
  } finally {
    run('git', ['worktree', 'remove', '--force', wt], { cwd: root });
    run('git', ['branch', '-D', branch], { cwd: root });
    rmSync(dir, { recursive: true, force: true });
  }
}
