// Where a builder's time goes (E6): each shell command the builder ran, from its Claude Code transcripts,
// classified by pattern (wait, check, git, other) and timed from the tool call to its result. It is what
// tells whether the checks, the waits or the model dominate a round. Pure: the caller reads the transcripts
// (cost.js readAgentTranscripts) and stores the result in job.json through `job <id> profile`.
import { entries, promptText, transcriptRole } from './cost.js';

/** The kinds, in the order a command is matched (a wait that names a check is still a wait). */
export const KINDS = Object.freeze(['wait', 'check', 'git', 'other']);
const PRIORITY = ['wait', 'check', 'git'];

/**
 * Patterns that hold for any repository, tested on each part of a command (split on `&&`, `||`, `;`
 * and `|`, with quoted text removed). A repository adds its own in config.json `profile.patterns`
 * ({ "check": ["run e2e"] }): they extend these, they never replace them.
 */
export const DEFAULT_PATTERNS = Object.freeze({
  wait: ['^\\s*(sleep|wait)\\b', '\\bpgrep\\b', '\\b(while|until)\\b.*\\bsleep\\b'],
  check: [
    'factory/bin/(nudge|gate|visual)\\b', '\\beminzo (nudge|gate|visual)\\b', 'checks\\.sh\\b',
    '\\b(npm|pnpm|yarn|bun)( run)? test\\b', '\\bnode --test\\b',
    '\\b(pytest|go test|cargo test|mvn|gradle|gradlew|make test|rspec|phpunit|dotnet test)\\b',
  ],
  git: ['(^|\\$\\(|`|\\b(if|then|do|else|elif|while|until)\\s+|!\\s*)\\s*(\\w+=\\S*\\s+)*\\(?\\s*(git|gh)\\b'],
});
/** Only this much of a command is classified, so a long heredoc never makes a pattern slow. */
const MAX_COMMAND = 2000;
/** An unbounded quantifier at `i` (+, *, {n,} or {n,m}), else null; `?` and {n} are bounded. */
function unboundedAt(p, i) {
  if (p[i] === '+' || p[i] === '*') return true;
  return p[i] === '{' && /^\{\d+,\d*\}/.test(p.slice(i)) ? true : null;
}

/**
 * True when a repository's pattern can backtrack for a long time: a group repeated without bound that holds
 * a repeated part or an alternation, at any depth ((a+)+, ((a+))*, (a|aa)+, (\d+,)*). Conservative: a safe
 * pattern of that shape is skipped too; write it without the nesting.
 */
export function unsafePattern(p) {
  const stack = [];
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '[') { // a character class: nothing inside it is a quantifier or a group
      for (i += 1; i < p.length && p[i] !== ']'; i += 1) if (p[i] === '\\') i += 1;
      continue;
    }
    const top = stack.at(-1);
    if (ch === '(') stack.push({ risky: false });
    else if (ch === '|' && top) top.risky = true;
    else if (unboundedAt(p, i) && top) top.risky = true;
    else if (ch === ')' && top) {
      stack.pop();
      if (unboundedAt(p, i + 1) && top.risky) return true;
      const parent = stack.at(-1);
      if (parent && (top.risky || unboundedAt(p, i + 1))) parent.risky = true;
    }
  }
  return false;
}
/** A gap longer than this between two entries of a transcript is idle time (the job waited), not builder time. */
const MAX_GAP_MS = 10 * 60 * 1000;

/** The patterns as RegExps: the defaults plus `extra` (config.json profile.patterns); an invalid or unsafe pattern is skipped. */
export function compilePatterns(extra = {}) {
  const out = {};
  for (const kind of PRIORITY) {
    const added = Array.isArray(extra?.[kind]) ? extra[kind].filter((p) => typeof p === 'string' && p && !unsafePattern(p)) : [];
    out[kind] = [...DEFAULT_PATTERNS[kind], ...added].flatMap((p) => {
      try { return [new RegExp(p)]; } catch { return []; }
    });
  }
  return out;
}

