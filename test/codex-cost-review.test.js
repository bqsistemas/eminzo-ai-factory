// Review regressions; previously protected cost tests remain untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexJobCost, readCodexRollouts } from '../factory/lib/cost.js';
import { costLabel, costTimeHtml, olderMergedHtml } from '../factory/activity.js';
import { formatCost, headerStats } from '../factory/office.js';
import { stageDetails } from '../factory/pipeline-canvas.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const root = '/repo';
const job = { id: '034-cost', provider: 'codex', worktree: '/repo/.worktrees/034-cost' };
const other = '/repo/.worktrees/999-other';
// Synthetic rates only, not vendor prices.
const prices = { model: { input: 10, cache_read: 2, cache_write: 5, output: 20 } };
const event = (type, payload) => ({ type, payload });
const context = (cwd = job.worktree) => event('turn_context', { cwd, model: 'model' });
const prompt = (text) => event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assignment = `Job folder: factory/jobs/${job.id}/\nBranch: factory/${job.id}`;
const snapshot = (input = 1000, output = 200) => event('event_msg', {
  type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } },
});
const rollout = (rows, meta = {}) => [event('session_meta', { id: 'parent', cwd: job.worktree, ...meta }), ...rows]
  .map((row) => JSON.stringify(row)).join('\n');
const calculate = (rollouts) => codexJobCost(rollouts, job, prices, root);
const unknown = (result, reason = 'ambiguous_session') => assert.deepEqual(result, {
  cost_usd: null, cost_status: 'unavailable', cost_reason: reason,
});

test('AC-2: distinct-ID forks never charge inherited cumulative parent usage twice', () => {
  const history = [prompt(assignment), context(), snapshot()];
  const parent = rollout(history);
  const fork = rollout([...history, prompt(assignment), context(), snapshot(1500, 300)], {
    id: 'fork', forked_from_id: 'parent',
  });
  // No trustworthy inherited-history boundary is present: fail closed, even
  // with a fresh worker assignment, rather than inventing a billable delta.
  unknown(calculate([parent, fork]));
  unknown(calculate([fork, parent, fork]));
  unknown(calculate([fork]));
  assert.equal(calculate([parent]).cost_usd, 0.014);
});

test('AC-3: a fork cannot inherit its parent assignment for an unrelated continuation', () => {
  const fork = rollout([prompt(assignment), context(root), snapshot(),
    prompt('Explain an unrelated topic.'), context(root), snapshot(1500, 300)], {
    id: 'fork', cwd: root, forked_from_id: 'unavailable-parent',
  });
  unknown(calculate([fork]));
});

test('AC-3: every turn cwd is checked, including a resumed session entering another job', () => {
  for (const cwd of [other, `${other}/src`, '/other-repo', 'relative/path', null, 42]) {
    const shared = rollout([context(), snapshot(100, 10), context(cwd), snapshot(1100, 110)]);
    unknown(calculate([shared]));
    unknown(calculate([rollout([context(), snapshot(100, 10)]), shared]));
  }
});

test('AC-3: sessions entering the job from a different initial cwd cannot hide mixed usage', () => {
  const shared = rollout([context(other), snapshot(100, 10), context(), snapshot(1100, 110)], { cwd: other });
  unknown(calculate([shared]));
});

test('AC-3: assigned root/worktree contexts and nested worktree paths remain attributable', () => {
  const dedicated = rollout([prompt(assignment), context(root), snapshot(500, 100),
    context(`${job.worktree}/src`), snapshot()], { cwd: root });
  assert.equal(calculate([dedicated]).cost_status, 'available');
  assert.equal(calculate([dedicated]).cost_usd, 0.014);
});

test('AC-3: fenced, quoted, indented and explanatory assignments are not worker contracts', () => {
  for (const text of [
    `Explain this example without executing it:\n\`\`\`\n${assignment}\n\`\`\``,
    `\`\`\`text\n${assignment}\n\`\`\``,
    `~~~text\n${assignment}\n~~~`,
    assignment.split('\n').map((line) => `> ${line}`).join('\n'),
    assignment.split('\n').map((line) => `    ${line}`).join('\n'),
    `Explain this contract without executing it:\n${assignment}`,
    `Job folder: factory/jobs/${job.id}/\nThis is an example, not an assignment.`,
    `Job folder: factory/jobs/${job.id}/\n\`\`\`\nBranch: factory/${job.id}\n\`\`\``,
  ]) {
    const result = calculate([rollout([prompt(text), context(root), snapshot()], { cwd: root })]);
    assert.equal(result.cost_status, 'unavailable', text);
    assert.equal(result.cost_usd, null, text);
  }
});

test('AC-3: a quote cannot authorize early usage before a genuine worker assignment', () => {
  unknown(calculate([rollout([
    prompt(`Explain this:\n\`\`\`\n${assignment}\n\`\`\``), context(root), snapshot(),
    prompt(assignment), context(root), snapshot(1500, 300),
  ], { cwd: root })]));
});

