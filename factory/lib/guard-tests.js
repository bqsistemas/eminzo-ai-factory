// factory/bin/guard-tests: the builder's PreToolUse hook for Bash (Claude Code). The full test suite runs only in
// the gate, once per round, so a Bash command is refused when any of its simple commands
//   1. runs `factory/checks.sh` (directly or through sh or bash),
//   2. runs the nudge (`factory/bin/nudge`, `eminzo nudge`), or
//   3. is one of the commands listed in `checks.suite_commands` of the MAIN checkout's `factory/config.json`
//      (`eminzo setup` writes the list for the checks.sh it generates; there is no guessing from checks.sh).
// A listed command followed by a non-option argument (a file, a directory, a package, a test name) or by a
// test-selection option (`-k`, `--tests`, `-Dtest`, ...) is targeted and allowed; followed only by other
// flags it is still the full suite. Without a list only 1 and 2 apply.
// It refuses like protect-tests does: exit 2 with the reason on stderr; exit 0 allows. A hook that cannot decide
// (bad JSON, no repository, an unreadable config) allows and prints one `guard-tests: not enforced: <why>` line,
// so it can never wedge the builder. Codex has no hooks: the builder role text is its only guard.
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { isDir, repoOf } from './protect-tests.js';
import { isMain } from './util.js';

const OPERATOR = /^(\d*|&)(>>?|<)(&\d+|\S*)$/;
const REDIRECT_ONLY = /^(\d*|&)(>>?|<)$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL = /^(sh|bash|zsh|dash|ksh)$/;
const SHELL_C = /^-[a-z]*c$/;
// Options that select which tests run: a command carrying one is targeted.
const SELECTION = new Set(['-Dtest', '--tests', '-k', '-run', '--test-name-pattern', '-t', '--testNamePattern', '-g', '--grep', '-p', '--package']);

/** Splits a command into simple commands (on && || ; | & and newlines, outside quotes), each as shell-like tokens. */
export function simpleCommands(text) {
  const commands = [];
  let tokens = [];
  let word = '';
  let has = false;
  const endWord = () => { if (has) tokens.push(word); word = ''; has = false; };
  const endCommand = () => { endWord(); if (tokens.length) commands.push(tokens); tokens = []; };
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) { if (s[i + 1] !== '\n') { word += s[i + 1]; has = true; } i++; continue; }
    if (ch === "'" || ch === '"') {
      const end = s.indexOf(ch, i + 1);
      const stop = end < 0 ? s.length : end;
      word += s.slice(i + 1, stop);
      has = true;
      i = stop;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|') { endCommand(); if (ch === '|' && s[i + 1] === '|') i++; continue; }
    if (ch === '&') {
      if (s[i + 1] === '&') { endCommand(); i++; continue; }
      if (word.endsWith('>') || word.endsWith('<') || s[i + 1] === '>') { word += ch; has = true; continue; } // 2>&1, &>file
      endCommand();
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { endWord(); continue; }
    word += ch;
    has = true;
  }
  endCommand();
  return commands;
}

/** The tokens of a simple command without its redirections and the cheap wrappers in front of it (VAR=value, time, nohup, command, exec, env, timeout). */
export function normalize(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (REDIRECT_ONLY.test(t)) { i++; continue; }
    if (OPERATOR.test(t) && /[<>]/.test(t)) continue;
    out.push(t);
  }
  for (let again = true; again && out.length;) {
    again = false;
    if (ASSIGNMENT.test(out[0])) { out.shift(); again = true; continue; }
    const head = out[0];
    if (head === 'time' || head === 'nohup' || head === 'command' || head === 'exec') {
      out.shift();
      while (out.length && /^-/.test(out[0])) out.shift();
      again = true;
    } else if (head === 'env') {
      out.shift();
      while (out.length && (/^-/.test(out[0]) || ASSIGNMENT.test(out[0]))) {
        const opt = out.shift();
        if (/^-[uCS]$|^--(unset|chdir|split-string)$/.test(opt)) out.shift(); // an option with a separate value
      }
      again = true;
    } else if (head === 'timeout') {
      out.shift();
      while (out.length && /^-/.test(out[0])) out.shift();
      if (out.length && /^\d+(\.\d+)?[smhd]?$/.test(out[0])) out.shift();
      again = true;
    }
  }
  return out;
}

const sameWords = (a, b) => a.length === b.length && a.every((w, i) => w === b[i]);

