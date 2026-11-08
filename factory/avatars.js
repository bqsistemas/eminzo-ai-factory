// One cartoon octopus per factory agent, used by the dashboard (served from
// factory/, imported as a plain ES module). Plain data plus one string builder; no
// dependencies, runs in the browser and in Node.
//
// Every value here is a fixed constant. avatarSvg() output is injected raw into
// the dashboard, so it must never be built from job data.

/** Shared body for a 32x32 viewBox: dome head, four tentacles, two eyes. */
export const OCTOPUS = Object.freeze({
  viewBox: '0 0 32 32',
  head: 'M6 16.5C6 9 10.5 4 16 4s10 5 10 12.5C26 19.4 24.2 21 21.5 21h-11C7.8 21 6 19.4 6 16.5Z',
  // Each tentacle starts at its top point (the first M), which is the pivot it sways from.
  tentacles: Object.freeze([
    'M9.5 19.5C8.5 23 6.5 24.5 7 28',
    'M13.5 20.5C13.5 24 11.5 26 12.5 29',
    'M18.5 20.5C18.5 24 20.5 26 19.5 29',
    'M22.5 19.5C23.5 23 25.5 24.5 25 28',
  ]),
  eyes: Object.freeze([
    Object.freeze({ cx: 12.5, cy: 14, r: 1.9 }),
    Object.freeze({ cx: 19.5, cy: 14, r: 1.9 }),
  ]),
  // Paints shared by every character: outline/eyes and the accessory fill.
  ink: '#1f2333',
  accent: '#fff7d6',
  tentacleWidth: 2.6,
});

/** Per-agent body color and accessory path (same 32x32 viewBox). */
export const AVATARS = Object.freeze({
  // Clipboard on the right: triage at the door.
  'eminzo-intake': Object.freeze({ color: '#64748b', accessory: 'M23 8.5h8V20h-8zM25 7h4v3h-4z' }),
  // Pencil held up on the right.
  'eminzo-spec-writer': Object.freeze({ color: '#8b5cf6', accessory: 'M23.5 12.5l1-3.5 5.5-5.5 2 2-5.5 5.5z' }),
  // Hard hat: dome plus brim over the head.
  'eminzo-builder': Object.freeze({ color: '#e08a00', accessory: 'M8 9.5C8.5 5 11.8 2.5 16 2.5s7.5 2.5 8 7h2v1.8H6V9.5z' }),
  // Shield on the right side.
  'eminzo-review-security': Object.freeze({ color: '#e5484d', accessory: 'M27 11l4 1.5V16c0 2.5-1.8 4-4 5-2.2-1-4-2.5-4-5v-3.5z' }),
  // Speech bubble: user feedback.
  'eminzo-review-ux': Object.freeze({ color: '#d6409f', accessory: 'M22 1.5h9.5v6.5H26l-2.5 2.5V8H22z' }),
  // Bow tie under the head: looking sharp.
  'eminzo-review-ui': Object.freeze({ color: '#0d9488', accessory: 'M11.5 18.5l4.5 2 4.5-2v4.5l-4.5-2-4.5 2z' }),
  // Laptop on the right.
  'eminzo-review-code': Object.freeze({ color: '#3b82f6', accessory: 'M23 12.5h8v6h-8zM21.5 19.5H32V21H21.5z' }),
  // Check mark badge.
  'eminzo-approver': Object.freeze({ color: '#16a34a', accessory: 'M22.5 6l2-2 2.2 2.2L30.5 2l1.5 1.5-5.3 5.8z' }),
});

/**
 * Inline SVG octopus for a known agent, or '' for anything else. Decorative:
 * the caller hides it from assistive tech.
 * @param {unknown} name agent name from .claude/agents/
 * @returns {string}
 */
export function avatarSvg(name) {
  const agent = typeof name === 'string' && (name.startsWith('eminzo-') ? name : `eminzo-${name}`);
  if (!agent || !Object.hasOwn(AVATARS, agent)) return '';
  const { color, accessory } = AVATARS[agent];
  const { viewBox, head, tentacles, eyes, ink, accent, tentacleWidth } = OCTOPUS;
  const legs = tentacles
    .map((d) => `<path class="octo-tentacle" d="${d}" fill="none" stroke="${color}" stroke-width="${tentacleWidth}" stroke-linecap="round"/>`)
    .join('');
  const eyeDots = eyes
    .map(({ cx, cy, r }) => `<circle class="octo-eye" cx="${cx}" cy="${cy}" r="${r}" fill="${ink}"/>`)
    .join('');
  return `<svg class="octo" viewBox="${viewBox}" width="22" height="22" focusable="false">` +
    legs +
    `<path class="octo-head" d="${head}" fill="${color}" stroke="${ink}" stroke-width="0.8"/>` +
    eyeDots +
    `<path class="octo-accessory" d="${accessory}" fill="${accent}" stroke="${ink}" stroke-width="0.9" stroke-linejoin="round"/>` +
    '</svg>';
}
