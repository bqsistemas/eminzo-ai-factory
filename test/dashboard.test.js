import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import {
  AGENTS, STAGE_COLUMNS, activeAgents, agentsHtml, costTimeHtml, linksHtml, roundChipsHtml,
} from '../factory/activity.js';
import { avatarSvg } from '../factory/avatars.js';
import { dashboardSource } from './helpers/dashboard-source.js';

const agentsDir = new URL('../.claude/agents/', import.meta.url);
const dashboardUrl = new URL('../factory/dashboard.html', import.meta.url);

// Reads the frontmatter `name:` of every agent file in .claude/agents/.
async function agentNames() {
  const files = (await readdir(agentsDir)).filter((f) => f.endsWith('.md'));
  const names = [];
  for (const file of files) {
    const text = await readFile(new URL(file, agentsDir), 'utf8');
    const name = text.match(/^---\n[\s\S]*?^name:\s*(.+)$/m)?.[1].trim();
    assert.ok(name, `${file} has a frontmatter name`);
    names.push(name.replace(/^eminzo-/, ''));
  }
  return names;
}

// Counts elements whose class attribute is exactly "agent".
const agentElements = (html) => html.match(/<[a-z]+ class="agent"[^>]*>/g) ?? [];

test('AC-1: intake, spec, build, and approve stages map to one agent each', () => {
  assert.deepEqual(activeAgents({ stage: 'intake' }), ['intake']);
  assert.deepEqual(activeAgents({ stage: 'spec' }), ['spec-writer']);
  assert.deepEqual(activeAgents({ stage: 'build' }), ['builder']);
  assert.deepEqual(activeAgents({ stage: 'approve' }), ['approver']);
});

test('AC-2: review stage maps pending lenses to review agents in fixed order', () => {
  const job = {
    stage: 'review',
    reviews: { security: 'PASS', ux: 'pending', ui: 'CHANGES', code: 'pending', human: 'pending' },
  };
  assert.deepEqual(activeAgents(job), ['review-ux', 'review-code']);

  const reordered = { stage: 'review', reviews: { code: 'pending', security: 'pending' } };
  assert.deepEqual(activeAgents(reordered), ['review-security', 'review-code']);
});

test('AC-3: idle, unknown, and malformed jobs have no running agents', () => {
  const jobs = [
    { stage: 'merged' },
    { stage: 'needs-human' },
    { stage: 'shipping-to-mars' },
    {},
    { stage: 'review' },
    { stage: 'review', reviews: null },
    { stage: 'review', reviews: 'pending' },
    { stage: 'review', reviews: ['pending'] },
    { stage: 42 },
    null,
    undefined,
    'build',
  ];
  for (const job of jobs) {
    assert.doesNotThrow(() => activeAgents(job), `activeAgents(${JSON.stringify(job)})`);
    assert.deepEqual(activeAgents(job), [], `activeAgents(${JSON.stringify(job)})`);
    assert.equal(agentsHtml(job), '', `agentsHtml(${JSON.stringify(job)})`);
  }
});

test('AC-4: AGENTS matches .claude/agents/ with distinct, non-empty labels and icons', async () => {
  const fromFiles = (await agentNames()).sort();
  assert.equal(fromFiles.length, 8, 'eight agent files');
  assert.deepEqual(Object.keys(AGENTS).sort(), fromFiles);

  for (const [name, { label, icon }] of Object.entries(AGENTS)) {
    assert.equal(typeof label, 'string', `${name} label is a string`);
    assert.ok(label.trim(), `${name} label is non-empty`);
    assert.equal(typeof icon, 'string', `${name} icon is a string`);
    assert.ok(icon.trim(), `${name} icon is non-empty`);
    assert.doesNotMatch(icon, /https?:|url\(|href|src=/i, `${name} icon has no external reference`);
  }
  const icons = Object.values(AGENTS).map((a) => a.icon);
  assert.equal(new Set(icons).size, 8, 'eight distinct icons');
});

test('AC-5: agentsHtml renders one labelled badge per running agent', () => {
  const job = {
    stage: 'review',
    reviews: { security: 'PASS', ux: 'pending', ui: 'CHANGES', code: 'pending' },
  };
  const html = agentsHtml(job);

  assert.match(html, /class="agents"/);
  assert.match(html, /aria-label="Running agents"/);

  const badges = agentElements(html);
  assert.equal(badges.length, 2, 'exactly two .agent elements');
  assert.match(badges[0], /data-agent="review-ux"/);
  assert.match(badges[1], /data-agent="review-code"/);

  assert.ok(html.includes(AGENTS['review-ux'].label), 'UX label visible');
  assert.ok(html.includes(AGENTS['review-code'].label), 'code label visible');
  assert.equal(html.match(/aria-hidden="true"/g)?.length, 2, 'one hidden icon per agent');

  assert.equal(agentsHtml({ stage: 'merged' }), '');
});

test('AC-6: unknown review keys are ignored and output carries no injected markup', () => {
  const job = {
    stage: 'review',
    reviews: { '<img src=x onerror=alert(1)>': 'pending', ux: 'pending' },
  };
  const html = agentsHtml(job);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /onerror/i);
  assert.equal(agentElements(html).length, 1, 'only the known lens renders');

  const onlyBad = { stage: 'review', reviews: { '<img src=x onerror=alert(1)>': 'pending' } };
  assert.equal(agentsHtml(onlyBad), '');
});