/** True when `word` selects tests: `-k`, `--tests`, `-Dtest=X`, `-run=X`, ... */
const selects = (word) => SELECTION.has(word.split('=')[0]) || word.startsWith('-Dtest');

/**
 * True when `candidate` runs the whole `suite` command: it starts with the suite's first word, carries the suite's
 * words in order and has nothing else but flags. A non-option argument or a test-selection option makes it targeted.
 */
export function runsSuite(candidate, suite) {
  if (!suite.length || candidate[0] !== suite[0]) return false;
  let next = 1;
  const extra = [];
  for (const word of candidate.slice(1)) {
    if (next < suite.length && word === suite[next]) next += 1;
    else extra.push(word);
  }
  if (next < suite.length) return false;
  return extra.every((w) => w.startsWith('-') && !selects(w));
}

const endsWithPath = (word, tail) => word === tail || word.endsWith(`/${tail}`);

/** What a normalized simple command is when it runs the checks or the nudge, else null. */
function checksOrNudge(words) {
  let rest = words;
  if (SHELL.test(rest[0] ?? '')) { rest = rest.slice(1); while (rest.length && rest[0].startsWith('-') && !SHELL_C.test(rest[0])) rest = rest.slice(1); }
  if (rest[0] && endsWithPath(rest[0], 'factory/checks.sh')) return 'factory/checks.sh';
  if (words[0] && endsWithPath(words[0], 'factory/bin/nudge')) return 'factory/bin/nudge';
  if (words[0] === 'eminzo' && words[1] === 'nudge') return 'eminzo nudge';
  return null;
}

/** The suite commands (word lists, with their text) listed in `checks.suite_commands` of the main checkout. `notes` collects why they could not be read. */
export function suiteCommands(main, notes = []) {
  const out = [];
  let list;
  try {
    list = JSON.parse(readFileSync(join(main, 'factory/config.json'), 'utf8'))?.checks?.suite_commands;
  } catch (err) {
    if (err.code !== 'ENOENT') notes.push(`no readable factory/config.json in the main checkout (${err.code ?? err.message})`);
    return out;
  }
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      const [first] = simpleCommands(entry);
      const words = first ? normalize(first) : [];
      if (words.length && !out.some((c) => sameWords(c.words, words))) out.push({ text: words.join(' '), words });
    }
  }
  return out;
}

/** The first thing in `command` that must not run, as `{ matched }`, or null. `suites` come from suiteCommands. */
export function findViolation(command, suites, depth = 0) {
  for (const tokens of simpleCommands(command)) {
    const words = normalize(tokens);
    if (!words.length || words[0] === 'cd') continue;
    const hit = checksOrNudge(words);
    if (hit) return { matched: hit };
    const suite = suites.find((s) => runsSuite(words, s.words));
    if (suite) return { matched: suite.text };
    const shell = SHELL.test(words[0]) ? words.findIndex((w, i) => i > 0 && SHELL_C.test(w)) : -1;
    if (shell > 0 && words[shell + 1] && depth < 3) {
      const inner = findViolation(words[shell + 1], suites, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

export const reasonFor = (matched) => `guard-tests: refused \`${matched}\`: the full suite runs only in the gate, once per round. Run only the test files you wrote or changed, with the test runner pointed at those files (the test command is in factory/project.md).`;

/** `{ deny: reason }` or `{ allow: true, note? }` for one tool call. Never throws. */
export function decide(input) {
  try {
    if (input?.tool_name !== undefined && input.tool_name !== 'Bash') return { allow: true };
    const command = input?.tool_input?.command;
    if (typeof command !== 'string' || !command.trim()) return { allow: true };
    const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) && isDir(input.cwd) ? input.cwd : resolve(process.cwd());
    const repo = repoOf(cwd);
    if (!repo) return { allow: true, note: 'not inside a git repository' };
    if (repo.error) return { allow: true, note: repo.error };
    const notes = [];
    const suites = suiteCommands(repo.main, notes);
    const violation = findViolation(command, suites);
    if (violation) return { deny: reasonFor(violation.matched) };
    return notes.length ? { allow: true, note: notes.join('; ') } : { allow: true };
  } catch (err) {
    return { allow: true, note: err?.message ?? 'unexpected error' };
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write('guard-tests: not enforced: the hook input is not JSON\n');
    return 0;
  }
  const verdict = decide(input);
  if (verdict.deny) {
    process.stderr.write(`${verdict.deny}\n`);
    return 2;
  }
  if (verdict.note) process.stderr.write(`guard-tests: not enforced: ${verdict.note}\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
