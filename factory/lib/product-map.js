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
/** A line longer than this is a problem and is not read. */
export const MAX_LINE = 2000;
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
const validDate = (s) => Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** `- text [confirmed|assumed] (source: x)` as `{ text, basis, source }`, or null. Linear: no backtracking. */
function parseItem(line) {
  let body = line.slice(1).trim();
  let source = null;
  if (body.endsWith(')')) {
    const at = body.lastIndexOf('(source:');
    if (at >= 0) {
      source = body.slice(at + '(source:'.length, -1).trim();
      if (!source) return null;
      body = body.slice(0, at).trimEnd();
    }
  }
  const basis = body.endsWith('[confirmed]') ? 'confirmed' : body.endsWith('[assumed]') ? 'assumed' : null;
  if (!basis) return null;
  const text = body.slice(0, body.lastIndexOf('[')).trimEnd();
  return text ? { text, basis, source } : null;
}

/**
 * A product map from its markdown: `{ title, reviewed: { date, by } | null, areas: [{ name, items: [{ text, basis,
 * source }] }], problems }`. Never throws; `problems` says what is wrong. Lines over MAX_LINE are reported, not read.
 */
export function parseProductMap(text) {
  const out = { title: null, reviewed: null, areas: [], problems: [] };
  let area = null;
  let reviews = 0;
  String(text ?? '').replace(/^﻿/, '').split('\n').forEach((raw, i) => {
    if (raw.length > MAX_LINE) { out.problems.push(`line ${i + 1} is longer than ${MAX_LINE} characters`); return; }
    const line = raw.trim();
    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    if (h1 && out.title === null) {
      out.title = h1[1].replace(TITLE_PREFIX, '').trim();
    } else if (h2) {
      area = { name: h2[1].trim(), items: [] };
      out.areas.push(area);
    } else if (REVIEW_LINE.test(line)) {
      reviews += 1;
      const m = line.match(REVIEW);
      if (reviews > 1) { if (reviews === 2) out.problems.push('there is more than one Reviewed line'); } else if (m && validDate(m[1])) out.reviewed = { date: m[1], by: m[2] };
      else out.problems.push(`the Reviewed line is not "Reviewed: YYYY-MM-DD by <login>": "${line}"`);
    } else if (/^[-*]\s/.test(line)) {
      const item = parseItem(line);
      if (!area) out.problems.push(`a statement comes before any area: "${line}"`);
      else if (!item) out.problems.push(`statement is not "- text [confirmed]" or "- text [assumed]": "${line}"`);
      else area.items.push(item);
    }
  });
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
 * Where the map stands: `{ state, age_days, problems, summary }` (problems only the clock reveals). missing (no file), draft (never reviewed, empty or with
 * problems), reviewed, stale (reviewed more than STALE_AFTER_DAYS days ago). `parsed` is null when there is no file.
 */
export function mapStatus(parsed, { now = Date.now() } = {}) {
  if (!parsed) return { state: 'missing', age_days: null, problems: [], summary: `There is no product map yet. Create it in a terminal with /eminzo-product map; it is saved as ${MAP_PATH} only after a person agrees.` };
  const items = parsed.areas.flatMap((a) => a.items);
  const confirmed = items.filter((i) => i.basis === 'confirmed').length;
  const counts = `${parsed.areas.length} area${parsed.areas.length === 1 ? '' : 's'}, ${items.length} statement${items.length === 1 ? '' : 's'} (${confirmed} confirmed, ${items.length - confirmed} assumed)`;
  const future = parsed.reviewed && Date.parse(`${parsed.reviewed.date}T00:00:00Z`) > now + DAY;
  const extra = future ? ['the Reviewed date is in the future'] : [];
  const all = [...parsed.problems, ...extra];
  if (!parsed.reviewed || !items.length || all.length) {
    const why = all.length ? `it has ${all.length} problem${all.length === 1 ? '' : 's'}: ${all[0]}` : !parsed.reviewed ? 'no person has reviewed it yet' : 'it has no statements yet';
    return { state: 'draft', age_days: null, problems: extra, summary: `The product map is a draft: ${why}. ${counts}.` };
  }
  const age = Math.max(0, Math.floor((now - Date.parse(`${parsed.reviewed.date}T00:00:00Z`)) / DAY));
  const when = `Reviewed on ${parsed.reviewed.date} by ${parsed.reviewed.by}, ${age} day${age === 1 ? '' : 's'} ago`;
  if (age > STALE_AFTER_DAYS) return { state: 'stale', age_days: age, problems: [], summary: `${when}: older than ${STALE_AFTER_DAYS} days, so review it again before relying on it. ${counts}.` };
  return { state: 'reviewed', age_days: age, problems: [], summary: `${when}. ${counts}.` };
}
