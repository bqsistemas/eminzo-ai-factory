// The weekly report of ONE initiative, for a client: what became available, what is going on, what waits and
// what comes next, in functional language. Pure: it reads the data `initiative()` returns and sends nothing anywhere;
// the person reviews and edits the draft before sharing it. No ids, no numbers of issues or pull requests, no
// engine words: parts are named by their titles. Dates are ISO dates; estimates are ranges, never dates.
import { humanMinutes } from './state/estimate.js';

const DAY_MS = 86_400_000;
const PERIOD_DAYS = 7;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_ITEMS = 20;
const MAX_DEPS = 5;
const LANGUAGES = ['en', 'es', 'pt'];

const join = (titles) => titles.join(', ');

/** The words of the report per language. Functions take already-bold titles. */
const WORDS = {
  en: {
    draft: 'Draft — review before sharing.',
    title: (t) => `Weekly progress report: ${t}`,
    period: (a, b) => `Period: ${a} to ${b} (UTC)`,
    more: (n) => `+${n} more`,
    headings: { delivered: 'Delivered this period', 'in-progress': 'In progress', waiting: 'Waiting for a decision', next: 'Coming next', estimate: 'Estimate and actual', cost: 'Cost of the parts delivered', notes: 'Notes', links: 'Links' },
    part: ['part', 'parts'],
    available: ['is available', 'are available'],
    clauses: { progress: ['is in progress', 'are in progress'], waiting: ['is waiting for a decision', 'are waiting for a decision'], notStarted: ['has not started', 'have not started'], closed: ['was closed without being delivered', 'were closed without being delivered'] },
    of: (done, total, noun) => `${done} of ${total} ${noun}`,
    noParts: 'No parts were found for this initiative yet.',
    empty: { delivered: 'Nothing was delivered in this period.', 'in-progress': 'Nothing is in progress.', waiting: 'Nothing is waiting for a decision.', next: 'There are no parts left to start.', estimate: 'There is not enough data yet to compare the estimate with the real time.' },
    delivered: (t, d) => `${t} — available since ${d}.`,
    building: 'being built',
    review: 'in review',
    inProgress: (t, how) => `${t} — ${how}.`,
    waitingItem: (t) => `${t} — waiting for the tech lead to accept it.`,
    next: (t, deps) => (deps.length ? `${t} — starts after ${join(deps)}.` : `${t} — not started yet.`),
    estimateItem: (t, lo, hi, took) => `${t}: estimated ${lo} to ${hi}, took ${took}.`,
    estimateTotal: (lo, hi, took, c, n) => `Total: estimated ${lo} to ${hi}, took ${took} (parts compared: ${c} of ${n}).`,
    estimateNote: 'These are ranges measured on similar past work; they are not delivery dates.',
    cost: (usd, known, total, unknown) => `Known cost of the parts delivered in this period: USD ${usd} (known for ${known} of ${total} parts${unknown ? `; not known for ${unknown}` : ''}).`,
    costUnknown: 'The cost is not known.',
    costNone: 'Nothing was delivered in this period, so there is no cost to report.',
    notes: {
      notFound: (t) => `${t} is not visible in the tracking yet; it can take a minute to show up.`,
      closed: (t) => `${t} was closed without being delivered.`,
      reopened: (t) => `${t} was reopened after it had been delivered.`,
      fork: 'A change that came from outside the team was ignored.',
      lookalike: 'An item that looks like part of this work was ignored because it was not created for it.',
      edited: 'The approved plan was edited after it was approved; only the parts that were found are listed.',
      title: 'The title of the plan was changed after it was created; the approval does not cover the title.',
      approver: 'The plan was approved by a different person than the one who created it.',
      duplicate: (t) => `${t} appears more than once; the first one was used.`,
      incomplete: 'Some information could not be read in time; the report may be incomplete.',
      unknown: 'Something unusual was found in the tracking; the tech lead should take a look.',
      undated: (t) => `${t} is available, but its delivery date is not known, so it is not listed as delivered in this period.`,
    },
  },
  es: {
    draft: 'Borrador — revisar antes de compartir.',
    title: (t) => `Informe semanal de avance: ${t}`,
    period: (a, b) => `Período: ${a} a ${b} (UTC)`,
    more: (n) => `+${n} más`,
    headings: { delivered: 'Entregado en este período', 'in-progress': 'En curso', waiting: 'Esperando una decisión', next: 'Lo que sigue', estimate: 'Estimación y tiempo real', cost: 'Costo de las partes entregadas', notes: 'Notas', links: 'Enlaces' },
    part: ['parte', 'partes'],
    available: ['está disponible', 'están disponibles'],
    clauses: { progress: ['está en curso', 'están en curso'], waiting: ['está esperando una decisión', 'están esperando una decisión'], notStarted: ['no empezó', 'no empezaron'], closed: ['se cerró sin entregarse', 'se cerraron sin entregarse'] },
    of: (done, total, noun) => `${done} de ${total} ${noun}`,
    noParts: 'Todavía no se encontraron partes de esta iniciativa.',
    empty: { delivered: 'En este período no se entregó nada.', 'in-progress': 'No hay nada en curso.', waiting: 'Nada espera una decisión.', next: 'No quedan partes por empezar.', estimate: 'Todavía no hay datos suficientes para comparar la estimación con el tiempo real.' },
    delivered: (t, d) => `${t} — disponible desde ${d}.`,
    building: 'en construcción',
    review: 'en revisión',
    inProgress: (t, how) => `${t} — ${how}.`,
    waitingItem: (t) => `${t} — esperando que el líder técnico lo acepte.`,
    next: (t, deps) => (deps.length ? `${t} — empieza después de ${join(deps)}.` : `${t} — todavía no empezó.`),
    estimateItem: (t, lo, hi, took) => `${t}: estimado de ${lo} a ${hi}, tomó ${took}.`,
    estimateTotal: (lo, hi, took, c, n) => `Total: estimado de ${lo} a ${hi}, tomó ${took} (partes comparadas: ${c} de ${n}).`,
    estimateNote: 'Son rangos medidos sobre trabajo parecido; no son fechas de entrega.',
    cost: (usd, known, total, unknown) => `Costo conocido de las partes entregadas en este período: USD ${usd} (conocido en ${known} de ${total} partes${unknown ? `; no se conoce en ${unknown}` : ''}).`,
    costUnknown: 'El costo no se conoce.',
    costNone: 'En este período no se entregó nada, así que no hay costo que informar.',
    notes: {
      notFound: (t) => `${t} todavía no se ve en el seguimiento; puede tardar un minuto en aparecer.`,
      closed: (t) => `${t} se cerró sin haberse entregado.`,
      reopened: (t) => `${t} se reabrió después de haberse entregado.`,
      fork: 'Se ignoró un cambio que vino de fuera del equipo.',
      lookalike: 'Se ignoró un elemento que parece parte de este trabajo pero no fue creado para él.',
      edited: 'El plan aprobado se modificó después de aprobarse; solo se listan las partes que se encontraron.',
      title: 'El título del plan se cambió después de crearse; la aprobación no cubre el título.',
      approver: 'El plan fue aprobado por una persona distinta de quien lo creó.',
      duplicate: (t) => `${t} figura más de una vez; se usó la primera.`,
      incomplete: 'Parte de la información no se pudo leer a tiempo; el informe puede estar incompleto.',
      unknown: 'Se encontró algo inusual en el seguimiento; conviene que lo revise el líder técnico.',
      undated: (t) => `${t} está disponible, pero no se conoce la fecha de entrega, así que no se lista como entregada en este período.`,
    },
  },
  pt: {
    draft: 'Rascunho — revisar antes de compartilhar.',
    title: (t) => `Relatório semanal de andamento: ${t}`,
    period: (a, b) => `Período: ${a} a ${b} (UTC)`,
    more: (n) => `+${n} mais`,
    headings: { delivered: 'Entregue neste período', 'in-progress': 'Em andamento', waiting: 'Aguardando uma decisão', next: 'Próximos passos', estimate: 'Estimativa e tempo real', cost: 'Custo das partes entregues', notes: 'Notas', links: 'Links' },
    part: ['parte', 'partes'],
    available: ['está disponível', 'estão disponíveis'],
    clauses: { progress: ['está em andamento', 'estão em andamento'], waiting: ['está aguardando uma decisão', 'estão aguardando uma decisão'], notStarted: ['não começou', 'não começaram'], closed: ['foi encerrada sem ser entregue', 'foram encerradas sem serem entregues'] },
    of: (done, total, noun) => `${done} de ${total} ${noun}`,
    noParts: 'Ainda não foram encontradas partes desta iniciativa.',
    empty: { delivered: 'Nada foi entregue neste período.', 'in-progress': 'Não há nada em andamento.', waiting: 'Nada aguarda uma decisão.', next: 'Não restam partes para começar.', estimate: 'Ainda não há dados suficientes para comparar a estimativa com o tempo real.' },
    delivered: (t, d) => `${t} — disponível desde ${d}.`,
    building: 'em construção',
    review: 'em revisão',
    inProgress: (t, how) => `${t} — ${how}.`,
    waitingItem: (t) => `${t} — aguardando que o líder técnico aceite.`,
    next: (t, deps) => (deps.length ? `${t} — começa depois de ${join(deps)}.` : `${t} — ainda não começou.`),
    estimateItem: (t, lo, hi, took) => `${t}: estimado de ${lo} a ${hi}, levou ${took}.`,
    estimateTotal: (lo, hi, took, c, n) => `Total: estimado de ${lo} a ${hi}, levou ${took} (partes comparadas: ${c} de ${n}).`,
    estimateNote: 'São faixas medidas sobre trabalho parecido; não são datas de entrega.',
    cost: (usd, known, total, unknown) => `Custo conhecido das partes entregues neste período: USD ${usd} (conhecido em ${known} de ${total} partes${unknown ? `; não se conhece em ${unknown}` : ''}).`,
    costUnknown: 'O custo não é conhecido.',
    costNone: 'Nada foi entregue neste período, então não há custo para informar.',
    notes: {
      notFound: (t) => `${t} ainda não aparece no acompanhamento; pode levar um minuto para aparecer.`,
      closed: (t) => `${t} foi encerrada sem ter sido entregue.`,
      reopened: (t) => `${t} foi reaberta depois de ter sido entregue.`,
      fork: 'Uma mudança que veio de fora da equipe foi ignorada.',
      lookalike: 'Um item que parece parte deste trabalho foi ignorado porque não foi criado para ele.',
      edited: 'O plano aprovado foi modificado depois de aprovado; só as partes encontradas estão listadas.',
      title: 'O título do plano foi alterado depois de criado; a aprovação não cobre o título.',
      approver: 'O plano foi aprovado por uma pessoa diferente de quem o criou.',
      duplicate: (t) => `${t} aparece mais de uma vez; a primeira foi usada.`,
      incomplete: 'Parte das informações não pôde ser lida a tempo; o relatório pode estar incompleto.',
      unknown: 'Algo incomum foi encontrado no acompanhamento; convém que o líder técnico dê uma olhada.',
      undated: (t) => `${t} está disponível, mas a data de entrega não é conhecida, então não aparece como entregue neste período.`,
    },
  },
};

