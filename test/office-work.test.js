import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREAS, COLLISIONS, LOUNGE_SPOTS, MEETING_SEATS, ROOM_POINTS, SEATS, WAYPOINTS } from '../factory/office-map.js';
import { WALK_SPEED, WANDER_SPEED, WORK_SPEED, advanceWalker, route, segmentClear } from '../factory/office-navigation.js';
import { WANDER, createWanderDirector, planWake } from '../factory/office-wander.js';
import { WORK, createWork, createWorkDirector, stepWork, workBob } from '../factory/office-work.js';

const rects = Object.fromEntries(AREAS.map((a) => [a.id, a.rect]));
const N = WAYPOINTS.nodes;
const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };
const inside = (r, n) => n.x > r.x + 6 && n.x < r.x + r.w - 6 && n.y > r.y + 30 && n.y < r.y + r.h - 6;
const inRect = (r, n) => n.x >= r.x && n.x <= r.x + r.w && n.y >= r.y && n.y <= r.y + r.h;
const roomOf = (node) => AREAS.find((a) => a.id !== 'lounge' && inRect(a.rect, N[node]))?.id;
const seatRooms = [...new Set(Object.values(SEATS).map(roomOf))];
const degree = (node) => WAYPOINTS.edges.filter((e) => e.includes(node)).length;

test('AC-1: every seat room has at least 2 clear, reachable, in-room work points', () => {
  assert.deepEqual([...seatRooms].sort(), ['engineering', 'release', 'research', 'review']);
  for (const room of seatRooms) {
    const pts = ROOM_POINTS[room], r = rects[room];
    assert.ok(pts.length >= 2, room);
    const seatNodes = [...Object.values(SEATS), ...Object.values(MEETING_SEATS)].filter((n) => roomOf(n) === room);
    for (const p of pts) {
      assert.ok(!p.node.includes('lounge'));
      const n = N[p.node];
      assert.ok(n && inside(r, n), `${p.node} inside ${room}`);
      assert.ok(COLLISIONS.every((c) => !(n.x > c.x - 5 && n.x < c.x + c.w + 5 && n.y > c.y - 5 && n.y < c.y + c.h + 5)), `${p.node} clear`);
      assert.equal(degree(p.node), 1, `${p.node} leaf`);
      for (const s of seatNodes) assert.ok(Math.hypot(N[s].x - n.x, N[s].y - n.y) >= WORK.minGap, `${p.node} off seat ${s}`);
    }
    const checkRoute = (a, b) => {
      const path = route(a, b);
      assert.ok(path.length > 1, `${a}->${b} routed`);
      for (const id of path) assert.ok(!/^(door|cor)_/.test(id) && inRect(r, N[id]), `${a}->${b} via ${id}`);
      for (let i = 1; i < path.length; i++) assert.ok(segmentClear(N[path[i - 1]], N[path[i]], COLLISIONS, 5), `${a}->${b} edge clear`);
    };
    for (const s of seatNodes.filter((n) => Object.values(SEATS).includes(n))) for (const p of pts) checkRoute(s, p.node);
    for (const a of pts) for (const b of pts) if (a !== b) checkRoute(a.node, b.node);
  }
});

test('AC-2: work is slower than the lounge wander', () => {
  assert.ok(WORK_SPEED < WANDER_SPEED && WANDER_SPEED < WALK_SPEED);
  for (const k of ['restMs', 'dwellMs', 'pauseMs']) {
    assert.ok(WORK[k][0] > WANDER[k][0] && WORK[k][1] > WANDER[k][1], k);
  }
  const mk = () => ({ ...N.seat_spec, node: 'seat_spec', queue: ['in_engineering', 'seat_builder'] });
  const a = mk(), b = mk();
  advanceWalker(a, 0.1, WORK_SPEED); advanceWalker(b, 0.1, WANDER_SPEED);
  assert.ok(Math.hypot(a.x - N.seat_spec.x, a.y - N.seat_spec.y) < Math.hypot(b.x - N.seat_spec.x, b.y - N.seat_spec.y));
});

const home = 'seat_spec', room = 'engineering';
const base = { moving: false, home, room, taken: [] };
const engNodes = ROOM_POINTS.engineering.map((p) => p.node);

test('AC-3: stepWork rests, walks to a room point, dwells and returns', () => {
  const s0 = stepWork(createWork(home, room), { ...base, now: 1000, rng: () => 0 });
  assert.equal(s0.until, 1000 + WORK.restMs[0]);
  assert.ok(stepWork(createWork(home, room), { ...base, now: 1000, rng: () => 0.999999 }).until <= 1000 + WORK.restMs[1]);
  assert.equal(stepWork(s0, { ...base, now: s0.until - 1, rng: () => 0 }), s0);
  const go = stepWork(s0, { ...base, now: s0.until, rng: seq(0, 0) });
  assert.equal(go.phase, 'walk');
  assert.ok(engNodes.includes(go.target));
  assert.equal(stepWork(go, { ...base, moving: true, now: s0.until + 1, rng: () => 0 }), go);
  const dwell = stepWork(go, { ...base, now: s0.until + 5000, rng: () => 0 });
  assert.equal(dwell.phase, 'dwell');
  assert.ok(dwell.until - (s0.until + 5000) >= WORK.dwellMs[0] && dwell.until - (s0.until + 5000) <= WORK.dwellMs[1]);
  const back = stepWork(dwell, { ...base, now: dwell.until, rng: () => 0 });
  assert.equal(back.phase, 'walk');
  assert.equal(back.target, home);
  const other = stepWork(dwell, { ...base, now: dwell.until, rng: seq(0.99, 0) });
  assert.equal(other.phase, 'walk');
  assert.ok(engNodes.includes(other.target) && other.target !== dwell.target);
  const rested = stepWork(back, { ...base, now: dwell.until + 5000, rng: () => 0 });
  assert.equal(rested.phase, 'rest');
});

