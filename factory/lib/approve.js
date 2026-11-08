// factory/bin/approve <job-id>: the deterministic approver. It runs the checks factory/roles/approver.md
// lists, none of which needs judgment, and is conservative: when unsure it is inconclusive.
//
//   approve       writes decision.md (APPROVE); prints "approve"
//   escalate      writes decision.md (ESCALATE) for a hard blocker; prints "escalate: <reason>"
//   inconclusive  writes nothing; prints "inconclusive: <reasons>" and the orchestrator spawns the LLM approver
//
// The repo-specific parts come from the job and factory/config.json (`base`, `protected_tests`); nothing here
// names a stack, a file or a command of any one repo.
import { join } from 'node:path';

import { diffEntries, isDenied, isManifest, isTestFile, opaqueReason, scopeTokens, xsLimitProblems } from './diff.js';
import { approvalFacts, recordApproval, recordInconclusive } from './job.js';
import { Refused, Usage, baseRef, engineCommand, factoryRoot, isMain, run, runCli, writeAtomic } from './util.js';

const SENSITIVE = /auth|secret|credential|permission|migration|\.env/i;
const RUNTIME_KEYS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

function runtimeDeps(text) {
  if (text === null) return null;
  try {
    const json = JSON.parse(text);
    return JSON.stringify(RUNTIME_KEYS.map((k) => Object.entries(json?.[k] ?? {}).sort(([a], [b]) => a.localeCompare(b))));
  } catch {
    return 'unreadable';
  }
}

