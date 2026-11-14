// The weekly client report of an initiative: a pure function of the initiative's data, in functional language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { initiativeReport } from '../factory/lib/client-report.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const part = (id, issue, title, status, extra = {}) => ({ id, issue, title, url: issue ? `https://github.com/acme/shop/issues/${issue}` : null, status, factory: false, after: [], pr: null, estimate: null, actual_min: null, available_at: null, cost_usd: null, ...extra });
const DELIVERABLES = [
  part('D1', 41, 'Ver solo lo pendiente', 'available', { available_at: '2026-11-11T09:00:00.000Z', estimate: { low_min: 60, high_min: 120 }, actual_min: 90, cost_usd: 1.5 }),
  part('D2', 42, 'Guardar el filtro', 'available', { available_at: '2026-10-01T09:00:00.000Z', cost_usd: 2.25 }),
  part('D3', 43, 'Avisar por correo', 'in-review'),
  part('D4', 44, 'Exportar a hoja de cálculo', 'in-factory'),
  part('D5', 45, 'Compartir el filtro', 'waiting-tech-lead'),
  part('D6', null, 'Filtro por fecha', 'not-created', { after: ['D3'] }),
  part('D7', 47, 'Idea descartada', 'closed'),
  part('D8', 48, 'Ordenar por fecha', 'available', { available_at: '2026-11-10T09:00:00.000Z' }),
];
const data = (over = {}) => ({
  language: 'es', brief: { issue: 40, title: 'Brief: Filtro de sugerencias', valid: true }, deliverables: DELIVERABLES, progress: { done: 3, total: 8 },
  estimate_vs_actual: { estimated: { low_min: 60, high_min: 120 }, actual_min: 90, complete: false, counted: { compared: 1, of: 8 }, basis: 'x' }, warnings: [], ...over,
});
const make = (over, options = {}) => initiativeReport(data(over), { now: NOW, ...options });
const BANNED_PR = /\bPRs?\b/; // case-sensitive: "Pr" starts honest Portuguese words
const BANNED = /\b(jobs?|pull requests?|merge[sd]?|gate|rounds?|rondas?|rodadas?|specs?|intake|factory|f[aá]brica|briefs?|issues?|deliverables?|gh|github|sha256|D\d+)\b|#\d+/i;

test('a report is a draft with a title, a period of ISO dates and a one-line status', () => {
  const r = make();
  const lines = r.markdown.split('\n');
  assert.equal(lines[0], 'Borrador — revisar antes de compartir.');
  assert.equal(lines[2], '# Informe semanal de avance: Filtro de sugerencias');
  assert.equal(r.title, 'Informe semanal de avance: Filtro de sugerencias');
  assert.equal(lines[4], 'Período: 2026-11-05 a 2026-11-11 (UTC)', 'by default the 7 whole UTC days before today');
  assert.equal(lines[6], '3 de 8 partes están disponibles; 2 están en curso; 1 está esperando una decisión; 1 no empezó; 1 se cerró sin entregarse.');
  assert.equal(r.status, lines[6]);
});

test('the sections say what was delivered, what is going on, what waits, what comes next and how long it took', () => {
  const r = make();
  assert.deepEqual(r.sections.map((s) => s.id), ['delivered', 'in-progress', 'waiting', 'next', 'estimate']);
  const by = Object.fromEntries(r.sections.map((s) => [s.id, s.items]));
  assert.deepEqual(by.delivered, ['**Ordenar por fecha** — disponible desde 2026-11-10.', '**Ver solo lo pendiente** — disponible desde 2026-11-11.'], 'only what became available in the period, oldest first');
  assert.deepEqual(by['in-progress'], ['**Avisar por correo** — en revisión.', '**Exportar a hoja de cálculo** — en construcción.']);
  assert.deepEqual(by.waiting, ['**Compartir el filtro** — esperando que el líder técnico lo acepte.']);
  assert.deepEqual(by.next, ['**Filtro por fecha** — empieza después de **Avisar por correo**.']);
  assert.deepEqual(by.estimate, ['**Ver solo lo pendiente**: estimado de 60 min a 2 h, tomó 1.5 h.', 'Total: estimado de 60 min a 2 h, tomó 1.5 h (partes comparadas: 1 de 3).', 'Son rangos medidos sobre trabajo parecido; no son fechas de entrega.']);
  for (const s of r.sections) assert.match(r.markdown, new RegExp(`^## ${s.heading}$`, 'm'));
});

