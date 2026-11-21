// Hand-off: the texts of the issues cut from an approved brief. This module only BUILDS texts (and reads markers back);
// it never talks to GitHub. The Eminzo desktop creates the issues after the person confirms them.
//
//   brief issue        label `eminzo-brief`;        body = the approved brief text + a hidden line
//                      <!-- eminzo:brief-issue v1 hash=<64 hex, the approval hash> -->
//   deliverable issue  label `eminzo-deliverable`;  body in functional language + a hidden line
//                      <!-- eminzo:deliverable v1 brief=<n> id=<Dn> hash=<12 hex> est=<low>-<high>|none -->
//
// The label `factory` is never set here: the tech lead adds it when they accept a deliverable. Both builders go
// through the gate (`briefStatus(...).can_create_issues`). Markers are read in linear time: only unindented lines
// outside code fences, one per body, every field checked with a small anchored pattern.
import { fenceOf, briefStatus, canonicalBrief, stripEnd } from './brief-approval.js';
import { BRIEF_MARKER, SECTIONS, parseBrief } from './brief.js';
import { humanMinutes } from './state/estimate.js';
import { BRIEF_ISSUE_LABEL, DELIVERABLE_LABEL } from './labels.js';

// The label names live in labels.js, the one list `factory/bin/setup` creates from.
export { BRIEF_ISSUE_LABEL, DELIVERABLE_LABEL };
export const MAX_TITLE = 120;
/** GitHub rejects an issue body above 65 536 characters. */
export const MAX_BODY = 65_000;
const MAX_MARKER = 200;
const BRIEF_ISSUE_PREFIX = '<!-- eminzo:brief-issue ';
const DELIVERABLE_PREFIX = '<!-- eminzo:deliverable ';
const CLOSE = ' -->';

const CONTROL_OR_BIDI = /[\u0000-\u0008\u000B-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * A brief-derived string made inert for an issue: one line, no HTML comment syntax (removed until none is left, so
 * `<<!---->!--` cannot rebuild one), no control or bidirectional character, and a zero-width space after every `@` so
 * GitHub does not notify anyone. The brief contract already refuses these; this is the second wall.
 */
export function sanitize(value) {
  let s = String(value ?? '').replace(/[\t\r\n]+/g, ' ').replace(CONTROL_OR_BIDI, '');
  while (s.includes('<!--') || s.includes('-->')) s = s.split('<!--').join('').split('-->').join('');
  return s.replace(/@(?!\u200b)/g, '@\u200b');
}

/**
 * `sanitize` applied line by line, so the line breaks of a verbatim brief text stay: the same removals on every line, and
 * no line break between two lines can rebuild a comment or a mention.
 */
export function sanitizeBlock(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => sanitize(line)).join('\n');
}

const cap = (s) => {
  const chars = [...sanitize(s).replace(/\s+/g, ' ').trim()];
  return chars.length <= MAX_TITLE ? chars.join('') : `${chars.slice(0, MAX_TITLE - 1).join('')}…`;
};

/** Unindented lines that start with `prefix`, outside code fences: `{ lines: [{ index, text }], all }`. */
function candidates(body, prefix) {
  const all = String(body ?? '').replace(/^﻿/, '').split('\n');
  const found = [];
  let fence = null;
  all.forEach((raw, index) => {
    const line = stripEnd(raw);
    const f = fenceOf(line);
    if (fence) { if (f === fence) fence = null; return; }
    if (f) { fence = f; return; }
    if (line.startsWith(prefix)) found.push({ index, text: line });
  });
  return { found, all };
}

/** The tokens `key=value` of a marker line, in order, or null. */
function fields(line, prefix, keys) {
  if (line.length > MAX_MARKER || !line.endsWith(CLOSE)) return null;
  const tokens = line.slice(prefix.length, line.length - CLOSE.length).split(' ');
  if (tokens.length !== keys.length + 1 || tokens[0] !== 'v1') return null;
  const out = {};
  for (let i = 0; i < keys.length; i += 1) {
    const token = tokens[i + 1];
    const eq = token.indexOf('=');
    if (eq < 1 || token.slice(0, eq) !== keys[i]) return null;
    out[keys[i]] = token.slice(eq + 1);
  }
  return out;
}