/** Runs every check and returns { result, hard, soft, checks }. `git` runs in the main checkout. */
export function inspect(root, id) {
  const facts = approvalFacts(id, root);
  const { job, config } = facts;
  const { base } = baseRef(config);
  const branch = `factory/${id}`;
  const git = (...args) => run('git', args, { cwd: root });
  const hard = [];
  const soft = [];
  const checks = [];
  const check = (label, ok, reason, list = soft) => {
    checks.push(`- [${ok ? 'x' : ' '}] ${label}${ok ? '' : `: ${reason}`}`);
    if (!ok) list.push(reason);
  };

  // 1. every routed lens's latest verdict is PASS
  const lenses = Object.entries(facts.lenses);
  const lensIssues = lenses.length ? lenses.flatMap(([lens, v]) => (v === 'PASS' ? [] : [v ? `${lens} latest verdict is ${v}` : `${lens} has no verdict`])) : ['no routed reviewers'];
  check('Latest verdict of every routed lens PASS', !lensIssues.length, lensIssues.join(', '));

  // 2. the last round's gate
  check('Last gate PASS', facts.gate === 'PASS', 'the last gate is not PASS');

  // 3. the branch merges cleanly (a conflict is a hard blocker; an unreadable result is not an approval)
  const merge = git('merge-tree', '--write-tree', base, branch);
  if (merge.status === 0) check('Merges cleanly', true);
  else if (merge.status === 1) check('Merges cleanly', false, `the branch conflicts with ${base}; rework it onto ${base}`, hard);
  else check('Merges cleanly', false, `git merge-tree could not run (exit ${merge.status})`);

  // 4. the diff is fully visible and stays inside the scope the spec set (xs jobs: intake's ## Scope)
  const entries = diffEntries(root, base, branch);
  const files = entries?.map((e) => e.path) ?? null;
  if (!entries) {
    check('Diff within scope', false, 'the diff could not be read');
  } else if (!entries.length) {
    check('Diff within scope', false, 'the branch has no changes against the base (empty diff)');
  } else {
    const opaque = entries.map(opaqueReason).filter(Boolean);
    // The lane picks the scope source, never whether a spec.md happens to exist.
    const xs = job.lane === 'xs';
    const scope = xs ? scopeTokens(facts.intake ?? '', 'Scope') : scopeTokens(facts.spec ?? '', 'Design');
    const where = xs ? "intake's ## Scope" : "the spec's ## Design";
    const problems = [...opaque];
    if (scope.unsafe.length) problems.push(`${where} names a directory, glob or unsafe path (${scope.unsafe.join(', ')})`);
    if (!scope.files.size) problems.push(`no files listed in ${where}, so the scope cannot be checked`);
    else {
      const outside = entries.filter((e) => !scope.files.has(e.path)
        && !(e.status === 'A' && isTestFile(e.path))).map((e) => e.path);
      if (outside.length) problems.push(`files outside the scope: ${outside.join(', ')}`);
    }
    check('Diff within scope', !problems.length, problems.join('; '));
    if (xs) {
      const limits = xsLimitProblems(entries, config);
      check('Within the xs limits', !limits.length, `lane xs limits not met: ${limits.join('; ')}`);
    }
  }

  // 4b. the branch is still at the head the reviewers saw
  const head = git('rev-parse', branch).stdout.trim();
  const reviewed = job.round_heads?.[job.round];
  check('Branch head is the reviewed head', typeof reviewed === 'string' && head === reviewed,
    'the branch head is not the head recorded at review; go back to build so a new round reviews it');

  // 5. judgment flags: each one needs a person or the LLM approver
  const flags = [];
  if (job.intake?.risk === 'high') flags.push('risk high');
  if ((job.intake?.surfaces ?? []).includes('security')) flags.push('security surface');
  if (facts.deviatedACs.length) flags.push(`spec deviation touches ${facts.deviatedACs.join(', ')}`);
  for (const f of files ?? []) {
    if (SENSITIVE.test(f)) flags.push(`sensitive path: ${f}`);
    if (Array.isArray(config.protected_tests) && config.protected_tests.includes(f)) flags.push(`protected test: ${f}`);
    if (isManifest(f)) flags.push(`dependency manifest changed: ${f}`);
    if (isDenied(f, config)) flags.push(`engine, CI or denied path: ${f}`);
  }
  check('No human-judgment areas', !flags.length, flags.join(', '));

  // 6. a changed runtime dependency is a hard blocker; unreadable manifests are never approved
  const manifests = (files ?? []).filter((f) => /(^|\/)package\.json$/.test(f));
  if (manifests.length) {
    const point = git('merge-base', base, branch).stdout.trim();
    const show = (ref, f) => { const r = git('show', `${ref}:${f}`); return r.status === 0 ? r.stdout : null; };
    const pairs = manifests.map((f) => [f, runtimeDeps(show(point, f)), runtimeDeps(show(branch, f))]);
    const unreadable = pairs.filter(([, a, b]) => a === 'unreadable' || b === 'unreadable').map(([f]) => f);
    const changed = pairs.filter(([f, a, b]) => !unreadable.includes(f) && a !== b).map(([f]) => f);
    check('No new runtime dependency', !changed.length, `runtime dependencies changed in ${changed.join(', ')}; a human should accept them`, hard);
    if (unreadable.length) check('Manifests readable', false, `could not read the dependencies of ${unreadable.join(', ')}`);
  } else {
    check('No new runtime dependency', true);
  }

  return { result: hard.length ? 'escalate' : soft.length ? 'inconclusive' : 'approve', hard, soft, checks, dir: facts.dir, head, flags };
}

function decisionText(first, reason, checks) {
  return [first, reason, '', `Decided by: ${engineCommand('approve')}`, '', '## Checks', ...checks, ''].join('\n');
}

function main(args) {
  if (args.length !== 1) throw new Usage('approve <job-id>');
  const root = factoryRoot();
  let outcome;
  try {
    outcome = inspect(root, args[0]);
  } catch (err) {
    if (err instanceof Refused || err instanceof Usage) throw err;
    throw new Refused(err.message);
  }
  const { result, hard, soft, checks, dir, head, flags } = outcome;
  if (result === 'approve') {
    writeAtomic(join(dir, 'decision.md'), decisionText('APPROVE', 'Every deterministic check passed.', checks));
    recordApproval(root, args[0], head); // job.js, the only writer of job.json, records who approved which head
    process.stdout.write('approve\n');
  } else if (result === 'escalate') {
    writeAtomic(join(dir, 'decision.md'), decisionText('ESCALATE', `${hard[0].replace(/\.$/, '')}.`, checks));
    process.stdout.write(`escalate: ${hard.join('; ')}\n`);
  } else {
    recordInconclusive(root, args[0], { head, reasons: soft, flags }); // job.js keeps the reasons for counting later
    process.stdout.write(`inconclusive: ${soft.join('; ')}\n`);
  }
}

if (isMain(import.meta.url)) runCli(main);
