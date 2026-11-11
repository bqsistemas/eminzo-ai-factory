// A CLI release published after a desktop one would steal "Latest" and blind electron-updater.
// pickDesktopLatest chooses the desktop release that must be "Latest"; main() applies it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickDesktopLatest, main } from '../scripts/keep-desktop-latest.mjs';

const rel = (tag, publishedAt, extra = {}) => ({ id: tag.length * 1000 + (publishedAt ? 1 : 0), tag_name: tag, draft: false, prerelease: false, published_at: publishedAt, ...extra });

test('empty or invalid input has no desktop release', () => {
  assert.equal(pickDesktopLatest([]), null);
  assert.equal(pickDesktopLatest(null), null);
  assert.equal(pickDesktopLatest(undefined), null);
});

test('CLI releases are never picked', () => {
  assert.equal(pickDesktopLatest([rel('v0.2.1', '2026-01-01T00:00:00Z')]), null);
});

test('drafts and prereleases are skipped', () => {
  const list = [
    rel('desktop-v1.1.0', null, { draft: true }),
    rel('desktop-v1.2.0-beta.1', '2026-04-01T00:00:00Z', { prerelease: true }),
    rel('desktop-v1.0.0', '2026-02-01T00:00:00Z'),
  ];
  assert.equal(pickDesktopLatest(list).tag_name, 'desktop-v1.0.0');
});

test('the highest semver wins regardless of list order or CLI releases', () => {
  const list = [
    rel('desktop-v1.0.0', '2026-02-01T00:00:00Z'),
    rel('desktop-v1.10.0', '2026-03-01T00:00:00Z'),
    rel('v0.3.0', '2026-05-01T00:00:00Z'),
    rel('desktop-v1.9.0', '2026-02-15T00:00:00Z'),
  ];
  assert.equal(pickDesktopLatest(list).tag_name, 'desktop-v1.10.0');
  assert.equal(pickDesktopLatest([...list].reverse()).tag_name, 'desktop-v1.10.0');
});

test('a hotfix on an older line published later never takes Latest', () => {
  const list = [rel('desktop-v2.0.0', '2026-03-01T00:00:00Z'), rel('desktop-v1.4.1', '2026-04-01T00:00:00Z')];
  assert.equal(pickDesktopLatest(list).tag_name, 'desktop-v2.0.0');
});

test('published_at only breaks ties between equal versions', () => {
  const a = rel('desktop-v1.0.0', '2026-02-01T00:00:00Z', { id: 1 });
  const b = rel('desktop-v1.0.0', '2026-02-02T00:00:00Z', { id: 2 });
  assert.equal(pickDesktopLatest([a, b]).id, 2);
  assert.equal(pickDesktopLatest([b, a]).id, 2);
});

test('only well formed desktop-vX.Y.Z tags count', () => {
  const list = [rel('desktop-1.0.0', '2026-02-01T00:00:00Z'), rel('mydesktop-v1', '2026-02-01T00:00:00Z'), rel('desktop-vnext', '2026-02-01T00:00:00Z')];
  assert.equal(pickDesktopLatest(list), null);
});

test('releases without a published date are skipped', () => {
  assert.equal(pickDesktopLatest([rel('desktop-v1.0.0', null)]), null);
});

// main() with an injected gh runner
const REPO = 'o/r';
function run({ pages, latest, latestError }) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const path = args.find((a) => a.startsWith('repos/'));
    if (path?.includes('/releases?')) return JSON.stringify(pages);
    if (path?.endsWith('/releases/latest')) {
      if (latestError) throw latestError;
      return JSON.stringify(latest);
    }
    return '{}';
  };
  const logs = [];
  const code = main({ GITHUB_REPOSITORY: REPO }, gh, (m) => logs.push(m));
  return { code, calls, logs };
}
const desktop = { id: 11, tag_name: 'desktop-v1.0.0', draft: false, prerelease: false, published_at: '2026-02-01T00:00:00Z' };
const cli = { id: 22, tag_name: 'v0.2.1', draft: false, prerelease: false, published_at: '2026-03-01T00:00:00Z' };
const patches = (calls) => calls.filter((c) => c.includes('PATCH'));

test('main flattens slurped pages and restores Latest with make_latest=true', () => {
  const r = run({ pages: [[cli], [desktop]], latest: cli });
  assert.equal(r.code, 0);
  const [p] = patches(r.calls);
  assert.ok(p.includes(`repos/${REPO}/releases/11`));
  assert.ok(p.includes('make_latest=true'));
  assert.ok(r.calls[0].includes('--paginate') && r.calls[0].includes('--slurp'));
});

test('main does nothing when the desktop release is already Latest', () => {
  const r = run({ pages: [[desktop, cli]], latest: desktop });
  assert.equal(r.code, 0);
  assert.equal(patches(r.calls).length, 0);
});

test('main exits 0 without calls beyond the listing when no desktop release exists', () => {
  const r = run({ pages: [[cli]], latest: cli });
  assert.equal(r.code, 0);
  assert.equal(patches(r.calls).length, 0);
  assert.equal(r.calls.length, 1);
});

test('a 404 on releases/latest means no current Latest and still patches', () => {
  const r = run({ pages: [[desktop]], latestError: new Error('gh: Not Found (HTTP 404)') });
  assert.equal(r.code, 0);
  assert.equal(patches(r.calls).length, 1);
});

test('other errors from releases/latest are not swallowed', () => {
  assert.throws(() => run({ pages: [[desktop]], latestError: new Error('gh: Server Error (HTTP 500)') }), /500/);
});

test('main needs GITHUB_REPOSITORY', () => {
  assert.throws(() => main({}, () => '[]', () => {}), /GITHUB_REPOSITORY/);
});
