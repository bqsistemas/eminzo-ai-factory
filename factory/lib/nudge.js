// factory/bin/nudge: the builder's Stop (SubagentStop) hook. Runs checks.sh in the
// job's worktree before the builder finishes. On failure it exits 2 with the log
// tail on stderr, so the builder keeps working. Advisory only: the gate decides.
// `factory/bin/nudge <job-id>` runs the same check by hand, with no hook input (the
// Codex orchestrator uses it before `job <id> to gate`, and the builder role runs it
// for its own checks). Exit 2 means the checks failed; 64 means the call itself was
// wrong (bad id, unknown job, no worktree).
//
// Modes: by hand, `nudge <job-id>` runs the checks focused (FACTORY_CHECK_MODE=focused and
// FACTORY_CHANGED_FILES, the file listing the paths changed against the base, for a checks.sh
// that uses them), `nudge <job-id> --full` and the Stop hook run everything. A checks.sh that
// ignores the variables runs everything either way. When the changed files cannot be computed
// the nudge runs full.
//
// A pass is remembered in the job folder (nudge.json: the worktree's tree, the mode, and the hash
// of checks.sh + config.json), so the next nudge on exactly the same files does not run
// the checks again. A focused pass never satisfies a full nudge (nor the hook); a full pass
// satisfies both. A failure forgets it and keeps the full log in nudge.log. The gate
// never reads nudge.json: it always runs the checks itself.
//
// One nudge per job at a time: while the checks run, nudge.lock in the job folder records the
// nudge (PID and start time) and nudge.lock.child the PID of the checks it started. A second
// nudge of the same job is refused instead of running the checks twice: exit 1 by hand, exit 2
// as the Stop hook (so the builder keeps waiting). A lock is stale, and taken over, when neither
// process is alive or it is older than MAX_LOCK_AGE (a recycled PID never blocks forever). The
// builder runs the nudge in the foreground and waits for it, so there is never a reason to start another.
import { existsSync, linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { changedFiles, checksInputs, worktreeTree } from './check-stamp.js';
import { runChecks } from './gate.js';
import { JOB_ID, baseRef, factoryRoot, isMain, loadConfig, readText, runCli, tail, writeAtomic } from './util.js';

// Exit codes: 0 checks pass (or nothing to check), 1 another nudge of the job is running,
// 2 checks failed, 64 bad usage or unknown job.
const EXIT_BUSY = 1;
const EXIT_FAIL = 2;
const EXIT_USAGE = 64;
const LOCK = 'nudge.lock';
const MAX_LOCK_AGE = 3 * 60 * 60 * 1000;
const JOB_PATH = /factory\/jobs\/(\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*)\//;

function jobIdFromHook() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return null;
  }
  if (!input || input.stop_hook_active === true) return null;
  const transcript = input.agent_transcript_path || input.transcript_path;
  const text = typeof transcript === 'string' ? readText(transcript) : null;
  return text?.match(JOB_PATH)?.[1] ?? null;
}

function main(args = []) {
  const full = args.includes('--full');
  const rest = args.filter((a) => a !== '--full');
  const manual = rest[0];
  if ((manual !== undefined && !JOB_ID.test(manual)) || rest.length > 1 || (full && manual === undefined)) {
    process.stderr.write('usage: nudge [<job-id> [--full]]\n');
    return EXIT_USAGE;
  }
  const id = manual ?? jobIdFromHook();
  if (!id) return 0;

  let root;
  let job;
  try {
    root = factoryRoot();
    job = JSON.parse(readFileSync(join(root, 'factory/jobs', id, 'job.json'), 'utf8'));
  } catch {
    if (manual) {
      process.stderr.write(`factory nudge: no job ${id}\n`);
      return EXIT_USAGE;
    }
    return 0;
  }
  if (typeof job.worktree !== 'string' || !existsSync(job.worktree)) {
    if (manual) {
      process.stderr.write(`factory nudge: job ${id} has no worktree to check\n`);
      return EXIT_USAGE;
    }
    return 0;
  }

  const dir = join(root, 'factory/jobs', id);
  const stampFile = join(dir, 'nudge.json');
  const logFile = join(dir, 'nudge.log');
  const inputs = checksInputs(root);
  const tree = worktreeTree(job.worktree);
  const last = readStamp(stampFile);
  // The hook (no job id) and --full need a full pass; only a by-hand nudge may settle for a focused one.
  const wantFull = full || !manual;
  const passed = !wantFull || last?.mode === undefined || last.mode === 'full';
  if (tree && last?.tree === tree && last.inputs === inputs && passed) {
    process.stderr.write(`factory nudge: the checks already passed for this tree (${tree.slice(0, 12)}); not running them again.\n`);
    return 0;
  }

  const lockFile = join(dir, LOCK);
  const lock = takeLock(lockFile);
  if (!lock.ok) {
    const who = lock.holder ? `pid ${lock.holder}` : 'pid unknown';
    if (!manual) {
      // As the Stop hook: the checks of this job are still running, so the builder must not stop yet.
      process.stderr.write(`factory nudge: the checks of this job are still running in another nudge (${who}); wait for them to finish, then stop.\n`);
      return EXIT_FAIL;
    }
    process.stderr.write(`factory nudge: refused: nudge running (${who}). Wait for it to finish; if no nudge of this job is running, delete ${lockFile}.\n`);
    return EXIT_BUSY;
  }
  try {
    return runAndReport({ root, job, dir, wantFull, stampFile, logFile, tree, inputs, childFile: lock.unlocked ? null : `${lockFile}.child` });
  } finally {
    if (!lock.unlocked) releaseLock(lockFile);
  }
}

