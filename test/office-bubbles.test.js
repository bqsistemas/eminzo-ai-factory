import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SPRITES } from '../factory/sprite-atlas.js';
import { AREAS, COLLISIONS, FURNITURE, LOUNGE_POINTS, LOUNGE_SPOTS, SHORT, WAYPOINTS } from '../factory/office-map.js';
import { segmentClear } from '../factory/office-navigation.js';
import { BUBBLES, BUBBLE_AREAS, BUBBLE_TIMING, createBubbleDirector } from '../factory/office-bubbles.js';
import { planWake } from '../factory/office-wander.js';

const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
const agents = (extra = {}) => ({
  builder: { place: 'seat', area: 'engineering', node: 'seat_builder' },
  'review-ux': { place: 'seat', area: 'review', node: 'seat_ux' },
  'review-code': { place: 'meeting', area: 'review', node: 'meet_code' },
  intake: { place: 'seat', area: 'research', node: 'seat_intake' },
  approver: { place: 'seat', area: 'release', node: 'seat_approver' },
  'spec-writer': { place: 'lounge', area: 'lounge', node: LOUNGE_SPOTS['spec-writer'] },
  ...extra,
});
const still = { queue: [] };

test('atlas registers the four bubble and the lounge decor sprites at the measured rects', () => {
  const want = {
    bubbleThink: [642, 67, 18, 17], bubbleAlert: [672, 66, 19, 20], bubbleIdea: [702, 66, 18, 19], bubbleDone: [733, 66, 18, 20],
    armchairOrange: [237, 190, 19, 25], armchairBlue: [375, 186, 21, 30], plantSmall: [208, 183, 18, 32], plantPot: [297, 184, 17, 32],
  };
  const json = JSON.parse(readFileSync(new URL('../factory/assets/pixel-office-2/atlas.json', import.meta.url)));
  for (const [k, [x, y, w, h]] of Object.entries(want)) {
    assert.deepEqual(SPRITES[k], { x, y, w, h }, k);
    assert.deepEqual(json.sprites[k], { x, y, w, h }, `${k} in atlas.json`);
  }
  for (const b of Object.values(BUBBLES)) assert.ok(SPRITES[b.sprite]);
});

test('only working agents in review and spec/build rooms are eligible', () => {
  const d = createBubbleDirector(() => 0);
  d.sync(agents(), false);
  assert.deepEqual(d.ids().sort(), ['builder', 'review-code', 'review-ux']);
  assert.deepEqual(BUBBLE_AREAS.sort(), ['engineering', 'review']);
});

test('reduced motion: no bubbles at all; activation/leaving drops them', () => {
  const d = createBubbleDirector(() => 0);
  d.sync(agents(), true);
  assert.equal(d.ids().length, 0);
  assert.equal(d.nextWake(), Infinity);
  d.sync(agents(), false);
  assert.equal(d.ids().length, 3);
  d.sync(agents({ builder: { place: 'lounge', area: 'lounge', node: LOUNGE_SPOTS.builder } }), false);
  assert.equal(d.get('builder', still), null);
  assert.equal(d.ids().includes('builder'), false);
});

test('cycle: staggered start, show within range, hide, random gap, repeat', () => {
  const d = createBubbleDirector(seq(0.5, 0.2, 0.4, 0.6, 0.3, 0.7, 0.5, 0.9));
  d.sync({ builder: agents().builder }, false);
  d.tick(0);
  assert.equal(d.get('builder', still), null);
  const start = d.nextWake();
  assert.ok(start > 0 && start >= BUBBLE_TIMING.staggerMs[0] && start <= BUBBLE_TIMING.staggerMs[1]);
  d.tick(start - 1); assert.equal(d.get('builder', still), null);
  d.tick(start);
  const kind = d.get('builder', still);
  assert.ok(kind in BUBBLES);
  const hideAt = d.nextWake();
  assert.ok(hideAt - start >= BUBBLE_TIMING.showMs[0] && hideAt - start <= BUBBLE_TIMING.showMs[1]);
  d.tick(hideAt);
  assert.equal(d.get('builder', still), null);
  const gap = d.nextWake() - hideAt;
  assert.ok(gap >= BUBBLE_TIMING.gapMs[0] && gap <= BUBBLE_TIMING.gapMs[1]);
  d.tick(d.nextWake());
  assert.ok(d.get('builder', still) in BUBBLES);
});

