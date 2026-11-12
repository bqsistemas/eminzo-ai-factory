// The brief contract: the document a Product Lead approves before any issue exists. Fixed sections (headings in
// English, Spanish or Portuguese), acceptance criteria with stable ids (BC-n), deliverables with size, risk, the
// criteria they cover and what they wait for; and the conversion of an Elephant-Goldfish concepts_brief.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BRIEF_MARKER, SECTIONS, fromEgmConcepts, parseBrief, renderBrief, validateBrief } from '../factory/lib/brief.js';

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
    { id: 'D1', title: 'Ver solo lo pendiente', size: 's', risk: 'low', covers: ['BC-1'], after: [] },
    { id: 'D2', title: 'Conservar el filtro', size: 's', risk: 'low', covers: ['BC-2'], after: ['D1'] },
    { id: 'D3', title: 'Aviso de pendientes antiguas', size: 'm', risk: 'high', covers: ['BC-3'], after: [] },
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
  assert.equal(SECTIONS.length, 9);
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
    'acceptance criterion line is not "- BC-n: text": "- criterion without id"',
    'deliverable D1: size must be xs, s, m or l',
    'deliverable D1: covers BC-9, which is not an acceptance criterion',
    'deliverable D2: waits for D3, which is not a deliverable',
    'deliverable line is not "- Dn: title | size: s | risk: low | covers: BC-1": "not a deliverable line"',
    'unknown section "Mystery"',
  ]);
});

test('validateBrief warns about what is legal but worth a second look', () => {
  const brief = structuredClone(BRIEF);
  brief.deliverables[2] = { ...brief.deliverables[2], size: 'l', covers: ['BC-1'] };
  brief.deliverables.push({ id: 'D4', title: 'Ciclo', size: 's', risk: 'low', covers: ['BC-1'], after: ['D5'] }, { id: 'D5', title: 'Ciclo 2', size: 's', risk: 'low', covers: ['BC-1'], after: ['D4'] });
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