test('the cost of the period appears only on request, only what is known, and never as zero when it is not', () => {
  assert.doesNotMatch(make().markdown, /Costo/);
  const r = make({}, { includeCost: true });
  assert.deepEqual(r.sections.find((s) => s.id === 'cost').items, ['Costo conocido de las partes entregadas en este período: USD 1.50 (conocido en 1 de 2 partes; no se conoce en 1).']);
  const none = make({ deliverables: DELIVERABLES.map((d) => ({ ...d, cost_usd: null })) }, { includeCost: true });
  assert.deepEqual(none.sections.find((s) => s.id === 'cost').items, ['El costo no se conoce.']);
  assert.doesNotMatch(none.markdown, /USD 0|\$0/);
  const empty = make({ deliverables: DELIVERABLES.filter((d) => d.status !== 'available') }, { includeCost: true });
  assert.match(empty.sections.find((s) => s.id === 'cost').items[0], /^En este período no se entregó nada/);
});

test('warnings become plain notes: no ids, numbers of issues or tool words', () => {
  const warnings = [
    'D6 was not found yet (GitHub search can lag a minute).',
    '#47 was closed without a merged change.',
    '#44 was reopened after a merged change.',
    'pull request #54 comes from a fork and is ignored.',
    'issue #90 looks like a deliverable of this brief but was not created by Eminzo for it',
    'WARNING: the brief issue no longer matches its approval: the text changed. Its text may have been edited.',
    'The title of the brief issue was changed after it was created; the approval does not cover the title.',
    'The brief issue was created by ana-p but approved by bo-q.',
    'D2 has more than one issue (#42, #92); #42 is used.',
    'gh call limit reached (60): some pull requests were not read.',
    'only the first 100 issues that mention this brief were read.',
    'could not read issue #50 from GitHub: HTTP 500.',
    'something nobody foresaw about #12',
  ];
  for (const language of ['es', 'en', 'pt']) {
    const r = make({ language, warnings });
    const notes = r.sections.find((s) => s.id === 'notes').items;
    assert.equal(notes.length, 11, `${language}: one note per kind, the two "incomplete" ones joined`);
    assert.deepEqual(r.warnings, notes);
    assert.doesNotMatch(r.markdown, BANNED, language);
    assert.doesNotMatch(r.markdown, BANNED_PR, language);
  }
  assert.equal(make().sections.some((s) => s.id === 'notes'), false, 'no warnings, no notes');
  assert.match(make({ warnings: ['#44 was reopened after a merged change.'] }).sections.at(-1).items[0], /^\*\*Exportar a hoja de cálculo\*\* se reabrió/);
});

test('English and Portuguese follow the language of the brief, and unknown languages fall back to English', () => {
  const en = make({ language: 'en' });
  assert.equal(en.markdown.split('\n')[0], 'Draft — review before sharing.');
  assert.equal(en.status, '3 of 8 parts are available; 2 are in progress; 1 is waiting for a decision; 1 has not started; 1 was closed without being delivered.');
  assert.deepEqual(en.sections.map((s) => s.heading), ['Delivered this period', 'In progress', 'Waiting for a decision', 'Coming next', 'Estimate and actual']);
  assert.deepEqual(make({ language: 'pt' }).sections.map((s) => s.heading), ['Entregue neste período', 'Em andamento', 'Aguardando uma decisão', 'Próximos passos', 'Estimativa e tempo real']);
  assert.equal(make({ language: 'fr' }).title, en.title);
  assert.equal(make({ language: null }, { language: 'pt' }).markdown.split('\n')[0], 'Rascunho — revisar antes de compartilhar.', 'the option wins when the initiative has no language');
  assert.equal(make({ language: 'es' }, { language: 'en' }).markdown.split('\n')[0], 'Draft — review before sharing.');
});

