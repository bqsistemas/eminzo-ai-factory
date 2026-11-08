import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, STAGE_COLUMNS, activeAgents, laneTone } from '../factory/activity.js';
import { AVATARS } from '../factory/avatars.js';
import { AREAS, CHARACTER_FOR, LOUNGE_SPOTS, MAP, MEETING_SEATS, SEATS, SPRITES, WAYPOINTS,
  areaForStage, areaTone, bubbleText, describeOffice, formatCost, headerStats, hitTargets, layoutOffice, officeState, route,
} from '../factory/office.js';
import { COLLISIONS } from '../factory/office-map.js';
import { segmentClear } from '../factory/office-navigation.js';

const job = (id, stage, extra = {}) => ({ id, stage, issue: Number(id.replace(/\D/g, '')) || undefined, started: '2026-01-01T00:00:00Z', ...extra });

test('AC-1: headerStats counts jobs, running, agents and valid costs', () => {
  const jobs = [
    job('j1', 'intake', { cost_usd: 1.5 }), job('j2', 'needs-info', { cost_usd: -3 }), job('j3', 'build', { cost_usd: '9' }),
    job('j4', 'review', { reviews: { ux: 'pending', code: 'pending', ui: 'PASS' }, cost_usd: 0.5 }),
    job('j5', 'merging'), job('j6', 'awaiting-merge'), job('j7', 'merged', { cost_usd: 1 }), job('j8', 'bogus'),
  ];
  const s = headerStats(jobs);
  assert.equal(s.total, 8);
  assert.equal(s.running, 6);
  assert.equal(s.agents, jobs.reduce((n, j) => n + activeAgents(j).length, 0));
  assert.equal(s.cost, 3);
  assert.deepEqual(headerStats(null), { total: 0, running: 0, agents: 0, cost: 0 });
  assert.equal(formatCost(3.149), '$3.15');
});

test('AC-2: officeState places agents and builds bubbles', () => {
  const jobs = [job('j23', 'build', { round: 2 }), job('j1', 'intake'), job('j2', 'intake')];
  const st = officeState(jobs);
  assert.deepEqual(Object.keys(st.agents).sort(), Object.keys(AGENTS).sort());
  const b = st.agents.builder;
  assert.equal(b.place, 'seat');
  assert.equal(b.node, SEATS.builder);
  assert.equal(b.area, 'engineering');
  assert.equal(b.bubble, 'Build · #23 · R2 · implementing');
  assert.equal(st.agents.intake.bubble, 'Intake · ×2 · triaging');
  for (const a of Object.keys(AGENTS)) {
    if (a === 'builder' || a === 'intake') continue;
    assert.equal(st.agents[a].place, 'lounge');
    assert.equal(st.agents[a].node, LOUNGE_SPOTS[a]);
    assert.equal(st.agents[a].bubble, ({ 'spec-writer':'Spec', builder:'Build', 'review-security':'Sec', 'review-ux':'UX', 'review-ui':'UI', 'review-code':'Code', approver:'Appr.' }[a] || AGENTS[a].label));
  }
  assert.doesNotThrow(() => officeState(null));
  assert.doesNotThrow(() => officeState([null, 5, { stage: 7 }]));
  const evil = officeState([{ id: '<img>', stage: 'build', issue: '<b>', round: '<i>' }, { id: 'x', stage: '<script>' }]);
  for (const a of Object.values(evil.agents)) assert.ok(!a.bubble.includes('<'));
});

test('AC-3: review meeting for two or more pending reviewers', () => {
  const st = officeState([job('j5', 'review', { reviews: { security: 'PASS', ux: 'pending', code: 'pending' } })]);
  assert.deepEqual(st.meeting, { jobId: 'j5', issue: 5, members: ['review-ux', 'review-code'] });
  for (const m of st.meeting.members) {
    assert.equal(st.agents[m].place, 'meeting');
    assert.equal(st.agents[m].node, MEETING_SEATS[m]);
  }
  const one = officeState([job('j5', 'review', { reviews: { ux: 'pending' } })]);
  assert.equal(one.meeting, null);
  assert.equal(one.agents['review-ux'].place, 'seat');
  const two = officeState([
    job('j9', 'review', { started: '2026-03-01T00:00:00Z', reviews: { ux: 'pending', ui: 'pending' } }),
    job('j8', 'review', { started: '2026-02-01T00:00:00Z', reviews: { code: 'pending', security: 'pending' } }),
  ]);
  assert.equal(two.meeting.jobId, 'j8');
  assert.equal(two.agents['review-ux'].place, 'seat');
});

test('AC-4: areas, tones, tokens, archive and gate', () => {
  const expected = { intake: 'research', 'needs-info': 'needs-info', 'spec-review': 'needs-info', spec: 'engineering', build: 'engineering', gate: 'gate',
    review: 'review', approve: 'release', merging: 'release', 'awaiting-merge': 'release', 'needs-human': 'escalation',
    merged: 'archive', rejected: 'archive' };
  for (const [stage] of STAGE_COLUMNS) assert.equal(areaForStage(stage), expected[stage], stage);
  for (const bad of ['bogus', null, 42]) assert.equal(areaForStage(bad), 'research');
  for (const a of AREAS) assert.equal(areaTone(a.id), a.stages.length ? laneTone(a.stages[0]) : 'neutral');
  assert.equal(areaTone('nope'), 'neutral');
  const st = officeState([job('j1', 'spec'), job('j2', 'gate'), job('j13', 'needs-human'), job('j4', 'merged'), job('j5', 'merged'), job('j6', 'rejected')]);
  assert.deepEqual(st.tokens.engineering.map((t) => t.label), ['#1']);
  assert.deepEqual(st.tokens.gate.map((t) => t.label), ['#2']);
  assert.deepEqual(st.escalation.map((t) => t.label), ['#13']);
  assert.deepEqual(st.archive, { merged: 2, rejected: 1 });
  assert.equal(st.gate.lit, true);
  assert.equal(st.gate.result, null);
  const off = officeState([job('j7', 'review', { gate: 'FAIL' })]);
  assert.deepEqual(off.gate, { lit: false, result: 'FAIL', status: 'FAIL' });
});

