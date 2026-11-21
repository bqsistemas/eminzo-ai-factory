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

/** The opening or closing fence run of a line (up to 3 spaces in): `{ ch, len, info }`, or null. */
function fenceRun(line) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  return m ? { ch: m[1][0], len: m[1].length, info: m[2].trim() } : null;
}

/** Which code fence is still open after `lines`, in the two readings that matter: ours (`fenceOf`) and CommonMark's. */
function openFences(lines) {
  let ours = null;
  let common = null;
  for (const raw of lines) {
    const line = stripEnd(raw);
    const f = fenceOf(line);
    if (ours) { if (f === ours) ours = null; } else if (f) ours = f;
    const run = fenceRun(line);
    if (common) { if (run && run.ch === common.ch && run.len >= common.len && run.info === '') common = null; }
    else if (run && !(run.ch === '`' && run.info.includes('`'))) common = { ch: run.ch, len: run.len };
  }
  return { ours, common };
}

/**
 * A multi-line brief-derived text made inert: every line goes through `sanitize`, the line breaks stay, and a code fence the
 * text leaves open is closed (same character, at least as long), so what follows the block is never swallowed by it.
 * Throws when the fences cannot be balanced in both readings.
 */
export function block(value) {
  const lines = String(value ?? '').split('\n').map(sanitize);
  for (let tries = 0; tries < 3; tries += 1) {
    const { ours, common } = openFences(lines);
    if (!ours && !common) return lines.join('\n');
    lines.push(common ? common.ch.repeat(Math.max(3, common.len)) : ours.repeat(3));
  }
  throw new Error('The brief has a code block that cannot be copied into an issue as it is; close it first.');
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

const heading = (lang, key) => SECTIONS.find((s) => s.key === key)[lang];

const TEXT = {
  en: { context: 'Context', delivers: 'What it delivers', criteria: 'Acceptance criteria', out_of_scope: 'Out of scope', today: 'How it works today', dependencies: 'Dependencies', questions: 'Open questions', estimate: 'Size, risk and estimate',
    size: (s, r) => `Size: ${s}. Risk: ${r}.`, waits: 'Waits for', unblocks: 'Unblocks', none: 'Nothing: it can start right away.', others: 'Covered by other deliverables:', part: (n) => `Part of #${n}`,
    see: (n, h) => `See brief issue #${n} for "${h}".`,
    range: (lo, hi, n) => `About ${lo} to ${hi} until ready for approval, from ${n} similar finished job${n === 1 ? '' : 's'}. It is a range, not a date.`, few: 'Too little history to estimate.' },
  es: { context: 'Contexto', delivers: 'Qué entrega', criteria: 'Criterios de aceptación', out_of_scope: 'Fuera de alcance', today: 'Cómo funciona hoy', dependencies: 'Dependencias', questions: 'Preguntas abiertas', estimate: 'Tamaño, riesgo y estimación',
    size: (s, r) => `Tamaño: ${s}. Riesgo: ${r}.`, waits: 'Espera a', unblocks: 'Desbloquea a', none: 'Nada: puede empezar ya.', others: 'Lo cubren otras entregas:', part: (n) => `Parte de #${n}`,
    see: (n, h) => `Ver el issue del brief #${n} para "${h}".`,
    range: (lo, hi, n) => `Entre ${lo} y ${hi} hasta estar lista para aprobar, según ${n} trabajo${n === 1 ? '' : 's'} parecido${n === 1 ? '' : 's'} ya terminado${n === 1 ? '' : 's'}. Es un rango, no una fecha.`, few: 'Hay muy poco historial para estimar.' },
  pt: { context: 'Contexto', delivers: 'O que entrega', criteria: 'Critérios de aceitação', out_of_scope: 'Fora do escopo', today: 'Como funciona hoje', dependencies: 'Dependências', questions: 'Perguntas em aberto', estimate: 'Tamanho, risco e estimativa',
    size: (s, r) => `Tamanho: ${s}. Risco: ${r}.`, waits: 'Espera por', unblocks: 'Desbloqueia', none: 'Nada: pode começar já.', others: 'Cobertos por outras entregas:', part: (n) => `Parte de #${n}`,
    see: (n, h) => `Ver a issue do brief #${n} para "${h}".`,
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

/** The lines of one section of the body (the section is whole: dropping it is the caller's decision). */
function sectionLines(section, t) {
  const out = [`## ${section.heading}`, ''];
  for (const p of section.parts) {
    if (p.type === 'text') out.push(...(p.heading ? [`### ${p.heading}`, ''] : []), p.text, '');
    else if (p.type === 'criteria') out.push(...p.items.map((c) => `- [ ] ${c.id}: ${c.text}`), '');
    else if (p.type === 'others') {
      if (p.items.length) out.push(t.others, '', ...p.items.map((o) => `- ${ref(o)}: ${o.criteria.join(', ')}`), '');
    } else if (p.type === 'waits_for') out.push(`### ${p.heading}`, '', ...(p.items.length ? p.items.map((o) => `- ${ref(o)}`) : [t.none]), '');
    else if (p.type === 'unblocks') { if (p.items.length) out.push(`### ${p.heading}`, '', ...p.items.map((o) => `- ${ref(o)}`), ''); }
    else if (p.type === 'estimate') out.push(p.text, '');
  }
  return out;
}

const ref = (o) => (Number.isInteger(o.issue) ? `#${o.issue} (${o.id}: ${o.title})` : `${o.id}: ${o.title}`);

/** The issue body: the sections in order (a dropped one is a single line), then the `Part of` line and the marker. */
function bodyOf(sections, t, briefIssue, marker) {
  const lines = [];
  for (const s of sections) {
    if (s.key === 'part_of') continue;
    if (s.dropped) lines.push(t.see(briefIssue, s.heading), '');
    else lines.push(...sectionLines(s, t));
  }
  return [...lines, t.part(briefIssue), '', marker, ''].join('\n');
}

/** Everything both public builders share: per deliverable, `{ d, sections, marker data }`, in dependency order. */
function build(briefText, { briefIssue = null, estimates = {}, issues = {} }) {
  const status = approvedOrThrow(briefText);
  const parsed = parseBrief(canonicalBrief(briefText));
  const lang = parsed.language;
  const t = TEXT[lang] ?? TEXT.en;
  const h = (key) => heading(lang, key);
  const byId = new Map(parsed.deliverables.map((d) => [d.id, d]));
  const criteria = new Map(parsed.criteria.map((c) => [c.id, c.text]));
  const hash = status.approval.hash.slice(0, 12);
  const issueOf = (id) => (Number.isInteger(issues[id]) && briefIssue !== null ? issues[id] : null);
  const one = (o) => ({ id: o.id, title: sanitize(o.title), issue: issueOf(o.id) });
  const text = (from, key, sub) => (parsed.sections[key] ? [{ type: 'text', from, heading: sub ?? null, text: block(parsed.sections[key]) }] : []);
  return dependencyOrder(parsed.deliverables).map((d) => {
    const est = fitEstimate(estimates[d.id]);
    const covered = new Set(d.covers);
    const others = parsed.deliverables.filter((o) => o.id !== d.id)
      .map((o) => ({ ...one(o), criteria: [...new Set(o.covers.filter((c) => criteria.has(c) && !covered.has(c)))] }))
      .filter((o) => o.criteria.length);
    const sections = [
      { key: 'context', heading: t.context, dropped: false, parts: [...text('problem', 'problem', h('problem')), ...text('audience', 'audience', h('audience'))] },
      { key: 'delivers', heading: t.delivers, dropped: false, parts: [{ type: 'text', from: 'title', heading: null, text: sanitize(d.title) }] },
      { key: 'criteria', heading: t.criteria, dropped: false, parts: [{ type: 'criteria', items: d.covers.map((id) => ({ id, text: sanitize(criteria.get(id)) })) }] },
      { key: 'out_of_scope', heading: t.out_of_scope, dropped: false, parts: [...text('out_of_scope', 'out_of_scope'), { type: 'others', items: others }] },
      { key: 'today', heading: t.today, dropped: false, parts: text('today', 'today') },
      { key: 'dependencies', heading: t.dependencies, dropped: false, parts: [
        { type: 'waits_for', heading: t.waits, items: d.after.map((id) => one(byId.get(id))) },
        { type: 'unblocks', heading: t.unblocks, items: parsed.deliverables.filter((o) => o.after.includes(d.id)).map(one) },
      ] },
      ...(parsed.sections.questions ? [{ key: 'questions', heading: t.questions, dropped: false, parts: text('questions', 'questions') }] : []),
      { key: 'estimate', heading: t.estimate, dropped: false, parts: [{ type: 'estimate', size: d.size, risk: d.risk, estimate: est,
        text: `${t.size(d.size, d.risk)}\n\n${est ? t.range(humanMinutes(est.low_min), humanMinutes(est.high_min), est.jobs) : t.few}` }] },
      { key: 'part_of', heading: null, dropped: false, parts: [{ type: 'brief', issue: briefIssue }] },
    ];
    let body = null;
    if (briefIssue !== null) {
      const marker = `${DELIVERABLE_PREFIX}v1 brief=${briefIssue} id=${d.id} hash=${hash} est=${est ? `${est.low_min}-${est.high_min}` : 'none'}${CLOSE}`;
      body = bodyOf(sections, t, briefIssue, marker);
      for (const key of ['today', 'questions', 'context']) {
        if (body.length <= MAX_BODY) break;
        const s = sections.find((x) => x.key === key);
        if (s) { s.dropped = true; body = bodyOf(sections, t, briefIssue, marker); }
      }
      checkBody(body);
    }
    return { id: d.id, title: cap(d.title), body, labels: [DELIVERABLE_LABEL], after: [...d.after], sections };
  });
}

/**
 * One issue draft per deliverable of an approved brief, in dependency order:
 * `{ id, title, body, labels, after, sections }`. Throws a readable Error unless the gate is open.
 * @param {string} briefText the approved brief
 * @param {{ briefIssue: number, estimates?: Record<string, { low_min: number, high_min: number, jobs: number } | null>, issues?: Record<string, number> }} options
 *   `estimates` by deliverable id (the range shown at creation time); `issues` the issue number of deliverables already created.
 */
export function deliverableIssueDrafts(briefText, { briefIssue, estimates = {}, issues = {} } = {}) {
  approvedOrThrow(briefText);
  if (!Number.isInteger(briefIssue) || briefIssue < 1) throw new Error('The deliverable issues need the brief issue number (a positive integer).');
  return build(briefText, { briefIssue, estimates, issues });
}

/** The same drafts for a brief whose issue does not exist yet: `body` is null and no deliverable has an issue number. */
export function deliverableSections(briefText, { estimates = {} } = {}) {
  return build(briefText, { estimates });
}
