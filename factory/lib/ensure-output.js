// factory/bin/ensure-output <file> <first-line-regex>: the output contract check.
// Exits 2 with a clear message on stderr when the file is missing or its first line
// does not match, so a Stop hook keeps the agent working until its deliverable exists.
//
// <file> may hold {job} and {round}. They resolve to the job and round folders named in
// the agent's first prompt ("Job folder: ...", "Round folder: ..."), read from the hook
// input (agent_transcript_path), so one hook line works for every job. Relative paths
// resolve against the main checkout. With no job context the check is skipped: this is
// not a factory run. Folder values that are not plain factory/jobs/<id>[/round-N] paths
// are ignored (fail open, with a note). The check blocks an agent at most MAX_BLOCKS times
// (counted per agent transcript, reset by a pass), so a retry that another Stop hook already
// consumed still cannot finish without its file, and nothing can loop forever.
// Existing hook patterns are accepted verbatim, but only these fixed contracts are executable.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { Usage, factoryRoot, firstLine, isMain, readText, runCli } from './util.js';

const USAGE = 'ensure-output <file> <first-line-regex>   ({job} and {round} in <file> resolve from the hook input)';
// Blocks per agent transcript before the hook lets go.
const MAX_BLOCKS = 2;
const JOB_FOLDER = /^factory\/jobs\/(\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const ROUND_FOLDER = /^factory\/jobs\/(\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*)\/round-[1-9]\d*$/;
const PLACEHOLDER = /\{(job|round)\}/g;
// Keep the exact arguments used by installed hooks. Never compile a CLI-provided pattern:
// arbitrary regular expressions can cause catastrophic backtracking on an agent's output.
const CONTRACTS = new Map([
  ['^(ACCEPT|NEEDS-INFO|REJECT)( |$)', /^(ACCEPT|NEEDS-INFO|REJECT)( |$)/],
  ['^# Spec: ', /^# Spec: /],
  ['^STATUS: (READY|BLOCKED)( |$)', /^STATUS: (READY|BLOCKED)( |$)/],
  ['^VERDICT: (PASS|CHANGES)( |$)', /^VERDICT: (PASS|CHANGES)( |$)/],
  ['^(APPROVE|ESCALATE)( |$)', /^(APPROVE|ESCALATE)( |$)/],
  // Direct callers also use word boundaries instead of the hooks' space-or-end suffix.
  ['^STATUS: (READY|BLOCKED)\\b', /^STATUS: (READY|BLOCKED)\b/],
  ['^VERDICT: (PASS|CHANGES)\\b', /^VERDICT: (PASS|CHANGES)\b/],
  ['^(APPROVE|ESCALATE)\\b', /^(APPROVE|ESCALATE)\b/],
]);

function counterPath(transcript) {
  try {
    const root = factoryRoot();
    const factoryDir = join(root, 'factory');
    const jobsDir = join(factoryDir, 'jobs');
    const stateDir = join(jobsDir, '.ensure-output');
    const safeDir = (dir) => {
      const stat = lstatSync(dir);
      return stat.isDirectory() && !stat.isSymbolicLink()
        && (typeof process.getuid !== 'function' || stat.uid === process.getuid())
        && (process.platform === 'win32' || (stat.mode & 0o022) === 0);
    };
    if (!safeDir(factoryDir)) throw new Error('factory directory is not private');
    mkdirSync(jobsDir, { recursive: true });
    if (!safeDir(jobsDir)) throw new Error('jobs directory is not private');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(stateDir);
    if (!safeDir(stateDir) || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('counter directory is not private');
    }
    return join(stateDir, `${createHash('sha256').update(transcript).digest('hex')}.count`);
  } catch (err) {
    // The orchestrator validates outputs too. Never write through an unsafe path or loop forever.
    process.stderr.write(`factory output contract: skipped unsafe counter state (${err.message}).\n`);
    return null;
  }
}

function hookInput() {
  if (process.stdin.isTTY) return null;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    return input && typeof input === 'object' ? input : null;
  } catch {
    return null;
  }
}

function promptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n');
}

/** Job and round folders from the first user prompt of a transcript. */
function folders(transcriptPath) {
  const text = typeof transcriptPath === 'string' ? readText(transcriptPath) : null;
  if (!text) return {};
  for (const line of text.split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'user') continue;
    const prompt = promptText(entry.message?.content);
    const job = /^Job folder: (\S+?)\/?\s*$/m.exec(prompt)?.[1];
    const round = /^Round folder: (\S+?)\/?\s*$/m.exec(prompt)?.[1];
    const jobId = job === undefined ? undefined : JOB_FOLDER.exec(job)?.[1];
    const roundId = round === undefined ? undefined : ROUND_FOLDER.exec(round)?.[1];
    if ((job !== undefined && !jobId) || (round !== undefined && (!roundId || (jobId && roundId !== jobId)))) {
      process.stderr.write('factory output contract: ignored a job or round folder that is not a plain factory/jobs/<id>[/round-N] path.\n');
      return {};
    }
    return { job, round };
  }
  return {};
}

function main(args) {
  if (args.length !== 2) throw new Usage(USAGE);
  const [template, pattern] = args;

  const input = hookInput();
  // Only the agent's own transcript identifies its job; the main session's never does.
  const transcript = typeof input?.agent_transcript_path === 'string' ? input.agent_transcript_path : null;
  const counter = transcript ? counterPath(transcript) : null;
  if (transcript && !counter) return 0;
  const blocked = () => (counter ? Number(readText(counter)) || 0 : 0);
  // Without a transcript to count against, one nudge is the cap, as nudge does.
  if (input && !counter && input.stop_hook_active === true) return 0;
  if (counter && blocked() >= MAX_BLOCKS) {
    rmSync(counter, { force: true });
    return 0;
  }
  const fail = (message) => {
    if (counter) writeFileSync(counter, String(blocked() + 1));
    process.stderr.write(message);
    return 2;
  };
  const regex = CONTRACTS.get(pattern);
  if (!regex) return fail(`factory output contract: unsupported first-line regex ${JSON.stringify(pattern)}.\n`);

  let path = template;
  if (PLACEHOLDER.test(template)) {
    PLACEHOLDER.lastIndex = 0;
    if (!counter) return 0; // not a hook run for an agent: nothing to resolve against
    const found = folders(transcript);
    const missing = [...template.matchAll(PLACEHOLDER)].some(([, key]) => !found[key]);
    if (missing) return 0;
    path = template.replace(PLACEHOLDER, (_, key) => found[key]);
  }
  if (!isAbsolute(path)) {
    let base;
    try {
      base = factoryRoot();
    } catch {
      base = process.cwd();
    }
    path = join(base, path);
  }

  const line = firstLine(path);
  if (line !== null && regex.test(line)) {
    if (counter) rmSync(counter, { force: true });
    return 0;
  }
  if (line === null) {
    return fail(`factory output contract: ${path} is missing. Write it with the Write tool, `
      + 'then run head -1 on it, before you finish.\n');
  }
  return fail(`factory output contract: the first line of ${path} is ${JSON.stringify(line)}; `
    + `it must match ${pattern}. Rewrite the file so its first line is the protocol token.\n`);
}

if (isMain(import.meta.url)) runCli(main);
