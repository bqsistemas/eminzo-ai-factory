// Related repositories: the team list in factory/config.json (`related_repos`) and the local folders of each
// person in factory/config.local.json (`related_checkouts`). Pure: no dependencies, no file or network access.
import { isAbsolute } from 'node:path';

export const RELATED_REPOS_MAX = 20;
export const DESCRIPTION_MAX = 500;
export const ACCOUNT_MAX = 100;

const SLUG = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => Object.hasOwn(obj, key);

/** True for `owner/name` (owner letters, digits, `-`; name also `.` and `_`, never `.` or `..`). */
export function isRepoSlug(value) {
  if (typeof value !== 'string') return false;
  const match = SLUG.exec(value);
  return match !== null && match[2] !== '.' && match[2] !== '..';
}

/** The lowercase `owner/name` of `config.repo` (a github.com URL or a slug), or null. */
export function mainRepoSlug(config) {
  const repo = isPlainObject(config) && own(config, 'repo') ? config.repo : null;
  if (typeof repo !== 'string') return null;
  const url = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(repo);
  const slug = url ? `${url[1]}/${url[2]}` : repo;
  return isRepoSlug(slug) ? slug.toLowerCase() : null;
}

/** Characters (code points) of the trimmed text. */
const textLength = (text) => [...text.trim()].length;

/**
 * Why each `related_repos` entry of the team config is invalid. `[]` when the key is missing or all is valid.
 * `index` is the 0-based position of the entry, or null for a problem of the whole list. Never mutates `team`.
 * @returns {{ index: number | null, repo: string | null, reason: string }[]}
 */
export function relatedReposProblems(team) {
  if (!isPlainObject(team) || !own(team, 'related_repos')) return [];
  const list = team.related_repos;
  if (!Array.isArray(list)) return [{ index: null, repo: null, reason: 'must be a list' }];
  if (list.length > RELATED_REPOS_MAX) return [{ index: null, repo: null, reason: `at most ${RELATED_REPOS_MAX} repositories (found ${list.length})` }];
  const main = mainRepoSlug(team);
  const seen = new Set();
  const problems = [];
  list.forEach((item, index) => {
    const repo = isPlainObject(item) && typeof item.repo === 'string' ? item.repo : null;
    const fail = (reason) => problems.push({ index, repo, reason });
    if (!isPlainObject(item)) return fail('must be an object with repo and description');
    const keys = Object.keys(item);
    const extra = keys.filter((k) => k !== 'repo' && k !== 'description');
    if (extra.length) return fail(`unknown field ${JSON.stringify(extra[0])}`);
    if (!own(item, 'repo') || !own(item, 'description')) return fail('needs both repo and description');
    if (repo === null || !isRepoSlug(repo)) return fail('repo must look like owner/name');
    if (typeof item.description !== 'string') return fail('description must be text');
    const length = textLength(item.description);
    if (length === 0) return fail('description must not be empty');
    if (length > DESCRIPTION_MAX) return fail(`description is longer than ${DESCRIPTION_MAX} characters`);
    const slug = repo.toLowerCase();
    if (slug === main) return fail('is the main repository of this config');
    if (seen.has(slug)) return fail('is listed more than once');
    seen.add(slug);
  });
  return problems;
}

/** Why a local `related_checkouts` value is invalid, or null. The reason names the slug involved. */
export function relatedCheckoutsProblem(value) {
  if (!isPlainObject(value)) return 'must be an object of owner/name keys';
  for (const key of Object.keys(value)) {
    const name = JSON.stringify(key);
    if (!isRepoSlug(key)) return `${name} is not an owner/name slug`;
    const item = value[key];
    if (!isPlainObject(item)) return `${name} must be an object with a path`;
    const extra = Object.keys(item).filter((k) => k !== 'path' && k !== 'account');
    if (extra.length) return `${name} has an unknown field ${JSON.stringify(extra[0])}`;
    if (!own(item, 'path') || typeof item.path !== 'string' || item.path === '') return `${name} needs a path (text)`;
    if (item.path.startsWith('~')) return `${name} path must be absolute, not start with ~`;
    if (!isAbsolute(item.path)) return `${name} path must be absolute`;
    if (own(item, 'account')) {
      const a = item.account;
      if (typeof a !== 'string' || a.length < 1 || a.length > ACCOUNT_MAX || !ACCOUNT.test(a)) return `${name} account must be 1 to ${ACCOUNT_MAX} letters, digits, - or _, starting with a letter or digit`;
    }
  }
  return null;
}
