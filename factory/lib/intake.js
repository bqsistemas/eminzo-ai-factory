// Parses the header of intake.md, written by the intake agent. Shared by
// factory/bin/job (re-exported from job.js) and factory/bin/route.

const DECISIONS = ['ACCEPT', 'NEEDS-INFO', 'REJECT'];
const RISKS = ['low', 'medium', 'high'];
/** The surfaces the engine knows; they never come from the reviewer config. */
export const KNOWN_SURFACES = ['ui', 'security', 'interaction'];
const SURFACES = KNOWN_SURFACES;

/** `interaction` implies `ui`: a new interactive flow also gets the UI reviewer and the visual check. */
export function withImplied(surfaces) {
  const list = Array.isArray(surfaces) ? surfaces : [];
  return list.includes('interaction') && !list.includes('ui') ? [...list, 'ui'] : list;
}
const SIZES = ['xs', 's', 'm', 'l'];

/**
 * Parses the header of intake.md: four exact lines, plus an optional fifth `SIZE: xs|s|m|l`.
 * Throws on any malformed or unknown line. A missing SIZE (older intake files) leaves `size`
 * out of the result, and the job then runs in the normal lane.
 * @returns {{ decision: string, risk: string, surfaces: string[], rescoped: boolean, size?: string }}
 */
export function parseIntake(text) {
  const [d = '', r = '', s = '', x = '', z = ''] = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const decision = d.trim();
  if (!DECISIONS.includes(decision)) throw new Error(`intake.md line 1: expected ACCEPT, NEEDS-INFO or REJECT, got ${JSON.stringify(d)}`);
  const risk = r.match(/^RISK:\s*(\S+)\s*$/)?.[1];
  if (!RISKS.includes(risk)) throw new Error(`intake.md line 2: expected RISK: low|medium|high, got ${JSON.stringify(r)}`);
  const list = s.match(/^SURFACES:\s*(.+?)\s*$/)?.[1];
  if (!list) throw new Error(`intake.md line 3: expected SURFACES: ..., got ${JSON.stringify(s)}`);
  const surfaces = list === 'none' ? [] : list.split(',').map((t) => t.trim());
  for (const surface of surfaces) {
    if (!SURFACES.includes(surface)) throw new Error(`intake.md line 3: unknown surface ${JSON.stringify(surface)}`);
  }
  if (new Set(surfaces).size !== surfaces.length) throw new Error('intake.md line 3: repeated surface');
  const rescoped = x.match(/^RESCOPED:\s*(yes|no)\s*$/)?.[1];
  if (!rescoped) throw new Error(`intake.md line 4: expected RESCOPED: yes|no, got ${JSON.stringify(x)}`);
  const result = { decision, risk, surfaces, rescoped: rescoped === 'yes' };
  if (/^SIZE:/.test(z)) {
    const size = z.match(/^SIZE:\s*(\S+)\s*$/)?.[1];
    if (!SIZES.includes(size)) throw new Error(`intake.md line 5: expected SIZE: xs|s|m|l, got ${JSON.stringify(z)}`);
    result.size = size;
  }
  return result;
}
