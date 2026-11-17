// `job metrics delivery`: the command through the real `factory/bin/job` process, and the places it is documented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TZ, septemberRoot } from './helpers/delivery-fixture.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(join(repo, file), 'utf8');
const KEYS = ['schema', 'source', 'read_at', 'repo', 'tz', 'period', 'previous', 'current', 'before', 'weeks', 'wip'];
const BLOCK = ['deployments', 'change_lead_time', 'lead_time_parts', 'until_approval_by_size', 'failures', 'change_fail_rate', 'deployment_rework_rate', 'finished', 'first_pass', 'extra_rounds', 'first_review_changes', 'escalation_by_risk', 'cost'];

function job(root, args, extraEnv = {}) {
  return spawnSync('sh', [join(repo, 'factory/bin/job'), ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, FACTORY_ROOT: root, TZ, ...extraEnv } });
}

test('AC-1: --json prints exactly one line of JSON with every key', () => {
  const root = septemberRoot();
  const res = job(root, ['metrics', 'delivery', '--json', '--from', '2026-09-01', '--to', '2026-09-30']);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split('\n');
  assert.equal(lines.length, 2, 'one line and the final newline');
  assert.equal(lines[1], '');
  const data = JSON.parse(lines[0]);
  assert.equal(data.schema, 1);
  assert.equal(data.source, 'local');
  assert.deepEqual(Object.keys(data), KEYS);
  assert.deepEqual(Object.keys(data.current), BLOCK);
  assert.deepEqual(Object.keys(data.before), BLOCK);
  assert.equal(data.weeks.length, 4);
  for (const w of data.weeks) assert.deepEqual(Object.keys(w.block), BLOCK);
  assert.equal(data.current.deployments.count, 4);
});

test('AC-1: without --json it prints a short text summary', () => {
  const res = job(septemberRoot(), ['metrics', 'delivery', '--from', '2026-09-01', '--to', '2026-09-30']);
  assert.equal(res.status, 0, res.stderr);
  assert.throws(() => JSON.parse(res.stdout));
  assert.match(res.stdout, /deployments/i);
  assert.doesNotMatch(res.stdout, /Held one|Third/); // issue titles never reach the text
});

test('AC-1: job metrics and the other commands still run, so the new module did not break loading', () => {
  const root = septemberRoot();
  const plain = job(root, ['metrics']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^metrics: last 20 jobs/);
  const last = job(root, ['metrics', '--last', '3', '--json']);
  assert.equal(last.status, 0, last.stderr);
  assert.ok(Array.isArray(Object.keys(JSON.parse(last.stdout))), 'job metrics --json still prints its own object');
  assert.equal(job(root, ['graph']).status, 0);
});

test('AC-5: invalid periods and flags exit 2 with the usage line and an empty stdout', () => {
  const root = septemberRoot();
  const cases = [
    ['--days', '7', '--from', '2026-09-01'],
    ['--from', '2026-09-30', '--to', '2026-09-01'],
    ['--from', '2026-09-01T10:00:00Z', '--to', '2026-09-01T12:00:00Z'],
    ['--from', '2024-01-01', '--to', '2026-09-01'],
    ['--weeks', '13'],
    ['--days', '0'],
    ['--days'],
    ['--bogus', '1'],
    ['--from', '2026-02-30'],
  ];
  for (const flags of cases) {
    const res = job(root, ['metrics', 'delivery', ...flags]);
    assert.equal(res.status, 2, `${flags.join(' ')}: ${res.stderr}`);
    assert.equal(res.stdout, '', flags.join(' '));
    assert.match(res.stderr, /^usage: .*job metrics delivery/, flags.join(' '));
  }
});

test('AC-7: the command never calls gh and reads only factory/jobs and factory/config.json of the repository', () => {
  const root = septemberRoot();
  const work = mkdtempSync(join(tmpdir(), 'delivery-readonly-'));
  const marker = join(work, 'gh-called');
  const log = join(work, 'reads.log');
  mkdirSync(join(work, 'bin'));
  const gh = join(work, 'bin/gh');
  writeFileSync(gh, `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`);
  chmodSync(gh, 0o755);
  const preload = join(work, 'preload.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const log = process.env.READ_LOG;
let busy = false;
for (const name of ['readFileSync', 'readdirSync', 'existsSync', 'statSync', 'lstatSync', 'openSync', 'opendirSync', 'readlinkSync', 'realpathSync', 'accessSync']) {
  const original = fs[name];
  fs[name] = function wrapped(path, ...rest) {
    if (!busy && (typeof path === 'string' || path instanceof URL || Buffer.isBuffer(path))) {
      busy = true;
      try { fs.appendFileSync(log, String(path instanceof URL ? path.pathname : path) + '\\n'); } finally { busy = false; }
    }
    return original.call(this, path, ...rest);
  };
}
syncBuiltinESMExports();
`);
  const res = job(root, ['metrics', 'delivery', '--json'], {
    FACTORY_GH: gh,
    PATH: `${join(work, 'bin')}:${process.env.PATH}`,
    READ_LOG: log,
    NODE_OPTIONS: `--import ${preload}`,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(marker), false, 'gh was called');
  const real = realpathSync(root);
  const inside = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((p) => resolve(p)).filter((p) => p === root || p === real || p.startsWith(root + sep) || p.startsWith(real + sep));
  const jobs = [join(root, 'factory/jobs'), join(real, 'factory/jobs')];
  const allowed = (p) => p === join(root, 'factory/config.json') || p === join(real, 'factory/config.json')
    || jobs.some((j) => p === j || p.startsWith(j + sep));
  const stray = inside.filter((p) => !allowed(p) && p !== root && p !== real && p !== join(root, 'factory') && p !== join(real, 'factory'));
  assert.deepEqual(stray, []);
  assert.ok(inside.some((p) => p.includes(`${sep}factory${sep}jobs${sep}`)), 'the preload saw the jobs being read');
});

test('AC-8: the command and the tool are documented', () => {
  const usage = read('factory/lib/job.js').match(/const USAGE = '([^']*)'/)[1];
  assert.match(usage, /job metrics delivery \[--days <n> \| --from <date>\] \[--to <date>\] \[--weeks <n>\] \[--json\]/);
  for (const file of ['README.md', 'cli/README.md', 'docs/guide.md']) assert.match(read(file), /job metrics delivery/, file);
  assert.match(read('docs/mcp.md'), /delivery_metrics/);
  assert.match(read('factory/project.md'), /delivery_metrics/);
  assert.match(read('factory/project.md'), /delivery\.js/);
  const help = spawnSync('sh', [join(repo, 'factory/bin/mcp'), '--help'], { encoding: 'utf8' });
  assert.match(`${help.stdout}${help.stderr}`, /delivery_metrics/);
});
