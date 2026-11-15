// E4: the fix issue. When the base fails the checks, `base fix-issue` finds the one open issue labelled
// factory:base-fix or creates it (labels factory and factory:base-fix). The issue is public text: it holds the base
// sha, the command or step that failed with its exit code and how to reproduce it, and NEVER a line of the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { baseFixture } from './helpers/base-harness.js';
import { fakeGhIssues } from './helpers/fake-gh-issues.js';

const { issueText, publicCommand } = await import('../factory/lib/base.js');
const { BASE_FIX_LABEL, LABELS } = await import('../factory/lib/labels.js');

// Prints a line only a log would hold, then fails on a command that carries a secret.
const RED = '#!/bin/sh\necho "LOG-LINE-THAT-MUST-STAY-LOCAL"\nSECRET=hunter2hunter2hunter2hunter2hunter2\ntest "$SECRET" = nope\n';
const red = (extra = {}) => baseFixture({ checks: RED, config: { checks: { prepare: '' } }, ...extra });
const withGh = (t, options) => {
  const fake = fakeGhIssues(join(t.dir, 'fake'), options);
  return { fake, fix: (extra = {}) => t.base(['fix-issue'], { FACTORY_GH: fake.gh, ...extra }) };
};

test('the label: one more in the list, within GitHub\'s limits', () => {
  assert.equal(BASE_FIX_LABEL, 'factory:base-fix');
  const label = LABELS.find((l) => l.name === BASE_FIX_LABEL);
  assert.ok(label);
  assert.match(label.color, /^[0-9a-f]{6}$/);
  assert.ok(label.description.length <= 100);
  assert.ok(LABELS.length <= 100);
});

