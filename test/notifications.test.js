import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, lifecycleEvent, SUPPORTED_EVENTS } from '../factory/lib/notifications.js';
const webhook = 'https://discord.com/api/webhooks/123456/token_abc';
const config = { notifications: { enabled: true, events: [...SUPPORTED_EVENTS] }, repo: 'https://github.com/acme/repo' };
const job = { id: '106-test', issue: 106, title: 'Private title', stage: 'build', round: 1, updated: '2026-11-05T12:00:00Z' };
const context = { config, env: { FACTORY_DISCORD_WEBHOOK_URL: webhook } };

test('AC-1: absent or disabled notifications never invoke adapters', async () => {
  let calls = 0;
  const notify = createNotifier({ adapters: { discord: async () => { calls++; } } });
  for (const notifications of [undefined, { enabled: false }, { enabled: false, events: ['bad'] }]) {
    await notify(lifecycleEvent(job, 'spec', config), { ...context, config: { notifications } });
  }
  assert.equal(calls, 0);
});

test('AC-2: classify and select all supported lifecycle events without merge/success duplication', async () => {
  const events = [];
  const notify = createNotifier({ adapters: { discord: async (event) => { events.push(event); return { status: 'sent' }; } } });
  for (const [from, to, type] of [[null, 'intake', 'job.started'], ['spec', 'build', 'stage.changed'], ['build', 'needs-human', 'job.needs_human'], ['intake', 'rejected', 'job.failed'], ['awaiting-merge', 'merged', 'job.merged']]) {
    const event = lifecycleEvent({ ...job, stage: to }, from, config);
    assert.equal(event.type, type);
    await notify(event, context);
  }
  assert.equal(events.length, 5);
  const successConfig = { ...config, notifications: { enabled: true, events: ['job.succeeded'] } };
  const event = lifecycleEvent({ ...job, stage: 'merged' }, 'merging', successConfig);
  assert.equal(event.type, 'job.succeeded');
  await notify(event, { ...context, config: successConfig });
  await notify(lifecycleEvent(job, 'spec', config), { ...context, config: successConfig });
  assert.equal(events.length, 6);
  assert.equal(lifecycleEvent(job, 'build', config), null);
  assert.equal(events[0].url, 'https://github.com/acme/repo/issues/106');
});

test('AC-4: lifecycle events carry the spec payload fields, GitHub links only, and nothing else from the job', () => {
  const event = lifecycleEvent({ ...job, stage: 'needs-human', note: 'blocked on review', pr: 12, round: 2, max_rounds: 3, lane: 'xs', body: 'PRIVATE', worktree: '/secret/path', env: { X: 1 } }, 'review', config);
  assert.deepEqual(Object.keys(event).sort(), ['eventId', 'from', 'id', 'issue', 'lane', 'language', 'max_rounds', 'note', 'prUrl', 'repoUrl', 'round', 'timestamp', 'title', 'to', 'type', 'url']);
  assert.equal(event.title, 'Private title');
  assert.equal(event.note, 'blocked on review');
  assert.equal(event.url, 'https://github.com/acme/repo/issues/106');
  assert.equal(event.prUrl, 'https://github.com/acme/repo/pull/12');
  assert.deepEqual([event.round, event.max_rounds, event.lane, event.language], [2, 3, 'xs', 'en']);
  assert.equal(lifecycleEvent({ ...job, stage: 'build' }, 'spec', { ...config, language: 'pt' }).language, 'pt');
  const invalid = lifecycleEvent({ ...job, round: -1, max_rounds: 0, lane: 'huge' }, 'spec', { ...config, language: 'zz' });
  assert.equal('round' in invalid || 'max_rounds' in invalid || 'lane' in invalid, false);
  assert.equal(invalid.language, 'en');
  assert.equal(invalid.eventId, lifecycleEvent({ ...job, round: -1 }, 'spec', config).eventId);
  const bare = lifecycleEvent({ ...job, title: 42, pr: 'x' }, 'spec', { ...config, repo: 'https://evil.example/acme/repo' });
  assert.equal('url' in bare || 'prUrl' in bare || 'title' in bare || 'note' in bare, false);
});

test('AC-3: reject invalid configuration with static secret-safe diagnostics', async () => {
  let calls = 0;
  const logs = [];
  const notify = createNotifier({ adapters: { discord: async () => { calls++; } }, report: (s) => logs.push(s) });
  for (const notifications of [{ enabled: 'true', events: [] }, { enabled: true, events: ['bad'] }, { enabled: true, events: 'job.started' }, { enabled: true, events: [], webhookUrl: webhook }]) {
    await notify({ type: 'job.started' }, { ...context, config: { notifications } });
  }
  await notify({ type: 'job.started' }, { ...context, env: {} });
  assert.equal(calls, 0);
  assert.equal(logs.length, 5);
  assert.ok(!JSON.stringify(logs).includes(webhook));
});