const isHex = (s, n) => s.length === n && [...s].every((c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
const isDigits = (s, max) => s.length > 0 && s.length <= max && [...s].every((c) => c >= '0' && c <= '9');
const minutesOf = (s) => {
  const [whole, frac, extra] = s.split('.');
  if (extra !== undefined || !isDigits(whole, 7) || (frac !== undefined && !isDigits(frac, 1))) return null;
  return Number(s);
};

/** `{ hash }` of the one valid brief-issue marker in an issue body, or null (none, malformed, or more than one). */
export function parseBriefIssueMarker(body) {
  const { found } = candidates(body, BRIEF_ISSUE_PREFIX);
  if (found.length !== 1) return null;
  const f = fields(found[0].text, BRIEF_ISSUE_PREFIX, ['hash']);
  return f && isHex(f.hash, 64) ? { hash: f.hash } : null;
}

/** `{ brief, id, hash, est }` of the one valid deliverable marker in an issue body, or null. `est` is null for `none`. */
export function parseDeliverableMarker(body) {
  const { found } = candidates(body, DELIVERABLE_PREFIX);
  if (found.length !== 1) return null;
  const f = fields(found[0].text, DELIVERABLE_PREFIX, ['brief', 'id', 'hash', 'est']);
  if (!f || !isDigits(f.brief, 9) || f.brief[0] === '0' || !isHex(f.hash, 12)) return null;
  if (f.id[0] !== 'D' || !isDigits(f.id.slice(1), 4)) return null;
  let est = null;
  if (f.est !== 'none') {
    const parts = f.est.split('-');
    const low = parts.length === 2 ? minutesOf(parts[0]) : null;
    const high = parts.length === 2 ? minutesOf(parts[1]) : null;
    if (low === null || high === null || low > high) return null;
    est = { low_min: low, high_min: high };
  }
  return { brief: Number(f.brief), id: f.id, hash: f.hash, est };
}

/**
 * Whether the body of a brief issue still passes the approval check: its hidden line is removed, the rest must be
 * `approved`, and the hidden line must point at that approval. `{ valid, reason, approval, marker }`.
 */
export function briefIssueValidity(body) {
  const marker = parseBriefIssueMarker(body);
  if (!marker) return { valid: false, reason: 'The issue has no valid brief marker.', approval: null, marker: null };
  const { found, all } = candidates(body, BRIEF_ISSUE_PREFIX);
  const status = briefStatus(all.filter((_, i) => i !== found[0].index).join('\n'));
  if (!status.can_create_issues) return { valid: false, reason: status.reason, approval: status.approval, marker };
  if (status.approval.hash !== marker.hash) return { valid: false, reason: 'The issue points at another approval than the one it contains.', approval: status.approval, marker };
  return { valid: true, reason: status.reason, approval: status.approval, marker, text: all.filter((_, i) => i !== found[0].index).join('\n') };
}

/**
 * Why a brief text must not become an issue even though it is approved, or null: a comment line of ours that is not its own
 * approval line (it could forge a marker), or a code block that is never closed (it would swallow the hidden line).
 */
export function inertProblem(briefText) {
  const lines = String(briefText ?? '').split('\n').map(stripEnd);
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last -= 1;
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes('<!-- eminzo:') && line.trim() !== BRIEF_MARKER && !(i === last && line.startsWith('<!-- eminzo:approved '))) {
      return 'The brief has an eminzo comment line that is not its own approval line; remove it.';
    }
    const f = fenceOf(line);
    if (fence) { if (f === fence) fence = null; } else if (f) fence = f;
  }
  return fence ? 'The brief has a code block that is never closed; close it first.' : null;
}

/** The gate: the approval of a brief, or an Error with the gate's own sentence. */
function approvedOrThrow(briefText) {
  const status = briefStatus(briefText);
  if (!status.can_create_issues) throw new Error(status.reason);
  const problem = inertProblem(briefText);
  if (problem) throw new Error(problem);
  return status;
}

function checkBody(body) {
  if (body.length > MAX_BODY) throw new Error(`The issue text is longer than GitHub accepts (${MAX_BODY} characters); shorten the brief.`);
  return body;
}

