// factory/bin/gate <job-id> [--out <file>]: the deterministic gate. Runs the MAIN
// checkout's factory/checks.sh inside the job's worktree (never the worktree's own
// copy), fails if the branch modified, deleted or renamed a protected test or left
// uncommitted changes, and writes round-N/checks.md plus round-N/context.md for the
// reviewers. Exit 0 on PASS, 1 on FAIL.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { checksInputs, headSha } from './check-stamp.js';
import { withImplied } from './intake.js';
import { projectMapLines, projectMapStatus } from './project-map.js';
import { roundContext } from './round-context.js';
import { visualStatus } from './visual-analysis.js';
import { Usage, baseRef, engineDir, factoryRoot, isMain, jobDir, loadConfig, readText, run, runCli, tail, writeAtomic } from './util.js';

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

/**
 * Runs <root>/factory/checks.sh with `cwd` as the working folder; stdout and stderr interleaved.
 * With `pidFile`, the shell writes its PID there first (the same process then runs checks.sh), so a
 * caller can tell whether checks it started are still running after it died.
 */
export function runChecks(root, cwd, { pidFile } = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // a gate started from a test run must not report into it
  const script = pidFile ? 'printf "%s\n" "$$" > "$1"; exec sh "$0" 2>&1' : 'exec sh "$0" 2>&1';
  const res = run('sh', ['-c', script, join(root, 'factory/checks.sh'), ...(pidFile ? [pidFile] : [])], { cwd, env });
  const output = `${res.stdout ?? ''}${res.error ? `\n${res.error.message}` : ''}`;
  return { code: res.status ?? 1, output };
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
export function gate(root, job, outFile) {
  const config = loadConfig(root);
  const { base } = baseRef(config);
  const dirty = uncommitted(job.worktree); // before the checks, which may write files
  const head = headSha(job.worktree);
  const inputs = checksInputs(root);
  const checks = runChecks(root, job.worktree);
  const guard = protectedChanges(job.worktree, base, config.protected_tests ?? []);
  const visual = checks.code === 0 ? runVisualCheck(root, config, job, outFile) : null;
  const visualSkippedForChecks = checks.code !== 0 && config.visual && withImplied(job.intake?.surfaces).includes('ui');
  const pass = checks.code === 0 && !guard.error && guard.paths.length === 0 && dirty.length === 0 && visual?.status !== 'FAIL';
  const log = tail(checks.output, 200);
  const longest = Math.max(0, ...(log.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const violations = guard.error ? [guard.error] : guard.paths;
  writeAtomic(outFile, [
    `GATE: ${pass ? 'PASS' : 'FAIL'}`,
    '',
    `Checks exit code: ${checks.code}`,
    `Tested head: ${head ?? 'unknown'}`,
    `Checks inputs: ${inputs}`,
    `Protected test violations: ${violations.length ? '' : 'none'}`,
    ...violations.map((v) => `- ${v}`),
    `Uncommitted changes: ${dirty.length ? 'commit them; the gate tests only committed work' : 'none'}`,
    ...dirty.slice(0, 20).map((v) => `- ${v}`),
    ...(visual ? visualLines(visual) : visualSkippedForChecks ? ['Visual check: not run (checks failed)'] : []),
    ...projectMapLines(projectMapStatus(job.worktree, base)),
    ...(visual?.status === 'FAIL' ? ['', '## Visual findings', '', ...tail(visual.text, 80).split('\n')] : []),
    '',
    '## Log (last 200 lines)',
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

function main(args) {
  const [id, ...rest] = args;
  let out = null;
  if (rest.length === 2 && rest[0] === '--out') out = resolve(rest[1]);
  else if (rest.length) throw new Usage('gate <job-id> [--out <file>]');
  if (!id) throw new Usage('gate <job-id> [--out <file>]');
  const root = factoryRoot();
  const dir = jobDir(root, id);
  const text = readText(join(dir, 'job.json'));
  if (text === null) throw new Error(`no job ${id}`);
  const job = JSON.parse(text);
  if (!out) {
    if (!(job.round >= 1)) throw new Usage(`${id} has no build round yet`);
    out = join(dir, `round-${job.round}`, 'checks.md');
  }
  const pass = gate(root, job, out);
  process.stdout.write(`${id} GATE: ${pass ? 'PASS' : 'FAIL'}\n`);
  return pass ? 0 : 1;
}

if (isMain(import.meta.url)) runCli(main);
