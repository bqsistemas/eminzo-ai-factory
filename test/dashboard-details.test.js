import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ago, roundsOf, olderMergedHtml, roundChipsHtml, costTimeHtml } from '../factory/activity.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const html = dashboardSource();
const T0 = Date.parse('2026-01-01T00:00:00Z');

test('AC-1: ago formats seconds, minutes, hours, days and rejects junk', () => {
  const iso = '2026-01-01T00:00:00Z';
  assert.equal(ago(iso, T0 + 45e3), '45s ago');
  assert.equal(ago(iso, T0 + 5 * 60e3), '5m ago');
  assert.equal(ago(iso, T0 + 3 * 3600e3), '3h ago');
  assert.equal(ago(iso, T0 + 2 * 86400e3), '2d ago');
  assert.equal(ago(iso, T0 - 5e3), '0s ago');
  for (const bad of [undefined, '', 'junk']) assert.equal(ago(bad, T0), '');
});

test('AC-2: roundsOf appends the current round only when it has data', () => {
  const reviews = { code: 'PASS' };
  const history = [{ gate: 'FAIL', reviews: {} }, { gate: 'PASS', reviews: {} }];
  const r = roundsOf({ history, round: 3, gate: 'PASS', reviews });
  assert.equal(r.length, 3);
  assert.deepEqual(r[2], { gate: 'PASS', reviews });
  assert.equal(roundsOf({ history, round: 0, gate: 'PASS', reviews }).length, 2);
  assert.equal(roundsOf({ history, round: 3 }).length, 2);
  assert.deepEqual(roundsOf(null), []);
});

test('AC-3: older rows carry escaped, aria-hidden meta details', () => {
  const now = T0 + 3600e3;
  const job = {
    id: 'j1', title: 'T', stage: 'merged', cost_usd: 1.5, started: '2026-01-01T00:00:00Z',
    finished: '2026-01-01T00:30:00Z', updated: '2026-01-01T00:30:00Z',
    history: [{ gate: 'FAIL', reviews: { code: 'CHANGES' } }, { gate: 'PASS', reviews: { code: 'PASS' } }],
  };
  const out = olderMergedHtml([job], 'l', false, now);
  const last = job.history[1];
  assert.ok(out.includes('<span class="row-title">T</span><span class="row-meta" aria-hidden="true">'));
  assert.ok(out.includes('<span class="n">R2</span>' + roundChipsHtml(last)));
  assert.ok(out.includes(`<span class="cost-time">${costTimeHtml(job, now)}</span>`));
  assert.ok(out.includes(`<span class="when">${ago(job.updated, now)}</span>`));
  const bare = olderMergedHtml([{ id: 'j2', title: 'x', cost_usd: 2, updated: job.updated }], 'l', false, now);
  assert.ok(!bare.includes('class="n"'));
  assert.ok(bare.includes('$2.00'));
  const evil = olderMergedHtml([{ id: '<img src=x>', title: '<img onerror=1>', updated: '<img>' }], 'l', false, now);
  assert.ok(!evil.includes('<img'));
  assert.ok(olderMergedHtml([{ id: 'x2', title: 'x2' }], 'l', false).includes('x2</span> <span class="row-title">x2<'));
});

test('AC-4: dashboard markup wires the drawer summary and imports ago/roundsOf', () => {
  const head = html.indexOf('class="drawer-head"');
  const sum = html.indexOf('id="d-summary"');
  const files = html.indexOf('id="files"');
  assert.ok(head > -1 && head < sum && sum < files);
  const imp = html.match(/import \{[^}]*\} from '\.\/activity\.js'/)[0];
  assert.match(imp, /\bago\b/);
  assert.match(imp, /\broundsOf\b/);
  assert.ok(!html.includes('function ago('));
  assert.ok(!html.includes('function roundsOf('));
  assert.match(html, /\$\('d-summary'\)\.innerHTML = card\(job\)/);
});

test('AC-5: CSS hides redundant summary parts and collapses row meta by container width', () => {
  assert.match(html, /\.drawer-summary \.card-top,\s*\.drawer-summary \.links\s*\{\s*display: none;/);
  assert.match(html, /\.drawer-summary \{[^}]*flex: none/);
  assert.match(html, /\.drawer-summary \{[^}]*overflow-y: auto/);
  assert.match(html, /\.older\s*\{[^}]*container-type: inline-size/);
  assert.match(html, /\.row-meta\s*\{[^}]*margin-left: auto/);
  assert.match(html, /\.row-meta\s*\{[^}]*flex-wrap: wrap/);
  assert.match(html, /\.drawer-summary \.card\s*\{[^}]*opacity: 1/);
  assert.match(html, /@container \(max-width: \d+px\)\s*\{\s*\.row-meta\s*\{\s*display: none;/);
});
