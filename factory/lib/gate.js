// factory/bin/gate <job-id> [--out <file>]: the deterministic gate. Runs the MAIN
// checkout's factory/checks.sh inside the job's worktree (never the worktree's own
// copy), fails if the branch modified, deleted or renamed a protected test or left
// uncommitted changes, and writes round-N/checks.md plus round-N/context.md for the
// reviewers. Exit 0 on PASS, 1 on FAIL. The command line is gate-cli.js (it also needs job.js, which imports this module); running this file starts it.
import { mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { checksInputs, headSha, mergeBase } from './check-stamp.js';
import { HELD, checksLockSetting, takeChecksLock } from './checks-lock.js';
import { withImplied } from './intake.js';
import { projectMapLines, projectMapStatus } from './project-map.js';
import { LOG_LINES, capLog, engineLines, formatSpan, summarySentence, table } from './report.js';
import { roundContext } from './round-context.js';
import { visualStatus } from './visual-analysis.js';
import { baseRef, engineDir, engineVersion, isMain, loadConfig, readText, run, runCli, tail, writeAtomic } from './util.js';

function visualLines(visual) {
  const label = visual.status === 'ERROR' ? 'ERROR (not blocking)' : visual.status;
  return [`Visual check: ${label}`, ...(visual.reason && visual.status !== 'PASS' && visual.status !== 'FAIL' ? [`Visual reason: ${visual.reason}`] : [])];
}

/** The `Reason:` line of a visual.md, or ''. */
function visualReason(text) {
  const m = /^Reason: (.*)$/m.exec(text ?? '');
  return m ? m[1].trim() : '';
}

/**
 * The visual check for a ui job whose repo declares config.visual: the engine's bin/visual (the
 * main checkout's factory/bin/visual, or the installed CLI's) writes visual.md next to the checks report. Only `VISUAL: FAIL` blocks.
 * `ERROR` (and a runner that crashes, times out or writes no valid report) is an environment
 * problem the builder cannot fix: it is reported and passes.
 * @returns {{status: string, text: string, reason: string}|null} null when the check does not apply
 */
export function runVisualCheck(root, config, job, checksFile) {
  const surfaces = job.intake?.surfaces;
  if (!config.visual || !Array.isArray(surfaces) || !withImplied(surfaces).includes('ui')) return null;
  const file = join(dirname(checksFile), 'visual.md');
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { force: true }); // a stale report must never decide this run
  const budget = Number.isInteger(config.visual.budget_ms) ? config.visual.budget_ms : 120000;
  const readyWait = Number.isInteger(config.visual.ready_timeout_ms) ? config.visual.ready_timeout_ms : 30000;
  const env = { ...process.env, FACTORY_ROOT: root };
  delete env.NODE_TEST_CONTEXT;
  const res = run('sh', [join(engineDir(root), 'bin', 'visual'), job.id, '--out', file], { cwd: root, env, timeout: budget + readyWait + 60000 });
  const text = readText(file);
  const status = visualStatus(text);
  if (status && (status === 'FAIL' || res.status === 0)) return { status, text, reason: visualReason(text) };
  const detail = tail(`${res.stderr ?? ''}${res.error ? `\n${res.error.message}` : ''}` || `exit ${res.status}`, 20);
  const reason = `the visual runner produced no usable report (exit ${res.status}): ${detail.replace(/\s+/g, ' ')}`.slice(0, 600);
  return { status: 'ERROR', text: `VISUAL: ERROR\n\nReason: ${reason}\n`, reason };
}

const isSha = (v) => typeof v === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v);

const NO_LOCK = Object.freeze({ held: false, ranAnyway: false, childFile: null, waitedMs: 0, waitedFor: null, release() {} });

/** The repository's checks lock (`checks.lock` in factory/config.json), or no lock when the repository turned it off. */
function takeLock(root, label, hooks) {
  let setting = 'repo';
  try { setting = checksLockSetting(loadConfig(root)); } catch { /* no readable config: the default */ }
  return setting === 'off' ? NO_LOCK : takeChecksLock(process.env, { root, label, ...hooks });
}

