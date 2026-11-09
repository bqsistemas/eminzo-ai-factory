import { test } from 'node:test';
import assert from 'node:assert/strict';
import { send, validWebhook, discordPayload, COLORS } from '../factory/lib/connectors/discord.js';
import { lifecycleEvent } from '../factory/lib/notifications.js';
const webhook = 'https://discord.com/api/webhooks/123456/token_abc';
const event = { id: '106-test', issue: 106, type: 'job.merged', from: 'merging', to: 'merged', timestamp: '2026-11-05T12:00:00Z', url: 'https://github.com/acme/repo/issues/106' };

test('AC-3: allow only canonical HTTPS Discord webhook endpoints without credentials or query', async () => {
  assert.equal(validWebhook(webhook), true);
  for (const url of ['https://discordapp.com/api/webhooks/1/t', 'https://ptb.discord.com/api/webhooks/1/t', 'https://canary.discord.com/api/v10/webhooks/1/t']) {
    assert.equal(validWebhook(url), true, url);
  }
  for (const url of ['http://discord.com/api/webhooks/1/t', 'https://evil.com/api/webhooks/1/t', `${webhook}?x=secret`, `${webhook}#secret`, 'https://u:p@discord.com/api/webhooks/1/t', 'https://discord.com:444/api/webhooks/1/t', 'https://discord.com/api/webhooks/1/t/slack', 'https://discord.com/api/webhooks/../t', 'https://xdiscord.com/api/webhooks/1/t', 'https://discord.com.evil.example/api/webhooks/1/t', 'https://evil.discord.com/api/webhooks/1/t', 'https://discord.com/api/webhooks/1/t\n', undefined]) {
    assert.equal(validWebhook(url), false, String(url));
    const result = await send(event, { webhookUrl: url, fetch: () => assert.fail('invalid destination fetched') });
    assert.equal(result.status, 'invalid_config');
  }
});

const embedOf = (e) => discordPayload(e).embeds[0];
const flat = (embed) => [embed.title, embed.description ?? '', embed.footer.text, ...embed.fields.flatMap((f) => [f.name, f.value])];
const total = (embed) => flat(embed).join('').length;

test('AC-1: payload is a single embed with sender, no content, title, colour, link, footer and timestamp', () => {
  const payload = discordPayload({ ...event, title: 'My issue', from: 'approve', to: 'merging', prUrl: 'https://github.com/acme/repo/pull/7', language: 'es' });
  assert.equal(payload.username, 'Eminzo Factory');
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.deepEqual(Object.keys(payload).sort(), ['allowed_mentions', 'embeds', 'username']);
  assert.equal(payload.embeds.length, 1);
  const embed = payload.embeds[0];
  assert.ok(embed.title.length > 0);
  assert.ok(Number.isInteger(embed.color));
  assert.ok(embed.description.includes('[#106](https://github.com/acme/repo/issues/106)'));
  assert.ok(Array.isArray(embed.fields));
  assert.equal(embed.footer.text, 'Eminzo Factory · 106-test');
  assert.equal(embed.timestamp, '2026-11-05T12:00:00.000Z');
  assert.equal(embed.url, 'https://github.com/acme/repo/pull/7');
  assert.equal(embedOf(event).url, 'https://github.com/acme/repo/issues/106');
  assert.equal('url' in embedOf({ ...event, url: undefined }), false);
  assert.equal('timestamp' in embedOf({ ...event, timestamp: 'nope' }), false);
});

