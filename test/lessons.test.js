// P4: `## Lessons` in decision.md, `job lessons` into project.md, and the opt-in lessons.required check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyLessons, collectLessons, lessonsOf, normalizeLesson, rankLessons } from '../factory/lib/lessons.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(repo, rel), 'utf8');
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const FAKE_GH = (log) => `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const i = args.indexOf('--body-file');
const entry = { args };
if (i >= 0) entry.body = fs.readFileSync(args[i + 1], 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');
if (args[0] === 'pr' && args[1] === 'create') process.stdout.write('https://github.com/o/r/pull/99\\n');
else { process.stderr.write('unexpected gh call\\n'); process.exit(1); }
`;

const PROJECT = '# Project context\n\n## Stack\n\n- Node\n\n## Conventions\n\n- Commit style.\n';

/** A clone with a bare origin on main, jobs with decisions, and a fake gh. */
function setup({ decisions = {}, project = PROJECT, config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-lessons-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, root);
  git(root, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ base: 'origin/main', ...config }));
  writeFileSync(join(root, 'factory/project.md'), project);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'main');
  for (const [id, text] of Object.entries(decisions)) {
    mkdirSync(join(root, 'factory/jobs', id), { recursive: true });
    writeFileSync(join(root, 'factory/jobs', id, 'decision.md'), text);
  }
  const log = join(dir, 'gh.jsonl');
  writeFileSync(log, '');
  const gh = join(dir, 'gh');
  writeFileSync(gh, FAKE_GH(log));
  chmodSync(gh, 0o755);
  const env = { ...process.env, ...GIT_ENV, FACTORY_ROOT: root, FACTORY_GH: gh };
  return {
    dir, root, origin,
    job: (...args) => spawnSync('sh', [join(repo, 'factory/bin/job'), ...args], { encoding: 'utf8', cwd: root, env }),
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

const decision = (...lessons) => `APPROVE\nOk.\n\n## Checks\n- [x] all\n\n## Lessons\n${lessons.length ? lessons.map((l) => `- ${l}`).join('\n') : 'None'}\n`;
const ok = (res) => { assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`); return res.stdout.trim(); };

test('P4: approver.md asks for ## Lessons, and the script approver writes it', () => {
  const role = read('factory/roles/approver.md');
  assert.match(role, /^## Lessons$/m);
  assert.match(role, /`None`/);
  assert.match(read('factory/lib/approve.js'), /'## Lessons', 'None'/);
});

test('P4: lessons.required is false in the config and in the template', () => {
  for (const f of ['factory/config.json', 'factory/templates/config.json']) assert.deepEqual(JSON.parse(read(f)).lessons, { required: false }, f);
});

function approveFixture(config) {
  const t = setup({ config });
  const id = '007-thing';
  mkdirSync(join(t.root, 'factory/jobs', id), { recursive: true });
  writeFileSync(join(t.root, 'factory/jobs', id, 'job.json'), JSON.stringify({
    id, issue: 7, title: 'x', pr: null, branch: `factory/${id}`, worktree: join(t.dir, 'wt'), port: 3001, stage: 'approve', round: 1, max_rounds: 3,
    lane: 'normal', agents: { builder: 'opus', reviewers: { code: 'sonnet' } }, reviews: {}, history: [], approve_entered: new Date().toISOString(),
  }));
  return { t, id, write: (text) => writeFileSync(join(t.root, 'factory/jobs', id, 'decision.md'), text) };
}

test('P4 AC-1: with lessons.required a decision.md without ## Lessons is refused at merging, with a clear message', () => {
  const { t, id, write } = approveFixture({ lessons: { required: true } });
  write('APPROVE\nAll good.\n');
  const res = t.job(id, 'to', 'merging');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /decision\.md has no `## Lessons` section/);
  assert.match(res.stderr, /lessons\.required/);
  write('APPROVE\nAll good.\n\n## Lessons\n');
  assert.match(t.job(id, 'to', 'merging').stderr, /## Lessons/, 'an empty section does not count');
  write(decision());
  assert.doesNotMatch(t.job(id, 'to', 'merging').stderr, /## Lessons/, '`None` is a valid section');
  write(decision('Run the formatter before committing.'));
  assert.doesNotMatch(t.job(id, 'to', 'merging').stderr, /## Lessons/);
});

test('P4 AC-1: without lessons.required (the default) the check does not apply', () => {
  const { t, id, write } = approveFixture({});
  write('APPROVE\nAll good.\n');
  assert.doesNotMatch(t.job(id, 'to', 'merging').stderr, /## Lessons/);
});

test('P4 AC-2: lessons that differ only in case and punctuation are one lesson', () => {
  assert.equal(normalizeLesson('Run the Formatter, first!'), normalizeLesson('run the formatter first'));
  assert.deepEqual(lessonsOf('APPROVE\n\n## Lessons\n- A **Thing**.\n- None\n\n## Other\n- x\n'), ['A Thing.']);
  assert.deepEqual(lessonsOf('APPROVE\n\n## Lessons\nNone\n'), []);
  const t = setup({ decisions: {
    '001-a': decision('Run the formatter first.', 'Keep PRs small.'),
    '002-b': decision('RUN THE FORMATTER, FIRST'),
  } });
  const got = collectLessons(t.root, 20);
  assert.equal(got.length, 2);
  const fmt = got.find((e) => e.key === 'run the formatter first');
  assert.equal(fmt.count, 2);
  assert.equal(fmt.text, 'Run the formatter first.');
});

test('P4 AC-3: the section never exceeds 15 lines and keeps the most repeated lessons', () => {
  const decisions = {};
  for (let i = 1; i <= 20; i += 1) decisions[`${String(i).padStart(3, '0')}-j`] = decision(`Unique lesson number ${i}`, 'The repeated one', ...(i % 2 ? ['Odd jobs repeat this'] : []));
  const t = setup({ decisions });
  const out = ok(t.job('lessons', '--last', '20'));
  assert.match(out, /15 lines/);
  const pr = t.calls()[0];
  assert.equal(pr.args[0], 'pr');
  const branch = pr.args[pr.args.indexOf('--head') + 1];
  const project = git(t.root, '--no-pager', 'show', `origin/${branch}:factory/project.md`);
  const body = project.split('\n## Things the builder gets wrong\n')[1].split('\n## ')[0];
  const bullets = body.split('\n').filter((l) => l.trim());
  assert.ok(bullets.length <= 15 && bullets.length === 15, `${bullets.length} bullets`);
  assert.equal(bullets[0], '- The repeated one');
  assert.equal(bullets[1], '- Odd jobs repeat this');
  assert.ok(project.includes('## Conventions'), 'the rest of project.md stays');
});

test('P4: rankLessons caps at 15 with the most repeated first, and applyLessons replaces an existing section', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, text: `L${i}`, count: i % 5 + 1, order: i }));
  const ranked = rankLessons(many);
  assert.equal(ranked.length, 15);
  assert.ok(ranked.every((e, i) => i === 0 || ranked[i - 1].count >= e.count));
  const once = applyLessons('# P\n\n## Things the builder gets wrong\n\n- old\n\n## Conventions\n\n- c\n', [{ text: 'new' }]);
  assert.equal(once, '# P\n\n## Things the builder gets wrong\n- new\n\n## Conventions\n\n- c\n');
  assert.equal(applyLessons(once, [{ text: 'new' }]), once, 'idempotent');
});

