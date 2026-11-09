// Job 020: language setting. Same fake-gh harness as test/job-merge.test.js (its own copy, not shared).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardSource } from './helpers/dashboard-source.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const configText = readFileSync(join(repo, 'factory/config.json'), 'utf8');

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const CHECKS = `#!/bin/sh
echo "checks: running"
if [ -f BROKEN ]; then echo "checks: BROKEN is present"; exit 1; fi
echo "checks: ok"
`;

// CommonJS on purpose: the temp folder has no package.json.
const fakeGh = (stateFile, logFile) => `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const entry = { args };
if (flag('--body') !== undefined) entry.body = flag('--body');
if (flag('--body-file') !== undefined) entry.body = fs.readFileSync(flag('--body-file'), 'utf8');
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(entry) + '\\n');
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state, null, 2));
const out = (value) => process.stdout.write(JSON.stringify(value));
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const [a, b, n] = args;
const issue = state.issues[n];
const pr = state.prs.find((p) => String(p.number) === n);
if (a === 'issue' && b === 'view') { if (!issue) fail('no such issue'); out(issue); }
else if (a === 'issue' && b === 'comment') {
  if (!issue) fail('no such issue');
  issue.comments.push({ author: { login: state.viewer }, body: entry.body, createdAt: new Date().toISOString(), viewerDidAuthor: true });
  save();
} else if (a === 'issue' && b === 'edit') {
  if (!issue) fail('no such issue');
  if (flag('--add-label')) issue.labels.push({ name: flag('--add-label') });
  if (flag('--remove-label')) issue.labels = issue.labels.filter((l) => l.name !== flag('--remove-label'));
  save();
} else if (a === 'pr' && b === 'list') {
  out(state.prs.filter((p) => p.headRefName === flag('--head') && p.state === 'OPEN'));
} else if (a === 'pr' && b === 'view') { if (!pr) fail('no such pr'); out(pr); }
else if (a === 'pr' && b === 'merge') { if (!pr) fail('no such pr'); pr.state = 'MERGED'; save(); }
else if (a === 'pr' && (b === 'ready' || b === 'comment')) { if (!pr) fail('no such pr'); }
`;