test('AC-7: dashboard loads activity.js as a module and honours reduced motion', async () => {
  const html = dashboardSource();

  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'has a <script type="module">');
  assert.match(script, /import\s*\{[^}]*\bagentsHtml\b[^}]*\}\s*from\s*['"]\.\/activity\.js['"]/);
  assert.match(script, /import\s*\{[^}]*\bactiveAgents\b[^}]*\}\s*from\s*['"]\.\/activity\.js['"]/);

  const cardBody = script.match(/function card\(job\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(cardBody, 'card(job) exists');
  assert.match(cardBody, /agentsHtml\(job\)/, 'card calls agentsHtml(job)');

  const reduced = html.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n {2}\}/)?.[1];
  assert.ok(reduced, 'has a prefers-reduced-motion: reduce block');
  assert.match(reduced, /\.agent[^{]*\{[^}]*animation:\s*none/, '.agent animation disabled');
  assert.match(reduced, /\.chip\.pending[^{]*\{[^}]*animation:\s*none/, '.chip.pending animation disabled');
});

describe('job 004: animated octopus agent characters', () => {
  test('AC-3: every AGENTS icon is the shared octopus and a badge hides it once', () => {
    for (const name of Object.keys(AGENTS)) {
      assert.equal(AGENTS[name].icon, avatarSvg(name), `${name} icon is avatarSvg(name)`);
    }
    const html = agentsHtml({ stage: 'build' });
    assert.match(html, /class="octo"/);
    assert.equal(html.match(/aria-hidden="true"/g)?.length, 1, 'exactly one aria-hidden="true"');
  });

  test('AC-4: dashboard animates tentacles with defined keyframes and stops them under reduced motion', async () => {
    const html = dashboardSource();
    const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    assert.ok(css, 'has a <style> block');

    const keyframes = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    const rules = [...css.matchAll(/([^{}]*\.octo-tentacle[^{}]*)\{([^}]*)\}/g)];
    const animated = rules
      .map(([, , body]) => body.match(/animation(?:-name)?:\s*([^;]+)/)?.[1])
      .filter(Boolean);
    assert.ok(animated.length, '.octo-tentacle has an animation');
    assert.ok(
      animated.some((value) => value.split(/[\s,]+/).some((word) => keyframes.has(word))),
      '.octo-tentacle animation names a @keyframes defined in the file',
    );

    const reduced = html.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n {2}\}/)?.[1];
    assert.ok(reduced, 'has a prefers-reduced-motion: reduce block');
    for (const sel of ['\\.octo(?![\\w-])', '\\.octo-tentacle', '\\.octo-eye', '\\.agent', '\\.chip\\.pending']) {
      assert.match(reduced, new RegExp(`${sel}[^{]*\\{[^}]*animation:\\s*none`), `${sel} animation disabled`);
    }
  });
});