test('AC-5: map data is consistent and routable', () => {
  const r = AREAS.map((a) => a.rect);
  for (const { x, y, w, h } of r) {
    assert.ok([x, y, w, h].every(Number.isInteger));
    assert.ok(x >= 0 && y >= 0 && x + w <= MAP.width && y + h <= MAP.height);
  }
  r.forEach((a, i) => r.slice(i + 1).forEach((b) => assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)));
  const area = (id) => AREAS.find((a) => a.id === id).rect;
  const inside = (id, node) => {
    const p = WAYPOINTS.nodes[node], q = area(id);
    return p.x >= q.x && p.x < q.x + q.w && p.y >= q.y && p.y < q.y + q.h;
  };
  const home = { intake: 'research', 'spec-writer': 'engineering', builder: 'engineering', approver: 'release' };
  for (const a of Object.keys(AGENTS)) {
    assert.ok(inside(home[a] || 'review', SEATS[a]), `seat ${a}`);
    assert.ok(inside('lounge', LOUNGE_SPOTS[a]), `lounge ${a}`);
    assert.ok(AVATARS[`eminzo-${a}`].color);
    assert.ok(Object.hasOwn(SPRITES, CHARACTER_FOR[a]));
  }
  for (const n of Object.values(MEETING_SEATS)) assert.ok(inside('review', n));
  const ids = Object.keys(WAYPOINTS.nodes);
  const edges = new Set(WAYPOINTS.edges.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  for (const [a, b] of WAYPOINTS.edges) assert.ok(ids.includes(a) && ids.includes(b));
  for (const from of ids) for (const to of ids) {
    const p = route(from, to);
    assert.equal(p[0], from);
    assert.equal(p.at(-1), to);
    for (let i = 1; i < p.length; i++) assert.ok(edges.has(`${p[i - 1]}|${p[i]}`));
  }
  assert.deepEqual(route('x', 'nope'), []);
  for (const { x, y, w, h } of Object.values(SPRITES)) {
    assert.ok([x, y, w, h].every(Number.isInteger) && x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 768 && y + h <= 512);
  }
});

test('AC-6: hit targets and the accessible description', () => {
  const jobs = [job('j23', 'build', { round: 2, started: '2026-01-02T00:00:00Z' }), job('j20', 'build'), job('j13', 'needs-human'),
    job('j4', 'merged'), job('j5', 'rejected'), job('j7', 'review', { reviews: { ux: 'pending' } })];
  const st = officeState(jobs);
  const hits = hitTargets(st, jobs);
  const builder = hits.find((h) => h.kind === 'agent' && h.key === 'builder');
  assert.equal(builder.jobId, 'j20');
  assert.match(builder.label, /Builder/);
  const tokenCount = Object.values(st.tokens).flat().length + st.escalation.length;
  assert.equal(hits.filter((h) => h.kind === 'token').length, tokenCount);
  const areas = hits.filter((h) => h.kind === 'area').map((h) => h.key).sort();
  assert.deepEqual(areas, ['archive', 'engineering', 'escalation', 'review']);
  assert.equal(hits.find((h) => h.kind === 'area' && h.key === 'engineering').jobId, 'j20');
  assert.ok(!hits.some((h) => h.kind === 'agent' && h.key === 'intake'));
  assert.ok(!hits.some((h) => h.key === 'lounge'));
  const lines = describeOffice(st);
  for (const a of Object.keys(AGENTS)) assert.ok(lines.some((l) => l.startsWith(`${AGENTS[a].label} in `)), a);
  assert.ok(lines.some((l) => /^Builder in Spec \/ Build: .*#20/.test(l)));
  assert.ok(lines.includes('Intake in Lounge · available agents: idle'));
  assert.equal(bubbleText('nobody', []), '');
  assert.deepEqual(hitTargets(null, null), []);
  assert.deepEqual(describeOffice(null), []);
});

test('duplicate or malformed board jobs cannot create duplicate clickable office tokens', () => {
  const jobs = [job('duplicate', 'needs-info', { issue: 420, round: 2 }), job('duplicate', 'build', { issue: 421 })];
  const state = officeState(jobs);
  const tokens = [...Object.values(state.tokens).flat(), ...state.escalation];
  assert.equal(tokens.length, 1);
  assert.deepEqual(tokens[0], { jobId: 'duplicate', stage: 'needs-info', round: 2, label: '#420 R2' });
  assert.equal(hitTargets(state, jobs).filter((hit) => hit.kind === 'token').length, 1);
  assert.doesNotThrow(() => officeState([null, undefined, [], { id: '', stage: 'needs-human' }]));
});
