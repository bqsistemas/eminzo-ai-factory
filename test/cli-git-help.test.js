// gitHelp maps a failed git step to the public guide (https://eminzo.dev/help/commit-signing/), and
// `eminzo enable` carries that link on the errors it can explain: one `help:` line for a person,
// `help: { topic, url }` next to the unchanged `error` in --json.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../cli/build.mjs';
import { gitHelp, helpLocale } from '../cli/src/git-help.js';

const EN = 'https://eminzo.dev/help/commit-signing/';
const ES = 'https://eminzo.dev/es/help/commit-signing/';

test('gitHelp: SSH authentication failures map to ssh-auth', () => {
  for (const stderr of [
    'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    'Host key verification failed.\nfatal: Could not read from remote repository.',
  ]) assert.deepEqual(gitHelp(stderr), { topic: 'ssh-auth', url: `${EN}#ssh-auth` });
});

test('gitHelp: commit signing failures map to troubleshooting', () => {
  for (const stderr of [
    'error: gpg failed to sign the data\nfatal: failed to write commit object',
    'gpg: signing failed: Inappropriate ioctl for device\ngpg: signing failed: No secret key',
    'error: gpg failed to sign the data:\n[GNUPG:] BEGIN_SIGNING',
    'gpg: skipped "ABCD1234": No secret key\n[GNUPG:] INV_SGNR 9 ABCD1234\nerror: gpg failed to sign the data',
    "Couldn't sign message (is ssh-agent running?)\nfatal: failed to write commit object",
    'Load key "/home/dev/.ssh/id_ed25519": incorrect passphrase supplied to decrypt private key\nfatal: failed to write commit object',
    'Load key "/home/dev/.ssh/id_ed25519": incorrect passphrase\nfatal: failed to write commit object',
  ]) assert.deepEqual(gitHelp(stderr), { topic: 'troubleshooting', url: `${EN}#troubleshooting` }, stderr);
});

test('gitHelp: unrelated failures get no help', () => {
  for (const stderr of [
    '',
    null,
    'ERROR: Repository not found.\nfatal: Could not read from remote repository.',
    "fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com",
    'CONFLICT (content): Merge conflict in a.txt',
    'fatal: failed to write commit object',
    'error: failed to push some refs to origin',
  ]) assert.equal(gitHelp(stderr), null, String(stderr));
});

test('gitHelp: the Spanish locale gives the /es/ URL', () => {
  assert.equal(gitHelp('Permission denied (publickey).', 'es').url, `${ES}#ssh-auth`);
  assert.equal(gitHelp('error: gpg failed to sign the data', 'es').url, `${ES}#troubleshooting`);
  assert.equal(gitHelp('error: gpg failed to sign the data', 'en').url, `${EN}#troubleshooting`);
});

test('helpLocale: first of LC_ALL, LC_MESSAGES, LANG that is set decides; es* is Spanish', () => {
  assert.equal(helpLocale({ LANG: 'es_AR.UTF-8' }), 'es');
  assert.equal(helpLocale({ LC_ALL: 'es_ES.UTF-8', LANG: 'en_US.UTF-8' }), 'es');
  assert.equal(helpLocale({ LC_ALL: 'en_US.UTF-8', LANG: 'es_AR.UTF-8' }), 'en');
  assert.equal(helpLocale({ LC_ALL: '', LC_MESSAGES: 'es', LANG: 'en_US' }), 'es');
  assert.equal(helpLocale({}), 'en');
});

// ---- eminzo enable, end to end -------------------------------------------------------------

const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = join(repo, 'cli/bin/eminzo.js');
const REMOTE = 'https://github.com/acme/shop';
let dist;
before(() => {
  dist = join(mkdtempSync(join(tmpdir(), 'eminzo-help-dist-')), 'dist');
  build({ out: dist });
});

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com',
};

