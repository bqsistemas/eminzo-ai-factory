// factory/bin/protect-tests: the builder's PreToolUse hook (Claude Code). It reads the tool call as
// JSON on stdin and refuses an Edit, Write, MultiEdit or NotebookEdit of a path listed in the
// MAIN checkout's factory/config.json `protected_tests`, by exiting 2 with the reason on stderr
// (the documented "block" form of a hook: Claude gets stderr as the reason and the call does not run).
//
// The path is resolved against the hook's cwd, then taken relative to the git work tree that
// holds the file, so the same list guards the main checkout and every job worktree. Everything
// else is allowed, including files outside any repository. A hook that cannot decide (bad JSON,
// no config, no git) allows: the gate stays the backstop and fails the round on a changed protected test.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { isMain, run } from './util.js';

export const REASON = 'protected test; the gate fails the round';
const FILE_KEYS = ['file_path', 'notebook_path'];

/** `abs` with its nearest existing ancestor resolved through symlinks (the file itself may not exist yet). */
function realPath(abs) {
  let ancestor = dirname(abs);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  return { dir: realpathSync(ancestor), file: join(realpathSync(ancestor), relative(ancestor, abs)) };
}

/** `.`/`..`-free, slash-separated repo-relative form of a configured path. */
const normalize = (p) => relative('/', resolve('/', String(p))).split('\\').join('/');

/** True when the call edits a protected test. Never throws. */
export function isProtected(input) {
  const target = FILE_KEYS.map((k) => input?.tool_input?.[k]).find((v) => typeof v === 'string' && v);
  if (!target) return false;
  const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : process.cwd();
  const { dir, file } = realPath(resolve(cwd, target));
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
  if (top.status !== 0 || common.status !== 0) return false;
  let config;
  try {
    config = JSON.parse(readFileSync(join(dirname(common.stdout.trim()), 'factory/config.json'), 'utf8'));
  } catch {
    return false;
  }
  const guarded = Array.isArray(config?.protected_tests) ? config.protected_tests.filter((p) => typeof p === 'string').map(normalize) : [];
  const rel = relative(realpathSync(top.stdout.trim()), file).split('\\').join('/');
  return !rel.startsWith('..') && guarded.includes(rel);
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }
  if (!isProtected(input)) return 0;
  process.stderr.write(`${REASON}\n`);
  return 2;
}

if (isMain(import.meta.url)) process.exitCode = main();
