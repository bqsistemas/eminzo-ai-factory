// factory/bin/dashboard [port]: a static file server for the dashboard. Node only, no
// dependencies. Serves the factory/ folder on loopback, GET and HEAD only, and never a
// path outside it (no traversal, no dotfiles). Under the installed CLI the page comes from
// the engine and only board.json and jobs/ come from the repo's factory/ folder.
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

import { Usage, factoryRoot, installedEngine, isMain, runCli } from './util.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** The file a request path names inside `root`, or null when it is unsafe. */
export async function resolveRequest(root, rawPath) {
  let path;
  try {
    path = decodeURIComponent(rawPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (path.includes('\0') || path.includes('\\')) return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.' || part.startsWith('.'))) return null;
  const base = await realpath(root);
  const target = resolve(base, ...(parts.length ? parts : ['dashboard.html']));
  if (target !== base && !target.startsWith(base + sep)) return null;
  try {
    const real = await realpath(target);
    return real.startsWith(base + sep) ? real : null;
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True when the Host header names this loopback server (blocks DNS rebinding). */
export function hostAllowed(header, port) {
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(String(header ?? ''));
  if (!match || !LOCAL_HOSTS.has(match[1].toLowerCase())) return false;
  return match[2] === undefined || Number(match[2]) === port;
}

/** The repo data the dashboard reads when its page comes from somewhere else: the board, the job folders and the review policy. */
const DATA = new Set(['board.json', 'jobs', 'review.md']);

/** The folder a request path is served from: `data` for the board and jobs when given, `root` for the rest. */
function folderFor(root, data, rawPath) {
  if (!data) return root;
  let path;
  try {
    path = decodeURIComponent(String(rawPath).split('?')[0].split('#')[0]);
  } catch {
    return root; // resolveRequest refuses it too
  }
  return DATA.has(path.split('/').filter(Boolean)[0]) ? data : root;
}

/**
 * An unstarted http.Server that serves `root`. With `data`, board.json and jobs/ come from
 * `data` instead (and are never served from `root`).
 */
export function createDashboardServer(root, { data } = {}) {
  return createServer(async (req, res) => {
    const send = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      res.end(text);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');
    if (!hostAllowed(req.headers.host, req.socket.localPort)) return send(403, 'forbidden host');
    const file = await resolveRequest(folderFor(root, data, req.url ?? '/'), req.url ?? '/');
    if (!file) return send(404, 'not found');
    try {
      const bytes = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': bytes.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch {
      send(404, 'not found');
    }
  });
}

function main(args) {
  if (args.length > 1) throw new Usage('dashboard [port]');
  if (args.length && !/^\d{1,5}$/.test(args[0])) throw new Usage('dashboard [port]  (port is an integer from 1 to 65535)');
  const port = args.length ? Number(args[0]) : 8000;
  if (port < 1 || port > 65535) throw new Usage('dashboard [port]  (port is an integer from 1 to 65535)');
  const repoFactory = join(factoryRoot(), 'factory');
  const engine = installedEngine();
  const server = engine ? createDashboardServer(engine, { data: repoFactory }) : createDashboardServer(repoFactory);
  server.on('error', (err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Dashboard: http://localhost:${server.address().port}/dashboard.html\n`);
  });
}

if (isMain(import.meta.url)) runCli(main);
