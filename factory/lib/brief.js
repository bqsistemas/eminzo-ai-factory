// The brief contract: what a Product Lead approves before any issue exists, in functional language.
//
//   <!-- eminzo:brief v1 -->
//   # Brief: <title>
//   ## Problem / For whom / Expected value / How it works today / Scope / Out of scope
//   ## Acceptance criteria      - BC-1: <a behaviour a person can check>
//   ## Open questions           (optional)
//   ## Deliverables             - D1: <title> | size: s | risk: low | covers: BC-1, BC-2 | after: D2
//
// Headings may be in English, Spanish or Portuguese (the repository's `language`); keys inside a deliverable line
// stay in English so every language parses the same. Criteria ids (BC-n) are stable: each issue cut from a brief
// names the criteria it covers. Pure: no I/O.

export const BRIEF_MARKER = '<!-- eminzo:brief v1 -->';
export const SIZES = Object.freeze(['xs', 's', 'm', 'l']);
export const RISKS = Object.freeze(['low', 'medium', 'high']);

/** The sections, in order, with their headings per language. */
export const SECTIONS = Object.freeze([
  { key: 'problem', required: true, en: 'Problem', es: 'Problema', pt: 'Problema' },
  { key: 'audience', required: true, en: 'For whom', es: 'Para quién', pt: 'Para quem' },
  { key: 'value', required: true, en: 'Expected value', es: 'Valor esperado', pt: 'Valor esperado' },
  { key: 'today', required: true, en: 'How it works today', es: 'Cómo funciona hoy', pt: 'Como funciona hoje' },
  { key: 'scope', required: true, en: 'Scope', es: 'Alcance', pt: 'Escopo' },
  { key: 'out_of_scope', required: true, en: 'Out of scope', es: 'Fuera de alcance', pt: 'Fora do escopo' },
  { key: 'acceptance', required: true, en: 'Acceptance criteria', es: 'Criterios de aceptación', pt: 'Critérios de aceitação' },
  { key: 'questions', required: false, en: 'Open questions', es: 'Preguntas abiertas', pt: 'Perguntas em aberto' },
  { key: 'deliverables', required: true, en: 'Deliverables', es: 'Entregas', pt: 'Entregas' },
].map((s) => Object.freeze(s)));

const LANGS = ['en', 'es', 'pt'];
const PLACEHOLDER = Object.freeze({ en: '_To complete._', es: '_Por completar._', pt: '_A completar._' });
const PLACEHOLDERS = new Set(Object.values(PLACEHOLDER));
const CRITERION = /^-\s*(BC-\d+):\s*(\S.*)$/;
const DELIVERABLE = /^-\s*(D\d+):\s*(.+)$/;

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const BIDI = /[؜‎‏‪-‮⁦-⁩]/;
// C1 controls, line and paragraph separators, soft hyphen, word joiner, zero-width characters and a byte order mark.
const INVISIBLE = /[\u0080-\u009F\u00AD\u200B-\u200D\u2028\u2029\u2060\uFEFF]/;
// GitHub notifies for `@login` unless a letter, digit or underscore comes right before the `@` (an e-mail address).
const MENTION = /(?:^|[^A-Za-z0-9_])@[A-Za-z0-9]/;
const ISO_AT = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})';
/** A whole line that is an approval marker; captures hash, login and date. brief-approval.js uses the same one. */
export const APPROVAL_PATTERN = new RegExp(`^<!-- eminzo:approved sha256=([0-9a-f]{64}) by=([A-Za-z0-9][A-Za-z0-9-]{0,38}) at=(${ISO_AT}) -->$`);
export const APPROVAL_ISO_AT = ISO_AT;

/** The fence character a line opens or closes (up to 3 spaces in), or null. */
function fenceChar(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i += 1;
  const ch = line[i];
  return i <= 3 && (ch === '`' || ch === '~') && line[i + 1] === ch && line[i + 2] === ch ? ch : null;
}

