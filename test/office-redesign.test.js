import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { officeState, hitTargets, layoutOffice, LOUNGE_SPOTS, SEATS, WAYPOINTS, route } from '../factory/office.js';
import { COLLISIONS, DOORS, FURNITURE, MAP, MEETING_SEATS, AREAS, officeBackdrop, viewportOffice } from '../factory/office-map.js';
import { segmentClear, retargetWalker, advanceWalker } from '../factory/office-navigation.js';
const job = (id, stage, more = {}) => ({ id, issue: +id, stage, started: '2026-01-01', ...more });

test('new atlas has semantic source coordinates and eight documented role mappings', async () => {
  const m = JSON.parse(await readFile(new URL('../factory/assets/pixel-office-2/atlas.json', import.meta.url)));
  assert.deepEqual(m.sourceSize, { width: 768, height: 512 });
  assert.equal(Object.keys(m.characters).length, 8);
  for (const s of Object.values(m.sprites)) assert.ok(s.x >= 0 && s.y >= 0 && s.x+s.w <= 768 && s.y+s.h <= 512);
  assert.notDeepEqual(m.sprites.floorCorridor, m.sprites.floorTile);
  assert.match(m.substitutions.join(' '), /UI/);
});
test('all complete walk edges clear walls and furniture with a foot radius', () => {
  for (const [a,b] of WAYPOINTS.edges) assert.ok(segmentClear(WAYPOINTS.nodes[a], WAYPOINTS.nodes[b], COLLISIONS, 5), `${a} -> ${b}`);
  for (const [a,n] of Object.entries(LOUNGE_SPOTS)) assert.ok(route(n, SEATS[a]).some(x => x.startsWith('door_')));
  for (const d of DOORS) assert.ok(WAYPOINTS.nodes[`door_${d.id}`]);
});
test('all reachable seats and meeting points have radius-safe routes, including the release monitor', () => {
  const targets = [...Object.values(SEATS), ...Object.values(MEETING_SEATS)];
  for (const source of Object.values(LOUNGE_SPOTS)) {
    for (const target of targets) {
      const path = route(source, target);
      if (!path.length) continue;
      for (let i = 1; i < path.length; i++) {
        assert.ok(segmentClear(WAYPOINTS.nodes[path[i - 1]], WAYPOINTS.nodes[path[i]], COLLISIONS, 5), `${source} -> ${target}: ${path[i - 1]} -> ${path[i]}`);
      }
    }
  }
});
test('review workers use the computer-side anchors while meeting anchors stay at the table', () => {
  for (const role of ['review-security','review-ux','review-ui','review-code']) {
    assert.equal(WAYPOINTS.nodes[SEATS[role]].y, 425);
    assert.equal(WAYPOINTS.nodes[MEETING_SEATS[role]].y, 475);
  }
  assert.equal(FURNITURE.filter(f => f.sprite === 'deskDual' && f.y === 381).length, 4);
});
test('mid-edge reversal follows the current edge before changing route', () => {
  const from = LOUNGE_SPOTS.intake, to = SEATS.intake;
  const w = { ...WAYPOINTS.nodes[from], node: from, target: from, queue: [] };
  retargetWalker(w, to, false);
  advanceWalker(w, 0.1);
  const before = { x:w.x, y:w.y };
  retargetWalker(w, from, false);
  let count = 0;
  while(w.queue.length && count++ < 1000) { const a={x:w.x,y:w.y}; advanceWalker(w, 0.03); assert.ok(segmentClear(a,w,COLLISIONS,5)); }
  assert.equal(w.node, from); assert.ok(count<1000); assert.notDeepEqual(before, w);
  retargetWalker(w,to,true); assert.deepEqual({x:w.x,y:w.y},WAYPOINTS.nodes[to]); assert.equal(w.queue.length,0);
});
test('every in-flight edge can redirect to an agent destination without crossing geometry', () => {
  const targets = [...Object.values(LOUNGE_SPOTS), ...Object.values(SEATS), ...Object.values(MEETING_SEATS)];
  for (const [from, next] of WAYPOINTS.edges) {
    for (const [a, b] of [[from, next], [next, from]]) {
      for (const target of targets) {
        const start = WAYPOINTS.nodes[a];
        const w = { ...start, node:a, target:b, queue:[b] };
        advanceWalker(w, 0.08); // Midway through a 7.2 px segment.
        retargetWalker(w, target, false);
        let frames = 0;
        while (w.queue.length && frames++ < 200) {
          const before={x:w.x,y:w.y};
          advanceWalker(w, 0.1);
          assert.ok(segmentClear(before,w,COLLISIONS,5), `${a} via ${b} -> ${target}`);
        }
        assert.ok(frames < 200, `${a} via ${b} -> ${target} did not finish`);
        assert.equal(w.node,target);
      }
    }
  }
});
test('three jobs, partial reviews, rework history and parked tokens remain authoritative', () => {
  const jobs = [job('35','review',{round:2,reviews:{security:'pending',ux:'pending',ui:'PASS'}}),job('36','build'),job('37','gate'),job('38','needs-human'),job('39','awaiting-merge')];
  const s=officeState(jobs); assert.equal(Object.keys(s.agents).length,8);
  assert.equal(s.agents['review-security'].place,'meeting'); assert.equal(s.agents['review-ui'].place,'lounge');
  assert.equal(s.gate.status,'running');
  const tokens=[...Object.values(s.tokens).flat(),...s.escalation];
  assert.equal(tokens.length,5); assert.equal(new Set(tokens.map(t=>t.jobId)).size,5);
  assert.equal(tokens.find(t=>t.jobId==='35').label,'#35 R2');
  jobs[0].reviews.security='PASS'; const next=officeState(jobs);
  assert.equal(next.agents['review-security'].place,'lounge'); assert.equal(next.agents['review-ux'].place,'seat');
  const rework=officeState([job('35','build',{round:3,gate:null,history:[{round:2,gate:'FAIL'}]})]);
  assert.equal(rework.gate.status,'FAIL'); assert.equal(rework.tokens.engineering[0].stage,'build');
  assert.equal(officeState([job('2','merging')]).merging.status,'merging');
});
test('a reviewer leaves Review as soon as its verdict is recorded', () => {
  const state = officeState([job('37', 'review', { reviews: { security: 'PASS', ux: 'CHANGES', ui: 'PASS', code: 'PASS' } })]);
  for (const role of ['review-security', 'review-ux', 'review-ui', 'review-code']) {
    assert.equal(state.agents[role].place, 'lounge');
    assert.equal(state.agents[role].work.length, 0);
  }
  assert.equal(state.meeting, null);
});
test('issue 37 stage transitions retarget exactly one worker while parallel jobs stay independent', () => {
  const jobs = [
    job('030-restyle-dashboard-header-to', 'intake', { issue: 37 }),
    job('031-parallel-build', 'build', { issue: 38 }),
    job('032-parallel-review', 'review', { issue: 39, reviews: { security: 'pending', ux: 'PASS', code: 'pending' } }),
  ];
  const intake = officeState(jobs);
  assert.equal(intake.agents.intake.node, SEATS.intake);
  assert.equal(intake.agents['spec-writer'].node, LOUNGE_SPOTS['spec-writer']);
  assert.equal(intake.agents.builder.node, SEATS.builder);
  assert.equal(intake.agents['review-security'].node, MEETING_SEATS['review-security']);
  assert.equal(intake.agents['review-code'].node, MEETING_SEATS['review-code']);
  assert.equal(intake.agents['review-ux'].node, LOUNGE_SPOTS['review-ux']);
  assert.equal(Object.keys(intake.agents).length, 8);

  jobs[0] = { ...jobs[0], stage: 'spec' };
  const spec = officeState(jobs);
  assert.equal(spec.agents.intake.node, LOUNGE_SPOTS.intake);
  assert.equal(spec.agents['spec-writer'].node, SEATS['spec-writer']);
  assert.equal(spec.agents.builder.node, SEATS.builder);
  assert.equal(spec.agents['review-security'].node, MEETING_SEATS['review-security']);

  // Exercise the same route/retarget/advance sequence used by the canvas renderer.
  const walker = { ...WAYPOINTS.nodes[LOUNGE_SPOTS.intake], node: LOUNGE_SPOTS.intake, target: LOUNGE_SPOTS.intake, queue: [] };
  retargetWalker(walker, intake.agents.intake.node);
  assert.ok(walker.queue.length > 0, 'intake should leave Lounge when issue #37 enters intake');
  let frames = 0;
  while (walker.queue.length && frames++ < 1000) advanceWalker(walker, 0.1);
  assert.ok(frames < 1000);
  assert.equal(walker.node, SEATS.intake);
  retargetWalker(walker, spec.agents.intake.node);
  assert.ok(walker.queue.length > 0, 'intake should return to Lounge after issue #37 advances to spec');
  frames = 0;
  while (walker.queue.length && frames++ < 1000) advanceWalker(walker, 0.1);
  assert.ok(frames < 1000);
  assert.equal(walker.node, LOUNGE_SPOTS.intake);
});
test('running gate wins over stale verdict; stage subregions open oldest job', () => {
  const jobs=[job('2','build',{gate:'PASS'}),job('3','gate'),job('1','build',{started:'2025-01-01'})];
  assert.equal(officeState(jobs).gate.status,'running');
  const hits=hitTargets(officeState(jobs),jobs);
  assert.equal(hits.find(h=>h.kind==='stage'&&h.key==='build').jobId,'1');
});
test('map fits narrow panels proportionally and all idle agents have separated slots', () => {
  for (const width of [280,375,600,900]) { const l=layoutOffice(width,0); assert.ok(l.map.width*l.scale<=width); assert.equal(l.map.width,MAP.width); }
  const spots=Object.values(LOUNGE_SPOTS).map(n=>WAYPOINTS.nodes[n]);
  for (let i=0;i<spots.length;i++) for(let j=i+1;j<spots.length;j++) assert.ok(Math.hypot(spots[i].x-spots[j].x,spots[i].y-spots[j].y)>=45);
});
test('wide dashboard office contains the original map without stretching sprites', () => {
  const v=viewportOffice(930,430);
  assert.equal(v.width/v.height,MAP.width/MAP.height);
  assert.equal(v.scale,Math.min(930/MAP.width,430/MAP.height));
  assert.ok(v.offsetX>0); assert.equal(v.offsetY,0);
  const floors=officeBackdrop({areas:AREAS}).floors;
  assert.equal(floors.find(f=>f.id==='gate').kind,'tile');
  assert.equal(floors.find(f=>f.id==='archive').kind,'tile');
  assert.equal(floors.find(f=>f.id==='lounge').kind,'wood');
  assert.ok(FURNITURE.filter(f=>f.sprite==='plant'||f.sprite==='plantTall').length>=6);
});