/** The issue for an approved brief: `{ title, body, labels }`. Throws a readable Error unless the gate is open. */
export function briefIssueDraft(briefText) {
  const status = approvedOrThrow(briefText);
  const body = `${String(briefText).replace(/^﻿/, '').trimEnd()}\n\n${BRIEF_ISSUE_PREFIX}v1 hash=${status.approval.hash}${CLOSE}\n`;
  if (!briefIssueValidity(body).valid) throw new Error('The brief issue text does not pass its own approval check; approve the brief again.');
  return { title: briefTitleOf(briefText), body: checkBody(body), labels: [BRIEF_ISSUE_LABEL] };
}

/** The title the brief issue is created with (the title is not covered by the approval, so readers compare it). */
export function briefTitleOf(briefText) {
  return cap(`Brief: ${parseBrief(canonicalBrief(briefText)).title}`);
}

/** The lines a deliverable issue carries to say which brief issue it belongs to, in every language of the template. */
export const partOfLines = (n) => [...new Set(Object.values(TEXT).map((t) => t.part(n)))];

const TEXT = {
  en: { goal: 'Goal', delivers: 'What it delivers', criteria: 'Acceptance criteria', builds_on: 'Builds on', out_of_scope: 'Out of scope', definitions: 'Definitions', dependencies: 'Dependencies', questions: 'Open questions', estimate: 'For planning',
    size: (s) => `Size: ${s}.`, waits: 'Waits for', unblocks: 'Unblocks', none: 'Nothing: it can start right away.', unblocksNone: 'Nothing: no other deliverable waits for this one.',
    builtBy: 'Built by {ref}; it exists when you start.', doNotStart: 'Do not start until the deliverables above are merged.',
    buildsOn: '{ref}: builds on {ids} of this deliverable',
    deliveredBy: (ids, ref) => `${ids.join(', ')} ${ids.length === 1 ? 'is' : 'are'} delivered by ${ref}.`, seeBrief: (n, what) => `See the brief issue #${n} for ${what}`, part: (n) => `Part of #${n}`,
    range: (lo, hi, n) => `About ${lo} to ${hi} until ready for approval, from ${n} similar finished job${n === 1 ? '' : 's'}. It is a range, not a date.`, few: 'Too little history to estimate.' },
  es: { goal: 'Objetivo', delivers: 'Qué entrega', criteria: 'Criterios de aceptación', builds_on: 'Se apoya en', out_of_scope: 'Fuera de alcance', definitions: 'Definiciones', dependencies: 'Dependencias', questions: 'Preguntas abiertas', estimate: 'Para planificar',
    size: (s) => `Tamaño: ${s}.`, waits: 'Espera a', unblocks: 'Desbloquea a', none: 'Nada: puede empezar ya.', unblocksNone: 'Nada: ninguna otra entrega espera a esta.',
    builtBy: 'Lo construye {ref}; ya existe al empezar.', doNotStart: 'No empezar hasta que las entregas de arriba estén integradas.',
    buildsOn: '{ref}: se apoya en {ids} de esta entrega',
    deliveredBy: (ids, ref) => `${ids.join(', ')} ${ids.length === 1 ? 'lo entrega' : 'los entrega'} ${ref}.`, seeBrief: (n, what) => `Mira el issue del brief #${n} para ${what}`, part: (n) => `Parte de #${n}`,
    range: (lo, hi, n) => `Entre ${lo} y ${hi} hasta estar lista para aprobar, según ${n} trabajo${n === 1 ? '' : 's'} parecido${n === 1 ? '' : 's'} ya terminado${n === 1 ? '' : 's'}. Es un rango, no una fecha.`, few: 'Hay muy poco historial para estimar.' },
  pt: { goal: 'Objetivo', delivers: 'O que entrega', criteria: 'Critérios de aceitação', builds_on: 'Apoia-se em', out_of_scope: 'Fora do escopo', definitions: 'Definições', dependencies: 'Dependências', questions: 'Perguntas em aberto', estimate: 'Para planejamento',
    size: (s) => `Tamanho: ${s}.`, waits: 'Espera por', unblocks: 'Libera', none: 'Nada: pode começar já.', unblocksNone: 'Nada: nenhuma outra entrega espera por esta.',
    builtBy: 'Construído por {ref}; já existe ao começar.', doNotStart: 'Não começar até que as entregas acima estejam integradas.',
    buildsOn: '{ref}: apoia-se em {ids} desta entrega',
    deliveredBy: (ids, ref) => `${ids.join(', ')} ${ids.length === 1 ? 'é entregue' : 'são entregues'} por ${ref}.`, seeBrief: (n, what) => `Veja a issue do brief #${n} para ${what}`, part: (n) => `Parte de #${n}`,
    range: (lo, hi, n) => `Entre ${lo} e ${hi} até ficar pronta para aprovação, com base em ${n} trabalho${n === 1 ? '' : 's'} parecido${n === 1 ? '' : 's'} já concluído${n === 1 ? '' : 's'}. É uma faixa, não uma data.`, few: 'Pouco histórico para estimar.' },
};

