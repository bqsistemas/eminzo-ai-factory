// The visual runner: SKIPPED paths run anywhere; the browser run is skipped without Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome } from '../factory/lib/visual-analysis.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = join(repo, 'factory/bin/visual');
const chrome = findChrome({ exists: existsSync });
const ID = '001-visual';

// A throwaway "repo": factory/config.json, one job folder and a page served by a node one-liner.
function setup(visual, page = '<!doctype html><title>t</title><p>hello</p>') {
  const root = mkdtempSync(join(tmpdir(), 'factory-visual-'));
  mkdirSync(join(root, 'factory/jobs', ID), { recursive: true });
  mkdirSync(join(root, 'site'), { recursive: true });
  writeFileSync(join(root, 'site/index.html'), page);
  writeFileSync(join(root, 'site/serve.mjs'), [
    "import { createServer } from 'node:http';",
    "import { readFileSync } from 'node:fs';",
    "createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(readFileSync(new URL('./index.html', import.meta.url))); })",
    ".listen(Number(process.env.PORT), '127.0.0.1');",
  ].join('\n'));
  const config = { base: 'origin/main', ...(visual ? { visual } : {}) };
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(config));
  writeFileSync(join(root, 'factory/jobs', ID, 'job.json'), JSON.stringify({ id: ID, worktree: root, round: 1, port: 0 }));
  return root;
}

function run(root, env = {}) {
  const res = spawnSync('sh', [bin, ID], {
    encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root, ...env }, timeout: 90000,
  });
  const file = join(root, 'factory/jobs', ID, 'round-1/visual.md');
  return { code: res.status, stderr: res.stderr, text: existsSync(file) ? readFileSync(file, 'utf8') : null };
}

test('without config.visual the runner writes SKIPPED (not configured) and exits 0', () => {
  const { code, text } = run(setup(null));
  assert.equal(code, 0);
  assert.equal(text.split('\n')[0], 'VISUAL: SKIPPED');
  assert.match(text, /not configured/);
});

test('without Chrome the runner writes SKIPPED (no browser), warns and exits 0', () => {
  const root = setup({ start: 'node site/serve.mjs', ready_url: 'http://127.0.0.1:{port}/' });
  const { code, text, stderr } = run(root, { CHROME_PATH: '/nonexistent/chrome', FACTORY_VISUAL_NO_SYSTEM_CHROME: '1' });
  assert.equal(code, 0);
  assert.equal(text.split('\n')[0], 'VISUAL: SKIPPED');
  assert.match(text, /no browser/);
  assert.match(stderr, /warning/i);
});

test('a broken adapter block is an environment problem: VISUAL: ERROR with the reason, exit 0', () => {
  const { code, text } = run(setup({ start: 'x' }));
  assert.equal(code, 0);
  assert.equal(text.split('\n')[0], 'VISUAL: ERROR');
  assert.match(text, /Reason: .*ready_url/);
});

test('a missing fixture file is ERROR', () => {
  const root = setup({ start: 'node site/serve.mjs', ready_url: 'http://127.0.0.1:{port}/', fixture: { url: 'x.json', file: 'nope.json' } });
  const { code, text } = run(root, { CHROME_PATH: '/bin/sh' });
  assert.equal(code, 0);
  assert.equal(text.split('\n')[0], 'VISUAL: ERROR');
  assert.match(text, /fixture/);
});

test('a start command that exits before answering is ERROR', () => {
  const { code, text } = run(setup({ start: 'exit 3', ready_url: 'http://127.0.0.1:{port}/', ready_timeout_ms: 5000 }), { CHROME_PATH: '/bin/sh' });
  assert.equal(code, 0);
  assert.equal(text.split('\n')[0], 'VISUAL: ERROR');
  assert.match(text, /exited before/);
});

test('a browser that cannot launch is ERROR, not FAIL', () => {
  const root = setup({ start: 'node site/serve.mjs', ready_url: 'http://127.0.0.1:{port}/', settle_ms: 0 });
  const { code, text } = run(root, { CHROME_PATH: '/bin/sh' });
  assert.equal(code, 0);
  assert.equal(text.split('\n')[0], 'VISUAL: ERROR');
  assert.match(text, /Reason: .*(launch|browser)/i);
});

test('SIGTERM stops the runner and kills the app it started', async () => {
  const root = setup({ start: 'echo $$ > app.pid; exec sleep 60', ready_url: 'http://127.0.0.1:{port}/', ready_timeout_ms: 30000 });
  const child = spawn('sh', [bin, ID], { env: { ...process.env, FACTORY_ROOT: root, CHROME_PATH: '/bin/sh' }, stdio: 'ignore' });
  const closed = new Promise((done) => child.on('close', (code, signal) => done({ code, signal })));
  const pidFile = join(root, 'app.pid');
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(pidFile), 'the app started');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  child.kill('SIGTERM');
  const { code } = await closed;
  assert.ok(code === 143 || code === 130 || code === 1, `runner exited (${code})`);
  let alive = true;
  for (let i = 0; i < 30 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; }
  }
  assert.equal(alive, false, 'the app process is gone');
});

test('with Chrome: a clean page passes and a page with clipped overflow fails', { skip: !chrome && 'no Chrome found' }, () => {
  const visual = { start: 'node site/serve.mjs', ready_url: 'http://127.0.0.1:{port}/', viewports: [390, 1024], settle_ms: 50 };
  const clean = run(setup(visual), { CHROME_PATH: chrome });
  assert.equal(clean.text.split('\n')[0], 'VISUAL: PASS', clean.text + clean.stderr);
  assert.equal(clean.code, 0);

  const bad = '<!doctype html><body style="margin:0"><div id="box" style="width:200px;overflow:hidden;white-space:nowrap">'
    + '<span style="display:inline-block;width:500px">wide content</span></div>'
    + '<p style="color:#bbb;background:#fff">faint text</p>';
  const failed = run(setup(visual, bad), { CHROME_PATH: chrome });
  assert.equal(failed.code, 1, failed.text + failed.stderr);
  assert.equal(failed.text.split('\n')[0], 'VISUAL: FAIL');
  assert.match(failed.text, /overflow `[^`]*#box`: scrollWidth 500 > clientWidth 200/);
  assert.match(failed.text, /contrast `[^`]*p`/);
  assert.match(failed.text, /## \/ · 390px/);
});

test('a server that never answers is ERROR after the ready timeout', () => {
  const root = setup({ start: 'sleep 30', ready_url: 'http://127.0.0.1:{port}/', ready_timeout_ms: 1500 });
  const { code, text } = run(root, { CHROME_PATH: '/bin/sh' });
  assert.equal(code, 0);
  assert.equal(text.split('\n')[0], 'VISUAL: ERROR');
  assert.match(text, /did not become ready/);
});
