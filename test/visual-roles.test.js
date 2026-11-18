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
  // The Codex profile no longer restates the step: it reads this role (sync-agents.test.js proves the generated profile).
  assert.match(read('.codex/agents/eminzo-builder.toml'), /factory\/roles\/builder\.md/);
});

test('review-ui sweeps every condition on a first review and reports all blockers at once, for any project', () => {
  const role = read('factory/roles/review-ui.md').replace(/\s+/g, ' '); // phrases may wrap
  // The method is generic: the role names no width, language or screen of one repository.
  assert.match(role, /\*\*Sweep every condition on a first review\.\*\*/);
  assert.match(role, /report every blocker you find in one review/i);
  assert.match(role, /does not declare them, derive them from the change/i);
  assert.match(role, /`Conditions reviewed:`/);
  assert.match(role, /longest content/i);
  assert.match(role, /name that already exists/i);
  // It does not fight the deterministic check, and it is bounded.
  assert.match(role, /Skip a condition `visual\.md` measured and passed/);
  assert.match(role, /combinations the change touches/i);
  assert.match(role, /`Not reviewed:`/);
  // A repeat review does not sweep again.
  assert.match(role, /On a repeat review, do not sweep again/);
  // The builder never reads this role: the fix line itself names where to verify.
  assert.match(role, /name the conditions in the fix/i);
  // Not web-only.
  assert.match(role, /screen, window or terminal sizes/i);
  assert.match(role, /text scale/i);
});

test('review-ui grades severity: unreadable or stuck blocks, a marginal miss in a transient state is minor unless the repo says otherwise', () => {
  const role = read('factory/roles/review-ui.md').replace(/\s+/g, ' ');
  assert.match(role, /\*\*Severity\.\*\*/);
  assert.match(role, /only on hover or while pressed/i);
  // The accessibility floor: the default state and keyboard focus never downgrade.
  assert.match(role, /in its default state is always a `\[blocker\]`/);
  assert.match(role, /focus[^.]*is never a marginal miss/i);
  assert.match(role, /within 0\.5 of the threshold/);
  assert.match(role, /A cap or a skip rule never hides it/);
  assert.match(role, /`factory\/review\.md` can make it a blocker/i);
  // The existing guarantee stays: the repo policy never suppresses a blocker.
  assert.match(role, /never suppresses a `\[blocker\]`/);
});

test('review-ui reads round-N/visual.md first, judges design, and measures itself on SKIPPED or ERROR', () => {
  const role = read('factory/roles/review-ui.md');
  assert.match(role, /visual\.md/);
  assert.match(role, /Do not re-measure/i);
  assert.match(role, /consistency, tokens, hierarchy/i);
  assert.match(role, /do not block on a matrix point/i);
  assert.match(role, /`VISUAL: SKIPPED` or `VISUAL: ERROR`/);
  assert.match(read('.codex/agents/eminzo-review-ui.toml'), /factory\/roles\/review-ui\.md/);
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