/** An estimate rounded to one decimal so the marker always parses back; null when it does not fit (then: no estimate). */
function fitEstimate(est) {
  if (!est) return null;
  const round = (n) => Math.round(Number(n) * 10) / 10;
  const low = round(est.low_min);
  const high = round(est.high_min);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low || high > 9_999_999) return null;
  return { low_min: low, high_min: high, jobs: est.jobs };
}

/** Deliverables so that every `after` comes before the ones that wait for it; ties keep the brief's order. */
function dependencyOrder(deliverables) {
  const left = [...deliverables];
  const done = new Set();
  const out = [];
  while (left.length) {
    const at = left.findIndex((d) => d.after.every((a) => done.has(a)));
    if (at === -1) throw new Error('The deliverables wait for each other; the brief cannot be cut into issues.');
    const [next] = left.splice(at, 1);
    done.add(next.id);
    out.push(next);
  }
  return out;
}

const briefHeading = (key, lang) => SECTIONS.find((s) => s.key === key)[lang];
/**
 * The sections of a deliverable issue, in body order. A section is left out when it has nothing to say (Builds on without
 * `after`, Definitions or Open questions when the brief has none). Exported so a destination that renders its own text
 * (the desktop app, Jira) follows the same order instead of hardcoding it.
 */
export const DELIVERABLE_SECTION_KEYS = Object.freeze(['goal', 'delivers', 'criteria', 'builds_on', 'out_of_scope', 'definitions', 'dependencies', 'questions', 'estimate']);
/** The sections of a body that may be left out when it is too long, in the order they are left out. */
export const DELIVERABLE_DROPPABLE = Object.freeze(['questions', 'goal', 'definitions']);

/** How a deliverable is named in a line: `#11 (D3: Title)` once it has an issue, `D3: Title` before. */
const refText = (r) => (Number.isInteger(r.issue) ? `#${r.issue} (${r.id}: ${r.title})` : `${r.id}: ${r.title}`);

/** The first paragraph of a text: up to the first blank line. */
const firstParagraph = (text) => String(text).split(/\r?\n[ \t]*\r?\n/)[0].trim();

/**
 * The parts of one deliverable issue, as data: `[{ key, heading, parts }]` in `DELIVERABLE_SECTION_KEYS` order (see the
 * shape in docs/product-stage.md). `issues` maps a deliverable id to its issue number; `brief` is the parsed brief.
 */
