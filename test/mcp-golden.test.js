// Ask Eminzo's known-answer questions, asked through the real `factory/bin/mcp` process over stdio, the way
// Claude Code, Codex or the desktop ask them. Each row is a question a person asks, the tool an agent should
// call, and the facts the answer must contain. If a row fails, the chat would answer that question wrongly.
//
// Add a row whenever Ask Eminzo learns a new kind of question.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { MODERN_VERSIONS } from '../factory/lib/mcp/protocol.js';
import { stateFixture } from './helpers/factory-state-fixture.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const ids = (list) => list.map((j) => j.id);

/** A stdio MCP client for one server process: `call(method, params)` resolves the response. */
function connect({ root, gh }) {
  // HOME is the fixture: no plugin or config of the machine running the tests is seen.
  const child = spawn('sh', [join(repo, 'factory/bin/mcp')], { cwd: root, env: { ...process.env, FACTORY_ROOT: root, FACTORY_GH: gh, HOME: root, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
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

const EGM_BRIEF = '# Filtro de sugerencias\n\n## Overview\n\nLos revisores pierden tiempo.\n\n## Goals vs. Non-Goals\n\n* **In-Scope Goals:**\n  - ver lo pendiente.\n* **Out-of-Scope Non-Goals:**\n  - correos.\n';
const COMPLETE_BRIEF = [
  '# Brief: Filtro de sugerencias',
  '## Problema', 'Los revisores pierden tiempo.', '## Para quién', 'Revisores.', '## Valor esperado', 'Menos tiempo.',
  '## Cómo funciona hoy', 'Todo junto.', '## Alcance', '- Filtro.', '## Fuera de alcance', '- Correos.',
  '## Criterios de aceptación', '- BC-1: Un revisor ve solo lo pendiente.',
  '## Entregas', '- D1: Ver solo lo pendiente | size: s | risk: low | covers: BC-1',
].join('\n');

const today = new Date().toISOString().slice(0, 10);
const PRODUCT_MAP = [
  '# Mapa del producto: Tienda', '', `Revisado: ${today} por ana-p`, '',
  '## Comprar un producto', '- Una visita agrega un producto al carrito sin cuenta. [confirmed]', '- Se puede pagar con tarjeta de regalo. [assumed] (source: pantalla de pago)',
  '', '## Seguir un pedido', '- El comprador ve el estado del pedido en su cuenta. [confirmed]', '',
].join('\n');

let client;
let fixtureRoot;
before(async () => {
  const fixture = stateFixture();
  fixtureRoot = fixture.root;
  writeFileSync(join(fixture.root, 'concepts_brief.md'), EGM_BRIEF);
  client = connect(fixture);
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

/** COMPLETE_BRIEF approved through the real tool, so no row depends on another having run. */
const approved = async () => (await ask('approve_brief', { text: COMPLETE_BRIEF, by: 'ana-p' })).structuredContent.text;
/** A Spanish brief with two deliverables, the first waiting for the second, approved through the real tool. */
const approvedTwo = async () => {
  const text = COMPLETE_BRIEF.replace('- D1: Ver solo lo pendiente | size: s | risk: low | covers: BC-1', '- D1: Ver solo lo pendiente | size: s | risk: low | covers: BC-1 | after: D2\n- D2: Guardar el filtro | size: m | risk: medium | covers: BC-1');
  return (await ask('approve_brief', { text, by: 'ana-p' })).structuredContent.text;
};
/** COMPLETE_BRIEF with six deliverables, approved through the real tool. */
const approvedSix = async () => {
  const six = [2, 3, 4, 5, 6].map((n) => `- D${n}: Entrega ${n} | size: s | risk: low | covers: BC-1`).join('\n');
  return (await ask('approve_brief', { text: COMPLETE_BRIEF.replace('- D1: Ver solo lo pendiente | size: s | risk: low | covers: BC-1', `- D1: Ver solo lo pendiente | size: s | risk: low | covers: BC-1\n${six}`), by: 'ana-p' })).structuredContent.text;
};
const FACTS = '<!-- factory:facts {"v":1,"job":"161-pending","issue":43,"lane":"normal","size":"s","risk":"low","surfaces":[],"round":1,"started":"2026-11-10T10:00:00.000Z","approve_entered":"2026-11-10T11:30:00.000Z","cost_usd":null,"decision":"APPROVE"} -->';
const writeFakeGh = (data) => writeFileSync(join(fixtureRoot, 'fake-gh.json'), JSON.stringify(data));
const removeFakeGh = () => rmSync(join(fixtureRoot, 'fake-gh.json'), { force: true });
/**
 * An initiative on the fake GitHub, built from the real tools: a six-deliverable brief approved, its brief issue (#40)
 * and the deliverable issues in every status but "not created" (D1), with a 60-120 minute estimate on D5.
 */
const setUpInitiative = async () => {
  const text = await approvedSix();
  const brief = (await ask('handoff_drafts', { text })).structuredContent.draft;
  const drafts = Object.fromEntries((await ask('handoff_drafts', { text, brief_issue: 40 })).structuredContent.drafts.map((d) => [d.id, d]));
  const labelled = (id, number, state, labels, extra = {}) => ({ number, title: drafts[id].title, state, stateReason: extra.stateReason ?? null, body: extra.body ?? drafts[id].body, labels: ['eminzo-deliverable', ...labels].map((name) => ({ name })), url: `https://github.com/acme/shop/issues/${number}`, closedAt: null, author: { login: 'ana-p' }, createdAt: '2026-11-12T16:00:00Z' });
  const issues = [
    labelled('D2', 42, 'OPEN', []),
    labelled('D3', 43, 'OPEN', ['factory']),
    labelled('D4', 44, 'OPEN', ['factory']),
    labelled('D5', 45, 'CLOSED', ['factory'], { stateReason: 'COMPLETED', body: drafts.D5.body.replace('est=none', 'est=60-120') }),
    labelled('D6', 46, 'CLOSED', [], { stateReason: 'NOT_PLANNED' }),
  ];
  const data = {
    issues: { 40: { number: 40, title: brief.title, state: 'OPEN', body: brief.body, labels: [{ name: 'eminzo-brief' }], url: 'https://github.com/acme/shop/issues/40', author: { login: 'ana-p' }, createdAt: '2026-11-12T15:05:00Z', closedAt: null } },
    list: issues,
    closing: { 44: [{ number: 54 }], 45: [{ number: 55 }] },
    prs: { 54: { number: 54, state: 'OPEN', mergedAt: null, url: 'https://github.com/acme/shop/pull/54', body: '', headRefName: 'factory/161-pending', isCrossRepository: false }, 55: { number: 55, state: 'MERGED', mergedAt: '2026-11-11T09:00:00Z', url: 'https://github.com/acme/shop/pull/55', body: `Record\n${FACTS}\n`, headRefName: 'factory/161-pending', isCrossRepository: false } },
  };
  writeFakeGh(data);
  return { data, drafts };
};
const REPORT_ES = [
  'Borrador — revisar antes de compartir.', '', '# Informe semanal de avance: Filtro de sugerencias', '', 'Período: 2026-11-05 a 2026-11-12 (UTC)', '',
  '1 de 6 partes está disponible; 2 están en curso; 1 está esperando una decisión; 1 no empezó; 1 se cerró sin entregarse.', '',
  '## Entregado en este período', '', '- **Entrega 5** — disponible desde 2026-11-11.', '',
  '## En curso', '', '- **Entrega 4** — en revisión.', '- **Entrega 3** — en construcción.', '',
  '## Esperando una decisión', '', '- **Entrega 2** — esperando que el líder técnico lo acepte.', '',
  '## Lo que sigue', '', '- **Ver solo lo pendiente** — todavía no empezó.', '',
  '## Estimación y tiempo real', '', '- **Entrega 5**: estimado de 60 min a 2 h, tomó 1.5 h.', '- Total: estimado de 60 min a 2 h, tomó 1.5 h (partes comparadas: 1 de 1).',
  '- Son rangos medidos sobre trabajo parecido; no son fechas de entrega.', '',
  '## Notas', '', '- **Ver solo lo pendiente** todavía no se ve en el seguimiento; puede tardar un minuto en aparecer.', '',
].join('\n');
const REPORT_JARGON = /\b(jobs?|pull requests?|merge[sd]?|gate|rounds?|rondas?|specs?|intake|factory|f[aá]brica|briefs?|issues?|deliverables?|gh|github|sha256|D\d+)\b|\bPRs?\b|#\d+/i;
const writeMap = (text) => { mkdirSync(join(fixtureRoot, 'factory'), { recursive: true }); writeFileSync(join(fixtureRoot, 'factory/product-map.md'), text); };
const removeMap = () => rmSync(join(fixtureRoot, 'factory/product-map.md'), { force: true });

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
    question: '¿Dónde pierde tiempo la fábrica?',
    tool: 'factory_diagnosis',
    check: (d) => { assert.equal(d.jobs, 3); assert.equal(d.cost.known, 3.6); assert.ok(Array.isArray(d.proposals)); assert.match(d.note, /nothing was changed/); },
  },
  {
    question: '¿Cuánto le tomaría al equipo una entrega pequeña de riesgo bajo?',
    tool: 'estimate_work',
    args: { deliverables: [{ title: 'Ver solo lo pendiente', size: 's', risk: 'low' }] },
    check: (d) => {
      const [one] = d.deliverables;
      assert.equal(one.factory_minutes, null, 'two finished jobs are not enough history for a range');
      assert.match(one.warnings[0], /^too little history: 1 finished job of size s, fewer than 5$/);
      assert.deepEqual(d.history.sources, { local: 2, github: 0 });
    },
  },
  {
    question: '¿Con qué método exploro la idea?',
    tool: 'discovery_methods',
    check: (d) => { assert.equal(d.selected, 'eminzo'); assert.equal(d.methods.find((m) => m.id === 'elephant-goldfish').available, false); },
  },
  {
    question: '¿Está listo este brief para aprobarse?',
    tool: 'check_brief',
    args: { text: COMPLETE_BRIEF },
    check: (d) => { assert.equal(d.ok, true, d.problems.join('; ')); assert.deepEqual(d.estimate_input, [{ title: 'Ver solo lo pendiente', size: 's', risk: 'low' }]); },
  },
  {
    question: 'Trae el brief que armé con Elephant-Goldfish',
    tool: 'import_egm_brief',
    check: (d) => { assert.match(d.markdown, /^## Problema\n\nLos revisores pierden tiempo\.$/m); assert.deepEqual(d.missing, ['audience', 'value', 'today', 'acceptance', 'deliverables']); },
  },
  {
    question: '(el desktop) prepara a los revisores sin contexto',
    tool: 'brief_review_prompts',
    args: { text: COMPLETE_BRIEF },
    check: (d) => { assert.equal(d.readers.length, 4); assert.equal(d.language, 'es'); assert.match(d.readers[0].user, /<brief>/); },
  },
  {
    question: '¿Puedo crear los issues de este brief?',
    tool: 'brief_status',
    args: { text: COMPLETE_BRIEF },
    check: (d) => { assert.equal(d.state, 'ready'); assert.equal(d.can_create_issues, false); assert.equal(d.reason, 'The brief is not approved yet.'); },
  },
  {
    question: '(el desktop) la persona aprobó el brief: devuelve el brief con la marca',
    tool: 'approve_brief',
    args: { text: COMPLETE_BRIEF, by: 'ana-p' },
    check: (d) => {
      assert.match(d.text, /<!-- eminzo:approved sha256=[0-9a-f]{64} by=ana-p at=\d{4}-\d{2}-\d{2}T/);
      assert.equal(d.approval.by, 'ana-p');
      assert.equal(d.approval.at, d.read_at);
    },
  },
  {
    question: '¿Puedo crear los issues del brief ya aprobado?',
    tool: 'brief_status',
    argsFrom: async () => ({ text: await approved() }),
    check: (d) => { assert.equal(d.state, 'approved'); assert.equal(d.can_create_issues, true); assert.equal(d.approval.by, 'ana-p'); },
  },
  {
    question: '¿Y si alguien cambió una línea después de aprobarlo?',
    tool: 'brief_status',
    argsFrom: async () => ({ text: (await approved()).replace('Menos tiempo.', 'Mucho menos tiempo.') }),
    check: (d) => { assert.equal(d.state, 'changed'); assert.equal(d.can_create_issues, false); assert.match(d.reason, /^The brief changed after it was approved on \d{4}-\d{2}-\d{2}; approve it again\.$/); },
  },
  {
    question: '¿Puedo crear los issues de un brief incompleto?',
    tool: 'brief_status',
    args: { text: '# Brief: x\n' },
    check: (d) => { assert.equal(d.state, 'draft'); assert.equal(d.can_create_issues, false); assert.match(d.reason, /^The brief cannot be approved yet: /); },
  },
  {
    question: 'Dame un brief vacío para empezar',
    tool: 'brief_template',
    args: { title: 'Filtro de sugerencias' },
    check: (d) => { assert.match(d.markdown, /^<!-- eminzo:brief v1 -->\n# Brief: Filtro de sugerencias\n/); assert.match(d.markdown, /^## Problema\n\n_Por completar\._$/m); },
  },
  {
    question: '(el desktop) junta lo que dijeron los revisores',
    tool: 'merge_brief_review',
    args: { answers: [{ lens: 'newcomer', answer: 'FINDING: Problema | blocker | No se entiende para quién es.' }, { lens: 'user', answer: 'FINDING: Problema | blocker | No se entiende para quién es.' }] },
    check: (d) => { assert.equal(d.findings.length, 1); assert.equal(d.findings[0].id, 'F1'); },
  },
  {
    question: '¿Cómo funciona hoy la app? (todavía no hay mapa)',
    tool: 'product_map',
    setup: removeMap,
    check: (d) => { assert.equal(d.state, 'missing'); assert.deepEqual(d.areas, []); assert.match(d.summary, /\/eminzo-product map/); },
  },
  {
    question: '¿Cómo funciona hoy la app?',
    tool: 'product_map',
    setup: () => writeMap(PRODUCT_MAP),
    check: (d) => {
      assert.equal(d.state, 'reviewed');
      assert.deepEqual(d.reviewed, { date: today, by: 'ana-p' });
      assert.deepEqual(d.areas.map((a) => a.name), ['Comprar un producto', 'Seguir un pedido']);
      assert.deepEqual(d.areas[0].items[1], { text: 'Se puede pagar con tarjeta de regalo.', basis: 'assumed', source: 'pantalla de pago' });
      assert.deepEqual(d.problems, []);
    },
  },
  {
    question: 'Prepara los issues del brief aprobado (todavía no existe el issue del brief)',
    tool: 'handoff_drafts',
    argsFrom: async () => ({ text: await approved() }),
    check: (d) => {
      assert.equal(d.kind, 'brief');
      assert.deepEqual(d.draft.labels, ['eminzo-brief']);
      assert.equal(d.draft.title, 'Brief: Filtro de sugerencias');
      assert.match(d.draft.body, /<!-- eminzo:approved sha256=[0-9a-f]{64} by=ana-p at=/);
      assert.match(d.draft.body, /\n<!-- eminzo:brief-issue v1 hash=[0-9a-f]{64} -->\n$/);
      assert.equal(JSON.stringify(d).includes('"factory"'), false, 'no factory label anywhere');
      assert.equal(d.drafts, undefined);
      assert.deepEqual(d.estimate_input, [{ title: 'Ver solo lo pendiente', size: 's', risk: 'low' }]);
      assert.match(d.summary, /creates nothing/);
    },
  },
  {
    question: 'Prepara los issues de las entregas, en orden de dependencia (el issue del brief es el 40)',
    tool: 'handoff_drafts',
    argsFrom: async () => ({ text: await approvedTwo(), brief_issue: 40, created: [{ id: 'D2', issue: 41 }] }),
    check: (d) => {
      assert.equal(d.kind, 'deliverables');
      assert.deepEqual(d.drafts.map((x) => x.id), ['D2', 'D1']);
      assert.deepEqual(d.drafts.map((x) => x.after), [[], ['D2']]);
      for (const x of d.drafts) {
        assert.deepEqual(x.labels, ['eminzo-deliverable']);
        assert.match(x.body, /Parte de #40/);
        assert.match(x.body, /<!-- eminzo:deliverable v1 brief=40 id=D[12] hash=[0-9a-f]{12} est=none -->/);
        assert.doesNotMatch(x.body, /factory/i);
      }
      assert.match(d.drafts[1].body, /#41 \(D2: Guardar el filtro\)/);
      assert.match(d.drafts[0].body, /Hay muy poco historial para estimar\./);
      assert.equal(d.estimate_input.length, 2);
    },
  },
  {
    question: '¿Puedo crear los issues de un brief todavía sin aprobar?',
    tool: 'handoff_drafts',
    args: { text: COMPLETE_BRIEF },
    refused: /^The brief is not approved yet\.$/,
  },
  {
    question: '¿Cómo va la iniciativa del brief #40?',
    tool: 'initiative',
    source: 'github',
    setup: undefined,
    argsFrom: async () => { await setUpInitiative(); return { issue: 40 }; },
    check: (d) => {
      assert.deepEqual(d.brief, { issue: 40, title: 'Brief: Filtro de sugerencias', url: 'https://github.com/acme/shop/issues/40', state: 'OPEN', author: 'ana-p', created_at: '2026-11-12T15:05:00Z', approvedBy: 'ana-p', approvedAt: d.brief.approvedAt, valid: true });
      assert.deepEqual(d.deliverables.map((x) => [x.id, x.status]), [['D1', 'not-created'], ['D2', 'waiting-tech-lead'], ['D3', 'in-factory'], ['D4', 'in-review'], ['D5', 'available'], ['D6', 'closed']]);
      assert.deepEqual(d.deliverables[3].pr, { number: 54, url: 'https://github.com/acme/shop/pull/54', state: 'OPEN', merged: false });
      assert.equal(d.deliverables[4].actual_min, 90);
      assert.deepEqual(d.deliverables[4].estimate, { low_min: 60, high_min: 120 });
      assert.deepEqual(d.progress, { done: 1, total: 6 });
      assert.deepEqual(d.estimate_vs_actual, { estimated: { low_min: 60, high_min: 120 }, actual_min: 90, complete: false, counted: { compared: 1, of: 6 }, basis: d.estimate_vs_actual.basis });
      assert.match(d.estimate_vs_actual.basis, /last facts line/);
      assert.deepEqual(d.warnings, ['D1 was not found yet (GitHub search can lag a minute).']);
      assert.match(d.summary, /1 of 6 deliverables is available; 1 in review, 1 in the factory, 1 waiting for the tech lead, 1 closed without being delivered, 1 not created yet\./);
    },
  },
  {
    question: 'Arma el reporte semanal de la iniciativa #40 para el cliente',
    tool: 'initiative_report',
    source: 'github',
    argsFrom: async () => { await setUpInitiative(); return { issue: 40, from: '2026-11-05', to: '2026-11-12' }; },
    check: (d) => {
      assert.deepEqual(d.sections.map((x) => x.id), ['delivered', 'in-progress', 'waiting', 'next', 'estimate', 'notes']);
      assert.equal(d.summary, '1 de 6 partes está disponible; 2 están en curso; 1 está esperando una decisión; 1 no empezó; 1 se cerró sin entregarse.');
      assert.equal(d.status, d.summary);
      assert.deepEqual(d.period, { from: '2026-11-05', to: '2026-11-12' });
      assert.equal(d.markdown, REPORT_ES);
      assert.doesNotMatch(d.markdown, REPORT_JARGON);
      assert.doesNotMatch(d.markdown, /Costo del período|https?:\/\//, 'cost and links only on request');
      assert.deepEqual(d.warnings, ['**Ver solo lo pendiente** todavía no se ve en el seguimiento; puede tardar un minuto en aparecer.']);
    },
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

for (const { question, tool, args, argsFrom, setup, source = 'local', check, refused } of QUESTIONS) {
  test(`golden: ${question} → ${tool}`, async () => {
    if (setup) setup();
    const result = await ask(tool, argsFrom ? await argsFrom() : args);
    if (refused) {
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, refused);
      return;
    }
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

for (const [name, args, message] of [
  ['unknown argument', { text: COMPLETE_BRIEF, by: 'ana', extra: true }, /extra/],
  ['bad login', { text: COMPLETE_BRIEF, by: 'ana bo' }, /by/],
  ['missing login', { text: COMPLETE_BRIEF }, /by/],
  ['incomplete brief', { text: '# Brief: x\n', by: 'ana' }, /^The brief cannot be approved yet: /],
]) {
  test(`golden: approve_brief refuses (${name}) with a sentence`, async () => {
    const result = await ask('approve_brief', args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, message);
  });
}

test('golden: handoff_drafts refuses a changed brief with the gate reason, and unknown arguments', async () => {
  const changed = await ask('handoff_drafts', { text: (await approved()).replace('Menos tiempo.', 'Mucho menos tiempo.'), brief_issue: 40 });
  assert.equal(changed.isError, true);
  assert.match(changed.content[0].text, /^The brief changed after it was approved on \d{4}-\d{2}-\d{2}; approve it again\.$/);
  const extra = await ask('handoff_drafts', { text: await approved(), labels: ['factory'] });
  assert.equal(extra.isError, true);
  assert.match(extra.content[0].text, /labels/);
});

test('golden: initiative reads a known deliverable issue the search has not shown yet', async () => {
  const { data, drafts } = await setUpInitiative();
  const d1 = drafts.D1;
  data.issues[48] = { number: 48, title: d1.title, state: 'OPEN', stateReason: null, body: d1.body, labels: [{ name: 'eminzo-deliverable' }, { name: 'factory' }], url: 'https://github.com/acme/shop/issues/48', closedAt: null, author: { login: 'ana-p' }, createdAt: '2026-11-12T16:30:00Z' };
  writeFakeGh(data);
  const result = (await ask('initiative', { issue: 40, known: [48] })).structuredContent;
  assert.deepEqual(result.deliverables[0], { ...result.deliverables[0], id: 'D1', issue: 48, status: 'in-factory', factory: true });
  assert.deepEqual(result.warnings, []);
  const bad = await ask('initiative', { issue: 40, known: ['x'] });
  assert.equal(bad.isError, true);
  removeFakeGh();
});

test('golden: initiative_report adds cost and links only when asked, never invents a cost, and gives the same text twice', async () => {
  const { data } = await setUpInitiative();
  const period = { issue: 40, from: '2026-11-05', to: '2026-11-12' };
  const plain = (await ask('initiative_report', period)).structuredContent;
  assert.equal((await ask('initiative_report', period)).structuredContent.markdown, plain.markdown, 'same input, same text');
  const unknown = (await ask('initiative_report', { ...period, include_cost: true })).structuredContent;
  assert.deepEqual(unknown.sections.find((x) => x.id === 'cost').items, ['El costo no se conoce.'], 'a cost that is not known is not 0');
  assert.doesNotMatch(unknown.markdown, /USD 0/);
  data.prs[55].body = data.prs[55].body.replace('"cost_usd":null', '"cost_usd":2.5');
  writeFakeGh(data);
  const known = (await ask('initiative_report', { ...period, include_cost: true, include_links: true })).structuredContent;
  assert.deepEqual(known.sections.find((x) => x.id === 'cost').items, ['Costo conocido de las partes entregadas en este período: USD 2.50 (conocido en 1 de 1 partes).']);
  assert.equal(known.sections.at(-1).id, 'links');
  assert.ok(known.sections.at(-1).items.includes('Entrega 5: https://github.com/acme/shop/issues/45'));
  assert.equal((await ask('initiative_report', { ...period, from: '2026-11-12', to: '2026-11-01' })).isError, true);
  removeFakeGh();
});

test('golden: initiative_report says why when the initiative cannot be read, and sends nothing', async () => {
  removeFakeGh();
  const missing = await ask('initiative_report', { issue: 999 });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /^could not read issue #999 from GitHub: /);
  writeFakeGh({ issues: { 41: { number: 41, title: 'Plain', state: 'OPEN', body: 'hello', labels: [], url: 'u', author: null, createdAt: '2026-11-12T15:05:00Z', closedAt: null } } });
  const plain = await ask('initiative_report', { issue: 41 });
  assert.equal(plain.isError, true);
  assert.match(plain.content[0].text, /^Issue #41 is not an Eminzo brief issue/);
  const bad = await ask('initiative_report', { issue: 40, from: 'ayer' });
  assert.equal(bad.isError, true);
  const tool = (await client.call('tools/list', {})).result.tools.find((t) => t.name === 'initiative_report');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.match(tool.description, /builds a draft the person reviews before sharing; it sends nothing/);
  removeFakeGh();
});

test('golden: initiative says why when gh cannot answer, and refuses an issue that is not a brief', async () => {
  removeFakeGh();
  const missing = await ask('initiative', { issue: 999 });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /^could not read issue #999 from GitHub: Could not resolve to an issue with the number of 999$/);
  writeFakeGh({ issues: { 41: { number: 41, title: 'Plain', state: 'OPEN', body: 'hello', labels: [], url: 'u', author: null, createdAt: '2026-11-12T15:05:00Z', closedAt: null } } });
  const plain = await ask('initiative', { issue: 41 });
  assert.equal(plain.isError, true);
  assert.match(plain.content[0].text, /^Issue #41 is not an Eminzo brief issue/);
  const bad = await ask('initiative', { issue: 'forty' });
  assert.equal(bad.isError, true);
  removeFakeGh();
});

test('golden: product_map with a Reviewed date in the future is a draft, never reviewed', async () => {
  writeMap(PRODUCT_MAP.replace(`Revisado: ${today}`, 'Revisado: 2999-01-01'));
  const data = (await ask('product_map')).structuredContent;
  assert.equal(data.state, 'draft');
  assert.ok(data.problems.includes('the Reviewed date is in the future'));
  removeMap();
});

test('golden: product_map with an oversize file says why it is missing', async () => {
  writeMap(`# Mapa del producto: x\n${'- relleno [assumed]\n'.repeat(60_000)}`);
  const data = (await ask('product_map')).structuredContent;
  assert.equal(data.state, 'missing');
  assert.match(data.summary, /larger than 1 MiB/);
  removeMap();
});

test('golden: tools/list offers exactly the read-only tools', async () => {
  const res = await client.call('tools/list', {});
  const tools = res.result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['factory_overview', 'list_jobs', 'job_detail', 'waiting_on_people', 'changes_since', 'period_summary', 'factory_diagnosis', 'estimate_work', 'discovery_methods', 'check_brief', 'brief_template', 'import_egm_brief', 'brief_review_prompts', 'merge_brief_review', 'brief_status', 'approve_brief', 'product_map', 'handoff_drafts', 'initiative', 'initiative_report', 'factory_config', 'factory_queue']);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} is read-only`);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('golden: a path outside the repository is never read', async () => {
  const result = await ask('import_egm_brief', { path: '../../etc/passwd.md' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found in this repository, or it is outside it/);
});