/** The line with its inline code spans blanked: a backtick run closes at the next run of the same length (none: literal). */
function withoutCodeSpans(line) {
  const runs = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== '`') continue;
    let end = i;
    while (line[end] === '`') end += 1;
    runs.push({ start: i, end });
    i = end - 1;
  }
  if (!runs.length) return line;
  const next = new Array(runs.length).fill(-1);
  const lastOfLength = new Map();
  for (let k = runs.length - 1; k >= 0; k -= 1) {
    const length = runs[k].end - runs[k].start;
    next[k] = lastOfLength.get(length) ?? -1;
    lastOfLength.set(length, k);
  }
  let out = '';
  let from = 0;
  for (let k = 0; k < runs.length; k += 1) {
    if (runs[k].start < from) continue;
    if (next[k] === -1) continue;
    out += `${line.slice(from, runs[k].start)} `;
    from = runs[next[k]].end;
  }
  return out + line.slice(from);
}

const APPROVAL_OPEN = '<!-- eminzo:approved sha256=';

/** What in the raw lines would misbehave once copied into an issue: comments, invisible, control or bidi characters, mentions. */
function hazardsOf(lines) {
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last -= 1;
  const found = new Set();
  let fence = null;
  lines.forEach((line, i) => {
    const text = line.trim();
    const own = text === BRIEF_MARKER || (i === last && line.startsWith(APPROVAL_OPEN) && line.length <= 200 && APPROVAL_PATTERN.test(line.replace(/[ \t\r]+$/, '')));
    if (!own && line.includes('<!--')) found.add('comments');
    if (CONTROL.test(line)) found.add('control');
    if (BIDI.test(line)) found.add('bidi');
    if (INVISIBLE.test(line)) found.add('invisible');
    const f = fenceChar(line);
    if (fence) { if (f === fence) fence = null; return; }
    if (f) { fence = f; return; }
    if (!own && MENTION.test(withoutCodeSpans(line))) found.add('mentions');
  });
  return [...found];
}

const normalize = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[:.]+$/, '').replace(/\s+/g, ' ').trim();
const HEADINGS = new Map(SECTIONS.flatMap((s) => LANGS.map((lang) => [`${lang}:${normalize(s[lang])}`, s.key])));
const trimBlock = (lines) => lines.join('\n').replace(/^\s*\n/, '').replace(/\n\s*$/, '').trim();
const list = (value) => (value === undefined || value.trim() === '-' ? [] : value.split(',').map((v) => v.trim()).filter(Boolean));
const label = (key) => SECTIONS.find((s) => s.key === key).en;

/** The section key and languages a heading matches, or null. */
function matchHeading(text) {
  const n = normalize(text);
  const langs = LANGS.filter((lang) => HEADINGS.has(`${lang}:${n}`));
  return langs.length ? { key: HEADINGS.get(`${langs[0]}:${n}`), langs } : null;
}

function parseDeliverable(id, rest) {
  const [title, ...fields] = rest.split('|').map((p) => p.trim());
  const values = {};
  for (const field of fields) {
    const m = field.match(/^([a-z_]+)\s*:\s*(.*)$/i);
    if (m) values[m[1].toLowerCase()] = m[2].trim();
  }
  return {
    id,
    title,
    size: values.size ? values.size.toLowerCase() : null,
    risk: values.risk ? values.risk.toLowerCase() : null,
    covers: list(values.covers),
    after: list(values.after),
  };
}

/**
 * A brief from its markdown: `{ title, language, marker, sections, criteria, deliverables, badCriteria,
 * badDeliverables, unknown }`. Never throws; validateBrief says what is wrong.
 */
export function parseBrief(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const out = { title: null, language: 'en', marker: lines.some((l) => l.trim() === BRIEF_MARKER), sections: {}, criteria: [], deliverables: [], badCriteria: [], badDeliverables: [], unknown: [], hazards: hazardsOf(lines) };
  const votes = { en: 0, es: 0, pt: 0 };
  let current = null;
  const blocks = {};
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (h1 && out.title === null) {
      out.title = h1[1].replace(/^brief:\s*/i, '').trim();
      continue;
    }
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      const match = matchHeading(h2[1]);
      if (match) {
        current = match.key;
        for (const lang of match.langs) votes[lang] += 1;
        blocks[current] = [];
      } else {
        current = null;
        out.unknown.push(h2[1]);
      }
      continue;
    }
    if (current) blocks[current].push(line);
  }
  out.language = LANGS.reduce((best, lang) => (votes[lang] > votes[best] ? lang : best), 'en');
  for (const [key, block] of Object.entries(blocks)) {
    const content = trimBlock(block);
    if (key === 'acceptance' || key === 'deliverables') {
      for (const raw of content.split('\n').map((l) => l.trim()).filter((l) => l && !PLACEHOLDERS.has(l))) {
        if (key === 'acceptance') {
          const m = raw.match(CRITERION);
          if (m) out.criteria.push({ id: m[1], text: m[2].trim() });
          else out.badCriteria.push(raw);
        } else {
          const m = raw.match(DELIVERABLE);
          if (m) out.deliverables.push(parseDeliverable(m[1], m[2]));
          else out.badDeliverables.push(raw);
        }
      }
    } else if (content && !PLACEHOLDERS.has(content)) {
      out.sections[key] = content;
    }
  }
  return out;
}

