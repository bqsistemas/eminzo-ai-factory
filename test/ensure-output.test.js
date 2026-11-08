// factory/bin/ensure-output: the output-contract check. Fails (exit 2) when an agent's
// file is missing or its first line does not match, so a Stop hook can keep the agent
// working instead of letting it finish without its deliverable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = join(repo, 'factory/bin/ensure-output');
const VERDICT = '^VERDICT: (PASS|CHANGES)\\b';

const sandbox = () => mkdtempSync(join(tmpdir(), 'ensure-output-'));
const ensure = (args, { input = '', root } = {}) => spawnSync(bin, args, {
  encoding: 'utf8', input, env: { ...process.env, ...(root ? { FACTORY_ROOT: root } : {}) },
});

test('passes when the first line matches', () => {
  const file = join(sandbox(), 'review-ui.md');
  writeFileSync(file, 'VERDICT: PASS\n\n# UI review\n');
  assert.equal(ensure([file, VERDICT]).status, 0);
});

test('tolerates CRLF line endings and a BOM', () => {
  const file = join(sandbox(), 'review-ui.md');
  writeFileSync(file, '﻿VERDICT: CHANGES\r\nbody\r\n');
  assert.equal(ensure([file, VERDICT]).status, 0);
});

test('fails with a clear message when the file is missing', () => {
  const file = join(sandbox(), 'review-ui.md');
  const res = ensure([file, VERDICT]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /missing/);
  assert.ok(res.stderr.includes(file));
});

test('fails when the first line does not match, and shows what it found', () => {
  const file = join(sandbox(), 'review-ui.md');
  writeFileSync(file, '# UI review\nVERDICT: PASS\n');
  const res = ensure([file, VERDICT]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /first line/);
  assert.ok(res.stderr.includes('# UI review'));
  assert.ok(res.stderr.includes(VERDICT));
});

test('fails on an empty file', () => {
  const file = join(sandbox(), 'build.md');
  writeFileSync(file, '');
  assert.equal(ensure([file, '^STATUS: (READY|BLOCKED)\\b']).status, 2);
});

test('rejects bad usage and an unsupported regex', () => {
  assert.notEqual(ensure([]).status, 0);
  assert.notEqual(ensure(['only-a-file']).status, 0);
  const file = join(sandbox(), 'x.md');
  writeFileSync(file, 'x\n');
  const res = ensure([file, '(unclosed']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /regex/i);
});

test('rejects an unapproved regex instead of compiling command-line input', () => {
  const file = join(sandbox(), 'x.md');
  writeFileSync(file, 'aaaaaaaaaaaa!\n');
  const res = ensure([file, '(a+)+$']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unsupported|not allowed|unknown/i);
});

test('the installed hook patterns still accept their protocol first lines', () => {
  const file = join(sandbox(), 'result.md');
  for (const [pattern, line] of [
    ['^(ACCEPT|NEEDS-INFO|REJECT)( |$)', 'NEEDS-INFO details'],
    ['^# Spec: ', '# Spec: a feature'],
    ['^STATUS: (READY|BLOCKED)( |$)', 'STATUS: BLOCKED reason'],
    ['^VERDICT: (PASS|CHANGES)( |$)', 'VERDICT: CHANGES details'],
    ['^(APPROVE|ESCALATE)( |$)', 'ESCALATE reason'],
  ]) {
    writeFileSync(file, `${line}\n`);
    assert.equal(ensure([file, pattern]).status, 0, pattern);
  }
});

test('the installed hook patterns still reject near-miss first lines', () => {
  const file = join(sandbox(), 'result.md');
  for (const [pattern, line] of [
    ['^(ACCEPT|NEEDS-INFO|REJECT)( |$)', 'ACCEPTED'],
    ['^# Spec: ', '# Spec:'],
    ['^STATUS: (READY|BLOCKED)( |$)', 'STATUS: READYX'],
    ['^VERDICT: (PASS|CHANGES)( |$)', 'VERDICT: PASSED'],
    ['^(APPROVE|ESCALATE)( |$)', 'APPROVED'],
  ]) {
    writeFileSync(file, `${line}\n`);
    assert.equal(ensure([file, pattern]).status, 2, pattern);
  }
});

// Hook mode: the file template holds {job} and {round}, filled from the agent's first prompt.
function hookFixture({ withContext = true } = {}) {
  const root = sandbox();
  const dir = sandbox();
  const transcript = join(dir, 'agent.jsonl');
  const prompt = withContext
    ? 'Job folder: factory/jobs/007-demo-job/\nRound folder: factory/jobs/007-demo-job/round-2/\nBranch: factory/007-demo-job\n'
    : 'Do something unrelated\n';
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
  mkdirSync(join(root, 'factory/jobs/007-demo-job/round-2'), { recursive: true });
  return { root, transcript };
}
const hook = (fx, extra = {}) => JSON.stringify({ agent_transcript_path: fx.transcript, ...extra });
const TEMPLATE = '{round}/review-ui.md';

