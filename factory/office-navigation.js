// Routes and animation share the same collision-tested map. No timers or job state.
import { COLLISIONS, WAYPOINTS } from './office-map.js';

const adjacent = new Map(Object.keys(WAYPOINTS.nodes).map((name) => [name, []]));
for (const [from, to] of WAYPOINTS.edges) {
  adjacent.get(from).push(to);
  adjacent.get(to).push(from);
}

export const WALK_SPEED = 90;
// Idle wandering is a calm stroll, well under the work-walk speed.
export const WANDER_SPEED = 38;
// Working agents stroll inside their room more slowly still.
export const WORK_SPEED = 22;

export function route(from, to) {
  if (!adjacent.has(from) || !adjacent.has(to)) return [];

  const previous = new Map([[from, null]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    if (queue[i] === to) break;
    for (const next of adjacent.get(queue[i])) {
      if (previous.has(next)) continue;
      previous.set(next, queue[i]);
      queue.push(next);
    }
  }
  if (!previous.has(to)) return [];

  const path = [];
  for (let node = to; node !== null; node = previous.get(node)) path.unshift(node);
  return path;
}

/** Segment vs inflated AABB (ground footprint), including segment endpoints. */
export function segmentClear(a, b, obstacles = COLLISIONS, radius = 0) {
  return obstacles.every((obstacle) => {
    let enter = 0;
    let exit = 1;
    for (const [position, delta, min, max] of [
      [a.x, b.x - a.x, obstacle.x - radius, obstacle.x + obstacle.w + radius],
      [a.y, b.y - a.y, obstacle.y - radius, obstacle.y + obstacle.h + radius],
    ]) {
      if (Math.abs(delta) < 1e-9) {
        if (position <= min || position >= max) return true;
        continue;
      }

      const first = (min - position) / delta;
      const second = (max - position) / delta;
      enter = Math.max(enter, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
      if (enter >= exit) return true;
    }
    return enter >= exit;
  });
}

export function retargetWalker(walker, target, reduced = false) {
  const destination = WAYPOINTS.nodes[target];
  if (!destination) return;

  if (reduced) {
    Object.assign(walker, { ...destination, node: target, target, queue: [] });
    return;
  }
  if (walker.target === target) return;

  // Finish the edge already being traversed before taking a different branch.
  const next = walker.queue[0];
  walker.queue = next ? [next, ...route(next, target).slice(1)] : route(walker.node, target).slice(1);
  walker.target = target;
}

export function advanceWalker(walker, dt, speed = WALK_SPEED) {
  let distance = speed * Math.max(0, Math.min(0.1, dt));
  while (walker.queue.length && distance > 0) {
    const destination = WAYPOINTS.nodes[walker.queue[0]];
    const dx = destination.x - walker.x;
    const dy = destination.y - walker.y;
    const remaining = Math.hypot(dx, dy);
    if (remaining <= distance) {
      Object.assign(walker, destination);
      walker.node = walker.queue.shift();
      distance -= remaining;
    } else {
      walker.x += (dx / remaining) * distance;
      walker.y += (dy / remaining) * distance;
      distance = 0;
    }
  }
  return walker.queue.length > 0;
}
