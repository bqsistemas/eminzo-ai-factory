// Ask Eminzo's known-answer questions, asked through the real `factory/bin/mcp` process over stdio, the way
// Claude Code, Codex or the desktop ask them. Each row is a question a person asks, the tool an agent should
// call, and the facts the answer must contain. If a row fails, the chat would answer that question wrongly.
//
// Add a row whenever Ask Eminzo learns a new kind of question.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { MODERN_VERSIONS } from '../factory/lib/mcp/protocol.js';
import { stateFixture } from './helpers/factory-state-fixture.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const ids = (list) => list.map((j) => j.id);

/** A stdio MCP client for one server process: `call(method, params)` resolves the response. */
function connect({ root, gh }) {
  const child = spawn('sh', [join(repo, 'factory/bin/mcp')], { cwd: root, env: { ...process.env, FACTORY_ROOT: root, FACTORY_GH: gh }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const stray = [];
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { stray.push(line); return; }
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); } else stray.push(line);
  });
  let next = 1;
  const call = (method, params) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const close = () => new Promise((resolve) => { child.on('exit', (code) => resolve(code)); child.stdin.end(); });
  return { call, close, stray, stderr: () => stderr };
}

let client;
before(async () => {
  client = connect(stateFixture());
  const init = await client.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'golden', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.equal(init.result.serverInfo.name, 'eminzo');
});
after(async () => {
  assert.equal(await client.close(), 0, 'the server exits 0 when stdin closes');
  assert.deepEqual(client.stray, [], 'stdout carries only JSON-RPC responses to our requests');
});

const ask = async (name, args = {}) => {
  const res = await client.call('tools/call', { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSIONS[0] } });
  assert.ok(res.result, JSON.stringify(res));
  return res.result;
};

const QUESTIONS = [
  {
    question: '¿Qué está esperando por mí?',
    tool: 'waiting_on_people',
    check: (d) => assert.deepEqual(d.items.map((i) => [i.issue, i.kind]), [[165, 'approve-spec'], [161, 'answer'], [164, 'merge'], [155, 'decide']]),
  },
  {
    question: '¿Qué jobs están corriendo?',
    tool: 'factory_overview',
    check: (d) => { assert.deepEqual(ids(d.running), ['162-building', '163-review']); assert.equal(d.waiting_for_people, 4); },
  },
  {
    question: '¿Por qué el 162 va en la ronda 3?',
    tool: 'job_detail',
    args: { job: '162' },
    check: (d) => assert.deepEqual(d.job.rounds.map((r) => r.reason), ['first build', 'gate failed', 'changes requested on the pull request']),
  },
  {
    question: '¿Qué encontró la revisión de seguridad del 155?',
    tool: 'job_detail',
    args: { job: '#155' },
    check: (d) => { assert.deepEqual(d.job.rounds[0].reviews.security, { verdict: 'CHANGES', blockers: 2 }); assert.equal(d.job.approval.decision, 'ESCALATE'); },
  },
  {
    question: '¿Cuánto costó esta semana?',
    tool: 'period_summary',
    check: (d) => { assert.equal(d.cost_usd.known, 3.6); assert.deepEqual(d.finished, { total: 3, merged: 2, rejected: 1 }); },
  },
  {
    question: '¿Qué pasó mientras no estaba? (últimas 24 horas)',
    tool: 'changes_since',
    check: (d) => { assert.deepEqual(ids(d.finished), ['158-merged-recent']); assert.deepEqual(ids(d.waiting), ['155-escalated', '164-awaiting']); },
  },
  {
    question: '¿Cuáles son los jobs de riesgo alto?',
    tool: 'list_jobs',
    args: { risk: 'high' },
    check: (d) => assert.deepEqual(ids(d.jobs), ['155-escalated', '170-rejected']),
  },
  {
    question: '¿Cómo está configurada la fábrica?',
    tool: 'factory_config',
    check: (d) => { assert.equal(d.config.concurrency, 2); assert.equal(d.config.auto_merge, false); assert.equal(Object.hasOwn(d.config, 'prices'), false); },
  },
  {
    question: '¿Qué issues esperan en la cola?',
    tool: 'factory_queue',
    source: 'github',
    check: (d) => assert.deepEqual(d.items.map((i) => i.issue), [180, 181]),
  },
];

for (const { question, tool, args, source = 'local', check } of QUESTIONS) {
  test(`golden: ${question} → ${tool}`, async () => {
    const result = await ask(tool, args);
    assert.equal(result.isError, false, result.content?.[0]?.text);
    assert.equal(result.resultType, 'complete');
    const data = result.structuredContent;
    assert.deepEqual(JSON.parse(result.content[0].text), data, 'the text block is the same data, for clients without structuredContent');
    assert.equal(data.source, source);
    assert.ok(Number.isFinite(Date.parse(data.read_at)), 'every answer says when it was read');
    assert.equal(data.repo, 'https://github.com/acme/shop');
    assert.equal(typeof data.summary, 'string');
    check(data);
  });
}

test('golden: a job from another machine is not invented', async () => {
  const result = await ask('job_detail', { job: '999' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no job on this machine matches 999; jobs live only on the machine that ran them/);
});

test('golden: tools/list offers exactly the read-only tools', async () => {
  const res = await client.call('tools/list', {});
  const tools = res.result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['factory_overview', 'list_jobs', 'job_detail', 'waiting_on_people', 'changes_since', 'period_summary', 'factory_config', 'factory_queue']);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} is read-only`);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.inputSchema.type, 'object');
  }
});