test('AC-5: adapter failures are isolated, recorded, and leave pipeline state untouched', async () => {
  const logs = [];
  let second = 0;
  const notify = createNotifier({ adapters: { discord: async () => { throw new Error(webhook); }, other: async () => { second++; return { status: 'sent' }; } }, report: (s) => logs.push(s) });
  const before = JSON.stringify(job);
  await notify(lifecycleEvent(job, 'spec', config), context);
  assert.equal(JSON.stringify(job), before);
  assert.equal(second, 1);
  assert.ok(JSON.stringify(logs).includes('failed'));
  assert.ok(!JSON.stringify(logs).includes(webhook));
});

test('AC-6: deterministic bounded dedupe coalesces concurrent delivery but permits failed retries', async () => {
  let calls = 0;
  let fail = true;
  const notify = createNotifier({ adapters: { discord: async () => { calls++; await Promise.resolve(); return { status: fail ? 'failed' : 'sent' }; } }, maxEntries: 2 });
  const event = lifecycleEvent(job, 'spec', config);
  assert.equal(event.eventId, lifecycleEvent({ ...job, updated: 'later' }, 'spec', config).eventId);
  await Promise.all([notify(event, context), notify(event, context)]);
  assert.equal(calls, 1);
  fail = false;
  await notify(event, context);
  await notify(event, context);
  assert.equal(calls, 2);
  for (const round of [2, 3]) await notify(lifecycleEvent({ ...job, round }, 'spec', config), context);
  await notify(event, context);
  assert.equal(calls, 5);
});

test('AC-7: documented defaults remain opt-in and every event is documented', async () => {
  const { readFile } = await import('node:fs/promises');
  // The default every installed repo gets is the template's: off, no events. A repo's own
  // factory/config.json (this one included) may turn notifications on; it only has to be valid.
  const template = JSON.parse(await readFile(new URL('../factory/templates/config.json', import.meta.url)));
  assert.deepEqual(template.notifications, { enabled: false, events: [] });
  const actual = JSON.parse(await readFile(new URL('../factory/config.json', import.meta.url)));
  assert.equal(typeof actual.notifications.enabled, 'boolean');
  for (const event of actual.notifications.events) assert.ok(SUPPORTED_EVENTS.includes(event), `${event} is a supported event`);
  const docs = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const word of [...SUPPORTED_EVENTS, 'FACTORY_DISCORD_WEBHOOK_URL', 'best-effort']) assert.ok(docs.includes(word), word);
});

test('AC-1 AC-2 AC-5 AC-6: CLI emits only after persistence, preserves results on failure, skips sync and duplicate creation', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { execFileSync, spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'factory-discord-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'factory'), { recursive: true });
  // job new checks the remote of config.base for factory/<id>: a local bare origin, no network.
  execFileSync('git', ['init', '-q', '--bare', join(root, '.origin.git')]);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', join(root, '.origin.git')]);
  const original = JSON.parse(readFileSync(new URL('../factory/config.json', import.meta.url), 'utf8'));
  const configure = (enabled) => writeFileSync(join(root, 'factory/config.json'), JSON.stringify({ ...original, notifications: { enabled, events: [...SUPPORTED_EVENTS] } }));
  configure(true);
  const gh = join(root, 'gh');
  writeFileSync(gh, `#!${process.execPath}\nif(process.argv[2]==='issue' && process.argv[3]==='view') console.log(JSON.stringify({number:106,title:'Test',body:'PRIVATE',state:'OPEN',labels:[{name:'factory'}]}));\n`);
  chmodSync(gh, 0o755);
  const preload = join(root, 'fetch.mjs');
  const log = join(root, 'requests.jsonl');
  writeFileSync(log, '');
  writeFileSync(preload, `import { readFileSync, appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, options) => {
      const payload = JSON.parse(options.body);
      const id = payload.embeds[0].footer.text.split(' · ')[1];
      const job = JSON.parse(readFileSync(process.env.FACTORY_ROOT + '/factory/jobs/' + id + '/job.json'));
      const board = JSON.parse(readFileSync(process.env.FACTORY_ROOT + '/factory/board.json'));
      if (!board.jobs.some(j => j.id === id && j.stage === job.stage)) throw Error('not persisted');
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({payload,stage:job.stage})+'\\n');
      if (process.env.DELIVERY === 'error') throw Error(url);
      return { status: Number(process.env.DELIVERY || 204) };
    };`);
  // This child posts through the stubbed fetch above, so it must not look like a test run.
  const { NODE_TEST_CONTEXT, ...parentEnv } = process.env;
  const run = (args, delivery = '204') => spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('../factory/lib/job.js', import.meta.url)), ...args], {
    encoding: 'utf8', env: { ...parentEnv, FACTORY_ROOT: root, FACTORY_GH: gh, FACTORY_DISCORD_WEBHOOK_URL: webhook, FACTORY_TRANSCRIPTS: join(root, 'transcripts'), DELIVERY: delivery },
  });
  const requests = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const created = run(['new', '106']);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.trim();
  assert.equal(requests().length, 1);
  assert.equal(requests()[0].stage, 'intake');
  assert.match(requests()[0].payload.embeds[0].title, /Nuevo trabajo/);
  assert.equal(run(['new', '106']).status, 0);
  assert.equal(run([id, 'sync']).status, 0);
  assert.equal(requests().length, 1);
  const refused = run([id, 'to', 'merged']);
  assert.equal(refused.status, 1);
  assert.equal(requests().length, 1);
  const failed = run([id, 'to', 'needs-human', '--note', 'waiting on ops password=hunter2'], 'error');
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stdout, /needs-human/);
  assert.match(failed.stderr, /notifications: failed/);
  assert.ok(!failed.stderr.includes(webhook));
  assert.equal(requests().length, 2);
  assert.equal(requests()[1].stage, 'needs-human');
  assert.match(requests()[1].payload.embeds[0].fields.find((f) => f.name === 'Nota').value, /waiting on ops \[redacted\]/);
  assert.ok(!readFileSync(log, 'utf8').includes('hunter2'));
  assert.ok(!failed.stderr.includes('hunter2'));
  assert.ok(!readFileSync(join(root, 'factory/board.json'), 'utf8').includes(webhook));
  configure(false);
  const before = requests().length;
  // New job in an independent root namespace; disabled notifications make no request.
  rmSync(join(root, 'factory/jobs'), { recursive: true });
  assert.equal(run(['new', '106']).status, 0);
  assert.equal(requests().length, before);
});

