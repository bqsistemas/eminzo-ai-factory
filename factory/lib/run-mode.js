// How `run` picks its work. "own" (the default): continue only the local jobs in
// factory/jobs/; a new issue enters through `issue <n>`, `<feature>` or `xs`.
// "queue": also drain every open `factory` issue. Pure: no I/O.
import { Refused } from './util.js';

export const RUN_MODES = Object.freeze(['own', 'queue']);

/** `config.run_mode`: 'own' when absent, a member of RUN_MODES, or Refused. */
export function runMode(config) {
  const value = config?.run_mode;
  if (value === undefined) return 'own';
  if (typeof value === 'string' && RUN_MODES.includes(value)) return value;
  throw new Refused(`run_mode must be "own" or "queue", got ${JSON.stringify(value) ?? String(value)}`);
}
