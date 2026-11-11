// The release rules live in files people and assistants read; keep them from drifting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ASSETS = [
  'Eminzo-mac-arm64.dmg', 'Eminzo-mac-x64.dmg', 'Eminzo-mac-arm64.zip', 'Eminzo-mac-x64.zip',
  'Eminzo-win-x64.exe', 'Eminzo-linux-x64.AppImage', 'Eminzo-linux-x64.deb',
];

test('root package.json exposes release:cli', () => {
  assert.equal(JSON.parse(read('package.json')).scripts['release:cli'], 'node scripts/release-cli.mjs');
});

test('the keep-latest workflow reacts to published/edited, skips desktop releases and pins nothing loose', () => {
  const y = read('.github/workflows/keep-desktop-latest.yml');
  assert.match(y, /types:\s*\[published,\s*edited\]/);
  assert.match(y, /contents:\s*write/);
  assert.match(y, /!startsWith\(github\.event\.release\.tag_name,\s*'desktop-v'\)/);
  assert.match(y, /node scripts\/keep-desktop-latest\.mjs/);
  assert.match(y, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  for (const m of y.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `unpinned action ${m[1]}`);
});

test('docs/releasing.md carries the rules and every stable asset name', () => {
  const d = read('docs/releasing.md');
  assert.match(d, /--latest=false/);
  assert.match(d, /gh release edit desktop-v\S* --draft=false --latest/);
  assert.match(d, /desktop-v/);
  for (const a of ASSETS) assert.ok(d.includes(a), a);
});

test('README links the released macOS downloads by stable name and marks Windows and Linux as coming soon', () => {
  const r = read('README.md');
  for (const a of ['Eminzo-mac-arm64.dmg', 'Eminzo-mac-x64.dmg']) {
    assert.ok(r.includes(`https://github.com/bqsistemas/eminzo-ai-factory/releases/latest/download/${a}`), a);
  }
  // No dead links: Windows and Linux are linked only once their builds are released.
  for (const a of ASSETS.filter((n) => /-(win|linux)-/.test(n))) {
    assert.ok(!r.includes(`/releases/latest/download/${a}`), `${a} is not released yet`);
  }
  assert.match(r, /\| Windows[^\n]*Coming soon/);
  assert.match(r, /\| Linux[^\n]*Coming soon/);
});

test('CONTRIBUTING.md and CLAUDE.md state the Latest rule', () => {
  for (const f of ['CONTRIBUTING.md', 'CLAUDE.md']) {
    const t = read(f);
    assert.match(t, /docs\/releasing\.md/, f);
    assert.match(t, /--latest=false/, f);
    assert.match(t, /desktop-v/, f);
  }
  assert.doesNotMatch(read('CLAUDE.md'), /Co-Authored-By:/);
});

test('the workflow checks out the default branch without persisting credentials and keeps expressions out of run:', () => {
  const y = read('.github/workflows/keep-desktop-latest.yml');
  assert.match(y, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
  assert.match(y, /persist-credentials:\s*false/);
  for (const m of y.matchAll(/^\s*run:\s*(.*)$/gm)) assert.doesNotMatch(m[1], /\$\{\{/);
});

test('docs stay public-safe and list the auto-update files', () => {
  const d = read('docs/releasing.md');
  assert.doesNotMatch(d, /private/i);
  assert.doesNotMatch(d, /release:mac/);
  for (const f of ['latest-mac.yml', 'latest.yml', 'latest-linux.yml', '.blockmap']) assert.ok(d.includes(f), f);
  assert.match(d, /from `main`|from main/);
});

test('README is precise about signing and updates per platform', () => {
  const r = read('README.md');
  assert.match(r, /macOS[^.\n]*signed and notarized/i);
  assert.match(r, /\.deb/);
  assert.match(r, /install(ing)? the new `?\.deb/i);
});
