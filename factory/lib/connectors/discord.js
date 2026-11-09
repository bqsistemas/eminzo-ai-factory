// Incoming webhooks are bearer credentials. Never return request/response details.
export function validWebhook(value) {
  return typeof value === 'string'
    && /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v[0-9]{1,2}\/)?webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/.test(value);
}

const identifier = (value) => String(value ?? '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100);
const issueNumber = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
const githubLink = (value, kind) => typeof value === 'string'
  && new RegExp(`^https://github\\.com/[\\w.-]+/[\\w.-]+/${kind}/[1-9]\\d*$`).test(value) ? value : null;

// Free text (issue titles, transition notes) can be written by third parties or quote
// tool output. Redaction is best-effort and runs on the whole text before truncation, so
// a secret is never cut into an unrecognisable fragment that survives.
const REDACT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /https?:\/\/\S*discord(?:app)?\.com\/api\/\S*/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@\S*/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{8,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:bearer|basic)\s+\S+/gi,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|auth|credentials?)\b\s*[:=]\s*\S+/gi,
  /[A-Za-z0-9+/_-]{32,}={0,2}/g,
];

const REDACTED = '[redacted]';

// Markdown, masked-link, mention and autolink syntax are shown literally.
const literal = (text) => text
  .replace(/[\\`*_~|>#[\]()<]/g, '\\$&')
  .replace(/@/g, '@\u200b')
  .replace(/:\/\//g, ':\u200b//');

/** Redacted, single-line, bounded (at most 2 * max characters) and inert Discord text. */
export function safeText(value, max) {
  if (typeof value !== 'string') return '';
  // Bound the regex work; anything past this point is truncated away anyway.
  let text = value.slice(0, 8 * max);
  for (const pattern of REDACT) text = text.replace(pattern, REDACTED);
  text = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
  return text.split(REDACTED).map(literal).join(REDACTED);
}

// Embed colours by category (decimal RGB): blue, amber, green, red.
export const COLORS = Object.freeze({ progress: 0x3b82f6, attention: 0xf59e0b, success: 0x22c55e, failure: 0xef4444 });

// Phrase tables. Keys are `from>to` (`new` when there is no previous stage) and, as a
// fallback, the destination stage. An array holds [with the number, without it]. Placeholders:
// {round} = N, {rounds} = N/M (N when the maximum is unknown), {pr} = PR number. The language
// is only ever used as a key of this table, never interpolated.
export const PHRASES = Object.freeze({
  en: {
    'new>intake': '🆕 New job: Intake is reading the issue',
    'intake>spec': '📋 Issue accepted: writing the spec',
    'intake>build': '⚡ Issue accepted on the fast lane: building',
    'spec>build': ['🔨 Spec ready: the builder started round {round}', '🔨 Spec ready: the builder started'],
    'build>gate': '🧪 Build ready: running the checks',
    'gate>review': '🔍 Checks passed: reviewers are working',
    'gate>build': ['⚠️ Checks failed: back to the builder (round {rounds})', '⚠️ Checks failed: back to the builder'],
    'review>build': ['✏️ Reviewers requested changes (round {rounds})', '✏️ Reviewers requested changes'],
    'review>approve': '✅ Reviews approved: deciding on the merge',
    'approve>merging': '🔀 Approved: syncing with the base and merging',
    merged: ['🎉 Merged: PR #{pr} into the base', '🎉 Merged into the base'],
    'awaiting-merge': '👀 PR ready: waiting for your merge',
    'needs-info': '❓ Missing information in the issue: reply to continue',
    'needs-human': '🙋 Needs your decision',
    rejected: '⛔ Rejected',
    intake: '🆕 Intake is reading the issue',
    spec: '📋 Writing the spec',
    build: ['🔨 The builder is working (round {round})', '🔨 The builder is working'],
    gate: '🧪 Running the checks',
    review: '🔍 Reviewers are working',
    approve: '✅ Deciding on the merge',
    merging: '🔀 Merging into the base',
  },
  es: {
    'new>intake': '🆕 Nuevo trabajo: Intake está leyendo el issue',
    'intake>spec': '📋 Issue aceptado: escribiendo la spec',
    'intake>build': '⚡ Issue aceptado por el carril rápido: construyendo',
    'spec>build': ['🔨 Spec lista: el builder arrancó la ronda {round}', '🔨 Spec lista: el builder arrancó'],
    'build>gate': '🧪 Build listo: corriendo los checks',
    'gate>review': '🔍 Checks en verde: revisores trabajando',
    'gate>build': ['⚠️ Fallaron los checks: vuelve al builder (ronda {rounds})', '⚠️ Fallaron los checks: vuelve al builder'],
    'review>build': ['✏️ Los revisores pidieron cambios (ronda {rounds})', '✏️ Los revisores pidieron cambios'],
    'review>approve': '✅ Revisiones aprobadas: decidiendo el merge',
    'approve>merging': '🔀 Aprobado: sincronizando con la base y mergeando',
    merged: ['🎉 Mergeado: PR #{pr} en la base', '🎉 Mergeado en la base'],
    'awaiting-merge': '👀 PR listo: esperando tu merge',
    'needs-info': '❓ Falta información en el issue: respondé para continuar',
    'needs-human': '🙋 Necesita tu decisión',
    rejected: '⛔ Rechazado',
    intake: '🆕 Intake está leyendo el issue',
    spec: '📋 Escribiendo la spec',
    build: ['🔨 El builder está trabajando (ronda {round})', '🔨 El builder está trabajando'],
    gate: '🧪 Corriendo los checks',
    review: '🔍 Revisores trabajando',
    approve: '✅ Decidiendo el merge',
    merging: '🔀 Mergeando en la base',
  },
  pt: {
    'new>intake': '🆕 Novo trabalho: o Intake está lendo a issue',
    'intake>spec': '📋 Issue aceita: escrevendo a spec',
    'intake>build': '⚡ Issue aceita pela via rápida: construindo',
    'spec>build': ['🔨 Spec pronta: o builder iniciou a rodada {round}', '🔨 Spec pronta: o builder iniciou'],
    'build>gate': '🧪 Build pronto: rodando os checks',
    'gate>review': '🔍 Checks em verde: revisores trabalhando',
    'gate>build': ['⚠️ Os checks falharam: volta ao builder (rodada {rounds})', '⚠️ Os checks falharam: volta ao builder'],
    'review>build': ['✏️ Os revisores pediram mudanças (rodada {rounds})', '✏️ Os revisores pediram mudanças'],
    'review>approve': '✅ Revisões aprovadas: decidindo o merge',
    'approve>merging': '🔀 Aprovado: sincronizando com a base e fazendo o merge',
    merged: ['🎉 Merge feito: PR #{pr} na base', '🎉 Merge feito na base'],
    'awaiting-merge': '👀 PR pronto: aguardando o seu merge',
    'needs-info': '❓ Faltam informações na issue: responda para continuar',
    'needs-human': '🙋 Precisa da sua decisão',
    rejected: '⛔ Rejeitado',
    intake: '🆕 O Intake está lendo a issue',
    spec: '📋 Escrevendo a spec',
    build: ['🔨 O builder está trabalhando (rodada {round})', '🔨 O builder está trabalhando'],
    gate: '🧪 Rodando os checks',
    review: '🔍 Revisores trabalhando',
    approve: '✅ Decidindo o merge',
    merging: '🔀 Fazendo o merge na base',
  },
});

const LABELS = Object.freeze({
  en: { stage: 'Stage', issue: 'Issue', round: 'Round', pr: 'PR', risk: 'Risk', reviews: 'Reviews', cost: 'Cost', duration: 'Duration', note: 'Note', action: 'What to do' },
  es: { stage: 'Fase', issue: 'Issue', round: 'Ronda', pr: 'PR', risk: 'Riesgo', reviews: 'Revisiones', cost: 'Costo', duration: 'Duración', note: 'Nota', action: 'Qué hacer' },
  pt: { stage: 'Fase', issue: 'Issue', round: 'Rodada', pr: 'PR', risk: 'Risco', reviews: 'Revisões', cost: 'Custo', duration: 'Duração', note: 'Nota', action: 'O que fazer' },
});

// Stage display names; `new` is the origin of a job that just started.
const STAGES = Object.freeze({
  en: {
    new: 'New', intake: 'Intake', spec: 'Spec', 'spec-review': 'Spec review', build: 'Build', gate: 'Gate', review: 'Review',
    approve: 'Approve', merging: 'Merging', merged: 'Merged', 'awaiting-merge': 'Awaiting merge',
    'needs-info': 'Needs info', 'needs-human': 'Needs human', rejected: 'Rejected',
  },
  es: {
    new: 'Nuevo', intake: 'Intake', spec: 'Spec', 'spec-review': 'Revisión de spec', build: 'Build', gate: 'Gate', review: 'Revisión',
    approve: 'Aprobación', merging: 'Mergeando', merged: 'Mergeado', 'awaiting-merge': 'Esperando merge',
    'needs-info': 'Falta info', 'needs-human': 'Necesita decisión', rejected: 'Rechazado',
  },
  pt: {
    new: 'Novo', intake: 'Intake', spec: 'Spec', 'spec-review': 'Revisão da spec', build: 'Build', gate: 'Gate', review: 'Revisão',
    approve: 'Aprovação', merging: 'Fazendo merge', merged: 'Merge feito', 'awaiting-merge': 'Aguardando merge',
    'needs-info': 'Faltam informações', 'needs-human': 'Precisa de decisão', rejected: 'Rejeitado',
  },
});

const RISKS = Object.freeze({
  en: { low: 'Low', medium: 'Medium', high: 'High' },
  es: { low: 'bajo', medium: 'medio', high: 'alto' },
  pt: { low: 'baixo', medium: 'médio', high: 'alto' },
});

// Stages where cost and duration are final or the job is parked.
const SETTLED = Object.freeze(['merged', 'awaiting-merge', 'needs-human', 'needs-info', 'rejected']);
const VERDICTS = Object.freeze({ PASS: '✅', CHANGES: '✏️' });

function stageName(lang, token) {
  const table = STAGES[lang];
  const id = identifier(token);
  return Object.hasOwn(table, id) ? table[id] : id;
}

function duration(startedAt, endedAt) {
  const start = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  const end = typeof endedAt === 'string' ? Date.parse(endedAt) : NaN;
  const minutes = Math.floor((end - start) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return '';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function reviewsLine(reviews) {
  if (!reviews || typeof reviews !== 'object' || Array.isArray(reviews)) return '';
  return Object.entries(reviews).slice(0, 8)
    .filter(([lens, verdict]) => /^[a-z][a-z0-9-]{0,30}$/.test(lens) && Object.hasOwn(VERDICTS, verdict))
    .map(([lens, verdict]) => `${identifier(lens)} ${VERDICTS[verdict]}`).join(' · ');
}

// {cmd} is built here from a validated integer, never from event text.
const ACTIONS = Object.freeze({
  en: {
    'needs-info': 'Reply in the issue as its author so the factory can continue.',
    'needs-human': 'Decide, then run {cmd}.',
    'awaiting-merge': 'Merge the PR on GitHub.',
  },
  es: {
    'needs-info': 'Respondé en el issue como su autor para que la factory continúe.',
    'needs-human': 'Decidí y después corré {cmd}.',
    'awaiting-merge': 'Mergeá el PR en GitHub.',
  },
  pt: {
    'needs-info': 'Responda na issue como autor dela para que a factory continue.',
    'needs-human': 'Decida e depois rode {cmd}.',
    'awaiting-merge': 'Faça o merge do PR no GitHub.',
  },
});

const LIMITS = { title: 256, description: 4096, name: 256, value: 1024, fields: 25, footer: 2048, total: 6000 };

/** Colour category of a transition. */
export function category(from, to) {
  if (to === 'rejected') return 'failure';
  if (['approve', 'merging', 'merged', 'awaiting-merge'].includes(to)) return 'success';
  if (['needs-info', 'needs-human'].includes(to)) return 'attention';
  if (to === 'build' && (from === 'gate' || from === 'review')) return 'attention';
  return 'progress';
}

// Cuts to `max` characters without leaving a lone escape backslash (which would escape the
// next character) or half a surrogate pair.
function clip(text, max) {
  let out = text.length > max ? text.slice(0, max) : text;
  if (out.length < text.length) {
    if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
    const slashes = out.length - out.replace(/\\+$/, '').length;
    if (slashes % 2 === 1) out = out.slice(0, -1);
  }
  return out;
}

const count = (value, min) => Number.isSafeInteger(value) && value >= min ? value : null;

function phrase(lang, event, round, maxRounds, prNumber) {
  const table = PHRASES[lang];
  const from = identifier(event.from) || 'new';
  const to = identifier(event.to);
  const entry = table[`${from}>${to}`] ?? (Object.hasOwn(table, to) ? table[to] : null);
  const text = Array.isArray(entry)
    ? entry[(/\{pr\}/.test(entry[0]) ? prNumber != null : round != null) ? 0 : 1]
    : entry;
  if (typeof text !== 'string') return '';
  return text
    .replace('{rounds}', () => (maxRounds != null ? `${round}/${maxRounds}` : `${round}`))
    .replace('{round}', () => `${round}`)
    .replace('{pr}', () => `${prNumber}`);
}

export function discordPayload(event) {
  const lang = typeof event.language === 'string' && Object.hasOwn(PHRASES, event.language) ? event.language : 'en';
  const labels = LABELS[lang];
  const to = identifier(event.to);
  const round = count(event.round, 0);
  const maxRounds = round != null ? count(event.max_rounds, 1) : null;
  const issueUrl = githubLink(event.url, 'issues');
  const prUrl = githubLink(event.prUrl, 'pull');
  const issue = issueNumber(event.issue) ?? (issueUrl ? issueNumber(Number(issueUrl.split('/').pop())) : null);
  const prNumber = prUrl ? issueNumber(Number(prUrl.split('/').pop())) : null;

  const embed = {
    title: clip(phrase(lang, event, round, maxRounds, prNumber), LIMITS.title),
    color: COLORS[category(identifier(event.from) || 'new', to)],
  };
  const link = issue ? (issueUrl ? `[#${issue}](${issueUrl})` : `#${issue}`) : '';
  const issueTitle = safeText(event.title, 200);
  const description = [link, issueTitle].filter(Boolean).join(' ');
  if (description) embed.description = clip(description, LIMITS.description);
  const url = prUrl ?? issueUrl;
  if (url) embed.url = url;
  const repo = typeof event.repoUrl === 'string' ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/.exec(event.repoUrl) : null;
  if (repo) embed.author = { name: repo[1], url: event.repoUrl };

  const fields = [];
  const fromToken = identifier(event.from) || 'new';
  if (to) fields.push({ name: labels.stage, value: `${stageName(lang, fromToken)} → ${stageName(lang, to)}`, inline: true });
  if (issue) fields.push({ name: labels.issue, value: issueUrl ? `[#${issue}](${issueUrl})` : `#${issue}`, inline: true, link: Boolean(issueUrl) });
  if (prNumber != null) fields.push({ name: labels.pr, value: `[#${prNumber}](${prUrl})`, inline: true, link: true });
  if (round != null && maxRounds != null) fields.push({ name: labels.round, value: `${round}/${maxRounds}`, inline: true });
  if (Object.hasOwn(RISKS[lang], event.risk)) {
    fields.push({ name: labels.risk, value: `${RISKS[lang][event.risk]}${event.lane === 'xs' ? ' · XS' : ''}`, inline: true });
  }
  const reviewed = fromToken === 'review' ? reviewsLine(event.reviews) : '';
  if (reviewed) fields.push({ name: labels.reviews, value: reviewed, inline: false });
  if (SETTLED.includes(to)) {
    if (typeof event.cost_usd === 'number' && Number.isFinite(event.cost_usd) && event.cost_usd >= 0) {
      fields.push({ name: labels.cost, value: `$${event.cost_usd.toFixed(2)}`, inline: true });
    }
    const elapsed = duration(event.started, event.timestamp);
    if (elapsed) fields.push({ name: labels.duration, value: elapsed, inline: true });
  }
  const note = safeText(event.note, 300);
  if (note) fields.push({ name: labels.note, value: note, inline: true });
  if (Object.hasOwn(ACTIONS[lang], to)) {
    const cmd = issue ? `\`/eminzo-factory rework ${issue}\`` : '`/eminzo-factory rework`';
    fields.push({ name: labels.action, value: ACTIONS[lang][to].replace('{cmd}', cmd) });
  }
  // Masked links are never clipped: a link that does not fit is dropped whole.
  embed.fields = fields.slice(0, LIMITS.fields)
    .filter((f) => !f.link || f.value.length <= LIMITS.value)
    .map(({ link, ...f }) => ({ ...f, name: clip(f.name, LIMITS.name), value: link ? f.value : clip(f.value, LIMITS.value) }));
  const id = identifier(event.id);
  embed.footer = { text: clip(id ? `Eminzo Factory · ${id}` : 'Eminzo Factory', LIMITS.footer) };
  if (typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp))) {
    embed.timestamp = new Date(event.timestamp).toISOString();
  }
  // Whole-embed budget: drop optional fields from the end until it fits.
  const size = () => embed.title.length + (embed.description?.length ?? 0) + embed.footer.text.length
    + (embed.author?.name.length ?? 0) + embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  while (size() > LIMITS.total && embed.fields.length) embed.fields.pop();
  return { username: 'Eminzo Factory', embeds: [embed], allowed_mentions: { parse: [] } };
}

export async function send(event, { webhookUrl, fetch = globalThis.fetch, timeoutMs = 1500 } = {}) {
  if (!validWebhook(webhookUrl)) return { status: 'invalid_config' };
  const controller = new AbortController();
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 5000)) : 1500;
  let timer;
  try {
    // Race as well as abort: injected transports need not honor AbortSignal.
    return await Promise.race([
      Promise.resolve().then(async () => {
        const response = await fetch(webhookUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(discordPayload(event)), redirect: 'error', signal: controller.signal,
        });
        // Do not read potentially sensitive or unbounded error bodies.
        const status = response.status === 429 ? 'rate_limited'
          : response.status >= 200 && response.status < 300 ? 'sent' : 'failed';
        try { await response.body?.cancel(); } catch { /* transport cleanup only */ }
        return { status };
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => { resolve({ status: 'timeout' }); controller.abort(); }, duration);
      }),
    ]);
  } catch {
    return { status: controller.signal.aborted ? 'timeout' : 'failed' };
  } finally {
    clearTimeout(timer);
  }
}