const ROWS = [
  [null, 'intake', '🆕 Nuevo trabajo: Intake está leyendo el issue', 'progress'],
  ['intake', 'spec', '📋 Issue aceptado: escribiendo la spec', 'progress'],
  ['intake', 'build', '⚡ Issue aceptado por el carril rápido: construyendo', 'progress'],
  ['spec', 'build', '🔨 Spec lista: el builder arrancó la ronda 2', 'progress'],
  ['build', 'gate', '🧪 Build listo: corriendo los checks', 'progress'],
  ['gate', 'review', '🔍 Checks en verde: revisores trabajando', 'progress'],
  ['gate', 'build', '⚠️ Fallaron los checks: vuelve al builder (ronda 2/3)', 'attention'],
  ['review', 'build', '✏️ Los revisores pidieron cambios (ronda 2/3)', 'attention'],
  ['review', 'approve', '✅ Revisiones aprobadas: decidiendo el merge', 'success'],
  ['approve', 'merging', '🔀 Aprobado: sincronizando con la base y mergeando', 'success'],
  ['merging', 'merged', '🎉 Mergeado: PR #7 en la base', 'success'],
  ['review', 'awaiting-merge', '👀 PR listo: esperando tu merge', 'success'],
  ['intake', 'needs-info', '❓ Falta información en el issue: respondé para continuar', 'attention'],
  ['build', 'needs-human', '🙋 Necesita tu decisión', 'attention'],
  ['build', 'rejected', '⛔ Rechazado', 'failure'],
];
for (const [from, to, title, color] of ROWS) {
  test(`AC-2: ${from ?? 'new'} -> ${to} has its Spanish title and ${color} colour`, () => {
    const embed = embedOf({ ...event, from, to, language: 'es', round: 2, max_rounds: 3, prUrl: 'https://github.com/acme/repo/pull/7' });
    assert.equal(embed.title, title);
    assert.equal(embed.color, COLORS[color]);
  });
}

test('AC-2: colours are four distinct integers and every other stage has a plain human title', () => {
  assert.deepEqual(Object.keys(COLORS).sort(), ['attention', 'failure', 'progress', 'success']);
  assert.equal(new Set(Object.values(COLORS)).size, 4);
  assert.ok(Object.values(COLORS).every(Number.isInteger));
  const stages = ['intake', 'needs-info', 'spec', 'build', 'gate', 'review', 'approve', 'merging', 'awaiting-merge', 'merged', 'needs-human', 'rejected'];
  for (const language of ['en', 'es', 'pt']) for (const to of stages) for (const from of ['needs-human', 'spec', null]) {
    const { title } = embedOf({ ...event, language, from, to });
    assert.ok(title.length > 0 && title.length <= 256, `${language} ${to}`);
    assert.match(title, /^\p{Extended_Pictographic}/u);
    for (const jargon of ['stage.changed', '->', '106-test', 'undefined', 'NaN']) assert.ok(!title.includes(jargon), `${language} ${to}: ${title}`);
  }
});

test('AC-3: round, PR and note are inline fields and action appears only for the three actionable stages', () => {
  const base = { ...event, from: 'review', to: 'build', round: 2, max_rounds: 3, prUrl: 'https://github.com/acme/repo/pull/9', note: 'syncing with origin/main', language: 'en' };
  const { fields } = embedOf(base);
  assert.deepEqual(fields.map((f) => f.value), ['Review → Build', '[#106](https://github.com/acme/repo/issues/106)', '[#9](https://github.com/acme/repo/pull/9)', '2/3', 'syncing with origin/main']);
  assert.ok(fields.every((f) => f.inline === true));
  const action = (to, language = 'en') => embedOf({ ...base, to, language }).fields.find((f) => !f.inline);
  assert.match(action('needs-human').value, /`\/eminzo-factory rework 106`/);
  assert.equal(action('needs-human', 'es').name, 'Qué hacer');
  assert.ok(action('needs-info') && action('awaiting-merge'));
  assert.match(action('needs-info').value, /author/);
  assert.match(action('needs-info', 'es').value, /autor/);
  assert.match(action('needs-info', 'pt').value, /autor/);
  for (const to of ['intake', 'spec', 'build', 'gate', 'review', 'approve', 'merging', 'merged', 'rejected']) assert.equal(action(to), undefined, to);
  const bare = discordPayload({ ...event, to: 'build', from: 'spec', language: 'es', round: 'x', max_rounds: NaN });
  const text = JSON.stringify(bare);
  assert.ok(!text.includes('undefined') && !text.includes('NaN'));
  assert.ok(!embedOf({ ...event, round: 2 }).fields.some((f) => f.name === 'Round'));
  assert.equal(embedOf({ ...event, from: 'gate', to: 'build', round: 2 }).title, '⚠️ Checks failed: back to the builder (round 2)');
});

