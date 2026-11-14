// What only GitHub knows about the factory, read with `gh` and never written: the open `factory` issues no
// local job has taken yet. Uses FACTORY_GH like the rest of the engine, so tests run a fake gh.
import { safeTitle } from '../job.js';
import { run } from '../util.js';
import { readJobs } from './jobs.js';

/** The label that puts an issue in the factory's queue. */
export const FACTORY_LABEL = 'factory';
const QUEUE_LIMIT = 100;

/** A short reason from gh's stderr, for a tool error the model can show. */
export function ghProblem(res) {
  if (res.error) return res.error.code === 'ENOENT' ? 'the GitHub CLI (gh) is not installed' : res.error.message;
  const last = String(res.stderr ?? '').trim().split('\n').slice(-1)[0];
  return last || `gh exited with code ${res.status}`;
}

/**
 * Open issues labeled `factory` that no job on this machine has taken, oldest first. Throws an Error whose message
 * says why gh could not answer (not installed, not signed in, offline).
 * @param {string} root the main checkout
 * @param {{ gh?: string, runner?: typeof run }} [options]
 */
export function factoryQueue(root, { gh = process.env.FACTORY_GH || 'gh', runner = run } = {}) {
  const res = runner(gh, ['issue', 'list', '--label', FACTORY_LABEL, '--state', 'open', '--limit', String(QUEUE_LIMIT),
    '--json', 'number,title,assignees,labels,createdAt,url'], { cwd: root });
  if (res.error || res.status !== 0) throw new Error(`could not read the queue from GitHub: ${ghProblem(res)}`);
  let issues;
  try {
    issues = JSON.parse(res.stdout);
  } catch {
    throw new Error('could not read the queue from GitHub: gh did not return JSON');
  }
  if (!Array.isArray(issues)) throw new Error('could not read the queue from GitHub: gh did not return a list');
  const taken = new Set(readJobs(root).map((j) => j.issue));
  const items = issues.filter((i) => Number.isInteger(i?.number) && !taken.has(i.number)).map((i) => ({
    issue: i.number,
    title: safeTitle(i.title),
    created: typeof i.createdAt === 'string' ? i.createdAt : null,
    assignees: Array.isArray(i.assignees) ? i.assignees.map((a) => a?.login).filter((l) => typeof l === 'string') : [],
    labels: Array.isArray(i.labels) ? i.labels.map((l) => l?.name).filter((n) => typeof n === 'string') : [],
    url: typeof i.url === 'string' ? i.url : null,
  })).sort((a, b) => (Date.parse(a.created ?? '') || 0) - (Date.parse(b.created ?? '') || 0));
  const summary = items.length
    ? `${items.length} open factory issue${items.length === 1 ? '' : 's'} not taken by a job on this machine${issues.length >= QUEUE_LIMIT ? ` (only the first ${QUEUE_LIMIT} were read)` : ''}.`
    : 'No open factory issue is waiting to be taken.';
  return { summary, total: items.length, truncated: issues.length >= QUEUE_LIMIT, items };
}