describe('job 012: factory v2 board', () => {
  const XSS = '<img src=x onerror=alert(1)>';

  test('AC-7: activeAgents maps the v2 stages and is idle everywhere else', () => {
    assert.deepEqual(activeAgents({ stage: 'intake' }), ['intake']);
    assert.deepEqual(activeAgents({ stage: 'spec' }), ['spec-writer']);
    assert.deepEqual(activeAgents({ stage: 'build' }), ['builder']);
    assert.deepEqual(activeAgents({ stage: 'approve' }), ['approver']);
    assert.deepEqual(
      activeAgents({ stage: 'review', reviews: { code: 'pending', ui: 'pending', ux: 'PASS', security: 'pending' } }),
      ['review-security', 'review-ui', 'review-code'],
    );
    for (const stage of ['gate', 'merging', 'awaiting-merge', 'needs-info', 'needs-human', 'merged', 'rejected', 'approval']) {
      assert.deepEqual(activeAgents({ stage }), [], stage);
    }
    for (const job of [null, {}, { stage: 7 }, { stage: 'review', reviews: [] }]) {
      assert.deepEqual(activeAgents(job), [], JSON.stringify(job));
    }
  });

  test('AC-7: STAGE_COLUMNS lists the 13 stages in order, awaiting-merge after merging and spec-review after spec', () => {
    assert.deepEqual(STAGE_COLUMNS.map(([stage]) => stage), [
      'intake', 'needs-info', 'spec', 'spec-review', 'build', 'gate', 'review', 'approve', 'merging', 'awaiting-merge', 'needs-human', 'merged', 'rejected',
    ]);
    assert.ok(STAGE_COLUMNS.some(([stage, label]) => stage === 'awaiting-merge' && label === 'Awaiting merge'));
    for (const [stage, label] of STAGE_COLUMNS) {
      assert.equal(typeof label, 'string', `${stage} label`);
      assert.ok(label.trim(), `${stage} label is non-empty`);
    }
  });

  test('AC-7: dashboard.html hints that an awaiting-merge job waits for a reviewer', async () => {
    const html = dashboardSource();
    assert.ok(html.includes('waiting for a reviewer to merge the PR'));
  });

  test('AC-7: roundChipsHtml puts the gate chip first and renders only the review keys present', () => {
    const html = roundChipsHtml({ gate: 'PASS', reviews: { code: 'CHANGES', ux: 'pending' } });
    const chips = html.match(/<span class="chip[^"]*"[^>]*>[^<]*<\/span>/g);
    assert.equal(chips.length, 3, 'gate plus two reviews');
    assert.match(chips[0], /class="chip gate PASS"/);
    assert.match(chips[0], />gate</);
    assert.match(chips[0], /aria-label="gate: PASS"/, 'the gate state is announced, not only coloured');
    assert.ok(html.includes('aria-label="code: CHANGES"') && html.includes('aria-label="ux: pending"'), 'review states are announced');
    assert.ok(chips.slice(1).every((c) => !/chip gate/.test(c)), 'one gate chip');
    assert.ok(html.indexOf('>gate<') < html.indexOf('>ux<'), 'gate before the first review');
    assert.ok(html.includes('>code<') && html.includes('>ux<'));
    assert.ok(!html.includes('>security<') && !html.includes('>ui<'), 'absent reviewers are not drawn');

    assert.match(roundChipsHtml({ gate: 'FAIL', reviews: {} }), /^<span class="chip gate FAIL"[^>]*>gate<\/span>$/);
    assert.match(roundChipsHtml({ gate: null, reviews: {} }), /class="chip gate pending"/);
    assert.match(roundChipsHtml({ gate: `"${XSS}`, reviews: {} }), /class="chip gate pending"/);
    const evil = roundChipsHtml({ gate: 'PASS', reviews: { [XSS]: `" ${XSS}` } });
    assert.doesNotMatch(evil, /<img/i);
    for (const [, cls] of evil.matchAll(/class="([^"]*)"/g)) {
      assert.match(cls, /^chip( gate)?( (PASS|FAIL|CHANGES|pending))?$/, `chip class is fixed: ${cls}`);
    }
    assert.equal(roundChipsHtml(null), roundChipsHtml({}), 'malformed rounds do not throw');
  });

  test('AC-7: linksHtml builds issue and PR links only for a GitHub repo and integer numbers', () => {
    const repo = 'https://github.com/bqsistemas/claude-code-factory';
    const html = linksHtml({ issue: 12, pr: 31 }, repo);
    assert.ok(html.includes(`href="${repo}/issues/12"`), 'issue url');
    assert.ok(html.includes(`href="${repo}/pull/31"`), 'PR url');
    assert.ok(html.includes('Issue #12') && html.includes('PR #31'), 'link labels');
    assert.ok(!linksHtml({ issue: 12, pr: null }, repo).includes('/pull/'), 'no PR link without a PR');

    assert.equal(linksHtml({ issue: 12, pr: 31 }, 'javascript:alert(1)'), '');
    assert.equal(linksHtml({ issue: 12 }, 'https://github.com/a/b/../../evil'), '');
    assert.equal(linksHtml({ issue: 12 }, `https://github.com/a/b"${XSS}`), '');
    assert.equal(linksHtml({ issue: '12" onclick="x' }, repo), '');
    for (const issue of [1.5, -3, 0, '12', NaN, null]) assert.equal(linksHtml({ issue }, repo), '', String(issue));
    assert.equal(linksHtml(null, repo), '');
  });

  test('AC-7: costTimeHtml shows dollars and a duration, with a dash for missing values', () => {
    const t = Date.parse('2026-11-02T14:00:00Z');
    const html = costTimeHtml({ cost_usd: 1.844, started: new Date(t).toISOString(), finished: new Date(t + 90 * 60000).toISOString() });
    assert.ok(html.includes('$1.84'), html);
    assert.ok(html.includes('1h 30m'), html);
    const running = costTimeHtml({ cost_usd: 0, started: new Date(t).toISOString(), finished: null }, t + 45 * 60000);
    assert.ok(running.includes('$0.00') && running.includes('45m'), running);
    const missing = costTimeHtml({ cost_usd: 'x', started: XSS });
    assert.equal(missing.match(/—/g)?.length, 2, missing);
    assert.doesNotMatch(missing, /<img/i);
    assert.doesNotThrow(() => costTimeHtml(null));
  });

  test('AC-7: dashboard.html imports the v2 helpers and no longer offers /eminzo-factory approve', async () => {
    const html = dashboardSource();
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, 'has a <script type="module">');
    for (const name of ['STAGE_COLUMNS', 'roundChipsHtml', 'linksHtml', 'costTimeHtml']) {
      assert.match(script, new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]\\./activity\\.js['"]`), name);
    }
    assert.ok(!/\/eminzo-factory approve(?!-spec)/.test(html), 'no /eminzo-factory approve (approve-spec approves a spec, not a PR)');
    assert.ok(html.includes('/eminzo-factory rework'), 'offers /eminzo-factory rework');
    assert.ok(html.includes('merge the PR to approve'), 'tells the human how to approve');
    assert.ok(html.includes('no PR yet'), 'a PR-less needs-human card says how to continue');
    assert.ok(!html.includes('Run /eminzo-factory to create'), 'no bare /eminzo-factory command');
    for (const file of ['issue.md', 'intake.md', 'checks.md', 'merge-checks.md']) {
      assert.ok(script.includes(file), `drawer lists ${file}`);
    }
  });

  test('empty board and pipeline states are centered on subtle surfaces', () => {
    const html = dashboardSource();
    assert.match(html, /\/__eminzo\/go\/terminal/);
    assert.match(html, /\$eminzo-factory run/);
    assert.match(html, /openTerminal/);
    assert.match(html, /classList\.toggle\('is-empty', !selectedJob\)/);
    assert.match(html, /taskHeader\.hidden = !selectedJob/);
    assert.match(html, /\.board\.empty-board\s*\{[^}]*place-items:\s*center/s);
    assert.match(html, /\.empty-board\s+\.empty\s*\{[^}]*background:\s*color-mix/s);
    assert.match(html, /\.pipeline-inspector\.pipeline-empty\s*\{[^}]*place-items:\s*center/s);
    assert.match(html, /\.pipeline-inspector\.pipeline-empty\s*\{[^}]*background:\s*color-mix/s);
  });

  test('AC-7: the demo board has the v2 shape, a gate-FAIL round, an escalated PR and a code-only job', async () => {
    const demo = JSON.parse(await readFile(new URL('../factory/demo/board.json', import.meta.url), 'utf8'));
    assert.match(demo.repo, /^https:\/\/github\.com\//);
    const stages = new Set(STAGE_COLUMNS.map(([stage]) => stage));
    for (const job of demo.jobs) {
      assert.ok(stages.has(job.stage), `${job.id} stage ${job.stage}`);
      assert.ok(Number.isInteger(job.issue), `${job.id} has an issue`);
      assert.equal(typeof job.max_rounds, 'number', `${job.id} has max_rounds`);
    }
    assert.ok(demo.jobs.some((j) => j.history.some((r) => r.gate === 'FAIL')), 'a gate-FAIL round');
    assert.ok(demo.jobs.some((j) => j.stage === 'needs-human' && Number.isInteger(j.pr)), 'a needs-human job with a PR');
    assert.ok(demo.jobs.some((j) => j.agents && Object.keys(j.agents.reviewers).join() === 'code'), 'a code-only job');
  });

  test('AC-7: injected markup in any job field is escaped on the card helpers', () => {
    const job = {
      stage: 'review', issue: 12, pr: 31, cost_usd: XSS, started: XSS, finished: XSS,
      gate: XSS, reviews: { code: XSS, [XSS]: 'pending' },
    };
    for (const html of [agentsHtml(job), roundChipsHtml(job), linksHtml(job, XSS), costTimeHtml(job)]) {
      assert.doesNotMatch(html, /<img/i);
    }
  });
});
