// The functional map of the product: how it works today, in the words of the people who use it, kept in a reviewed
// markdown file (`factory/product-map.md`) so "how does it work today" has a source better than a guess.
//
//   # Product map: <title>
//   Reviewed: YYYY-MM-DD by <github login>
//   ## <area>                      (something a person can do or see)
//   - <statement> [confirmed]      (confirmed: a person checked it in the product)
//   - <statement> [assumed] (source: <path or screen>)
//
// The labels `confirmed` and `assumed` and the word `source` stay in English in every language; the title prefix,
// the review word and the area headings follow the repository's language. Pure: no I/O, no clock (the caller passes
// `now`). Nothing in the engine writes the file.

/** A map not reviewed for more than this many days is stale. */
export const STALE_AFTER_DAYS = 90;
export const MAP_PATH = 'factory/product-map.md';

const DAY = 86_400_000;
const LANGS = ['en', 'es', 'pt'];
const WORDS = Object.freeze({
  en: { prefix: 'Product map', reviewed: 'Reviewed', by: 'by', area: 'What a person can do or see', placeholder: '_To complete._', hint: 'Set the Reviewed line after a person has checked this map.' },
  es: { prefix: 'Mapa del producto', reviewed: 'Revisado', by: 'por', area: 'Qué puede hacer o ver una persona', placeholder: '_Por completar._', hint: 'Completá la línea Revisado cuando una persona haya comprobado este mapa.' },
  pt: { prefix: 'Mapa do produto', reviewed: 'Revisado', by: 'por', area: 'O que uma pessoa pode fazer ou ver', placeholder: '_A completar._', hint: 'Preencha a linha Revisado depois que uma pessoa conferir este mapa.' },
});

const TITLE_PREFIX = /^(?:product map|mapa del producto|mapa do produto):\s*/i;
const REVIEW_LINE = /^(?:reviewed|revisado)\s*:/i;
const REVIEW = /^(?:reviewed|revisado)\s*:\s*(\d{4}-\d{2}-\d{2})\s+(?:by|por)\s+([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\s*$/i;
const ITEM = /^[-*]\s+(\S.*?)\s*\[(confirmed|assumed)\](?:\s*\(source:\s*(.+?)\s*\))?\s*$/;
const validDate = (s) => Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/**
 * A product map from its markdown: `{ title, reviewed: { date, by } | null, areas: [{ name, items: [{ text, basis,
 * source }] }], problems }`. Never throws; `problems` says what is wrong.
 */
export function parseProductMap(text) {
  const out = { title: null, reviewed: null, areas: [], problems: [] };
  let area = null;
  for (const raw of String(text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    if (h1 && out.title === null) {
      out.title = h1[1].replace(TITLE_PREFIX, '').trim();
    } else if (h2) {
      area = { name: h2[1].trim(), items: [] };
      out.areas.push(area);
    } else if (REVIEW_LINE.test(line)) {
      const m = line.match(REVIEW);
      if (m && validDate(m[1])) out.reviewed = { date: m[1], by: m[2] };
      else out.problems.push(`the Reviewed line is not "Reviewed: YYYY-MM-DD by <login>": "${line}"`);
    } else if (/^[-*]\s/.test(line)) {
      const m = line.match(ITEM);
      if (!area) out.problems.push(`a statement comes before any area: "${line}"`);
      else if (!m) out.problems.push(`statement is not "- text [confirmed]" or "- text [assumed]": "${line}"`);
      else area.items.push({ text: m[1], basis: m[2], source: m[3] ?? null });
    }
  }
  if (!out.title) out.problems.push('the map has no title');
  for (const a of out.areas) if (!a.items.length) out.problems.push(`area "${a.name}" has no items`);
  return out;
}

/** A map to fill in, in `language` (en, es, pt). It parses without problems and is a draft until it is reviewed. */
export function productMapTemplate({ title = '', language = 'en' } = {}) {
  const w = WORDS[LANGS.includes(language) ? language : 'en'];
  return [`# ${w.prefix}: ${title}`.trimEnd(), '', `<!-- ${w.hint} Format: "${w.reviewed}: YYYY-MM-DD ${w.by} <login>". -->`, '', `## ${w.area}`, `- ${w.placeholder} [assumed]`, ''].join('\n');
}

/**
 * Where the map stands: `{ state, age_days, summary }`. missing (no file), draft (never reviewed, empty or with
 * problems), reviewed, stale (reviewed more than STALE_AFTER_DAYS days ago). `parsed` is null when there is no file.
 */
export function mapStatus(parsed, { now = Date.now() } = {}) {
  if (!parsed) return { state: 'missing', age_days: null, summary: `There is no product map yet. Create it in a terminal with /eminzo-product map; it is saved as ${MAP_PATH} only after a person agrees.` };
  const items = parsed.areas.flatMap((a) => a.items);
  const confirmed = items.filter((i) => i.basis === 'confirmed').length;
  const counts = `${parsed.areas.length} area${parsed.areas.length === 1 ? '' : 's'}, ${items.length} statement${items.length === 1 ? '' : 's'} (${confirmed} confirmed, ${items.length - confirmed} assumed)`;
  if (!parsed.reviewed || !items.length || parsed.problems.length) {
    const why = parsed.problems.length ? `it has ${parsed.problems.length} problem${parsed.problems.length === 1 ? '' : 's'}: ${parsed.problems[0]}` : !parsed.reviewed ? 'no person has reviewed it yet' : 'it has no statements yet';
    return { state: 'draft', age_days: null, summary: `The product map is a draft: ${why}. ${counts}.` };
  }
  const age = Math.max(0, Math.floor((now - Date.parse(`${parsed.reviewed.date}T00:00:00Z`)) / DAY));
  const when = `Reviewed on ${parsed.reviewed.date} by ${parsed.reviewed.by}, ${age} day${age === 1 ? '' : 's'} ago`;
  if (age > STALE_AFTER_DAYS) return { state: 'stale', age_days: age, summary: `${when}: older than ${STALE_AFTER_DAYS} days, so review it again before relying on it. ${counts}.` };
  return { state: 'reviewed', age_days: age, summary: `${when}. ${counts}.` };
}
