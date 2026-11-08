// Jobs that would change the same files must not build in parallel: the second merge would
// end in a conflict and a `needs-human`. `factory/bin/job <id> overlap` lists the jobs ahead
// of this one that share a file; the orchestrator waits for them before the first build.
import { join } from 'node:path';

import { scopeTokens } from './diff.js';
import { jobDir, readText } from './util.js';

// Stages whose branch already holds (or is about to hold) committed changes.
const AHEAD = new Set(['gate', 'review', 'approve', 'merging', 'awaiting-merge']);

/** The job's number (the digits before the first `-` of its id): ids widen past 999, so never compare them as text. */
const jobNumber = (job) => Number(String(job.id).match(/^(\d+)-/)?.[1] ?? Infinity);

/** The exact file paths a job says it will change: its spec's Design, or intake's Scope in lane xs. */
export function jobScope(root, job) {
  const dir = jobDir(root, job.id);
  const spec = job.lane === 'xs' ? null : readText(join(dir, 'spec.md'));
  const source = spec ?? readText(join(dir, 'intake.md')) ?? '';
  return scopeTokens(source, spec ? 'Design' : 'Scope').files;
}

/**
 * The jobs ahead of `job` that share a file with it: any job past the build, or an older job
 * still in build. A younger job never counts, so two jobs can never wait for each other. A job
 * whose spec names no exact path never waits; the merge still syncs with the base.
 * @returns {{id: string, files: string[]}[]}
 */
export function overlaps(root, job, jobs) {
  const mine = jobScope(root, job);
  if (!mine.size) return [];
  const found = [];
  for (const other of jobs) {
    if (other.id === job.id) continue;
    const ahead = AHEAD.has(other.stage) || (other.stage === 'build' && jobNumber(other) < jobNumber(job));
    if (!ahead) continue;
    const shared = [...jobScope(root, other)].filter((f) => mine.has(f)).sort();
    if (shared.length) found.push({ id: other.id, files: shared });
  }
  return found;
}

/** One `wait: <id> (<files>)` line per job ahead, or `none`. */
export function overlapReport(list) {
  return list.length ? list.map((o) => `wait: ${o.id} (${o.files.join(', ')})`).join('\n') : 'none';
}
