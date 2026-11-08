// `eminzo enable`: adds the factory to the repository of the current directory as a pull request,
// with only the repository's own files (no engine code): factory/config.json (pinned to this
// engine's minor), factory/checks.sh (detected from the stack), a first draft of factory/project.md,
// the factory's .gitignore lines and `Bash(eminzo:*)` in .claude/settings.json. The checks and
// the stack detection are cli/src/installer (shared with the Eminzo desktop installer). After the pull request is
// merged, `/eminzo-factory setup` finishes project.md and creates the labels.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { preflight } from './installer/preflight.js';
import { normalizeGithubRemote } from './installer/remote.js';
import { detectChecks } from './installer/checks.js';
import { gitignoreText } from './installer/plan.js';
import { CliError, engineFolder, hasCommittedEngine } from './paths.js';
import { minorRange } from './semver.js';

export const ENABLE_BRANCH = 'chore/enable-factory';
export const COMMIT_MESSAGE = 'chore: enable software factory';
export const PERMISSION = 'Bash(eminzo:*)';
/** Every path enable may write, in the order it writes them. */
export const FOOTPRINT = ['factory/config.json', 'factory/checks.sh', 'factory/project.md', '.gitignore', '.claude/settings.json'];

const firstLine = (s) => String(s ?? '').trim().split('\n')[0] ?? '';

