import { createHash } from 'node:crypto';
import { send, validWebhook } from './connectors/discord.js';
import { LANGUAGES } from './util.js';

export const SUPPORTED_EVENTS = Object.freeze([
  'job.started', 'stage.changed', 'job.needs_human', 'job.failed', 'job.succeeded', 'job.merged',
]);

/** One notification per effective persisted transition; success and merge are aliases. */
export function lifecycleEvent(job, from, config = {}) {
  if (from === job.stage) return null;
  const selected = config.notifications?.events;
  const events = Array.isArray(selected) ? selected : [];
  let type = from == null ? 'job.started'
    : job.stage === 'needs-human' ? 'job.needs_human'
      : job.stage === 'rejected' ? 'job.failed'
        : job.stage === 'merged' ? (events.includes('job.merged') ? 'job.merged' : 'job.succeeded')
          : 'stage.changed';
  if (from != null && !events.includes(type) && events.includes('stage.changed')) type = 'stage.changed';
  const repo = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(config.repo ?? '') ? config.repo : null;
  const issue = Number.isSafeInteger(job.issue) && job.issue > 0 ? job.issue : undefined;
  const pr = Number.isSafeInteger(job.pr) && job.pr > 0 ? job.pr : null;
  const round = Number.isSafeInteger(job.round) && job.round >= 0 ? job.round : null;
  const maxRounds = Number.isSafeInteger(job.max_rounds) && job.max_rounds >= 1 ? job.max_rounds : null;
  const language = typeof config.language === 'string' && LANGUAGES.includes(config.language) ? config.language : 'en';
  const eventId = createHash('sha256').update(JSON.stringify([job.id, type, from ?? null, job.stage, job.round ?? 0])).digest('hex');
  // Explicit allow-list: adapters never see the rest of job.json (worktree, costs, history).
  // Title and note are untrusted free text; adapters must sanitise them before sending.
  return {
    type, id: job.id, ...(issue ? { issue } : {}),
    ...(typeof job.title === 'string' && job.title ? { title: job.title } : {}),
    from: from ?? null, to: job.stage,
    ...(typeof job.note === 'string' && job.note ? { note: job.note } : {}),
    ...(repo && issue ? { url: `${repo}/issues/${issue}` } : {}),
    ...(repo && pr ? { prUrl: `${repo}/pull/${pr}` } : {}),
    ...(round != null ? { round } : {}),
    ...(maxRounds != null ? { max_rounds: maxRounds } : {}),
    ...(job.lane === 'xs' || job.lane === 'normal' ? { lane: job.lane } : {}),
    language,
    timestamp: job.updated, eventId,
  };
}

/** Bounded in-memory idempotency; failures are not cached and can be retried. */
export function createNotifier({ adapters = { discord: send }, report = () => {}, maxEntries = 512 } = {}) {
  const delivered = new Map();
  const pending = new Map();
  const capacity = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 512;
  const record = (status) => { try { report(`notifications: ${status}`); } catch { /* isolated logger */ } };
  return async function notify(event, { config = {}, env = process.env, fetch, timeoutMs } = {}) {
    try {
      const settings = config.notifications;
      if (!event) return; // no effective stage change: nothing to validate or send
      if (settings == null || settings.enabled === false) return;
      if (!settings || settings.enabled !== true || !Array.isArray(settings.events)
        || settings.events.some((name) => !SUPPORTED_EVENTS.includes(name))
        || Object.keys(settings).some((key) => !['enabled', 'events'].includes(key))
        || !validWebhook(env.FACTORY_DISCORD_WEBHOOK_URL)) {
        record('invalid_config');
        return;
      }
      if (!settings.events.includes(event.type)) return;
      for (const [name, adapter] of Object.entries(adapters)) {
        const key = `${name}:${event.eventId}`;
        if (delivered.has(key)) continue;
        if (pending.has(key)) { await pending.get(key); continue; }
        const task = Promise.resolve().then(async () => {
          try {
            const result = await adapter(event, { webhookUrl: env.FACTORY_DISCORD_WEBHOOK_URL, fetch, timeoutMs });
            const status = ['sent', 'timeout', 'rate_limited', 'invalid_config'].includes(result?.status) ? result.status : 'failed';
            record(status);
            if (status === 'sent') {
              delivered.set(key, true);
              while (delivered.size > capacity) delivered.delete(delivered.keys().next().value);
            }
          } catch { record('failed'); }
        });
        pending.set(key, task);
        try { await task; } finally { pending.delete(key); }
      }
    } catch { record('failed'); }
  };
}

export const notify = createNotifier({ report: (message) => process.stderr.write(`${message}\n`) });
