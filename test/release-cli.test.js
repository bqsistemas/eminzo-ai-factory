// The CLI GitHub Release must never become "Latest": electron-updater reads /releases/latest
// for the desktop app. planCliRelease holds that rule as a pure function.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planCliRelease, parseArgs } from '../scripts/release-cli.mjs';

const SHA = 'a'.repeat(40);
const good = () => ({
  version: '0.2.2',
  branch: 'main',
  clean: true,
  localTags: ['v0.2.1', 'v0.2.2'],
  remoteTagSha: SHA,
  headSha: SHA,
  tagSha: SHA,
});

test('a clean main with the tag on HEAD, local and remote, yields the gh command with --latest=false', () => {
  const r = planCliRelease(good());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.command, ['gh', 'release', 'create', 'v0.2.2', '--latest=false', '--title', 'CLI v0.2.2', '--verify-tag', '--generate-notes']);
});

test('a notes file replaces --generate-notes', () => {
  const r = planCliRelease({ ...good(), notesFile: 'NOTES.md' });
  assert.equal(r.ok, true);
  assert.ok(r.command.includes('--notes-file'));
  assert.equal(r.command[r.command.indexOf('--notes-file') + 1], 'NOTES.md');
  assert.ok(!r.command.includes('--generate-notes'));
  assert.ok(r.command.includes('--latest=false'));
});

test('refuses a branch other than main', () => {
  const r = planCliRelease({ ...good(), branch: 'feat/x' });
  assert.equal(r.ok, false);
  assert.equal(r.command, null);
  assert.match(r.errors.join('\n'), /main/);
});

test('refuses a dirty tree', () => {
  const r = planCliRelease({ ...good(), clean: false });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /clean|uncommitted/i);
});

test('a missing local tag explains how to create it', () => {
  const r = planCliRelease({ ...good(), localTags: ['v0.2.1'], tagSha: null });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /git tag -a v0\.2\.2 -m "eminzo 0\.2\.2"/);
});

test('a tag missing on origin explains how to push it', () => {
  const r = planCliRelease({ ...good(), remoteTagSha: null });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /git push origin v0\.2\.2/);
});

test('a tag that does not point at HEAD is refused', () => {
  const r = planCliRelease({ ...good(), tagSha: 'b'.repeat(40) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /HEAD/);
});

test('refuses desktop- and otherwise malformed versions', () => {
  for (const version of ['desktop-v1.0.0', 'v0.2.2', '0.2', '1.0.0-', '', null, undefined]) {
    const r = planCliRelease({ ...good(), version });
    assert.equal(r.ok, false, String(version));
    assert.equal(r.command, null);
  }
});

test('a tag on origin that points elsewhere than HEAD is refused (peeled remote commit)', () => {
  const r = planCliRelease({ ...good(), remoteTagSha: 'c'.repeat(40) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /origin/);
});

test('a prerelease version adds --prerelease and keeps --latest=false', () => {
  const v = '0.3.0-rc.1';
  const r = planCliRelease({ ...good(), version: v, localTags: [`v${v}`], tagSha: SHA });
  assert.equal(r.ok, true);
  assert.ok(r.command.includes('--prerelease'));
  assert.ok(r.command.includes('--latest=false'));
  assert.equal(r.command[3], `v${v}`);
  assert.ok(!planCliRelease(good()).command.includes('--prerelease'));
});

test('parseArgs validates --notes-file', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, notesFile: undefined, error: null });
  assert.equal(parseArgs(['--dry-run', '--notes-file', 'n.md']).notesFile, 'n.md');
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  for (const argv of [['--notes-file'], ['--notes-file', '--dry-run'], ['--notes-file', '']]) {
    assert.match(parseArgs(argv).error, /notes-file/, argv.join(' '));
  }
  assert.match(parseArgs(['--bogus']).error, /--bogus/);
});

test('a successful plan carries --latest=false and --verify-tag with or without a notes file', () => {
  for (const notesFile of [undefined, 'n.md']) {
    const r = planCliRelease({ ...good(), notesFile });
    assert.ok(r.command.includes('--latest=false'));
    assert.ok(r.command.includes('--verify-tag'));
  }
});