/** The focused run's options: the changed-files file in the job folder, or {} (full) when it cannot be made. */
function focusedOptions(root, job, dir) {
  try {
    const files = changedFiles(job.worktree, baseRef(loadConfig(root)).base);
    if (!files) return {};
    const file = join(dir, 'changed-files.txt');
    writeAtomic(file, files.map((f) => `${f}\n`).join(''));
    return { mode: 'focused', changedFiles: file };
  } catch {
    return {};
  }
}

function runAndReport({ root, job, dir, wantFull, stampFile, logFile, tree, inputs, childFile }) {
  const options = { ...(wantFull ? {} : focusedOptions(root, job, dir)), ...(childFile ? { pidFile: childFile } : {}) };
  const mode = options.mode ?? 'full';
  const { code, output } = runChecks(root, job.worktree, options);
  if (code === 0) {
    bestEffort(() => (tree
      ? writeAtomic(stampFile, `${JSON.stringify({ tree, inputs, mode, at: new Date().toISOString() })}\n`)
      : rmSync(stampFile, { force: true })));
    return 0;
  }
  bestEffort(() => rmSync(stampFile, { force: true }));
  const logged = bestEffort(() => writeAtomic(logFile, output));
  process.stderr.write(
    `factory nudge: factory/checks.sh failed (exit ${code}) in ${job.worktree}.\n`
    + 'Fix it before you finish; the gate runs the same checks.\n'
    + (logged ? `Full log: ${logFile}\n\n` : '\n')
    + `${tail(output, 60)}\n`,
  );
  return 2;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
};
const pidIn = (text) => {
  const pid = Number.parseInt(String(text ?? '').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

/** A lock's record: { pid, started (ms) }, from its JSON (or a bare PID with the file's time); null when unreadable. */
function readRecord(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    const rec = JSON.parse(text);
    if (rec && pidIn(rec.pid) && Number.isFinite(Date.parse(rec.started))) return { pid: pidIn(rec.pid), started: Date.parse(rec.started) };
  } catch { /* a bare PID */ }
  const pid = pidIn(text);
  if (!pid) return null;
  try { return { pid, started: statSync(file).mtimeMs }; } catch { return null; }
}

/** Live while its nudge or the checks it started run, and for at most MAX_LOCK_AGE. */
function isLive(rec, childFile) {
  if (!rec || rec.pid === process.pid) return false;
  const age = Date.now() - rec.started;
  if (!(age >= 0) || age > MAX_LOCK_AGE) return false;
  const child = pidIn(readText(childFile));
  return alive(rec.pid) || (child !== null && alive(child));
}

/** Creates `file` with this nudge's record in one step (a link of a complete temp file): true, or false when it exists. */
function publish(file) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, started: new Date().toISOString() })}\n`);
  try {
    linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Takes the job's nudge lock: { ok: true } (also { unlocked: true } when the folder cannot hold a lock: the
 * nudge then runs as before), or { ok: false, holder } when another nudge of the job is running. A stale
 * lock is moved aside with a rename (atomic), and put back if what was moved turns out to be live.
 */
function takeLock(file) {
  const childFile = `${file}.child`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (publish(file)) return { ok: true };
    } catch {
      return { ok: true, unlocked: true };
    }
    const rec = readRecord(file);
    if (isLive(rec, childFile)) return { ok: false, holder: rec.pid };
    const aside = `${file}.stale.${process.pid}.${attempt}`;
    try {
      renameSync(file, aside);
    } catch {
      continue; // someone else moved or released it: try again
    }
    if (isLive(readRecord(aside), childFile)) {
      try { linkSync(aside, file); } catch { /* another lock took the place */ }
      rmSync(aside, { force: true });
      continue;
    }
    rmSync(aside, { force: true });
    rmSync(childFile, { force: true });
  }
  return { ok: false, holder: readRecord(file)?.pid ?? null };
}

/** Removes the lock (and its checks PID) only when this nudge holds it. */
function releaseLock(file) {
  if (readRecord(file)?.pid !== process.pid) return;
  bestEffort(() => rmSync(`${file}.child`, { force: true }));
  bestEffort(() => rmSync(file, { force: true }));
}

/** The stamp and the log only save time; failing to write them never changes the checks' result. */
function bestEffort(fn) {
  try {
    fn();
    return true;
  } catch (err) {
    process.stderr.write(`factory nudge: ${err.message}\n`);
    return false;
  }
}

function readStamp(file) {
  try {
    const stamp = JSON.parse(readText(file) ?? 'null');
    return stamp && typeof stamp.tree === 'string' && typeof stamp.inputs === 'string' ? stamp : null;
  } catch {
    return null;
  }
}

if (isMain(import.meta.url)) runCli(main);