function sectionsOf(brief, d, { t, lang, issues, estimate }) {
  const ref = (id) => {
    const other = brief.deliverables.find((x) => x.id === id);
    return { id, title: sanitize(other.title), issue: Number.isInteger(issues[id]) ? issues[id] : null };
  };
  const criteria = new Map(brief.criteria.map((c) => [c.id, c.text]));
  const ordered = dependencyOrder(brief.deliverables);
  const covered = new Set(d.covers);
  // Builds on: the criteria of each deliverable this one waits for (direct `after`), in full. `uses` narrows them.
  const buildsOn = ordered.filter((x) => d.after.includes(x.id)).map((dep) => {
    const own = (d.uses ?? []).filter((id) => dep.covers.includes(id));
    return { dep, ids: (own.length ? own : dep.covers).filter((id) => criteria.has(id)) };
  });
  const shown = new Set(buildsOn.flatMap((b) => b.ids));
  const others = [];
  for (const o of ordered.filter((x) => x.id !== d.id)) {
    const foreign = o.covers.filter((c) => !covered.has(c) && !shown.has(c) && criteria.has(c));
    if (foreign.length) others.push({ ...ref(o.id), criteria: foreign, format: t.deliveredBy(foreign, '{ref}') });
  }
  const verbatim = (key, label) => (brief.sections[key] === undefined ? [] : [{ kind: 'text', ...(label ? { label } : {}), text: sanitizeBlock(brief.sections[key]) }]);
  const out = [];
  const add = (key, parts) => { if (parts.length) out.push({ key, heading: t[key], parts }); };
  add('goal', [...verbatim('value'), ...(brief.sections.problem === undefined ? [] : [{ kind: 'text', label: briefHeading('problem', lang), text: sanitizeBlock(firstParagraph(brief.sections.problem)) }])]);
  add('delivers', [{ kind: 'text', text: sanitize(d.title) }]);
  add('criteria', [{ kind: 'criteria', items: d.covers.map((id) => ({ id, text: sanitize(criteria.get(id)) })) }]);
  add('builds_on', buildsOn.flatMap(({ dep, ids }) => [
    { kind: 'refs', label: null, none: null, format: t.builtBy, items: [ref(dep.id)] },
    { kind: 'criteria', items: ids.map((id) => ({ id, text: sanitize(criteria.get(id)) })) },
  ]));
  add('out_of_scope', [...verbatim('out_of_scope'), ...(others.length ? [{ kind: 'refs', label: null, none: null, items: others }] : [])]);
  add('definitions', verbatim('definitions'));
  const unblocks = ordered.filter((x) => x.after.includes(d.id)).map((x) => {
    const own = (x.uses ?? []).filter((id) => covered.has(id));
    return { ...ref(x.id), uses: own.length ? own : [...d.covers] };
  });
  const waits = d.after.map(ref);
  add('dependencies', [
    { kind: 'refs', label: t.waits, none: waits.length ? null : t.none, items: waits },
    ...(waits.length ? [{ kind: 'text', text: t.doNotStart }] : []),
    { kind: 'refs', label: t.unblocks, none: unblocks.length ? null : t.unblocksNone, uses_format: t.buildsOn, items: unblocks },
  ]);
  if (/\?/.test(brief.sections.questions ?? '')) add('questions', verbatim('questions'));
  add('estimate', [{ kind: 'text', text: t.size(d.size) }, { kind: 'text', text: estimate ? t.range(humanMinutes(estimate.low_min), humanMinutes(estimate.high_min), estimate.jobs) : t.few }]);
  return out;
}

/** A section replaced by one line that points at the brief issue. */
function briefRef(section, { t, briefIssue }) {
  return { key: section.key, heading: section.heading, parts: [{ kind: 'brief_ref', issue: briefIssue, text: t.seeBrief(briefIssue, section.heading) }] };
}

/**
 * The lines of a text from the brief inside a block quote. A quoted line can never be a `Part of #n` line, start a marker
 * or a heading, and a code fence opened inside it ends with the quote, so it cannot reach another section.
 */
const quoted = (text) => text.split('\n').map((l) => (l === '' ? '>' : `> ${l}`));

/** Sections whose texts are the factory's own sentences, not brief text: they are not quoted. */
const PLAIN_SECTIONS = new Set(['estimate', 'dependencies']);

/** The markdown of a list of sections: every section is a `## ` heading, its parts, and a blank line. */
function renderSections(sections, t) {
  const lines = [];
  for (const section of sections) {
    lines.push(`## ${section.heading}`, '');
    for (const part of section.parts) {
      if (part.kind === 'brief_ref') { lines.push(part.text, ''); continue; }
      if (part.kind === 'criteria') {
        // Under Builds on the criteria already exist: a plain list, not a checklist to tick.
        lines.push(...part.items.map((i) => (section.key === 'builds_on' ? `- ${i.id}: ${i.text}` : `- [ ] ${i.id}: ${i.text}`)), '');
        continue;
      }
      if (part.kind === 'refs') {
        if (part.label) lines.push(`### ${part.label}`, '');
        // Every sentence comes from the data: `format` (part or item) and `uses_format`, with {ref} and {ids} filled in.
        const fill = (template, i) => template.replace(/\{(ref|ids)\}/g, (_, k) => (k === 'ref' ? refText(i) : (i.uses ?? []).join(', ')));
        if (part.format) lines.push(...part.items.map((i) => fill(part.format, i)), '');
        else if (part.items.length) lines.push(...part.items.map((i) => `- ${i.format ? fill(i.format, i) : part.uses_format && i.uses?.length ? fill(part.uses_format, i) : refText(i)}`), '');
        else if (part.none) lines.push(part.none, '');
        continue;
      }
      if (part.label) lines.push(`### ${part.label}`, '');
      lines.push(...(PLAIN_SECTIONS.has(section.key) ? [part.text] : quoted(part.text)), '');
    }
  }
  return lines;
}

