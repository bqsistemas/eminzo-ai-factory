import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREAS, COLLISIONS, LOUNGE_POINTS, LOUNGE_SPOTS, WAYPOINTS } from '../factory/office-map.js';
import { route } from '../factory/office-navigation.js';
import { WALK_SPEED, WANDER_SPEED, advanceWalker, segmentClear } from '../factory/office-navigation.js';
import { WANDER, createWander, stepWander, createWanderDirector, sofaLift } from '../factory/office-wander.js';

const lounge = AREAS.find((a) => a.id === 'lounge').rect;
const inside = (p) => p.x > lounge.x + 6 && p.x < lounge.x + lounge.w - 6 && p.y > lounge.y + 30 && p.y < lounge.y + lounge.h - 6;
const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };
const home = LOUNGE_SPOTS.intake;
const base = { moving: false, home, taken: [] };

test('points of interest are inside the lounge, collision-free and reachable', () => {
  assert.ok(LOUNGE_POINTS.length >= 4);
  for (const p of LOUNGE_POINTS) {
    const n = WAYPOINTS.nodes[p.node];
    assert.ok(n && inside(n), p.id);
    assert.ok(COLLISIONS.every((c) => !(n.x > c.x - 5 && n.x < c.x + c.w + 5 && n.y > c.y - 5 && n.y < c.y + c.h + 5)), `${p.id} clear`);
    const r = route('in_lounge', p.node);
    assert.ok(r.length > 1 && r.every((id) => id.includes('lounge') || id === p.node), `${p.id} route stays in lounge`);
    for (let i = 1; i < r.length; i++) assert.ok(segmentClear(WAYPOINTS.nodes[r[i - 1]], WAYPOINTS.nodes[r[i]], COLLISIONS, 5), `${p.id} edge clear`);
    const slots = Object.values(LOUNGE_SPOTS).map((s) => WAYPOINTS.nodes[s]);
    for (const s of slots) assert.ok(Math.hypot(s.x - n.x, s.y - n.y) >= 28, `${p.id} not on a home slot`);
  }
  const ids = LOUNGE_POINTS.map((p) => p.id);
  for (const want of ['water', 'snacks', 'sofa-blue', 'sofa-green', 'table']) assert.ok(ids.includes(want), want);
});

test('wander speed is slower than the work-walk speed', () => {
  assert.ok(WANDER_SPEED < WALK_SPEED);
  const mk = () => ({ ...WAYPOINTS.nodes.lounge_1, node: 'lounge_1', queue: ['lounge_turn_0', 'lounge_spine'] });
  const a = mk(), b = mk();
  advanceWalker(a, 0.1); advanceWalker(b, 0.1, WANDER_SPEED);
  const d = (w) => Math.hypot(w.x - WAYPOINTS.nodes.lounge_1.x, w.y - WAYPOINTS.nodes.lounge_1.y);
  assert.ok(d(b) < d(a));
});

test('first tick schedules a rest inside the configured range', () => {
  const s = stepWander(createWander(), { ...base, now: 1000, rng: () => 0 });
  assert.equal(s.phase, 'rest');
  assert.equal(s.until, 1000 + WANDER.restMs[0]);
  const t = stepWander(createWander(), { ...base, now: 1000, rng: () => 0.999999 });
  assert.ok(t.until <= 1000 + WANDER.restMs[1]);
});

test('rest expiry picks a known point or pauses; never early', () => {
  let s = stepWander(createWander(), { ...base, now: 0, rng: () => 0 });
  const early = stepWander(s, { ...base, now: s.until - 1, rng: () => 0 });
  assert.equal(early.phase, 'rest');
  assert.equal(early.until, s.until);
  const go = stepWander(s, { ...base, now: s.until, rng: seq(0, 0) });
  assert.equal(go.phase, 'walk');
  assert.ok(LOUNGE_POINTS.some((p) => p.node === go.target));
  const pause = stepWander(s, { ...base, now: s.until, rng: seq(0.99, 0) });
  assert.equal(pause.phase, 'rest');
  assert.ok(pause.until - s.until >= WANDER.pauseMs[0] && pause.until - s.until <= WANDER.pauseMs[1]);
});

test('never targets a point another agent already holds', () => {
  const s = { ...createWander(), phase: 'rest', until: 0, target: home };
  const taken = LOUNGE_POINTS.slice(1).map((p) => p.node);
  for (const r of [0, 0.3, 0.6, 0.99]) {
    const n = stepWander(s, { ...base, now: 1, taken, rng: seq(0, r) });
    assert.equal(n.target, LOUNGE_POINTS[0].node);
  }
  const all = stepWander(s, { ...base, now: 1, taken: LOUNGE_POINTS.map((p) => p.node), rng: seq(0, 0) });
  assert.equal(all.phase, 'rest');
});

