// project.md helpers: the required sections of the template and the freshness check.
// The check is deterministic and never blocks: it compares the files a branch adds or
// moves with what the `Module map` section of factory/project.md mentions.
import { join } from 'node:path';

import { readText, run } from './util.js';

export const REQUIRED_SECTIONS = Object.freeze(['Snapshot', 'Stack', 'Commands', 'Module map', 'UI contract', 'Conventions']);

/** Body of the `## <name>` section (without its heading), or '' when there is none. */
export function sectionText(markdown, name) {
  const lines = String(markdown).split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\b`, 'i').test(l));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

// Paths that never need a Module map entry: tests, docs, lockfiles, dot folders.
const IGNORED = [/(^|\/)tests?\//, /(^|\/)__tests__\//, /\.(test|spec)\.[a-z]+$/, /(^|\/)docs?\//, /\.md$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|[^/]*\.lock)$/, /(^|\/)\.[^/]+/];

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Backticked tokens of the Module map: paths, folders (`dir/`) and globs (`lib/*`, `office*.js`). */
function mapTokens(map) {
  return [...map.matchAll(/`([^`\s]+)`/g)].map((m) => m[1].replace(/^\.\//, '').replace(/:$/, ''));
}

function covers(token, path) {
  if (token.endsWith('/')) return path.startsWith(token) || path.includes(`/${token}`);
  const body = token.split('*').map(escapeRe).join('[^/]*');
  // A bare name (no slash) names a top-level file only; a path token may sit under any prefix.
  return new RegExp(token.includes('/') ? `(^|/)${body}$` : `^${body}$`).test(path);
}

/**
 * The paths the Module map of `projectMd` does not mention. A path counts as mentioned
 * when a backticked token names it, its file name, a folder above it, or matches a `*` glob.
 * @param {string[]} paths repo-relative paths a branch added or moved
 * @param {string} projectMd the whole project.md text
 */
export function uncoveredPaths(paths, projectMd) {
  const tokens = mapTokens(sectionText(projectMd, 'Module map'));
  return paths.filter((path) => !IGNORED.some((re) => re.test(path)) && !tokens.some((token) => covers(token, path)));
}

/** Paths a branch added or renamed (their new path) since it left `base`, or an error. */
export function addedOrMovedPaths(worktree, base) {
  const mb = run('git', ['merge-base', base, 'HEAD'], { cwd: worktree });
  if (mb.status !== 0) return { error: `git merge-base ${base} HEAD failed`, paths: [] };
  // -z: NUL-separated and never quoted, so non-ASCII and unusual names arrive verbatim.
  const diff = run('git', ['diff', '--name-status', '-z', '-M', mb.stdout.trim(), 'HEAD'], { cwd: worktree });
  if (diff.status !== 0) return { error: 'git diff failed', paths: [] };
  const fields = diff.stdout.split('\0');
  const paths = [];
  for (let i = 0; i < fields.length && fields[i]; i += 1) {
    const status = fields[i][0];
    if (status === 'A') paths.push(fields[++i]);
    else if (status === 'R' || status === 'C') {
      const [from, to] = [fields[++i], fields[++i]];
      if (status === 'R' && from !== to) paths.push(to);
    } else i += 1;
  }
  return { error: null, paths };
}

/**
 * The freshness verdict for a job branch, using the project.md the branch holds.
 * @returns {{status: 'ok'|'stale'|'not checked', paths: string[], reason?: string}}
 */
export function projectMapStatus(worktree, base) {
  const text = readText(join(worktree, 'factory/project.md'));
  if (text === null) return { status: 'not checked', paths: [], reason: 'no factory/project.md' };
  const changed = addedOrMovedPaths(worktree, base);
  if (changed.error) return { status: 'not checked', paths: [], reason: changed.error };
  const paths = uncoveredPaths(changed.paths, text);
  return { status: paths.length ? 'stale' : 'ok', paths };
}

/** The checks.md lines for a verdict. Informational only; never part of PASS/FAIL. */
export function projectMapLines({ status, paths, reason }) {
  if (status === 'not checked') return [`Project map: not checked (${reason})`];
  if (status === 'ok') return ['Project map: ok'];
  return [
    'Project map: stale (non-blocking): the branch adds or moves paths the Module map in factory/project.md does not mention; add them to it.',
    ...paths.slice(0, 20).map((p) => `- ${p}`),
    ...(paths.length > 20 ? [`- ... and ${paths.length - 20} more`] : []),
  ];
}
