// Guesses the repo's deterministic checks from which files exist, and returns the factory/checks.sh to write.
// factory/bin/gate runs this script in a job's worktree; exit 0 means the gate passes.
// The detection, the per-stack scripts (factory/templates/checks/<stack>.sh) and the defaults live in the
// engine's factory/lib/stacks.js, which `factory/lib/init.js` (setup) uses too. Next to this repo's sources that
// is ../../../factory; in the published package it is the built engine under dist/.
import { existsSync } from 'node:fs';

const engineLib = ['../../../factory/lib/stacks.js', '../../dist/factory/lib/stacks.js'].map((p) => new URL(p, import.meta.url));
const stacks = await import(engineLib.find((u) => existsSync(u)) ?? engineLib[0]);

export const { acPattern } = stacks;

/**
 * @param {{ files: string[], packageJson: object | null, read: (file: string) => string }} input `files` are the repo root entries.
 * @returns {{ stack: 'node' | 'go' | 'rust' | 'python' | 'ruby' | 'maven' | 'gradle' | 'none', script: string }}
 */
export const detectChecks = (input) => stacks.checksFor(input);
