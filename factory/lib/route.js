// factory/bin/route <job-id> [--provider <name>]: intake's risk and surfaces → the
// builder model and routed reviewers from the provider routing table in
// factory/config.json. The CLI only prints; it writes nothing.
import { join } from 'node:path';

import { KNOWN_SURFACES, parseIntake, withImplied } from './intake.js';

export { KNOWN_SURFACES };
import { Refused, Usage, factoryRoot, isMain, jobDir, loadConfig, readText, runCli } from './util.js';

const RISKS = ['low', 'medium', 'high'];
export const DEFAULT_PROVIDER = 'claude';
const SCRIPT = 'script';
const configured = (config, provider) => config?.providers?.[provider];

/**
 * Resolve the provider-specific model/routing section while keeping the
 * original top-level `models`/`routing` fields as the Claude compatibility
 * fallback for old config files.
 */
export function providerConfig(config, provider = config?.default_provider ?? DEFAULT_PROVIDER) {
  if (typeof provider !== 'string' || !provider.trim()) throw new Error('provider must be a non-empty string');
  const configured = config?.providers?.[provider];
  const legacy = provider === DEFAULT_PROVIDER ? config : null;
  const models = configured?.models ?? legacy?.models;
  const routing = configured?.routing ?? legacy?.routing;
  if (!models || !routing) throw new Error(`unknown provider: ${provider}`);
  return { provider, models, routing };
}

/** A model entry is a string, or `{low, medium, high}` chosen by the job's risk. */
function pickModel(entry, risk, role, provider) {
  const selected = typeof entry === 'string' ? entry : entry?.[risk];
  if (typeof selected !== 'string' || !selected.trim()) throw new Error(`provider ${provider} has no model for ${role}`);
  return selected;
}

/**
 * Return the fixed-stage model assignments for a provider at a risk level
 * (`medium` until intake has rated the job). A `script` approver also reports the
 * LLM to spawn when the script is inconclusive as `approver-llm`: `models["approver-llm"]`
 * (a string or `{low, medium, high}`) picked by risk, else the `approver.high` entry.
 */
export function stageModels(config, provider = config?.default_provider ?? DEFAULT_PROVIDER, risk = 'medium') {
  if (!RISKS.includes(risk)) throw new Error(`unknown risk: ${risk}`);
  const resolved = providerConfig(config, provider);
  const result = {};
  for (const role of ['intake', 'spec-writer', 'approver']) {
    result[role] = pickModel(resolved.models?.[role], risk, role, provider);
  }
  // The amend model is optional: a config without it amends with the spec-writer model.
  const amend = resolved.models?.['spec-writer-amend'];
  result['spec-writer-amend'] = typeof amend === 'string' && amend.trim() ? amend : result['spec-writer'];
  if (result.approver === SCRIPT) {
    const entry = resolved.models['approver-llm'];
    if (entry !== undefined) {
      const llm = pickModel(entry, risk, 'approver-llm', provider);
      if (llm === SCRIPT) throw new Error(`provider ${provider} has no model for approver-llm`);
      result['approver-llm'] = llm;
    } else {
      const llm = resolved.models.approver?.high;
      if (typeof llm === 'string' && llm.trim() && llm !== SCRIPT) result['approver-llm'] = llm;
    }
  }
  return result;
}

/** The lane rule from the root config, e.g. `{ reviewers: ['code'], spec: false, approver: 'script' }`. */
export function laneRule(config, lane) {
  const rule = config?.lanes?.[lane];
  if (!rule || typeof rule !== 'object') throw new Error(`unknown lane: ${lane}`);
  return rule;
}

/**
 * Which lane a job runs in. `xs` needs intake's `SIZE: xs`, risk low and surfaces `none` or
 * `ui`, and a configured xs lane for the provider; anything else is `normal` with the reason.
 * `requested` (the factory:xs label) only explains a downgrade; the criteria are never waived.
 * @returns {{ lane: 'xs'|'normal', reason: string|null }}
 */
export function decideLane(config, intake, provider = config?.default_provider ?? DEFAULT_PROVIDER, { requested = false } = {}) {
  const normal = (reason) => ({ lane: 'normal', reason: requested || intake?.size === 'xs' ? reason : null });
  if (intake?.size !== 'xs') return normal(`intake sized the change ${intake?.size ?? 'unspecified'}, not xs`);
  if (intake.risk !== 'low') return normal(`xs needs risk low, got ${intake.risk}`);
  if ((intake.surfaces ?? []).some((s) => s !== 'ui')) return normal(`xs allows surfaces none or ui, got ${intake.surfaces.join(', ')}`);
  if (!config?.lanes?.xs) return normal('no xs lane is configured');
  if (config.lanes.xs.spec !== false) return normal('lanes.xs.spec must be false: the xs lane has no spec stage');
  const models = config?.providers?.[provider]?.lanes?.xs;
  if (!models?.builder || !models?.reviewer) return normal(`provider ${provider} has no xs lane models`);
  return { lane: 'xs', reason: null };
}

/**
 * @param {object} config factory/config.json
 * @param {{ risk: string, surfaces: string[] }} intake
 * @param {string} provider provider name, defaulting to config.default_provider
 * @param {string} lane `normal` (the routing table) or a lane from `config.lanes` (its builder, and only its reviewers)
 * @returns {{ builder: string, reviewers: Record<string, string> }}
 */
export function route(config, { risk, surfaces } = {}, provider = config?.default_provider ?? DEFAULT_PROVIDER, lane = 'normal') {
  const resolved = providerConfig(config, provider);
  const { builder, reviewers } = resolved.routing;
  if (!RISKS.includes(risk) || !Object.hasOwn(builder, risk)) throw new Error(`unknown risk: ${risk}`);
  if (!Array.isArray(surfaces)) throw new Error('surfaces must be a list');
  for (const surface of surfaces) {
    if (!KNOWN_SURFACES.includes(surface)) throw new Error(`unknown surface: ${surface}`);
  }
  const effective = withImplied(surfaces); // interaction also routes ui
  const pick = (model, role) => pickModel(model, risk, role, provider);
  if (lane !== 'normal') {
    const rule = laneRule(config, lane);
    const models = configured(config, provider)?.lanes?.[lane];
    const lenses = Array.isArray(rule.reviewers) ? rule.reviewers : [];
    for (const lens of lenses) if (!Object.hasOwn(reviewers, lens)) throw new Error(`lane ${lane} lists unknown reviewer: ${lens}`);
    return {
      builder: pick(models?.builder, `${lane} builder`),
      reviewers: Object.fromEntries(lenses.map((lens) => [lens, pick(models?.reviewer, `${lane} reviewer`)])),
    };
  }
  const routed = {};
  for (const [lens, rule] of Object.entries(reviewers)) {
    if (rule.always || effective.includes(rule.surface)) routed[lens] = pick(rule.model, `review-${lens}`);
  }
  return { builder: pick(builder, 'builder'), reviewers: routed };
}

function main(args) {
  if (![1, 3].includes(args.length) || (args.length === 3 && args[1] !== '--provider')) {
    throw new Usage('route <job-id> [--provider <name>]');
  }
  const root = factoryRoot();
  const text = readText(join(jobDir(root, args[0]), 'intake.md'));
  if (text === null) throw new Refused(`${args[0]} has no intake.md`);
  const provider = args.length === 3 ? args[2] : undefined;
  const config = loadConfig(root);
  const result = route(config, parseIntake(text), provider);
  process.stdout.write(`${JSON.stringify(provider ? { provider, ...result } : result)}\n`);
}

if (isMain(import.meta.url)) runCli(main);
