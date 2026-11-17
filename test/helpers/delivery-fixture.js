// Job folders with fixed times, for the delivery metrics tests. Times are written in UTC; the tests run in
// America/Costa_Rica (UTC-6, no daylight saving time), so local midnight of a date is 06:00 UTC.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TZ = 'America/Costa_Rica';
export const REPO = 'https://github.com/acme/widgets';
/** The moment the fixture is read at. */
export const NOW = Date.parse('2026-10-02T12:00:00Z');

/** An empty repository root with a factory/config.json (no `repo` when `repo` is null). */
export function emptyRoot({ repo = REPO } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-delivery-'));
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(repo === null ? { base: 'origin/main' } : { repo, base: 'origin/main' }));
  return root;
}

/** Writes factory/jobs/<id>/job.json. */
export function addJob(root, id, job) {
  const dir = join(root, 'factory/jobs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ lane: 'normal', round: 1, max_rounds: 3, provider: 'claude', cost_status: 'available', ...job }));
}

const intake = (risk, size) => ({ decision: 'ACCEPT', risk, surfaces: [], size });

/**
 * The jobs of September 2026 the metrics tests read, for the period 2026-09-01 .. 2026-09-30 (local):
 *   deployments 201 (120 min, approval after 30), 202 (100 min, no approve_entered, cost unavailable),
 *   203 (150 min, approval after 60), 211 (60 min, approval after 20); 205 rejected; 204 merged before the period;
 *   206 merged after it. Failures: one shared by 207 and 208 (fix issue 203), one without fix issue (209) and one
 *   still open (210, held at the gate for fix issue 299).
 */
export function septemberRoot() {
  const root = emptyRoot();
  addJob(root, '201-first', { issue: 201, title: 'First', stage: 'merged', intake: intake('low', 's'), started: '2026-09-10T10:00:00.000Z', approve_entered: '2026-09-10T10:30:00.000Z', finished: '2026-09-10T12:00:00.000Z', updated: '2026-09-10T12:00:00.000Z', cost_usd: 2.5 });
  addJob(root, '202-second', { issue: 202, title: 'Second', stage: 'merged', round: 2, intake: intake('medium', 'm'), started: '2026-09-12T10:00:00.000Z', finished: '2026-09-12T11:40:00.000Z', updated: '2026-09-12T11:40:00.000Z', cost_status: 'unavailable', history: [{ gate: 'FAIL', reviews: {} }] });
  addJob(root, '203-third', { issue: 203, title: 'Third', stage: 'merged', intake: intake('high', 'l'), started: '2026-09-20T10:00:00.000Z', approve_entered: '2026-09-20T11:00:00.000Z', finished: '2026-09-20T12:30:00.000Z', updated: '2026-09-20T12:30:00.000Z', cost_usd: 10 });
  addJob(root, '211-fourth', { issue: 211, title: 'Fourth', stage: 'merged', intake: intake('low', 'xs'), started: '2026-09-22T08:00:00.000Z', approve_entered: '2026-09-22T08:20:00.000Z', finished: '2026-09-22T09:00:00.000Z', updated: '2026-09-22T09:00:00.000Z', cost_usd: 1.25 });
  addJob(root, '205-rejected', { issue: 205, title: 'Rejected', stage: 'rejected', intake: intake('low', 'xs'), started: '2026-09-15T08:00:00.000Z', finished: '2026-09-15T09:00:00.000Z', updated: '2026-09-15T09:00:00.000Z', cost_usd: 0.5 });
  addJob(root, '204-before', { issue: 204, title: 'Before', stage: 'merged', intake: intake('low', 's'), started: '2026-08-20T08:00:00.000Z', approve_entered: '2026-08-20T08:30:00.000Z', finished: '2026-08-20T10:00:00.000Z', updated: '2026-08-20T10:00:00.000Z', cost_usd: 1 });
  addJob(root, '206-after', { issue: 206, title: 'After', stage: 'merged', intake: intake('low', 's'), started: '2026-10-01T08:00:00.000Z', finished: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T10:00:00.000Z', cost_usd: 1 });
  addJob(root, '207-held-one', { issue: 207, title: 'Held one', stage: 'build', intake: intake('low', 's'), started: '2026-09-05T09:00:00.000Z', updated: '2026-09-05T14:00:00.000Z', base_waits: [{ since: '2026-09-05T10:00:00.000Z', until: '2026-09-05T12:00:00.000Z', fix_issue: 203 }] });
  addJob(root, '208-held-two', { issue: 208, title: 'Held two', stage: 'build', intake: intake('low', 's'), started: '2026-09-05T09:30:00.000Z', updated: '2026-09-05T14:00:00.000Z', base_waits: [{ since: '2026-09-05T10:30:00.000Z', until: '2026-09-05T14:00:00.000Z', fix_issue: 203 }] });
  addJob(root, '209-held-own', { issue: 209, title: 'Held own', stage: 'build', intake: intake('low', 's'), started: '2026-09-07T09:00:00.000Z', updated: '2026-09-07T11:00:00.000Z', base_waits: [{ since: '2026-09-07T10:00:00.000Z', until: '2026-09-07T10:30:00.000Z', fix_issue: null }] });
  addJob(root, '210-held-open', { issue: 210, title: 'Held open', stage: 'gate', intake: intake('low', 's'), started: '2026-09-25T09:00:00.000Z', updated: '2026-09-25T11:00:00.000Z', base_wait: { since: '2026-09-25T10:00:00.000Z', fix_issue: 299 } });
  return root;
}

/** Jobs in needs-human, build, gate (held by the base), merged and rejected, read at NOW. */
export function wipRoot() {
  const root = emptyRoot();
  addJob(root, '301-human', { issue: 301, title: 'Needs a person', stage: 'needs-human', intake: intake('high', 'm'), started: '2026-10-02T06:00:00.000Z', updated: '2026-10-02T09:00:00.000Z' });
  addJob(root, '302-build', { issue: 302, title: 'Building', stage: 'build', intake: intake('low', 's'), started: '2026-10-02T11:00:00.000Z', updated: '2026-10-02T11:30:00.000Z' });
  addJob(root, '303-held', { issue: 303, title: 'Held at the gate', stage: 'gate', intake: intake('medium', 'm'), started: '2026-10-01T12:00:00.000Z', updated: '2026-10-02T10:30:00.000Z', base_wait: { since: '2026-10-02T10:00:00.000Z', fix_issue: 77 } });
  addJob(root, '304-merged', { issue: 304, title: 'Merged', stage: 'merged', intake: intake('low', 's'), started: '2026-10-01T08:00:00.000Z', finished: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T10:00:00.000Z' });
  addJob(root, '305-rejected', { issue: 305, title: 'Rejected', stage: 'rejected', intake: intake('low', 's'), started: '2026-10-01T08:00:00.000Z', finished: '2026-10-01T10:00:00.000Z', updated: '2026-10-01T10:00:00.000Z' });
  return root;
}
