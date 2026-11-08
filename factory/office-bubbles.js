// Thought bubbles over agents working in the Review and Spec/Build rooms. Pure: time (ms) and rng injected.
// Reduced motion shows no bubbles at all (static layout, nothing cycling).
export const BUBBLES = Object.freeze({
  think: { sprite: 'bubbleThink', weight: 5 },  // "..." most common
  alert: { sprite: 'bubbleAlert', weight: 2 },  // "!" found something
  idea: { sprite: 'bubbleIdea', weight: 2 },    // lightbulb
  done: { sprite: 'bubbleDone', weight: 1 },    // checkmark
});
export const BUBBLE_AREAS = ['review', 'engineering'];
export const BUBBLE_TIMING = Object.freeze({
  staggerMs: [0, 6000],   // first appearance, so agents do not all pop at once
  showMs: [2500, 4500],
  gapMs: [4000, 10000],
  maxConcurrent: 2,
  retryMs: 1000,          // base wait (plus up to the same again in jitter) when the cap is hit
  settleMs: [800, 2500],  // after arriving at a seat, before the first bubble
});

const between = ([lo, hi], rng) => lo + Math.floor(rng() * (hi - lo));
export const bubbleEligible = (a) => a.place !== 'lounge' && BUBBLE_AREAS.includes(a.area);

export function createBubbleDirector(rng) {
  // id -> { area, node, kind: key|null, until: ms|null, fresh: bool, waiting: ms|null }
  const states = new Map();
  const pick = (r) => {
    const entries = Object.entries(BUBBLES), total = entries.reduce((n, [, b]) => n + b.weight, 0);
    let roll = r() * total;
    for (const [key, b] of entries) { if (roll < b.weight) return key; roll -= b.weight; }
    return entries.at(-1)[0];
  };
  const blank = (a) => ({ area: a.area, node: a.node, kind: null, until: null, fresh: true, waiting: null });
  return {
    pick: (r = rng) => pick(r),
    ids: () => [...states.keys()],
    /** Keep state only for eligible agents; reduced motion drops everything. A new room or seat starts over. */
    sync(agents, reduced) {
      for (const id of [...states.keys()]) if (reduced || !agents[id] || !bubbleEligible(agents[id])) states.delete(id);
      if (reduced) return;
      for (const [id, a] of Object.entries(agents)) {
        if (!bubbleEligible(a)) continue;
        const s = states.get(id);
        if (!s || s.area !== a.area || s.node !== a.node) states.set(id, blank(a));
      }
    },
    /** `moving(id)`: walking agents hold no slot and their timers restart (a short settle delay) on arrival. */
    tick(now, moving = () => false) {
      const live = [];
      for (const [id, s] of states) {
        if (moving(id)) { Object.assign(s, { kind: null, until: null, fresh: false, waiting: null }); continue; }
        if (s.until === null) s.until = now + between(s.fresh ? BUBBLE_TIMING.staggerMs : BUBBLE_TIMING.settleMs, rng);
        else live.push(s);
      }
      const visible = () => live.filter((s) => s.kind).length;
      for (const s of live) if (s.kind && now >= s.until) { s.kind = null; s.until = now + between(BUBBLE_TIMING.gapMs, rng); }
      // Longest-waiting agent first, so a full cap cannot starve anyone; waiters take a freed slot at once.
      const due = live.filter((s) => !s.kind && (now >= s.until || (s.waiting !== null && visible() < BUBBLE_TIMING.maxConcurrent)));
      due.sort((a, b) => (a.waiting ?? a.until) - (b.waiting ?? b.until));
      for (const s of due) {
        if (visible() >= BUBBLE_TIMING.maxConcurrent) {
          s.waiting ??= s.until;
          s.until = now + BUBBLE_TIMING.retryMs + Math.floor(rng() * BUBBLE_TIMING.retryMs);
        } else { s.kind = pick(rng); s.waiting = null; s.until = now + between(BUBBLE_TIMING.showMs, rng); }
      }
    },
    /** Bubble key to draw now; nothing while the agent is walking. */
    get: (id, walker) => (walker.queue.length ? null : states.get(id)?.kind ?? null),
    nextWake() {
      let wake = Infinity;
      for (const s of states.values()) wake = Math.min(wake, s.until ?? 0);
      return wake;
    },
  };
}
