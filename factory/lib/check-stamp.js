// Fingerprints that let the factory skip a check it already ran on exactly the same input.
// Shared by every provider: the nudge (Claude's Stop hook, Codex's manual call), the gate
// and the merge use the same functions, so a skip means the same thing everywhere.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_CONFIG, engineDir, installedEngine, run } from './util.js';

const SHA = /^[0-9a-f]{40,64}$/;
const INPUTS = /^sha256:[0-9a-f]{64}$/;

/** Every file directly in <dir>/<sub>, as [label, absolute path] with label `<prefix>/<sub>/<name>`, sorted; [] when it cannot be listed. */
function filesIn(dir, sub, prefix) {
  try {
    return readdirSync(join(dir, sub), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()
      .map((name) => [`${prefix}/${sub}/${name}`, join(dir, sub, name)]);
  } catch {
    return [];
  }
}

/**
 * Everything that decides a check's answer besides the worktree, hashed together, all from
 * the main checkout (the one the gate runs): checks.sh, config.json (protected tests, visual
 * block), config.local.json only when it exists (so a root without it hashes exactly as
 * before that file existed) and the engine's lib and bin: the repo's factory/lib and
 * factory/bin, or the installed CLI's (labelled engine/lib, engine/bin). Paths are hashed by
 * label, never by absolute path, so the builder's worktree copy of the engine and the main
 * checkout's agree. A change to any of these files, or creating or deleting config.local.json,
 * means a pass recorded before it no longer counts.
 */
export function checksInputs(root) {
  const hash = createHash('sha256');
  const local = existsSync(join(root, LOCAL_CONFIG)) ? [LOCAL_CONFIG] : [];
  const repoFiles = ['factory/checks.sh', 'factory/config.json', ...local].map((rel) => [rel, join(root, rel)]);
  const prefix = installedEngine() ? 'engine' : 'factory';
  const engine = engineDir(root);
  const files = [...repoFiles, ...filesIn(engine, 'lib', prefix), ...filesIn(engine, 'bin', prefix)];
  for (const [label, file] of files) {
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      bytes = Buffer.alloc(0);
    }
    hash.update(label).update('\0').update(bytes).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** The head commit of a worktree, or null. */
export function headSha(worktree) {
  const res = run('git', ['rev-parse', 'HEAD'], { cwd: worktree });
  const sha = res.status === 0 ? res.stdout.trim() : '';
  return SHA.test(sha) ? sha : null;
}

/**
 * The git tree of everything in a worktree: committed, staged, unstaged and untracked
 * files, minus ignored ones. It is built in a throwaway index, so the worktree's own index
 * is never touched. Two calls give the same tree only for the same files, committed or not.
 * Null when git cannot build it (then nothing is skipped).
 */
export function worktreeTree(worktree) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'factory-tree-'));
  } catch {
    return null;
  }
  const opts = { cwd: worktree, env: { ...process.env, GIT_INDEX_FILE: join(dir, 'index') } };
  try {
    if (run('git', ['read-tree', 'HEAD'], opts).status !== 0) return null;
    if (run('git', ['add', '-A'], opts).status !== 0) return null;
    const res = run('git', ['write-tree'], opts);
    const sha = res.status === 0 ? res.stdout.trim() : '';
    return SHA.test(sha) ? sha : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The `Tested head:` and `Checks inputs:` lines of a gate report; null fields when missing. */
export function testedBy(text) {
  const head = (text ?? '').match(/^Tested head: (\S+)$/m)?.[1] ?? null;
  const inputs = (text ?? '').match(/^Checks inputs: (\S+)$/m)?.[1] ?? null;
  return { head: SHA.test(head ?? '') ? head : null, inputs: INPUTS.test(inputs ?? '') ? inputs : null };
}

/** The commit the worktree's branch left `base` at (their merge-base), or null. */
export function mergeBase(worktree, base) {
  const mb = run('git', ['merge-base', base, 'HEAD'], { cwd: worktree });
  const sha = mb.status === 0 ? mb.stdout.trim() : '';
  return SHA.test(sha) ? sha : null;
}

/**
 * The paths a worktree changed against `base`: committed, staged, unstaged and untracked (not
 * ignored), compared with the merge-base of `base` and HEAD. Renames count as the old path and the
 * new one, deletions as the deleted path. Sorted, without duplicates.
 * @returns {{files: string[], base: string}|{reason: string}} `reason` when git cannot tell, or when
 *   a path holds a newline or carriage return (it cannot be written one per line): run everything then.
 */
export function changedFiles(worktree, base) {
  const from = mergeBase(worktree, base);
  const tree = worktreeTree(worktree);
  if (!from || !tree) return { reason: `cannot compare with ${base}` };
  const diff = run('git', ['diff', '--name-only', '--no-renames', '-z', from, tree], { cwd: worktree });
  if (diff.status !== 0) return { reason: 'git diff failed' };
  const files = [...new Set(diff.stdout.split('\0').filter(Boolean))].sort();
  if (files.some((f) => /[\n\r\uFFFD]/.test(f))) return { reason: 'a changed path contains a newline or is not valid UTF-8' };
  return { files, base: from };
}
