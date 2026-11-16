// The words and facts of a red base, kept apart from job.js: what a gate report says about why it failed, and the
// notes a held job shows. A job whose gate fails while the base fails the same checks is HELD at stage `gate` with a
// `base_wait` field (no new stage); `job <id> base` is the only thing that sets or clears it.
//
//   base_wait   { since, sha, key, fix_issue, command }   only while the job is held
//   base_check  { round, head, verdict, reason, at }      the answer for one gate report: `own`, `wait` or `resumed`
//   base_waits  [{ since, until, fix_issue }]             every wait that ended, oldest first
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_WAITS = 20;

/** What a gate report (round-N/checks.md) says: the checks' exit code, the tested head and base, and what else failed. */
export function gateFacts(text) {
  const t = String(text ?? '');
  const exit = t.match(/^Checks exit code: (\d+)$/m)?.[1];
  const head = t.match(/^Tested head: (\S+)$/m)?.[1] ?? '';
  const base = t.match(/^Checks base: (\S+)$/m)?.[1] ?? '';
  const other = [];
  if (/^Protected test violations:\s*$/m.test(t)) other.push('protected tests');
  if (/^Uncommitted changes: (?!none$)/m.test(t)) other.push('uncommitted changes');
  if (/^Visual check: FAIL$/m.test(t)) other.push('the visual check');
  return { exit: exit === undefined ? null : Number(exit), head: SHA.test(head) ? head : null, base: SHA.test(base) ? base : null, other };
}

/** Why a gate that failed with passing checks is the job's own failure. */
export const ownChecksPassed = (facts) => `the checks passed; the gate failed on ${facts.other.length ? facts.other.join(' and ') : 'something other than the checks'}`;

/** The note a held job shows. */
export function waitNote(branch, number, failure, commands) {
  if (Number.isInteger(number)) return `${branch} is broken: waiting for #${number}`;
  return `${branch} is broken: no fix issue (${failure ?? 'it was not created'}); run ${commands.base}, then ${commands.base} fix-issue`;
}

/** The `wait:` line `job <id> base` prints. */
export const waitLine = (branch, number) => `wait: ${branch} is broken (${Number.isInteger(number) ? `#${number}` : 'no fix issue yet'})`;

/** Ends a wait: it moves to `base_waits` and `base_wait` goes away. A job that leaves `gate` always loses its wait. */
export function endWait(job, at) {
  const wait = job.base_wait;
  if (!wait) return;
  job.base_waits = [...(Array.isArray(job.base_waits) ? job.base_waits : []), { since: wait.since, until: at, fix_issue: wait.fix_issue ?? null }].slice(-MAX_WAITS);
  delete job.base_wait;
}