test('arrival starts a dwell within range, then moves on or goes home', () => {
  const poi = LOUNGE_POINTS[0];
  const walking = { phase: 'walk', target: poi.node, until: 0, pose: poi.pose };
  const still = stepWander(walking, { ...base, now: 500, moving: true, rng: () => 0 });
  assert.equal(still.phase, 'walk');
  const dwell = stepWander(walking, { ...base, now: 500, rng: () => 0 });
  assert.equal(dwell.phase, 'dwell');
  assert.equal(dwell.until, 500 + WANDER.dwellMs[0]);
  const next = stepWander(dwell, { ...base, now: dwell.until, rng: seq(0, 0) });
  assert.equal(next.phase, 'walk');
  assert.equal(next.target, home);
  const other = stepWander(dwell, { ...base, now: dwell.until, rng: seq(0.99, 0) });
  assert.equal(other.phase, 'walk');
  assert.notEqual(other.target, poi.node);
  assert.ok(LOUNGE_POINTS.some((p) => p.node === other.target));
  const back = stepWander(next, { ...base, now: 9000, rng: () => 0 });
  assert.equal(back.phase, 'rest');
  assert.equal(back.target, home);
});

test('does not decide while the walker is still moving (e.g. returning from work)', () => {
  const s = { ...createWander(), phase: 'rest', until: 0, target: home };
  const n = stepWander(s, { ...base, now: 99999, moving: true, rng: () => 0 });
  assert.equal(n.phase, 'rest');
  assert.equal(n.target, home);
});

test('configured ranges are sane', () => {
  for (const k of ['restMs', 'dwellMs', 'pauseMs']) assert.ok(WANDER[k][0] > 0 && WANDER[k][0] < WANDER[k][1], k);
  assert.ok(WANDER.poiChance > 0 && WANDER.poiChance < 1);
});

const walkerAt = (node) => ({ ...WAYPOINTS.nodes[node], node, target: node, queue: [] });
const homes = Object.keys(LOUNGE_SPOTS);
const agentsAt = (place = 'lounge') => Object.fromEntries(homes.map((a) => [a, place === 'lounge' ? { place, node: LOUNGE_SPOTS[a] } : { place: 'seat', node: 'seat_builder' }]));
const mkWalkers = () => new Map(homes.map((a) => [a, walkerAt(LOUNGE_SPOTS[a])]));

test('table point is off the spine and every route pair is lounge-local and clear', () => {
  const spine = WAYPOINTS.nodes.lounge_spine;
  const table = WAYPOINTS.nodes[LOUNGE_POINTS.find((p) => p.id === 'table').node];
  assert.ok(Math.hypot(table.x - spine.x, table.y - spine.y) >= 28);
  const from = [...Object.values(LOUNGE_SPOTS), ...LOUNGE_POINTS.map((p) => p.node)];
  for (const a of from) for (const p of LOUNGE_POINTS) {
    if (a === p.node) continue;
    const r = route(a, p.node);
    assert.ok(r.length > 1, `${a} -> ${p.node}`);
    for (let i = 0; i < r.length; i++) {
      assert.ok(r[i].includes('lounge'), `${a} -> ${p.node} leaves lounge via ${r[i]}`);
      assert.ok(inside(WAYPOINTS.nodes[r[i]]));
      if (i) assert.ok(segmentClear(WAYPOINTS.nodes[r[i - 1]], WAYPOINTS.nodes[r[i]], COLLISIONS, 5), `${r[i - 1]} -> ${r[i]}`);
    }
  }
});

test('minGap: a point crowding another agent target is not picked', () => {
  const s = { ...createWander(), phase: 'rest', until: 0, target: home };
  const a = LOUNGE_POINTS[0];
  const crowd = Object.values(LOUNGE_SPOTS).find((n) => Math.hypot(WAYPOINTS.nodes[n].x - a.x, WAYPOINTS.nodes[n].y - a.y) < WANDER.minGap + 6) ?? LOUNGE_SPOTS.approver;
  const fake = 'lounge_fake';
  WAYPOINTS.nodes[fake] = { x: a.x + WANDER.minGap - 4, y: a.y };
  try {
    for (const r of [0, 0.2, 0.5, 0.9]) {
      const n = stepWander(s, { ...base, now: 1, taken: [fake], rng: seq(0, r) });
      assert.notEqual(n.target, a.node);
    }
  } finally { delete WAYPOINTS.nodes[fake]; }
  assert.ok(crowd);
});

test('sofa lift eases with distance and is zero elsewhere', () => {
  const sofa = LOUNGE_POINTS.find((p) => p.id === 'sofa-blue'), water = LOUNGE_POINTS.find((p) => p.id === 'water');
  assert.equal(sofaLift({ x: sofa.x, y: sofa.y }), 7);
  const mid = sofaLift({ x: sofa.x + 5, y: sofa.y });
  assert.ok(mid > 0 && mid < 7);
  assert.equal(sofaLift({ x: sofa.x + 40, y: sofa.y }), 0);
  assert.equal(sofaLift({ x: water.x, y: water.y }), 0);
});

