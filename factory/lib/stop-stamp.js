// The Stop-hook stamp: factory/jobs/.stamps/<job-id>.json in the MAIN checkout, written only by the
// nudge when a FULL run of checks.sh actually ran and passed, and read (once) by the gate, which may then
// skip running checks.sh. Shared by nudge.js (writes, deletes) and gate.js (reads, deletes).
//
// The stamp is NOT unforgeable: the builder has Bash and no sandbox, so it can write the file (the
// same residual risk as job.json). The safeguards are that the protect hook denies the file tools on the
// folder, that the gate reads it only from the main checkout and only when every field matches the job
// as the gate itself recomputes it, that it is single use, that it expires after STAMP_TTL_MS (and is not
// dated in the future), that the reader refuses a stamp file or a .stamps folder that is a symlink and the
// writer and deleter never go through a symlinked .stamps (an lstat check: it leaves a small window between
// the check and the use, and does not cover a symlinked `factory` or `factory/jobs`), that a branch
// touching factory/jobs/ (any letter case) fails the round, and that the merge never reuses a gate that
// rested on a stamp (it runs checks.sh itself).
import { lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { readText, writeAtomic } from './util.js';

export const STAMPS_DIR = 'factory/jobs/.stamps';
/** How long a stamp may stand in for a run: the builder's pass is for the tree it just checked, not for one left over from yesterday. */
export const STAMP_TTL_MS = 60 * 60 * 1000;
/** A stamp dated up to this far ahead is taken as clock skew; further ahead it is not a time this machine wrote. */
export const STAMP_SKEW_MS = 60 * 1000;
const SHA = /^[0-9a-f]{40,64}$/;
const INPUTS = /^sha256:[0-9a-f]{64}$/;

const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Where the stamp of `jobId` lives: always under the main checkout `root`. */
export const stampFile = (root, jobId) => join(root, STAMPS_DIR, `${jobId}.json`);

/** Writes the stamp atomically. Throws on failure (also when the stamp folder is a symlink; the nudge treats that as best effort). */
export function writeStamp(root, jobId, { job, round, tree, inputs, base, head, at, engine }) {
  if (isLink(join(root, STAMPS_DIR))) throw new Error(`${STAMPS_DIR} is a symlink`);
  writeAtomic(stampFile(root, jobId), `${JSON.stringify({ job, round, tree, inputs, base, head, at, engine: engine ?? null })}\n`);
}

/** Removes the stamp of `jobId`, if any. Never throws. */
export function removeStamp(root, jobId) {
  if (isLink(join(root, STAMPS_DIR))) return; // never delete through a link the builder may have placed
  try { rmSync(stampFile(root, jobId), { force: true }); } catch { /* a stamp that stays is checked field by field anyway */ }
}

/** True when `path` exists and is a real (not symlinked) file or folder as `want` says. */
function plain(path, want) {
  try {
    const st = lstatSync(path);
    return !st.isSymbolicLink() && (want === 'dir' ? st.isDirectory() : st.isFile());
  } catch {
    return false;
  }
}

/** True when `at` is a time this machine could have written within the last STAMP_TTL_MS (allowing STAMP_SKEW_MS of clock skew). */
function fresh(at, now) {
  const ms = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(ms) && ms >= now - STAMP_TTL_MS && ms <= now + STAMP_SKEW_MS;
}

/**
 * The stamp of `job` when it may stand in for a run of checks.sh, else null. Every condition must hold:
 * it parses; its job and round are this job's; the worktree is clean; its head, tree, checks inputs and
 * base are exactly what the caller measured now (`facts`); the job is not a base fix; base is a real sha; its
 * time is within STAMP_TTL_MS; and neither the file nor its folder is a symlink (lstat, never followed).
 * A stamp that is expired or in the future is deleted here; the caller deletes the others once it has looked.
 * @param {{dirty: string[], head: string|null, tree: string|null, inputs: string, base: string|null}} facts
 * @param {number} [now] the clock, for tests
 */
export function reusableStamp(root, job, facts, now = Date.now()) {
  if (job.base_fix || facts.dirty.length > 0) return null;
  if (!plain(join(root, STAMPS_DIR), 'dir') || !plain(stampFile(root, job.id), 'file')) return null;
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
  if (!fresh(s.at, now)) {
    removeStamp(root, job.id);
    return null;
  }
  return s;
}
