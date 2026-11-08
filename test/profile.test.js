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

import { classify, compilePatterns, jobProfile } from '../factory/lib/profile.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const ID = '042-profile';
const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();

/** A builder transcript: the first prompt names the job folder, then Bash calls and their results. */
function transcript(calls, { id = ID, role = 'eminzo-builder' } = {}) {
  const lines = [{ type: 'user', timestamp: at(0), message: { content: `Job folder: factory/jobs/${id}/` } }];
  calls.forEach(([command, start, end], i) => {
    lines.push({ type: 'assistant', timestamp: at(start), message: { content: [{ type: 'tool_use', name: 'Bash', id: `t${i}`, input: { command } }] } });
    if (end !== null) lines.push({ type: 'user', timestamp: at(end), message: { content: [{ type: 'tool_result', tool_use_id: `t${i}` }] } });
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
  assert.equal(classify('git commit -m x', c), 'git');
  assert.equal(classify('gh pr create', c), 'git');
  assert.equal(classify('ls src', c), 'other');
});

test('a repository adds its own patterns; an invalid one is skipped', () => {
  const c = compilePatterns({ check: ['run e2e', '[invalid'] });
  assert.equal(classify('npm --prefix app run e2e', c), 'check');
  assert.equal(classify('npm run build', c), 'other');
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
  assert.equal(builderTime(job), 'checks 3.0 min · waits 2.0 · git 0.5 · other 0.2');
  assert.equal(builderTime(job, { timeCheck: 'checks', timeWait: 'esperas', timeGit: 'git', timeOther: 'otros' }), 'checks 3.0 min · esperas 2.0 · git 0.5 · otros 0.2');
  assert.equal(builderTime({ id: ID }), null, 'no profile yet');
  assert.equal(stageDetails(job, 'build').builderTime, 'checks 3.0 min · waits 2.0 · git 0.5 · other 0.2');
  assert.equal(stageDetails(job, 'gate').builderTime, null, 'only on the build stage');
  const html = readFileSync(join(repo, 'factory/dashboard.html'), 'utf8');
  assert.equal(html.match(/"pipelineBuilderTime":/g).length, 3, 'en, es and pt');
});
