// `job graph` publishes the pipeline as factory/pipeline.json. These tests keep the
// committed file, the transition table and the edge metadata from drifting apart.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAGES, TRANSITIONS, EXTRA_TRANSITIONS, buildGraph } from '../factory/lib/job.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const KINDS = ['happy', 'retry', 'park', 'resume', 'escalate', 'human', 'exit', 'lane'];
const GROUPS = ['active', 'parked', 'terminal'];

const cli = () => execFileSync(join(repo, 'factory/bin/job'), ['graph'], { cwd: repo, encoding: 'utf8' });
const graph = () => JSON.parse(cli());

describe('job graph', () => {
  test('the committed factory/pipeline.json equals the `job graph` output', () => {
    assert.equal(readFileSync(join(repo, 'factory/pipeline.json'), 'utf8'), cli(),
      'regenerate it: factory/bin/job graph > factory/pipeline.json');
  });

  test('the output is deterministic and follows the contract', () => {
    assert.equal(cli(), cli());
    const g = graph();
    assert.equal(g.version, 1);
    assert.equal(g.generated_by, 'factory/bin/job graph');
    assert.deepEqual(g.stages.map((s) => s.id), [...STAGES]);
    for (const s of g.stages) assert.ok(GROUPS.includes(s.group), `${s.id} group`);
    for (const t of g.transitions) {
      assert.ok(KINDS.includes(t.kind), `${t.from}>${t.to} kind`);
      assert.ok(typeof t.label === 'string' && t.label.length > 0, `${t.from}>${t.to} label`);
    }
    assert.deepEqual(g.lanes.xs.skips, ['spec', 'spec-review']);
    assert.equal(g.lanes.xs.promote.to, 'spec');
    assert.ok(g.limits.max_rounds);
  });

  test('every TRANSITIONS key has an edge', () => {
    const edges = new Set(graph().transitions.map((t) => `${t.from}>${t.to}`));
    for (const key of Object.keys(TRANSITIONS)) assert.ok(edges.has(key), `no edge for ${key}`);
  });

  test('every edge is a real transition', () => {
    const g = graph();
    const active = g.stages.filter((s) => s.group === 'active').map((s) => s.id);
    const real = new Set([...Object.keys(TRANSITIONS), ...EXTRA_TRANSITIONS.map((t) => `${t.from}>${t.to}`)]);
    for (const t of g.transitions) {
      assert.ok(STAGES.includes(t.to), `unknown stage ${t.to}`);
      if (t.from === '*') {
        assert.equal(t.to, 'needs-human');
        continue;
      }
      assert.ok(STAGES.includes(t.from), `unknown stage ${t.from}`);
      assert.ok(real.has(`${t.from}>${t.to}`), `${t.from}>${t.to} is not a real transition`);
    }
    assert.ok(active.length > 0);
  });

  test('a transition without metadata fails the build', () => {
    const extra = { 'ghost>merged'() {} };
    assert.throws(() => buildGraph({ transitions: { ...TRANSITIONS, ...extra } }), /ghost>merged/);
  });

  test('an edge that is not a real transition fails the build', () => {
    const { 'intake>spec': _gone, ...rest } = TRANSITIONS;
    assert.throws(() => buildGraph({ transitions: rest }), /intake>spec/);
  });
});
