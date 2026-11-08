// `job <id> selfcheck` (factory/bin/selfcheck <id>): what the builder runs, after committing and
// before it writes `STATUS: READY`. Deterministic and read-only; the gate stays the backstop.
// It lists every problem it finds, one per line, and the caller exits 1; with none it says `selfcheck: ok`.
//
// 1. AC coverage. Each `AC-n` of the job's spec (spec.md; in lane xs the `## Scope` of intake.md)
//    must be referenced in a test file the branch added or changed since it left the base.
//    `config.selfcheck.ac_pattern` (default `AC-\d+`, case-insensitive) is the regex that finds a
//    reference. It is applied to the lines the diff ADDS to test files (a changed test counts through
//    its new lines); the number of a match (its last run of digits) names the AC, so `AC-1` in a
//    JS `test('AC-1: ...')` or Go `t.Run("AC-1: ...")` and `test_ac_1` in a Python
//    `def test_ac_1` (pattern `(?:AC-|test_ac_)\d+`) all cover AC-1.
// 2. Protected tests. No path of `config.protected_tests` changed against the base (gate.js' rule).
// 3. Module map. factory/project.md mentions the paths the branch added or moved (project-map.js).
// 4. Uncommitted changes. The worktree holds none (gate.js' rule).
import { join } from 'node:path';

import { isTestFile } from './diff.js';
import { protectedChanges, uncommitted } from './gate.js';
import { projectMapStatus } from './project-map.js';
import { sectionLines } from './section.js';
import { baseRef, jobDir, readText, run } from './util.js';

export const DEFAULT_AC_PATTERN = 'AC-\\d+';
const AC_LINE = /^\s*(?:[-*]|\d+[.)]|\|)\s*(?:\*\*|`)?AC-(\d+)/i;
// Test files the shared `isTestFile` does not know: Go `_test.go`, Python `test_*.py` / `*_test.py`.
const MORE_TESTS = [/_test\.(go|py)$/, /(^|\/)test_[^/]*\.py$/];
const isTest = (path) => isTestFile(path) || MORE_TESTS.some((re) => re.test(path));

/** The AC numbers of a spec: list items or table rows that start with `AC-n`, in order of first appearance. */
export function acNumbers(lines) {
  const out = [];
  for (const line of lines) {
    const n = AC_LINE.exec(line)?.[1];
    if (n !== undefined && !out.includes(Number(n))) out.push(Number(n));
  }
  return out;
}

/** The lines the branch adds to test files since it left `base`: `{ path, lines[] }` per file, or an error. */
export function addedTestLines(worktree, base) {
  const mb = run('git', ['merge-base', base, 'HEAD'], { cwd: worktree });
  if (mb.status !== 0) return { error: `git merge-base ${base} HEAD failed`, files: [] };
  const diff = run('git', ['-c', 'core.quotepath=off', 'diff', '-U0', '--no-color', '--no-renames', mb.stdout.trim(), 'HEAD'], { cwd: worktree });
  if (diff.status !== 0) return { error: 'git diff failed', files: [] };
  const files = [];
  let current = null;
  for (const line of diff.stdout.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '');
      current = path !== '/dev/null' && isTest(path) ? { path, lines: [] } : null;
      if (current) files.push(current);
    } else if (current && line.startsWith('+')) current.lines.push(line.slice(1));
  }
  return { error: null, files };
}

/** The AC numbers some added test line references, through `pattern`. */
function referenced(files, pattern) {
  const found = new Set();
  for (const { lines } of files) {
    for (const line of lines) {
      for (const m of line.matchAll(pattern)) {
        const digits = m[0].match(/\d+/g);
        if (digits) found.add(Number(digits[digits.length - 1]));
      }
    }
  }
  return found;
}

function coverageProblems(root, job, config, worktree, base) {
  const xs = job.lane === 'xs';
  const name = xs ? 'intake.md ## Scope' : 'spec.md';
  const text = readText(join(jobDir(root, job.id), xs ? 'intake.md' : 'spec.md'));
  if (text === null) return [`${name}: the file is missing, so the acceptance criteria cannot be checked`];
  const acs = acNumbers(xs ? (sectionLines(text, 'Scope') ?? []).map((l) => l.text) : text.split('\n'));
  if (!acs.length) return [`${name}: no acceptance criteria (AC-n) found`];
  const source = config.selfcheck?.ac_pattern ?? DEFAULT_AC_PATTERN;
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
 * Every problem of the job's branch, as lines; empty when it is ready.
 * @param {string} root the main checkout
 * @param {object} job the parsed job.json
 * @param {object} config the effective config
 */
export function selfcheckProblems(root, job, config) {
  const { base } = baseRef(config);
  const worktree = job.worktree;
  if (!worktree) return ['the job has no worktree'];
  const problems = [...coverageProblems(root, job, config, worktree, base)];
  const guard = protectedChanges(worktree, base, config.protected_tests ?? []);
  if (guard.error) problems.push(`protected tests not checked: ${guard.error}`);
  problems.push(...guard.paths.map((p) => `protected test changed (the gate fails the round): ${p}`));
  const map = projectMapStatus(worktree, base);
  if (map.status === 'stale') {
    problems.push(`Module map in factory/project.md does not mention: ${map.paths.slice(0, 20).join(', ')}${map.paths.length > 20 ? `, and ${map.paths.length - 20} more` : ''}`);
  }
  problems.push(...uncommitted(worktree));
  return problems;
}