test('hook retries use private repository runtime state, not a predictable OS temp file', () => {
  const fx = hookFixture();
  const hash = createHash('sha256').update(fx.transcript).digest('hex');
  const counterDir = join(fx.root, 'factory/jobs/.ensure-output');
  const res = ensure([TEMPLATE, VERDICT], { input: hook(fx), root: fx.root });
  assert.equal(res.status, 2);
  assert.equal(readFileSync(join(counterDir, `${hash}.count`), 'utf8'), '1');
  if (process.platform !== 'win32') assert.equal(statSync(counterDir).mode & 0o077, 0);
  const oldCounter = join(tmpdir(), `factory-ensure-output-${createHash('sha1').update(fx.transcript).digest('hex')}.count`);
  assert.equal(existsSync(oldCounter), false);
});

test('an unsafe counter directory is never followed and does not trap the hook', () => {
  const fx = hookFixture();
  const target = sandbox();
  symlinkSync(target, join(fx.root, 'factory/jobs/.ensure-output'), 'dir');
  const res = ensure([TEMPLATE, VERDICT], { input: hook(fx), root: fx.root });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /unsafe counter state/);
  assert.deepEqual(readdirSync(target), []);
});

test('an unsupported hook contract obeys the same two-block cap', () => {
  const fx = hookFixture();
  const run = () => ensure([TEMPLATE, '(a+)+$'], { input: hook(fx), root: fx.root });
  for (let i = 0; i < 2; i++) {
    const res = run();
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unsupported|not allowed|unknown/i);
  }
  assert.equal(run().status, 0);
});

test('hook mode: blocks the stop while the round file is missing', () => {
  const fx = hookFixture();
  const res = ensure([TEMPLATE, VERDICT], { input: hook(fx), root: fx.root });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /factory\/jobs\/007-demo-job\/round-2\/review-ui\.md/);
});

test('hook mode: allows the stop once the round file is valid', () => {
  const fx = hookFixture();
  writeFileSync(join(fx.root, 'factory/jobs/007-demo-job/round-2/review-ui.md'), 'VERDICT: PASS\n');
  assert.equal(ensure([TEMPLATE, VERDICT], { input: hook(fx), root: fx.root }).status, 0);
});

test('hook mode: resolves {job} for job-level files', () => {
  const fx = hookFixture();
  const res = ensure(['{job}/decision.md', '^(APPROVE|ESCALATE)\\b'], { input: hook(fx), root: fx.root });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /factory\/jobs\/007-demo-job\/decision\.md/);
});

test('hook mode: blocks at most twice per agent, so a retry still cannot finish without the file', () => {
  const fx = hookFixture();
  const run = (extra = {}) => ensure([TEMPLATE, VERDICT], { input: hook(fx, extra), root: fx.root }).status;
  assert.equal(run(), 2);
  assert.equal(run({ stop_hook_active: true }), 2); // another Stop hook (nudge) blocked first; we still block
  assert.equal(run({ stop_hook_active: true }), 0); // hard cap: never an endless loop
});

test('hook mode: a literal path is capped the same way', () => {
  const fx = hookFixture();
  const file = join(fx.root, 'missing.md');
  const run = () => ensure([file, VERDICT], { input: hook(fx, { stop_hook_active: true }), root: fx.root }).status;
  assert.deepEqual([run(), run(), run()], [2, 2, 0]);
});

test('hook mode: without an agent transcript the stop_hook_active flag caps at one nudge', () => {
  const file = join(sandbox(), 'missing.md');
  assert.equal(ensure([file, VERDICT], { input: JSON.stringify({}) }).status, 2);
  assert.equal(ensure([file, VERDICT], { input: JSON.stringify({ stop_hook_active: true }) }).status, 0);
});

test('hook mode: never falls back to the main session transcript', () => {
  const fx = hookFixture();
  const input = JSON.stringify({ transcript_path: fx.transcript });
  const res = ensure([TEMPLATE, VERDICT], { input, root: fx.root });
  assert.equal(res.status, 0);
});

function foldersFixture(job, round) {
  const root = sandbox();
  const transcript = join(sandbox(), 'agent.jsonl');
  const prompt = `Job folder: ${job}\nRound folder: ${round}\n`;
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
  return { root, transcript };
}

test('hook mode: folders that escape factory/jobs fail open with a note', () => {
  const bad = [
    ['/etc/', 'factory/jobs/007-demo-job/round-1/'],
    ['factory/jobs/../../x/', 'factory/jobs/007-demo-job/round-1/'],
    ['factory/jobs/007-demo-job/', 'factory/jobs/007-demo-job/../../../x/'],
    ['factory/jobs/007-demo-job/', 'factory/jobs/008-other/round-1/'],
    ['factory/jobs/007-demo-job/extra/', 'factory/jobs/007-demo-job/round-1/'],
    ['factory/jobs/007-demo-job/', 'factory/jobs/007-demo-job/round-0/'],
  ];
  for (const [job, round] of bad) {
    const fx = foldersFixture(job, round);
    const res = ensure(['{job}/x.md', VERDICT], { input: hook(fx), root: fx.root });
    assert.equal(res.status, 0, `${job} ${round}`);
    assert.match(res.stderr, /ignored|unsafe|rejected/i);
  }
});

test('hook mode: a transcript without job context is not a factory job, so it passes', () => {
  const fx = hookFixture({ withContext: false });
  assert.equal(ensure([TEMPLATE, VERDICT], { input: hook(fx), root: fx.root }).status, 0);
});

test('hook mode: no usable stdin leaves a templated path unchecked', () => {
  assert.equal(ensure([TEMPLATE, VERDICT], { input: 'not json' }).status, 0);
});
