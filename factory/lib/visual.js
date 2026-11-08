// factory/bin/visual <job-id> [--out <file>]: the generic visual check. It reads the
// adapter block `visual` of factory/config.json, starts the app inside the job's worktree
// on the job's port, drives headless system Chrome (puppeteer-core) through the matrix and
// writes round-N/visual.md. The first line is VISUAL: PASS|FAIL|SKIPPED. Exit 0 on PASS and
// SKIPPED, 1 on FAIL. It knows nothing about the app; the adapter says how to apply each
// dimension. Node 20 ESM.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Usage, factoryRoot, isMain, jobDir, loadConfig, readText, runCli, writeAtomic } from './util.js';
import { analyzeSnapshot, buildMatrix, findChrome, formatReport, overallStatus, snapshotNotes, validateVisualConfig } from './visual-analysis.js';
import { collectSnapshot } from './visual-collect.js';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => done(port));
    });
  });
}

async function portIsFree(port) {
  return new Promise((done) => {
    const srv = createServer();
    srv.once('error', () => done(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => done(true)));
  });
}

/** puppeteer-core from this checkout or from the main checkout; null when not installed. */
async function loadPuppeteer(root) {
  for (const base of [import.meta.url, pathToFileURL(join(root, 'package.json')).href]) {
    try {
      const path = createRequire(base).resolve('puppeteer-core');
      const mod = await import(pathToFileURL(path).href);
      return mod.default ?? mod;
    } catch { /* try the next location */ }
  }
  return null;
}

function startApp(command, cwd, port) {
  const child = spawn('sh', ['-c', command], {
    cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PORT: String(port), NODE_TEST_CONTEXT: undefined },
  });
  const app = { child, exited: false, stderr: '' };
  child.stderr.on('data', (d) => { app.stderr = (app.stderr + d).slice(-2000); });
  child.on('exit', () => { app.exited = true; });
  child.on('error', (err) => { app.exited = true; app.stderr += err.message; });
  return app;
}

/** Kills the app's whole process group, even when the sh wrapper already exited. */
function stopApp(app) {
  if (!app || !app.child.pid) return;
  try { process.kill(-app.child.pid, 'SIGKILL'); } catch { try { app.child.kill('SIGKILL'); } catch { /* gone */ } }
}

/** Closes the browser, killing it when close() does not return in time. */
async function closeBrowser(browser, timeoutMs = 5000) {
  if (!browser) return;
  const proc = browser.process?.();
  await Promise.race([browser.close().catch(() => {}), sleep(timeoutMs)]);
  if (proc && proc.exitCode === null && !proc.killed) { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
}

async function waitReady(app, url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (app.exited) return `the start command exited before ${url} answered${app.stderr ? `: ${app.stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return null;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return `the app did not become ready at ${url} within ${timeoutMs} ms`;
}

function pointUrl(origin, point, cfg) {
  const url = new URL(point.page, origin);
  if (point.locale !== null && cfg.locale.param) url.searchParams.set(cfg.locale.param, point.locale);
  return url.href;
}

async function applyPoint(page, point, cfg, fixtureText) {
  await page.setViewport({ width: point.viewport, height: 900 });
  const features = [{ name: 'prefers-reduced-motion', value: 'no-preference' }];
  if (point.theme !== null && cfg.theme.media) features.push({ name: cfg.theme.media, value: point.theme });
  await page.emulateMediaFeatures(features);
  await page.setExtraHTTPHeaders(point.locale !== null && cfg.locale.header ? { 'Accept-Language': point.locale } : {});
  const json = point.locale !== null ? cfg.locale.json : null;
  if (fixtureText !== null || json) {
    await page.setRequestInterception(true);
    page.removeAllListeners('request');
    page.on('request', async (req) => {
      const url = req.url();
      const isFixture = fixtureText !== null && url.split('?')[0].endsWith(cfg.fixture.url);
      const isJson = json && url.split('?')[0].endsWith(json.url);
      if (!isFixture && !isJson) return req.continue();
      try {
        let body = isFixture ? fixtureText : await (await fetch(url)).text();
        if (isJson) {
          const data = JSON.parse(body);
          data[json.key] = point.locale;
          body = JSON.stringify(data);
        }
        return req.respond({ status: 200, contentType: 'application/json', body });
      } catch {
        return req.continue();
      }
    });
  }
}

async function checkPoint(page, point, cfg, origin, fixtureText, reduced) {
  await applyPoint(page, point, cfg, fixtureText);
  if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, ...(point.theme !== null && cfg.theme.media ? [{ name: cfg.theme.media, value: point.theme }] : [])]);
  await page.goto(pointUrl(origin, point, cfg), { waitUntil: 'load', timeout: cfg.page_timeout_ms });
  if (point.theme !== null && cfg.theme.attribute) {
    await page.evaluate((attr, value) => document.documentElement.setAttribute(attr, value), cfg.theme.attribute, point.theme);
  }
  await sleep(cfg.settle_ms);
  const snapshot = await page.evaluate(collectSnapshot, { animations: reduced });
  return { findings: analyzeSnapshot(snapshot), notes: snapshotNotes(snapshot) };
}

/**
 * Runs the check for a job and writes the report. Resolves to PASS, FAIL, SKIPPED or ERROR.
 * FAIL means a page rendered and showed findings, which the builder can fix. Everything the
 * builder cannot fix (bad adapter block, missing fixture, an app that does not start, a
 * browser that does not launch, a crash) is ERROR, which never blocks.
 */