test('hidden while the agent is walking', () => {
  const d = createBubbleDirector(() => 0);
  d.sync({ builder: agents().builder }, false);
  d.tick(0); d.tick(d.nextWake());
  assert.ok(d.get('builder', still));
  assert.equal(d.get('builder', { queue: ['x'] }), null);
});

test('weighted pick: thinking is the most common', () => {
  const total = Object.values(BUBBLES).reduce((n, b) => n + b.weight, 0);
  const top = Object.entries(BUBBLES).sort((a, b) => b[1].weight - a[1].weight)[0][0];
  assert.equal(top, 'think');
  const d = createBubbleDirector(() => 0);
  assert.equal(d.pick(() => 0), 'think');
  assert.equal(d.pick(() => 0.999999), 'done');
  let think = 0;
  for (let i = 0; i < total * 10; i++) if (d.pick(() => i / (total * 10)) === 'think') think++;
  assert.ok(think > total * 10 / Object.keys(BUBBLES).length);
});

test('at most maxConcurrent bubbles are visible at once', () => {
  const d = createBubbleDirector(() => 0);
  const a = agents({ 'review-security': { place: 'seat', area: 'review', node: 'seat_sec' }, 'review-ui': { place: 'seat', area: 'review', node: 'seat_ui' } });
  d.sync(a, false);
  d.tick(0);
  for (let t = 0; t < 40000; t += 250) {
    d.tick(t);
    const visible = d.ids().filter((id) => d.get(id, still)).length;
    assert.ok(visible <= BUBBLE_TIMING.maxConcurrent, `t=${t}`);
  }
});

test('nextWake is Infinity with nothing eligible', () => {
  const d = createBubbleDirector(() => 0);
  d.sync({ 'spec-writer': agents()['spec-writer'] }, false);
  assert.equal(d.nextWake(), Infinity);
});

test('lounge decor: collision-registered, inside the lounge, clear of slots, POIs, aisles and routes', () => {
  const lounge = AREAS.find((a) => a.id === 'lounge').rect;
  const decor = FURNITURE.filter((f) => ['armchairOrange', 'armchairBlue', 'plantSmall', 'plantPot'].includes(f.sprite));
  assert.ok(decor.length >= 3 && decor.some((f) => f.sprite.startsWith('armchair')) && decor.some((f) => f.sprite.startsWith('plant')));
  for (const f of decor) {
    assert.ok(f.x > lounge.x + 6 && f.x + f.w < lounge.x + lounge.w - 6 && f.y >= lounge.y + 30 && f.y + f.h <= lounge.y + lounge.h - 6, f.sprite);
    assert.ok(COLLISIONS.some((c) => c.kind === 'furniture' && c.x === f.x && c.y === f.y), `${f.sprite} collides`);
    const nodes = [...Object.values(LOUNGE_SPOTS), ...LOUNGE_POINTS.map((p) => p.node), 'lounge_spine', 'in_lounge', 'lounge_turn_0', 'lounge_turn_1', 'lounge_turn_2', 'lounge_turn_3'];
    for (const id of nodes) {
      const n = WAYPOINTS.nodes[id];
      assert.ok(!(n.x > f.x - 5 && n.x < f.x + f.w + 5 && n.y > f.y - 5 && n.y < f.y + f.h + 5), `${f.sprite} blocks ${id}`);
    }
    // Agents standing at a slot or point (body 24x34, label below) must not overlap decor either.
    for (const id of [...Object.values(LOUNGE_SPOTS), ...LOUNGE_POINTS.map((p) => p.node)]) {
      const n = WAYPOINTS.nodes[id];
      const body = { x: n.x - 12, y: n.y - 34, w: 24, h: 34 + 16 };
      assert.ok(f.x >= body.x + body.w || f.x + f.w <= body.x || f.y >= body.y + body.h || f.y + f.h <= body.y, `${f.sprite} overlaps agent at ${id}`);
    }
    // Name labels (>= 30 wide, centred on the agent, y-4..y+16) keep a real margin from decor.
    const labelled = [...Object.entries(LOUNGE_SPOTS).map(([a, id]) => [id, SHORT[a]]), ...LOUNGE_POINTS.map((p) => [p.node, 'MMMMM'])];
    for (const [id, text] of labelled) {
      const n = WAYPOINTS.nodes[id], half = Math.max(30, text.length * 7.2 + 12) / 2, m = 3;
      const l = { x: n.x - half - m, y: n.y - 4 - m, w: half * 2 + 2 * m, h: 20 + 2 * m };
      assert.ok(f.x >= l.x + l.w || f.x + f.w <= l.x || f.y >= l.y + l.h || f.y + f.h <= l.y, `${f.sprite} too close to label at ${id}`);
    }
  }
  for (const [a, b] of WAYPOINTS.edges) {
    if (!a.includes('lounge') || !b.includes('lounge')) continue;
    assert.ok(segmentClear(WAYPOINTS.nodes[a], WAYPOINTS.nodes[b], COLLISIONS, 5), `${a}-${b}`);
  }
});

