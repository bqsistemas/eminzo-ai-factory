// Pure: the facts gathered about a target repo -> the problems that block the install, each with a message for a person.
import { normalizeGithubRemote } from './remote.js';

export const MIN_NODE = 20;

/**
 * `ignoredPaths` (optional): planned install paths that `git check-ignore` reports as ignored.
 * `installing` (optional): a previous process left the install marker behind.
 * @param {{ isGitRepo: boolean, clean: boolean, branch: string | null, defaultBranch: string | null, remoteUrl: string | null, ghAuthed: boolean, nodeMajor: number | null }} facts
 * @returns {{ code: string, message: string }[]}
 */
export function preflight(facts) {
  if (!facts.isGitRepo) return [{ code: 'not-git', message: 'This folder is not a git repository. Run "git init" and add a GitHub remote first.' }];
  if (facts.installing) return [{
    code: 'install-in-progress',
    message: 'A previous factory installation was interrupted because factory/.installing still exists. Do not retry yet. Inspect with "git status --short", preview untracked cleanup with "git clean -nd -- factory .claude .agents .codex", then remove only the partial files, run "rm -f factory/.installing", and delete the abandoned branch with "git branch -D chore/install-factory".',
  }];
  const problems = [];
  const branchName = facts.defaultBranch;
  if (branchName && !(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(branchName) && !branchName.includes('..'))) {
    problems.push({ code: 'bad-branch', message: `The default branch name (${branchName}) has characters the installer will not pass to git. Rename the branch first.` });
  }
  if (!facts.clean) problems.push({ code: 'dirty', message: 'The working tree has uncommitted changes. Commit or stash them so the install PR contains only the factory.' });
  if (facts.defaultBranch && facts.branch !== facts.defaultBranch) {
    problems.push({ code: 'not-default-branch', message: `You are on "${facts.branch ?? 'a detached HEAD'}", but the install branch must start from "${facts.defaultBranch}". Check it out first.` });
  }
  if (facts.ignoredPaths?.length) {
    const shown = facts.ignoredPaths.slice(0, 5).join(', ');
    const more = facts.ignoredPaths.length > 5 ? ` and ${facts.ignoredPaths.length - 5} more` : '';
    problems.push({ code: 'ignored-paths', message: `Your .gitignore ignores files the factory needs to commit (${shown}${more}). Remove those rules from .gitignore, then try again.` });
  }
  if (!facts.remoteUrl) problems.push({ code: 'no-remote', message: 'There is no "origin" remote. The factory needs a GitHub repository to open its pull request on.' });
  else if (!normalizeGithubRemote(facts.remoteUrl)) problems.push({ code: 'not-github', message: `The "origin" remote (${facts.remoteUrl}) is not a GitHub repository. The factory only supports GitHub.` });
  if (!facts.ghAuthed) problems.push({ code: 'gh-auth', message: 'The GitHub CLI is not signed in. Run "gh auth login" and try again.' });
  if (!Number.isInteger(facts.nodeMajor) || facts.nodeMajor < MIN_NODE) {
    problems.push({ code: 'node-version', message: `The factory needs Node.js ${MIN_NODE} or newer on your PATH${Number.isInteger(facts.nodeMajor) ? ` (found ${facts.nodeMajor})` : ' (not found)'}.` });
  }
  return problems;
}
