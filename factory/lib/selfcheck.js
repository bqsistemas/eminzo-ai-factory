// `job <id> selfcheck` (factory/bin/selfcheck <id>): what the builder runs, after committing and
// before it writes `STATUS: READY`. Deterministic and read-only; the gate stays the backstop.
// Problems make it exit 1, one per line; warnings are printed but never change the exit code;
// with no problem it ends with `selfcheck: ok`.
//
// Problems
// 1. AC coverage. Each `AC-n` of the job's spec (spec.md; in lane xs the `## Scope` of intake.md)
//    must be referenced in a test file the branch added or changed since it left the base.
//    `config.selfcheck.ac_pattern` (a non-empty regex string; default `AC-\d+`, case-insensitive) finds a
//    reference. It is applied to the lines the diff ADDS to test files (a changed test counts through
//    its new lines; each line is cut at 2000 characters first); every match counts, and its last run
//    of digits names the AC, so `AC-1` in a JS `test('AC-1: ...')` or Go `t.Run("AC-1: ...")` and
//    `test_ac_1` in a Python `def test_ac_1` (pattern `(?:AC-|test_ac_)\d+`) all cover AC-1. A match
//    followed by `..` or `to` and another number (`AC-1..AC-3`) covers the whole range. In a spec, a
//    line that starts `AC-1, AC-2: ...` or `AC-1..AC-3: ...` defines each of those ACs.
// 2. Protected tests. No path of `config.protected_tests` changed against the base (gate.js' rule).
// 3. Uncommitted changes. The worktree holds none (gate.js' rule).
// Warnings
// - Module map. factory/project.md does not mention the paths the branch added or moved
//   (project-map.js). The gate reports the same finding as informational and never fails on it, so
//   selfcheck does not fail on it either.
import { join } from 'node:path';

import { isTestFile } from './diff.js';
import { protectedChanges, uncommitted } from './gate.js';
import { projectMapStatus } from './project-map.js';
import { sectionLines } from './section.js';
import { baseRef, jobDir, readText, run } from './util.js';

export const DEFAULT_AC_PATTERN = 'AC-\\d+';
export const MAX_LINE = 2000;

// A spec line that defines ACs: a list item or table row starting with `AC-n`, then more numbers after `,`, `&`, `and`, `..` or `to`.
const SEP = String.raw`(?:,|&|\band\b|\.{2,3}|…|–|—|\bto\b)`;
const AC_HEAD = new RegExp(String.raw`^\s*(?:[-*]|\d+[.)]|\|)\s*(?:\*\*|\x60)?(AC-\d+(?:\s*${SEP}\s*(?:AC-)?\d+)*)`, 'i');
const RANGE_SEP = /^(?:\.{2,3}|…|–|—|to)$/i;
const MAX_SPAN = 200;

/** Numbers of `a, b`, `a..c` and `a to c` (a range fills every number between). */
function numbersOf(chunk) {
  const out = [];
  let prev = null;
  let range = false;
  for (const m of chunk.matchAll(/(\d+)|(\.{2,3}|…|–|—|\bto\b)/gi)) {
    if (m[2] !== undefined) { range = RANGE_SEP.test(m[2]); continue; }
    const n = Number(m[1]);
    if (range && prev !== null && n > prev && n - prev <= MAX_SPAN) for (let k = prev + 1; k < n; k += 1) out.push(k);
    out.push(n);
    prev = n;
    range = false;
  }
  return out;
}

/** The AC numbers of a spec, in order of first appearance. */
export function acNumbers(lines) {
  const out = [];
  for (const line of lines) {
    const chunk = AC_HEAD.exec(line)?.[1];
    if (chunk) for (const n of numbersOf(chunk)) if (!out.includes(n)) out.push(n);
  }
  return out;
}

// Test files the shared `isTestFile` does not know: Go `_test.go`, Python `test_*.py` / `*_test.py`.
const MORE_TESTS = [/_test\.(go|py)$/, /(^|\/)test_[^/]*\.py$/];
const isTest = (path) => isTestFile(path) || MORE_TESTS.some((re) => re.test(path));

/**
 * The lines the branch adds to test files since it left `base`: `{ path, lines[] }` per file, or an error.
 * Files come from `--name-only -z` (any name, spaces included) and each is diffed on its own, so an added
 * line that looks like a header (`++ x`) is content: after the first `@@`, every `+` line is an addition.
 */
