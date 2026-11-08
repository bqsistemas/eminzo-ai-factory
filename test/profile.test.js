// E6: `profile` measures where a builder's time goes, from its transcripts: shell commands classified as
// wait, check, git or other and timed from call to result. It is how the proposal's numbers are reproduced
// per job, and how a change to the loop is measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, compilePatterns, jobProfile, unsafePattern } from '../factory/lib/profile.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const ID = '042-profile';
const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();

/** A builder transcript: the first prompt names the job folder, then Bash calls and their results. */
function transcript(calls, { id = ID, role = 'eminzo-builder' } = {}) {
  const lines = [{ type: 'user', timestamp: at(0), message: { content: `Job folder: factory/jobs/${id}/` } }];
  calls.forEach(([command, start, end, opts = {}], i) => {
    const id = opts.id ?? `t${i}`;
    const input = { command, ...(opts.background ? { run_in_background: true } : {}) };
    lines.push({ type: 'assistant', timestamp: at(start), message: { content: [{ type: 'tool_use', name: opts.name ?? 'Bash', id, input }] } });
    if (end !== null) lines.push({ type: 'user', timestamp: opts.untimed ? undefined : at(end), message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
  });
  return { text: lines.map((l) => JSON.stringify(l)).join('\n'), agentType: role };
}

test('classify: waits first, then checks, git, and everything else', () => {
  const c = compilePatterns();
  assert.equal(classify('factory/bin/nudge 042-x', c), 'check');
  assert.equal(classify('eminzo nudge 042-x', c), 'check');
  assert.equal(classify('npm test', c), 'check');
  assert.equal(classify('go test ./...', c), 'check');
  assert.equal(classify('sleep 60; pgrep -f bin/nudge', c), 'wait', 'a wait that names a check is a wait');
  assert.equal(classify('while pgrep -f x; do sleep 5; done', c), 'wait');
  assert.equal(classify('until [ -s out.txt ]; do sleep 3; done; cat out.txt', c), 'wait', 'a loop split on ; is still a wait');
  assert.equal(classify('git commit -m x', c), 'git');
  assert.equal(classify('gh pr create', c), 'git');
  assert.equal(classify('cd /w/.worktrees/042-x && git commit -m x', c), 'git', 'git chained after cd');
  assert.equal(classify('git status; gh pr view 7', c), 'git');
  assert.equal(classify('echo digit', c), 'other', 'a word that contains git is not git');
  assert.equal(classify('ls src', c), 'other');
});

test('quoted text never decides the kind, and only the start of a long command is read', () => {
  const c = compilePatterns();
  assert.equal(classify('git commit -m "fix: npm test was flaky"', c), 'git', 'a commit message that names a check');
  assert.equal(classify("echo 'sleep 5'", c), 'other');
  assert.equal(classify(`echo ${'x'.repeat(5000)}; npm test`, c), 'other', 'past the first 2000 characters');
  assert.equal(classify(`cat <<EOF\n${'x'.repeat(5000)}\nEOF\nnpm test`, c), 'check', 'a long heredoc body is dropped before the cut');
  assert.equal(classify('GIT_TRACE=1 git push', c), 'git', 'an env assignment before git');
  assert.equal(classify("git commit -F - <<'EOF'\nfix: don't run npm test\nsleep 3\nEOF", c), 'git', 'a heredoc body is data');
  assert.equal(classify('cat <<EOF > a.txt && npm test\nbody\nEOF', c), 'check', 'the heredoc line itself still counts');
  assert.equal(classify(`git commit -m "x${'y'.repeat(2100)} npm test"`, c), 'git', 'a cut inside a quote drops the open quote');
  assert.equal(classify('git commit -m "x" && npm test', c), 'check', 'a command after a quote still counts');
  assert.equal(classify('bash -c "npm test"', c), 'check', 'the script of sh -c is the command');
  assert.equal(classify("sh -lc 'sleep 30'", c), 'wait');
  assert.equal(classify('if git diff --quiet; then echo same; fi', c), 'git');
  assert.equal(classify('echo $(git rev-parse HEAD)', c), 'git');
});

test('a repository pattern that can backtrack without bound is skipped; a bounded one is kept', () => {
  for (const p of ['(a+)+', '((a+))+', '((a+)b)*', '(a|aa)+', '(\\d+,)*']) assert.equal(unsafePattern(p), true, p);
  for (const p of ['([+-])+', '(a+){2}', 'run e2e', '--smoke\\b', '(?:npm|pnpm) test']) assert.equal(unsafePattern(p), false, p);
});

test('a repository adds its own patterns; an invalid one is skipped', () => {
  const c = compilePatterns({ check: ['run e2e', '[invalid'] });
  assert.equal(classify('npm --prefix app run e2e', c), 'check');
  assert.equal(classify('npm run build', c), 'other');
  const unsafe = compilePatterns({ check: ['(a+)+$', '((x*))*', 'run e2e'] });
  assert.equal(unsafe.check.length, compilePatterns().check.length + 1, 'a nested quantifier is skipped');
});

test('parallel commands of a kind share wall time; a background command is counted and its output read is a wait', () => {
  const profile = jobProfile([transcript([
    ['npm test', 1, 4],
    ['npm test -- --grep x', 2, 5],
    ['npm run e2e', 6, 6.1, { background: true }],
    ['', 7, 10, { name: 'BashOutput' }],
  ])], ID);
  assert.equal(profile.time_by_kind.check, 4, '[1,4] and [2,5] overlap: 4 minutes, not 6');
  assert.equal(profile.commands_by_kind.check, 2);
  assert.equal(profile.time_by_kind.wait, 3);
  assert.equal(profile.background_commands, 1);
});

test('a result without a time is counted as untimed; a resumed transcript is counted once', () => {
  const one = transcript([['npm test', 1, 3], ['git push', 4, 5, { untimed: true }]]);
  const profile = jobProfile([one, one], ID);
  assert.equal(profile.untimed_commands, 1);
  assert.equal(profile.commands_by_kind.check, 1, 'the same tool call in two transcripts counts once');
  assert.equal(profile.time_by_kind.check, 2);
});

test('a call and its result in two transcripts of a resumed builder are matched; a call with no result is untimed', () => {
  const head = { type: 'user', timestamp: at(0), message: { content: `Job folder: factory/jobs/${ID}/` } };
  const use = { type: 'assistant', timestamp: at(1), message: { content: [{ type: 'tool_use', name: 'Bash', id: 'r1', input: { command: 'npm test' } }] } };
  const result = { type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result', tool_use_id: 'r1' }] } };
  const lost = { type: 'assistant', timestamp: at(5), message: { content: [{ type: 'tool_use', name: 'Bash', id: 'r2', input: { command: 'git push' } }] } };
  const file = (lines) => ({ text: lines.map((l) => JSON.stringify(l)).join('\n'), agentType: 'eminzo-builder' });
  const profile = jobProfile([file([head, use]), file([head, use, result, lost])], ID);
  assert.equal(profile.time_by_kind.check, 3);
  assert.equal(profile.commands_by_kind.check, 1);
  assert.equal(profile.untimed_commands, 1, 'git push never got a result');
});

test('idle time between rounds is not builder time; a long foreground check is', () => {
  const idle = jobProfile([transcript([['npm test', 1, 2], ['git push', 120, 121]])], ID);
  assert.equal(idle.builder_minutes, 3, '0..1, 1..2, 120..121: the 118-minute gap is idle');
  const long = jobProfile([transcript([['factory/bin/nudge 042-profile', 1, 41]])], ID);
  assert.equal(long.builder_minutes, 41, 'a 40-minute nudge is busy');
  assert.ok(long.time_by_kind.check <= long.builder_minutes);
});

test('AC-1: minutes and commands per kind match the transcript', () => {
  const profile = jobProfile([transcript([
    ['factory/bin/nudge 042-profile', 1, 4],
    ['sleep 120; pgrep -f bin/nudge', 5, 7],
    ['git commit -m x', 8, 8.5],
    ['ls', 9, 9.2],
  ])], ID);
  assert.deepEqual(profile.time_by_kind, { wait: 2, check: 3, git: 0.5, other: 0.2 });
  assert.deepEqual(profile.commands_by_kind, { wait: 1, check: 1, git: 1, other: 1 });
  assert.equal(profile.transcripts, 1);
  assert.equal(profile.builder_minutes, 9.2);
});

test('only the builder of this job counts; a command with no result is not timed', () => {
  const profile = jobProfile([
    transcript([['npm test', 1, 3]]),
    transcript([['npm test', 1, 30]], { id: '043-other' }),
    transcript([['npm test', 1, 30]], { role: 'eminzo-review-code' }),
    transcript([['npm test', 1, null]]),
  ], ID);
  assert.equal(profile.time_by_kind.check, 2);
  assert.equal(profile.commands_by_kind.check, 1);
  assert.equal(profile.transcripts, 2);
});

// The command: `job <id> profile` stores the result in job.json (job stays the only writer).
function cli({ provider = 'claude', transcripts = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-profile-'));
  const root = join(dir, 'root');
  const tdir = join(dir, 'transcripts', 'session', 'subagents');
  mkdirSync(join(root, 'factory/jobs', ID), { recursive: true });
  mkdirSync(tdir, { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), readFileSync(join(repo, 'factory/config.json')));
  const job = { id: ID, issue: 42, title: 'x', stage: 'build', round: 1, max_rounds: 3, provider, cost_usd: 1.5 };
  writeFileSync(join(root, 'factory/jobs', ID, 'job.json'), JSON.stringify(job));
  transcripts.forEach((t, i) => {
    writeFileSync(join(tdir, `agent-${i}.jsonl`), t.text);
    writeFileSync(join(tdir, `agent-${i}.meta.json`), JSON.stringify({ agentType: t.agentType }));
  });
  const env = { ...process.env, FACTORY_ROOT: root, FACTORY_TRANSCRIPTS: join(dir, 'transcripts') };
  const run = (bin, args) => spawnSync('sh', [join(repo, 'factory/bin', bin), ...args], { encoding: 'utf8', env });
  return { run, job: () => JSON.parse(readFileSync(join(root, 'factory/jobs', ID, 'job.json'), 'utf8')) };
}

test('AC-3: job <id> profile stores time_by_kind in job.json without touching other fields, and prints a table', () => {
  const t = cli({ transcripts: [transcript([['npm test', 1, 4], ['git push', 5, 6]])] });
  const res = t.run('job', [ID, 'profile']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /check\s+3(\.0)? min/);
  const job = t.job();
  assert.deepEqual(job.time_by_kind, { wait: 0, check: 3, git: 1, other: 0 });
  assert.deepEqual(job.commands_by_kind, { wait: 0, check: 1, git: 1, other: 0 });
  assert.equal(job.cost_usd, 1.5);
  assert.equal(job.stage, 'build');
  assert.equal(job.profiled_round, 1);
  assert.ok(Date.parse(job.profiled_at));
  const again = t.run('job', [ID, 'profile']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(t.job().updated, job.updated, 'an unchanged profile does not touch the job');
});

test('factory/bin/profile <id> is the same command', () => {
  const t = cli({ transcripts: [transcript([['npm test', 1, 2]])] });
  assert.equal(t.run('profile', [ID]).status, 0);
  assert.equal(t.job().time_by_kind.check, 1);
});

test('AC-2: a job without a builder transcript does not fail, says so and writes nothing', () => {
  const t = cli();
  const res = t.run('job', [ID, 'profile']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no builder transcript/);
  assert.equal(t.job().time_by_kind, undefined);
});

test('a Codex job says profile is not supported and writes nothing', () => {
  const t = cli({ provider: 'codex', transcripts: [transcript([['npm test', 1, 2]])] });
  const res = t.run('job', [ID, 'profile']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /profile: codex not supported/);
  assert.equal(t.job().time_by_kind, undefined);
});

import { builderTime, stageDetails } from '../factory/pipeline-canvas.js';

test('AC-4: the dashboard shows the builder time on the build stage, localized', () => {
  const job = { id: ID, stage: 'build', time_by_kind: { wait: 2, check: 3, git: 0.5, other: 0.2 } };
  assert.equal(builderTime(job), 'checks 3.0 · waits 2.0 · git 0.5 · other 0.2 min');
  assert.equal(builderTime(job, { timeCheck: 'checks', timeWait: 'esperas', timeGit: 'git', timeOther: 'otros' }), 'checks 3.0 · esperas 2.0 · git 0.5 · otros 0.2 min');
  assert.equal(builderTime({ id: ID, time_by_kind: { wait: 2, check: 0, git: 0, other: 0 } }), 'waits 2.0 min', 'the unit follows the last part, whichever parts there are');
  assert.equal(builderTime(job, { timeUnit: 'mn' }), 'checks 3.0 · waits 2.0 · git 0.5 · other 0.2 mn', 'the unit is localized too');
  assert.equal(builderTime({ id: ID }), null, 'no profile yet');
  assert.equal(stageDetails(job, 'build').builderTime, 'checks 3.0 · waits 2.0 · git 0.5 · other 0.2 min');
  assert.equal(stageDetails(job, 'gate').builderTime, null, 'only on the build stage');
  const html = readFileSync(join(repo, 'factory/dashboard.html'), 'utf8');
  assert.equal(html.match(/"pipelineBuilderTime":/g).length, 3, 'en, es and pt');
  assert.equal(html.match(/"timeUnit":/g).length, 3);
});