const five = () => agents({ 'review-security': { place: 'seat', area: 'review', node: 'seat_sec' }, 'review-ui': { place: 'seat', area: 'review', node: 'seat_ui' } });

test('walking agents neither count toward the cap nor advance; arrival gets a fresh delay', () => {
  const d = createBubbleDirector(() => 0);
  d.sync(five(), false);
  const walking = new Set(['builder', 'review-ux']);
  const moving = (id) => walking.has(id);
  d.tick(0, moving);
  for (let t = 0; t <= 30000; t += 250) {
    d.tick(t, moving);
    // The two walkers must not hold cap slots: the other two can both show.
  }
  const shown = ['review-code', 'review-security', 'review-ui'].filter((id) => d.get(id, still)).length;
  assert.ok(shown >= 1);
  for (const id of walking) assert.equal(d.get(id, still), null);
  // Walkers arrive: no bubble the instant they stop.
  walking.clear();
  d.tick(30250, moving);
  assert.equal(d.get('builder', still), null);
  assert.equal(d.get('review-ux', still), null);
  const wake = d.nextWake();
  assert.ok(wake > 30250);
});

test('walkers holding bubbles do not starve the stationary agents', () => {
  const d = createBubbleDirector(() => 0);
  d.sync(five(), false);
  const walking = new Set(['builder', 'review-ux']);
  let seen = new Set();
  for (let t = 0; t <= 60000; t += 250) {
    d.tick(t, (id) => walking.has(id));
    for (const id of ['review-code', 'review-security', 'review-ui']) if (d.get(id, still)) seen.add(id);
  }
  assert.equal(seen.size, 3);
});

test('cap fairness: every agent eventually gets a bubble with more agents than slots', () => {
  const r = seq(0.1, 0.9, 0.5, 0.3, 0.7);
  const d = createBubbleDirector(r);
  d.sync(five(), false);
  const shown = new Map();
  for (let t = 0; t <= 120000; t += 250) {
    d.tick(t, () => false);
    for (const id of d.ids()) if (d.get(id, still)) shown.set(id, (shown.get(id) ?? 0) + 1);
  }
  assert.equal(shown.size, 5);
  const counts = [...shown.values()];
  assert.ok(Math.max(...counts) <= Math.min(...counts) * 4 + 8, JSON.stringify([...shown]));
});

test('state resets when the agent changes room or seat', () => {
  const d = createBubbleDirector(() => 0);
  d.sync({ builder: agents().builder }, false);
  d.tick(0, () => false); d.tick(d.nextWake(), () => false);
  assert.ok(d.get('builder', still));
  d.sync({ builder: { place: 'seat', area: 'review', node: 'seat_sec' } }, false);
  assert.equal(d.get('builder', still), null);
  d.tick(0, () => false);
  assert.equal(d.get('builder', still), null);
});

test('planWake: timer always rearms when a frame is not needed (early fire cannot stall)', () => {
  const base = { reduced: false, hidden: false, moving: false, busy: false, now: 1000 };
  assert.deepEqual(planWake({ ...base, wake: 1000 }), { frame: true, timerMs: null });
  assert.deepEqual(planWake({ ...base, wake: 1002 }), { frame: true, timerMs: null });
  assert.deepEqual(planWake({ ...base, wake: 1500 }), { frame: false, timerMs: 500 });
  assert.deepEqual(planWake({ ...base, moving: true, wake: 1500 }), { frame: true, timerMs: null });
  assert.deepEqual(planWake({ ...base, busy: true, wake: Infinity }), { frame: true, timerMs: null });
  assert.deepEqual(planWake({ ...base, wake: Infinity }), { frame: false, timerMs: null });
  assert.deepEqual(planWake({ ...base, reduced: true, wake: 0 }), { frame: false, timerMs: null });
  assert.deepEqual(planWake({ ...base, hidden: true, wake: 0 }), { frame: false, timerMs: null });
});
