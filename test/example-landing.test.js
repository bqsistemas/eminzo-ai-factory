// The landing example: a small app the factory built job by job in claude-code-factory, kept
// here as a target for trying the factory. It is not part of the engine or the CLI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { createApp } from '../examples/landing/src/app.js';

const rootDir = fileURLToPath(new URL('../examples/landing/', import.meta.url));

let server;
let baseUrl;
let port;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ({ port } = server.address());
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Sends a request with the path left exactly as written. `fetch` normalizes
// `/../x` to `/x`, which would hide a traversal attempt from the server.
function rawRequest(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function assertSecurityHeaders(headers, label) {
  assert.equal(headers['x-content-type-options'], 'nosniff', `${label}: nosniff`);
  assert.match(headers['content-security-policy'] ?? '', /default-src 'self'/, `${label}: CSP`);
}

test('AC-1: GET / returns 200 HTML with the welcome heading', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const body = await res.text();
  assert.match(body, /<h1 id="welcome"[^>]*>\s*Welcome, Player One!\s*<\/h1>/);
});

test('AC-2: GET / contains the HUD, XP bar, stylesheet link and quest log', async () => {
  const body = await (await fetch(`${baseUrl}/`)).text();
  assert.match(body, /<html lang="en">/);
  assert.match(body, /<link rel="stylesheet" href="\/styles.css">/);
  assert.match(body, /<progress id="xp"[^>]*aria-label="[^"]+"/);
  assert.match(body, /id="level"/);
  const questLog = body.match(/<section id="quest-log"[\s\S]*?<\/section>/);
  assert.ok(questLog, 'quest-log section exists');
  assert.match(questLog[0], /<li class="quest/);
  assert.doesNotMatch(body, /<script/i, 'no scripts');
  assert.doesNotMatch(body, /\sstyle="/i, 'no inline style attributes');
});

test('AC-3: GET /styles.css returns CSS with :root custom properties and reduced-motion block', async () => {
  const res = await fetch(`${baseUrl}/styles.css`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/css/);
  const body = await res.text();
  assert.match(body, /:root\s*\{[^}]*--[\w-]+\s*:/);
  assert.match(body, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test('AC-4: unknown paths and traversal attempts return 404 without file contents', async () => {
  const pkg = await readFile(new URL('../examples/landing/package.json', import.meta.url), 'utf8');
  for (const path of ['/nope', '/../package.json', '/%2e%2e/package.json', '/package.json', '/public/index.html', '/index.html']) {
    const res = await rawRequest('GET', path);
    assert.equal(res.status, 404, `${path} status`);
    assert.match(res.headers['content-type'], /^text\/plain/, `${path} content-type`);
    assert.equal(res.body, 'Not found', `${path} body`);
    assert.ok(!res.body.includes(pkg.trim().slice(0, 20)), `${path} leaks no file contents`);
  }
});

test('AC-5: POST / returns 405 with Allow: GET, HEAD', async () => {
  for (const path of ['/', '/styles.css']) {
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST' });
    assert.equal(res.status, 405, `${path} status`);
    assert.equal(res.headers.get('allow'), 'GET, HEAD', `${path} Allow`);
    await res.arrayBuffer();
  }
});

test('AC-6: every response sets nosniff and a default-src self CSP', async () => {
  const cases = [
    ['GET', '/'],
    ['HEAD', '/'],
    ['GET', '/styles.css'],
    ['HEAD', '/styles.css'],
    ['GET', '/nope'],
    ['GET', '/../package.json'],
    ['POST', '/'],
  ];
  for (const [method, path] of cases) {
    const res = await rawRequest(method, path);
    assertSecurityHeaders(res.headers, `${method} ${path}`);
  }
});

test('AC-7: importing src/app.js does not listen, so the process exits on its own', async () => {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', "await import('./src/app.js');"],
      { cwd: rootDir, stdio: 'ignore' },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('process did not exit: importing app.js keeps the event loop alive'));
    }, 5000);
    child.on('error', reject);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 0);
  assert.equal(createApp().listening, false, 'createApp() returns a server that is not listening');
});

test('AC-8: the example package is an ES module with no dependencies that starts with node src/server.js', async () => {
  const pkg = JSON.parse(await readFile(new URL('../examples/landing/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.scripts?.start, 'node src/server.js');
  assert.equal(pkg.engines?.node, '>=20');
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'no dependencies');
});

test('HEAD / and HEAD /styles.css return headers with an empty body', async () => {
  for (const [path, type] of [['/', /^text\/html/], ['/styles.css', /^text\/css/]]) {
    const res = await rawRequest('HEAD', path);
    assert.equal(res.status, 200, `${path} status`);
    assert.match(res.headers['content-type'], type, `${path} content-type`);
    assert.equal(res.body, '', `${path} body`);
  }
});

