// config.run_mode: "own" (the default) keeps `run` on the local jobs; "queue" drains
// the open `factory` issues. `factory/bin/job run-mode` exposes the resolved value
// to both orchestrator skills, which branch on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUN_MODES, runMode } from '../factory/lib/run-mode.js';
import { Refused } from '../factory/lib/util.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(repo, rel), 'utf8');

function tree(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const st = statSync(path);
    out.push(`${name}:${st.size}:${st.mtimeMs}`);
    if (st.isDirectory()) out.push(...tree(path).map((p) => `${name}/${p}`));
  }
  return out;
}

function cli(config) {
  const root = mkdtempSync(join(tmpdir(), 'factory-run-mode-'));
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(config));
  const before = tree(root);
  const res = spawnSync(join(repo, 'factory/bin/job'), ['run-mode'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root, FACTORY_GH: '/nonexistent/gh' },
  });
  return { ...res, before, after: tree(root), root };
}

test('AC-1: runMode resolves own by default and accepts only "own" or "queue"', () => {
  assert.deepEqual([...RUN_MODES], ['own', 'queue']);
  assert.ok(Object.isFrozen(RUN_MODES));
  assert.equal(runMode({}), 'own');
  assert.equal(runMode({ run_mode: undefined }), 'own');
  assert.equal(runMode({ run_mode: 'own' }), 'own');
  assert.equal(runMode({ run_mode: 'queue' }), 'queue');
  for (const bad of ['Queue', 'OWN', '', null, 1, true, ['queue'], { mode: 'queue' }, ' queue']) {
    assert.throws(() => runMode({ run_mode: bad }), (err) => {
      assert.ok(err instanceof Refused, `Refused for ${JSON.stringify(bad)}`);
      assert.equal(err.message, `run_mode must be "own" or "queue", got ${JSON.stringify(bad)}`);
      return true;
    });
  }
});

test('AC-1: job run-mode prints own, own or queue with exit 0 and writes nothing', () => {
  for (const [config, expected] of [
    [{ base: 'origin/main' }, 'own'],
    [{ base: 'origin/main', run_mode: 'own' }, 'own'],
    [{ base: 'origin/main', run_mode: 'queue' }, 'queue'],
  ]) {
    const res = cli(config);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `${expected}\n`);
    assert.deepEqual(res.after, res.before, 'job run-mode writes no file');
  }
});