test('P4 AC-4: the PR touches only factory/project.md and a human merges it; the main checkout is untouched', () => {
  const t = setup({ decisions: { '001-a': decision('Write the test first.') } });
  const out = ok(t.job('lessons'));
  assert.match(out, /https:\/\/github\.com\/o\/r\/pull\/99/);
  const [call] = t.calls();
  assert.deepEqual(call.args.slice(0, 2), ['pr', 'create']);
  assert.equal(call.args[call.args.indexOf('--base') + 1], 'main');
  const branch = call.args[call.args.indexOf('--head') + 1];
  assert.match(branch, /^factory\/lessons-\d{8}-\d{6}$/);
  assert.equal(git(t.root, 'diff', '--name-only', 'origin/main', `origin/${branch}`), 'factory/project.md');
  assert.match(git(t.root, 'log', '-1', '--format=%s', `origin/${branch}`), /^docs\(factory\): /);
  assert.match(call.body, /Only `factory\/project\.md` changes/);
  assert.equal(git(t.root, 'status', '--porcelain', '--', 'factory/project.md', 'factory/config.json'), '');
  assert.equal(git(t.root, 'branch', '--list', branch), '', 'no leftover local branch');
  assert.equal(readFileSync(join(t.root, 'factory/project.md'), 'utf8'), PROJECT);
});

test('P4: with no lessons, or nothing new, no branch and no PR', () => {
  const none = setup({ decisions: { '001-a': decision() } });
  assert.match(ok(none.job('lessons')), /no lessons/);
  assert.deepEqual(none.calls(), []);
  const bad = none.job('lessons', '--last', 'x');
  assert.equal(bad.status, 2);
});
