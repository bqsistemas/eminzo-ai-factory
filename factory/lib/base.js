// factory/bin/base: the base check. Does the repository's own factory/checks.sh pass on the tip of the base
// branch (`config.base`, `<remote>/<branch>`)? It runs in ONE reused, detached worktree, `.worktrees/.base`:
// the engine fetches the remote, checks out the tip there, runs the prepare step (installs the dependencies:
// `checks.prepare` in config.json, else the one the lockfile names, `""` turns it off) and then the MAIN
// checkout's checks.sh, exactly as the gate does for a job.
//
// Three answers, and only one of them is a verdict about the base:
//   PASS     checks.sh exited 0.
//   FAIL     checks.sh exited with another code.
//   UNKNOWN  the check could not run: a git or worktree step failed, the prepare step failed, checks.sh
//            exited 126 or 127, a signal killed it, it did not start, another check held the lock too long.
//            Nobody is ever blamed or held for an UNKNOWN, and it is never cached.
//
// State lives in factory/jobs/.base/ (gitignored; `allJobs` skips names that are not job ids):
//   state.json            the last full-scope check and up to 50 cached results, written atomically
//   <key12>/checks.md     the report of one check, with checks.log next to it
//   lock                  one check at a time ({pid, started}; only a dead holder's lock is taken over, and an empty one after a minute)
// The folder must be a private one that this user owns, never a link: nothing is read or written through one.
//
// `base` by hand never uses the cache. A job's check (checkBase with `job`) reuses a PASS or FAIL for the same
// key: the checked commit, the checks inputs, the prepare step and the scope. The scope is `full` (every
// project) or, when the main checkout's checks.sh names FACTORY_BASE (so it can narrow) and the caller says
// what the job changed, `files:<hash of the changed paths>`.
//
// factory/bin/base            the tip of the base, every project, never cached.   exit 0 PASS, 1 FAIL, 3 UNKNOWN
//                             base: PASS <sha12> | base: FAIL <sha12>: <command> | base: UNKNOWN <sha12>: <reason>
//                             report: factory/jobs/.base/<key12>/checks.md
// factory/bin/base fix-issue  the one open issue that fixes a failing base, found or created (labels factory and
//                             factory:base-fix, text in config.language, no log in it).   exit 0, or 1 when refused:
//                             fix: #<n> created | fix: #<n> open
//                             refused: the last check of <base> did not fail | <base> moved since; run base again
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checksInputs } from './check-stamp.js';
import { runChecks } from './gate.js';
import { BASE_FIX_LABEL } from './labels.js';
import { LOG_LINES, capLog, engineLines, formatSpan } from './report.js';
import { prepareCommand, span } from './stacks.js';
import { Refused, Usage, baseRef, configLanguage, engineCommand, engineVersion, factoryRoot, isMain, loadConfig, now, readText, run, runCli, tail, writeAtomic } from './util.js';

export const MAX_RESULTS = 50;
export const STATE_VERSION = 1;
export const EXIT_UNKNOWN = 3;
const STATUSES = ['PASS', 'FAIL', 'UNKNOWN'];
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const KEY = /^[0-9a-f]{64}$/;
const MAX_STATE_BYTES = 256 * 1024;
const PREPARE_TIMEOUT_MS = 30 * 60 * 1000;
const TRACE = /^\++\[factory\] (.*)$/;
const COMMAND_MAX = 300;
const CHECKS_TIMEOUT_MINUTES = 30;
const FAIL_TTL_MS = 60 * 60 * 1000; // a FAIL may be a flaky or environment-only failure: it holds jobs for an hour, not for ever
const EMPTY_LOCK_MS = 60 * 1000;
const FETCH_TTL_MS = 60 * 1000;
const LOCK_MARGIN_MS = 10 * 60 * 1000;
// Secrets of the machine that neither the prepare step nor checks.sh of the base check may inherit. Registry tokens such as
// NPM_TOKEN stay: an install may need them.
const SECRET_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'FACTORY_DISCORD_WEBHOOK_URL'];

/** How long checks.sh may run in the base check, in minutes. */
const checksTimeoutMinutes = (config) => {
  const minutes = Number(config?.checks?.base_timeout_minutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : CHECKS_TIMEOUT_MINUTES;
};

const envNumber = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && process.env[name] !== '' && process.env[name] !== undefined ? n : fallback;
};

/** Where the state of the base check lives. */
export const baseDir = (root) => join(root, 'factory/jobs/.base');

/** The sha shown to a person. */
export const short = (sha) => String(sha ?? '').slice(0, 12);

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
const git = (cwd, args, opts = {}) => run('git', args, { cwd, env: gitEnv(), ...opts });
const why = (res) => (res.stderr || res.error?.message || '').trim().split('\n').slice(-1)[0] || `exit ${res.status}`;
/** Display text from a log: no control characters, one line, bounded. */
const clean = (text, max = COMMAND_MAX) => String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// ---- the state folder -------------------------------------------------------------------------------