test('one part: singular wording; no parts yet; everything delivered', () => {
  const one = make({ deliverables: [DELIVERABLES[2]], language: 'en' });
  assert.equal(one.status, '0 of 1 part are available; 1 is in progress.');
  assert.equal(make({ deliverables: [], language: 'en' }).status, 'No parts were found for this initiative yet.');
  const all = make({ deliverables: [DELIVERABLES[0]], language: 'en' });
  assert.equal(all.status, '1 of 1 part is available.');
  assert.deepEqual(all.sections.find((s) => s.id === 'in-progress').items, ['Nothing is in progress.']);
});

test('links go at the end, as plain URLs, only when asked', () => {
  assert.doesNotMatch(make().markdown, /https?:\/\//);
  const r = make({}, { includeLinks: true });
  const links = r.sections.at(-1);
  assert.equal(links.id, 'links');
  assert.equal(links.items[0], 'Ver solo lo pendiente: https://github.com/acme/shop/issues/41');
  assert.equal(links.items.some((x) => /Filtro por fecha/.test(x)), false, 'a part with no issue has no link');
  assert.ok(r.markdown.trimEnd().endsWith(links.items.at(-1)));
});

test('the period: from and to are validated, a day alone means that whole day, and the same input gives the same text', () => {
  assert.equal(make({}, { from: '2026-11-11T00:00:00Z' }).sections[0].items.length, 1, 'only what became available since `from`');
  assert.match(make({}, { from: '2026-11-01', to: '2026-11-10' }).markdown, /^Período: 2026-11-01 a 2026-11-10 \(UTC\)$/m);
  assert.deepEqual(make({}, { from: '2026-11-01', to: '2026-11-10' }).sections[0].items, ['**Ordenar por fecha** — disponible desde 2026-11-10.'], 'the day of `to` is included');
  for (const bad of [{ from: 'ayer' }, { to: 'x' }, { from: '2026-02-31' }, { from: '2026-11-12', to: '2026-11-01' }, { from: '2026-11-12T12:00:00Z', to: '2026-11-12T12:00:00Z' }, { from: 5 }, { to: NOW }]) {
    assert.throws(() => make({}, bad), /from|to|date/i, JSON.stringify(bad));
  }
  assert.equal(make().markdown, make().markdown);
  assert.equal(initiativeReport(data(), { now: NOW }).markdown, make().markdown, '`to` defaults to now');
});

test('a part delivered with no known date is named in the notes, not listed as delivered', () => {
  const r = make({ deliverables: [part('D1', 41, 'Sin fecha', 'available')] });
  assert.deepEqual(r.sections.find((s) => s.id === 'delivered').items, ['En este período no se entregó nada.']);
  assert.match(r.sections.find((s) => s.id === 'notes').items[0], /^\*\*Sin fecha\*\* está disponible, pero no se conoce la fecha/);
});

test('the report refuses data that is not an initiative', () => {
  assert.throws(() => initiativeReport(null, { now: NOW }), /initiative/);
  assert.throws(() => initiativeReport({ deliverables: 'x' }, { now: NOW }), /initiative/);
});

test('the default window is the 7 whole UTC days before today, and a `to` in the future is capped at now', () => {
  const r = make({}, { now: Date.parse('2026-11-12T00:00:01Z') });
  assert.deepEqual(r.period, { from: '2026-11-05', to: '2026-11-11' });
  assert.equal(make({}, { now: Date.parse('2026-11-12T23:59:59Z') }).markdown, make({}, { now: Date.parse('2026-11-12T00:00:00Z') }).markdown, 'the same UTC day gives the same text');
  assert.deepEqual(make({}, { to: '2099-01-01' }).period, { from: '2026-11-05', to: '2026-11-12' }, 'capped at now: 2026-11-12');
  for (const language of ['en', 'es', 'pt']) assert.match(make({ language }).markdown, /^.+: 2026-11-05 .+ 2026-11-11 \(UTC\)$/m, language);
});

test('a date-time needs a zone, so the same input gives the same report in every time zone', async () => {
  assert.throws(() => make({}, { from: '2026-11-11T00:00:00' }), /from .*zone|Z/i);
  assert.throws(() => make({}, { to: '2026-11-11T10:00' }), /to .*zone|Z/i);
  const script = "import('./factory/lib/client-report.js').then(({ initiativeReport }) => { const d = JSON.parse(process.argv[1]); let out = initiativeReport(d, { from: '2026-11-11T00:00:00Z', to: '2026-11-12T23:30:00-05:00', now: Date.parse('2026-11-13T12:00:00Z') }).markdown; try { initiativeReport(d, { from: '2026-11-11T00:00:00' }); out += 'NO ERROR'; } catch (e) { out += e.message; } console.log(out); })";
  const outputs = [];
  for (const TZ of ['Asia/Tokyo', 'America/Lima']) {
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', script, JSON.stringify(data())], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, TZ } });
    outputs.push(stdout);
  }
  assert.equal(outputs[0], outputs[1]);
  assert.doesNotMatch(outputs[0], /NO ERROR/);
  assert.match(outputs[0], /disponible desde 2026-11-11/);
});

test('titles are plain: no links, no domains, no references', () => {
  const dirty = [
    part('D1', 41, 'Visit https://evil.com now', 'in-review'), part('D2', 42, 'See www.evil.com', 'in-factory'),
    part('D3', 43, 'evil.com', 'waiting-tech-lead'), part('D4', 44, 'Fix #123 and docs.example.io today', 'not-created'),
    part('D5', 45, 'Ver http://x.y/z?q=1', 'available', { available_at: '2026-11-11T09:00:00.000Z' }),
  ];
  const r = make({ deliverables: dirty, language: 'en', brief: { title: 'Brief: Tour evil.com #9' }, warnings: ['D3 was not found yet (x).'] }, { includeLinks: true, includeCost: true });
  const body = r.markdown.split('\n').filter((l) => !/^- .+: https:\/\/github\.com\//.test(l)).join('\n');
  assert.doesNotMatch(body, /evil|www\.|example|https?:|#\d|x\.y/);
  assert.match(r.markdown, /\*\*Visit now\*\*/);
  assert.match(r.markdown, /\*\*Fix and today\*\*/);
  assert.match(r.markdown, /^# Weekly progress report: Tour$/m);
  assert.match(r.markdown, /\*\*—\*\*/, 'a title that was only a domain becomes a dash');
  const links = r.sections.at(-1).items;
  assert.ok(links.every((x) => !/evil|#\d/.test(x.split(': https://')[0])), 'link labels are plain too');
});

test('the cost heading says what it covers, and the amount is always USD with a dot', () => {
  assert.deepEqual(['en', 'es', 'pt'].map((language) => make({ language }, { includeCost: true }).sections.find((x) => x.id === 'cost').heading), ['Cost of the parts delivered', 'Costo de las partes entregadas', 'Custo das partes entregues']);
  for (const language of ['en', 'es', 'pt']) assert.match(make({ language }, { includeCost: true }).sections.find((x) => x.id === 'cost').items[0], /USD 1\.50/);
});

test('long lists are capped: 5 dependencies per part, 20 items per section, with "+N more"', () => {
  const many = Array.from({ length: 25 }, (_, i) => part(`D${i + 10}`, null, `Futura ${i + 10}`, 'not-created'));
  const deps = Array.from({ length: 7 }, (_, i) => part(`D${i + 100}`, 200 + i, `Previa ${i}`, 'in-review'));
  const r = make({ deliverables: [...many, ...deps, part('D99', null, 'Final', 'not-created', { after: deps.map((d) => d.id) })] });
  const next = r.sections.find((x) => x.id === 'next').items;
  assert.equal(next.length, 21);
  assert.equal(next.at(-1), '+6 más');
  const progress = r.sections.find((x) => x.id === 'in-progress').items;
  assert.equal(progress.length, 7);
  const final = make({ deliverables: [...deps, part('D99', null, 'Final', 'not-created', { after: deps.map((d) => d.id) })], language: 'en' }).sections.find((x) => x.id === 'next').items[0];
  assert.equal(final, '**Final** — starts after **Previa 0**, **Previa 1**, **Previa 2**, **Previa 3**, **Previa 4**, +2 more.');
  assert.equal(make({ deliverables: many, language: 'pt' }).sections.find((x) => x.id === 'next').items.at(-1), '+5 mais');
});

test('no jargon in the plain report in any language, with cost on', () => {
  for (const language of ['en', 'es', 'pt']) {
    const r = make({ language }, { includeCost: true });
    assert.doesNotMatch(r.markdown, BANNED, language);
    assert.doesNotMatch(r.markdown, BANNED_PR, language);
  }
});