test('AC-4: texts come out in the configured language and fall back to English', () => {
  const job = { id: '106-test', issue: 106, stage: 'needs-human', updated: event.timestamp, note: 'n' };
  const out = {};
  for (const language of ['en', 'es', 'pt', undefined, 'fr', '__proto__', 7]) {
    const embed = embedOf(lifecycleEvent(job, 'build', { language, repo: 'https://github.com/acme/repo' }));
    out[String(language)] = [embed.title, embed.fields.map((f) => f.name).join(), embed.fields.at(-1).value];
  }
  assert.equal(new Set([out.en.join('|'), out.es.join('|'), out.pt.join('|')]).size, 3);
  for (const key of ['undefined', 'fr', '__proto__', '7']) assert.deepEqual(out[key], out.en, key);
  assert.equal(out.en[0], '🙋 Needs your decision');
  assert.equal(out.pt[0], '🙋 Precisa da sua decisão');
});

test('AC-5: secrets, mentions, markdown and non-GitHub links never reach the embed', () => {
  const payload = discordPayload({ ...event, id: '@everyone <@123> `oops`'.repeat(300), title: `password=hidden ${webhook} **bold** @everyone <@123> https://u:p@example.com/x`, note: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789 private-artifact-secret', body: 'private issue', url: `${webhook}?secret=hidden`, prUrl: 'https://evil.example/pull/1', token: 'hidden', env: { FACTORY_DISCORD_WEBHOOK_URL: webhook } });
  const text = JSON.stringify(payload);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  for (const secret of [webhook, 'token_abc', 'private issue', 'hidden', '@everyone', '<@123>', 'evil.example', 'ghp_abc', 'u:p@', '**bold**', 'discord.com']) assert.ok(!text.includes(secret), secret);
  assert.match(text, /\[redacted\]/);
  const embed = payload.embeds[0];
  assert.equal('url' in embed, false);
  assert.ok(!/https?:/.test(embed.description));
  const ok = embedOf({ ...event, prUrl: 'https://github.com/acme/repo/pull/7', title: 'Fix', language: 'en' });
  assert.equal(ok.url, 'https://github.com/acme/repo/pull/7');
  const bad = JSON.stringify(discordPayload({ ...event, url: 'javascript:alert(1)', prUrl: 'https://github.com.evil/acme/repo/pull/7' }));
  assert.ok(!bad.includes('javascript:') && !bad.includes('evil'));
});

test('AC-5: title and note are included only after redaction, mention/markdown neutralisation and length limits', () => {
  const secrets = ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'sk-proj-abcdefghijklmnop1234', 'xoxb-1234567890-abcdefghij', 'AKIAABCDEFGHIJKLMNOP', 'hunter2', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrst', 's3cr3t-basic', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5'];
  const title = `Fix login @everyone <@&42> **bold** ${webhook} https://user:pass@example.com/x ${secrets[0]} ${secrets[4]}`;
  const note = `blocked: password=hunter2 token: ${secrets[0]} ${secrets[1]} ${secrets[2]} ${secrets[3]} ${secrets[4]} Bearer ${secrets[6]} https://u:${secrets[7]}@h.example ${secrets[8]} -----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY----- ${'x '.repeat(400)}`;
  const payload = discordPayload({ ...event, type: 'job.needs_human', from: 'build', to: 'needs-human', title, note });
  const text = JSON.stringify(payload);
  const embed = payload.embeds[0];
  const noteValue = embed.fields.find((f) => f.name === 'Note').value;
  assert.match(embed.description, /Fix login/);
  assert.match(noteValue, /^blocked:/);
  assert.match(text, /\[redacted\]/);
  for (const secret of [...secrets, webhook, 'token_abc', 'user:pass', 'MIIabc', '@everyone', '<@&42>', '**bold**']) assert.ok(!text.includes(secret), secret);
  assert.ok(embed.description.length <= 2 * 200 + 60, embed.description.length);
  assert.ok(noteValue.length <= 2 * 300, noteValue.length);
  assert.ok(!/[\r\n\t\u0000-\u001f]/.test(embed.description + noteValue));
});

test('AC-6: huge text stays within every Discord limit and never ends in a loose escape', () => {
  for (const text of ['a'.repeat(1e6), '@'.repeat(1e6), '*'.repeat(1e6), '\\'.repeat(1e6), '😀'.repeat(1e6)]) {
    for (const to of ['needs-human', 'merged', 'build']) {
      const embed = embedOf({ ...event, id: 'x'.repeat(1e6), to, title: text, note: text, round: 2, max_rounds: 3, prUrl: 'https://github.com/acme/repo/pull/7', language: 'pt' });
      assert.ok(embed.title.length <= 256);
      assert.ok(embed.description.length <= 4096);
      assert.ok(embed.fields.length <= 25);
      for (const f of embed.fields) assert.ok(f.name.length <= 256 && f.value.length <= 1024);
      assert.ok(embed.footer.text.length <= 2048);
      assert.ok(total(embed) <= 6000);
      for (const f of embed.fields) assert.ok(!/(?<!\\)(?:\\\\)*\\$/.test(f.value), 'loose escape');
      assert.ok(!/(?<!\\)(?:\\\\)*\\$/.test(embed.description), 'loose escape');
    }
  }
});

test('AC-2: valid Discord JSON uses bounded POST and never follows redirects', async () => {
  const result = await send(event, { webhookUrl: webhook, fetch: async (url, options) => {
    assert.equal(url, webhook);
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), discordPayload(event));
    assert.ok(options.signal);
    return { status: 204 };
  } });
  assert.equal(result.status, 'sent');
});