/** `factory/jobs/.base`, created private on first use; throws (with a reason) when it is not safe to use. */
function ensureStateDir(root) {
  const mine = (st) => typeof process.getuid !== 'function' || st.uid === process.getuid();
  // factory/ and factory/jobs belong to the repository: a group-writable one (umask 002) is normal, a world-writable one is not.
  const plain = (dir) => {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && mine(st) && (process.platform === 'win32' || (st.mode & 0o002) === 0);
  };
  const factoryDir = join(root, 'factory');
  const jobsDir = join(factoryDir, 'jobs');
  const dir = baseDir(root);
  if (!plain(factoryDir)) throw new Error('factory/ is not a private folder');
  mkdirSync(jobsDir, { recursive: true });
  if (!plain(jobsDir)) throw new Error('factory/jobs is not a private folder');
  if (!existsSyncNoFollow(dir)) mkdirSync(dir, { mode: 0o700 });
  const st = lstatSync(dir);
  if (!plain(dir) || (process.platform !== 'win32' && (st.mode & 0o077) !== 0)) throw new Error('factory/jobs/.base is not private (it must be a folder only you can write, not a link)');
  return dir;
}

function existsSyncNoFollow(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const isRecord = (r) => r && typeof r === 'object' && !Array.isArray(r) && KEY.test(r.key ?? '') && SHA.test(r.sha ?? '') && STATUSES.includes(r.status)
  && (r.report === null || r.report === undefined || r.report === `${r.key.slice(0, 12)}/checks.md`);

/** A state with nothing in it. */
export const emptyState = (base = null) => ({ version: STATE_VERSION, base, full: null, results: {} });

/**
 * The state of the base check, or an empty one when there is none, it is not a regular file of a sane size,
 * or it does not parse. Never follows a link. Records that do not look right are dropped.
 */
export function readState(root) {
  const file = join(baseDir(root), 'state.json');
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > MAX_STATE_BYTES) return emptyState();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || raw.version !== STATE_VERSION || typeof raw.results !== 'object' || raw.results === null || Array.isArray(raw.results)) return emptyState();
    const results = {};
    for (const [key, rec] of Object.entries(raw.results)) if (isRecord(rec) && rec.key === key && rec.status !== 'UNKNOWN') results[key] = rec;
    return { version: STATE_VERSION, base: typeof raw.base === 'string' ? raw.base : null, full: isRecord(raw.full) ? raw.full : null, results };
  } catch {
    return emptyState();
  }
}

/**
 * The state after one more check: a PASS or FAIL joins `results` (at most MAX_RESULTS, the oldest dropped; UNKNOWN is never
 * cached) and a check of the full scope becomes `full`, whatever its answer, so the desktop can show it.
 */
export function recordResult(state, record) {
  const results = { ...state.results };
  if (record.status !== 'UNKNOWN') results[record.key] = record;
  const keep = Object.values(results).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, MAX_RESULTS);
  return { ...state, full: record.scope === 'full' ? record : state.full, results: Object.fromEntries(keep.map((r) => [r.key, r])) };
}

// ---- the lock -------------------------------------------------------------------------------------

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/**
 * Whether the lock is a dead holder's, and which file that judgment is about (its inode). A live holder is never robbed, however
 * old its lock is: the checks and the prepare step have a timeout, so a live pid is a check that is still running. An empty or
 * unreadable file is a holder that died while writing it: it ages out after a minute by its mtime.
 */
function lockStaleness(file, maxAgeMs) {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return { stale: true, ino: st.ino }; // a link or a folder is never a lock this engine wrote
    let held = null;
    try { held = JSON.parse(readFileSync(file, 'utf8')); } catch { /* empty or half written */ }
    if (!Number.isInteger(held?.pid)) return { stale: Date.now() - st.mtimeMs > EMPTY_LOCK_MS, ino: st.ino };
    // A live pid can be a different process that reused the number: the holder's own run is bounded by its timeouts, so a lock older
    // than that (plus a margin) is over whatever the pid says.
    const started = Date.parse(held.started);
    const tooOld = Number.isFinite(started) && Date.now() - started > maxAgeMs;
    return { stale: !alive(held.pid) || tooOld, ino: st.ino, pid: held.pid };
  } catch {
    return { stale: false };
  }
}

/** The oldest a live holder's lock may be: its prepare timeout plus its checks timeout plus a margin. */
const lockAge = (config) => envNumber('FACTORY_BASE_PREPARE_TIMEOUT_MS', PREPARE_TIMEOUT_MS) + checksTimeoutMinutes(config) * 60 * 1000 + LOCK_MARGIN_MS;
const defaultLockAge = () => lockAge(null);

