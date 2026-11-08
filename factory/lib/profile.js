// Where a builder's time goes (E6): each shell command the builder ran, from its Claude Code transcripts,
// classified by pattern (wait, check, git, other) and timed from the tool call to its result. It is what
// tells whether the checks, the waits or the model dominate a round. Pure: the caller reads the transcripts
// (cost.js readAgentTranscripts) and stores the result in job.json through `job <id> profile`.
import { entries, promptText, transcriptRole } from './cost.js';

/** The kinds, in the order a command is matched (a wait that names a check is still a wait). */
export const KINDS = Object.freeze(['wait', 'check', 'git', 'other']);

/**
 * Patterns that hold for any repository. A repository adds its own in config.json
 * `profile.patterns` ({ "check": ["run e2e"] }): they extend these, they never replace them.
 */
export const DEFAULT_PATTERNS = Object.freeze({
  wait: ['^\\s*(sleep|wait)\\b', '\\bpgrep\\b', '\\b(while|until)\\b.*\\bsleep\\b'],
  check: [
    'factory/bin/(nudge|gate|visual)\\b', '\\beminzo (nudge|gate|visual)\\b', 'checks\\.sh\\b',
    '\\b(npm|pnpm|yarn|bun)( run)? test\\b', '\\bnode --test\\b',
    '\\b(pytest|go test|cargo test|mvn|gradle|gradlew|make test|rspec|phpunit|dotnet test)\\b',
  ],
  git: ['^\\s*(git|gh)\\b'],
});

/** The patterns as RegExps: the defaults plus `extra` (config.json profile.patterns); a pattern that is not a valid regex is skipped. */
export function compilePatterns(extra = {}) {
  const out = {};
  for (const kind of KINDS.filter((k) => k !== 'other')) {
    const added = Array.isArray(extra?.[kind]) ? extra[kind].filter((p) => typeof p === 'string' && p) : [];
    out[kind] = [...DEFAULT_PATTERNS[kind], ...added].flatMap((p) => {
      try { return [new RegExp(p)]; } catch { return []; }
    });
  }
  return out;
}

/** The kind of one shell command. */
export function classify(command, compiled = compilePatterns()) {
  const text = String(command ?? '');
  for (const kind of ['wait', 'check', 'git']) if (compiled[kind].some((re) => re.test(text))) return kind;
  return 'other';
}

const isBuilder = (role) => String(role ?? '').replace(/^(?:eminzo|factory)-/, '') === 'builder';
const minutes = (ms) => Math.round(ms / 6000) / 10;

/**
 * The builder's time in `jobId`: minutes and number of shell commands per kind, and the minutes from the first
 * to the last entry of each builder transcript (`builder_minutes`). Only transcripts whose first prompt names
 * factory/jobs/<id>/ and whose agent is the builder count; a command with no result is not timed.
 */
export function jobProfile(transcripts, jobId, patterns) {
  const needle = `factory/jobs/${jobId}/`;
  const compiled = compilePatterns(patterns);
  const ms = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const count = Object.fromEntries(KINDS.map((k) => [k, 0]));
  let found = 0;
  let span = 0;
  for (const item of transcripts) {
    const text = typeof item === 'string' ? item : item?.text;
    if (!String(text).includes(needle)) continue;
    const lines = entries(text);
    const first = lines.find((e) => e?.type === 'user');
    if (!first || !promptText(first.message?.content).includes(needle)) continue;
    if (!isBuilder(transcriptRole(typeof item === 'string' ? undefined : item.agentType, lines))) continue;
    found += 1;
    const times = lines.map((e) => Date.parse(e?.timestamp)).filter(Number.isFinite);
    if (times.length) span += Math.max(...times) - Math.min(...times);
    const open = new Map();
    for (const e of lines) {
      const at = Date.parse(e?.timestamp);
      const blocks = Array.isArray(e?.message?.content) ? e.message.content : [];
      for (const b of blocks) {
        if (e.type === 'assistant' && b?.type === 'tool_use' && b.name === 'Bash' && typeof b.id === 'string') {
          open.set(b.id, { kind: classify(b.input?.command, compiled), at });
        } else if (e.type === 'user' && b?.type === 'tool_result' && open.has(b.tool_use_id)) {
          const call = open.get(b.tool_use_id);
          open.delete(b.tool_use_id);
          count[call.kind] += 1;
          if (Number.isFinite(at) && Number.isFinite(call.at) && at >= call.at) ms[call.kind] += at - call.at;
        }
      }
    }
  }
  return {
    transcripts: found,
    builder_minutes: minutes(span),
    time_by_kind: Object.fromEntries(KINDS.map((k) => [k, minutes(ms[k])])),
    commands_by_kind: count,
  };
}
