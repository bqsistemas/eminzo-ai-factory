// The Stop-hook stamp: factory/jobs/.stamps/<job-id>.json in the MAIN checkout, written only by the
// nudge when a FULL run of checks.sh actually ran and passed, and read (once) by the gate, which may then
// skip running checks.sh. Shared by nudge.js (writes, deletes) and gate.js (reads, deletes).
//
// The stamp is NOT unforgeable: the builder has Bash and no sandbox, so it can write the file (the
// same residual risk as job.json). The safeguards are that the protect hook denies the file tools on the
// folder, that the gate reads it only from the main checkout and only when every field matches the job
// as the gate itself recomputes it, that it is single use, that a branch touching factory/jobs/ fails the
// round, and that the merge never reuses a gate that rested on a stamp (it runs checks.sh itself).
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { readText, writeAtomic } from './util.js';

export const STAMPS_DIR = 'factory/jobs/.stamps';
const SHA = /^[0-9a-f]{40,64}$/;
const INPUTS = /^sha256:[0-9a-f]{64}$/;

/** Where the stamp of `jobId` lives: always under the main checkout `root`. */
export const stampFile = (root, jobId) => join(root, STAMPS_DIR, `${jobId}.json`);

/** Writes the stamp atomically. Throws on failure (the nudge treats that as best effort). */
export function writeStamp(root, jobId, { job, round, tree, inputs, base, head, at, engine }) {
  writeAtomic(stampFile(root, jobId), `${JSON.stringify({ job, round, tree, inputs, base, head, at, engine: engine ?? null })}\n`);
}

/** Removes the stamp of `jobId`, if any. Never throws. */
export function removeStamp(root, jobId) {
  try { rmSync(stampFile(root, jobId), { force: true }); } catch { /* a stamp that stays is checked field by field anyway */ }
}

/**
 * The stamp of `job` when it may stand in for a run of checks.sh, else null. Every condition must hold:
 * it parses; its job and round are this job's; the worktree is clean; its head, tree, checks inputs and
 * base are exactly what the caller measured now (`facts`); the job is not a base fix; and base is a real sha.
 * @param {{dirty: string[], head: string|null, tree: string|null, inputs: string, base: string|null}} facts
 */
export function reusableStamp(root, job, facts) {
  if (job.base_fix || facts.dirty.length > 0) return null;
  let s;
  try {
    s = JSON.parse(readText(stampFile(root, job.id)) ?? 'null');
  } catch {
    return null;
  }
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return null;
  if (s.job !== job.id || s.round !== job.round) return null;
  if (!SHA.test(facts.head ?? '') || s.head !== facts.head) return null;
  if (!SHA.test(facts.tree ?? '') || s.tree !== facts.tree) return null;
  if (!INPUTS.test(facts.inputs ?? '') || s.inputs !== facts.inputs) return null;
  if (!SHA.test(facts.base ?? '') || s.base !== facts.base) return null;
  if (typeof s.at !== 'string' || !Number.isFinite(Date.parse(s.at))) return null;
  return s;
}
