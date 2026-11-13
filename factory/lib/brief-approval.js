// Approval of a brief: a marker line at the end of the brief text, bound to a SHA-256 of the brief, who approved and
// when.
//
//   <!-- eminzo:approved sha256=<64 lowercase hex> by=<github login> at=<ISO 8601> -->
//
// The hash is SHA-256 (UTF-8) of:  canonicalBrief(text) + "\n" + by + "\n" + at
// The canonical text is the brief without its approval marker, with `\n` line endings, without a leading BOM, and
// without trailing spaces and tabs on each line or blank lines at the end. ONLY ASCII space and tab are ignored at line
// ends, so any other edit (a non-breaking space, a line separator) changes the hash.
//
// What the marker does: it detects any edit made after approval, to the text, to who approved or to when. What it does
// NOT do: authenticate. `by` is self-declared and anyone holding the text can compute a valid marker; GitHub (the
// author and history of the issue created from the brief) is the record of who approved.
//
// A marker counts only as an unindented line outside fenced code blocks, and it must be the last non-blank line.
// Marker-like text anywhere else is the person's content (inside a code fence) or makes the brief "changed".
//
// briefStatus is THE gate: whatever creates issues from a brief must call it and proceed only when
// `can_create_issues` is true. Pure and linear in the size of the text: no I/O, no clock (the caller passes `at`).
import { createHash } from 'node:crypto';

import { parseBrief, validateBrief } from './brief.js';

/** A line longer than this blocks approval (and is never scanned with a regular expression). */
export const MAX_LINE = 10_000;
const MAX_MARKER = 200;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ISO_AT = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})';
/** A whole line that is an approval marker; captures hash, login and date. */
export const APPROVAL_PATTERN = new RegExp(`^<!-- eminzo:approved sha256=([0-9a-f]{64}) by=([A-Za-z0-9][A-Za-z0-9-]{0,38}) at=(${ISO_AT}) -->$`);

const isoDate = (s) => typeof s === 'string' && s.length <= 40 && new RegExp(`^${ISO_AT}$`).test(s) && Number.isFinite(Date.parse(s));
const isBlank = (line) => { for (let i = 0; i < line.length; i += 1) if (line[i] !== ' ' && line[i] !== '\t') return false; return true; };
export const stripEnd = (line) => {
  let end = line.length;
  if (line[end - 1] === '\r') end -= 1;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return line.slice(0, end);
};
const leading = (line) => { let i = 0; while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1; return i; };

/** The fence character a line opens or closes (``` or ~~~, up to 3 spaces in), or null. */
export function fenceOf(line) {
  const i = leading(line);
  if (i > 3 || line[i] === '\t') return null;
  const ch = line[i];
  return (ch === '`' || ch === '~') && line[i + 1] === ch && line[i + 2] === ch ? ch : null;
}

/** Splits into lines and finds the approval markers and marker-like lines outside code fences. */
function scan(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split('\n').map(stripEnd);
  const markers = [];
  const malformed = [];
  let fence = null;
  lines.forEach((line, index) => {
    const f = fenceOf(line);
    if (fence) {
      if (f === fence) fence = null;
      return;
    }
    if (f) { fence = f; return; }
    const at = leading(line);
    if (!line.startsWith('<!--', at) || !line.slice(at, at + 40).includes('eminzo:approved')) return;
    const m = at === 0 && line.length <= MAX_MARKER ? line.match(APPROVAL_PATTERN) : null;
    if (m && isoDate(m[3])) markers.push({ index, hash: m[1], by: m[2], at: m[3] });
    else malformed.push(index);
  });
  return { lines, markers, malformed };
}

/** The brief without its approval marker, `\n` line endings, no BOM, no trailing spaces, tabs or blank lines. */
export function canonicalBrief(text) {
  const { lines, markers } = scan(text);
  const drop = new Set(markers.map((m) => m.index));
  const kept = lines.filter((_, i) => !drop.has(i));
  while (kept.length && isBlank(kept[kept.length - 1])) kept.pop();
  return kept.join('\n');
}

/** SHA-256 (hex) of the canonical brief, "\n", who approved, "\n", and when. */
export const briefHash = (text, { by, at }) => createHash('sha256').update(`${canonicalBrief(text)}\n${by}\n${at}`, 'utf8').digest('hex');

const longLine = (text) => String(text ?? '').split('\n').some((l) => l.length > MAX_LINE);
const LONG_LINE = `a line is longer than ${MAX_LINE} characters`;

/** The brief check on the canonical text; a very long line is a problem and the text is not parsed at all. */
function check(text) {
  if (longLine(text)) return { ok: false, problems: [LONG_LINE], warnings: [] };
  return validateBrief(parseBrief(canonicalBrief(text)));
}

/**
 * The brief with exactly one approval marker at its end (an old one is replaced). Throws a sentence a person
 * understands unless the brief is complete.
 */
export function approveBrief(text, { by, at } = {}) {
  if (!longLine(text) && scan(text).malformed.length) throw new Error('The brief has an approval line that is not valid; remove it before approving.');
  const result = check(text);
  if (!result.ok) throw new Error(`The brief cannot be approved yet: ${result.problems[0]}.`);
  if (typeof by !== 'string' || !LOGIN.test(by)) throw new Error('"by" must be a GitHub login (letters, digits and hyphens, up to 39 characters).');
  if (!isoDate(at)) throw new Error('"at" must be an ISO 8601 date and time, for example 2026-11-12T15:00:00Z.');
  return `${canonicalBrief(text)}\n\n<!-- eminzo:approved sha256=${briefHash(text, { by, at })} by=${by} at=${at} -->\n`;
}

/**
 * Where a brief stands: `{ state, ok, problems, warnings, approval, can_create_issues, reason }`.
 * draft (has problems) | ready (complete, not approved) | approved (the marker's hash matches) | changed (a marker is
 * there but the hash differs, there are two, it is not at the end, or an approval line is not valid).
 * `can_create_issues` is true only for approved.
 */
export function briefStatus(text) {
  if (longLine(text)) return { state: 'draft', ok: false, problems: [LONG_LINE], warnings: [], approval: null, can_create_issues: false, reason: `The brief cannot be approved yet: ${LONG_LINE}.` };
  const { lines, markers, malformed } = scan(text);
  const [first] = markers;
  const approval = first ? { by: first.by, at: first.at, hash: first.hash } : null;
  const result = validateBrief(parseBrief(canonicalBrief(text)));
  const base = { ok: result.ok, problems: result.problems, warnings: result.warnings };
  const refuse = (state, reason) => ({ state, ...base, approval, can_create_issues: false, reason });
  // The marker's own shape comes first: stray text after it would otherwise read as a problem of the last section.
  if (malformed.length) return refuse('changed', 'The brief has an approval line that is not valid; approve it again.');
  if (markers.length > 1) return refuse('changed', 'The brief has more than one approval marker; approve it again.');
  if (first && first.index !== lines.length - 1 - [...lines].reverse().findIndex((l) => !isBlank(l))) {
    return refuse('changed', 'The brief has text after its approval marker, which must be at the end of the brief; approve it again.');
  }
  if (!result.ok) return refuse('draft', `The brief cannot be approved yet: ${result.problems[0]}.`);
  if (!first) return refuse('ready', 'The brief is not approved yet.');
  if (first.hash !== briefHash(text, first)) return refuse('changed', `The brief changed after it was approved on ${first.at.slice(0, 10)}; approve it again.`);
  return { state: 'approved', ...base, approval, can_create_issues: true, reason: `The brief was approved by ${first.by} on ${first.at.slice(0, 10)}.` };
}