for (const [label, fetch, expected] of [
  ['rate limit', async () => ({ status: 429 }), 'rate_limited'],
  ['server error', async () => ({ status: 500 }), 'failed'],
  ['redirect', async () => ({ status: 302 }), 'failed'],
  ['network error', async () => { throw new Error(webhook); }, 'failed'],
  ['timeout', () => new Promise(() => {}), 'timeout'],
]) test(`AC-5: ${label} returns a safe retryable result`, async () => {
  const result = await send(event, { webhookUrl: webhook, fetch, timeoutMs: 10 });
  assert.equal(result.status, expected);
  assert.ok(!JSON.stringify(result).includes(webhook));
});

const fieldMap = (e) => Object.fromEntries(embedOf(e).fields.map((f) => [f.name, f.value]));
const rich = { ...event, from: 'spec', to: 'build', round: 2, max_rounds: 3, prUrl: 'https://github.com/acme/repo/pull/178', language: 'en' };

test('AC-9: Stage field shows origin and destination, localized, with New for started jobs', () => {
  assert.equal(fieldMap(rich).Stage, 'Spec → Build');
  assert.equal(fieldMap({ ...rich, language: 'es' }).Fase, 'Spec → Build');
  assert.equal(fieldMap({ ...rich, language: 'es', from: 'build', to: 'gate' }).Fase, 'Build → Gate');
  assert.equal(fieldMap({ ...rich, from: null, to: 'intake' }).Stage, 'New → Intake');
  assert.equal(fieldMap({ ...rich, from: null, to: 'intake', language: 'es' }).Fase, 'Nuevo → Intake');
  assert.equal(fieldMap({ ...rich, from: null, to: 'intake', language: 'pt' }).Fase, 'Novo → Intake');
  assert.equal(fieldMap({ ...rich, from: 'awaiting-merge', to: 'merged', language: 'es' }).Fase, 'Esperando merge → Mergeado');
  assert.equal(fieldMap({ ...rich, from: 'we!ird', to: 'spec' }).Stage, 'weird → Spec');
  assert.equal(embedOf(rich).fields[0].inline, true);
});

test('AC-9: Issue and PR are masked links when URLs validate, plain numbers otherwise', () => {
  const m = fieldMap(rich);
  assert.equal(m.Issue, '[#106](https://github.com/acme/repo/issues/106)');
  assert.equal(m.PR, '[#178](https://github.com/acme/repo/pull/178)');
  const plain = fieldMap({ ...rich, url: 'https://evil.example/x/issues/1', prUrl: undefined });
  assert.equal(plain.Issue, '#106');
  assert.equal('PR' in plain, false);
  assert.equal(fieldMap({ ...rich, prUrl: 'javascript:alert(1)' }).PR, undefined);
});