test('director: activation drops wandering, walks to work at normal speed', () => {
  const walkers = mkWalkers(), d = createWanderDirector(() => 0);
  d.sync(agentsAt(), walkers, false);
  assert.equal(d.size, homes.length);
  // intake leaves home for a point
  let now = 0;
  while (!walkers.get('intake').queue.length && now < 60000) { now += 100; d.tick(now, agentsAt(), walkers); }
  assert.ok(walkers.get('intake').queue.length);
  assert.equal(d.speed('intake', walkers.get('intake')), WANDER_SPEED);
  const agents = agentsAt(); agents.intake = { place: 'seat', node: 'seat_builder' };
  d.sync(agents, walkers, false);
  assert.equal(d.state('intake'), undefined);
  const w = walkers.get('intake');
  assert.equal(w.target, 'seat_builder');
  assert.equal(w.queue.at(-1), 'seat_builder');
  assert.equal(d.speed('intake', w), WALK_SPEED);
  assert.equal(d.size, homes.length - 1);
});

test('director: returning from work is normal speed, then wanders', () => {
  const walkers = new Map([['intake', walkerAt('seat_builder')]]);
  const d = createWanderDirector(() => 0);
  d.sync({ intake: { place: 'lounge', node: LOUNGE_SPOTS.intake } }, walkers, false);
  const w = walkers.get('intake');
  assert.ok(w.queue.length);
  assert.equal(d.speed('intake', w), WALK_SPEED);
  assert.equal(d.nextWake(walkers), Infinity);
});

test('director: reduced motion on -> off leaves agents home then resumes wandering', () => {
  const walkers = mkWalkers(), d = createWanderDirector(() => 0);
  d.sync(agentsAt(), walkers, false);
  let now = 0;
  while (![...walkers.values()].some((w) => w.queue.length) && now < 60000) { now += 100; d.tick(now, agentsAt(), walkers); }
  d.sync(agentsAt(), walkers, true);
  assert.equal(d.size, 0);
  for (const [a, w] of walkers) assert.deepEqual({ x: w.x, y: w.y, q: w.queue.length }, { ...WAYPOINTS.nodes[LOUNGE_SPOTS[a]], q: 0 });
  assert.equal(d.nextWake(walkers), Infinity);
  d.sync(agentsAt(), walkers, false);
  assert.equal(d.size, homes.length);
  for (const w of walkers.values()) assert.equal(w.queue.length, 0);
  now = 0;
  while (![...walkers.values()].some((w) => w.queue.length) && now < 60000) { now += 100; d.tick(now, agentsAt(), walkers); }
  assert.ok([...walkers.values()].some((w) => w.queue.length));
});

test('director: a wander walk with no route reverts to rest at home', () => {
  const walkers = new Map([['intake', walkerAt(home)]]);
  const d = createWanderDirector(() => 0);
  d.sync({ intake: { place: 'lounge', node: home } }, walkers, false);
  d.set('intake', { phase: 'dwell', target: LOUNGE_POINTS[0].node, until: 0, pose: 'stand' });
  d.tick(10, { intake: { place: 'lounge', node: home } }, walkers);
  assert.equal(d.state('intake').phase, 'rest');
  assert.equal(d.state('intake').target, home);
});

test('director: speed is slow only while on a wander-issued walk', () => {
  const walkers = new Map([['intake', walkerAt(home)]]);
  const d = createWanderDirector(() => 0);
  d.sync({ intake: { place: 'lounge', node: home } }, walkers, false);
  const w = walkers.get('intake');
  d.set('intake', { phase: 'walk', target: LOUNGE_POINTS[0].node, until: 0, pose: 'stand' });
  w.target = LOUNGE_POINTS[1].node;
  assert.equal(d.speed('intake', w), WALK_SPEED);
  w.target = LOUNGE_POINTS[0].node;
  assert.equal(d.speed('intake', w), WANDER_SPEED);
  d.set('intake', { phase: 'rest', target: home, until: 5, pose: 'stand' });
  assert.equal(d.speed('intake', w), WALK_SPEED);
});

test('director: nextWake is the earliest timer of settled agents', () => {
  const walkers = new Map([['intake', walkerAt(home)], ['spec-writer', walkerAt(LOUNGE_SPOTS['spec-writer'])]]);
  const d = createWanderDirector(() => 0);
  const ag = { intake: { place: 'lounge', node: home }, 'spec-writer': { place: 'lounge', node: LOUNGE_SPOTS['spec-writer'] } };
  d.sync(ag, walkers, false);
  assert.equal(d.nextWake(walkers), 0);
  d.set('intake', { phase: 'rest', target: home, until: 900, pose: 'stand' });
  d.set('spec-writer', { phase: 'dwell', target: LOUNGE_POINTS[0].node, until: 500, pose: 'stand' });
  assert.equal(d.nextWake(walkers), 500);
});