test('AC-3: full worker contracts accept preceding boilerplate messages, not prose inside the assignment', () => {
  const contract = `Job folder: factory/jobs/${job.id}/\nRound folder: factory/jobs/${job.id}/round-2/\n` +
    `Branch: factory/${job.id}\nWorktree: ${job.worktree}\nIssue: #44\nPort: 3034\nResume: apply corrections.`;
  const dedicated = rollout([prompt('Boilerplate mentioning factory/jobs/999-other/'),
    prompt(contract), context(root), snapshot()], { cwd: root });
  assert.equal(calculate([dedicated]).cost_usd, 0.014);
});

test('AC-4/AC-7: sync preserves unavailable fork/context/quoted states and board parity across repeats', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-cost-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, 'repo'), sessions = join(dir, 'sessions');
  const stored = { ...job, stage: 'build', round: 2, reviews: {}, worktree: join(base, '.worktrees', job.id) };
  const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const jobFile = join(base, 'factory/jobs', job.id, 'job.json');
  write(jobFile, JSON.stringify(stored));
  write(join(base, 'factory/config.json'), JSON.stringify({ providers: { codex: { prices } } }));
  const cli = (...args) => spawnSync(fileURLToPath(new URL('../factory/bin/job', import.meta.url)), args, {
    encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: base, FACTORY_CODEX_SESSIONS: sessions },
  });
  const cases = [
    rollout([prompt(assignment), context(base), snapshot(), snapshot(1500, 300)], {
      cwd: base, id: 'fork', forked_from_id: 'parent',
    }),
    rollout([context(stored.worktree), snapshot(100, 10), context(other), snapshot()], { cwd: stored.worktree }),
    rollout([prompt(`Explain this example:\n\`\`\`\n${assignment}\n\`\`\``), context(base), snapshot()], { cwd: base }),
    rollout([context(other), snapshot(100, 10), context(stored.worktree), snapshot()], { cwd: '/outside-repo' }),
  ];
  for (const source of cases) {
    write(join(sessions, 'rollout.jsonl'), source);
    for (let i = 0; i < 2; i++) {
      const result = cli(job.id, 'sync');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /unavailable/i);
      assert.doesNotMatch(result.stdout, /\$0\.00/);
      const actual = read(jobFile);
      assert.equal(actual.cost_status, 'unavailable');
      assert.equal(actual.cost_usd, null);
      assert.deepEqual(read(join(base, 'factory/board.json')).jobs[0], actual);
      const summary = cli('summary');
      assert.equal(summary.status, 0, summary.stderr);
      assert.match(summary.stdout, /unavailable/i);
      assert.doesNotMatch(summary.stdout, /\$0\.00/);
    }
    const projected = readCodexRollouts(sessions, base);
    assert.equal(projected.length, 1, 'turn cwd evidence survives discovery filtering');
    if (projected[0].meta.id === 'fork') assert.equal(projected[0].meta.forked_from_id, 'parent');
    assert.ok(projected[0].cwds.length, 'turn directories survive metadata projection');
    assert.doesNotMatch(JSON.stringify(projected), /Explain this|input_text|Branch:/);
  }
});

test('AC-6: unavailable card hints explain the reason and next step without exposing raw input', () => {
  const hints = {
    missing_price: /Configure.*prices/i,
    missing_model: /model.*sync/i,
    no_associated_usage: /worker.*sync/i,
    ambiguous_session: /dedicated.*session/i,
    invalid_usage: /usage.*sync/i,
  };
  for (const [cost_reason, hint] of Object.entries(hints)) {
    const html = costTimeHtml({ ...job, cost_usd: null, cost_status: 'unavailable', cost_reason });
    assert.match(html, /Cost unavailable/);
    assert.match(html, hint);
  }
  for (const cost_reason of ['<img src=x onerror=alert(1)>', '__proto__', 'constructor',
    { toString: null }, ['missing_price'], null]) {
    const html = costTimeHtml({ ...job, cost_status: 'unavailable', cost_reason });
    assert.doesNotMatch(html, /img|onerror/);
    assert.match(html, /Sync this job to check cost availability/);
  }
  assert.match(costTimeHtml({ provider: 'claude', cost_usd: 0 }), /title="cost">\$0\.00/);
});


test('AC-3/AC-4: a job contract plus later root context retains mixed outside-origin sessions', () => {
  const dedicated = rollout([context(), snapshot()], { id: 'dedicated' });
  const shared = rollout([context('/outside-repo'), snapshot(100, 10), prompt(assignment),
    context(root), snapshot(1100, 110)], { id: 'mixed', cwd: '/outside-repo' });
  assert.equal(calculate([dedicated]).cost_usd, 0.014);
  for (const sources of [[dedicated, shared], [shared, dedicated], [dedicated, shared, shared]]) {
    unknown(calculate(sources));
  }
  unknown(calculate([shared]));
  // Entering a different job, without this job's contract, is still unrelated.
  const unrelated = rollout([context('/outside-repo'), snapshot(100, 10),
    prompt(assignment.replaceAll(job.id, '999-other')), context(root), snapshot()], {
    id: 'unrelated', cwd: '/outside-repo',
  });
  assert.equal(calculate([dedicated, unrelated]).cost_usd, 0.014);
});