export function addedTestLines(worktree, base) {
  const mb = run('git', ['merge-base', base, 'HEAD'], { cwd: worktree });
  if (mb.status !== 0) return { error: `git merge-base ${base} HEAD failed`, files: [] };
  const from = mb.stdout.trim();
  const names = run('git', ['-c', 'core.quotepath=off', 'diff', '--name-only', '-z', '--no-renames', from, 'HEAD'], { cwd: worktree });
  if (names.status !== 0) return { error: 'git diff failed', files: [] };
  const files = [];
  for (const path of names.stdout.split('\0').filter(Boolean)) {
    if (!isTest(path)) continue;
    const diff = run('git', ['diff', '-U0', '--no-color', '--no-renames', from, 'HEAD', '--', path], { cwd: worktree });
    if (diff.status !== 0) return { error: `git diff failed for ${path}`, files: [] };
    const lines = [];
    let inHunk = false;
    for (const line of diff.stdout.split('\n')) {
      if (line.startsWith('@@')) inHunk = true;
      else if (inHunk && line.startsWith('+')) lines.push(line.slice(1));
    }
    files.push({ path, lines });
  }
  return { error: null, files };
}

/** The AC numbers some added test line references, through `pattern`. */
function referenced(files, pattern) {
  const found = new Set();
  for (const { lines } of files) {
    for (const full of lines) {
      const line = full.slice(0, MAX_LINE);
      for (const m of line.matchAll(pattern)) {
        const digits = m[0].match(/\d+/g);
        if (!digits) continue;
        // `AC-1..AC-3` / `AC-1 to 3`: the match covers the first number, the text after it the range.
        const tail = /^\s*(?:\.{2,3}|…|–|—|\bto\b)\s*[A-Za-z_-]*?(\d+)/i.exec(line.slice(m.index + m[0].length));
        const from = Number(digits[digits.length - 1]);
        for (const n of numbersOf(`${from}${tail ? `..${tail[1]}` : ''}`)) found.add(n);
        if (m[0].length === 0) pattern.lastIndex += 1;
      }
    }
  }
  return found;
}

function coverageProblems(root, job, config, worktree, base, notes) {
  const xs = job.lane === 'xs';
  const name = xs ? 'intake.md ## Scope' : 'spec.md';
  const text = readText(join(jobDir(root, job.id), xs ? 'intake.md' : 'spec.md'));
  if (text === null) return [`${name}: the file is missing, so the acceptance criteria cannot be checked`];
  const acs = acNumbers(xs ? (sectionLines(text, 'Scope') ?? []).map((l) => l.text) : text.split('\n'));
  if (!acs.length) return [`${name}: no acceptance criteria (AC-n) found`];
  let source = config.selfcheck?.ac_pattern;
  if (typeof source !== 'string' || !source) {
    if (source !== undefined) notes.push(`factory/config.json selfcheck.ac_pattern must be a non-empty string; using ${DEFAULT_AC_PATTERN}`);
    source = DEFAULT_AC_PATTERN;
  }
  let pattern;
  try {
    pattern = new RegExp(source, 'gi');
  } catch {
    return [`factory/config.json selfcheck.ac_pattern is not a valid regular expression: ${JSON.stringify(source)}`];
  }
  const added = addedTestLines(worktree, base);
  if (added.error) return [`AC coverage not checked: ${added.error}`];
  const seen = referenced(added.files, pattern);
  return acs.filter((n) => !seen.has(n)).map((n) => `AC-${n} has no test: no test added or changed in the diff against ${base} references it (pattern ${source})`);
}

/**
 * Everything selfcheck found for the job's branch.
 * @param {string} root the main checkout
 * @param {object} job the parsed job.json
 * @param {object} config the effective config
 * @returns {{problems: string[], warnings: string[]}} problems fail the check; warnings and notes are only printed
 */
export function selfcheckFindings(root, job, config) {
  const { base } = baseRef(config);
  const worktree = job.worktree;
  if (!worktree) return { problems: ['the job has no worktree'], warnings: [] };
  const warnings = [];
  const problems = [...coverageProblems(root, job, config, worktree, base, warnings)];
  const guard = protectedChanges(worktree, base, config.protected_tests ?? []);
  if (guard.error) problems.push(`protected tests not checked: ${guard.error}`);
  problems.push(...guard.paths.map((p) => `protected test changed (the gate fails the round): ${p}`));
  const map = projectMapStatus(worktree, base);
  if (map.status === 'stale') {
    warnings.push(`Module map in factory/project.md does not mention: ${map.paths.slice(0, 20).join(', ')}${map.paths.length > 20 ? `, and ${map.paths.length - 20} more` : ''} (the gate reports it too, without failing)`);
  }
  problems.push(...uncommitted(worktree));
  return { problems, warnings };
}
