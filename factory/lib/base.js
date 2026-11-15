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
//   lock                  one check at a time ({pid, started}; stale when the pid is dead or after 3 hours)
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
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checksInputs } from './check-stamp.js';
import { runChecks } from './gate.js';
import { LOG_LINES, capLog, engineLines, formatSpan } from './report.js';
import { prepareCommand } from './stacks.js';
import { Usage, baseRef, engineVersion, factoryRoot, isMain, loadConfig, now, readText, run, runCli, tail, writeAtomic } from './util.js';

export const MAX_RESULTS = 50;
export const STATE_VERSION = 1;
export const EXIT_UNKNOWN = 3;
const STATUSES = ['PASS', 'FAIL', 'UNKNOWN'];
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const KEY = /^[0-9a-f]{64}$/;
const MAX_STATE_BYTES = 256 * 1024;
const LOCK_STALE_MS = 3 * 60 * 60 * 1000;
const PREPARE_TIMEOUT_MS = 30 * 60 * 1000;
const TRACE = /^\++\[factory\] (.*)$/;
const COMMAND_MAX = 300;

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
  const plain = (dir) => {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && mine(st) && (process.platform === 'win32' || (st.mode & 0o022) === 0);
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

const isRecord = (r) => r && typeof r === 'object' && !Array.isArray(r) && KEY.test(r.key ?? '') && SHA.test(r.sha ?? '') && STATUSES.includes(r.status);

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

function lockIsStale(file) {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return true; // a link or a folder is never a lock this engine wrote
    const held = JSON.parse(readFileSync(file, 'utf8'));
    const started = Date.parse(held?.started);
    if (!Number.isInteger(held?.pid) || !Number.isFinite(started)) return Date.now() - st.mtimeMs > LOCK_STALE_MS;
    return !alive(held.pid) || Date.now() - started > LOCK_STALE_MS;
  } catch {
    return false; // half written or gone: look again
  }
}

/** Takes factory/jobs/.base/lock, waiting for a live holder. @returns {{ok: true, release: () => void}|{ok: false, reason: string}} */
function takeLock(dir, waitMs, pollMs) {
  const file = join(dir, 'lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, started: now() }), { flag: 'wx', mode: 0o600 });
      return { ok: true, release: () => { try { if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file); } catch { /* gone */ } } };
    } catch (err) {
      if (err.code !== 'EEXIST') return { ok: false, reason: `cannot take the lock: ${err.message}` };
    }
    if (lockIsStale(file)) {
      try {
        const away = `${file}.stale.${process.pid}`;
        renameSync(file, away);
        rmSync(away, { force: true });
      } catch { /* someone else took it over */ }
      continue;
    }
    if (Date.now() >= deadline) return { ok: false, reason: 'another base check is still running' };
    sleep(pollMs);
  }
}

// ---- git and the worktree -------------------------------------------------------------------------

/** The commit `ref` points at, after `git fetch <remote>` (a failed fetch keeps the local ref). */
function resolveTip(root, base, remote) {
  if (remote.startsWith('-') || base.startsWith('-')) return { error: `the base ${base} is not a valid ref` };
  git(root, ['fetch', remote], { timeout: 120_000 });
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
  delete env.NODE_TEST_CONTEXT;
  const [cmd, args] = custom ? ['sh', ['-c', command]] : [command.split(/\s+/)[0], command.split(/\s+/).slice(1)];
  const started = Date.now();
  const res = run(cmd, args, { cwd: path, env, timeout: envNumber('FACTORY_BASE_PREPARE_TIMEOUT_MS', PREPARE_TIMEOUT_MS), stdio: ['ignore', 'pipe', 'pipe'] });
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
  const cached = () => (useCache ? readState(root).results[key] : undefined);
  const hit = cached();
  if (hit) return { ...hit, fromCache: true };

  const lock = takeLock(dir, envNumber('FACTORY_BASE_LOCK_WAIT_MS', 20 * 60 * 1000), envNumber('FACTORY_BASE_LOCK_POLL_MS', 2000));
  if (!lock.ok) return unknown(lock.reason, sha, { key });
  try {
    const again = cached(); // another check may have answered while this one waited
    if (again) return { ...again, fromCache: true };
    return runCheck(root, dir, { base, config, prepare, wanted, identity });
  } finally {
    lock.release();
  }
}

function runCheck(root, dir, { base, prepare, wanted, identity }) {
  const record = (fields) => ({ ...identity, command: null, reason: null, exit: null, at: now(), span_ms: 0, report: `${identity.key.slice(0, 12)}/checks.md`, fix_issue: null, ...fields });
  const finish = (rec, extras) => {
    const folder = join(dir, identity.key.slice(0, 12));
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeAtomic(join(dir, rec.report), reportText(rec, { base, prepare: prepare.command, scope: wanted, ...extras }));
      writeAtomic(join(folder, 'checks.log'), capLog(extras.log ?? ''));
      writeAtomic(join(dir, 'state.json'), `${JSON.stringify(recordResult({ ...readState(root), base }, rec), null, 2)}\n`);
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
  const checks = runChecks(root, checkout.path, { trace: true, ...(wanted ? { scope: wanted } : {}) });
  const spanMs = Date.now() - started;
  const log = withoutTrace(checks.output);
  const base_ = { span_ms: spanMs };
  if (checks.failedToStart) return finish(record({ ...base_, status: 'UNKNOWN', reason: clean(`factory/checks.sh did not start: ${tail(checks.output, 1)}`) }), { log, prepareRun });
  if (checks.signal) return finish(record({ ...base_, status: 'UNKNOWN', reason: `factory/checks.sh was killed by ${checks.signal}` }), { log, prepareRun });
  if (checks.code === 126 || checks.code === 127) return finish(record({ ...base_, status: 'UNKNOWN', exit: checks.code, reason: `factory/checks.sh could not run (exit ${checks.code})` }), { log, prepareRun });
  if (checks.code === 0) return finish(record({ ...base_, status: 'PASS', exit: 0 }), { log, prepareRun });
  return finish(record({ ...base_, status: 'FAIL', exit: checks.code, command: failingCommand(checks.output) }), { log, prepareRun });
}

// ---- the command ------------------------------------------------------------------------------------

/** The `base:` line of an answer. */
export function answerLine(r, base) {
  const where = r.sha ? short(r.sha) : base;
  if (r.status === 'PASS') return `base: PASS ${where}`;
  if (r.status === 'FAIL') return `base: FAIL ${where}: ${r.command ?? `factory/checks.sh exited ${r.exit}`}`;
  return `base: UNKNOWN ${where}: ${r.reason}`;
}

function main(args) {
  if (args.length) throw new Usage('base');
  const root = factoryRoot();
  const config = loadConfig(root);
  const result = checkBase(root, { byHand: true, config });
  process.stdout.write(`${answerLine(result, config.base)}\n`);
  if (result.report) process.stdout.write(`report: factory/jobs/.base/${result.report}\n`);
  if (result.writeError) process.stderr.write(`base: the answer could not be saved: ${result.writeError}\n`);
  return result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 1 : EXIT_UNKNOWN;
}

if (isMain(import.meta.url)) runCli(main);