// Async, so the tests below can run concurrently (each has its own temp root).
function runAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function setup({ viewer = 'factory-owner', language } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-job-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\nfactory/board.json\n.worktrees/\n');
  const cfg = JSON.parse(configText);
  delete cfg.language;
  if (language !== undefined) cfg.language = language;
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(cfg));
  writeFileSync(join(root, 'factory/checks.sh'), CHECKS);
  writeFileSync(join(root, 'app.txt'), 'v1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');

  const stateFile = join(dir, 'gh-state.json');
  const logFile = join(dir, 'gh-log.jsonl');
  const gh = join(dir, 'gh');
  writeFileSync(stateFile, JSON.stringify({ viewer, issues: {}, prs: [] }));
  writeFileSync(logFile, '');
  writeFileSync(gh, fakeGh(stateFile, logFile));
  chmodSync(gh, 0o755);

  const env = {
    ...process.env, ...GIT_ENV, FACTORY_ROOT: root, FACTORY_GH: gh, FACTORY_TRANSCRIPTS: join(dir, 'transcripts'),
  };
  const jobsDir = join(root, 'factory/jobs');
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const setState = (fn) => { const s = state(); fn(s); writeFileSync(stateFile, JSON.stringify(s)); };

  return {
    dir, root, origin, gh, env,
    job: (...args) => runAsync(join(repo, 'factory/bin/job'), args, { cwd: root, env }),
    raw: (id) => readFileSync(join(jobsDir, id, 'job.json'), 'utf8'),
    json: (id) => JSON.parse(readFileSync(join(jobsDir, id, 'job.json'), 'utf8')),
    read: (id, rel) => readFileSync(join(jobsDir, id, rel), 'utf8'),
    write(id, rel, text) {
      const file = join(jobsDir, id, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    issue(n, fields = {}) {
      setState((s) => {
        s.issues[n] = {
          number: n, title: `Issue ${n}`, body: 'Please build it.', state: 'OPEN',
          author: { login: 'alice' }, labels: [{ name: 'factory' }], comments: [], ...fields,
        };
      });
    },
    comment(n, login, body) {
      setState((s) => { s.issues[n].comments.push({ author: { login }, body, createdAt: new Date().toISOString() }); });
    },
    pr(number, headRefName, fields = {}) {
      setState((s) => {
        s.prs.push({
          number, headRefName, state: 'OPEN', isCrossRepository: false, headRepositoryOwner: { login: 'bqsistemas' },
          reviews: [], comments: [], ...fields,
        });
      });
    },
    setPr(number, fields) {
      setState((s) => { Object.assign(s.prs.find((p) => p.number === number), fields); });
    },
    state,
    calls: () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    jobIds: () => (existsSync(jobsDir) ? readdirSync(jobsDir) : [])
      .filter((d) => existsSync(join(jobsDir, d, 'job.json'))).sort(),
    board: () => JSON.parse(readFileSync(join(root, 'factory/board.json'), 'utf8')),
  };
}

// A successful transition: exit 0, and board.json lists every job.json.
function ok(t, res) {
  assert.equal(res.status, 0, `expected success, got ${res.status}: ${res.stderr}`);
  assert.deepEqual(t.board().jobs.map((j) => j.id), t.jobIds(), 'board.json lists every job.json');
  return res.stdout.trim();
}

// A refused transition: exit 1, `refused:` on stderr, job.json byte-identical.
async function refused(t, id, ...args) {
  const before = t.raw(id);
  const res = await t.job(id, ...args);
  assert.equal(res.status, 1, `expected refusal for ${args.join(' ')}, got ${res.status}: ${res.stdout}${res.stderr}`);
  assert.match(res.stderr, /^refused: /m);
  assert.equal(t.raw(id), before, `job.json byte-identical after ${args.join(' ')}`);
}

const INTAKE = (decision, risk = 'low', surfaces = 'none') =>
  `${decision}\nRISK: ${risk}\nSURFACES: ${surfaces}\nRESCOPED: no\n\n## Scope\nThe toggle only.\n\n## Reason\nClear request.\n`;

// Drives a fresh job from intake to the start of a gate check in round 1.
async function toGate(t, id, pr = 31) {
  t.write(id, 'intake.md', INTAKE('ACCEPT'));
  ok(t, await t.job(id, 'to', 'spec'));
  t.write(id, 'spec.md', '# Spec\n');
  ok(t, await t.job(id, 'to', 'build'));
  t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Spec deviations\nNone\n');
  t.pr(pr, `factory/${id}`);
  ok(t, await t.job(id, 'to', 'gate'));
}

// From gate, with a passing gate and passing reviews, to approve.
async function gateToApprove(t, id) {
  const { round } = t.json(id);
  t.write(id, `round-${round}/checks.md`, 'GATE: PASS\n');
  ok(t, await t.job(id, 'to', 'review'));
  for (const lens of Object.keys(t.json(id).reviews)) {
    t.write(id, `round-${round}/review-${lens}.md`, 'VERDICT: PASS\n');
  }
  ok(t, await t.job(id, 'to', 'approve'));
}


const { githubBody, parseIntake } = await import('../factory/lib/job.js');
const { LANGUAGES, configLanguage } = await import('../factory/lib/util.js');

const KINDS = {
  intake: { id: '020-x', decision: 'ACCEPT', header: 'ACCEPT\nRISK: low\nSURFACES: none\nRESCOPED: no', rest: '## Scope\nOnly this.' },
  'needs-human-pr': { id: '020-x', note: 'the note xyz' },
  'needs-human-issue': { id: '020-x', note: 'the note xyz' },
  'awaiting-merge': { id: '020-x', pr: 42 },
  'pr-closed': { id: '020-x', pr: 42 },
};

describe('job 020: language', { concurrency: true }, () => {
  test('AC-1: configLanguage defaults to en, accepts en/es/pt, rejects anything else', () => {
    assert.equal(configLanguage({}), 'en');
    for (const l of LANGUAGES) assert.equal(configLanguage({ language: l }), l);
    for (const bad of ['fr', 'ES', '', null, 1]) {
      assert.throws(() => configLanguage({ language: bad }), (e) => /language/.test(e.message) && /"en", "es" or "pt"/.test(e.message));
    }
  });

  test('AC-1: factory/bin/job summary exits 1 naming language when it is "fr"', async () => {
    const t = setup({ language: 'fr' });
    const res = await t.job('summary');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /language/);
  });

  test('AC-2: board.json carries the language, en when the key is missing', async () => {
    const pt = setup({ language: 'pt' });
    pt.issue(5);
    ok(pt, await pt.job('new', '5'));
    assert.equal(pt.board().language, 'pt');
    const none = setup();
    none.issue(5);
    ok(none, await none.job('new', '5'));
    assert.equal(none.board().language, 'en');
  });

  test('AC-3: parseIntake ignores the body language', () => {
    for (const body of ['## Alcance\nSolo el botón.', '## Escopo\nApenas o botão.']) {
      const r = parseIntake(`ACCEPT\nRISK: medium\nSURFACES: ui, security\nRESCOPED: no\n\n${body}\n`);
      assert.deepEqual(r, { decision: 'ACCEPT', risk: 'medium', surfaces: ['ui', 'security'], rescoped: false });
    }
  });

  test('AC-3: a job in es with Spanish and Portuguese bodies is driven to merged', async () => {
    const t = setup({ language: 'es' });
    t.issue(7, { title: 'Merge me' });
    const id = ok(t, await t.job('new', '7'));
    t.write(id, 'intake.md', 'ACCEPT\nRISK: low\nSURFACES: none\nRESCOPED: no\n\n## Alcance\nSolo el botón.\n');
    ok(t, await t.job(id, 'to', 'spec'));
    t.write(id, 'spec.md', '# Spec\n');
    ok(t, await t.job(id, 'to', 'build'));
    t.write(id, 'build.md', 'STATUS: READY\n\n# Build\n\n## Cambios\n- Listo.\n\n## Spec deviations\nNone\n');
    t.pr(31, `factory/${id}`);
    ok(t, await t.job(id, 'to', 'gate'));
    t.write(id, 'round-1/checks.md', 'GATE: PASS\n');
    ok(t, await t.job(id, 'to', 'review'));
    for (const lens of Object.keys(t.json(id).reviews)) t.write(id, `round-1/review-${lens}.md`, 'VERDICT: PASS\n\nTudo certo.\n');
    ok(t, await t.job(id, 'to', 'approve'));
    t.write(id, 'decision.md', 'APPROVE\nTodo bien.\n');
    assert.equal(ok(t, await t.job(id, 'to', 'merging')), `${id} merged`);
  });

  test('AC-4: githubBody renders every kind in every language', () => {
    for (const lang of LANGUAGES) {
      for (const [kind, params] of Object.entries(KINDS)) {
        const out = githubBody(lang, kind, params);
        const marker = kind === 'intake' ? 'intake' : 'note';
        assert.ok(out.startsWith(`<!-- factory:${marker} 020-x -->\n`), `${lang} ${kind} marker`);
        if (params.note) assert.ok(out.includes(params.note));
        if (params.pr) assert.ok(out.includes('#42'));
        if (kind === 'awaiting-merge') assert.ok(out.includes('auto_merge'));
        if (kind === 'intake') {
          assert.ok(out.includes(`\`\`\`\n${params.header}\n\`\`\``));
          assert.ok(out.includes(params.rest));
          assert.ok(out.includes('ACCEPT'));
        }
        if (lang !== 'en') assert.notEqual(out, githubBody('en', kind, params), `${lang} ${kind} differs from en`);
      }
    }
    assert.throws(() => githubBody('fr', 'intake', KINDS.intake));
    assert.throws(() => githubBody('en', 'nope', {}));
  });

  test('AC-5: es and pt intake keep the English next-step sentence', () => {
    for (const lang of ['es', 'pt']) {
      const nr = githubBody(lang, 'intake', { ...KINDS.intake, decision: 'NEEDS-INFO' });
      assert.match(nr, /reply/i);
      const rj = githubBody(lang, 'intake', { ...KINDS.intake, decision: 'REJECT' });
      assert.match(rj, /close it/i);
    }
  });

  test('AC-5: needs-human posts the es issue comment through gh', async () => {
    const t = setup({ language: 'es' });
    t.issue(7);
    const id = ok(t, await t.job('new', '7'));
    ok(t, await t.job(id, 'to', 'needs-human', '--note', 'x'));
    const comment = t.calls().filter(({ args }) => args[0] === 'issue' && args[1] === 'comment').pop();
    assert.equal(comment.body, githubBody('es', 'needs-human-issue', { id, note: 'x' }));
    assert.equal(t.json(id).note, 'x');
  });

  test('AC-6: dashboard.html has a complete i18n block and reads board.language', () => {
    const html = dashboardSource();
    const block = html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/);
    assert.ok(block, 'i18n block');
    const dict = JSON.parse(block[1]);
    assert.deepEqual(Object.keys(dict), ['en', 'es', 'pt']);
    const shape = (o) => Object.keys(o).sort().map((k) => (typeof o[k] === 'object' ? `${k}:${shape(o[k])}` : k)).join(',');
    for (const l of ['es', 'pt']) assert.equal(shape(dict[l]), shape(dict.en));
    const walk = (v) => (typeof v === 'object' ? Object.values(v).flatMap(walk) : [v]);
    for (const l of LANGUAGES) {
      assert.ok(!('columns' in dict[l]), `${l} has no columns map`);
      for (const v of walk(dict[l])) assert.ok(typeof v === 'string' && v.trim());
    }
    assert.equal(dict.en.hintNeedsHumanPr, 'merge the PR to approve, or rework it:');
    assert.equal(dict.en.hintNeedsHumanNoPr, 'no PR yet: fix the cause, then resume it:');
    assert.equal(dict.en.hintAwaitingMerge, 'waiting for a reviewer to merge the PR');
    assert.equal(dict.en.hintNeedsInfo, 'waiting for the author to reply on the issue');
    assert.match(html, /board\.language/);
    assert.match(html, /Object\.hasOwn\(I18N/);
  });

  test('AC-7: every agent file states the language rule and SKILL.md documents it', () => {
    const sentence = 'Write prose in the configured language; keep technical terms and protocol tokens in English.';
    // The language paragraph is generated into every agent (factory/templates/agent-shared.md), not written in the roles.
    const files = readdirSync(join(repo, 'factory/roles')).filter((f) => f.endsWith('.md')).flatMap((f) => [`.claude/agents/eminzo-${f}`, `.codex/agents/eminzo-${f.replace(/\.md$/, '.toml')}`]);
    assert.equal(files.length, 16);
    for (const f of files) {
      const text = readFileSync(join(repo, f), 'utf8');
      assert.ok(text.includes(sentence), `${f} sentence`);
      assert.ok(text.includes('`Language:` line of your prompt'), `${f} reads the prompt Language: line`);
    }
    const skill = readFileSync(join(repo, '.claude/skills/eminzo-factory/SKILL.md'), 'utf8');
    assert.match(skill, /language/);
    assert.match(skill, /agents read the `Language:` line[^]*?`factory\/config\.json` plus `factory\/config\.local\.json`/);
  });

  test('AC-8: the repo config sets language es and it is accepted', () => {
    const cfg = JSON.parse(configText);
    assert.equal(cfg.language, 'es');
    assert.equal(configLanguage(cfg), 'es');
  });
});
