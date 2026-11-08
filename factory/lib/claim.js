// The claim `job new <n>` makes before it creates a job, so developers sharing a
// repo don't start the same issue: refuse an issue assigned to someone else or whose
// `factory/<id>` branch already exists on the base remote, then assign an unassigned
// issue to the gh user. Fail closed: a check that can't run throws a plain Error and
// no job is created. Every command goes through the injected `exec` as argv; no issue
// text reaches any argument.
import { Refused } from './util.js';

// Same reduction as login() in job.js: GitHub logins are data, printed only like this.
const safeLogin = (value) => String(value ?? 'unknown').replace(/[^\w.[\]-]/g, '');

function failed(res) {
  return Boolean(res?.error) || res?.status !== 0;
}

function why(res) {
  return String(res?.stderr || res?.error?.message || `exit ${res?.status}`).trim().split('\n').slice(-3).join(' ');
}

/**
 * @param {{n: number, id: string, assignees?: {login?: string}[], remote: string, gh: string,
 *   exec: (cmd: string, args: string[]) => {status: number|null, stdout: string, stderr: string, error?: Error}}} opts
 * @returns {{assigned: boolean}}
 */
export function claimIssue({ n, id, assignees, remote, gh, exec }) {
  if (assignees != null && !Array.isArray(assignees)) throw new Error(`issue #${n}: assignees is not a list`);
  const people = assignees ?? [];

  // 1) Assigned to someone else? Only then does the gh user's login matter.
  if (people.length) {
    const res = exec(gh, ['api', 'user', '--jq', '.login']);
    if (failed(res)) throw new Error(`gh api user failed: ${why(res)}`);
    const me = String(res.stdout ?? '').trim().toLowerCase();
    if (!me) throw new Error('gh api user returned no login');
    const other = people.find((p) => String(p?.login ?? '').toLowerCase() !== me);
    if (other) throw new Refused(`#${n} is assigned to ${safeLogin(other?.login)}`);
  }

  // 2) Already started from another clone? An exact ref match, not git's suffix match.
  const ref = `refs/heads/factory/${id}`;
  const heads = exec('git', ['ls-remote', '--heads', remote, ref]);
  if (failed(heads)) throw new Error(`git ls-remote ${remote} failed: ${why(heads)}`);
  const refs = String(heads.stdout ?? '').split('\n').map((line) => line.split('\t')[1]?.trim());
  if (refs.includes(ref)) throw new Refused(`#${n} already has branch factory/${id} on ${remote}`);

  // 3) Claim it. An issue already assigned only to the gh user needs no edit.
  if (people.length) return { assigned: false };
  const edit = exec(gh, ['issue', 'edit', String(n), '--add-assignee', '@me']);
  if (failed(edit)) throw new Error(`gh issue edit --add-assignee failed: ${why(edit)}`);
  return { assigned: true };
}