/** The cycles among deliverables' `after` links, each as a sorted list of ids. */
function cycles(deliverables) {
  const next = new Map(deliverables.map((d) => [d.id, d.after.filter((a) => a !== d.id)]));
  const found = new Set();
  const visit = (id, path) => {
    const at = path.indexOf(id);
    if (at !== -1) {
      found.add([...path.slice(at)].sort().join(', '));
      return;
    }
    for (const n of next.get(id) ?? []) visit(n, [...path, id]);
  };
  for (const d of deliverables) visit(d.id, []);
  return [...found].sort();
}

/** `{ ok, problems, warnings }`: problems block approval, warnings deserve a second look. */
export function validateBrief(brief) {
  const problems = [];
  const warnings = [];
  if (!brief.title) problems.push('the brief has no title');
  for (const s of SECTIONS.filter((x) => x.required)) {
    const empty = s.key === 'acceptance' ? !brief.criteria.length && !brief.badCriteria.length
      : s.key === 'deliverables' ? !brief.deliverables.length && !brief.badDeliverables.length
        : !brief.sections[s.key];
    if (empty) problems.push(`section "${s.en}" is missing or empty`);
  }
  const criteria = new Set();
  for (const c of brief.criteria) {
    if (criteria.has(c.id)) problems.push(`acceptance criterion ${c.id} appears twice`);
    criteria.add(c.id);
  }
  for (const raw of brief.badCriteria) problems.push(`acceptance criterion line is not "- BC-n: text": "${raw}"`);
  const ids = new Set();
  for (const d of brief.deliverables) {
    if (ids.has(d.id)) problems.push(`deliverable ${d.id} appears twice`);
    ids.add(d.id);
  }
  for (const d of brief.deliverables) {
    if (!SIZES.includes(d.size)) problems.push(`deliverable ${d.id}: size must be ${SIZES.slice(0, -1).join(', ')} or ${SIZES.at(-1)}`);
    if (!RISKS.includes(d.risk)) problems.push(`deliverable ${d.id}: risk must be ${RISKS.slice(0, -1).join(', ')} or ${RISKS.at(-1)}`);
    if (!d.title) problems.push(`deliverable ${d.id} has no title`);
    if (!d.covers.length) problems.push(`deliverable ${d.id}: covers no acceptance criterion`);
    for (const c of d.covers) if (!criteria.has(c)) problems.push(`deliverable ${d.id}: covers ${c}, which is not an acceptance criterion`);
    for (const a of d.after) {
      if (a === d.id) problems.push(`deliverable ${d.id} waits for itself`);
      else if (!ids.has(a)) problems.push(`deliverable ${d.id}: waits for ${a}, which is not a deliverable`);
    }
  }
  for (const cycle of cycles(brief.deliverables)) problems.push(`deliverables ${cycle} wait for each other`);
  for (const raw of brief.badDeliverables) problems.push(`deliverable line is not "- Dn: title | size: s | risk: low | covers: BC-1": "${raw}"`);
  for (const heading of brief.unknown) problems.push(`unknown section "${heading}"`);
  const hazards = brief.hazards ?? [];
  if (hazards.includes('comments')) problems.push('HTML comments are not allowed in a brief: remove "<!--"');
  if (hazards.includes('control')) problems.push('Control characters are not allowed in a brief');
  if (hazards.includes('bidi')) problems.push('Bidirectional control characters are not allowed in a brief');
  if (hazards.includes('invisible')) problems.push('Invisible characters are not allowed in a brief');
  if (hazards.includes('mentions')) problems.push('Remove the @ before a name (or put it in backticks): GitHub would notify that person when the issues are created');

  const covered = new Set(brief.deliverables.flatMap((d) => d.covers));
  for (const c of brief.criteria) if (!covered.has(c.id)) warnings.push(`acceptance criterion ${c.id} is not covered by any deliverable`);
  for (const d of brief.deliverables) if (d.size === 'l') warnings.push(`deliverable ${d.id} is large: consider splitting it`);
  return { ok: problems.length === 0, problems, warnings };
}