/** An instant in ms from an ISO date (a day alone: its start, or its end for `end`) or date-time; throws a sentence otherwise. */
function instant(name, value, { end = false } = {}) {
  const bad = () => new Error(`${name} must be an ISO date (2026-11-12) or a date-time with its zone (2026-11-12T09:00:00Z or 2026-11-12T09:00:00-05:00).`);
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw bad();
    return value.getTime();
  }
  if (typeof value !== 'string') throw bad();
  if (DATE_ONLY.test(value)) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw bad();
    return end ? ms + DAY_MS - 1 : ms;
  }
  const ms = DATE_TIME.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw bad();
  return ms;
}

/** A title as plain words: no links, no domains that would turn into links, no `#123` references. Linear: one pass per rule. */
function plain(title) {
  const text = String(title ?? '')
    .replace(/\S+:\/\/\S*/g, ' ')
    .replace(/\bwww\.\S*/gi, ' ')
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|co)\b/gi, ' ')
    .replace(/#\d+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return text || '—';
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const timeOf = (v) => { const ms = Date.parse(v ?? ''); return Number.isFinite(ms) ? ms : null; };
const bold = (t) => `**${plain(t)}**`;

/** The plain-words notes for the initiative's warnings, without repeats, in the order they came. */
function notesOf(warnings, deliverables, words) {
  const byId = new Map(deliverables.map((d) => [d.id, d]));
  const byIssue = new Map(deliverables.filter((d) => d.issue !== null).map((d) => [d.issue, d]));
  const N = words.notes;
  const out = [];
  for (const raw of warnings) {
    const w = String(raw);
    const of = (m, map, key) => { const d = m && map.get(key(m)); return d ? bold(d.title) : null; };
    let note;
    let m;
    if ((m = /^(D\d+) was not found yet/.exec(w))) { const t = of(m, byId, (x) => x[1]); note = t ? N.notFound(t) : N.unknown; }
    else if ((m = /^#(\d+) was closed without a merged change/.exec(w))) { const t = of(m, byIssue, (x) => Number(x[1])); note = t ? N.closed(t) : N.unknown; }
    else if ((m = /^#(\d+) was reopened after a merged change/.exec(w))) { const t = of(m, byIssue, (x) => Number(x[1])); note = t ? N.reopened(t) : N.unknown; }
    else if (/^pull request #\d+ comes from a fork/.test(w)) note = N.fork;
    else if (/looks like a deliverable of this brief/.test(w)) note = N.lookalike;
    else if (/the brief issue no longer matches its approval/.test(w)) note = N.edited;
    else if (/^The title of the brief issue was changed/.test(w)) note = N.title;
    else if (/^The brief issue was created by .+ but approved by /.test(w)) note = N.approver;
    else if ((m = /^(D\d+) has more than one issue/.exec(w))) { const t = of(m, byId, (x) => x[1]); note = t ? N.duplicate(t) : N.unknown; }
    else if (/^gh call limit reached|^only the first \d+ |^could not read /.test(w)) note = N.incomplete;
    else note = N.unknown;
    if (!out.includes(note)) out.push(note);
  }
  return out;
}

/**
 * The weekly report of an initiative, a draft the person reviews before sharing.
 * @param {object} data what `initiative()` returned
 * @param {{ from?: string, to?: string, language?: 'en'|'es'|'pt', includeCost?: boolean, includeLinks?: boolean, now?: number }} [options]
 *   Period: `from` (default 7 days before `to`) to `to` (default `now`); a date alone means that whole day.
 * @returns {{ title: string, status: string, period: { from: string, to: string }, markdown: string, sections: { id: string, heading: string, items: string[] }[], warnings: string[] }}
 */
export function initiativeReport(data, { from, to, language, includeCost = false, includeLinks = false, now = Date.now() } = {}) {
  if (data === null || typeof data !== 'object' || !Array.isArray(data.deliverables)) throw new Error('initiativeReport needs the data of an initiative.');
  // By default the window is the 7 whole UTC days before today, so the same day always gives the same report.
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const wanted = to === undefined ? today - 1 : instant('to', to, { end: true });
  const end = Math.min(wanted, now);
  const start = from === undefined ? (to === undefined ? today - PERIOD_DAYS * DAY_MS : end - PERIOD_DAYS * DAY_MS) : instant('from', from);
  if (start >= end) throw new Error('from must be before to.');
  const lang = LANGUAGES.includes(language) ? language : LANGUAGES.includes(data.language) ? data.language : 'en';
  const words = WORDS[lang];
  const parts = data.deliverables;
  const where = (status) => parts.filter((d) => d.status === status);
  const rawTitle = String(data.brief?.title ?? '').replace(/^\s*brief\s*:\s*/i, '');
  const name = plain(rawTitle);

  const available = where('available');
  const dated = available.map((d) => ({ d, at: timeOf(d.available_at) }));
  const delivered = dated.filter((x) => x.at !== null && x.at >= start && x.at <= end).sort((a, b) => a.at - b.at).map((x) => x.d);
  const undated = dated.filter((x) => x.at === null).map((x) => x.d);
  const titleOf = (id) => { const d = parts.find((x) => x.id === id); return d ? bold(d.title) : null; };

  const sections = [];
  const add = (id, items, tail = []) => sections.push({ id, heading: words.headings[id], items: [...(items.length > MAX_ITEMS ? [...items.slice(0, MAX_ITEMS), words.more(items.length - MAX_ITEMS)] : items), ...tail] });
  add('delivered', delivered.length ? delivered.map((d) => words.delivered(bold(d.title), day(timeOf(d.available_at)))) : [words.empty.delivered]);
  const progress = [...where('in-review').map((d) => words.inProgress(bold(d.title), words.review)), ...where('in-factory').map((d) => words.inProgress(bold(d.title), words.building))];
  add('in-progress', progress.length ? progress : [words.empty['in-progress']]);
  const waiting = where('waiting-tech-lead');
  add('waiting', waiting.length ? waiting.map((d) => words.waitingItem(bold(d.title))) : [words.empty.waiting]);
  const upcoming = where('not-created');
  const unmet = (d) => {
    const all = (d.after ?? []).filter((id) => parts.find((x) => x.id === id)?.status !== 'available').map(titleOf).filter(Boolean);
    return all.length > MAX_DEPS ? [...all.slice(0, MAX_DEPS), words.more(all.length - MAX_DEPS)] : all;
  };
  add('next', upcoming.length
    ? upcoming.map((d) => words.next(bold(d.title), unmet(d)))
    : [words.empty.next]);

  const compared = available.filter((d) => d.estimate && typeof d.actual_min === 'number');
  const total = data.estimate_vs_actual;
  const estimate = compared.map((d) => words.estimateItem(bold(d.title), humanMinutes(d.estimate.low_min), humanMinutes(d.estimate.high_min), humanMinutes(d.actual_min)));
  const totalLine = compared.length && total?.estimated ? [words.estimateTotal(humanMinutes(total.estimated.low_min), humanMinutes(total.estimated.high_min), humanMinutes(total.actual_min), compared.length, available.length)] : [];
  if (compared.length) add('estimate', estimate, [...totalLine, words.estimateNote]);
  else add('estimate', [words.empty.estimate]);

  if (includeCost) {
    const known = delivered.filter((d) => typeof d.cost_usd === 'number' && Number.isFinite(d.cost_usd));
    const sum = Math.round(known.reduce((s, d) => s + d.cost_usd, 0) * 100) / 100;
    add('cost', [!delivered.length ? words.costNone : known.length ? words.cost(sum.toFixed(2), known.length, delivered.length, delivered.length - known.length) : words.costUnknown]);
  }

  const notes = [...notesOf(Array.isArray(data.warnings) ? data.warnings : [], parts, words), ...undated.map((d) => words.notes.undated(bold(d.title)))];
  if (notes.length) add('notes', notes);
  if (includeLinks) {
    const links = parts.filter((d) => typeof d.url === 'string' && /^https?:\/\/\S+$/.test(d.url)).map((d) => `${plain(d.title)}: ${d.url}`);
    if (links.length) add('links', links);
  }

  const done = available.length;
  const clauses = [['progress', where('in-review').length + where('in-factory').length], ['waiting', waiting.length], ['notStarted', upcoming.length], ['closed', where('closed').length]]
    .filter(([, n]) => n > 0).map(([key, n]) => `${n} ${words.clauses[key][n === 1 ? 0 : 1]}`);
  const status = parts.length
    ? `${words.of(done, parts.length, words.part[parts.length === 1 ? 0 : 1])} ${words.available[done === 1 ? 0 : 1]}${clauses.map((c) => `; ${c}`).join('')}.`
    : words.noParts;

  const heading = words.title(name);
  const lines = [words.draft, '', `# ${heading}`, '', words.period(day(start), day(end)), '', status];
  for (const s of sections) lines.push('', `## ${s.heading}`, '', ...s.items.map((i) => `- ${i}`));
  return { title: heading, status, period: { from: day(start), to: day(end) }, markdown: `${lines.join('\n')}\n`, sections, warnings: notes };
}