/**
 * Runs <root>/factory/checks.sh with `cwd` as the working folder; stdout and stderr interleaved.
 * With `pidFile`, the shell writes its PID there first (the same process then runs checks.sh), so a
 * caller can tell whether checks it started are still running after it died.
 * The checks see FACTORY_CHECK_MODE: `full` unless the caller passes mode `focused` together with
 * `changedFiles` (the absolute path of a file listing the changed paths, one per line), which
 * becomes FACTORY_CHANGED_FILES. Whatever the environment already holds for either variable is
 * dropped.
 * `scope` says what the job touched, for a checks.sh that checks only that: `scope.base` (the commit
 * the job's branch left the base at) becomes FACTORY_BASE and `scope.head` (the commit under test)
 * becomes FACTORY_HEAD. Each is set only from a full-length hex sha; inherited values are always
 * dropped, and without a scope every project is checked.
 * With `trace` the script runs under `sh -x` with the prefix `+[factory] `, so the base check can name
 * the command that failed (display text only; the trace is on stderr, merged into `output`).
 * `timeoutMs` (SIGKILL when it runs out), `dropEnv` (names to remove) and `dropFactoryEnv` (every FACTORY_* but FACTORY_ROOT) are for the
 * base check, which runs unattended on a machine that holds secrets.
 * A full run takes the repository's checks lock (checks-lock.js; `label` says who asks, for the one that has to wait), so
 * only one full suite of a repository runs at a time; a focused run never waits. `waitedMs` is how long it waited for
 * another run (`waitedFor` names that run; `onWait` and `onAcquire` let the caller show it, see takeChecksLock) and is not time the checks took; `timeoutMs` counts from after the wait.
 * @returns {{code: number, output: string, signal: string|null, failedToStart: boolean, timedOut: boolean, waitedMs: number, waitedFor: string|null}} `code` is 1 when
 *   the shell has no exit status (a signal, or it did not start); the base check tells those apart.
 */
export function runChecks(root, cwd, { pidFile, mode = 'full', changedFiles, scope, trace = false, timeoutMs, dropEnv = [], dropFactoryEnv = false, label, onWait, onAcquire } = {}) {
  const env = { ...process.env };
  for (const name of dropEnv) delete env[name];
  if (dropFactoryEnv) for (const name of Object.keys(env)) if (name.startsWith('FACTORY_') && name !== 'FACTORY_ROOT') delete env[name];
  delete env.NODE_TEST_CONTEXT; // a gate started from a test run must not report into it
  delete env.FACTORY_CHANGED_FILES;
  delete env.FACTORY_BASE;
  delete env.FACTORY_HEAD;
  if (isSha(scope?.base)) env.FACTORY_BASE = scope.base;
  if (isSha(scope?.head)) env.FACTORY_HEAD = scope.head;
  const focused = mode === 'focused' && typeof changedFiles === 'string';
  env.FACTORY_CHECK_MODE = focused ? 'focused' : 'full';
  if (focused) env.FACTORY_CHANGED_FILES = changedFiles;
  if (trace) env.PS4 = '+[factory] ';
  const sh = trace ? 'sh -x' : 'sh';
  // The shell writes its PID to every file it is given (the caller's pidFile, the lock's), then becomes checks.sh.
  const script = `for f in "$@"; do printf "%s\\n" "$$" > "$f"; done; exec ${sh} "$0" 2>&1`;
  // Only a caller that passes a timeout gets one (the base check): the gate's own and the nudge's behavior do not change.
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeout: timeoutMs, killSignal: 'SIGKILL' } : {};
  const lock = focused ? NO_LOCK : takeLock(root, label, { onWait, onAcquire });
  if (lock.held || lock.ranAnyway || process.env[HELD]) env[HELD] = '1'; // a checks run started from inside these checks does not wait for them (nor does it wait again when this run gave up waiting)
  let res;
  try {
    // The time limit starts here, after the wait.
    res = run('sh', ['-c', script, join(root, 'factory/checks.sh'), ...(pidFile ? [pidFile] : []), ...(lock.held ? [lock.childFile] : [])], { cwd, env, ...limit });
  } finally {
    lock.release();
  }
  const output = `${res.stdout ?? ''}${res.error ? `\n${res.error.message}` : ''}`;
  const timedOut = res.error?.code === 'ETIMEDOUT';
  return { code: res.status ?? 1, output, signal: res.signal ?? null, failedToStart: Boolean(res.error) && !timedOut, timedOut, waitedMs: lock.waitedMs, waitedFor: lock.waitedFor };
}

/** Protected test paths the branch changed since it left `base`, or an error. */
export function protectedChanges(worktree, base, protectedTests) {
  const mb = run('git', ['merge-base', base, 'HEAD'], { cwd: worktree });
  if (mb.status !== 0) return { error: `git merge-base ${base} HEAD failed: ${(mb.stderr || mb.error?.message || '').trim()}`, paths: [] };
  const diff = run('git', ['diff', '--name-status', mb.stdout.trim(), 'HEAD'], { cwd: worktree });
  if (diff.status !== 0) return { error: `git diff failed: ${(diff.stderr || '').trim()}`, paths: [] };
  const guarded = new Set(protectedTests);
  const paths = [];
  for (const line of diff.stdout.split('\n')) {
    const [status, path] = line.split('\t');
    if (status && /^[MDRT]/.test(status) && guarded.has(path)) paths.push(`${status[0]} ${path}`);
  }
  return { error: null, paths };
}

/** Uncommitted or untracked (not ignored) paths: the checks would test a tree the branch doesn't hold. */
export function uncommitted(worktree) {
  const res = run('git', ['status', '--porcelain'], { cwd: worktree });
  if (res.status !== 0) return [`git status failed: ${(res.stderr || res.error?.message || '').trim()}`];
  return res.stdout.split('\n').filter(Boolean).map((line) => `uncommitted: ${line.slice(3)}`);
}

