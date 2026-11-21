// The brief contract: the document a Product Lead approves before any issue exists. Fixed sections (headings in
// English, Spanish or Portuguese), acceptance criteria with stable ids (BC-n), deliverables with size, risk, the
// criteria they cover and what they wait for; and the conversion of an Elephant-Goldfish concepts_brief.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BRIEF_MARKER, SECTIONS, fromEgmConcepts, parseBrief, renderBrief, renderBriefTemplate, validateBrief } from '../factory/lib/brief.js';

const BRIEF = {
  title: 'Filtro de sugerencias',
  sections: {
    problem: 'Los revisores pierden tiempo buscando lo pendiente entre sugerencias ya resueltas.',
    audience: 'Revisores de contenido.',
    value: 'Menos tiempo por revisión y menos pendientes olvidadas.',
    today: 'La lista muestra todas las sugerencias juntas, sin filtro.',
    scope: '- Filtrar por pendientes.\n- Recordar el filtro al volver.',
    out_of_scope: '- Notificaciones por correo.',
    questions: '- ¿Los administradores ven el mismo filtro?',
  },
  criteria: [
    { id: 'BC-1', text: 'Un revisor ve solo las sugerencias pendientes con un clic.' },
    { id: 'BC-2', text: 'El filtro sigue activo al volver a la lista.' },
    { id: 'BC-3', text: 'Las pendientes de más de 7 días se marcan.' },
  ],
  deliverables: [
    { id: 'D1', title: 'Ver solo lo pendiente', size: 's', risk: 'low', covers: ['BC-1'], after: [], uses: [] },
    { id: 'D2', title: 'Conservar el filtro', size: 's', risk: 'low', covers: ['BC-2'], after: ['D1'], uses: [] },
    { id: 'D3', title: 'Aviso de pendientes antiguas', size: 'm', risk: 'high', covers: ['BC-3'], after: [], uses: [] },
  ],
};

