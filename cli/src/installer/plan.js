// Pure: what the installer will do to a target repo, as an ordered list of ops. Nothing here touches the disk.
// Ops: copy (kit file, read from the kit dir), write (generated content), gitignore-append, skip-existing.
import { KIT_LOCAL_FILES, KIT_RUNTIME_STATE } from './kit.js';

export const GITIGNORE_HEADER = '# software factory runtime state';
export const MANIFEST_PATH = 'factory/.manifest.json';
const REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const EXECUTABLE = 0o755;

/** Every line the factory needs in a repo's .gitignore: runtime state, then per-developer files. */
export const GITIGNORE_LINES = Object.freeze([...KIT_RUNTIME_STATE, ...KIT_LOCAL_FILES]);

const ignoreKey = (line) => line.trim().replace(/^\//, '').replace(/\/$/, '');

/**
 * The text to append to a .gitignore (`current`, null when the file is absent) so it has every GITIGNORE_LINES entry,
 * or null when none is missing. An entry counts as present with or without a leading or trailing slash.
 */
export function gitignoreText(current) {
  const present = new Set((current ?? '').split(/\r?\n/).map(ignoreKey));
  const missing = GITIGNORE_LINES.filter((line) => !present.has(ignoreKey(line)));
  if (!missing.length) return null;
  const lead = current && !current.endsWith('\n') ? '\n' : '';
  return `${lead}${GITIGNORE_HEADER}\n${missing.join('\n')}\n`;
}

/**
 * @param {{ existing: string[], gitignore: string | null, repoUrl: string, defaultBranch: string, checksScript: string, configTemplate: string }} facts
 *   `existing`: which of the kit and generated paths already exist in the target (relative, forward slashes).
 * @param {{ kitVersion: string, files: { path: string, sha256: string }[] }} kit
 */
export function planInstall(facts, kit) {
  if (!REPO_URL.test(facts.repoUrl ?? '')) throw new Error(`planInstall: the repo URL must be https://github.com/<owner>/<name>, got ${JSON.stringify(facts.repoUrl)}`);
  if (!BRANCH.test(facts.defaultBranch ?? '')) throw new Error(`planInstall: invalid default branch ${JSON.stringify(facts.defaultBranch)}`);
  const existing = new Set(facts.existing);
  const plan = [];
  const copied = [];
  const skipped = [];

  const place = (path, make) => {
    if (existing.has(path)) { plan.push({ op: 'skip-existing', path }); skipped.push(path); return false; }
    plan.push(make());
    return true;
  };

  for (const file of kit.files) {
    const copiedNow = place(file.path, () => ({ op: 'copy', path: file.path, ...(file.path.startsWith('factory/bin/') ? { mode: EXECUTABLE } : {}) }));
    if (copiedNow) copied.push(file);
  }

  const config = facts.configTemplate.split('__REPO__').join(facts.repoUrl).split('__BASE__').join(`origin/${facts.defaultBranch}`);
  place('factory/config.json', () => ({ op: 'write', path: 'factory/config.json', content: config }));
  place('factory/checks.sh', () => ({ op: 'write', path: 'factory/checks.sh', content: facts.checksScript, mode: EXECUTABLE }));

  const text = gitignoreText(facts.gitignore);
  if (text) plan.push({ op: 'gitignore-append', path: '.gitignore', text });

  // The installed marker goes last: it exists only if everything before it was written.
  const manifest = { kitVersion: kit.kitVersion, files: copied, skipped };
  place(MANIFEST_PATH, () => ({ op: 'write', path: MANIFEST_PATH, content: `${JSON.stringify(manifest, null, 2)}\n` }));
  return plan;
}
