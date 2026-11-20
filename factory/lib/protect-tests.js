// factory/bin/protect-tests: the builder's PreToolUse hook (Claude Code). It reads the tool call as
// JSON on stdin and refuses an Edit, Write, MultiEdit or NotebookEdit that would
//   1. change a path listed in the MAIN checkout's factory/config.json `protected_tests`, or
//   2. write anywhere in the MAIN checkout except this job's `factory/jobs/<id>/build.md` and `plan.md`
//      (the builder works in its worktree; the main checkout's config, engine and checks stay out of reach).
// It refuses by exiting 2 with the reason on stderr (the documented "block" form of a hook: Claude gets
// stderr as the reason and the call does not run).
//
// The target path is resolved like the kernel does: symlinks first (the leaf included), then `..`, and
// relative to the hook's cwd. It is then taken relative to the git work tree that holds it, so the same
// list guards the main checkout and every job worktree. Protected paths are compared case-insensitively
// (macOS and Windows file systems are): a false deny is harmless, a miss is not. The gate needs no such
// care: git reports the path as the index spells it. Everything else is allowed, including files outside
// any repository.
//
// Scope: only the file-editing tools. A Bash command can still write a file; the gate (which fails the
// round on a changed protected test) is the backstop. A hook that cannot decide (bad JSON, no git, no
// config) allows and prints one stderr line saying why. Through the installed CLI a stale or partial
// install makes `eminzo` exit 1, which Claude treats as non-blocking: the protection is then off until
// `eminzo install` is run again; the gate still applies.
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { JOB_ID, isMain, run } from './util.js';

export const REASON = 'protected test; the gate fails the round';
export const MAIN_REASON = "the main checkout is read-only for the builder except this job's build.md and plan.md";
const FILE_KEYS = ['file_path', 'notebook_path'];
const JOB_FILE = /^factory\/jobs\/(\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*)\/(?:build|plan)\.md$/;

/** `target` as an absolute path with every symlink resolved before `..` is applied; the file may not exist. */
export function realResolve(cwd, target) {
  let cur = isAbsolute(target) ? sep : cwd;
  try {
    cur = realpathSync(cur);
  } catch {
    cur = resolve(cur);
  }
  for (const part of target.split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') { cur = dirname(cur); continue; }
    const next = join(cur, part);
    try {
      cur = lstatSync(next).isSymbolicLink() ? realpathSync(next) : next;
    } catch {
      cur = next; // missing (or a dangling/looping link): keep the name
    }
  }
  return cur;
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** The nearest existing folder at or above `path`. */
function existingDir(path) {
  let dir = dirname(path);
  while (!isDir(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

const slashes = (p) => p.split(sep).join('/');
const normalize = (p) => relative('/', resolve('/', String(p))).split('\\').join('/');

/** `{ top, main }` (real paths) of the repository holding `dir`, `null` when it is not in one, or `{ error }`. */
function repoOf(dir) {
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.error) return { error: `git could not run (${top.error.message})` };
  if (top.status !== 0) return null;
  // No --path-format: that flag needs git 2.31. The output is relative to `dir` or absolute.
  const common = run('git', ['rev-parse', '--git-common-dir'], { cwd: dir });
  if (common.status !== 0) return { error: 'git rev-parse --git-common-dir failed' };
  try {
    return { top: realpathSync(top.stdout.trim()), main: dirname(realpathSync(resolve(dir, common.stdout.trim()))) };
  } catch (err) {
    return { error: `cannot resolve the repository (${err.message})` };
  }
}

/** The job id of the session: the branch `factory/<id>` or the worktree folder `<id>` at cwd, or null. */
function jobIdAt(cwd, main) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || !isDir(cwd)) return null;
  const repo = repoOf(cwd);
  if (!repo || repo.error || repo.top === main) return null;
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const fromBranch = /^factory\/(.+)$/.exec(branch.stdout?.trim() ?? '')?.[1];
  if (fromBranch && JOB_ID.test(fromBranch)) return fromBranch;
  return JOB_ID.test(basename(repo.top)) ? basename(repo.top) : null;
}

/**
 * The verdict for one tool call: `{ deny: reason }` or `{ allow: true, note? }` (a note says why the hook could not decide).
 * Never throws.
 */
export function decide(input) {
  const target = FILE_KEYS.map((k) => input?.tool_input?.[k]).find((v) => typeof v === 'string' && v);
  if (!target) return { allow: true };
  const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) && isDir(input.cwd) ? input.cwd : process.cwd();
  const file = realResolve(cwd, target);
  const repo = repoOf(existingDir(file));
  if (!repo) return { allow: true }; // not in a repository: nothing to protect
  if (repo.error) return { allow: true, note: repo.error };
  let config;
  try {
    config = JSON.parse(readFileSync(join(repo.main, 'factory/config.json'), 'utf8'));
  } catch (err) {
    return { allow: true, note: `no readable factory/config.json in the main checkout (${err.code ?? err.message})` };
  }
  const rel = slashes(relative(repo.top, file));
  if (rel.startsWith('..')) return { allow: true };
  const guarded = (Array.isArray(config?.protected_tests) ? config.protected_tests : [])
    .filter((p) => typeof p === 'string').map((p) => normalize(p).toLowerCase());
  if (guarded.includes(rel.toLowerCase())) return { deny: REASON };
  if (repo.top === repo.main) {
    const own = JOB_FILE.exec(rel);
    const jobId = jobIdAt(input.cwd, repo.main);
    if (!own || (jobId && own[1] !== jobId)) return { deny: MAIN_REASON };
  }
  return { allow: true };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write('protect-tests: not enforced: the hook input is not JSON\n');
    return 0;
  }
  const verdict = decide(input);
  if (verdict.deny) {
    process.stderr.write(`${verdict.deny}\n`);
    return 2;
  }
  if (verdict.note) process.stderr.write(`protect-tests: not enforced: ${verdict.note}\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
