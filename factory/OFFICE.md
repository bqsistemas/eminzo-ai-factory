# Agent Office

The office is a read-only visual projection of `board.jobs`; it has no separate job state, persistence, or service. `office.js` turns jobs and `activity.js`'s authoritative `activeAgents()` result into locations, status tokens, accessible labels, and drawer targets. `office-map.js` owns the 3×3 room geometry, furniture, walls, collision footprints, seats, and waypoint graph. `office-navigation.js` routes/retargets walkers and advances animation. `office-renderer.js` paints the atlas, keyed keyboard/click hotspots, and the accessible status strip. `dashboard.html` only mounts the office beside the existing pipeline and board.

The map has a fixed 768×500 logical coordinate system that scales proportionally into the responsive office panel. Walk edges are checked against inflated wall, furniture, and monitor ground footprints; changing a destination finishes the current edge before following a new route. Reduced-motion mode places agents immediately. Parked jobs remain individually accessible from the status strip; when a parked room has more than four visible tokens, the map shows a `+N more` badge.

## Lounge wandering

Idle agents (`place === 'lounge'`) do not stay frozen. `office-wander.js` is a pure state machine (`rest` -> `walk` -> `dwell`, time and rng injected) that sends an agent from its home slot to a point of interest in `LOUNGE_POINTS` (water cooler, snack machine, blue/green sofas, center table), lingers 5-14 s, then picks another free point or heads home; at home it rests 4-12 s or just pauses 3-8 s. Points are leaf nodes in the walk graph attached to lounge nodes, so routes never leave the lounge, and no two agents target the same point or crowd within 28 px. Wandering uses `WANDER_SPEED` (38) instead of `WALK_SPEED` (90). `createWanderDirector` keeps the bookkeeping (sync with office state, tick, speed, next wake); the renderer only runs frames while someone is walking and arms one timer for the next rest/dwell expiry, pausing when the tab is hidden. When a job activates an agent it drops its wander state and walks to work from wherever it is; on returning it resumes at normal speed and wanders after the first decision. `prefers-reduced-motion` disables wandering and keeps the static slots.

## Room work

Agents seated in a work room (`place === 'seat'` in Intake, Spec / Build, Review or Release) also move, but more slowly than in the Lounge. `office-work.js` is a pure `rest` -> `walk` -> `dwell` state machine (time and rng injected): rest 8-20 s at the seat, walk to a point in `ROOM_POINTS[room]` (board, cabinet, plants, meeting table), work there 9-20 s, then another point or back to the seat; a pause at the seat lasts 5-12 s. Points are leaf nodes attached to nodes of the same room, never within 28 px of another agent's node or target. Work walks use `WORK_SPEED` (22) against `WANDER_SPEED` (38) and `WALK_SPEED` (90); the walk to the seat itself stays at `WALK_SPEED`. Settled agents bob 1 px in 600 ms steps, driven by the shared wake timer rather than a frame loop. Agents in a review meeting (`place === 'meeting'`) stay at the table. The work director syncs before the wander director, which skips agents it owns through the optional `owned` argument of `sync`. Reduced motion clears work state and seats agents immediately.

## Lounge decor and bubbles

The Lounge has two armchairs and a small potted plant placed in the gaps between home slots (registered as furniture, so they collide and routes avoid them; a test checks they clear every slot, point and aisle). No chair is a sit point: the gaps are too tight to keep labels readable.

`office-bubbles.js` (pure, rng/time injected) shows a random thought bubble (`think` 5, `alert` 2, `idea` 2, `done` 1) above agents working in the Review and Spec/Build rooms: 2.5-4.5 s visible, 4-10 s gap, staggered first appearance, at most two at once, walking agents hold no slot and restart with a short settle delay on arrival, the longest-waiting agent gets a freed slot first, and state resets if the agent changes room or seat. `planWake` decides frame vs one rearmed timer. Idle Lounge agents, Intake and Approver get none. Reduced motion shows no bubbles. Bubbles share the wander wake timer, so there is still no permanent frame loop. Bubble and decor sprite rects were measured from `PixelOfficeAssets.png` and registered in `build_atlas.py`, `atlas.json` and `sprite-atlas.js`.

## Atlas

`assets/pixel-office-2/PixelOfficeAssets.png` is the untouched 768×512 source sheet. `build_atlas.py` makes `office-atlas-assets.png`, `atlas.json`, and `sprite-atlas.js` reproducibly from documented source rectangles, using Pillow and an alpha threshold of 200 to remove low-alpha colored fringe pixels. It does not resample or invent sprite pixels. The UI role uses the intact side pose because its hat pixels are incomplete; roles have one complete pose each, so movement is translation/bob, not fabricated walk cycles. The meeting table reuses a scaled clean table sprite.

Rebuild the atlas after changing source rectangles with:

```sh
python3 factory/assets/pixel-office-2/build_atlas.py
```

Run office behavior, collision, accessibility, and dashboard integration tests with:

```sh
node --test test/office.test.js test/office-redesign.test.js test/office-dashboard.test.js test/office-wander.test.js test/office-bubbles.test.js test/office-work.test.js
```