/** The drafts of a brief's deliverables with their sections, before any body: `{ d, estimate, sections }[]`. */
function plan(briefText, { estimates = {}, issues = {}, briefIssue = null } = {}) {
  const status = approvedOrThrow(briefText);
  const brief = parseBrief(canonicalBrief(briefText));
  const lang = TEXT[brief.language] ? brief.language : 'en';
  const t = TEXT[lang];
  return {
    status, t, lang,
    items: dependencyOrder(brief.deliverables).map((d) => {
      const estimate = fitEstimate(estimates[d.id]);
      return { d, estimate, sections: sectionsOf(brief, d, { t, lang, issues, estimate, briefIssue }) };
    }),
  };
}

/**
 * One issue draft per deliverable of an approved brief, in dependency order:
 * `{ id, title, body, labels, after, sections }`. Throws a readable Error unless the gate is open.
 * The body is the sections rendered as markdown (the brief's texts in block quotes), then the `Part of #n` line and the
 * hidden marker. When it would be longer than GitHub accepts, the optional sections (Open questions, Goal, Definitions,
 * see DELIVERABLE_DROPPABLE) are replaced, whole and in that order, by one line that points at the brief issue.
 * @param {string} briefText the approved brief
 * @param {{ briefIssue: number, estimates?: Record<string, { low_min: number, high_min: number, jobs: number } | null>, issues?: Record<string, number> }} options
 *   `estimates` by deliverable id (the range shown at creation time); `issues` the issue number of deliverables already created.
 */
export function deliverableIssueDrafts(briefText, { briefIssue, estimates = {}, issues = {} } = {}) {
  approvedOrThrow(briefText);
  if (!Number.isInteger(briefIssue) || briefIssue < 1) throw new Error('The deliverable issues need the brief issue number (a positive integer).');
  const { status, t, lang, items } = plan(briefText, { estimates, issues, briefIssue });
  const hash = status.approval.hash.slice(0, 12);
  return items.map(({ d, estimate, sections: full }) => {
    const marker = `${DELIVERABLE_PREFIX}v1 brief=${briefIssue} id=${d.id} hash=${hash} est=${estimate ? `${estimate.low_min}-${estimate.high_min}` : 'none'}${CLOSE}`;
    const render = (list) => [...renderSections(list, t), t.part(briefIssue), '', marker, ''].join('\n');
    let sections = full;
    let body = render(sections);
    for (const key of DELIVERABLE_DROPPABLE) {
      if (body.length <= MAX_BODY) break;
      if (!sections.some((s) => s.key === key)) continue;
      sections = sections.map((s) => (s.key === key ? briefRef(s, { t, briefIssue }) : s));
      body = render(sections);
    }
    checkBody(body);
    const expected = { brief: briefIssue, id: d.id, hash, est: estimate ? { low_min: estimate.low_min, high_min: estimate.high_min } : null };
    const found = parseDeliverableMarker(body);
    const partLines = body.split('\n').filter((l) => l === t.part(briefIssue)).length;
    if (!found || JSON.stringify(found) !== JSON.stringify(expected) || partLines !== 1) throw new Error('The deliverable issue text does not pass its own check (marker and Part of line); the brief text cannot be cut into issues.');
    return { id: d.id, title: cap(d.title), body, labels: [DELIVERABLE_LABEL], after: [...d.after], sections };
  });
}

/**
 * The same content as `deliverableIssueDrafts`, as sections only, for a destination that has no GitHub issue numbers
 * (every reference to another deliverable has `issue: null`). No body, marker or `Part of` line, and nothing is dropped:
 * each destination applies its own limit. `[{ id, title, labels, after, sections }]`, in dependency order.
 */
export function deliverableSections(briefText, { estimates = {} } = {}) {
  const { items } = plan(briefText, { estimates });
  return items.map(({ d, sections }) => ({ id: d.id, title: cap(d.title), labels: [DELIVERABLE_LABEL], after: [...d.after], sections }));
}
