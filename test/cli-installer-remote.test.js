import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGithubRemote } from '../cli/src/installer/remote.js';

test('https, ssh and scp-like GitHub remotes normalize to https://github.com/o/n', () => {
  for (const url of [
    'https://github.com/acme/web',
    'https://github.com/acme/web.git',
    'https://github.com/acme/web/',
    'http://github.com/acme/web.git',
    'git@github.com:acme/web.git',
    'git@github.com:acme/web',
    'ssh://git@github.com/acme/web.git',
    'ssh://git@github.com:22/acme/web.git',
    'https://user:token@github.com/acme/web.git',
    '  https://github.com/acme/web.git\n',
    'https://GitHub.com/acme/web.git',
    'git@GITHUB.COM:acme/web.git',
    'SSH://git@Github.com/acme/web',
  ]) assert.equal(normalizeGithubRemote(url), 'https://github.com/acme/web', url);
});

test('dots, dashes and underscores in names are kept; only a trailing .git is stripped', () => {
  assert.equal(normalizeGithubRemote('git@github.com:acme/my.repo_v2.git'), 'https://github.com/acme/my.repo_v2');
  assert.equal(normalizeGithubRemote('https://github.com/a-b/c.js'), 'https://github.com/a-b/c.js');
});

test('anything that is not a GitHub repo remote is null', () => {
  for (const url of [
    'https://gitlab.com/acme/web.git', 'git@bitbucket.org:acme/web.git', 'https://github.com/acme', 'https://github.com/acme/web/tree/main',
    'https://evilgithub.com/acme/web', 'https://github.com.evil.io/acme/web', '/local/path/repo', '', null, undefined, 42,
  ]) assert.equal(normalizeGithubRemote(url), null, String(url));
});
