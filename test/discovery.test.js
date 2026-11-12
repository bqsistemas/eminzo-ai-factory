// The product stage's discovery method: the team's choice in config.json `discovery`, a person's own in
// config.local.json, and whether Elephant-Goldfish (egm@egm) is installed for Claude Code or Codex, read only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EGM_INSTALL, discoveryMethod, discoveryMethods, egmInClaude, egmInCodex } from '../factory/lib/discovery.js';
import { DISCOVERY_METHODS, OVERRIDABLE, Refused, validateLocal } from '../factory/lib/util.js';

function setup({ team = {}, local, claudePlugins, claudeSettings, codexToml } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-discovery-'));
  const root = join(dir, 'repo');
  const home = join(dir, 'home');
  mkdirSync(join(root, 'factory'), { recursive: true });
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ base: 'origin/main', ...team }));
  if (local) writeFileSync(join(root, 'factory/config.local.json'), JSON.stringify(local));
  if (claudePlugins) writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify(claudePlugins));
  if (claudeSettings) writeFileSync(join(home, '.claude/settings.json'), JSON.stringify(claudeSettings));
  if (codexToml) writeFileSync(join(home, '.codex/config.toml'), codexToml);
  return { root, home, env: { HOME: home } };
}

const EGM_CLAUDE = { version: 2, plugins: { 'egm@egm': [{ scope: 'user', installPath: '/x', version: '1.0.0' }], 'other@m': [] } };

test('discovery is a team key a person may override, with two methods and eminzo by default', () => {
  assert.deepEqual(DISCOVERY_METHODS, ['eminzo', 'elephant-goldfish']);
  assert.ok(OVERRIDABLE.includes('discovery'));
  assert.equal(discoveryMethod({}), 'eminzo');
  assert.equal(discoveryMethod({ discovery: 'elephant-goldfish' }), 'elephant-goldfish');
  assert.throws(() => discoveryMethod({ discovery: 'spec-kit' }), Refused);
  assert.throws(() => validateLocal({}, { discovery: 'spec-kit' }), /discovery: must be one of eminzo, elephant-goldfish/);
  validateLocal({}, { discovery: 'elephant-goldfish' });
});

test('Elephant-Goldfish in Claude Code: installed and not disabled', () => {
  assert.equal(egmInClaude(setup().home), false, 'no plugin registry');
  assert.equal(egmInClaude(setup({ claudePlugins: EGM_CLAUDE }).home), true);
  assert.equal(egmInClaude(setup({ claudePlugins: EGM_CLAUDE, claudeSettings: { enabledPlugins: { 'egm@egm': false } } }).home), false, 'disabled');
  assert.equal(egmInClaude(setup({ claudePlugins: { plugins: { 'other@m': [] } } }).home), false);
  const relocated = setup({ claudePlugins: EGM_CLAUDE });
  assert.equal(egmInClaude('/nowhere', { CLAUDE_CONFIG_DIR: join(relocated.home, '.claude') }), true);
});

test('Elephant-Goldfish in Codex: its own plugins table, unless enabled = false', () => {
  assert.equal(egmInCodex(setup().home), false);
  assert.equal(egmInCodex(setup({ codexToml: 'model = "gpt-6"\n[plugins."egm@egm"]\nenabled = true\n' }).home), true);
  assert.equal(egmInCodex(setup({ codexToml: '[plugins."egm@egm"]\n' }).home), true, 'installed without an enabled key');
  assert.equal(egmInCodex(setup({ codexToml: '[plugins."egm@egm"]\nenabled = false\n[other]\n' }).home), false);
  assert.equal(egmInCodex(setup({ codexToml: '[plugins."gmail@openai-curated"]\nenabled = true\n' }).home), false);
});

test('discoveryMethods: the team choice when it is available, a person\'s local choice, and a clear fallback', () => {
  const basic = setup();
  const b = discoveryMethods({ root: basic.root, home: basic.home, env: basic.env });
  assert.equal(b.selected, 'eminzo');
  assert.equal(b.source, 'default');
  assert.equal(b.fallback, null);
  assert.deepEqual(b.methods.map((m) => [m.id, m.available]), [['eminzo', true], ['elephant-goldfish', false]]);

  const team = setup({ team: { discovery: 'elephant-goldfish' }, claudePlugins: EGM_CLAUDE });
  const t = discoveryMethods({ root: team.root, home: team.home, env: team.env });
  assert.equal(t.selected, 'elephant-goldfish');
  assert.equal(t.source, 'team');
  assert.equal(t.summary, 'Discovery method: Elephant-Goldfish (Google).');

  const missing = setup({ team: { discovery: 'elephant-goldfish' } });
  const m = discoveryMethods({ root: missing.root, home: missing.home, env: missing.env, provider: 'codex' });
  assert.equal(m.selected, 'eminzo');
  assert.equal(m.fallback, `Elephant-Goldfish (Google) is configured but not installed for Codex; using Eminzo basic. To install it: ${EGM_INSTALL.codex.join(' && ')}`);

  const local = setup({ team: { discovery: 'elephant-goldfish' }, local: { discovery: 'eminzo' }, claudePlugins: EGM_CLAUDE });
  const l = discoveryMethods({ root: local.root, home: local.home, env: local.env });
  assert.equal(l.selected, 'eminzo');
  assert.equal(l.source, 'local');
  assert.equal(l.summary, 'Discovery method: Eminzo basic (your local choice).');
});
