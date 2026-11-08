// Slow in-room movement for agents working at their seat. Pure: callers inject time (ms) and rng, no timers or globals.
import { ROOM_POINTS, WAYPOINTS } from './office-map.js';
import { retargetWalker, WORK_SPEED } from './office-navigation.js';

export const WORK = Object.freeze({
  restMs: [8000, 20000],   // in the seat before the next decision (lounge: 4000-12000)
  dwellMs: [9000, 20000],  // working at a point (lounge: 5000-14000)
  pauseMs: [5000, 12000],  // stays a while longer in the seat (lounge: 3000-8000)
  poiChance: 0.5,          // chance to leave for a point at a decision
  homeChance: 0.6,         // after a dwell: go back to the seat instead of another point
  minGap: 28,              // never stand closer than this to another agent's node
  bobMs: 600,              // step period of the working bob
});

const between = ([lo, hi], rng) => lo + Math.floor(rng() * (hi - lo));
const dist = (a, b) => Math.hypot(WAYPOINTS.nodes[a].x - WAYPOINTS.nodes[b].x, WAYPOINTS.nodes[a].y - WAYPOINTS.nodes[b].y);

export const createWork = (home, room) => ({ phase: 'rest', target: home, until: null, pose: 'stand', home, room });

/** Pick a free point of this room only (not held by, or crowding, another agent's node). */
function pickPoint(room, rng, taken, current) {
  const free = (ROOM_POINTS[room] ?? []).filter((p) => p.node !== current && !taken.some((t) => t === p.node || (WAYPOINTS.nodes[t] && dist(t, p.node) < WORK.minGap)));
  return free.length ? free[Math.min(free.length - 1, Math.floor(rng() * free.length))] : null;
}

const walkTo = (state, target) => ({ ...state, phase: 'walk', target, pose: 'stand', until: 0 });

/** Next work state; same semantics as `stepWander` but slower and confined to `room`. */
export function stepWork(state, { now, rng, moving, home, room = state.room, taken = [] }) {
  if (moving) return state;
  if (state.until === null && state.phase === 'rest') return { ...state, target: state.target ?? home, until: now + between(WORK.restMs, rng) };

  if (state.phase === 'walk') {
    if (state.target === home) return { ...state, phase: 'rest', target: home, until: now + between(WORK.restMs, rng), pose: 'stand' };
    return { ...state, phase: 'dwell', until: now + between(WORK.dwellMs, rng) };
  }
  if (now < state.until) return state;

  if (state.phase === 'dwell') {
    if (rng() >= WORK.homeChance) {
      const p = pickPoint(room, rng, taken, state.target);
      if (p) return walkTo(state, p.node);
    }
    return walkTo(state, home);
  }
  const p = rng() < WORK.poiChance ? pickPoint(room, rng, taken, state.target) : null;
  if (p) return walkTo(state, p.node);
  return { ...state, until: now + between(WORK.pauseMs, rng) };
}

/** 1 px bob in discrete steps while settled at the seat or a point; 0 otherwise. */
export function workBob(state, walker, now) {
  if (!state || walker.queue.length || (state.phase !== 'rest' && state.phase !== 'dwell')) return 0;
  return Math.floor(now / WORK.bobMs) % 2;
}

/** Work bookkeeping for agents seated in a room with points: sync, tick, speed, bob, next wake. */
export function createWorkDirector(rng) {
  const works = new Map();
  return {
    get size() { return works.size; },
    state: (id) => works.get(id),
    set: (id, s) => works.set(id, s),
    clear() { works.clear(); },
    owns: (id) => works.has(id),
    sync(agents, walkers, reduced) {
      if (reduced) { works.clear(); return; }
      for (const [id, a] of Object.entries(agents)) {
        if (a.place === 'seat' && ROOM_POINTS[a.area]) {
          const s = works.get(id);
          if (!s || s.home !== a.node || s.room !== a.area) {
            works.set(id, createWork(a.node, a.area));
            retargetWalker(walkers.get(id), a.node);
          }
        } else works.delete(id);
      }
    },
    tick(now, agents, walkers) {
      for (const [id, ws] of works) {
        const w = walkers.get(id), a = agents[id], home = a.node;
        const taken = [
          ...[...works].filter(([o]) => o !== id).map(([, s]) => s.target),
          ...Object.entries(agents).filter(([o, b]) => o !== id && b.area === a.area && !works.has(o)).map(([, b]) => b.node),
        ].filter(Boolean);
        const next = stepWork(ws, { now, rng, moving: w.queue.length > 0, home, room: a.area, taken });
        if (next === ws) continue;
        if (next.phase === 'walk' && next.target !== ws.target) {
          retargetWalker(w, next.target);
          if (!w.queue.length) {
            works.set(id, { ...ws, phase: 'rest', target: home, until: now + WORK.pauseMs[0], pose: 'stand' });
            continue;
          }
        }
        works.set(id, next);
      }
    },
    /** Slow speed only on a walk the work logic issued. */
    speed: (id, walker) => {
      const s = works.get(id);
      return s && s.phase === 'walk' && walker.target === s.target ? WORK_SPEED : undefined;
    },
    bob: (id, walker, now) => workBob(works.get(id), walker, now),
    /** Earliest time (ms) a settled working agent needs a redraw or decision; Infinity when none. */
    nextWake(walkers, now) {
      let wake = Infinity;
      const edge = (Math.floor(now / WORK.bobMs) + 1) * WORK.bobMs;
      for (const [id, s] of works) {
        if (walkers.get(id).queue.length) continue;
        wake = Math.min(wake, s.until === null || s.phase === 'walk' ? 0 : s.until, edge);
      }
      return wake;
    },
  };
}