/** The markdown of a brief in `lang` (en, es, pt). Empty required sections get a placeholder to complete. */
export function renderBrief(brief, lang = 'en') {
  const language = LANGS.includes(lang) ? lang : 'en';
  const out = [BRIEF_MARKER, `# Brief: ${brief.title ?? ''}`.trimEnd(), ''];
  for (const s of SECTIONS) {
    let body;
    if (s.key === 'acceptance') {
      body = (brief.criteria ?? []).map((c) => `- ${c.id}: ${c.text}`).join('\n');
    } else if (s.key === 'deliverables') {
      body = (brief.deliverables ?? []).map((d) => [
        `- ${d.id}: ${d.title}`, `size: ${d.size}`, `risk: ${d.risk}`, `covers: ${d.covers.join(', ')}`, ...(d.after?.length ? [`after: ${d.after.join(', ')}`] : []),
      ].join(' | ')).join('\n');
    } else {
      body = brief.sections?.[s.key] ?? '';
    }
    if (!body && !s.required) continue;
    out.push(`## ${s[language]}`, '', body || PLACEHOLDER[language], '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** The `##` sections of a markdown document, each with its `###` subsections. */
function outline(text) {
  const doc = { title: null, sections: [] };
  let section = null;
  let sub = null;
  for (const line of String(text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h1 && doc.title === null) doc.title = h1[1].trim();
    else if (h2) {
      section = { heading: h2[1], lines: [], subs: [] };
      sub = null;
      doc.sections.push(section);
    } else if (h3 && section) {
      sub = { heading: h3[1], lines: [] };
      section.subs.push(sub);
    } else if (sub) sub.lines.push(line);
    else if (section) section.lines.push(line);
  }
  return doc;
}

/** The nested bullets under a `* **<label>:**` line of an Elephant-Goldfish Goals vs. Non-Goals section. */
function egmList(lines, labelPattern) {
  const start = lines.findIndex((l) => labelPattern.test(l));
  if (start === -1) return '';
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\*\s+\*\*/.test(line)) break;
    const m = line.match(/^\s+[-*]\s+(.*)$/);
    if (m) items.push(`- ${m[1].trim()}`);
  }
  return items.join('\n');
}

/**
 * An Eminzo brief from an Elephant-Goldfish concepts_brief.md (written by /egm-brainstorm): its Overview becomes the
 * problem, its In-Scope Goals and Out-of-Scope Non-Goals the scope, its critical objections the open questions.
 * `missing` lists the required sections the Product Lead still has to write; `carried` names the parts that were not
 * mapped, so nothing is dropped silently.
 */
export function fromEgmConcepts(text) {
  const doc = outline(text);
  const sections = {};
  const carried = [];
  const carriedSubs = [];
  for (const s of doc.sections) {
    const h = normalize(s.heading);
    if (h.startsWith('overview')) {
      const body = trimBlock(s.lines);
      if (body) sections.problem = body;
    } else if (h.startsWith('goals vs')) {
      const scope = egmList(s.lines, /^\*\s+\*\*In-Scope Goals:?\*\*/i);
      const out = egmList(s.lines, /^\*\s+\*\*Out-of-Scope Non-Goals:?\*\*/i);
      if (scope) sections.scope = scope;
      if (out) sections.out_of_scope = out;
    } else if (h.startsWith('analysis')) {
      for (const sub of s.subs) {
        if (normalize(sub.heading).startsWith('critical objections')) {
          const body = trimBlock(sub.lines);
          if (body) sections.questions = body;
        } else carriedSubs.push(sub.heading);
      }
    } else carried.push(s.heading);
  }
  const brief = { title: doc.title, sections, criteria: [], deliverables: [] };
  const filled = new Set(Object.keys(sections));
  const missing = SECTIONS.filter((s) => s.required && !filled.has(s.key)).map((s) => s.key);
  return { brief, missing, carried: [...carried, ...carriedSubs], labels: missing.map(label) };
}
