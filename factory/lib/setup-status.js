// What the last setup covered: the marker that says setup finished and the coverage line that says which related
// repositories it described. Pure: no I/O, like `product-map.js`.
//
//   <!-- eminzo:setup-related: <slug> <slug> -->     (right before the setup-complete marker; commas are read as spaces)
//   <!-- eminzo:setup-complete -->
import { isRepoSlug, validRelatedRepos } from './related-repos.js';

export const SETUP_COMPLETE_MARKER = '<!-- eminzo:setup-complete -->';
const COVERAGE = /<!--\s*eminzo:setup-related:([^\n]*?)-->/g;

/**
 * The lowercase slugs of the last coverage line of the text, without duplicates; invalid tokens are dropped; `[]` without a line.
 * Slugs are separated by spaces; commas are accepted too, since an agent may write a list that way.
 */
export function parseSetupRelated(text) {
  if (typeof text !== 'string') return [];
  const last = [...text.matchAll(COVERAGE)].at(-1);
  if (!last) return [];
  const slugs = last[1].split(/[\s,]+/).filter(isRepoSlug).map((s) => s.toLowerCase());
  return [...new Set(slugs)];
}

/**
 * The state of setup (`missing` until the marker is there) and which valid related repositories it covered.
 * `covered` and `not_covered` keep the writing and the order of `related_repos`. A setup that is not finished covers nothing.
 * @param {string | null} text the text of factory/project.md, or null
 * @returns {{ state: 'missing' | 'complete', related: { covered: string[], not_covered: string[] } }}
 */
export function setupStatus(text, team) {
  const repos = validRelatedRepos(team).map((e) => e.repo);
  const complete = typeof text === 'string' && text.includes(SETUP_COMPLETE_MARKER);
  if (!complete) return { state: 'missing', related: { covered: [], not_covered: repos } };
  const seen = new Set(parseSetupRelated(text));
  return { state: 'complete', related: { covered: repos.filter((r) => seen.has(r.toLowerCase())), not_covered: repos.filter((r) => !seen.has(r.toLowerCase())) } };
}
