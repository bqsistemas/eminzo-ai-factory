// Pure: turns a git remote URL into the one shape factory/lib/job.js accepts, https://github.com/<owner>/<name>.
const NAME = '[A-Za-z0-9._-]+';
const PATTERNS = [
  new RegExp(`^(?:https?|ssh|git)://(?:[^@/]+@)?github\\.com(?::\\d+)?/(${NAME})/(${NAME}?)(?:\\.git)?/?$`, 'i'),
  new RegExp(`^[^@/\\s]+@github\\.com:(${NAME})/(${NAME}?)(?:\\.git)?/?$`, 'i'),
];

/** @returns {string | null} the canonical https URL, or null when the remote is not a GitHub repository. */
export function normalizeGithubRemote(url) {
  if (typeof url !== 'string') return null;
  const text = url.trim();
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (m) return `https://github.com/${m[1]}/${m[2]}`;
  }
  return null;
}