test('AC-4: stepWork honours taken nodes and crowding', () => {
  const s = stepWork(createWork(home, room), { ...base, now: 0, rng: () => 0 });
  const [first, second] = engNodes;
  const only = stepWork(s, { ...base, now: s.until, rng: seq(0, 0), taken: [first] });
  assert.equal(only.target, second);
  N.__crowd = { x: N[second].x + 10, y: N[second].y };
  try {
    const none = stepWork(s, { ...base, now: s.until, rng: seq(0, 0), taken: [first, '__crowd'] });
    assert.equal(none.phase, 'rest');
  } finally { delete N.__crowd; }
  const all = stepWork(s, { ...base, now: s.until, rng: seq(0, 0), taken: engNodes });
  assert.equal(all.phase, 'rest');
  assert.ok(all.until > s.until);
});

const agent = (place, node, area) => ({ place, node, area });
const mkWalker = (node) => ({ ...N[node], node, target: node, queue: [] });
const settle = (w) => { while (w.queue.length) advanceWalker(w, 0.1, 1000); };

test('AC-5: work director owns seated agents, slows work walks and yields to the lounge', () => {
  const work = createWorkDirector(() => 0), wander = createWanderDirector(() => 0);
  const walkers = new Map([['builder', mkWalker(LOUNGE_SPOTS.builder)], ['review-ux', mkWalker('meet_ux')]]);
  const agents = { builder: agent('seat', SEATS.builder, 'engineering'), 'review-ux': agent('meeting', MEETING_SEATS['review-ux'], 'review') };
  work.sync(agents, walkers, false); wander.sync(agents, walkers, false, (id) => work.owns(id));
  assert.ok(work.owns('builder'));
  assert.equal(walkers.get('builder').target, SEATS.builder);
  assert.equal(work.speed('builder', walkers.get('builder')), undefined);
  assert.equal(work.owns('review-ux'), false);
  settle(walkers.get('builder'));
  work.tick(0, agents, walkers);
  work.tick(work.state('builder').until, agents, walkers);
  const w = walkers.get('builder'), st = work.state('builder');
  assert.equal(st.phase, 'walk');
  assert.ok(w.queue.length);
  assert.equal(work.speed('builder', w), WORK_SPEED);
  settle(w);
  wander.sync(agents, walkers, false, (id) => work.owns(id));
  assert.equal(w.target, st.target);
  agents.builder = agent('lounge', LOUNGE_SPOTS.builder, 'lounge');
  work.sync(agents, walkers, false); wander.sync(agents, walkers, false, (id) => work.owns(id));
  assert.equal(work.owns('builder'), false);
  assert.equal(w.target, LOUNGE_SPOTS.builder);
  assert.equal(wander.speed('builder', w), WALK_SPEED);
});

test('AC-6: reduced motion clears work state and seats agents instantly', () => {
  const work = createWorkDirector(() => 0), wander = createWanderDirector(() => 0);
  const walkers = new Map([['builder', mkWalker(LOUNGE_SPOTS.builder)]]);
  const agents = { builder: agent('seat', SEATS.builder, 'engineering') };
  work.sync(agents, walkers, true); wander.sync(agents, walkers, true, (id) => work.owns(id));
  assert.equal(work.size, 0);
  const w = walkers.get('builder');
  assert.equal(w.node, SEATS.builder);
  assert.deepEqual(w.queue, []);
  assert.equal(w.x, N[SEATS.builder].x);
  assert.equal(work.bob('builder', w, 700), 0);
  assert.equal(work.nextWake(walkers, 100), Infinity);
  work.sync(agents, walkers, false);
  assert.equal(work.size, 1);
});

test('AC-7: bob alternates in steps and wakes on its own timer, never frames', () => {
  const work = createWorkDirector(() => 0);
  const walkers = new Map([['builder', mkWalker(SEATS.builder)]]);
  const agents = { builder: agent('seat', SEATS.builder, 'engineering') };
  work.sync(agents, walkers, false);
  const w = walkers.get('builder');
  work.tick(0, agents, walkers);
  assert.equal(work.bob('builder', w, 0), 0);
  assert.equal(work.bob('builder', w, WORK.bobMs), 1);
  assert.equal(work.bob('builder', w, 2 * WORK.bobMs), 0);
  const now = 250, wake = work.nextWake(walkers, now);
  assert.ok(wake > now && wake <= WORK.bobMs);
  assert.deepEqual(planWake({ reduced: false, hidden: false, moving: false, busy: false, wake, now }), { frame: false, timerMs: wake - now });
  w.queue = ['in_engineering'];
  assert.equal(work.bob('builder', w, WORK.bobMs), 0);
  assert.equal(work.nextWake(walkers, now), Infinity);
  assert.equal(workBob(undefined, w, WORK.bobMs), 0);
});

test('AC-1: no work point stands on the merging or awaiting-merge regions or on a monitor', async () => {
  const { STAGE_REGIONS, MONITORS } = await import('../factory/office-map.js');
  const boxes = [STAGE_REGIONS.merging, STAGE_REGIONS['awaiting-merge'], ...MONITORS];
  for (const p of Object.values(ROOM_POINTS).flat()) {
    for (const b of boxes) assert.ok(!(p.x > b.x - 6 && p.x < b.x + b.w + 20 && p.y > b.y - 8 && p.y < b.y + b.h + 16), `${p.node} clear of ${JSON.stringify(b)}`);
  }
});
