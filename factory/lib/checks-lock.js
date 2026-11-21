// One full checks run at a time per repository. A full checks.sh already uses most of the cores (a test
// runner starts one worker per core), so several jobs of the same repository reaching the gate together
// make each other slower and can stall the machine. runChecks takes this lock around a full checks.sh.
// Different repositories do not wait for each other.
//
// The lock only delays, it never fails a check:
//   - a holder that is dead (its process and the checks it started), or older than MAX_AGE_MS, is taken over;
//   - after FACTORY_CHECKS_LOCK_WAIT_MS (default 30 minutes) the checks run anyway, as they did before the lock;
//   - a lock that cannot be written (a read-only folder, a sandbox) is skipped.
//
// A checks run started from inside the checks (this engine's own suite runs gates and nudges) never
// waits for itself: the checks get FACTORY_CHECKS_LOCK_HELD=1, and a run that lost the variable
// still sees that the holder is one of its ancestors.
//
// FACTORY_CHECKS_LOCK: `off` disables the lock; any other value is the lock file to use (tests).
// Default: <root>/factory/jobs/.checks.lock (factory/jobs is gitignored runtime state of the repository;
// every job worktree and .worktrees/.base belong to that root). `checks.lock: "off"` in
// factory/config.json disables it for the repository (see checksLockSetting). Under a test run
// (NODE_TEST_CONTEXT) the default is no lock, so tests never touch a real one.
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { run } from './util.js';

export const HELD = 'FACTORY_CHECKS_LOCK_HELD';
const DEFAULT_WAIT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;
const MAX_AGE_MS = 3 * 60 * 60 * 1000; // a recycled pid never blocks forever
const EMPTY_LOCK_MS = 60 * 1000; // a holder that died while writing the file
const MAX_HOPS = 32;