export async function runVisual(root, job, outFile) {
  const write = (report) => writeAtomic(outFile, formatReport(report));
  const config = loadConfig(root);
  if (config.visual === undefined || config.visual === null) {
    write({ status: 'SKIPPED', reason: 'not configured (factory/config.json has no visual block)' });
    return 'SKIPPED';
  }
  let app = null;
  let browser = null;
  const cleanup = async () => { await closeBrowser(browser); stopApp(app); };
  const onSignal = (code) => () => { cleanup().finally(() => process.exit(code)); };
  const onInt = onSignal(130);
  const onTerm = onSignal(143);
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  try {
    return await check();
  } catch (err) {
    const reason = String(err?.message ?? err).split('\n')[0];
    process.stderr.write(`warning: visual check could not run: ${reason}\n`);
    write({ status: 'ERROR', reason });
    return 'ERROR';
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    await cleanup();
  }

  async function check() {
    const cfg = validateVisualConfig(config.visual);
    const chrome = findChrome({ exists: existsSync });
    const puppeteer = chrome ? await loadPuppeteer(root) : null;
    if (!chrome || !puppeteer) {
      const why = !chrome ? 'no browser: set CHROME_PATH or install Chrome/Chromium' : 'no browser driver: puppeteer-core is not installed (npm install)';
      process.stderr.write(`warning: visual check skipped, ${why}\n`);
      write({ status: 'SKIPPED', reason: why });
      return 'SKIPPED';
    }
    const port = job.port && (await portIsFree(job.port)) ? job.port : await freePort();
    const readyUrl = cfg.ready_url.replaceAll('{port}', String(port));
    const origin = new URL(readyUrl).origin;
    const cwd = job.worktree && existsSync(job.worktree) ? job.worktree : root;
    const fixtureText = cfg.fixture ? readText(resolve(cwd, cfg.fixture.file)) : null;
    if (cfg.fixture && fixtureText === null) throw new Error(`visual fixture file not found: ${cfg.fixture.file}`);
    const matrix = buildMatrix(cfg);

    app = startApp(cfg.start.replaceAll('{port}', String(port)), cwd, port);
    const notReady = await waitReady(app, readyUrl, cfg.ready_timeout_ms);
    if (notReady) throw new Error(notReady);
    browser = await puppeteer.launch({
      executablePath: chrome, headless: true,
      args: process.getuid?.() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'],
    }).catch((err) => { throw new Error(`the browser could not launch: ${err.message}`); });

    const results = [];
    const notes = new Set();
    const deadline = Date.now() + cfg.budget_ms;
    const visit = async (point, reduced) => {
      const page = await browser.newPage();
      try {
        const out = await checkPoint(page, point, cfg, origin, fixtureText, reduced);
        out.notes.forEach((n) => notes.add(n));
        return { rendered: true, findings: out.findings };
      } catch (err) {
        return { rendered: false, findings: [{ type: 'error', selector: '', detail: `could not render: ${String(err.message).split('\n')[0]}` }] };
      } finally {
        await page.close().catch(() => {});
      }
    };
    let checked = 0;
    for (const point of matrix.points) {
      if (Date.now() > deadline) { notes.add(`budget_ms ${cfg.budget_ms} reached after ${checked} of ${matrix.points.length} points`); break; }
      const out = await visit(point, false);
      results.push({ point, rendered: out.rendered, findings: out.findings.filter((f) => f.type !== 'motion') });
      checked++;
    }
    const status = overallStatus(results);
    if (status === 'ERROR') {
      write({ status, reason: `no page rendered in ${checked} point(s): ${results[0]?.findings[0]?.detail ?? 'the matrix is empty'}` });
      return status;
    }
    // Reduced motion: one extra pass at the first point; only running CSS animations count.
    const first = matrix.points[0];
    const motion = await visit(first, true);
    if (!motion.rendered) notes.add(`ERROR: the reduced-motion pass could not run (${motion.findings[0].detail}); motion was not checked`);
    else results.push({ point: { ...first, page: `${first.page} (prefers-reduced-motion: reduce)` }, rendered: true, findings: motion.findings.filter((f) => f.type === 'motion') });
    const final = overallStatus(results);
    write({ status: final, matrix: { ...matrix, points: matrix.points.slice(0, checked) }, results, notes: [...notes] });
    return final;
  }
}

function main(args) {
  const [id, ...rest] = args;
  let out = null;
  if (rest.length === 2 && rest[0] === '--out') out = resolve(rest[1]);
  else if (rest.length) throw new Usage('visual <job-id> [--out <file>]');
  if (!id) throw new Usage('visual <job-id> [--out <file>]');
  const root = factoryRoot();
  const dir = jobDir(root, id);
  const text = readText(join(dir, 'job.json'));
  if (text === null) throw new Error(`no job ${id}`);
  const job = JSON.parse(text);
  if (!out) {
    if (!(job.round >= 1)) throw new Usage(`${id} has no build round yet`);
    out = join(dir, `round-${job.round}`, 'visual.md');
  }
  return runVisual(root, job, out).then((status) => {
    process.stdout.write(`${id} VISUAL: ${status}\n`);
    return status === 'FAIL' ? 1 : 0;
  });
}

if (isMain(import.meta.url)) {
  Promise.resolve().then(() => main(process.argv.slice(2))).then((code) => { process.exitCode = code ?? 0; }, (err) => {
    runCli(() => { throw err; });
  });
}