test('render and parse round-trip, in Spanish headings', () => {
  const text = renderBrief(BRIEF, 'es');
  assert.ok(text.startsWith(`${BRIEF_MARKER}\n# Brief: Filtro de sugerencias\n`));
  assert.match(text, /^## Para quién$/m);
  assert.match(text, /^## Criterios de aceptación\n\n- BC-1: Un revisor ve solo/m);
  assert.match(text, /^- D2: Conservar el filtro \| size: s \| risk: low \| covers: BC-2 \| after: D1$/m);
  const parsed = parseBrief(text);
  assert.equal(parsed.title, BRIEF.title);
  assert.equal(parsed.language, 'es');
  assert.deepEqual(parsed.sections, BRIEF.sections);
  assert.deepEqual(parsed.criteria, BRIEF.criteria);
  assert.deepEqual(parsed.deliverables, BRIEF.deliverables);
  assert.deepEqual(validateBrief(parsed), { ok: true, problems: [], warnings: [] });
});

test('headings are recognized in English and Portuguese too, ignoring case and accents', () => {
  assert.equal(parseBrief(renderBrief(BRIEF, 'en')).language, 'en');
  assert.deepEqual(parseBrief(renderBrief(BRIEF, 'pt')).criteria, BRIEF.criteria);
  const loose = renderBrief(BRIEF, 'es').replace('## Para quién', '## PARA QUIEN');
  assert.equal(parseBrief(loose).sections.audience, 'Revisores de contenido.');
  assert.equal(SECTIONS.length, 10);
});

test('validateBrief names every blocking problem', () => {
  const broken = parseBrief([
    '# Brief: x',
    '## Problem', 'Something.',
    '## Acceptance criteria', '- BC-1: one', '- BC-1: again', '- criterion without id',
    '## Deliverables', '- D1: A | size: xl | risk: low | covers: BC-9', '- D2: B | size: s | risk: low | covers: BC-1 | after: D3', 'not a deliverable line',
    '## Mystery', 'text',
  ].join('\n'));
  const { ok, problems } = validateBrief(broken);
  assert.equal(ok, false);
  assert.deepEqual(problems, [
    'section "For whom" is missing or empty',
    'section "Expected value" is missing or empty',
    'section "How it works today" is missing or empty',
    'section "Scope" is missing or empty',
    'section "Out of scope" is missing or empty',
    'acceptance criterion BC-1 appears twice',
    'Acceptance criterion could not be read: write it as "- BC-1: what a person can check". Line: "- criterion without id"',
    'deliverable D1: size must be xs, s, m or l',
    'deliverable D1: covers BC-9, which is not an acceptance criterion',
    'deliverable D2: waits for D3, which is not a deliverable',
    'Deliverable could not be read: write it as "- D1: title | size: s | risk: low | covers: BC-1". Line: "not a deliverable line"',
    'unknown section "Mystery"',
  ]);
});

const withLines = (criteria, deliverables) => parseBrief(renderBrief({ ...BRIEF, criteria: [], deliverables: [] }, 'en')
  .replace(/(## Acceptance criteria\n\n)[^]*?(\n\n## Deliverables\n\n)[^]*$/, `$1${criteria.join('\n')}$2${deliverables.join('\n')}\n`));

test('an emphasized id and colon is read as the plain id, and the text is kept as written', () => {
  const ids = ['**BC-1**:', '**BC-1:**', '*BC-1*:', '*BC-1:*', '__BC-1__:', '_BC-1_:', '`BC-1`:', '`BC-1:`', 'BC-1:'];
  for (const bullet of ['-', '*', '+']) {
    for (const id of ids) {
      const dId = id.replace('BC-1', 'D1');
      const b = withLines([`${bullet} ${id} La página abre **rápido**.`], [`${bullet} ${dId} Encabezado | size: s | risk: low | covers: BC-1`]);
      assert.deepEqual(b.criteria, [{ id: 'BC-1', text: 'La página abre **rápido**.' }], `${bullet} ${id}`);
      assert.deepEqual(b.deliverables, [{ id: 'D1', title: 'Encabezado', size: 's', risk: 'low', covers: ['BC-1'], after: [], uses: [] }], ` `);
      assert.deepEqual(validateBrief(b).problems.filter((p) => /could not be read/.test(p)), []);
    }
  }
});

test('unbalanced or odd emphasis is reported, never guessed', () => {
  const odd = ['**BC-1: text', 'BC-1**: text', '**BC-1*: text', '*BC-1_: text', '**BC-1** text', '***BC-1***: text'];
  for (const o of odd) {
    const b = withLines([`- ${o}`], [`- ${o.replace('BC-1', 'D1')} | size: s | risk: low | covers: BC-1`]);
    assert.deepEqual(b.criteria, [], o);
    assert.deepEqual(b.deliverables, [], o);
    assert.deepEqual(b.badCriteria, [`- ${o}`]);
  }
  assert.equal(withLines(['*BC-1*: text without a bullet'], []).criteria.length, 0);
});

test('validateBrief warns about what is legal but worth a second look', () => {
  const brief = structuredClone(BRIEF);
  brief.deliverables[2] = { ...brief.deliverables[2], size: 'l', covers: ['BC-1'] };
  brief.deliverables.push({ id: 'D4', title: 'Ciclo', size: 's', risk: 'low', covers: ['BC-1'], after: ['D5'], uses: [] }, { id: 'D5', title: 'Ciclo 2', size: 's', risk: 'low', covers: ['BC-1'], after: ['D4'] });
  const { problems, warnings } = validateBrief(parseBrief(renderBrief(brief, 'en')));
  assert.deepEqual(problems, ['deliverables D4, D5 wait for each other']);
  assert.deepEqual(warnings, [
    'acceptance criterion BC-3 is not covered by any deliverable',
    'deliverable D3 is large: consider splitting it',
  ]);
});

const EGM = `# Eminzo AI Factory landing page

* **Author:** Jhon Barrantes
* **Date:** 2026-11-09
* **Status:** Brainstorm complete after the Goldfish review (7 lenses, 2026-11-09).

## Overview

A public landing page for Eminzo.

It should get visitors to install the CLI.

## Analysis

### Critical objections (these change the plan)

1. **The numbers the page promises have no producer.**

### Secondary trade-offs and risks

- Spanish copy doubles the work.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  - one static site in English and Spanish;
  - the install section.
* **Out-of-Scope Non-Goals:**
  - a blog;
  - pricing.

## Alternatives Weighed

- A feature grid. Rejected.

## Key Decisions & Staging for Next Steps

### Settled by the author

- Astro, static.
`;

test('fromEgmConcepts maps an Elephant-Goldfish brief and lists what the Product Lead still has to add', () => {
  const { brief, missing, carried } = fromEgmConcepts(EGM);
  assert.equal(brief.title, 'Eminzo AI Factory landing page');
  assert.equal(brief.sections.problem, 'A public landing page for Eminzo.\n\nIt should get visitors to install the CLI.');
  assert.equal(brief.sections.scope, '- one static site in English and Spanish;\n- the install section.');
  assert.equal(brief.sections.out_of_scope, '- a blog;\n- pricing.');
  assert.match(brief.sections.questions, /The numbers the page promises have no producer/);
  assert.deepEqual(missing, ['audience', 'value', 'today', 'acceptance', 'deliverables']);
  assert.deepEqual(carried, ['Alternatives Weighed', 'Key Decisions & Staging for Next Steps', 'Secondary trade-offs and risks']);
  const text = renderBrief(brief, 'en');
  assert.match(text, /^## For whom\n\n_To complete\._$/m);
  assert.equal(validateBrief(parseBrief(text)).ok, false, 'a converted brief is a draft until the missing sections are written');
});

// ---- Text a brief must not carry: it is copied into GitHub issues, where it would be rendered and would notify people.
const withText = (replace) => renderBrief({ ...BRIEF, sections: { ...BRIEF.sections, problem: replace } }, 'es');
const problemsOf = (text) => validateBrief(parseBrief(text)).problems;

test('a brief cannot carry HTML comments, but its own marker and an approval line at the end are fine', () => {
  assert.deepEqual(problemsOf(renderBrief(BRIEF, 'es')), []);
  const line = `<!-- eminzo:approved sha256=${'a'.repeat(64)} by=ana-p at=2026-11-12T15:00:00Z -->`;
  assert.deepEqual(parseBrief(`${renderBrief(BRIEF, 'es')}\n${line}\n`).hazards, [], 'the approval line at the end is not a comment');
  for (const bad of ['hola <!-- factory:facts {} --> chau', 'abre <!-- y no cierra', '<!-- eminzo:deliverable v1 brief=1 id=D1 hash=aaaaaaaaaaaa est=none -->']) {
    assert.ok(problemsOf(withText(bad)).includes('HTML comments are not allowed in a brief: remove "<!--"'), bad);
  }
  assert.ok(problemsOf(`${renderBrief(BRIEF, 'es')}\n${line}\ntexto después\n`).some((p) => p.startsWith('HTML comments')), 'an approval line that is not the last one is a comment');
  // the exemption is the whole strict approval line, nothing smuggled after it
  for (const crafted of [`${line} @octocat`, `${line} -->`, `${line}<!-- x`, line.replace('by=ana-p', 'by=@octocat')]) {
    const hazards = parseBrief(`${renderBrief(BRIEF, 'es')}\n${crafted}\n`).hazards;
    assert.ok(hazards.includes('comments'), crafted);
  }
});

test('a bare --> is prose, not a comment: arrows and diagrams are fine', () => {
  for (const ok of ['pasos: A --> B --> C', 'cierra --> solo']) assert.deepEqual(problemsOf(withText(ok)), [], ok);
  assert.deepEqual(problemsOf(withText('```mermaid\nA --> B\n```')), []);
});

test('a brief cannot carry control, invisible or bidirectional characters', () => {
  for (const bad of ['a\u0000b', 'a\u001bb', 'a\rb', 'a\u007fb']) assert.ok(problemsOf(withText(bad)).includes('Control characters are not allowed in a brief'), JSON.stringify(bad));
  for (const bad of ['a\u202eb', 'a\u2066b', 'a\u2069b', 'a\u200fb']) assert.ok(problemsOf(withText(bad)).includes('Bidirectional control characters are not allowed in a brief'), JSON.stringify(bad));
  for (const bad of ['a\u0085b', 'a\u0080b', 'a\u009fb', 'a\u2028b', 'a\u2029b', 'a\u00adb', 'a\u2060b', 'a\u200bb', 'a\u200cb', 'a\u200db', 'a\ufeffb']) {
    assert.ok(problemsOf(withText(bad)).includes('Invisible characters are not allowed in a brief'), JSON.stringify(bad));
  }
  assert.deepEqual(problemsOf(withText('tab\tok y acentos áéí ñ 🙂')), []);
});

test('a brief cannot mention people with @, except in e-mail addresses, code spans and code blocks', () => {
  const message = 'Remove the @ before a name (or put it in backticks): GitHub would notify that person when the issues are created';
  for (const bad of ['pregunta a @ana-p', '@ana al inicio', 'con (@equipo) y más', 'a @org/team', 'foo-@octocat', 'x.@user', '+@user', 'a/@user', '`code` y @ana', 'abre ` y @ana', '``a` @ana']) {
    assert.ok(problemsOf(withText(bad)).includes(message), bad);
  }
  for (const ok of ['escribir a ana@example.com', 'solo una @ suelta', 'precio a@b', 'usar `@angular/core` aquí', 'usar ``@a ` @b`` aquí', '```\n@angular/core\n```', '~~~\nfoo @bar\n~~~']) {
    assert.deepEqual(problemsOf(withText(ok)), [], ok);
  }
  assert.ok(problemsOf(withText('```\n@a\n```\nluego @ana')).includes(message), 'after the block it applies again');
});

test('the mention scan is linear on hostile lines', () => {
  const started = Date.now();
  parseBrief(`# Brief: x\n## Problema\n${'`` ` '.repeat(100_000)}\n${'a@'.repeat(100_000)}\n`);
  assert.ok(Date.now() - started < 2000);
});

// ---- Definitions, `uses` and the new warnings ------------------------------------------------------------------

test('Definitions is an optional section in en, es and pt, between Out of scope and Acceptance criteria', () => {
  const keys = SECTIONS.map((s) => s.key);
  assert.equal(keys.indexOf('definitions'), keys.indexOf('out_of_scope') + 1);
  assert.equal(keys.indexOf('acceptance'), keys.indexOf('definitions') + 1);
  const heading = { en: 'Definitions', es: 'Definiciones', pt: 'Definições' };
  for (const lang of ['en', 'es', 'pt']) {
    const text = renderBrief({ ...BRIEF, sections: { ...BRIEF.sections, definitions: '- Pending: not yet reviewed.' } }, lang);
    assert.match(text, new RegExp(`^## ${heading[lang]}$`, 'm'));
    const parsed = parseBrief(text);
    assert.equal(parsed.sections.definitions, '- Pending: not yet reviewed.');
    assert.equal(parsed.language, lang);
    assert.equal(validateBrief(parsed).problems.length, 0);
  }
  // optional: omitted when empty, and a brief without it is still valid
  assert.doesNotMatch(renderBrief(BRIEF, 'en'), /Definitions/);
});

test('Definitions counts in the language vote', () => {
  const text = ['# Brief: x', '## Problem', 'p', '## Definiciones', 'd', '## Definiciones', 'd'].join('\n');
  assert.equal(parseBrief(text).language, 'es');
});

test('a deliverable line may say which criteria it `uses`, and render/parse round-trip keeps them', () => {
  const brief = structuredClone(BRIEF);
  brief.deliverables[1].uses = ['BC-1'];
  const text = renderBrief(brief, 'en');
  assert.match(text, /^- D2: Conservar el filtro \| size: s \| risk: low \| covers: BC-2 \| after: D1 \| uses: BC-1$/m);
  const parsed = parseBrief(text);
  assert.deepEqual(parsed.deliverables[1].uses, ['BC-1']);
  assert.deepEqual(parsed.deliverables[0].uses, []);
  assert.deepEqual(validateBrief(parsed), { ok: true, problems: [], warnings: [] });
});

test('`uses` is a problem when the id is unknown or not covered by a deliverable in `after`', () => {
  const brief = structuredClone(BRIEF);
  brief.deliverables[1].uses = ['BC-9', 'BC-3', 'BC-1'];
  const { ok, problems } = validateBrief(parseBrief(renderBrief(brief, 'en')));
  assert.equal(ok, false);
  assert.deepEqual(problems, [
    'deliverable D2: uses BC-9, which is not an acceptance criterion',
    'deliverable D2: uses BC-3, which no deliverable it waits for covers',
  ]);
  const none = structuredClone(BRIEF);
  none.deliverables[0].uses = ['BC-2'];
  assert.deepEqual(validateBrief(parseBrief(renderBrief(none, 'en'))).problems, ['deliverable D1: uses BC-2, which no deliverable it waits for covers']);
});

test('warns about a deliverable that covers more than 8 criteria', () => {
  const brief = structuredClone(BRIEF);
  brief.criteria = Array.from({ length: 9 }, (_, i) => ({ id: `BC-${i + 1}`, text: `Thing ${i + 1} works.` }));
  brief.deliverables = [{ id: 'D1', title: 'Big', size: 'm', risk: 'low', covers: brief.criteria.map((c) => c.id), after: [] }];
  const { problems, warnings } = validateBrief(parseBrief(renderBrief(brief, 'en')));
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, ['deliverable D1 covers 9 acceptance criteria; the factory\'s spec takes 3 to 8: split it or move shared rules to Definitions']);
  brief.criteria = brief.criteria.slice(0, 8);
  brief.deliverables[0].covers = brief.criteria.map((c) => c.id);
  assert.deepEqual(validateBrief(parseBrief(renderBrief(brief, 'en'))).warnings, []);
});

test('warns about a criterion that starts with Given/Dado but has no when/cuando/quando', () => {
  const brief = structuredClone(BRIEF);
  brief.criteria = [
    { id: 'BC-1', text: 'Given a reviewer on the list, then only pending items show.' },
    { id: 'BC-2', text: 'Dado un revisor en la lista, cuando abre el filtro, entonces ve pendientes.' },
    { id: 'BC-3', text: 'Dado un revisor, entonces ve algo.' },
    { id: 'BC-6', text: 'Given name is shown on the profile.' },
    { id: 'BC-4', text: 'Dado um revisor, quando abre, então vê.' },
    { id: 'BC-5', text: 'Given a reviewer, when they open it, then it shows.' },
  ];
  brief.deliverables = [{ id: 'D1', title: 'A', size: 's', risk: 'low', covers: ['BC-1', 'BC-2', 'BC-3', 'BC-4', 'BC-5', 'BC-6'], after: [] }];
  const { warnings } = validateBrief(parseBrief(renderBrief(brief, 'en')));
  assert.deepEqual(warnings, [
    'acceptance criterion BC-1 starts with "Given" but has no "when": write it as "Given …, when …, then …"',
    'acceptance criterion BC-3 starts with "Dado" but has no "when": write it as "Given …, when …, then …"',
  ]);
});

test('the brief template shows Definitions, a one-line Given/when/then criterion and a `uses` example, in its language', () => {
  const expected = {
    en: { def: '## Definitions', given: /^- BC-1: Given .+, when .+, then .+$/m },
    es: { def: '## Definiciones', given: /^- BC-1: Dado .+, cuando .+, entonces .+$/m },
    pt: { def: '## Definições', given: /^- BC-1: Dado .+, quando .+, então .+$/m },
  };
  for (const lang of ['en', 'es', 'pt']) {
    const text = renderBriefTemplate('Filter', lang);
    assert.ok(text.startsWith(`${BRIEF_MARKER}\n# Brief: Filter\n`));
    assert.ok(text.includes(`\n${expected[lang].def}\n`), lang);
    assert.match(text, expected[lang].given, lang);
    assert.match(text, /^- D2: .+ \| size: s \| risk: low \| covers: BC-2 \| after: D1 \| uses: BC-1$/m, lang);
    const parsed = parseBrief(text);
    assert.equal(parsed.language, lang);
    assert.equal(parsed.criteria[0].id, 'BC-1');
    assert.deepEqual(parsed.deliverables[1].uses, ['BC-1']);
    assert.equal(validateBrief(parsed).ok, false, 'still a draft: the sections are to be completed');
  }
});

test('warns when a deliverable waits for another but uses none of its criteria', () => {
  const brief = structuredClone(BRIEF);
  brief.deliverables[1].uses = ['BC-3'];
  assert.deepEqual(validateBrief(parseBrief(renderBrief(brief, 'en'))).problems.length, 1, 'BC-3 is not covered by D1: still a problem');
  const ok = structuredClone(BRIEF);
  ok.deliverables.push({ id: 'D4', title: 'Cuarta', size: 's', risk: 'low', covers: ['BC-3'], after: ['D1', 'D2'], uses: ['BC-2'] });
  ok.deliverables[2].covers = [];
  ok.deliverables.splice(2, 1);
  const { problems, warnings } = validateBrief(parseBrief(renderBrief(ok, 'en')));
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, ['deliverable D4 waits for D1 but uses none of its criteria: fine if it only needs the order; otherwise add them to uses']);
  const none = structuredClone(BRIEF);
  assert.deepEqual(validateBrief(parseBrief(renderBrief(none, 'en'))).warnings, [], 'no `uses` at all: all of each dependency, no warning');
});
