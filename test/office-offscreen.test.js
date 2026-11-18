import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal fake browser: counts raf and timers, records style writes, drives ResizeObserver by hand.
function harness() {
  const log = { raf: 0, timers: 0, draws: 0, styleWrites: 0 };
  const rafs = new Map();
  let rafId = 0, observer = null;
  const styled = (count) => new Proxy({ setProperty() {} }, { set(t, k, v) { if (count) log.styleWrites++; t[k] = v; return true; } });
  const ctx = new Proxy({}, { get: (t, k) => k === 'measureText' ? () => ({ width: 10 }) : k === 'drawImage' ? () => { log.draws++; } : t[k] ?? (() => {}), set: (t, k, v) => (t[k] = v, true) });
  const el = (count) => ({ style: styled(count), getContext: () => ctx, addEventListener() {}, appendChild() {}, replaceChildren() {}, remove() {}, setAttribute() {}, dataset: {}, children: [], width: 0, height: 0 });
  const stage = { ...el(), clientWidth: 768, clientHeight: 500, isConnected: true };
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} };
  globalThis.document = { hidden: false, addEventListener() {}, createElement: () => el() };
  globalThis.Image = class { set src(v) {} };
  globalThis.ResizeObserver = class { constructor(cb) { observer = cb; } observe() {} };
  globalThis.requestAnimationFrame = (cb) => { log.raf++; rafs.set(++rafId, cb); return rafId; };
  globalThis.cancelAnimationFrame = (id) => rafs.delete(id);
  globalThis.setTimeout = () => { log.timers++; return 1; };
  globalThis.clearTimeout = () => {};
  const flush = (now = 1000) => { const cbs = [...rafs.values()]; rafs.clear(); cbs.forEach((cb) => cb(now)); };
  return { log, stage, el, flush, resize: () => observer(), rafs };
}

const gateJob = [{ id: 'job-1', stage: 'gate', issue: 1, started: '2026-01-01T00:00:00Z' }];

async function office(h) {
  const { createOffice } = await import("../factory/office-renderer.js");
  const o = createOffice({ stage: h.stage, canvas: h.el(true), hits: h.el(true), live: h.el(), status: h.el(), openJob() {} });
  return o;
}

test("a stage with no layout box schedules no frames and no wake timers while the gate runs", async () => {
  const h = harness();
  h.stage.clientWidth = 0; h.stage.clientHeight = 0;
  const o = await office(h);
  o.update(gateJob);
  assert.equal(h.log.raf, 0);
  assert.equal(h.log.timers, 0);
  assert.equal(h.log.draws, 0);
  h.resize();
  assert.equal(h.log.raf, 0);
  assert.equal(h.log.draws, 0);
});

test("a disconnected stage is treated as not rendered", async () => {
  const h = harness();
  h.stage.isConnected = false;
  const o = await office(h);
  o.update(gateJob);
  assert.equal(h.log.raf, 0);
});

test("the loop resumes when the stage gets a size again", async () => {
  const h = harness();
  h.stage.clientWidth = 0; h.stage.clientHeight = 0;
  const o = await office(h);
  o.update(gateJob);
  assert.equal(h.log.raf, 0);
  h.stage.clientWidth = 768; h.stage.clientHeight = 500;
  h.resize();
  assert.equal(h.log.raf, 1);
  assert.ok(h.log.draws > 0);
});

test("a frame in flight stops the loop once the stage loses its box", async () => {
  const h = harness();
  const o = await office(h);
  o.update(gateJob);
  assert.equal(h.log.raf, 1);
  h.stage.clientWidth = 0; h.stage.clientHeight = 0;
  h.flush();
  assert.equal(h.log.raf, 1, 'no new frame requested');
  assert.equal(h.log.timers, 0);
});

test("fit does not rewrite styles when the size is unchanged", async () => {
  const h = harness();
  const o = await office(h);
  o.update(gateJob);
  h.flush(1000);
  const before = h.log.styleWrites;
  h.flush(1016); h.flush(1032);
  assert.equal(h.log.styleWrites, before);
  h.stage.clientWidth = 500; h.stage.clientHeight = 400;
  h.resize();
  assert.ok(h.log.styleWrites > before, 'a real resize still writes styles');
});
