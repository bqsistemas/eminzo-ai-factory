// A CLI release published after a desktop one would steal "Latest" and blind electron-updater.
// pickDesktopLatest chooses the desktop release that must be "Latest".
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickDesktopLatest } from '../scripts/keep-desktop-latest.mjs';

const rel = (tag, publishedAt, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, published_at: publishedAt, ...extra });

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
    rel('desktop-v1.1.0', '2026-03-01T00:00:00Z', { draft: true, published_at: null }),
    rel('desktop-v1.2.0-beta.1', '2026-04-01T00:00:00Z', { prerelease: true }),
    rel('desktop-v1.0.0', '2026-02-01T00:00:00Z'),
  ];
  assert.equal(pickDesktopLatest(list).tag_name, 'desktop-v1.0.0');
});

test('the newest published_at wins regardless of list order', () => {
  const list = [
    rel('desktop-v1.0.0', '2026-02-01T00:00:00Z'),
    rel('desktop-v1.1.0', '2026-03-01T00:00:00Z'),
    rel('v0.3.0', '2026-05-01T00:00:00Z'),
    rel('desktop-v1.0.1', '2026-02-15T00:00:00Z'),
  ];
  assert.equal(pickDesktopLatest(list).tag_name, 'desktop-v1.1.0');
  assert.equal(pickDesktopLatest([...list].reverse()).tag_name, 'desktop-v1.1.0');
});

test('only tags starting with desktop-v count', () => {
  assert.equal(pickDesktopLatest([rel('desktop-1.0.0', '2026-02-01T00:00:00Z'), rel('mydesktop-v1', '2026-02-01T00:00:00Z')]), null);
});

test('releases without a published date are skipped', () => {
  assert.equal(pickDesktopLatest([rel('desktop-v1.0.0', null)]), null);
});
