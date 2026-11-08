// Plan P0-6, dashboard: the XS chip and the pipeline canvas that shows skipped stages dimmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { derivePipeline, laneChip, stageCardsHtml, stageDetails, taskHeaderHtml } from '../factory/pipeline-canvas.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const html = dashboardSource();
const states = (job) => Object.fromEntries(derivePipeline(job).map((s) => [s.key, s.state]));

test('an xs job shows spec and approve as skipped, never pending', () => {
  assert.deepEqual(states({ lane: 'xs', stage: 'build' }), {
    intake: 'complete', spec: 'skipped', build: 'active', gate: 'pending', review: 'pending', approve: 'skipped', merge: 'pending',
  });
  assert.deepEqual(states({ lane: 'xs', stage: 'review' }), {
    intake: 'complete', spec: 'skipped', build: 'complete', gate: 'complete', review: 'active', approve: 'skipped', merge: 'pending',
  });
  assert.equal(states({ lane: 'xs', stage: 'approve' }).approve, 'skipped');
  assert.deepEqual(states({ lane: 'xs', stage: 'merged' }), {
    intake: 'complete', spec: 'skipped', build: 'complete', gate: 'complete', review: 'complete', approve: 'skipped', merge: 'complete',
  });
});

test('a normal job, and a promoted job, skip nothing', () => {
  assert.ok(!Object.values(states({ lane: 'normal', stage: 'build' })).includes('skipped'));
  assert.ok(!Object.values(states({ stage: 'merged' })).includes('skipped'));
  assert.ok(!Object.values(states({ lane: 'normal', promoted_from: 'xs', stage: 'spec' })).includes('skipped'));
});

test('skipped stages render dimmed with their own label and glyph, and count as passed over', () => {
  const out = stageCardsHtml({ lane: 'xs', stage: 'build' }, 'build');
  assert.match(out, /data-stage="spec" data-state="skipped"[^>]*aria-label="Spec: Skipped"/);
  assert.match(out, /data-stage="approve" data-state="skipped"/);
  assert.match(stageCardsHtml({ lane: 'xs', stage: 'build' }, 'build', { pipelineSkipped: 'Omitida' }), /aria-label="Spec: Omitida"/);
  assert.equal(stageDetails({ lane: 'xs', stage: 'merged' }, 'spec').status, 'Skipped');
  assert.equal(stageDetails({ lane: 'xs', stage: 'merged' }, 'merge').progress, '7/7 stages');
});

test('the chip says XS, or XS→normal after a promotion, and nothing for normal jobs', () => {
  assert.equal(laneChip({ lane: 'xs' }), 'XS');
  assert.equal(laneChip({ lane: 'normal', promoted_from: 'xs' }), 'XS→normal');
  assert.equal(laneChip({ lane: 'normal' }), null);
  assert.equal(laneChip({}), null);
  assert.equal(laneChip(null), null);
  assert.match(taskHeaderHtml({ id: '001-a', lane: 'xs', stage: 'build' }), /<span class="pipeline-chip">XS<\/span>/);
  assert.match(taskHeaderHtml({ id: '001-a', lane: 'normal', promoted_from: 'xs', stage: 'spec' }), /XS→normal/);
  assert.doesNotMatch(taskHeaderHtml({ id: '001-a', lane: 'normal', stage: 'spec' }), />XS/);
});

test('the dashboard styles the skipped stage and the lane chip, and localizes Skipped', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /\.pipeline-node\[data-state="skipped"\][^{]*\{[^}]*opacity/);
  assert.match(css, /\.lane-chip\s*\{/);
  assert.equal((html.match(/"pipelineSkipped"\s*:/g) ?? []).length, 3, 'one entry per language');
  assert.match(html, /laneChip/);
});
