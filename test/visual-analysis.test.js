// The visual check's analysis is pure: it reads a serialized snapshot (boxes, styles) and
// never needs a browser. These tests cover it, the adapter config and Chrome detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeSnapshot, buildMatrix, contrastRatio, effectiveBackground, findChrome, formatReport, overallStatus, parseColor,
  snapshotNotes, validateVisualConfig, visualStatus,
} from '../factory/lib/visual-analysis.js';

const el = (over) => ({
  i: 0, p: -1, sel: 'div', x: 0, y: 0, w: 100, h: 20, sw: 100, cw: 100, ox: 'visible', to: 'clip',
  color: 'rgb(0, 0, 0)', bg: 'rgba(0, 0, 0, 0)', bgImg: false, op: 1, fs: 14, fw: 400, text: false, mark: false, dis: false,
  ...over,
});
const snap = (els, over = {}) => ({ viewport: { w: 390, h: 800 }, doc: { sw: 390 }, reducedMotion: false, truncated: false, els, anims: [], ...over });

test('parseColor reads rgb, rgba and color(srgb) and rejects the rest', () => {
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('color(srgb 1 0 0 / 0.5)'), { r: 255, g: 0, b: 0, a: 0.5 });
  assert.equal(parseColor('transparent'), null);
  assert.equal(parseColor('oklch(0.5 0.1 20)'), null);
  assert.equal(parseColor(undefined), null);
});

test('contrastRatio matches the WCAG reference values', () => {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  assert.equal(contrastRatio(black, white).toFixed(2), '21.00');
  assert.equal(contrastRatio(white, white).toFixed(2), '1.00');
  assert.equal(contrastRatio({ r: 119, g: 119, b: 119 }, white).toFixed(2), '4.48');
});

test('effectiveBackground composites translucent layers up the ancestor chain', () => {
  const els = [
    el({ i: 0, p: -1, bg: 'rgb(255, 255, 255)' }),
    el({ i: 1, p: 0, bg: 'rgba(0, 0, 0, 0.5)' }),
    el({ i: 2, p: 1 }),
  ];
  assert.deepEqual(effectiveBackground(els, 2), { r: 128, g: 128, b: 128 });
  // nothing opaque above: the page canvas is white
  assert.deepEqual(effectiveBackground([el({ i: 0, p: -1 })], 0), { r: 255, g: 255, b: 255 });
  // a background image or gradient makes the real background unknown
  assert.equal(effectiveBackground([el({ i: 0, p: -1, bgImg: true }), el({ i: 1, p: 0 })], 1), null);
});