test('AC-4/AC-7: repeated sync and summary never publish a partial cost after outside-to-root usage', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-cost-root-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, 'repo'), sessions = join(dir, 'sessions');
  const worktree = join(base, '.worktrees', job.id);
  const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const jobFile = join(base, 'factory/jobs', job.id, 'job.json');
  write(jobFile, JSON.stringify({ ...job, worktree, stage: 'build', round: 3, reviews: {} }));
  write(join(base, 'factory/config.json'), JSON.stringify({ providers: { codex: { prices } } }));
  write(join(sessions, 'dedicated.jsonl'), rollout([context(worktree), snapshot()], { id: 'dedicated', cwd: worktree }));
  const cli = (...args) => spawnSync(fileURLToPath(new URL('../factory/bin/job', import.meta.url)), args, {
    encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: base, FACTORY_CODEX_SESSIONS: sessions },
  });
  assert.equal(cli(job.id, 'sync').status, 0);
  assert.equal(read(jobFile).cost_usd, 0.014, 'initial dedicated usage is known');
  write(join(sessions, 'mixed.jsonl'), rollout([context('/outside-repo'), snapshot(100, 10),
    prompt(assignment), context(base), snapshot(1100, 110)], { id: 'mixed', cwd: '/outside-repo' }));
  assert.equal(readCodexRollouts(sessions, base).length, 2, 'both sessions survive discovery');
  for (let i = 0; i < 2; i++) {
    const result = cli(job.id, 'sync');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Cost unavailable/);
    const actual = read(jobFile);
    unknown({ cost_usd: actual.cost_usd, cost_status: actual.cost_status, cost_reason: actual.cost_reason });
    assert.deepEqual(read(join(base, 'factory/board.json')).jobs[0], actual);
    const summary = cli('summary');
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /Cost unavailable/);
    assert.doesNotMatch(summary.stdout, /\$0\.(00|01)/);
    const stats = headerStats([actual]);
    assert.equal(stats.cost_unavailable, 1);
    assert.equal(formatCost(stats.cost, stats.cost_unavailable), 'Cost unavailable');
  }
});

test('AC-6: dashboard cost labels, reason hints, pipeline and totals follow en/es/pt dictionaries', () => {
  const html = dashboardSource();
  const dictionaries = JSON.parse(html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/)[1]);
  const labels = { en: 'Cost unavailable', es: 'Costo no disponible', pt: 'Custo indisponível' };
  const reasons = ['missing_price', 'missing_model', 'no_associated_usage', 'ambiguous_session', 'invalid_usage'];
  for (const [lang, text] of Object.entries(dictionaries)) {
    assert.equal(text.costUnavailable, labels[lang]);
    const unknownJob = { ...job, cost_status: 'unavailable', cost_usd: null };
    assert.equal(costLabel(unknownJob, text), labels[lang]);
    assert.ok(olderMergedHtml([unknownJob], 'older', false, 0, text).includes(labels[lang]));
    assert.equal(stageDetails(unknownJob, 'build', 0, text).cost, labels[lang]);
    assert.equal(formatCost(0, 2, text), labels[lang]);
    assert.equal(formatCost(2, 2, text), `$2.00 + ${text.costUnavailableCount.replace('{n}', '2')}`);
    for (const reason of reasons) {
      const card = costTimeHtml({ ...unknownJob, cost_reason: reason }, 0, text);
      const hint = text[`costHint_${reason}`];
      assert.ok(hint && hint.trim(), `${lang}: ${reason} hint`);
      assert.ok(card.includes(hint), `${lang}: ${reason}`);
      assert.ok(card.includes(`aria-label="${labels[lang]}. `));
      assert.doesNotMatch(card, /\$0\.00/);
      if (lang !== 'en') assert.notEqual(hint, dictionaries.en[`costHint_${reason}`]);
    }
    for (const cost_reason of ['<img src=x onerror=alert(1)>', '__proto__', { toString: null }, null]) {
      const card = costTimeHtml({ ...unknownJob, cost_reason }, 0, text);
      assert.ok(card.includes(text.costHintDefault));
      assert.doesNotMatch(card, /img|onerror/);
    }
    assert.match(costTimeHtml({ provider: 'claude', cost_usd: 0 }, 0, text), /title="cost">\$0\.00/);
    assert.equal(formatCost(0, 0, text), '$0.00');
  }
  assert.match(html, /costTimeHtml\(job, undefined, T\)/);
  assert.match(html, /olderMergedHtml\(older, T.olderMerged.replace\('\{n\}', older.length\), olderOpen, undefined, T\)/);
  assert.match(html, /stageDetails\(selectedJob, stage, undefined, T\)/);
  assert.match(html, /formatCost\(s.cost, s.cost_unavailable, T\)/);
});