test('no open issue: one create with both labels; the body names the sha, the failure and the way to reproduce it, and holds no log', () => {
  const t = red();
  assert.equal(t.base().status, 1);
  const { fake, fix } = withGh(t);
  const res = fix();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'fix: #1 created');
  const [create] = fake.creates();
  const args = create.args;
  assert.deepEqual(args.slice(0, 2), ['issue', 'create']);
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '--label'), ['factory', BASE_FIX_LABEL]);
  const sha12 = t.tip().slice(0, 12);
  assert.match(args[args.indexOf('--title') + 1], /^Fix the checks on main: factory\/checks\.sh$/);
  assert.match(create.body, new RegExp(`\`main\` at \`${sha12}\``));
  assert.match(create.body, /Failing step: `factory\/checks\.sh exited 1`/);
  assert.match(create.body, /factory\/bin\/base/, 'the engine is committed in this repository');
  assert.match(create.body, /^- AC-1: /m);
  assert.doesNotMatch(create.body, /LOG-LINE-THAT-MUST-STAY-LOCAL/);
  assert.doesNotMatch(create.body, /hunter2/);
  assert.doesNotMatch(args.join(' '), /hunter2/);
  assert.doesNotMatch(create.body, /^```/m, 'no fenced log');
  assert.equal(t.state().full.fix_issue, 1, 'the state remembers the issue');
});

test('the installed engine says `eminzo base`', () => {
  const t = red();
  assert.equal(t.base().status, 1);
  const { fake, fix } = withGh(t);
  assert.equal(fix({ EMINZO_ENGINE: join(t.dir, 'engine') }).status, 0);
  assert.match(fake.creates()[0].body, /`eminzo base`/);
});

test('one already open: it is reused and nothing is created; two calls make one issue', () => {
  const t = red();
  assert.equal(t.base().status, 1);
  const reuse = withGh(t, { open: [9, 7] });
  assert.equal(reuse.fix().stdout.trim(), 'fix: #7 open');
  assert.equal(reuse.fake.creates().length, 0);
  const u = red();
  assert.equal(u.base().status, 1);
  const { fake, fix } = withGh(u);
  assert.equal(fix().stdout.trim(), 'fix: #1 created');
  assert.equal(fix().stdout.trim(), 'fix: #1 open');
  assert.equal(fake.creates().length, 1);
  assert.equal(fake.issues().length, 1);
});

test('two machines racing: the lowest open issue wins and this one reports it as open', () => {
  const t = red();
  assert.equal(t.base().status, 1);
  const { fake, fix } = withGh(t, { race: true });
  assert.equal(fix().stdout.trim(), 'fix: #1 open');
  assert.equal(fake.issues().length, 2);
});

test('language es: the title and the body are in Spanish', () => {
  const t = red({ config: { language: 'es', checks: { prepare: '' } } });
  assert.equal(t.base().status, 1);
  const { fake, fix } = withGh(t);
  assert.equal(fix().status, 0);
  const [create] = fake.creates();
  assert.match(create.args[create.args.indexOf('--title') + 1], /^Arreglar los checks en main: /);
  assert.match(create.body, /Paso que falla: `factory\/checks\.sh terminó con 1`/);
});

test('a gh failure is exit 1 and a missing label points at setup', () => {
  const t = red();
  assert.equal(t.base().status, 1);
  const { fix } = withGh(t, { failCreate: "could not add label: 'factory:base-fix' not found" });
  const res = fix();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\/eminzo-factory setup/);
  const listing = withGh(t, { failList: 'HTTP 401' }).fix();
  assert.equal(listing.status, 1);
  assert.match(listing.stderr, /HTTP 401/);
});

test('fix-issue is refused after a passing check, with no check at all, and after the base moved', () => {
  const green = baseFixture({ config: { checks: { prepare: '' } } });
  const g = withGh(green);
  const none = g.fix();
  assert.equal(none.status, 1);
  assert.match(none.stderr, /refused: the last check of origin\/main did not fail/);
  assert.equal(green.base().status, 0);
  assert.match(g.fix().stderr, /refused: the last check of origin\/main did not fail/);
  assert.equal(g.fake.calls().length, 0, 'gh is never called');

  const t = red();
  assert.equal(t.base().status, 1);
  t.push({ 'moved.txt': 'm\n' });
  const moved = withGh(t).fix();
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /refused: origin\/main moved since; run factory\/bin\/base again/);
});

test('publicCommand is an allowlist: a known check tool, a known subcommand, at most one script name after run or exec', () => {
  assert.equal(publicCommand('pnpm run lint'), 'pnpm run lint');
  assert.equal(publicCommand('pnpm run lint:ci'), 'pnpm run lint:ci');
  assert.equal(publicCommand('npm test'), 'npm test');
  assert.equal(publicCommand('pnpm exec nx run-many -t lint test'), 'pnpm exec nx …');
  assert.equal(publicCommand('pnpm run lint --max-warnings=0'), 'pnpm run lint …');
  assert.equal(publicCommand('go vet ./...'), 'go vet …');
  assert.equal(publicCommand('cargo clippy --all-targets'), 'cargo clippy …');
  assert.equal(publicCommand('./gradlew test'), './gradlew test');
  assert.equal(publicCommand('make'), 'make');
  assert.equal(publicCommand('echo ``a`` b'), null, 'echo is not a check tool; backticks never survive');
  assert.equal(publicCommand('npm `run` lint'), 'npm run lint');
  assert.equal(publicCommand(null), null);
  assert.equal(publicCommand('   '), null);
  assert.equal(publicCommand('./run.sh --token x'), null);
  assert.equal(publicCommand('/usr/bin/pnpm run lint'), null, 'a path is not on the list');
  assert.equal(publicCommand('npm run build test extra'), 'npm run build …', 'at most three words');
});

test('publicCommand never lets a token, a key, an id or a password through, whatever it looks like', () => {
  const leaks = [
    ['aws-secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['npm login npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_abcdefghij'],
    ['vault login hvs.CAESIabcdefgh12345', 'hvs.CAESI'],
    ['deploy glpat-abcdefghij1234567890', 'glpat'],
    ['a SG.abcdefghijklmnop.qrstuvwxyz0123456', 'SG.abc'],
    ['x 550e8400-e29b-41d4-a716-446655440000', '550e8400'],
    ['redis-cli AUTH s3cretpass', 's3cretpass'],
    ["curl -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789' https://x", 'ghp_'],
    ['curl -u admin:SuperSecret123 https://x', 'SuperSecret123'],
    ['deploy --jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc', 'eyJ'],
    ['test hunter2hunter2hunter2hunter2hunter2 = nope', 'hunter2'],
    ['npm login --password hunter2', 'hunter2'],
    ['npm run hunter2hunter2hunter2hunter2hunter2hunter2hunter2', 'hunter2'],
  ];
  const config = { base: 'origin/main', language: 'en' };
  for (const [raw, secret] of leaks) {
    const shown = publicCommand(raw);
    assert.ok(!(shown ?? '').includes(secret), `${secret} in ${shown}`);
    const { title, body } = issueText(config, { sha: 'a'.repeat(40), status: 'FAIL', exit: 3, command: raw }, { engineCommand: 'eminzo base', version: null, date: '2026-11-15' });
    assert.ok(!title.includes(secret) && !body.includes(secret), `${secret} reached the issue for ${raw}`);
  }
});

test('a command whose program is not a known check tool is not published: the issue says checks.sh exited with the code', () => {
  const config = { base: 'origin/main', language: 'en' };
  const { title, body } = issueText(config, { sha: 'a'.repeat(40), status: 'FAIL', exit: 7, command: 'redis-cli AUTH s3cretpass' }, { engineCommand: 'eminzo base', version: null, date: '2026-11-15' });
  assert.match(body, /factory\/checks\.sh exited 7/);
  assert.equal(title, 'Fix the checks on main: factory/checks.sh');
});

test('issueText: inert title, no backtick can break the span, no command falls back to checks.sh', () => {
  const config = { base: 'origin/main', language: 'en' };
  const base = { sha: 'a'.repeat(40), status: 'FAIL', exit: 2, command: 'npm run lint `x` $(rm -rf /)' };
  const { title, body } = issueText(config, base, { engineCommand: 'eminzo base', version: '1.2.3', date: '2026-11-15' });
  assert.doesNotMatch(title, /[`$]|\n/);
  assert.match(body, /Failing command: `npm run lint …` \(exit 2\)/);
  assert.doesNotMatch(body, /rm -rf/);
  assert.match(body, /Found by eminzo base \(engine 1\.2\.3\) on 2026-11-15\./);
  const bare = issueText(config, { ...base, command: null }, { engineCommand: 'eminzo base', version: null, date: '2026-11-15' });
  assert.match(bare.body, /Failing step: `factory\/checks\.sh exited 2`/);
  assert.match(bare.title, /^Fix the checks on main: factory\/checks\.sh$/);
  assert.doesNotMatch(bare.body, /engine null/);
});

test('two machines racing: the one that lost closes its own issue as a duplicate of the lowest one', () => {
  const t = red();
  assert.equal(t.base().status, 1);
  const { fake, fix } = withGh(t, { race: true });
  assert.equal(fix().stdout.trim(), 'fix: #1 open');
  const close = fake.calls().find((c) => c.args[1] === 'close');
  assert.deepEqual(close.args, ['issue', 'close', '2', '--comment', 'Duplicate of #1']);
  assert.equal(fake.issues().find((i) => i.number === 2).state, 'closed');
});