test('contrast: flags text below 4.5:1 with the selector and the numbers', () => {
  const findings = analyzeSnapshot(snap([
    el({ i: 0, p: -1, bg: 'rgb(255, 255, 255)' }),
    el({ i: 1, p: 0, sel: '.hint', text: true, color: 'rgb(170, 170, 170)' }),
    el({ i: 2, p: 0, sel: '.ok', text: true, color: 'rgb(0, 0, 0)' }),
  ]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'contrast');
  assert.equal(findings[0].selector, '.hint');
  assert.match(findings[0].detail, /2\.\d+:1 < 4\.5:1/);
});

test('contrast: large text needs 3:1, a bold 18.66px counts as large, disabled controls are exempt', () => {
  const gray = 'rgb(140, 140, 140)'; // about 3.3:1 on white
  const base = el({ i: 0, p: -1, bg: 'rgb(255, 255, 255)' });
  const run = (over) => analyzeSnapshot(snap([base, el({ i: 1, p: 0, sel: '.t', text: true, color: gray, ...over })]));
  assert.equal(run({ fs: 14 }).length, 1);
  assert.equal(run({ fs: 24 }).length, 0);
  assert.equal(run({ fs: 19, fw: 700 }).length, 0);
  assert.equal(run({ fs: 19, fw: 400 }).length, 1);
  assert.equal(run({ fs: 14, dis: true }).length, 0);
});

test('contrast: element opacity lowers the foreground and unknown backgrounds are skipped', () => {
  const base = el({ i: 0, p: -1, bg: 'rgb(255, 255, 255)' });
  const faded = analyzeSnapshot(snap([base, el({ i: 1, p: 0, sel: '.faded', text: true, color: 'rgb(0, 0, 0)', op: 0.3 })]));
  assert.equal(faded.length, 1);
  const gradient = analyzeSnapshot(snap([el({ i: 0, p: -1, bgImg: true }), el({ i: 1, p: 0, text: true, color: 'rgb(250, 250, 250)' })]));
  assert.equal(gradient.length, 0);
});

test('overflow: flags clipped content, ignores scrollers, ellipsis and sub-pixel noise', () => {
  const findings = analyzeSnapshot(snap([
    el({ i: 0, p: -1, sel: 'html', w: 390 }),
    el({ i: 1, p: 0, sel: '.clipped', ox: 'hidden', sw: 420, cw: 380 }),
    el({ i: 2, p: 0, sel: '.scroller', ox: 'auto', sw: 900, cw: 380 }),
    el({ i: 3, p: 0, sel: '.ellipsis', ox: 'hidden', to: 'ellipsis', sw: 420, cw: 380 }),
    el({ i: 4, p: 0, sel: '.fine', ox: 'hidden', sw: 381, cw: 380 }),
    el({ i: 5, p: 0, sel: '.inline', ox: 'hidden', sw: 50, cw: 0 }),
  ]));
  assert.deepEqual(findings.map((f) => [f.type, f.selector]), [['overflow', '.clipped']]);
  assert.match(findings[0].detail, /scrollWidth 420 > clientWidth 380/);
});

test('invisible content is not judged: fully transparent text and visually-hidden boxes', () => {
  const base = el({ i: 0, p: -1, bg: 'rgb(255, 255, 255)' });
  const hidden = el({ i: 1, p: 0, sel: '.closed', op: 0 });
  const findings = analyzeSnapshot(snap([
    base, hidden,
    el({ i: 2, p: 1, sel: '.closed-text', text: true, color: 'rgb(255, 255, 255)' }),
    el({ i: 3, p: 0, sel: '.sr-only', ox: 'hidden', w: 1, cw: 1, sw: 300 }),
  ]));
  assert.deepEqual(findings, []);
});

test('overflow: horizontal page scroll names the elements that stick out and are not clipped', () => {
  const findings = analyzeSnapshot(snap([
    el({ i: 0, p: -1, sel: 'html', w: 390 }),
    el({ i: 1, p: 0, sel: 'body', w: 390 }),
    el({ i: 2, p: 1, sel: '.wide', x: 10, w: 500 }),
    el({ i: 3, p: 1, sel: '.mask', ox: 'hidden', w: 390, sw: 390 }),
    el({ i: 4, p: 3, sel: '.inside-mask', x: 10, w: 500 }),
  ], { doc: { sw: 510 } }));
  const page = findings.filter((f) => f.type === 'page-scroll');
  assert.equal(page.length, 1);
  assert.match(page[0].detail, /document scrollWidth 510 > viewport 390/);
  assert.match(page[0].detail, /\.wide/);
  assert.doesNotMatch(page[0].detail, /inside-mask/);
  assert.equal(analyzeSnapshot(snap([el({ i: 0, p: -1 })], { doc: { sw: 390 } })).length, 0);
});

test('overlap: only elements marked data-visual-check, never ancestors or touching edges', () => {
  const marked = (i, sel, x, over = {}) => el({ i, p: 0, sel, x, w: 100, h: 40, mark: true, ...over });
  const findings = analyzeSnapshot(snap([
    el({ i: 0, p: -1, sel: 'html', w: 390, h: 800 }),
    marked(1, '.a', 0),
    marked(2, '.b', 60), // overlaps .a by 40 x 40
    marked(3, '.c', 100), // only touches .b's end? .b spans 60-160, so it overlaps .b, not .a
    el({ i: 4, p: 0, sel: '.unmarked', x: 0, w: 100, h: 40 }),
  ]));
  const overlaps = findings.filter((f) => f.type === 'overlap');
  assert.deepEqual(overlaps.map((f) => f.selector), ['.a', '.b']);
  assert.match(overlaps[0].detail, /overlaps `\.b` by 40x40px/);
  // a marked element inside another marked element is containment, not an overlap
  const nested = analyzeSnapshot(snap([
    el({ i: 0, p: -1 }), marked(1, '.outer', 0), marked(2, '.inner', 10, { p: 1, w: 20 }),
  ]));
  assert.equal(nested.filter((f) => f.type === 'overlap').length, 0);
});

test('motion: running CSS animations under reduced motion are findings, only when emulated', () => {
  const anims = [{ sel: '.spin', name: 'rotate' }];
  assert.equal(analyzeSnapshot(snap([el({ i: 0, p: -1 })], { anims })).length, 0);
  const findings = analyzeSnapshot(snap([el({ i: 0, p: -1 })], { anims, reducedMotion: true }));
  assert.deepEqual(findings.map((f) => [f.type, f.selector]), [['motion', '.spin']]);
  assert.match(findings[0].detail, /rotate/);
});

test('findings are capped per type so a broken page cannot flood the report', () => {
  const els = [el({ i: 0, p: -1, bg: 'rgb(255, 255, 255)' })];
  for (let i = 1; i <= 40; i++) els.push(el({ i, p: 0, sel: `.t${i}`, text: true, color: 'rgb(200, 200, 200)' }));
  const findings = analyzeSnapshot(snap(els));
  assert.equal(findings.filter((f) => f.type === 'contrast' && f.selector).length, 10);
  assert.ok(findings.some((f) => /30 more contrast/.test(f.detail)));
});

test('validateVisualConfig fills defaults and rejects what it cannot apply', () => {
  const cfg = validateVisualConfig({ start: 'npm start', ready_url: 'http://localhost:{port}/' });
  assert.deepEqual(cfg.pages, ['/']);
  assert.deepEqual(cfg.viewports, [1024]);
  assert.deepEqual(cfg.locales, []);
  assert.deepEqual(cfg.themes, []);
  assert.equal(cfg.max_points, 48);
  assert.ok(cfg.ready_timeout_ms > 0 && cfg.budget_ms > 0);
  assert.throws(() => validateVisualConfig({ ready_url: 'http://x/' }), /start/);
  assert.throws(() => validateVisualConfig({ start: 'x' }), /ready_url/);
  assert.throws(() => validateVisualConfig({ start: 'x', ready_url: 'http://x/', viewports: [0] }), /viewports/);
  assert.throws(() => validateVisualConfig({ start: 'x', ready_url: 'http://x/', pages: ['no-slash'] }), /pages/);
  // several locales need a declared way to apply them; so do themes
  assert.throws(() => validateVisualConfig({ start: 'x', ready_url: 'http://x/', locales: ['en', 'es'] }), /locale/);
  assert.throws(() => validateVisualConfig({ start: 'x', ready_url: 'http://x/', themes: ['a', 'b'] }), /theme/);
  assert.throws(() => validateVisualConfig({ start: 'x', ready_url: 'http://x/', locales: ['en'], locale: { nope: 1 } }), /locale/);
  assert.throws(() => validateVisualConfig({ start: 'x', ready_url: 'http://x/', themes: ['a'], theme: { media: 'other' } }), /theme/);
  const ok = validateVisualConfig({
    start: 'x', ready_url: 'http://x/', locales: ['en', 'es'], locale: { param: 'lang' },
    themes: ['light', 'dark'], theme: { media: 'prefers-color-scheme' },
  });
  assert.deepEqual(ok.locale, { param: 'lang' });
});

test('buildMatrix expands pages x viewports x locales x themes and honors the cap', () => {
  const cfg = validateVisualConfig({
    start: 'x', ready_url: 'http://x/', pages: ['/a', '/b'], viewports: [390, 1024], locales: ['en', 'es'],
    locale: { param: 'lang' }, themes: ['light', 'dark'], theme: { attribute: 'data-theme' }, max_points: 10,
  });
  const full = buildMatrix({ ...cfg, max_points: 100 });
  assert.equal(full.total, 16);
  assert.equal(full.points.length, 16);
  assert.deepEqual(full.points[0], { page: '/a', viewport: 390, locale: 'en', theme: 'light' });
  const capped = buildMatrix(cfg);
  assert.equal(capped.total, 16);
  assert.equal(capped.points.length, 10);
  assert.equal(capped.truncated, true);
  const bare = buildMatrix(validateVisualConfig({ start: 'x', ready_url: 'http://x/' }));
  assert.deepEqual(bare.points, [{ page: '/', viewport: 1024, locale: null, theme: null }]);
});

test('findChrome prefers CHROME_PATH, then common locations, and returns null without a browser', () => {
  const only = (...paths) => (p) => paths.includes(p);
  assert.equal(findChrome({ env: { CHROME_PATH: '/opt/chrome' }, exists: only('/opt/chrome'), platform: 'linux' }), '/opt/chrome');
  assert.equal(findChrome({ env: {}, exists: only('/usr/bin/chromium'), platform: 'linux' }), '/usr/bin/chromium');
  assert.equal(
    findChrome({ env: {}, exists: only('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), platform: 'darwin' }),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  );
  // a CHROME_PATH that does not exist falls through to the common locations
  assert.equal(findChrome({ env: { CHROME_PATH: '/nope' }, exists: only('/usr/bin/google-chrome'), platform: 'linux' }), '/usr/bin/google-chrome');
  assert.equal(findChrome({ env: {}, exists: () => false, platform: 'linux' }), null);
});

test('formatReport: first line is the status, findings are grouped by matrix point', () => {
  const matrix = { total: 2, points: [{}, {}], truncated: false };
  const text = formatReport({
    status: 'FAIL', matrix,
    results: [
      { point: { page: '/', viewport: 390, locale: 'es', theme: 'dark' }, findings: [{ type: 'overflow', selector: '.a', detail: 'scrollWidth 420 > clientWidth 380' }] },
      { point: { page: '/', viewport: 1024, locale: 'es', theme: 'dark' }, findings: [] },
    ],
  });
  const lines = text.split('\n');
  assert.equal(lines[0], 'VISUAL: FAIL');
  assert.match(text, /## \/ · 390px · es · dark/);
  assert.match(text, /- overflow `\.a`: scrollWidth 420 > clientWidth 380/);
  assert.doesNotMatch(text, /1024px · es · dark\n/);
  assert.equal(visualStatus(text), 'FAIL');
  const skipped = formatReport({ status: 'SKIPPED', reason: 'not configured' });
  assert.equal(skipped.split('\n')[0], 'VISUAL: SKIPPED');
  assert.match(skipped, /not configured/);
  assert.equal(visualStatus('VISUAL: SKIPPED\n'), 'SKIPPED');
  assert.equal(visualStatus('nonsense'), null);
  assert.equal(visualStatus(null), null);
});

test('contrast: alpha-0 text is skipped, -webkit-text-fill-color wins over color', () => {
  const base = el({ i: 0, p: -1, bg: 'rgb(255, 255, 255)' });
  const run = (over) => analyzeSnapshot(snap([base, el({ i: 1, p: 0, sel: '.t', text: true, color: 'rgb(0, 0, 0)', ...over })]));
  assert.deepEqual(run({ color: 'rgba(0, 0, 0, 0)' }), [], 'transparent color');
  assert.deepEqual(run({ tf: 'rgba(0, 0, 0, 0)' }), [], 'transparent text fill (gradient text)');
  assert.deepEqual(run({ color: 'rgb(255, 255, 255)', tf: 'rgb(0, 0, 0)' }), [], 'fill is dark: readable');
  const faint = run({ color: 'rgb(0, 0, 0)', tf: 'rgb(200, 200, 200)' });
  assert.equal(faint.length, 1);
  assert.match(faint[0].detail, /#c8c8c8/);
});

test('contrast: 1px-tall or 1px-wide visually-hidden boxes are exempt like in overflow', () => {
  const base = el({ i: 0, p: -1, bg: 'rgb(255, 255, 255)' });
  const hidden = (over) => analyzeSnapshot(snap([base, el({ i: 1, p: 0, text: true, color: 'rgb(255, 255, 255)', ...over })]));
  assert.deepEqual(hidden({ w: 1, h: 1 }), []);
  assert.deepEqual(hidden({ w: 100, h: 1 }), []);
  assert.equal(hidden({ w: 100, h: 20 }).length, 1);
});

test('data-visual-ignore opts one element (and its subtree) out of overflow, contrast or overlap', () => {
  const base = el({ i: 0, p: -1, bg: 'rgb(255, 255, 255)' });
  const overflow = (ign) => analyzeSnapshot(snap([base, el({ i: 1, p: 0, sel: '.crop', ox: 'hidden', sw: 500, cw: 200, ign })]));
  assert.equal(overflow('').length, 1);
  assert.deepEqual(overflow('overflow'), []);
  assert.equal(overflow('contrast').length, 1, 'only the named check is skipped');
  assert.deepEqual(overflow('contrast overlap overflow'), []);
  const text = (ign) => analyzeSnapshot(snap([base, el({ i: 1, p: 0, text: true, color: 'rgb(220, 220, 220)', ign })]));
  assert.equal(text('').length, 1);
  assert.deepEqual(text('contrast'), []);
  const pair = (ign) => analyzeSnapshot(snap([
    el({ i: 0, p: -1 }), el({ i: 1, p: 0, sel: '.a', w: 100, h: 40, mark: true }),
    el({ i: 2, p: 0, sel: '.b', x: 50, w: 100, h: 40, mark: true, ign }),
  ])).filter((f) => f.type === 'overlap');
  assert.equal(pair('').length, 1);
  assert.equal(pair('overlap').length, 0);
});

test('snapshotNotes reports the element cap; the report prints notes', () => {
  assert.deepEqual(snapshotNotes(snap([el({ i: 0, p: -1 })])), []);
  const notes = snapshotNotes(snap([el({ i: 0, p: -1 })], { truncated: true }));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /element cap/);
  assert.match(formatReport({ status: 'PASS', notes }), /Note: .*element cap/);
});

test('overallStatus: ERROR when nothing rendered, FAIL on findings from a rendered point, else PASS', () => {
  const ok = { rendered: true, findings: [] };
  const bad = { rendered: true, findings: [{ type: 'overflow', selector: '.a', detail: 'x' }] };
  const broke = { rendered: false, findings: [{ type: 'error', selector: '', detail: 'could not render' }] };
  assert.equal(overallStatus([ok, ok]), 'PASS');
  assert.equal(overallStatus([ok, bad]), 'FAIL');
  assert.equal(overallStatus([broke, broke]), 'ERROR', 'no page rendered');
  assert.equal(overallStatus([ok, broke]), 'FAIL', 'one page failing to load among passing ones is a finding');
  assert.equal(overallStatus([]), 'ERROR');
});

test('ERROR is a status: formatted with its reason and parsed from the first line', () => {
  const text = formatReport({ status: 'ERROR', reason: 'the app did not become ready' });
  assert.equal(text.split('\n')[0], 'VISUAL: ERROR');
  assert.match(text, /Reason: the app did not become ready/);
  assert.equal(visualStatus(text), 'ERROR');
});