const envNumber = (env, name, fallback) => {
  const n = Number(env[name]);
  return env[name] !== undefined && env[name] !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** The longest a checks run waits for the lock before it runs anyway. */
export const checksLockWaitMs = (env = process.env) => envNumber(env, 'FACTORY_CHECKS_LOCK_WAIT_MS', DEFAULT_WAIT_MS);

const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** `checks.lock` of the config: `repo` (the default) or `off`; anything else is `repo`. */
export function checksLockSetting(config) {
  return config?.checks?.lock === 'off' ? 'off' : 'repo';
}

/** The lock file for this process, or null when it must not lock. */
function lockPath(env, root) {
  const value = env.FACTORY_CHECKS_LOCK;
  if (value === 'off' || env[HELD]) return null;
  if (value) return value;
  if (env.NODE_TEST_CONTEXT || !root) return null;
  return join(root, 'factory', 'jobs', '.checks.lock');
}

const readPid = (file) => {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

/** Who holds the lock and whether it is over: `stale`, the inode judged, the holder's pid, label, start and the pid of its checks. */
export function judgeLock(file, childFile) {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return { stale: true, ino: st.ino };
    let held = null;
    let raw = '';
    try { raw = readFileSync(file, 'utf8'); held = JSON.parse(raw); } catch { /* empty or half written */ }
    if (!Number.isInteger(held?.pid)) return { stale: Date.now() - st.mtimeMs > EMPTY_LOCK_MS, ino: st.ino, raw };
    const child = readPid(childFile);
    const started = Date.parse(held.started);
    const tooOld = Number.isFinite(started) && Date.now() - started > MAX_AGE_MS;
    return { stale: tooOld || (!alive(held.pid) && !alive(child)), ino: st.ino, raw, pid: held.pid, child, label: typeof held.label === 'string' ? held.label : null, since: Number.isFinite(started) ? started : null };
  } catch {
    return { stale: false, gone: true };
  }
}

/** Whether one of `pids` is an ancestor of this process (best effort: needs `ps`). */
function heldByAncestor(pids) {
  const wanted = new Set(pids.filter((p) => Number.isInteger(p)));
  if (wanted.size === 0 || process.platform === 'win32') return false;
  let pid = process.ppid;
  for (let hop = 0; hop < MAX_HOPS && Number.isInteger(pid) && pid > 1; hop += 1) {
    if (wanted.has(pid)) return true;
    const res = run('ps', ['-o', 'ppid=', '-p', String(pid)]);
    if (res.status !== 0) return false;
    pid = Number(String(res.stdout).trim());
  }
  return false;
}

/**
 * Takes over the file that was judged stale: the same inode before and after the rename, and the same holder
 * (a filesystem may give a new lock the inode number of the one that was judged).
 */
export function takeOver(file, childFile, judged) {
  const away = `${file}.stale.${process.pid}`;
  try {
    if (lstatSync(file).ino !== judged.ino) return;
    renameSync(file, away);
    if (lstatSync(away).ino !== judged.ino || readFileSync(away, 'utf8') !== judged.raw) {
      try { writeFileSync(file, readFileSync(away), { flag: 'wx', mode: 0o600 }); } catch { /* somebody holds it again */ }
      rmSync(away, { force: true });
    } else {
      rmSync(away, { force: true });
      rmSync(childFile, { force: true });
    }
  } catch { /* someone else took it over */ }
}

const UNLOCKED = Object.freeze({ file: null, childFile: null, held: false, ranAnyway: false, waitedMs: 0, waitedFor: null, release() {} });

const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

/**
 * Takes the repository's checks lock, waiting for a live holder.
 * `label` says who asks (`gate 045-feat-x`, `base`), so the one who waits can name who holds it.
 * @returns {{file: string|null, childFile: string|null, held: boolean, waitedMs: number, waitedFor: string|null, release: () => void}}
 *   `held` false means the checks run without the lock (disabled, nested, not writable, or the wait ran out);
 *   `ranAnyway` is true when the wait ran out: the checks then run as if they held the lock.
 *   `waitedFor` is the label of the holder that was waited for, when there was a wait.
 */
export function takeChecksLock(env = process.env, { root, label = 'checks', note = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const file = lockPath(env, root);
  if (!file) return UNLOCKED;
  const childFile = `${file}.child`;
  const waitMs = checksLockWaitMs(env);
  const pollMs = envNumber(env, 'FACTORY_CHECKS_LOCK_POLL_MS', DEFAULT_POLL_MS);
  const started = Date.now();
  let told = false;
  let checkedAncestry = false;
  let waitedFor = null;
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    return UNLOCKED;
  }
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), label }), { flag: 'wx', mode: 0o600 });
      return {
        file,
        childFile,
        held: true,
        waitedMs: Date.now() - started,
        waitedFor,
        release() {
          try {
            if (JSON.parse(readFileSync(file, 'utf8')).pid !== process.pid) return;
            rmSync(childFile, { force: true });
            rmSync(file, { force: true });
          } catch { /* gone, or taken over */ }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') return UNLOCKED;
    }
    const judged = judgeLock(file, childFile);
    if (judged.gone) continue;
    if (judged.stale) {
      takeOver(file, childFile, judged);
      continue;
    }
    if (!checkedAncestry) {
      checkedAncestry = true;
      if (heldByAncestor([judged.pid, judged.child])) return UNLOCKED;
    }
    const waited = Date.now() - started;
    if (!told) {
      told = true;
      waitedFor = judged.label ?? `pid ${judged.pid ?? 'unknown'}`;
      const since = judged.since ? ` (since ${clock(judged.since)})` : '';
      note(`factory checks: the checks of this repository are running for ${waitedFor}${since}; waiting for them to finish. Set checks.lock to "off" in factory/config.json to disable.`);
    }
    if (waited >= waitMs) {
      note(`factory checks: waited ${Math.round(waited / 1000)}s for the checks lock of this repository (${file}); running anyway.`);
      return { ...UNLOCKED, waitedMs: waited, waitedFor, ranAnyway: true };
    }
    sleep(Math.min(pollMs, Math.max(waitMs - waited, 1)));
  }
}
