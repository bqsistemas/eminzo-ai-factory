// The dashboard's cache of job files. Only files that exist are remembered: a stage writes intake.md, build.md and the round-N/
// reviews while board.json stays the same, so "not written yet" (an empty body, a failed read) must be asked again, never kept.
// Neither dashboard server sends Last-Modified or Content-Length for these files, so hits are dropped on every board change instead.
export const FINAL_STAGES = new Set(['merged', 'rejected', 'closed']);
const EAGER_MISSES = 5; // reads that find nothing are repeated on every poll this many times, then only now and then
const LAZY_EVERY = 6;

export function createArtifactCache(fetchText) {
  const pending = new Map();
  const misses = new Map();
  const skipped = new Map();
  const missedIn = new Map(); // key -> the poll that last counted a miss for it
  const askedIn = new Map(); // key -> { poll, answer }: `due` is answered once per poll
  const missed = new Map(); // key -> the poll whose miss is still being served from `pending`
  let poll = 0;
  return {
    load(key, url) {
      // A miss is kept for the rest of the poll that found it (a second view gets the same answer without another read), then forgotten.
      if (pending.has(key) && missed.has(key) && missed.get(key) !== poll) { pending.delete(key); missed.delete(key); }
      if (!pending.has(key)) {
        const p = Promise.resolve().then(() => fetchText(url)).catch(() => null).then((text) => {
          const hit = typeof text === 'string' && text.length > 0 ? text : null;
          if (hit === null) {
            if (pending.get(key) === p) missed.set(key, poll);
            if (missedIn.get(key) !== poll) { missedIn.set(key, poll); misses.set(key, (misses.get(key) ?? 0) + 1); } // once per poll, whoever asks
          } else { misses.delete(key); missed.delete(key); }
          return hit;
        });
        pending.set(key, p);
      }
      return pending.get(key);
    },
    /** Whether a file that was not found should be asked for again now: always at first, then one poll in a few. */
    due(key) {
      const seen = askedIn.get(key);
      if (seen?.poll === poll) return seen.answer; // a second view in the same poll gets the same answer and does not advance the back-off
      let answer = true;
      if ((misses.get(key) ?? 0) >= EAGER_MISSES) {
        const n = (skipped.get(key) ?? 0) + 1;
        if (n >= LAZY_EVERY) skipped.delete(key); else { skipped.set(key, n); answer = false; }
      }
      askedIn.set(key, { poll, answer });
      return answer;
    },
    /** Call once at the start of each poll: the back-off counts polls, not callers. */
    beginPoll() { poll += 1; },
    clear() { pending.clear(); misses.clear(); skipped.clear(); missedIn.clear(); askedIn.clear(); missed.clear(); },
  };
}

/**
 * The files of `job` among `wanted` (the ones shown as not written) that exist now: `[{ file, text }]`. A job in a final stage
 * writes nothing more and is never asked again; a file that keeps missing is asked for less and less often.
 */
export async function newlyWritten(job, wanted, cache, urlOf) {
  if (!job || FINAL_STAGES.has(job.stage)) return [];
  const due = wanted.filter((file) => cache.due(`${job.id}/${file}`));
  const texts = await Promise.all(due.map((file) => cache.load(`${job.id}/${file}`, urlOf(file))));
  return due.flatMap((file, i) => (texts[i] === null ? [] : [{ file, text: texts[i] }]));
}