test('AC-1: job run-mode refuses an invalid run_mode with exit 1 and writes nothing', () => {
  for (const bad of ['Queue', null, 1]) {
    const res = cli({ base: 'origin/main', run_mode: bad });
    assert.equal(res.status, 1, `exit 1 for ${JSON.stringify(bad)}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /^refused: run_mode must be "own" or "queue"/);
    assert.equal(res.stdout, '');
    assert.deepEqual(res.after, res.before, 'a refused run-mode writes no file');
  }
});

test('AC-1: job run-mode takes no arguments', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-run-mode-'));
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ base: 'origin/main' }));
  const res = spawnSync(join(repo, 'factory/bin/job'), ['run-mode', 'queue'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root },
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /^usage: .*job run-mode/);
});

// --- the skills and the README ---------------------------------------------------

/** The text from `heading` to the next heading of the same or a higher level. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `missing heading ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${level}} `, 'm'));
  return next < 0 ? rest : rest.slice(0, next);
}

/** Numbered list items (`N. ...` plus their indented continuation lines). */
function items(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (/^\d+\. /.test(line)) out.push(line);
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += `\n${line}`;
    else if (out.length && line.trim() === '') out[out.length - 1] += '\n';
  }
  return out;
}

/** A `- ` bullet that starts with `prefix`, with its indented continuation lines. */
function bullet(text, prefix) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(start >= 0, `missing bullet ${prefix}`);
  let end = start + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

test('AC-2: the Claude skill checks the run mode first and lists issues only with queue', () => {
  const skill = read('.claude/skills/eminzo-factory/SKILL.md');
  assert.ok(skill.includes('<!-- rule: run-mode -->'), 'run-mode marker');
  const run = section(skill, '## /eminzo-factory run');
  assert.match(run, /^<!-- rule: run-mode -->$/m, 'the marker sits on its own line in the run section');
  const mode = run.indexOf('factory/bin/job run-mode');
  const list = run.indexOf('gh issue list --label factory');
  assert.ok(mode >= 0, 'run calls factory/bin/job run-mode');
  assert.ok(list > mode, 'run-mode runs before the issue list');
  const steps = items(run);
  const listing = steps.filter((s) => s.includes('gh issue list --label factory'));
  assert.equal(listing.length, 1, 'one step lists the queue');
  assert.match(listing[0], /^\d+\. Only with `queue`/, 'the issue list is conditioned on queue');
  assert.ok(listing[0].includes('factory/bin/job new'), 'job new lives in the queue step');
  assert.equal(steps.filter((s) => s.includes('factory/bin/job new')).length, 1, 'job new only in the queue step');
  const prChecks = steps.find((s) => /PR checks/.test(s));
  assert.ok(prChecks, 'PR checks step');
  assert.doesNotMatch(prChecks, /Only with/, 'PR checks run in both modes');
  const advance = steps.find((s) => /Advance up to `concurrency`/.test(s));
  assert.ok(advance, 'advance step');
  assert.doesNotMatch(advance, /Only with/, 'local jobs advance in both modes');
  const own = steps.find((s) => s.includes('factory/bin/job run-mode'));
  assert.match(own, /`own`/);
  assert.match(own, /`queue`/);
  assert.match(own, /refus/i, 'an invalid run mode stops the command');
  // Commands: run no longer drains the queue by default.
  const commands = bullet(skill, '- `/eminzo-factory run`');
  assert.match(commands, /run_mode/);
  assert.doesNotMatch(skill.split('\n')[2], /issues labeled `factory` are the queue;/, 'the description no longer says run always drains');
  assert.match(section(skill, '## Resume'), /local/);
});

test('AC-2: the Codex skill checks the run mode first and lists issues only with queue', () => {
  const skill = read('.agents/skills/eminzo-factory/SKILL.md');
  assert.ok(skill.includes('<!-- rule: run-mode -->'), 'run-mode marker');
  assert.match(skill, /^\s*<!-- rule: run-mode -->$/m, 'the marker sits on its own line');
  const runItem = items(section(skill, '## Pipeline')).find((s) => s.startsWith('1. **run**'));
  assert.ok(runItem, 'the run stage');
  const mode = runItem.indexOf('factory/bin/job run-mode');
  const list = runItem.indexOf('list open `factory` issues');
  assert.ok(mode >= 0, 'run calls factory/bin/job run-mode');
  assert.ok(list > mode, 'run-mode runs before the issue list');
  const sentences = runItem.split(/(?<=\.)\s+/);
  const listing = sentences.filter((s) => s.includes('list open `factory` issues'));
  assert.equal(listing.length, 1);
  assert.match(listing[0], /Only with `queue`/, 'the issue list is conditioned on queue');
  assert.ok(listing[0].includes('factory/bin/job new'), 'job new lives in the queue sentence');
  const both = sentences.find((s) => /reconcile PRs/.test(s));
  assert.ok(both, 'PR reconciliation');
  assert.doesNotMatch(both, /Only with/, 'PR checks and local jobs run in both modes');
  assert.match(both, /In both modes/);
  const commands = bullet(skill, '- `$eminzo-factory run`');
  assert.match(commands, /run_mode/);
});

test('AC-2: README documents run_mode own (default) and queue, and that job new assigns the issue', () => {
  const readme = read('README.md');
  assert.match(readme, /`run_mode`/);
  assert.match(readme, /`own`[^\n]*default|default[^\n]*`own`/);
  assert.match(readme, /`queue`/);
  assert.match(readme, /--add-assignee @me/);
  assert.match(readme, /is assigned to/);
  assert.match(readme, /already has branch/);
});
