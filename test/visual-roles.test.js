// The visual check reaches the roles, both skills and the Codex wrappers, and the engine
// stays free of this repo's widths and locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateVisualConfig } from '../factory/lib/visual-analysis.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(repo, p), 'utf8');
const SKILLS = ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md'];
const STATUSES = ['VISUAL: PASS', 'VISUAL: FAIL', 'VISUAL: SKIPPED', 'VISUAL: ERROR'];

test('builder runs factory/bin/visual for a ui surface before STATUS: READY, fixes only FAIL, in the role and the Codex wrapper', () => {
  const role = read('factory/roles/builder.md');
  assert.match(role, /factory\/bin\/visual <job-id>/);
  assert.match(role, /surfaces include `ui`[^]*?before[^]*?STATUS: READY/);
  for (const status of STATUSES) assert.ok(role.includes(`\`${status}\``), `builder names ${status}`);
  assert.match(role, /Fix only\s+`FAIL`/);
  const toml = read('.codex/agents/eminzo-builder.toml');
  assert.match(toml, /factory\/bin\/visual/);
  assert.match(toml, /`ui`/);
  assert.match(toml, /fix only FAIL/);
  assert.match(toml, /VISUAL: ERROR/);
});

test('review-ui reads round-N/visual.md first, judges design, and measures itself on SKIPPED or ERROR', () => {
  const role = read('factory/roles/review-ui.md');
  assert.match(role, /visual\.md/);
  assert.match(role, /Do not re-measure/i);
  assert.match(role, /consistency, tokens, hierarchy/i);
  assert.match(role, /do not block on a matrix point/i);
  assert.match(role, /`VISUAL: SKIPPED` or `VISUAL: ERROR`/);
  const toml = read('.codex/agents/eminzo-review-ui.toml');
  assert.match(toml, /visual\.md/);
  assert.match(toml, /VISUAL: ERROR/);
});

test('spec-writer requires a verifiable UI AC and file:line ranges in Design', () => {
  const role = read('factory/roles/spec-writer.md');
  assert.match(role, /factory\/bin\/visual/);
  assert.match(role, /config\.visual/);
  assert.match(role, /overflow, contrast or overlap/);
  assert.match(role, /`path:start-end`/);
  assert.doesNotMatch(role, /\b(390|768|1024|1440)\b/, 'the role names no widths');
});

test('both skills carry the visual-check rule, name the gate, SKIPPED and ERROR', () => {
  for (const path of SKILLS) {
    const text = read(path);
    const at = text.indexOf('<!-- rule: visual-check -->');
    assert.ok(at >= 0, `${path} lacks the visual-check marker`);
    const block = text.slice(at, at + 1100);
    assert.match(block, /visual\.md/);
    assert.match(block, /config\.visual/);
    assert.match(block, /gate/i);
    assert.match(block, /SKIPPED/);
    assert.match(block, /ERROR/);
  }
});

test('this repo declares a visual block the runner accepts, covering the dashboard matrix', () => {
  const cfg = validateVisualConfig(JSON.parse(read('factory/config.json')).visual);
  assert.deepEqual(cfg.viewports, [390, 768, 1024, 1440]);
  assert.deepEqual(cfg.locales, ['en', 'es', 'pt']);
  assert.equal(cfg.themes.length, 2);
  assert.ok(cfg.pages.some((p) => p.startsWith('/dashboard.html')));
});

test('the dashboard marks its key tiles for the overlap check', () => {
  assert.ok((dashboardSource().replace(/\s+/g, ' ').match(/data-visual-check/g) ?? []).length >= 1);
  assert.match(read('factory/pipeline-canvas.js'), /data-visual-check/);
});

test('the engine files name no widths or locales of this repo', () => {
  for (const f of ['factory/lib/visual.js', 'factory/lib/visual-analysis.js', 'factory/lib/visual-collect.js']) {
    const text = read(f);
    assert.doesNotMatch(text, /\b(390|768|1440)\b/, f);
    assert.doesNotMatch(text, /dashboard|navy/i, f);
  }
  assert.ok(readdirSync(join(repo, 'factory/bin')).includes('visual'));
});