/** Takes factory/jobs/.base/lock, waiting for a live holder. @returns {{ok: true, release: () => void}|{ok: false, reason: string}} */
function takeLock(dir, waitMs, pollMs, maxAgeMs = defaultLockAge()) {
  const file = join(dir, 'lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, started: now() }), { flag: 'wx', mode: 0o600 });
      return { ok: true, release: () => { try { if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file); } catch { /* gone */ } } };
    } catch (err) {
      if (err.code !== 'EEXIST') return { ok: false, reason: `cannot take the lock: ${err.message}` };
    }
    const judged = lockStaleness(file, maxAgeMs);
    if (judged.stale) {
      // Take over only the file that was judged: the same inode before and after the rename, or give it back and give up.
      const away = `${file}.stale.${process.pid}`;
      try {
        if (lstatSync(file).ino !== judged.ino) continue;
        renameSync(file, away);
        if (lstatSync(away).ino !== judged.ino) {
          if (!existsSyncNoFollow(file)) renameSync(away, file); // it was somebody's fresh lock: put it back
          return { ok: false, reason: 'another base check is still running' };
        }
        rmSync(away, { force: true });
      } catch { /* someone else took it over */ }
      continue;
    }
    if (Date.now() >= deadline) return { ok: false, reason: `another base check is still running${judged.pid ? ` (pid ${judged.pid}; if it is gone, remove factory/jobs/.base/lock)` : ''}` };
    sleep(pollMs);
  }
}

// ---- git and the worktree -------------------------------------------------------------------------

/** The commit `ref` points at, after `git fetch <remote>` (a failed fetch keeps the local ref). */
const fetched = new Map();
export function resolveTip(root, base, remote) {
  if (remote.startsWith('-') || base.startsWith('-')) return { error: `the base ${base} is not a valid ref` };
  const seen = `${root}\0${remote}`;
  if (!(Date.now() - (fetched.get(seen) ?? 0) < FETCH_TTL_MS)) { // one fetch per minute per process is plenty
    git(root, ['fetch', remote], { timeout: 120_000 });
    fetched.set(seen, Date.now());
  }
  const res = git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  const sha = res.status === 0 ? res.stdout.trim() : '';
  return SHA.test(sha) ? { sha } : { error: `cannot resolve ${base}${res.status === 0 ? '' : `: ${why(res)}`}` };
}

/** The tip's root entries, for the prepare default (no worktree needed yet). */
function filesAt(root, sha) {
  const res = git(root, ['ls-tree', '--name-only', '-z', sha]);
  return res.status === 0 ? res.stdout.split('\0').filter(Boolean) : [];
}

/** The reused detached worktree at `sha`. @returns {{path: string}|{error: string}} */
function checkoutBase(root, sha) {
  const path = join(root, '.worktrees/.base');
  const parent = join(root, '.worktrees');
  for (const p of [parent, path]) if (existsSyncNoFollow(p) && lstatSync(p).isSymbolicLink()) return { error: `${p.slice(root.length + 1)} is a link, not a plain folder` };
  const pruned = git(root, ['worktree', 'prune']);
  if (pruned.status !== 0) return { error: `git worktree prune failed: ${why(pruned)}` };
  const listed = git(root, ['worktree', 'list', '--porcelain']);
  if (listed.status !== 0) return { error: `git worktree list failed: ${why(listed)}` };
  let registered = false;
  if (existsSync(path)) {
    const real = realpathSync(path);
    registered = listed.stdout.split('\n').some((l) => l.startsWith('worktree ') && safeReal(l.slice('worktree '.length)) === real);
  }
  if (existsSync(path) && !registered) rmSync(path, { recursive: true, force: true }); // a leftover folder git does not know
  if (!existsSync(path)) {
    const added = git(root, ['worktree', 'add', '--detach', path, sha]);
    if (added.status !== 0) return { error: `git worktree add failed: ${why(added)}` };
    return { path };
  }
  const moved = git(path, ['checkout', '--detach', '--force', sha]);
  if (moved.status !== 0) return { error: `git checkout failed: ${why(moved)}` };
  const cleaned = git(path, ['clean', '-ffd']); // keeps the ignored files: node_modules, .nx
  if (cleaned.status !== 0) return { error: `git clean failed: ${why(cleaned)}` };
  return { path };
}

