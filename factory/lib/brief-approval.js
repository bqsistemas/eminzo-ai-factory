// Approval of a brief: a marker line inside the brief text, bound to a SHA-256 of the brief's content.
//
//   <!-- eminzo:approved sha256=<64 hex> by=<github login> at=<ISO 8601> -->
//
// The hash covers the canonical text (the brief without its approval marker, normalized line endings, no trailing
// whitespace). Any later edit stops the hash from matching, so the brief is "changed" and needs a new approval.
// briefStatus is THE gate: whatever creates issues from a brief must call it and proceed only when
// `can_create_issues` is true. Pure: no I/O, no clock (the caller passes `at`).
import { createHash } from 'node:crypto';

import { parseBrief, validateBrief } from './brief.js';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A whole line that is an approval marker; captures hash, login and date. */
export const APPROVAL_PATTERN = /^<!--\s*eminzo:approved\s+sha256=([0-9a-f]{64})\s+by=([A-Za-z0-9][A-Za-z0-9-]{0,38})\s+at=(\d{4}-\d{2}-\d{2}T\S+)\s*-->$/;

const isMarker = (line) => APPROVAL_PATTERN.test(line.trim());
const isoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s));
const lines = (text) => String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);

/** The brief without approval markers, `\n` line endings, no trailing whitespace per line or blank lines at the end. */
export function canonicalBrief(text) {
  return lines(text).filter((l) => !isMarker(l)).map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
}

/** The SHA-256 (hex) of the canonical brief. */
export const briefHash = (text) => createHash('sha256').update(canonicalBrief(text), 'utf8').digest('hex');

/** The approval markers found in a text, in order. */
const markers = (text) => lines(text).map((l) => l.trim().match(APPROVAL_PATTERN)).filter(Boolean).map((m) => ({ hash: m[1], by: m[2], at: m[3] }));

/**
 * The brief with exactly one approval marker (an old one is replaced). Throws a sentence a person understands unless
 * the brief is complete.
 */
export function approveBrief(text, { by, at } = {}) {
  const check = validateBrief(parseBrief(canonicalBrief(text)));
  if (!check.ok) throw new Error(`The brief cannot be approved yet: ${check.problems[0]}.`);
  if (typeof by !== 'string' || !LOGIN.test(by)) throw new Error('"by" must be a GitHub login (letters, digits and hyphens, up to 39 characters).');
  if (!isoDate(at)) throw new Error('"at" must be an ISO 8601 date and time, for example 2026-11-12T15:00:00Z.');
  return `${canonicalBrief(text)}\n\n<!-- eminzo:approved sha256=${briefHash(text)} by=${by} at=${at} -->\n`;
}

/**
 * Where a brief stands: `{ state, ok, problems, warnings, approval, can_create_issues, reason }`.
 * draft (has problems) | ready (complete, not approved) | approved (the marker's hash matches) | changed (a marker
 * is there but the hash differs, or there is more than one). `can_create_issues` is true only for approved.
 */
export function briefStatus(text) {
  const check = validateBrief(parseBrief(canonicalBrief(text)));
  const found = markers(text);
  const base = { ok: check.ok, problems: check.problems, warnings: check.warnings };
  if (!check.ok) {
    return { state: 'draft', ...base, approval: found[0] ?? null, can_create_issues: false, reason: `The brief cannot be approved yet: ${check.problems[0]}.` };
  }
  if (!found.length) return { state: 'ready', ...base, approval: null, can_create_issues: false, reason: 'The brief is not approved yet.' };
  if (found.length > 1) {
    return { state: 'changed', ...base, approval: found[0], can_create_issues: false, reason: 'The brief has more than one approval marker; approve it again.' };
  }
  const [approval] = found;
  if (approval.hash === briefHash(text)) {
    return { state: 'approved', ...base, approval, can_create_issues: true, reason: `The brief was approved by ${approval.by} on ${approval.at.slice(0, 10)}.` };
  }
  return { state: 'changed', ...base, approval, can_create_issues: false, reason: `The brief changed after it was approved on ${approval.at.slice(0, 10)}; approve it again.` };
}
