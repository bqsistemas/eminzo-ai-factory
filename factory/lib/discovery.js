// The discovery method of the product stage: how Ask Eminzo explores an idea with a Product Lead before a brief.
//   eminzo             the basic method that ships with the engine (always available)
//   elephant-goldfish  Google's Elephant-Goldfish Model plugin (egm@egm), when it is installed for the agent
// The team picks one in factory/config.json `discovery`; a person may pick another in config.local.json.
// Whatever the method, its outcome becomes an Eminzo brief (brief.js), so deliverables and estimates work the same.
//
// Detection only reads files, and only what each tool documents: Claude Code lists installed plugins in
// ~/.claude/plugins/installed_plugins.json (key "<plugin>@<marketplace>") and keeps the enabled state in
// ~/.claude/settings.json `enabledPlugins`; Codex keeps installed plugins as [plugins."<plugin>@<marketplace>"]
// tables in ~/.codex/config.toml, with `enabled = false` for a disabled one. Nothing is installed or changed here.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DISCOVERY_METHODS, Refused, effectiveConfig } from './util.js';

/** The Elephant-Goldfish plugin id in both tools, and how a person installs it (shown, never run). */
export const EGM_PLUGIN = 'egm@egm';
export const EGM_INSTALL = Object.freeze({
  claude: ['claude plugin marketplace add google/elephant-goldfish-model', 'claude plugin install egm@egm'],
  codex: ['codex plugin marketplace add google/elephant-goldfish-model', 'codex plugin add egm@egm'],
});

const LABELS = Object.freeze({ eminzo: 'Eminzo basic', 'elephant-goldfish': 'Elephant-Goldfish (Google)' });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};
const readText = (file) => {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
};

/** The configured method: `discovery` in the effective config, 'eminzo' when absent, or Refused. */
export function discoveryMethod(config) {
  const value = isObject(config) && Object.hasOwn(config, 'discovery') ? config.discovery : 'eminzo';
  if (typeof value === 'string' && DISCOVERY_METHODS.includes(value)) return value;
  throw new Refused(`discovery must be one of ${DISCOVERY_METHODS.join(', ')}, got ${JSON.stringify(value) ?? String(value)}`);
}

/** Whether Claude Code has the plugin installed and not disabled. */
export function egmInClaude(home, env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const installed = readJson(join(dir, 'plugins', 'installed_plugins.json'));
  if (!isObject(installed?.plugins) || !Object.hasOwn(installed.plugins, EGM_PLUGIN)) return false;
  const settings = readJson(join(dir, 'settings.json'));
  const enabled = isObject(settings?.enabledPlugins) ? settings.enabledPlugins[EGM_PLUGIN] : undefined;
  return enabled !== false;
}

/** Whether Codex has the plugin installed and not disabled (its own table in config.toml). */
export function egmInCodex(home, env = process.env) {
  const text = readText(join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'));
  if (text === null) return false;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[\s*plugins\.(?:"egm@egm"|'egm@egm')\s*\]\s*(#.*)?$/.test(l));
  if (start === -1) return false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    if (/^\s*enabled\s*=\s*false\b/.test(line)) return false;
  }
  return true;
}

/**
 * The methods a person can pick, which one is in use and why. When the configured method is not available for the
 * agent in use, the basic method is used instead and `fallback` says so.
 * @param {{ root: string, home?: string, env?: object, provider?: 'claude' | 'codex' }} options
 */
export function discoveryMethods({ root, home = homedir(), env = process.env, provider = 'claude' }) {
  const { config, overrides } = effectiveConfig(root, { warn: () => {} });
  const configured = discoveryMethod(config);
  const egm = { claude: egmInClaude(home, env), codex: egmInCodex(home, env) };
  const methods = DISCOVERY_METHODS.map((id) => ({
    id,
    label: LABELS[id],
    available: id === 'eminzo' ? true : egm[provider] === true,
    ...(id === 'elephant-goldfish' ? { installed: egm, install: EGM_INSTALL[provider] } : {}),
  }));
  const usable = methods.find((m) => m.id === configured)?.available === true;
  const selected = usable ? configured : 'eminzo';
  const fallback = usable ? null
    : `${LABELS[configured]} is configured but not installed for ${provider === 'codex' ? 'Codex' : 'Claude Code'}; using ${LABELS.eminzo}. To install it: ${EGM_INSTALL[provider].join(' && ')}`;
  return {
    summary: fallback ?? `Discovery method: ${LABELS[selected]}${overrides.includes('discovery') ? ' (your local choice)' : ''}.`,
    configured,
    configured_in: overrides.includes('discovery') ? 'local' : Object.hasOwn(config, 'discovery') ? 'team' : 'default',
    selected,
    provider,
    fallback,
    methods,
  };
}
