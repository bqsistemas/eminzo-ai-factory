import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import { AVATARS, OCTOPUS, avatarSvg } from '../factory/avatars.js';

const agentsDir = new URL('../.claude/agents/', import.meta.url);

// Reads the frontmatter `name:` of every agent file in .claude/agents/.
async function agentNames() {
  const files = (await readdir(agentsDir)).filter((f) => f.endsWith('.md'));
  const names = [];
  for (const file of files) {
    const text = await readFile(new URL(file, agentsDir), 'utf8');
    const name = text.match(/^---\n[\s\S]*?^name:\s*(.+)$/m)?.[1].trim();
    assert.ok(name, `${file} has a frontmatter name`);
    names.push(name);
  }
  return names;
}

test('AC-1: AVATARS matches .claude/agents/ with distinct colors and accessories; OCTOPUS has the shared shape', async () => {
  const fromFiles = (await agentNames()).sort();
  assert.equal(fromFiles.length, 8, 'eight agent files');
  assert.deepEqual(Object.keys(AVATARS).sort(), fromFiles);

  for (const [name, { color, accessory }] of Object.entries(AVATARS)) {
    assert.match(color, /^#[0-9a-f]{6}$/i, `${name} color is #rrggbb`);
    assert.equal(typeof accessory, 'string', `${name} accessory is a string`);
    assert.ok(accessory.trim(), `${name} accessory is non-empty`);
  }
  const colors = Object.values(AVATARS).map((a) => a.color.toLowerCase());
  assert.equal(new Set(colors).size, 8, 'eight distinct colors');
  const accessories = Object.values(AVATARS).map((a) => a.accessory);
  assert.equal(new Set(accessories).size, 8, 'eight distinct accessories');

  assert.equal(OCTOPUS.viewBox, '0 0 32 32');
  assert.equal(typeof OCTOPUS.head, 'string');
  assert.ok(OCTOPUS.head.trim(), 'head is non-empty');
  assert.ok(Array.isArray(OCTOPUS.tentacles) && OCTOPUS.tentacles.length >= 4, 'at least 4 tentacles');
  for (const t of OCTOPUS.tentacles) assert.ok(typeof t === 'string' && t.trim(), 'tentacle path is non-empty');
  assert.ok(Array.isArray(OCTOPUS.eyes) && OCTOPUS.eyes.length >= 2, 'at least 2 eyes');
  for (const e of OCTOPUS.eyes) {
    for (const k of ['cx', 'cy', 'r']) assert.equal(typeof e[k], 'number', `eye ${k} is a number`);
  }
  assert.ok(Object.isFrozen(OCTOPUS) && Object.isFrozen(AVATARS), 'shared data is frozen');
});

test('AC-2: avatarSvg builds a safe, distinct octopus per agent and returns "" for anything else', () => {
  const results = [];
  for (const [name, { color }] of Object.entries(AVATARS)) {
    const svg = avatarSvg(name);
    results.push(svg);
    assert.ok(svg.startsWith('<svg'), `${name} starts with <svg`);
    assert.match(svg, /class="octo"/, `${name} has class="octo"`);
    assert.ok((svg.match(/class="octo-tentacle"/g) ?? []).length >= 4, `${name} has 4+ tentacles`);
    assert.equal((svg.match(/class="octo-accessory"/g) ?? []).length, 1, `${name} has one accessory`);
    assert.ok(svg.includes(color), `${name} uses its color`);
    assert.doesNotMatch(svg, /style=|href|src=|url\(|<script|aria-hidden/i, `${name} has no unsafe markup`);
    assert.doesNotMatch(svg, /\son\w+=/i, `${name} has no event handler attributes`);
  }
  assert.equal(new Set(results).size, 8, 'eight distinct results');

  for (const bad of ['unknown', '<img src=x onerror=alert(1)>', null, 42, undefined, {}, 'constructor', '__proto__']) {
    assert.equal(avatarSvg(bad), '', `avatarSvg(${String(bad)})`);
  }
});
