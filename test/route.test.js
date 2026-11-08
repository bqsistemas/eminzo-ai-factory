// Spine test (protected in factory/config.json): routing and intake parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { route } from '../factory/lib/route.js';
import { parseIntake } from '../factory/lib/job.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(readFileSync(join(repo, 'factory/config.json'), 'utf8'));

test('AC-1: route maps risk and surfaces to the builder and reviewer models from config.json', () => {
  assert.deepEqual(route(config, { risk: 'low', surfaces: [] }), {
    builder: 'sonnet',
    reviewers: { code: 'haiku' },
  });
  assert.deepEqual(route(config, { risk: 'medium', surfaces: ['ui'] }), {
    builder: 'sonnet',
    reviewers: { code: 'sonnet', ui: 'haiku' },
  });
  assert.deepEqual(route(config, { risk: 'high', surfaces: ['security', 'ui', 'interaction'] }), {
    builder: 'opus',
    reviewers: { code: 'sonnet', ux: 'sonnet', ui: 'haiku', security: 'opus' },
  });

  assert.throws(() => route(config, { risk: 'extreme', surfaces: [] }), /risk/);
  assert.throws(() => route(config, { risk: undefined, surfaces: [] }), /risk/);
  assert.throws(() => route(config, { risk: 'low', surfaces: ['database'] }), /surface/);
  assert.throws(() => route(config, { risk: 'low', surfaces: ['__proto__'] }), /surface/);
});

test('AC-1: parseIntake reads the four-line header and throws on a bad decision, risk or surface', () => {
  const body = '\n## Scope\nOnly the toggle.\n\n## Reason\nSmall.\n';
  assert.deepEqual(parseIntake(`ACCEPT\nRISK: low\nSURFACES: none\nRESCOPED: no\n${body}`), {
    decision: 'ACCEPT', risk: 'low', surfaces: [], rescoped: false,
  });
  assert.deepEqual(parseIntake(`ACCEPT\nRISK: high\nSURFACES: ui, security\nRESCOPED: yes\n${body}`), {
    decision: 'ACCEPT', risk: 'high', surfaces: ['ui', 'security'], rescoped: true,
  });
  assert.deepEqual(parseIntake('NEEDS-INFO\r\nRISK: medium\r\nSURFACES: ui\r\nRESCOPED: no\r\n'), {
    decision: 'NEEDS-INFO', risk: 'medium', surfaces: ['ui'], rescoped: false,
  });
  assert.equal(parseIntake('REJECT\nRISK: low\nSURFACES: none\nRESCOPED: no').decision, 'REJECT');

  const bad = [
    'MAYBE\nRISK: low\nSURFACES: none\nRESCOPED: no',
    'accept\nRISK: low\nSURFACES: none\nRESCOPED: no',
    'ACCEPT\nRISK: huge\nSURFACES: none\nRESCOPED: no',
    'ACCEPT\nRISK: low\nSURFACES: database\nRESCOPED: no',
    'ACCEPT\nRISK: low\nSURFACES: ui, ui\nRESCOPED: no',
    'ACCEPT\nRISK: low\nSURFACES: none, ui\nRESCOPED: no',
    'ACCEPT\nRISK: low\nSURFACES: none\nRESCOPED: maybe',
    'ACCEPT\nSURFACES: none\nRISK: low\nRESCOPED: no',
    'ACCEPT\nRISK: low\nSURFACES: none',
    '',
  ];
  for (const text of bad) assert.throws(() => parseIntake(text), `throws for ${JSON.stringify(text)}`);
});

test('AC-1: factory/bin/route prints the routing JSON for a job intake.md and writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-route-'));
  const id = '004-dark-mode-toggle';
  const dir = join(root, 'factory/jobs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'intake.md'), 'ACCEPT\nRISK: medium\nSURFACES: ui\nRESCOPED: yes\n\n## Scope\nx\n');
  const jobJson = `${JSON.stringify({ id, stage: 'intake', round: 0 }, null, 2)}\n`;
  writeFileSync(join(dir, 'job.json'), jobJson);

  const res = spawnSync(join(repo, 'factory/bin/route'), [id], {
    encoding: 'utf8',
    env: { ...process.env, FACTORY_ROOT: root },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), route(config, { risk: 'medium', surfaces: ['ui'] }));
  assert.equal(readFileSync(join(dir, 'job.json'), 'utf8'), jobJson, 'job.json unchanged');

  const usage = spawnSync(join(repo, 'factory/bin/route'), [], { encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root } });
  assert.equal(usage.status, 2);
  const traversal = spawnSync(join(repo, 'factory/bin/route'), ['../../etc'], { encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root } });
  assert.notEqual(traversal.status, 0);
});