/** A heredoc: its first line is kept (it may chain more commands), its body is data. */
const HEREDOC = /(?<!<)<<(?!<)-?[ \t]*(['"]?)(\w+)\1([^\n]*)(?:\n[ \t]*\2(?=\n|$)|\n[\s\S]*?\n[ \t]*\2(?=\n|$)|\n[\s\S]*$|$)/g;
/** `bash -c '...'` and the like: the quoted script is the command. */
const SHELL_C = /\b(?:bash|sh|zsh|dash)\s+-[a-z]*c\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g;

/**
 * The command as a whole plus each of its parts, with heredoc bodies and quoted text removed (a commit
 * message never decides the kind). The whole is kept because a loop (`until x; do sleep 5; done`) only
 * reads as a wait unsplit. A quote left open where the command is cut is dropped with what follows it.
 */
const parts = (command) => {
  const text = String(command ?? '')
    .replace(HEREDOC, (m, q, tag, rest) => `<<${rest}`)
    .slice(0, MAX_COMMAND)
    .replace(SHELL_C, (m, single, double) => single ?? double)
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '_') // no quote left in the placeholder: the next step drops open quotes
    .replace(/['"][\s\S]*$/, '');
  return [text, ...text.split(/&&|\|\||;|\||\n/)];
};

/** The kind of one shell command: the highest-priority kind among its parts. */
export function classify(command, compiled = compilePatterns()) {
  const pieces = parts(command);
  for (const kind of PRIORITY) if (pieces.some((piece) => compiled[kind].some((re) => re.test(piece)))) return kind;
  return 'other';
}

const isBuilder = (role) => String(role ?? '').replace(/^(?:eminzo|factory)-/, '') === 'builder';
const minutes = (ms) => Math.round(ms / 6000) / 10;

/** Total length of a set of [start, end] intervals, overlaps counted once (parallel commands share wall time). */
function unionMs(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let [start, end] = [null, null];
  for (const [a, b] of sorted) {
    if (end === null || a > end) {
      if (end !== null) total += end - start;
      [start, end] = [a, b];
    } else if (b > end) end = b;
  }
  return end === null ? total : total + end - start;
}

/** The busy spans of one transcript: each gap between consecutive entries up to MAX_GAP_MS (a longer one is idle). */
function busySpans(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const spans = [];
  for (let i = 1; i < sorted.length; i += 1) if (sorted[i] - sorted[i - 1] <= MAX_GAP_MS) spans.push([sorted[i - 1], sorted[i]]);
  return spans;
}

/**
 * The builder's time in `jobId`, from the transcripts of the builder whose first prompt names
 * factory/jobs/<id>/: wall minutes per kind of shell command (parallel commands of a kind counted once),
 * commands per kind, commands sent to the background (they return at once: their run time counts only
 * where the builder waits for them, in a wait loop or an output read, as `wait`), commands with no usable
 * time (no result, or no timestamp), and the builder's active minutes (gaps over MAX_GAP_MS between
 * entries are idle unless a command was running; overlapping transcripts are counted once). A call and its
 * result may sit in different transcripts of the same builder (a resumed session): they are matched by id.
 */
export function jobProfile(transcripts, jobId, patterns) {
  const needle = `factory/jobs/${jobId}/`;
  const compiled = compilePatterns(patterns);
  const intervals = Object.fromEntries(KINDS.map((k) => [k, []]));
  const count = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const seen = new Set();
  const open = new Map();
  let found = 0;
  const busy = [];
  let background = 0;
  let untimed = 0;
  for (const item of transcripts) {
    const text = typeof item === 'string' ? item : item?.text;
    if (!String(text).includes(needle)) continue;
    const lines = entries(text);
    const first = lines.find((e) => e?.type === 'user');
    if (!first || !promptText(first.message?.content).includes(needle)) continue;
    if (!isBuilder(transcriptRole(typeof item === 'string' ? undefined : item.agentType, lines))) continue;
    found += 1;
    busy.push(...busySpans(lines.map((e) => Date.parse(e?.timestamp)).filter(Number.isFinite)));
    for (const e of lines) {
      const at = Date.parse(e?.timestamp);
      const blocks = Array.isArray(e?.message?.content) ? e.message.content : [];
      for (const b of blocks) {
        if (e.type === 'assistant' && b?.type === 'tool_use' && typeof b.id === 'string' && !seen.has(b.id)) {
          if (b.name === 'Bash') {
            seen.add(b.id);
            if (b.input?.run_in_background === true) background += 1;
            open.set(b.id, { kind: classify(b.input?.command, compiled), at });
          } else if (b.name === 'BashOutput') {
            seen.add(b.id);
            open.set(b.id, { kind: 'wait', at }); // reading a background command's output: a blocking read is a wait
          }
        } else if (e.type === 'user' && b?.type === 'tool_result' && open.has(b.tool_use_id)) {
          const call = open.get(b.tool_use_id);
          open.delete(b.tool_use_id);
          if (!Number.isFinite(at) || !Number.isFinite(call.at) || at < call.at) { untimed += 1; continue; }
          count[call.kind] += 1;
          intervals[call.kind].push([call.at, at]);
        }
      }
    }
  }
  untimed += open.size; // a call that never got a result (the builder stopped, or the result is missing)
  return {
    transcripts: found,
    // Active time: the busy spans plus every timed command (a long foreground check is busy, not idle), counted once.
    builder_minutes: minutes(unionMs([...busy, ...KINDS.flatMap((k) => intervals[k])])),
    time_by_kind: Object.fromEntries(KINDS.map((k) => [k, minutes(unionMs(intervals[k]))])),
    commands_by_kind: count,
    background_commands: background,
    untimed_commands: untimed,
  };
}
