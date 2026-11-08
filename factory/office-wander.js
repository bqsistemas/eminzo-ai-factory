// Idle lounge wandering decisions. Pure: callers inject time (ms) and rng, no timers or globals.
import { LOUNGE_POINTS, WAYPOINTS } from './office-map.js';
import { retargetWalker, WALK_SPEED, WANDER_SPEED } from './office-navigation.js';

export const WANDER = Object.freeze({
  restMs: [4000, 12000],   // standing at the home spot before the next decision
  dwellMs: [5000, 14000],  // lingering at a point of interest
  pauseMs: [3000, 8000],   // "just stand there" pause instead of leaving
  poiChance: 0.7,          // chance to leave for a point of interest at a decision
  homeChance: 0.5,         // after a dwell: go home instead of another point
  minGap: 28,              // never stand closer than this to another agent's target
});

const between = ([lo, hi], rng) => lo + Math.floor(rng() * (hi - lo));
const dist = (a, b) => Math.hypot(WAYPOINTS.nodes[a].x - WAYPOINTS.nodes[b].x, WAYPOINTS.nodes[a].y - WAYPOINTS.nodes[b].y);

export const createWander = () => ({ phase: 'rest', target: null, until: null, pose: 'stand' });

/** Pick a free point of interest (not held by, or crowding, another agent's target). */
function pickPoint(rng, taken, current) {
  const free = LOUNGE_POINTS.filter((p) => p.node !== current && !taken.some((t) => t === p.node || (WAYPOINTS.nodes[t] && dist(t, p.node) < WANDER.minGap)));
  return free.length ? free[Math.min(free.length - 1, Math.floor(rng() * free.length))] : null;
}

const walkTo = (state, p) => ({ ...state, phase: 'walk', target: p.node, pose: p.pose, until: 0 });
const goHome = (state, home) => ({ ...state, phase: 'walk', target: home, pose: 'stand', until: 0 });

/**
 * Next wander state. `moving` is true while the walker still has route left,
 * so timers only run once it has stopped. Cancelling is the director's job (it drops the state).
 */
export function stepWander(state, { now, rng, moving, home, taken = [] }) {
  if (moving) return state;
  if (state.until === null && state.phase === 'rest') return { ...state, target: state.target ?? home, until: now + between(WANDER.restMs, rng) };

  if (state.phase === 'walk') {
    if (state.target === home) return { phase: 'rest', target: home, until: now + between(WANDER.restMs, rng), pose: 'stand' };
    return { ...state, phase: 'dwell', until: now + between(WANDER.dwellMs, rng) };
  }
  if (now < state.until) return state;

  if (state.phase === 'dwell') {
    // Low roll heads home, high roll strolls to another point.
    if (rng() >= WANDER.homeChance) {
      const p = pickPoint(rng, taken, state.target);
      if (p) return walkTo(state, p);
    }
    return goHome(state, home);
  }
  // rest: leave for a point of interest, or just stand a while longer.
  const p = rng() < WANDER.poiChance ? pickPoint(rng, taken, state.target) : null;
  if (p) return walkTo(state, p);
  return { ...state, until: now + between(WANDER.pauseMs, rng) };
}

const SIT_LIFT = 7, LIFT_EASE = 10;
/** Sprite lift (px) while seated on a sofa; eases out as the walker moves away from the seat point. */
export function sofaLift(walker) {
  let lift = 0;
  for (const p of LOUNGE_POINTS) {
    if (p.pose !== 'sit') continue;
    const d = Math.hypot(walker.x - p.x, walker.y - p.y);
    if (d < LIFT_EASE) lift = Math.max(lift, Math.round(SIT_LIFT * (1 - d / LIFT_EASE)));
  }
  return lift;
}

/**
 * Wander bookkeeping for all lounge agents: which ones wander, when to wake, how fast to walk.
 * Pure apart from mutating the walkers it is handed; time and rng are injected.
 */
export function createWanderDirector(rng) {
  const wanders = new Map();
  return {
    get size() { return wanders.size; },
    state: (id) => wanders.get(id),
    set: (id, state) => wanders.set(id, state),
    /** Reconcile with the office state: idle lounge agents wander, anything else is cancelled. */
    sync(agents, walkers, reduced, owned = () => false) {
      for (const [id, a] of Object.entries(agents)) {
        const w = walkers.get(id);
        if (owned(id)) { wanders.delete(id); continue; }
        if (a.place === 'lounge' && !reduced) {
          if (!wanders.has(id)) wanders.set(id, { ...createWander(), target: a.node });
          retargetWalker(w, wanders.get(id).target);
        } else {
          wanders.delete(id);
          retargetWalker(w, a.node, reduced);
        }
      }
    },
    clear() { wanders.clear(); },
    tick(now, agents, walkers) {
      for (const [id, ws] of wanders) {
        const w = walkers.get(id), home = agents[id].node;
        const taken = [...wanders].filter(([o]) => o !== id).map(([, s]) => s.target).filter(Boolean);
        const next = stepWander(ws, { now, rng, moving: w.queue.length > 0, home, taken });
        if (next === ws) continue;
        if (next.phase === 'walk' && next.target !== ws.target) {
          retargetWalker(w, next.target);
          // No route (or nothing to walk): do not mistake it for an arrival.
          if (!w.queue.length) {
            wanders.set(id, { phase: 'rest', target: home, until: now + WANDER.pauseMs[0], pose: 'stand' });
            continue;
          }
        }
        wanders.set(id, next);
      }
    },
    /** Calm speed only on a walk the wander logic issued; everything else is a work walk. */
    speed: (id, walker) => {
      const ws = wanders.get(id);
      return ws && ws.phase === 'walk' && walker.target === ws.target ? WANDER_SPEED : WALK_SPEED;
    },
    /** Earliest time (ms) a settled agent needs a decision; Infinity when nothing is pending. */
    nextWake(walkers) {
      let wake = Infinity;
      for (const [id, ws] of wanders) {
        if (walkers.get(id).queue.length) continue;
        wake = Math.min(wake, ws.until === null || ws.phase === 'walk' ? 0 : ws.until);
      }
      return wake;
    },
  };
}

/**
 * What the render loop should do next: run frames, or sleep on one timer until `wake`.
 * A timer that fires early or clamped still falls back to a new timer, never to a stall.
 */
export function planWake({ reduced, hidden, moving, busy, wake, now }) {
  if (reduced || hidden) return { frame: false, timerMs: null };
  if (moving || busy || wake <= now + 4) return { frame: true, timerMs: null };
  return { frame: false, timerMs: wake === Infinity ? null : Math.max(0, wake - now) };
}