function safeReal(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// ---- the prepare step -----------------------------------------------------------------------------

/**
 * The prepare step of a check: `checks.prepare` of config.json when it is a string (`""` turns it off), else the one the
 * lockfile at the tip names. `custom` is true for the repository's own text (run by `sh -c`); the default runs as argv.
 */
function prepareFor(config, files) {
  const own = config?.checks?.prepare;
  if (typeof own === 'string') return { command: own.trim(), custom: true };
  return { command: prepareCommand(files) ?? '', custom: false };
}

function runPrepare(path, { command, custom }) {
  const env = { ...process.env, CI: 'true' };
  for (const name of Object.keys(env)) if (name.startsWith('FACTORY_')) delete env[name];
  for (const name of SECRET_ENV) delete env[name];
  delete env.NODE_TEST_CONTEXT;
  const [cmd, args] = custom ? ['sh', ['-c', command]] : [command.split(/\s+/)[0], command.split(/\s+/).slice(1)];
  const started = Date.now();
  const res = run(cmd, args, { cwd: path, env, timeout: envNumber('FACTORY_BASE_PREPARE_TIMEOUT_MS', PREPARE_TIMEOUT_MS), killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error.message}` : ''}`;
  return { code: res.status, signal: res.signal, error: res.error, output, spanMs: Date.now() - started };
}

// ---- the answer -------------------------------------------------------------------------------------

/** The last command the trace shows before checks.sh stopped (display text only), or null. */
export function failingCommand(output) {
  let last = null;
  for (const line of String(output ?? '').split('\n')) {
    const m = TRACE.exec(line);
    if (m) last = m[1];
  }
  const text = last === null ? '' : clean(last);
  return text || null;
}

const withoutTrace = (output) => String(output ?? '').split('\n').filter((l) => !TRACE.test(l)).join('\n');

/** The check's cache key: what decides its answer. */
export function cacheKey({ sha, inputs, prepare, scope }) {
  return createHash('sha256').update('v1\0').update(sha).update('\0').update(inputs).update('\0').update(prepare).update('\0').update(scope).digest('hex');
}

/** Whether the main checkout's checks.sh can narrow by the job's files (it names FACTORY_BASE). */
function canScope(root) {
  return (readText(join(root, 'factory/checks.sh')) ?? '').includes('FACTORY_BASE');
}

/** `files:<hash>` of the paths the job changed between its base and head, and how many. */
function scopeOf(root, scope) {
  const diff = git(root, ['diff', '--name-only', '--no-renames', '-z', scope.base, scope.head], { maxBuffer: 64 * 1024 * 1024 });
  if (diff.status !== 0) return { error: `cannot list the files the job changed: ${why(diff)}` };
  const files = diff.stdout.split('\0').filter(Boolean);
  return { key: `files:${createHash('sha256').update(diff.stdout).digest('hex')}`, files: files.length };
}

const fenceFor = (text) => '`'.repeat(Math.max(3, Math.max(0, ...(String(text).match(/`+/g) ?? []).map((m) => m.length)) + 1));

function reportText(r, { base, prepare, prepareRun, scope, log }) {
  const mb = scope?.base ? short(scope.base) : null;
  const summary = {
    PASS: `The checks passed on ${base} at ${short(r.sha)} in ${formatSpan(r.span_ms)}.`,
    FAIL: `The checks fail on ${base} at ${short(r.sha)}: ${r.command ?? `factory/checks.sh exited with code ${r.exit}`}.`,
    UNKNOWN: `The checks could not run on ${base} at ${short(r.sha)}: ${r.reason}.`,
  }[r.status];
  const logLines = tail(log, LOG_LINES);
  const fence = fenceFor(logLines);
  const prepared = prepareRun ? tail(withoutTrace(prepareRun.output), 30) : null;
  const pf = prepared === null ? '' : fenceFor(prepared);
  return [
    `BASE: ${r.status}`,
    ...engineLines(engineVersion()),
    '',
    summary,
    '',
    `Base: ${base}`,
    `Checked commit: ${r.sha}`,
    r.scope === 'full' ? 'Scope: everything' : `Scope: the files ${r.job ?? 'a job'} changed (${r.files} since ${mb ?? 'its base'})`,
    `Checks inputs: ${r.inputs}`,
    prepare ? `Prepare: ${prepare}${prepareRun ? ` (exit ${prepareRun.code ?? prepareRun.signal ?? 'none'} in ${formatSpan(prepareRun.spanMs)})` : ' (not run)'}` : 'Prepare: none',
    `Checks exit code: ${r.exit ?? 'not run'}`,
    ...(r.status === 'FAIL' ? [`Failing command: ${r.command ?? 'unknown'}`] : []),
    ...(r.status === 'UNKNOWN' ? [`Reason: ${r.reason}`] : []),
    '',
    ...(prepared === null ? [] : ['## Prepare', '', pf, prepared, pf, '']),
    `## Log (last ${LOG_LINES} lines)`,
    '',
    ...(log === null ? ['The checks did not run.'] : ['Full log: `checks.log`', '', fence, logLines, fence]),
    '',
  ].join('\n');
}

/**
 * Checks `config.base`: the whole answer of one base check.
 * @param {string} root the main checkout
 * @param {{ job?: string|null, scope?: {base: string, head: string}|null, fresh?: boolean, byHand?: boolean, config?: object }} [options]
 *   `job` names the job the check is for (cached); `scope` says what it changed (hex shas) so a checks.sh that
 *   names FACTORY_BASE checks only that; `fresh` skips the cache; `byHand` never reads or needs it.
 * @returns the stored record ({key, sha, scope, files, job, inputs, prepare, status, command, reason, exit, at, span_ms,
 *   report, fix_issue}), plus `fromCache`; `sha` and `key` are null and `report` is null when the check stopped before it had them.
 */
export function checkBase(root, { job = null, scope = null, fresh = false, byHand = false, config = loadConfig(root) } = {}) {
  const { base, remote } = baseRef(config);
  const unknown = (reason, sha = null, extra = {}) => ({ key: null, sha, scope: 'full', files: null, job, inputs: null, prepare: '', status: 'UNKNOWN', command: null, reason: clean(reason), exit: null, at: now(), span_ms: 0, report: null, fix_issue: null, fromCache: false, ...extra });

  const tip = resolveTip(root, base, remote);
  if (tip.error) return unknown(tip.error);
  const sha = tip.sha;
  const prepare = prepareFor(config, filesAt(root, sha));
  const inputs = checksInputs(root);

  let scopeKey = 'full';
  let files = null;
  const wanted = scope && SHA.test(scope.base ?? '') && SHA.test(scope.head ?? '') && canScope(root) ? scope : null;
  if (wanted) {
    const found = scopeOf(root, wanted);
    if (found.error) return unknown(found.error, sha);
    scopeKey = found.key;
    files = found.files;
  }
  const key = cacheKey({ sha, inputs, prepare: prepare.command, scope: scopeKey });
  const identity = { key, sha, scope: scopeKey, files, job, inputs, prepare: prepare.command };

  let dir;
  try {
    dir = ensureStateDir(root);
  } catch (err) {
    return unknown(err.message, sha, { key });
  }
  const useCache = !byHand && !fresh;
  // A PASS of the whole base at this tip (same inputs, same prepare) also answers any narrower check of it: the job's files
  // are a subset of everything. Only a PASS: a FAIL of everything says nothing about a subset.
  const cached = () => {
    if (!useCache) return undefined;
    const state = readState(root);
    const full = state.full;
    if (scopeKey !== 'full' && full?.status === 'PASS' && full.sha === sha && full.inputs === inputs && full.prepare === prepare.command) return { ...full, job };
    const rec = state.results[key];
    if (rec?.status === 'FAIL' && !(Date.now() - Date.parse(rec.at) < FAIL_TTL_MS)) return undefined; // too old to hold a job
    return rec;
  };
  const hit = cached();
  if (hit) return { ...hit, fromCache: true };

  const lock = takeLock(dir, envNumber('FACTORY_BASE_LOCK_WAIT_MS', 20 * 60 * 1000), envNumber('FACTORY_BASE_LOCK_POLL_MS', 2000), lockAge(config));
  if (!lock.ok) return unknown(lock.reason, sha, { key });
  try {
    const again = cached(); // another check may have answered while this one waited
    if (again) return { ...again, fromCache: true };
    return runCheck(root, dir, { base, config, prepare, wanted, identity });
  } finally {
    lock.release();
  }
}

/** Removes the report folders no record of the state points to (the one just written stays). Best effort. */
function prune(dir, state, current) {
  try {
    const keep = new Set([current, ...Object.keys(state.results).map((k) => k.slice(0, 12)), ...(state.full ? [state.full.key.slice(0, 12)] : [])]);
    for (const name of readdirSync(dir)) {
      if (/^[0-9a-f]{12}$/.test(name) && !keep.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
    }
  } catch { /* a leftover folder is harmless */ }
}

function runCheck(root, dir, { base, config, prepare, wanted, identity }) {
  const record = (fields) => ({ ...identity, command: null, reason: null, exit: null, at: now(), span_ms: 0, report: `${identity.key.slice(0, 12)}/checks.md`, fix_issue: null, ...fields });
  const finish = (rec, extras) => {
    const folder = join(dir, identity.key.slice(0, 12));
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeAtomic(join(dir, rec.report), reportText(rec, { base, prepare: prepare.command, scope: wanted, ...extras }));
      writeAtomic(join(folder, 'checks.log'), capLog(extras.log ?? ''));
      const next = recordResult({ ...readState(root), base }, rec);
      writeAtomic(join(dir, 'state.json'), `${JSON.stringify(next, null, 2)}\n`);
      prune(dir, next, identity.key.slice(0, 12));
    } catch (err) {
      return { ...rec, report: null, reason: rec.status === 'UNKNOWN' ? rec.reason : null, writeError: err.message, fromCache: false };
    }
    return { ...rec, fromCache: false };
  };
  const stop = (reason, extras = {}) => finish(record({ status: 'UNKNOWN', reason: clean(reason) }), { log: null, ...extras });

  const checkout = checkoutBase(root, identity.sha);
  if (checkout.error) return stop(checkout.error);

  let prepareRun = null;
  if (prepare.command) {
    prepareRun = runPrepare(checkout.path, prepare);
    if (prepareRun.error || prepareRun.code !== 0) {
      const how = prepareRun.error ? `could not start it: ${prepareRun.error.message}` : prepareRun.signal ? `it was killed by ${prepareRun.signal}` : `exit ${prepareRun.code}`;
      return stop(`the prepare step failed (${how})`, { prepareRun });
    }
  }

  const started = Date.now();
  const limit = checksTimeoutMinutes(config);
  const checks = runChecks(root, checkout.path, { label: 'base', trace: true, timeoutMs: limit * 60 * 1000, dropEnv: SECRET_ENV, dropFactoryEnv: true, ...(wanted ? { scope: wanted } : {}) });
  const spanMs = Math.max(0, Date.now() - started - checks.waitedMs); // the wait for the repository's checks lock is not the checks' time
  const log = withoutTrace(checks.output);
  const base_ = { span_ms: spanMs };
  if (checks.timedOut) return finish(record({ ...base_, status: 'UNKNOWN', reason: `factory/checks.sh did not finish in ${limit} minutes and was stopped` }), { log, prepareRun });
  if (checks.failedToStart) return finish(record({ ...base_, status: 'UNKNOWN', reason: clean(`factory/checks.sh did not start: ${tail(checks.output, 1)}`) }), { log, prepareRun });
  if (checks.signal) return finish(record({ ...base_, status: 'UNKNOWN', reason: `factory/checks.sh was killed by ${checks.signal}` }), { log, prepareRun });
  if (checks.code === 126 || checks.code === 127) return finish(record({ ...base_, status: 'UNKNOWN', exit: checks.code, reason: `factory/checks.sh could not run (exit ${checks.code})` }), { log, prepareRun });
  if (checks.code === 0) return finish(record({ ...base_, status: 'PASS', exit: 0 }), { log, prepareRun });
  return finish(record({ ...base_, status: 'FAIL', exit: checks.code, command: failingCommand(checks.output) }), { log, prepareRun });
}

// ---- the fix issue ----------------------------------------------------------------------------------

const CHECK_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'node', 'deno', 'go', 'cargo', 'rustc', 'python', 'python3', 'pytest', 'ruff', 'mypy', 'make', 'mvn', 'gradle', './gradlew', './mvnw', 'tsc', 'eslint', 'jest', 'vitest', 'nx', 'turbo', 'rspec', 'bundle', 'rake', 'dotnet', 'phpunit', 'composer', 'swift', 'flutter', 'dart']);
const CHECK_WORDS = new Set(['run', 'test', 'lint', 'exec', 'build', 'check', 'typecheck', 'vet', 'fmt', 'clippy', 'affected', 'run-many', 'ci', 'verify', 'compile']);
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']); // `<runner> run <name>` runs a script of package.json
const EXEC_BINS = new Set(['nx', 'turbo', 'tsc', 'eslint', 'jest', 'vitest', 'prettier', 'biome']);
const BIN_RUNNERS = new Set(['npx', 'bunx']); // the word after them is a binary

/**
 * The failing command as a PUBLIC issue may show it. The trace prints a command after the shell expanded it, so anything it
 * carried (a token, `-u user:pass`, a key, a password in a variable) is in it, and no pattern can tell a secret from a word. So
 * this is an allowlist, and a free word is shown only when it can be checked:
 * - the program must be a known check tool (`pnpm`, `go`, `cargo`...);
 * - the next words are known verbs (`run`, `test`, `lint`...);
 * - after `run` of npm, pnpm, yarn or bun, a word only when it is a key of `scripts` in the base worktree's package.json
 *   (`scripts` is that list; without it the word is dropped);
 * - after `exec`, and after npx or bunx, a word only when it is one of a fixed set of binaries (nx, turbo, tsc, eslint, jest,
 *   vitest, prettier, biome);
 * - after `run` of any other tool (node, deno, python, go, cargo...) no free word at all.
 * It stops at the first word that fails, shows at most three words and adds ` …` when something was left out. The raw command
 * stays in the local state and report. Display text only.
 * @param {string|null} command @param {Iterable<string>|null} [scripts]
 * @returns {string|null} null when the program is not on the list: then nothing of the command is shown.
 */
export function publicCommand(command, scripts = null) {
  if (typeof command !== 'string') return null;
  const words = command.replace(/`/g, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || !CHECK_TOOLS.has(words[0])) return null;
  const known = new Set(scripts ?? []);
  let shown = 1;
  while (shown < 3 && shown < words.length) {
    const word = words[shown];
    const before = words[shown - 1];
    let allowed;
    if (shown === 1 && BIN_RUNNERS.has(words[0])) allowed = EXEC_BINS.has(word);
    else if (before === 'exec') allowed = EXEC_BINS.has(word);
    else if (before === 'run' && SCRIPT_RUNNERS.has(words[0])) allowed = known.has(word);
    else allowed = CHECK_WORDS.has(word);
    if (!allowed) break;
    shown += 1;
  }
  return `${words.slice(0, shown).join(' ')}${shown < words.length ? ' …' : ''}`;
}

/** The names of `scripts` in the package.json of the base worktree, read bounded and never through a link; null when unreadable. */
export function baseScripts(root) {
  try {
    const file = join(root, '.worktrees/.base/package.json');
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 256 * 1024) return null;
    const scripts = JSON.parse(readFileSync(file, 'utf8'))?.scripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return null;
    return Object.keys(scripts).slice(0, 500);
  } catch {
    return null;
  }
}

/** The title with only characters that are inert in a shell and in Markdown (job.js `safeTitle` does the same for issue titles). */
const inertTitle = (title) => String(title ?? '').replace(/[\r\n]+/g, ' ').replace(/[^\p{L}\p{N} .,:_+#()/-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 100);

const TEXT = {
  en: {
    title: (branch, what) => `Fix the checks on ${branch}: ${what}`,
    intro: (branch, sha) => `The factory's checks fail on \`${branch}\` at \`${sha}\`, so every job whose checks also fail there waits for this issue.`,
    command: (shown, exit) => `Failing command: ${shown} (exit ${exit})`,
    step: (shown) => `Failing step: ${shown}`,
    exited: (exit) => `factory/checks.sh exited ${exit}`,
    goal: 'Goal',
    goalText: (branch) => `factory/checks.sh passes on ${branch} again, for every project.`,
    criteria: 'Acceptance criteria',
    ac1: 'sh factory/checks.sh exits 0 on this branch with no FACTORY_BASE set (every project).',
    ac2: 'no check, rule or test is removed, skipped or weakened to get there; a rule change says why.',
    reproduce: 'How to reproduce',
    reproduceText: (cmd, branch, sha) => `Run \`${cmd}\` on \`${branch}\` at \`${sha}\`: it runs the same checks and prints the failing command.`,
    found: (cmd, version, date) => `Found by ${cmd}${version ? ` (engine ${version})` : ''} on ${date}.`,
  },
  es: {
    title: (branch, what) => `Arreglar los checks en ${branch}: ${what}`,
    intro: (branch, sha) => `Los checks de la fábrica fallan en \`${branch}\` en \`${sha}\`, así que cada job cuyos checks también fallan ahí espera este issue.`,
    command: (shown, exit) => `Comando que falla: ${shown} (salida ${exit})`,
    step: (shown) => `Paso que falla: ${shown}`,
    exited: (exit) => `factory/checks.sh terminó con ${exit}`,
    goal: 'Objetivo',
    goalText: (branch) => `factory/checks.sh vuelve a pasar en ${branch}, para todos los proyectos.`,
    criteria: 'Criterios de aceptación',
    ac1: 'sh factory/checks.sh sale con 0 en esta rama sin FACTORY_BASE definida (todos los proyectos).',
    ac2: 'no se quita, omite ni debilita ningún check, regla o test para lograrlo; un cambio de regla explica por qué.',
    reproduce: 'Cómo reproducirlo',
    reproduceText: (cmd, branch, sha) => `Ejecuta \`${cmd}\` en \`${branch}\` en \`${sha}\`: corre los mismos checks e imprime el comando que falla.`,
    found: (cmd, version, date) => `Encontrado por ${cmd}${version ? ` (motor ${version})` : ''} el ${date}.`,
  },
  pt: {
    title: (branch, what) => `Corrigir os checks em ${branch}: ${what}`,
    intro: (branch, sha) => `Os checks da fábrica falham em \`${branch}\` em \`${sha}\`, então todo job cujos checks também falham ali espera esta issue.`,
    command: (shown, exit) => `Comando que falha: ${shown} (saída ${exit})`,
    step: (shown) => `Passo que falha: ${shown}`,
    exited: (exit) => `factory/checks.sh terminou com ${exit}`,
    goal: 'Objetivo',
    goalText: (branch) => `factory/checks.sh volta a passar em ${branch}, para todos os projetos.`,
    criteria: 'Critérios de aceitação',
    ac1: 'sh factory/checks.sh termina com 0 nesta branch sem FACTORY_BASE definida (todos os projetos).',
    ac2: 'nenhum check, regra ou teste é removido, ignorado ou enfraquecido para chegar lá; uma mudança de regra explica o motivo.',
    reproduce: 'Como reproduzir',
    reproduceText: (cmd, branch, sha) => `Execute \`${cmd}\` em \`${branch}\` em \`${sha}\`: roda os mesmos checks e imprime o comando que falha.`,
    found: (cmd, version, date) => `Encontrado por ${cmd}${version ? ` (motor ${version})` : ''} em ${date}.`,
  },
};

/**
 * The title and body of the fix issue, in `config.language`. Public text: the base sha, which command or step failed
 * and its exit code, and how to reproduce it. NEVER a line of the log (a public repository must not leak its output).
 * @param {{base: string, language?: string}} config
 * @param {{sha: string, exit: number|null, command: string|null}} record the failing check
 * @param {{engineCommand?: string, version?: string|null, date?: string}} [options]
 */
export function issueText(config, record, { engineCommand: command = engineCommand('base'), version = engineVersion(), date = new Date().toISOString().slice(0, 10), scripts = null } = {}) {
  const t = TEXT[configLanguage(config)];
  const { branch } = baseRef(config);
  const sha = short(record.sha);
  const shownCommand = publicCommand(record.command, scripts);
  const exit = record.exit ?? '?';
  return {
    title: inertTitle(t.title(branch, shownCommand ?? 'factory/checks.sh')) || 'Fix the checks',
    body: [
      t.intro(branch, sha),
      '',
      shownCommand ? t.command(span(shownCommand), exit) : t.step(span(t.exited(exit))),
      '',
      `## ${t.goal}`,
      '',
      t.goalText(branch),
      '',
      `## ${t.criteria}`,
      '',
      `- AC-1: ${t.ac1}`,
      `- AC-2: ${t.ac2}`,
      '',
      `## ${t.reproduce}`,
      '',
      t.reproduceText(command, branch, sha),
      '',
      t.found(command, version, date),
      '',
    ].join('\n'),
  };
}

const ghFailure = (what, res) => `${what} failed: ${(res.stderr || res.error?.message || '').trim().split('\n').slice(-1)[0] || `exit ${res.status}`}`;

/** The open issues that carry the base-fix label, lowest number first. */
function openFixIssues(gh, root) {
  const res = run(gh, ['issue', 'list', '--label', BASE_FIX_LABEL, '--state', 'open', '--json', 'number', '--limit', '20'], { cwd: root });
  if (res.status !== 0) throw new Error(`${ghFailure('gh issue list', res)}`);
  let list;
  try {
    list = JSON.parse(res.stdout);
  } catch {
    throw new Error('gh issue list printed something that is not JSON');
  }
  return (Array.isArray(list) ? list : []).map((i) => i?.number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
}

/**
 * The one open issue that fixes the base: the lowest open one that carries `factory:base-fix`, or a new one created with the
 * labels `factory` and `factory:base-fix`. After a create it lists again, so two machines that raced end up on the same issue.
 * @returns {{number: number, created: boolean}}
 */
export function ensureFixIssue(root, config, record, { gh = process.env.FACTORY_GH || 'gh', date, version } = {}) {
  const open = openFixIssues(gh, root);
  if (open.length) return { number: open[0], created: false };
  const { title, body } = issueText(config, record, { scripts: baseScripts(root), ...(date ? { date } : {}), ...(version !== undefined ? { version } : {}) });
  const dir = mkdtempSync(join(tmpdir(), 'factory-base-fix-'));
  let made;
  try {
    const file = join(dir, 'body.md');
    writeFileSync(file, body);
    made = run(gh, ['issue', 'create', '--title', title, '--body-file', file, '--label', 'factory', '--label', BASE_FIX_LABEL], { cwd: root });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (made.status !== 0) throw new Error(`${ghFailure('gh issue create', made)}; the labels may be missing: run /eminzo-factory setup`);
  const mine = Number(/\/issues\/(\d+)\s*$/.exec(made.stdout ?? '')?.[1]);
  const after = openFixIssues(gh, root);
  const number = after[0] ?? (Number.isInteger(mine) && mine > 0 ? mine : null);
  if (number === null) throw new Error('gh created the issue but its number could not be read');
  if (Number.isInteger(mine) && mine > 0 && number !== mine) {
    // Another machine's issue is the lower one: close ours as its duplicate (argv only). Best effort: a failed close leaves a duplicate a person can close.
    run(gh, ['issue', 'close', String(mine), '--comment', `Duplicate of #${number}`], { cwd: root });
  }
  return { number, created: number === mine };
}

/**
 * Marks a cached FAIL as confirmed by a second, fresh run, without touching its time (the TTL counts from the check). A confirmed
 * FAIL is not confirmed again for the next job. Best effort.
 */
export function markConfirmed(root, key, config) {
  return updateRecord(root, key, (rec) => ({ ...rec, confirmed: true }), config);
}

function updateRecord(root, key, change, config) {
  try {
    const dir = ensureStateDir(root);
    // The same lock age as the check itself (it follows checks.base_timeout_minutes): a live holder is never robbed by a writer.
    const lock = takeLock(dir, Math.min(10_000, envNumber('FACTORY_BASE_LOCK_WAIT_MS', 10_000)), Math.min(100, envNumber('FACTORY_BASE_LOCK_POLL_MS', 100)), lockAge(config ?? loadConfig(root)));
    if (!lock.ok) return false;
    try {
      const state = readState(root);
      if (state.full?.key === key) state.full = change(state.full);
      if (state.results[key]) state.results[key] = change(state.results[key]);
      writeAtomic(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
      return true;
    } finally {
      lock.release();
    }
  } catch {
    return false;
  }
}

/** Remembers the fix issue on the check that found the failure (the last full check and its cached result). Best effort. */
export function setFixIssue(root, key, number, config) {
  return updateRecord(root, key, (rec) => ({ ...rec, fix_issue: number }), config);
}

// ---- the command ------------------------------------------------------------------------------------

/** The `base:` line of an answer. */
export function answerLine(r, base) {
  const where = r.sha ? short(r.sha) : base;
  if (r.status === 'PASS') return `base: PASS ${where}`;
  if (r.status === 'FAIL') return `base: FAIL ${where}: ${r.command ?? `factory/checks.sh exited ${r.exit}`}`;
  return `base: UNKNOWN ${where}: ${r.reason}`;
}

/** `base fix-issue`: only for a base whose last check failed and has not moved since. */
function fixIssueMain() {
  const root = factoryRoot();
  const config = loadConfig(root);
  const { base, remote } = baseRef(config);
  const last = readState(root).full;
  if (!last || last.status !== 'FAIL') throw new Refused(`the last check of ${base} did not fail`);
  const tip = resolveTip(root, base, remote);
  if (tip.error) throw new Error(tip.error);
  if (tip.sha !== last.sha) throw new Refused(`${base} moved since; run ${engineCommand('base')} again`);
  const { number, created } = ensureFixIssue(root, config, last);
  setFixIssue(root, last.key, number, config);
  process.stdout.write(`fix: #${number} ${created ? 'created' : 'open'}\n`);
  return 0;
}

function main(args) {
  if (args.length === 1 && args[0] === 'fix-issue') return fixIssueMain();
  if (args.length) throw new Usage('base [fix-issue]');
  const root = factoryRoot();
  const config = loadConfig(root);
  const result = checkBase(root, { byHand: true, config });
  process.stdout.write(`${answerLine(result, config.base)}\n`);
  if (result.report) process.stdout.write(`report: factory/jobs/.base/${result.report}\n`);
  if (result.writeError) process.stderr.write(`base: the answer could not be saved: ${result.writeError}\n`);
  return result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 1 : EXIT_UNKNOWN;
}

if (isMain(import.meta.url)) runCli(main);