/** The settings text with PERMISSION allowed, or null when it is already there. Refuses a file that is not a JSON object. */
export function settingsText(current) {
  let settings = {};
  if (current !== null) {
    try {
      settings = JSON.parse(current);
    } catch (err) {
      throw new CliError(`.claude/settings.json is not valid JSON (${err.message}); fix it and run eminzo enable again`);
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new CliError('.claude/settings.json must be a JSON object');
  }
  const permissions = settings.permissions ?? {};
  if (typeof permissions !== 'object' || Array.isArray(permissions)) throw new CliError('.claude/settings.json: permissions must be an object');
  const allow = permissions.allow ?? [];
  if (!Array.isArray(allow)) throw new CliError('.claude/settings.json: permissions.allow must be a list');
  if (allow.includes(PERMISSION)) return null;
  return `${JSON.stringify({ ...settings, permissions: { ...permissions, allow: [...allow, PERMISSION] } }, null, 2)}\n`;
}

/** factory/config.json from the engine's template: `engine` first, then the template with repo and base filled. */
export function configText(template, { repoUrl, defaultBranch, version }) {
  const filled = template.split('__REPO__').join(repoUrl).split('__BASE__').join(`origin/${defaultBranch}`);
  return `${JSON.stringify({ engine: minorRange(version), ...JSON.parse(filled) }, null, 2)}\n`;
}

function prBody({ version, stack, files, kept }) {
  return [
    `Enables the Eminzo software factory in this repository (eminzo ${version}). The engine is not copied:`,
    'it is the `eminzo` command (`npm i -g @eminzo/factory`, then `eminzo install`).',
    '',
    '## Files',
    '',
    ...files.map((f) => `- \`${f}\``),
    ...(kept.length ? ['', `Kept as they are on the default branch: ${kept.map((f) => `\`${f}\``).join(', ')}.`] : []),
    '',
    `\`factory/checks.sh\` was detected for the \`${stack}\` stack: review it, the gate runs it on every job.`,
    `\`factory/config.json\` pins the engine to \`${minorRange(version)}\`; every developer runs the factory with that engine.`,
    '',
    '## After merging',
    '',
    '1. Pull the default branch.',
    '2. Run `/eminzo-factory setup` (Codex: `$eminzo-factory setup`): it creates the labels and completes `factory/project.md`.',
    '3. Label an issue `factory` and run `/eminzo-factory issue <n>`.',
    '',
  ].join('\n');
}

/** @returns {Promise<number>} exit status */
export async function enable({ dist, version, env = process.env, cwd = process.cwd(), dryRun = false, json = false, out = process.stdout }) {
  const gh = env.FACTORY_GH || 'gh';
  // One JSON object for tools (eminzo enable --json), or lines for a person.
  const report = (result, lines) => {
    if (json) out.write(`${JSON.stringify(result)}\n`);
    else for (const line of lines) out.write(`${line}\n`);
  };
  const failChecks = (problems) => {
    report({ ok: false, problems }, problems.map((p) => `FAIL ${p.message}`));
    return 1;
  };
  let root = null;
  const run = (cmd, args, opts = {}) => {
    const res = spawnSync(cmd, args, { cwd: root ?? cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
    return { code: res.error ? 1 : res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr || res.error?.message || '' };
  };
  const git = (...args) => run('git', args);
  const must = (res, what) => {
    if (res.code !== 0) throw new CliError(`${what} failed: ${firstLine(res.stderr) || firstLine(res.stdout) || `exit ${res.code}`}`);
    return res;
  };

  // Preflight: the same facts and messages as the desktop installer.
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (top.code !== 0) return failChecks(preflight({ isGitRepo: false }));
  root = top.stdout.trim();
  const gitDir = firstLine(git('rev-parse', '--absolute-git-dir').stdout);
  const commonDir = firstLine(git('rev-parse', '--path-format=absolute', '--git-common-dir').stdout);
  if (gitDir && commonDir && gitDir !== commonDir) {
    throw new CliError(`this is a linked worktree; run eminzo enable in the main checkout (${dirname(commonDir)})`);
  }
  if (existsSync(join(root, 'factory', 'config.json'))) {
    throw new CliError(hasCommittedEngine(root)
      ? 'this repository already commits its own factory engine (a desktop install); eminzo runs that engine as it is'
      : 'the factory is already enabled here (factory/config.json exists); run /eminzo-factory setup, or eminzo doctor');
  }

  const branch = firstLine(git('rev-parse', '--abbrev-ref', 'HEAD').stdout) || null;
  const symbolic = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  let defaultBranch = symbolic.code === 0 ? firstLine(symbolic.stdout).replace(/^origin\//, '') || null : null;
  if (!defaultBranch) {
    const view = run(gh, ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']);
    defaultBranch = view.code === 0 ? firstLine(view.stdout) || null : null;
  }
  const remote = git('config', '--get', 'remote.origin.url');
  const ignored = git('check-ignore', '--', ...FOOTPRINT.filter((p) => p !== '.gitignore'));
  const facts = {
    isGitRepo: true,
    clean: git('status', '--porcelain').stdout.trim() === '',
    branch,
    defaultBranch,
    remoteUrl: remote.code === 0 ? firstLine(remote.stdout) || null : null,
    ghAuthed: run(gh, ['auth', 'status']).code === 0,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    ignoredPaths: ignored.code === 0 ? ignored.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [],
    installing: existsSync(join(root, 'factory', '.installing')),
  };
  const problems = preflight(facts);
  if (!defaultBranch && facts.remoteUrl) {
    problems.push({ code: 'no-default-branch', message: 'The default branch of origin is unknown (no origin/HEAD and gh could not tell). Run "git remote set-head origin --auto" and try again.' });
  }
  if (problems.length) return failChecks(problems);
  const repoUrl = normalizeGithubRemote(facts.remoteUrl);
  const slug = repoUrl.replace('https://github.com/', '');

  // Everything is computed from origin/<default>, the commit the branch starts from, never from the
  // local checkout (which may be behind), so the pull request can only add the factory's lines.
  must(git('fetch', '-q', 'origin', defaultBranch), `git fetch origin ${defaultBranch}`);
  const base = `origin/${defaultBranch}`;
  const atBase = (rel) => git('cat-file', '-e', `${base}:${rel}`).code === 0;
  const showBase = (rel) => {
    const res = git('show', `${base}:${rel}`);
    return res.code === 0 ? res.stdout : null;
  };
  if (atBase('factory/config.json')) {
    throw new CliError(`${base} already has factory/config.json: the factory is enabled there; pull ${defaultBranch} and run /eminzo-factory setup`);
  }
  let packageJson = null;
  try { packageJson = JSON.parse(showBase('package.json') ?? 'null'); } catch { /* not JSON: no node stack */ }
  const checks = detectChecks({
    files: git('ls-tree', '--name-only', base).stdout.split('\n').filter(Boolean),
    packageJson,
    read: (f) => showBase(f) ?? '',
  });
  const engine = engineFolder(dist);
  const config = configText(readFileSync(join(engine, 'templates', 'config.json'), 'utf8'), { repoUrl, defaultBranch, version });
  const gitignoreBefore = showBase('.gitignore');
  const settingsBefore = showBase('.claude/settings.json');
  const gitignoreAdd = gitignoreText(gitignoreBefore);
  const settings = settingsText(settingsBefore);
  const kept = ['factory/checks.sh', 'factory/project.md'].filter(atBase);
  const files = ['factory/config.json', 'factory/checks.sh', 'factory/project.md']
    .filter((f) => !kept.includes(f))
    .concat(gitignoreAdd ? ['.gitignore'] : [], settings ? ['.claude/settings.json'] : []);

  const plan = { repo: slug, base: defaultBranch, branch: ENABLE_BRANCH, engine: minorRange(version), stack: checks.stack, files, kept };
  if (dryRun) {
    report({ ok: true, dryRun: true, ...plan }, [
      ...files.map((f) => `write ${f}`),
      ...kept.map((f) => `keep ${f} (already on ${base})`),
      `dry run: would open a pull request from ${ENABLE_BRANCH} into ${defaultBranch} on ${slug}; nothing was written`,
    ]);
    return 0;
  }

  const branchTaken = git('show-ref', '--verify', '--quiet', `refs/heads/${ENABLE_BRANCH}`).code === 0
    || git('ls-remote', '--exit-code', '--heads', 'origin', ENABLE_BRANCH).code === 0;
  if (branchTaken) throw new CliError(`the branch ${ENABLE_BRANCH} already exists (here or on origin); merge or close its pull request, delete the branch, then run eminzo enable again`);

  must(git('checkout', '-q', '-b', ENABLE_BRANCH, base), `git checkout -b ${ENABLE_BRANCH}`);
  const createdDirs = [];
  let committed = false;
  try {
    const put = (rel, text, mode) => {
      const file = join(root, rel);
      for (let d = dirname(file), missing = []; ; d = dirname(d)) {
        if (existsSync(d)) { createdDirs.push(...missing.reverse()); break; }
        missing.push(d);
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      if (mode) chmodSync(file, mode);
    };
    put('factory/config.json', config);
    if (files.includes('factory/checks.sh')) put('factory/checks.sh', checks.script, 0o755);
    if (files.includes('factory/project.md')) {
      const init = spawnSync(process.execPath, [join(engine, 'lib', 'init.js')], {
        cwd: root, env: { ...env, EMINZO_ENGINE: engine, EMINZO_VERSION: version, FACTORY_ROOT: root }, encoding: 'utf8',
      });
      if (init.status !== 0) throw new CliError(`drafting factory/project.md failed: ${firstLine(init.stderr) || `exit ${init.status}`}`);
    }
    if (gitignoreAdd) put('.gitignore', `${gitignoreBefore ?? ''}${gitignoreAdd}`);
    if (settings) put('.claude/settings.json', settings);

    must(git('add', '--', ...files), 'git add');
    must(git('commit', '-q', '-m', COMMIT_MESSAGE), 'git commit');
    committed = true;
  } catch (err) {
    // Nothing was committed: remove what this run created, restore what it changed, go back.
    git('reset', '-q');
    for (const rel of files) {
      if (atBase(rel)) git('checkout', '-q', '--', rel);
      else rmSync(join(root, rel), { force: true });
    }
    for (const dir of createdDirs.reverse()) { try { rmdirSync(dir); } catch { /* not empty */ } }
    git('checkout', '-q', branch);
    git('branch', '-D', ENABLE_BRANCH);
    throw err;
  }

  try {
    const pushed = git('push', '-q', '-u', 'origin', ENABLE_BRANCH);
    if (pushed.code !== 0) {
      throw new CliError(`git push origin ${ENABLE_BRANCH} failed: ${firstLine(pushed.stderr) || `exit ${pushed.code}`}. `
        + `The commit is on the local branch ${ENABLE_BRANCH}: push it and open the pull request, or delete the branch and run eminzo enable again`);
    }
    const pr = run(gh, ['pr', 'create', '--repo', slug, '--base', defaultBranch, '--head', ENABLE_BRANCH, '--title', COMMIT_MESSAGE,
      '--body', prBody({ version, stack: checks.stack, files, kept })]);
    if (pr.code !== 0) {
      throw new CliError(`gh pr create failed: ${firstLine(pr.stderr) || `exit ${pr.code}`}. The branch ${ENABLE_BRANCH} is pushed: `
        + `open the pull request with: gh pr create --repo ${slug} --base ${defaultBranch} --head ${ENABLE_BRANCH} --fill`);
    }
    const url = pr.stdout.split('\n').map((l) => l.trim()).filter((l) => /^https:\/\/\S+$/.test(l)).at(-1) ?? null;
    report({ ok: true, url, ...plan }, [
      url ?? firstLine(pr.stdout),
      `Merge it, pull ${defaultBranch}, then run /eminzo-factory setup (Codex: $eminzo-factory setup).`,
    ]);
    return 0;
  } finally {
    if (committed) git('checkout', '-q', branch);
  }
}