test('AC-8: lifecycle events carry validated risk, reviews, cost and started, and omit each when invalid', () => {
  const rich = { ...job, stage: 'merged', intake: { risk: 'medium' }, reviews: { code: 'PASS', ux: 'CHANGES' }, cost_usd: 8.8649, started: '2026-11-05T10:00:00Z' };
  const event = lifecycleEvent(rich, 'approve', config);
  assert.equal(event.risk, 'medium');
  assert.deepEqual(event.reviews, { code: 'PASS', ux: 'CHANGES' });
  assert.equal(event.cost_usd, 8.86);
  assert.equal(event.started, '2026-11-05T10:00:00Z');
  const has = (e, key) => key in e;
  assert.equal(has(lifecycleEvent({ ...rich, intake: { risk: 'extreme' } }, 'approve', config), 'risk'), false);
  assert.equal(has(lifecycleEvent({ ...rich, intake: 'x' }, 'approve', config), 'risk'), false);
  assert.deepEqual(lifecycleEvent({ ...rich, reviews: { code: 'PASS', 'Bad Lens!': 'PASS', ux: 'MAYBE', 'A': 'PASS' } }, 'approve', config).reviews, { code: 'PASS' });
  assert.equal(has(lifecycleEvent({ ...rich, reviews: { ux: 'MAYBE' } }, 'approve', config), 'reviews'), false);
  assert.equal(has(lifecycleEvent({ ...rich, reviews: [] }, 'approve', config), 'reviews'), false);
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`lens${i}`, 'PASS']));
  assert.equal(Object.keys(lifecycleEvent({ ...rich, reviews: many }, 'approve', config).reviews).length, 8);
  for (const bad of [NaN, -1, Infinity, '3', null]) assert.equal(has(lifecycleEvent({ ...rich, cost_usd: bad }, 'approve', config), 'cost_usd'), false, String(bad));
  assert.equal(lifecycleEvent({ ...rich, cost_usd: 0 }, 'approve', config).cost_usd, 0);
  for (const bad of ['not a date', 42, null]) assert.equal(has(lifecycleEvent({ ...rich, started: bad }, 'approve', config), 'started'), false, String(bad));
  assert.equal(lifecycleEvent(rich, 'approve', config).eventId, lifecycleEvent({ ...job, stage: 'merged' }, 'approve', config).eventId);
});

test('AC-10: lifecycle events carry the validated repository URL and omit an invalid one', () => {
  assert.equal(lifecycleEvent(job, 'spec', config).repoUrl, 'https://github.com/acme/repo');
  for (const repo of [undefined, 'https://evil.example/acme/repo', 'https://github.com/acme/repo/issues', 'http://github.com/acme/repo']) {
    assert.equal('repoUrl' in lifecycleEvent(job, 'spec', { ...config, repo }), false, String(repo));
  }
});

test('AC-11: a process started by the node test runner never reaches a real webhook', async () => {
  let calls = 0;
  const notify = createNotifier({ adapters: { discord: async () => { calls++; return { status: 'sent' }; } } });
  await notify(lifecycleEvent(job, 'spec', config), { config, env: { FACTORY_DISCORD_WEBHOOK_URL: webhook, NODE_TEST_CONTEXT: 'child-v8' } });
  assert.equal(calls, 0);
  await notify(lifecycleEvent(job, 'spec', config), context);
  assert.equal(calls, 1);
});
