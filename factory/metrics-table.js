// The metrics table of the dashboard: pure functions from `board.metrics` and a dictionary to rows, and a
// renderer that only uses createElement/textContent/append, so a stub document can drive it in tests.

const pct = (r, T) => (typeof r === 'number' ? `${Math.round(r * 1000) / 10}%` : T.metricsNA);

/** True when the board holds metrics worth showing: no error and at least one job. */
export const hasMetrics = (m) => Boolean(m && !m.error && m.jobs);

/** `[[label, value]]` rows. Replacements use functions so `$&` in a lens or kind name stays literal. */
export function metricsRows(m, T) {
  return [
    [T.metricsGate, `${m.gate_pass_round1.passed}/${m.gate_pass_round1.total} (${pct(m.gate_pass_round1.rate, T)})`],
    [T.metricsRounds, String(m.rounds_per_job.median ?? T.metricsNA)],
    ...Object.entries(m.changes_by_lens).map(([lens, v]) => [T.metricsChanges.replace('{lens}', () => lens), `${v.changes}/${v.total} (${pct(v.rate, T)})`]),
    ...Object.entries(m.minutes_by_kind).map(([kind, v]) => [T.metricsMinutes.replace('{kind}', () => kind), `${v.total} (${T.metricsJobsShort.replace('{n}', () => v.jobs)})`]),
    [T.metricsLessons, m.repeated_lessons.length ? m.repeated_lessons.map((l) => `${l.count}× ${l.text}`).join(' · ') : T.metricsNoLessons],
  ];
}

/** Fills `table` (an empty-able element) with a header row and one row per metric. Text only, never markup. */
export function renderMetricsTable(doc, table, m, T) {
  const cell = (tag, text, scope) => {
    const el = doc.createElement(tag);
    el.textContent = text;
    if (scope) el.scope = scope;
    return el;
  };
  const row = (...cells) => { const tr = doc.createElement('tr'); tr.append(...cells); return tr; };
  const head = doc.createElement('thead');
  head.append(row(cell('th', T.metricsMetric, 'col'), cell('th', T.metricsValue, 'col')));
  const body = doc.createElement('tbody');
  body.append(...metricsRows(m, T).map(([label, value]) => row(cell('th', label, 'row'), cell('td', value))));
  table.replaceChildren(head, body);
}
