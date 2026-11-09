// The readable face of the gate reports (checks.md, merge-checks.md): the machine status line and the
// lines other tools parse stay exactly as they were; a plain summary sentence, a step table and a
// bounded log tail are added around them. Written by gate.js and by job.js (a reused gate).

export const LOG_LINES = 60;

/** A span as a person reads it: `8s`, `2m 14s`, `1h 3m`. */
export function formatSpan(ms) {
  const total = Math.max(1, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m ${s}s` : `${s}s`;
}

/** The ENGINE header line (a KEY: value field right under the status line), or [] when the version is unknown. */
export const engineLines = (version) => (version ? [`ENGINE: ${version}`] : []);

/**
 * The one sentence under the status line.
 * @param {{pass: boolean, spanMs: number, head: string|null, code: number, violations: number, dirty: number, visualFailed: boolean}} f
 */
export function summarySentence(f) {
  const commit = f.head ? ` on commit ${f.head.slice(0, 7)}` : '';
  if (f.pass) return `The checks passed in ${formatSpan(f.spanMs)}${commit}.`;
  const why = [];
  if (f.code !== 0) why.push(`the checks command exited with code ${f.code}`);
  if (f.violations) why.push(f.violations === 1 ? 'a protected test was changed' : `${f.violations} protected test problems were found`);
  if (f.dirty) why.push('the worktree has uncommitted changes');
  if (f.visualFailed) why.push('the visual check failed');
  return `The checks failed: ${why.join('; ') || 'see the sections below'}.`;
}

/** A markdown table; cells are plain text. */
export function table(head, rows) {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
}

/** merge-checks.md when the sync with the base brought nothing and the round's gate still stands. */
export function reusedReport({ round, base, head, inputs, engine }) {
  return [
    'GATE: PASS',
    ...engineLines(engine),
    '',
    `The checks passed: the round-${round} gate is reused for commit ${head.slice(0, 7)}.`,
    '',
    `Reused the round-${round} gate: the sync with ${base} brought no changes, so ${head}`,
    `is the commit round-${round}/checks.md tested, with the same checks.sh and config.json.`,
    `Tested head: ${head}`,
    `Checks inputs: ${inputs}`,
    '',
  ].join('\n');
}
