// P1-2: the UX checklist moves into review-ui; review-ux becomes opt-in through the
// `interaction` surface (a new interactive flow). `interaction` implies `ui` in route(), so it routes ui and ux.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decideLane, route, KNOWN_SURFACES } from '../factory/lib/route.js';
import { parseIntake } from '../factory/lib/job.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(readFileSync(join(repo, 'factory/config.json'), 'utf8'));
const read = (p) => readFileSync(join(repo, p), 'utf8');
const flat = (p) => read(p).replace(/\s+/g, ' ');
const lenses = (provider, surfaces, risk = 'medium') => Object.keys(route(config, { risk, surfaces }, provider)).length && Object.keys(route(config, { risk, surfaces }, provider).reviewers).sort();

describe('routing by surface combination, in both providers', () => {
  const cases = [
    [[], ['code']],
    [['ui'], ['code', 'ui']],
    [['interaction'], ['code', 'ui', 'ux']],
    [['ui', 'interaction'], ['code', 'ui', 'ux']],
    [['security'], ['code', 'security']],
    [['ui', 'security'], ['code', 'security', 'ui']],
    [['interaction', 'security'], ['code', 'security', 'ui', 'ux']],
    [['ui', 'interaction', 'security'], ['code', 'security', 'ui', 'ux']],
  ];
  for (const provider of ['claude', 'codex']) {
    for (const [surfaces, expected] of cases) {
      test(`${provider}: ${surfaces.join('+') || 'none'} -> ${expected.join(',')}`, () => {
        assert.deepEqual(lenses(provider, surfaces), expected);
      });
    }
    test(`${provider}: ux is routed by the interaction surface only`, () => {
      const rule = config.providers[provider].routing.reviewers.ux;
      assert.equal(rule.surface, 'interaction');
      assert.ok(!rule.always);
    });
  }
});

test('known surfaces are an engine constant, not read from the reviewer config', () => {
  assert.deepEqual([...KNOWN_SURFACES].sort(), ['interaction', 'security', 'ui']);
  // An older adapter whose ux reviewer is still keyed on ui: interaction is known, and ux follows the config.
  const old = structuredClone(config);
  for (const p of Object.values(old.providers)) p.routing.reviewers.ux.surface = 'ui';
  for (const provider of ['claude', 'codex']) {
    assert.deepEqual(Object.keys(route(old, { risk: 'medium', surfaces: ['interaction'] }, provider).reviewers).sort(), ['code', 'ui', 'ux']);
    assert.deepEqual(Object.keys(route(old, { risk: 'medium', surfaces: ['ui'] }, provider).reviewers).sort(), ['code', 'ui', 'ux']);
  }
  // A config with no ux reviewer at all still accepts every known surface.
  const bare = structuredClone(config);
  for (const p of Object.values(bare.providers)) delete p.routing.reviewers.ux;
  assert.deepEqual(Object.keys(route(bare, { risk: 'low', surfaces: ['interaction'] }).reviewers).sort(), ['code', 'ui']);
  assert.throws(() => route(config, { risk: 'low', surfaces: ['database'] }), /unknown surface/);
});

test('the intake parser accepts interaction, alone and combined, and old files stay valid', () => {
  const header = (s) => `ACCEPT\nRISK: low\nSURFACES: ${s}\nRESCOPED: no\nSIZE: s\n`;
  assert.deepEqual(parseIntake(header('interaction')).surfaces, ['interaction']);
  assert.deepEqual(parseIntake(header('ui, interaction')).surfaces, ['ui', 'interaction']);
  assert.deepEqual(parseIntake(header('ui, security, interaction')).surfaces, ['ui', 'security', 'interaction']);
  assert.deepEqual(parseIntake('ACCEPT\nRISK: low\nSURFACES: ui\nRESCOPED: no\n').surfaces, ['ui']);
  assert.throws(() => parseIntake(header('interaction, interaction')), /repeated/);
  assert.throws(() => parseIntake(header('flow')), /unknown surface/);
});

test('xs rejects interaction: a new flow is never an xs change', () => {
  for (const surfaces of [['interaction'], ['ui', 'interaction']]) {
    for (const provider of ['claude', 'codex']) {
      const out = decideLane(config, { size: 'xs', risk: 'low', surfaces }, provider, { requested: true });
      assert.equal(out.lane, 'normal');
      assert.match(out.reason, /none or ui/);
    }
  }
  assert.equal(decideLane(config, { size: 'xs', risk: 'low', surfaces: ['ui'] }).lane, 'xs');
});

describe('roles and skills', () => {
  test('review-ui carries the UX checklist and keeps the visual-check behavior', () => {
    const ui = flat('factory/roles/review-ui.md');
    assert.match(ui, /flow does what the spec's Goal promises/i);
    assert.match(ui, /error messages say what went wrong and what to do next/i);
    assert.match(ui, /empty, error,? and loading states/i);
    assert.match(ui, /keyboard and screen-reader/i);
    assert.match(ui, /\[design\]/);
    assert.match(ui, /\[ux\]/);
    assert.match(ui, /visual\.md/);
    assert.match(ui, /N\/A only for the visual part|N\/A: no visual UI/);
    assert.match(ui, /UX checklist (still )?applies|UX of whatever the change renders|still run/i);
    assert.match(ui, /VERDICT: PASS/);
  });

  test('review-ux says it runs only for new interactive flows and tags findings like review-ui', () => {
    const ux = flat('factory/roles/review-ux.md');
    assert.match(ux, /interaction/);
    assert.match(ux, /\[ux\]/);
  });

  test('the Codex review-ui wrapper says the UX checklist survives a no-visual N/A', () => {
    assert.match(read('.codex/agents/eminzo-review-ui.toml'), /N\/A only for the visual part/);
  });

  test('docs: factory-explicado lists the interaction surface', () => {
    const doc = read('docs/factory-explicado.md');
    assert.match(doc, /`interaction`, si agrega un flujo interactivo nuevo/);
    assert.doesNotMatch(doc, /ninguna de las dos/);
    assert.doesNotMatch(doc, /errores visibles/);
  });

  test('intake documents the interaction surface and the line-3 format', () => {
    const intake = flat('factory/roles/intake.md');
    assert.match(intake, /`interaction`/);
    assert.match(intake, /Line 3 is `none`, `ui`, `security`, `interaction`/);
    assert.match(intake, /`ui` alone covers/);
    assert.match(intake, /`interaction` also adds the UI reviewer/);
    assert.match(intake, /never `interaction`/);
  });

  for (const file of ['.claude/skills/eminzo-factory/SKILL.md', '.agents/skills/eminzo-factory/SKILL.md']) {
    test(`${file}: ux-opt-in marker states the routing`, () => {
      const text = flat(file);
      assert.match(text, /<!-- rule: ux-opt-in -->/);
      const rule = text.slice(text.indexOf('<!-- rule: ux-opt-in -->')).slice(0, 900);
      assert.match(rule, /`interaction`/);
      assert.match(rule, /`ui` alone covers both design and UX/i);
      assert.match(rule, /`interaction` also routes `ui`/);
      assert.match(rule, /never xs|not allowed in xs|xs never/i);
    });
  }
});
