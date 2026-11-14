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
import { BRIEF_MARKER, parseBrief } from './brief.js';
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
  en: { delivers: 'What it delivers', covers: 'Acceptance criteria it covers', size: (s, r) => `Size: ${s}. Risk: ${r}.`, waits: 'Waits for', none: 'Nothing: it can start right away.', estimate: 'Estimate when this issue was created', part: (n) => `Part of #${n}`,
    range: (lo, hi, n) => `About ${lo} to ${hi} until ready for approval, from ${n} similar finished job${n === 1 ? '' : 's'}. It is a range, not a date.`, few: 'Too little history to estimate.' },
  es: { delivers: 'Qué entrega', covers: 'Criterios de aceptación que cubre', size: (s, r) => `Tamaño: ${s}. Riesgo: ${r}.`, waits: 'Espera a', none: 'Nada: puede empezar ya.', estimate: 'Estimación al crear esta incidencia', part: (n) => `Parte de #${n}`,
    range: (lo, hi, n) => `Entre ${lo} y ${hi} hasta estar lista para aprobar, según ${n} trabajo${n === 1 ? '' : 's'} parecido${n === 1 ? '' : 's'} ya terminado${n === 1 ? '' : 's'}. Es un rango, no una fecha.`, few: 'Hay muy poco historial para estimar.' },
  pt: { delivers: 'O que entrega', covers: 'Critérios de aceitação que cobre', size: (s, r) => `Tamanho: ${s}. Risco: ${r}.`, waits: 'Espera por', none: 'Nada: pode começar já.', estimate: 'Estimativa ao criar esta issue', part: (n) => `Parte de #${n}`,
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

/**
 * One issue draft per deliverable of an approved brief, in dependency order:
 * `{ id, title, body, labels, after }`. Throws a readable Error unless the gate is open.
 * @param {string} briefText the approved brief
 * @param {{ briefIssue: number, estimates?: Record<string, { low_min: number, high_min: number, jobs: number } | null>, issues?: Record<string, number> }} options
 *   `estimates` by deliverable id (the range shown at creation time); `issues` the issue number of deliverables already created.
 */
export function deliverableIssueDrafts(briefText, { briefIssue, estimates = {}, issues = {} } = {}) {
  const status = approvedOrThrow(briefText);
  if (!Number.isInteger(briefIssue) || briefIssue < 1) throw new Error('The deliverable issues need the brief issue number (a positive integer).');
  const parsed = parseBrief(canonicalBrief(briefText));
  const t = TEXT[parsed.language] ?? TEXT.en;
  const byId = new Map(parsed.deliverables.map((d) => [d.id, d]));
  const criteria = new Map(parsed.criteria.map((c) => [c.id, c.text]));
  const hash = status.approval.hash.slice(0, 12);
  return dependencyOrder(parsed.deliverables).map((d) => {
    const est = fitEstimate(estimates[d.id]);
    const waits = d.after.map((id) => `- ${Number.isInteger(issues[id]) ? `#${issues[id]} (${id}: ${sanitize(byId.get(id).title)})` : `${id}: ${sanitize(byId.get(id).title)}`}`);
    const marker = `${DELIVERABLE_PREFIX}v1 brief=${briefIssue} id=${d.id} hash=${hash} est=${est ? `${est.low_min}-${est.high_min}` : 'none'}${CLOSE}`;
    const body = [
      `## ${t.delivers}`, '', `> ${sanitize(d.title)}`, '',
      `## ${t.covers}`, '', ...d.covers.map((c) => `> ${c}: ${sanitize(criteria.get(c))}`), '',
      t.size(d.size, d.risk), '',
      `## ${t.waits}`, '', ...(waits.length ? waits : [t.none]), '',
      `## ${t.estimate}`, '', est ? t.range(humanMinutes(est.low_min), humanMinutes(est.high_min), est.jobs) : t.few, '',
      t.part(briefIssue), '',
      marker, '',
    ].join('\n');
    return { id: d.id, title: cap(d.title), body: checkBody(body), labels: [DELIVERABLE_LABEL], after: [...d.after] };
  });
}
