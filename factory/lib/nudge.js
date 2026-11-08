// factory/bin/nudge: the builder's Stop (SubagentStop) hook. Runs checks.sh in the
// job's worktree before the builder finishes. On failure it exits 2 with the log
// tail on stderr, so the builder keeps working. Advisory only: the gate decides.
// `factory/bin/nudge <job-id>` runs the same check by hand, with no hook input (the
// Codex orchestrator uses it before `job <id> to gate`, and the builder role runs it
// for its own checks). Exit 2 means the checks failed; 64 means the call itself was
// wrong (bad id, unknown job, no worktree).
//
// A pass is remembered in the job folder (nudge.json: the worktree's tree and the hash
// of checks.sh + config.json), so the next nudge on exactly the same files does not run
// the checks again. A failure forgets it and keeps the full log in nudge.log. The gate
// never reads nudge.json: it always runs the checks itself.
//
// One nudge per job at a time: while the checks run, nudge.lock in the job folder holds the
// PID. A second nudge of the same job is refused (exit 1) instead of running the checks twice;
// a lock whose process is gone is taken over. The builder runs the nudge in the foreground and
// waits for it, so there is never a reason to start another.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checksInputs, worktreeTree } from './check-stamp.js';
import { runChecks } from './gate.js';
import { JOB_ID, factoryRoot, isMain, readText, runCli, tail, writeAtomic } from './util.js';

// Exit codes: 0 checks pass (or nothing to check), 1 another nudge of the job is running,
// 2 checks failed, 64 bad usage or unknown job.
const EXIT_BUSY = 1;
const EXIT_USAGE = 64;
const LOCK = 'nudge.lock';
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
  const manual = args[0];
  if (manual !== undefined && !JOB_ID.test(manual)) {
    process.stderr.write('usage: nudge [<job-id>]\n');
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
  if (tree && last?.tree === tree && last.inputs === inputs) {
    process.stderr.write(`factory nudge: the checks already passed for this tree (${tree.slice(0, 12)}); not running them again.\n`);
    return 0;
  }

  const lockFile = join(dir, LOCK);
  const holder = takeLock(lockFile);
  if (holder) {
    process.stderr.write(`factory nudge: refused: nudge running (pid ${holder}); wait for that one to finish instead of starting another.\n`);
    return EXIT_BUSY;
  }
  try {
    return runAndReport({ root, job, stampFile, logFile, tree, inputs });
  } finally {
    releaseLock(lockFile);
  }
}

function runAndReport({ root, job, stampFile, logFile, tree, inputs }) {
  const { code, output } = runChecks(root, job.worktree);
  if (code === 0) {
    bestEffort(() => (tree
      ? writeAtomic(stampFile, `${JSON.stringify({ tree, inputs, at: new Date().toISOString() })}\n`)
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

/**
 * Takes the job's nudge lock for this process. Returns the PID of the live nudge that holds it, or
 * null when this process may run (it took the lock, or the folder cannot hold one: then it runs as
 * before). A lock with no PID or the PID of a process that is gone is taken over.
 */
function takeLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      return null;
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
      const pid = Number.parseInt(readText(file) ?? '', 10);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) return pid;
      bestEffort(() => rmSync(file, { force: true }));
    }
  }
  return null;
}

/** Removes the lock only when this process holds it. */
function releaseLock(file) {
  if (Number.parseInt(readText(file) ?? '', 10) === process.pid) bestEffort(() => rmSync(file, { force: true }));
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
