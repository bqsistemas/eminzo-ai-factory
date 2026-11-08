import http from 'node:http';
import { readFile } from 'node:fs/promises';

const publicDir = new URL('../public/', import.meta.url);

// Explicit route map. Files are never resolved from the request path.
const routes = new Map([
  ['/', { file: new URL('index.html', publicDir), type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: new URL('styles.css', publicDir), type: 'text/css; charset=utf-8' }],
]);

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'",
};

function send(res, status, headers, body, includeBody = true) {
  res.writeHead(status, {
    ...securityHeaders,
    ...headers,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(includeBody ? body : undefined);
}

function sendText(res, status, text, extraHeaders = {}, includeBody = true) {
  send(res, status, { 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders }, text, includeBody);
}

async function handle(req, res) {
  const path = (req.url ?? '').split('?')[0];
  const route = routes.get(path);
  const isHead = req.method === 'HEAD';

  if (!route) {
    sendText(res, 404, 'Not found', {}, !isHead);
    return;
  }

  if (req.method !== 'GET' && !isHead) {
    sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }

  try {
    const body = await readFile(route.file);
    send(res, 200, { 'Content-Type': route.type }, body, !isHead);
  } catch {
    sendText(res, 500, 'Internal server error', {}, !isHead);
  }
}

/**
 * Creates the landing page server. It is not listening yet; call `listen()`.
 * @returns {http.Server}
 */
export function createApp() {
  return http.createServer((req, res) => {
    handle(req, res);
  });
}
