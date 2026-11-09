// The engine-written gate report: one plain summary sentence, short sections, a step table,
// a bounded log tail with a pointer to the full log, and the engine version. The parsed lines
// are pinned in artifact-contract.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { desktopHeader, gateFixture } from './helpers/gate-fixture.js';
import { engineVersion } from '../factory/lib/util.js';
import { formatSpan } from '../factory/lib/report.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const pkgVersion = JSON.parse(readFileSync(join(repo, 'cli/package.json'), 'utf8')).version;
const FAILING = '#!/bin/sh\ni=1\nwhile [ $i -le 300 ]; do echo "line $i"; i=$((i+1)); done\necho "boom" >&2\nexit 1\n';

test('engineVersion: EMINZO_VERSION wins, then the package beside the engine, then cli/package.json', () => {
  assert.equal(engineVersion({ EMINZO_VERSION: '9.8.7' }), '9.8.7');
  assert.equal(engineVersion({}), pkgVersion);
  const dir = mkdtempSync(join(tmpdir(), 'engine-version-'));
  mkdirSync(join(dir, 'factory'));
  writeFileSync(join(dir, 'build.json'), JSON.stringify({ version: '4.5.6' }));
  assert.equal(engineVersion({ EMINZO_ENGINE: join(dir, 'factory') }), '4.5.6');
  assert.equal(engineVersion({ EMINZO_VERSION: ' ' , EMINZO_ENGINE: join(dir, 'factory') }), '4.5.6');
});

test('formatSpan: seconds, minutes and hours', () => {
  assert.equal(formatSpan(800), '1s');
  assert.equal(formatSpan(8000), '8s');
  assert.equal(formatSpan(134000), '2m 14s');
  assert.equal(formatSpan(3780000), '1h 3m');
});

test('checks.md (PASS): engine field under the status line, one sentence, steps table', () => {
  const t = gateFixture();
  t.gate();
  const text = t.report();
  const { first, fields } = desktopHeader(text);
  assert.equal(first, 'GATE: PASS');
  assert.deepEqual(fields, { ENGINE: engineVersion() });
  const sentence = text.split('\n')[3];
  assert.match(sentence, new RegExp(`^The checks passed in \\d+(s|m \\d+s|h \\d+m) on commit ${t.head().slice(0, 7)}\\.$`));
  assert.match(text, /^## Steps$/m);
  assert.match(text, /^\| Step \| Result \|$/m);
  assert.match(text, /^\| Checks \(full mode\) \| exit 0 in /m);
  assert.match(text, /^\| Protected tests \| none changed \|$/m);
  assert.match(text, /^\| Working tree \| clean \|$/m);
});

test('checks.md (FAIL): says why, bounds the log to 60 lines and points to the full log', () => {
  const t = gateFixture(FAILING);
  t.gate();
  const text = t.report();
  assert.match(text.split('\n')[3], /^The checks failed: the checks command exited with code 1\.$/);
  assert.match(text, /^## Log \(last 60 lines\)$/m);
  assert.match(text, /^Full log: `checks\.log`$/m);
  assert.ok(text.includes('line 300') && text.includes('boom'));
  assert.ok(!text.includes('line 200\n'), 'older lines stay out of the report');
  const full = readFileSync(join(t.jobDir, 'round-1/checks.log'), 'utf8');
  assert.ok(full.includes('line 1\n') && full.includes('line 300'));
});

test('merge-checks.md: same format, its own log file', () => {
  const t = gateFixture();
  t.gate('--out', join(t.jobDir, 'merge-checks.md'));
  const text = t.report('merge-checks.md');
  assert.match(text.split('\n')[3], /^The checks passed in /);
  assert.match(text, /^Full log: `merge-checks\.log`$/m);
  assert.ok(existsSync(join(t.jobDir, 'merge-checks.log')));
});

test('reusedReport keeps the parsed lines and adds the sentence and engine', async () => {
  const { reusedReport } = await import('../factory/lib/report.js');
  const { testedBy } = await import('../factory/lib/check-stamp.js');
  const head = 'a'.repeat(40);
  const inputs = `sha256:${'b'.repeat(64)}`;
  const text = reusedReport({ round: 2, base: 'origin/main', head, inputs, engine: '1.2.3' });
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 5), ['GATE: PASS', 'ENGINE: 1.2.3', '', 'The checks passed: the round-2 gate is reused for commit aaaaaaa.', '']);
  assert.match(text, /Reused the round-2 gate: the sync with origin\/main brought no changes/);
  assert.deepEqual(testedBy(text), { head, inputs });
});