test('AC-9: Risk is localized with an XS marker; Reviews only when leaving review', () => {
  assert.equal(fieldMap({ ...rich, risk: 'high' }).Risk, 'High');
  assert.equal(fieldMap({ ...rich, risk: 'low', lane: 'xs' }).Risk, 'Low · XS');
  assert.equal(fieldMap({ ...rich, risk: 'medium', language: 'es' }).Riesgo, 'medio');
  assert.equal(fieldMap({ ...rich, risk: 'high', language: 'pt' }).Risco, 'alto');
  assert.equal(fieldMap({ ...rich, risk: 'bogus' }).Risk, undefined);
  const reviews = { code: 'PASS', ux: 'PASS', ui: 'CHANGES' };
  assert.equal(fieldMap({ ...rich, from: 'review', to: 'build', reviews }).Reviews, 'code ✅ · ux ✅ · ui ✏️');
  assert.equal(fieldMap({ ...rich, from: 'review', to: 'build', reviews, language: 'es' }).Revisiones, 'code ✅ · ux ✅ · ui ✏️');
  assert.equal(fieldMap({ ...rich, reviews }).Reviews, undefined);
  const f = embedOf({ ...rich, from: 'review', to: 'approve', reviews }).fields.find((x) => x.name === 'Reviews');
  assert.equal(f.inline, false);
});

test('AC-9: Cost and Duration appear only on terminal or parked stages and format durations', () => {
  const done = { ...rich, from: 'approve', to: 'merged', cost_usd: 8.86, started: '2026-11-05T11:15:00Z', timestamp: '2026-11-05T12:00:00Z' };
  assert.equal(fieldMap(done).Cost, '$8.86');
  assert.equal(fieldMap(done).Duration, '45m');
  assert.equal(fieldMap({ ...done, language: 'es' }).Costo, '$8.86');
  assert.equal(fieldMap({ ...done, language: 'es' }).Duración, '45m');
  assert.equal(fieldMap({ ...done, language: 'pt' }).Custo, '$8.86');
  assert.equal(fieldMap({ ...done, language: 'pt' }).Duração, '45m');
  assert.equal(fieldMap({ ...done, started: '2026-11-05T09:55:00Z' }).Duration, '2h 05m');
  assert.equal(fieldMap({ ...done, started: '2026-11-02T08:00:00Z' }).Duration, '3d 4h');
  for (const to of ['awaiting-merge', 'needs-human', 'needs-info', 'rejected']) {
    assert.equal(fieldMap({ ...done, to }).Cost, '$8.86', to);
  }
  for (const to of ['build', 'gate', 'review', 'approve', 'merging']) {
    const m = fieldMap({ ...done, to });
    assert.ok(!('Cost' in m) && !('Duration' in m), to);
  }
  assert.equal(fieldMap({ ...done, started: '2026-11-05T13:00:00Z' }).Duration, undefined);
  assert.equal(fieldMap({ ...done, started: 'nope' }).Duration, undefined);
  assert.equal(fieldMap({ ...done, cost_usd: -1 }).Cost, undefined);
  assert.equal(fieldMap({ ...done, cost_usd: NaN }).Cost, undefined);
});

test('AC-9: field order is stable and the embed still respects every limit', () => {
  const full = { ...rich, from: 'review', to: 'needs-human', risk: 'high', lane: 'xs', reviews: { code: 'PASS', ux: 'CHANGES' },
    cost_usd: 1.5, started: '2026-11-05T10:00:00Z', timestamp: '2026-11-05T12:00:00Z', note: 'n' };
  assert.deepEqual(embedOf(full).fields.map((f) => f.name), ['Stage', 'Issue', 'PR', 'Round', 'Risk', 'Reviews', 'Cost', 'Duration', 'Note', 'What to do']);
  const lens = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`l${'x'.repeat(28)}${i}`, 'PASS']));
  const huge = embedOf({ ...full, id: 'x'.repeat(1e6), title: 'a'.repeat(1e6), note: 'b'.repeat(1e6), reviews: lens });
  assert.ok(total(huge) <= 6000);
  for (const f of huge.fields) {
    assert.ok(f.value.length <= 1024 && f.name.length <= 256);
    if (/^\[#/.test(f.value)) assert.match(f.value, /^\[#\d+\]\(https:\/\/github\.com\/[^)]+\)$/);
  }
});

test('AC-10: the embed names the repository as its author, linked, only when the URL is a GitHub repo', () => {
  const embed = embedOf({ ...event, repoUrl: 'https://github.com/acme/repo' });
  assert.deepEqual(embed.author, { name: 'acme/repo', url: 'https://github.com/acme/repo' });
  for (const repoUrl of [undefined, 'https://evil.example/acme/repo', 'https://github.com/acme/repo/pull/1', 'https://github.com/acme', '[x](https://evil.example)']) {
    assert.equal('author' in embedOf({ ...event, repoUrl }), false, String(repoUrl));
  }
});