/**
 * Runs the gate for a job and writes the report.
 * @returns {boolean} true on PASS
 */
export function gate(root, job, outFile, { onStart, onWait, onAcquire } = {}) {
  try { onStart?.(); } catch { /* a hook never fails the gate */ }
  const config = loadConfig(root);
  const { base } = baseRef(config);
  const dirty = uncommitted(job.worktree); // before the checks, which may write files
  const head = headSha(job.worktree);
  const inputs = checksInputs(root);
  const started = Date.now();
  // A job that fixes the base is judged on everything: its goal is the whole base.
  const checksBase = job.base_fix ? null : mergeBase(job.worktree, base);
  const checks = runChecks(root, job.worktree, { label: `gate ${job.id}`, onWait, onAcquire, scope: job.base_fix ? undefined : { base: checksBase ?? undefined, head: head ?? undefined } });
  const spanMs = Math.max(0, Date.now() - started - checks.waitedMs); // the wait for another run's checks is not the checks' time
  const guard = protectedChanges(job.worktree, base, config.protected_tests ?? []);
  const visual = checks.code === 0 ? runVisualCheck(root, config, job, outFile) : null;
  const visualSkippedForChecks = checks.code !== 0 && config.visual && withImplied(job.intake?.surfaces).includes('ui');
  const pass = checks.code === 0 && !guard.error && guard.paths.length === 0 && dirty.length === 0 && visual?.status !== 'FAIL';
  const log = tail(checks.output, LOG_LINES);
  const longest = Math.max(0, ...(log.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const violations = guard.error ? [guard.error] : guard.paths;
  const logFile = outFile.replace(/\.md$/, '') + '.log';
  writeAtomic(logFile, capLog(checks.output)); // stays in the job folder: see capLog
  const visualCell = visual ? (visual.status === 'ERROR' ? 'ERROR (not blocking)' : visual.status) : null;
  writeAtomic(outFile, [
    `GATE: ${pass ? 'PASS' : 'FAIL'}`,
    ...engineLines(engineVersion()),
    '',
    summarySentence({ pass, spanMs, head, code: checks.code, violations: violations.length, dirty: dirty.length, visualFailed: visual?.status === 'FAIL' }),
    '',
    `Checks exit code: ${checks.code}`,
    `Tested head: ${head ?? 'unknown'}`,
    `Checks base: ${checksBase ?? 'none'}`,
    `Checks inputs: ${inputs}`,
    ...(checks.waitedFor ? [`Waited for the checks lock: ${formatSpan(checks.waitedMs)} (${checks.waitedFor})`] : []),
    `Protected test violations: ${violations.length ? '' : 'none'}`,
    ...violations.map((v) => `- ${v}`),
    `Uncommitted changes: ${dirty.length ? 'commit them; the gate tests only committed work' : 'none'}`,
    ...dirty.slice(0, 20).map((v) => `- ${v}`),
    ...(visual ? visualLines(visual) : visualSkippedForChecks ? ['Visual check: not run (checks failed)'] : []),
    ...projectMapLines(projectMapStatus(job.worktree, base)),
    '',
    '## Steps',
    '',
    ...table(['Step', 'Result'], [
      ['Checks (full mode)', `exit ${checks.code} in ${formatSpan(spanMs)}`],
      ['Protected tests', violations.length ? `${violations.length} problem${violations.length === 1 ? '' : 's'}` : 'none changed'],
      ['Working tree', dirty.length ? 'uncommitted changes' : 'clean'],
      ...(visualCell ? [['Visual check', visualCell]] : []),
    ]),
    ...(visual?.status === 'FAIL' ? ['', '## Visual findings', '', ...tail(visual.text, 80).split('\n')] : []),
    '',
    `## Log (last ${LOG_LINES} lines)`,
    '',
    `Full log: \`${basename(logFile)}\``,
    '',
    fence,
    log,
    fence,
    '',
  ].join('\n'));
  writeRoundContext(root, config, job, outFile);
  return pass;
}

/** round-N/context.md for the reviewers (see round-context.js). Informational: it never fails the gate. */
function writeRoundContext(root, config, job, outFile) {
  try {
    writeAtomic(join(dirname(outFile), 'context.md'), roundContext(root, config, job));
  } catch (err) {
    process.stderr.write(`gate: context.md not written: ${err.message}\n`);
  }
}

// `eminzo gate <id>` runs this file (the CLI runs lib/<command>.js), and so does factory/bin/gate. The command line lives in
// gate-cli.js because it needs job.js, which imports this module: a static import here would be a load-time cycle, so it is
// loaded with import() once this module is done.
if (isMain(import.meta.url)) {
  import('./gate-cli.js').then(({ main }) => runCli(main), (err) => { process.stderr.write(`error: ${err.message}\n`); process.exitCode = 1; });
}
