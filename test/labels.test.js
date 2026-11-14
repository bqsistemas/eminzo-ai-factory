// One list of GitHub labels (factory/lib/labels.js) and the setup script that creates every one of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const { LABELS, BRIEF_ISSUE_LABEL, DELIVERABLE_LABEL } = await import('../factory/lib/labels.js');
const { BRIEF_ISSUE_LABEL: HANDOFF_BRIEF, DELIVERABLE_LABEL: HANDOFF_DELIVERABLE } = await import('../factory/lib/handoff.js');

const EXPECTED = ['factory', 'factory:needs-info', 'factory:needs-human', 'factory:xs', 'factory:spec-review', 'eminzo-brief', 'eminzo-deliverable'];

test('the list: names unique, colors 6-digit hex, descriptions within GitHub\'s 100 characters', () => {
  const names = LABELS.map((l) => l.name);
  assert.equal(new Set(names).size, names.length, 'unique names');
  for (const l of LABELS) {
    assert.match(l.color, /^[0-9a-f]{6}$/i, `${l.name} color`);
    assert.ok(l.description && l.description.length <= 100, `${l.name} description is ${l.description?.length} characters`);
    assert.doesNotMatch(l.description, /[\t\n]/, `${l.name} description has no tab or newline`);
  }
});

test('the list holds the factory labels and both Ask Eminzo labels, and handoff.js uses the same names', () => {
  assert.deepEqual(LABELS.map((l) => l.name), EXPECTED);
  assert.equal(BRIEF_ISSUE_LABEL, 'eminzo-brief');
  assert.equal(DELIVERABLE_LABEL, 'eminzo-deliverable');
  assert.equal(HANDOFF_BRIEF, BRIEF_ISSUE_LABEL);
  assert.equal(HANDOFF_DELIVERABLE, DELIVERABLE_LABEL);
});

/** A fake gh on PATH (the engine's script tests use one): logs each call as one JSON line; fails for the names in FAIL. */
function fakeGh(failing = []) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-labels-'));
  const log = join(dir, 'log');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh
node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), repo: process.env.GH_REPO || null }) + "\\n")' "${log}" "$@"
case " ${failing.join(' ')} " in *" $3 "*) echo "HTTP 422 for $3" >&2; exit 1;; esac
`);
  chmodSync(gh, 0o755);
  const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { dir, calls, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FACTORY_GH: '', GH_REPO: 'acme/widgets' } };
}
const runSetup = (env, args = []) => spawnSync(join(repo, 'factory/bin/setup'), args, { env: { ...env, FACTORY_GH: undefined }, encoding: 'utf8' });

test('setup issues one label create per label, with the list\'s color and description, --force and GH_REPO', () => {
  const g = fakeGh();
  const res = runSetup(g.env);
  assert.equal(res.status, 0, res.stderr);
  const calls = g.calls();
  assert.equal(calls.length, LABELS.length);
  LABELS.forEach((l, i) => {
    assert.deepEqual(calls[i].args, ['label', 'create', l.name, '--color', l.color, '--description', l.description, '--force']);
    assert.equal(calls[i].repo, 'acme/widgets');
  });
});

test('setup honours FACTORY_GH', () => {
  const g = fakeGh();
  const env = { ...g.env, PATH: process.env.PATH, FACTORY_GH: join(g.dir, 'gh') };
  const res = spawnSync(join(repo, 'factory/bin/setup'), [], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(g.calls().length, LABELS.length);
});

test('a failing label does not hide the others: every label is tried, every failure reported, exit non-zero', () => {
  const g = fakeGh(['factory:xs', 'eminzo-brief']);
  const res = runSetup(g.env);
  assert.notEqual(res.status, 0);
  assert.equal(g.calls().length, LABELS.length, 'all labels were tried');
  assert.match(res.stderr, /factory:xs/);
  assert.match(res.stderr, /eminzo-brief/);
  assert.doesNotMatch(res.stderr, /factory:needs-info/);
});

test('setup-spec-review creates only factory:spec-review, from the same list', () => {
  const g = fakeGh();
  const res = spawnSync(join(repo, 'factory/bin/setup-spec-review'), [], { env: { ...g.env, FACTORY_GH: undefined }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const spec = LABELS.find((l) => l.name === 'factory:spec-review');
  assert.deepEqual(g.calls().map((c) => c.args), [['label', 'create', spec.name, '--color', spec.color, '--description', spec.description, '--force']]);
});
