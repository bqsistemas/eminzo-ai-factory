// `job <id> provider <name>`: rebind a job to another provider at a stage boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { route, stageModels } from '../factory/lib/route.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(readFileSync(join(repo, 'factory/config.json'), 'utf8'));
const ID = '042-switch-me';
const INTAKE = { decision: 'ACCEPT', rescoped: false, risk: 'high', surfaces: ['security'], size: 'l' };

function codexJob(overrides = {}) {
  const agents = route(config, INTAKE, 'codex');
  return {
    id: ID, issue: 42, title: 'Switch me', pr: 7, branch: `factory/${ID}`, worktree: `/tmp/${ID}`,
    port: 3001, stage: 'build', round: 1, max_rounds: 3, provider: 'codex', lane: 'normal',
    intake: INTAKE, agents, models: { ...stageModels(config, 'codex', 'high'), ...agents },
    gate: null, reviews: {}, history: [], decision: null, note: 'resumed by a human', parked_from: 'build',
    cost_usd: null, cost_status: 'unavailable', cost_reason: 'no_associated_usage',
    started: '2026-11-01T00:00:00.000Z', finished: null, updated: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function setup(job) {
  const root = mkdtempSync(join(tmpdir(), 'factory-provider-switch-'));
  mkdirSync(join(root, 'factory/jobs', job.id), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(config));
  writeFileSync(join(root, 'factory/jobs', job.id, 'job.json'), JSON.stringify(job));
  return root;
}

function run(root, ...args) {
  return spawnSync(join(repo, 'factory/bin/job'), args, {
    cwd: repo, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: root },
  });
}

const read = (root, id = ID) => JSON.parse(readFileSync(join(root, 'factory/jobs', id, 'job.json'), 'utf8'));

test('provider claude rebinds a Codex job: re-routes agents and models from its risk and surfaces', () => {
  const root = setup(codexJob());
  const res = run(root, ID, 'provider', 'claude');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), `${ID} build provider claude`);
  const job = read(root);
  assert.equal(job.provider, 'claude');
  assert.deepEqual(job.agents, { builder: 'opus', reviewers: { code: 'sonnet', security: 'opus' } });
  assert.deepEqual(job.models, { ...stageModels(config, 'claude', 'high'), ...job.agents });
  // The stage machine is untouched.
  for (const key of ['stage', 'round', 'pr', 'note', 'parked_from', 'lane', 'intake']) {
    assert.deepEqual(job[key], codexJob()[key], key);
  }
  // Claude cost comes from transcripts again; the Codex marker is gone.
  assert.equal(job.cost_usd, 0);
  assert.equal(job.cost_status, undefined);
  assert.equal(job.cost_reason, undefined);
  assert.equal(job.provider_switches.length, 1);
  const [entry] = job.provider_switches;
  assert.equal(entry.from, 'codex');
  assert.equal(entry.to, 'claude');
  assert.equal(entry.stage, 'build');
  assert.equal(entry.round, 1);
  assert.equal(entry.cost_usd, null);
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
  const board = JSON.parse(readFileSync(join(root, 'factory/board.json'), 'utf8'));
  assert.equal(board.jobs.find((j) => j.id === ID).provider, 'claude');
});

test('provider codex marks the cost unavailable and keeps the previous Claude cost in the switch record', () => {
  const agents = route(config, INTAKE, 'claude');
  const root = setup(codexJob({
    provider: 'claude', agents, models: { ...stageModels(config, 'claude', 'high'), ...agents },
    cost_usd: 1.25, cost_by_agent: { builder: 1.25 }, cost_status: 'available', cost_reason: null,
  }));
  const res = run(root, ID, 'provider', 'codex');
  assert.equal(res.status, 0, res.stderr);
  const job = read(root);
  assert.equal(job.provider, 'codex');
  assert.equal(job.agents.builder, 'gpt-6.1-sol');
  assert.equal(job.cost_usd, null);
  assert.equal(job.cost_status, 'unavailable');
  assert.equal(job.cost_reason, 'no_associated_usage');
  assert.equal(job.cost_by_agent, undefined);
  assert.equal(job.provider_switches[0].cost_usd, 1.25);
});

test('a job still at intake gets only the stage models of the new provider', () => {
  const root = setup(codexJob({ stage: 'intake', round: 0, intake: null, agents: null, models: stageModels(config, 'codex') }));
  const res = run(root, ID, 'provider', 'claude');
  assert.equal(res.status, 0, res.stderr);
  const job = read(root);
  assert.equal(job.agents, null);
  assert.deepEqual(job.models, stageModels(config, 'claude'));
});

test('a lane xs job is routed with the new provider lane models and keeps the script approver', () => {
  const xsIntake = { ...INTAKE, risk: 'low', surfaces: [], size: 'xs' };
  const agents = route(config, xsIntake, 'codex', 'xs');
  const models = { ...stageModels(config, 'codex', 'low'), ...agents, approver: 'script' };
  delete models['approver-llm'];
  const root = setup(codexJob({ lane: 'xs', intake: xsIntake, agents, models }));
  const res = run(root, ID, 'provider', 'claude');
  assert.equal(res.status, 0, res.stderr);
  const job = read(root);
  assert.deepEqual(job.agents, route(config, xsIntake, 'claude', 'xs'));
  assert.equal(job.models.approver, 'script');
  assert.equal(job.models['approver-llm'], undefined);
});

test('refuses the same provider, an unknown provider and terminal or merging stages', () => {
  const same = run(setup(codexJob()), ID, 'provider', 'codex');
  assert.equal(same.status, 1);
  assert.match(same.stderr, /^refused: .*already uses provider codex/);

  const unknown = run(setup(codexJob()), ID, 'provider', 'nope');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^refused: unknown provider: nope/);

  for (const stage of ['merging', 'merged', 'rejected']) {
    const root = setup(codexJob({ stage }));
    const res = run(root, ID, 'provider', 'claude');
    assert.equal(res.status, 1, stage);
    assert.match(res.stderr, new RegExp(`^refused: .*${stage}`), stage);
    assert.equal(read(root).provider, 'codex', stage);
  }
});

test('usage lists the provider command', () => {
  const res = run(setup(codexJob()), ID, 'provider');
  assert.equal(res.status, 2);
  assert.match(res.stderr, /job <id> provider <name>/);
});