/** A temp repo whose origin is a local bare repo; `git` on PATH is a shim that fails `fetch` with `fetchError` when given. */
function setup({ fetchError = null, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eminzo-help-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'shop');
  const env = { ...process.env, ...GIT_ENV, HOME: join(dir, 'home'), EMINZO_DIST: dist, LC_ALL: 'en_US.UTF-8', LC_MESSAGES: '', LANG: 'en_US.UTF-8' };
  delete env.EMINZO_ENGINE;
  delete env.FACTORY_ROOT;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'config', `url.${origin}.insteadOf`, REMOTE);
  git(root, 'remote', 'add', 'origin', REMOTE);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'remote', 'set-head', 'origin', 'main');

  const gh = join(dir, 'gh');
  writeFileSync(gh, '#!/bin/sh\ncase "$1 $2" in\n  "auth status") exit 0 ;;\n  "pr create") echo "' + REMOTE + '/pull/7" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shimDir = join(dir, 'shim');
  mkdirSync(shimDir);
  const shim = join(shimDir, 'git');
  writeFileSync(shim, `#!/bin/sh\nif [ "$1" = fetch ] && [ -n "${fetchError ? '1' : ''}" ]; then\n  printf '%s\\n' ${JSON.stringify(fetchError ?? '')} >&2\n  echo 'fatal: Could not read from remote repository.' >&2\n  exit 128\nfi\nexec "${realGit}" "$@"\n`);
  chmodSync(shim, 0o755);
  const run = (args = [], more = {}) => spawnSync(process.execPath, [bin, 'enable', ...args], {
    cwd: root, encoding: 'utf8', env: { ...env, FACTORY_GH: gh, PATH: `${shimDir}:${process.env.PATH}`, ...extraEnv, ...more },
  });
  return { dir, root, git, run };
}

test('enable: a fetch that fails on SSH authentication names the guide, in text and in --json', () => {
  const t = setup({ fetchError: 'git@github.com: Permission denied (publickey).' });
  const text = t.run();
  assert.equal(text.status, 1);
  assert.match(text.stderr, /^error: git fetch origin main failed: git@github\.com: Permission denied \(publickey\)\./m);
  assert.match(text.stderr, /^help: https:\/\/eminzo\.dev\/help\/commit-signing\/#ssh-auth$/m);

  const out = JSON.parse(t.run(['--json']).stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'git fetch origin main failed: git@github.com: Permission denied (publickey).');
  assert.deepEqual(out.help, { topic: 'ssh-auth', url: `${EN}#ssh-auth` });
});

test('enable: the Spanish locale links the /es/ guide', () => {
  const t = setup({ fetchError: 'Host key verification failed.' });
  const out = JSON.parse(t.run(['--json'], { LC_ALL: '', LC_MESSAGES: '', LANG: 'es_AR.UTF-8' }).stdout);
  assert.deepEqual(out.help, { topic: 'ssh-auth', url: `${ES}#ssh-auth` });
  assert.match(t.run([], { LC_ALL: 'es_ES.UTF-8' }).stderr, /^help: https:\/\/eminzo\.dev\/es\/help\/commit-signing\/#ssh-auth$/m);
});

test('enable: a commit that cannot be signed maps to troubleshooting and leaves the repository as it was', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eminzo-help-gpg-'));
  const gpg = join(dir, 'gpg-fail');
  writeFileSync(gpg, '#!/bin/sh\necho "gpg: signing failed: Inappropriate ioctl for device" >&2\nexit 1\n', { mode: 0o755 });
  const t = setup({ extraEnv: { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_1: 'gpg.program', GIT_CONFIG_VALUE_1: gpg } });
  const text = t.run();
  assert.equal(text.status, 1, text.stderr);
  assert.match(text.stderr, /^error: git commit failed: /m);
  assert.match(text.stderr, /^help: https:\/\/eminzo\.dev\/help\/commit-signing\/#troubleshooting$/m);

  const out = JSON.parse(t.run(['--json']).stdout);
  assert.match(out.error, /^git commit failed: /);
  assert.deepEqual(out.help, { topic: 'troubleshooting', url: `${EN}#troubleshooting` });
  assert.equal(t.git(t.root, 'branch', '--list', 'chore/enable-factory'), '', 'the enable branch was removed');
});

test('enable: a failure the guide does not cover has no help, in text or in --json', () => {
  const t = setup({ fetchError: 'ERROR: Repository not found.' });
  const text = t.run();
  assert.equal(text.status, 1);
  assert.doesNotMatch(text.stderr, /help:/);
  const out = JSON.parse(t.run(['--json']).stdout);
  assert.equal(out.ok, false);
  assert.match(out.error, /Repository not found/);
  assert.equal('help' in out, false);
});
