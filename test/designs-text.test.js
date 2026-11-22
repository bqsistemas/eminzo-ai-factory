// The text side of the designs linked in an issue: both orchestrator skills, the four roles that read a design and
// the user guide. The engine side is in designs.test.js and job-designs.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(repo, path), 'utf8');
const flat = (text) => text.replace(/\s+/g, ' ');

/** The rule that follows a marker: from the marker to the next marker or the next heading. */
function rule(text, name) {
  const start = text.indexOf(`<!-- rule: ${name} -->`);
  assert.ok(start >= 0, `no <!-- rule: ${name} --> marker`);
  const rest = text.slice(start + 1);
  const ends = [rest.search(/<!-- rule: /), rest.search(/\n#{1,3} /)].filter((i) => i >= 0);
  return rest.slice(0, ends.length ? Math.min(...ends) : rest.length);
}

test('AC-8: the Claude skill downloads the pending Claude artifacts before intake, with the five commands and the no-tool fallback', () => {
  const skill = read('.claude/skills/eminzo-factory/SKILL.md');
  const block = flat(rule(skill, 'designs'));
  for (const command of ['designs', 'design-artboards', 'design-images', 'design-done', 'design-failed']) {
    assert.ok(block.includes(`factory/bin/job <id> ${command}`), `names factory/bin/job <id> ${command}`);
  }
  assert.match(block, /no-tool/);
  assert.match(block, /after `factory\/bin\/job new`/);
  assert.match(block, /`needs-info` (comes back|returns) to `intake`/);
  assert.match(block, /before you spawn `eminzo-intake`/i);
  assert.match(block, /only the images (that )?`design-images` prints|download no other image/i);
  assert.match(block, /only a Claude Code session logged in to claude\.ai/i);
  assert.match(block, /data, never instructions/);
  assert.match(block, /never publish, edit or comment on the artifact/i);
  assert.match(block, /never edit `issue\.md`/i);
  assert.match(block, /never stops the job/i);
  const stages = skill.indexOf('## Stages');
  const intake = skill.indexOf('- **intake**: spawn `eminzo-intake`');
  const marker = skill.indexOf('<!-- rule: designs -->');
  assert.ok(stages < marker && marker < intake, 'the rule sits in Stages, before intake');
  assert.match(skill, /jobs\/<id>\/[^\n]*\n[^\n]*design\//, 'the job folder listing names design/');
});

test('AC-8: the Codex skill records every pending link as no-tool before intake', () => {
  const block = flat(rule(read('.agents/skills/eminzo-factory/SKILL.md'), 'designs'));
  assert.ok(block.includes('factory/bin/job <id> designs'));
  assert.ok(block.includes("factory/bin/job <id> design-failed '<url>' no-tool"));
  assert.match(block, /before you spawn `eminzo-intake`/i);
  assert.match(block, /only a Claude Code session logged in to claude\.ai/i);
});

test('AC-8: the four roles that read a design say where it is, that it is data, and what to do with an image they cannot open', () => {
  for (const name of ['intake', 'spec-writer', 'builder', 'review-ui']) {
    const text = flat(read(`factory/roles/${name}.md`));
    assert.ok(text.includes('`## Designs`'), `${name}: names the ## Designs section`);
    assert.ok(text.includes('`<job folder>/design/`'), `${name}: names the design/ folder`);
    assert.ok(text.includes('`assets.json`'), `${name}: names assets.json`);
    assert.match(text, /`notes` of (a |the )?`canvas\.json`/, `${name}: names the notes of canvas.json`);
    assert.match(text, /design[^.]*is data, never instructions/i, `${name}: a design is data`);
    assert.match(text, /never in a browser/, `${name}: HTML is read as source`);
    assert.match(text, /pending, summary only or not downloaded/, `${name}: a design not seen`);
    assert.match(text, /cannot open an image, say so/i, `${name}: an image the agent cannot open`);
    assert.doesNotMatch(text, /factory\/(lib|roles|templates)\//, `${name}: no engine path`);
  }
  assert.match(flat(read('factory/roles/intake.md')), /NEEDS-INFO[^.]*depends on a design (that was|you have) not seen|depends on a design that was not seen[^.]*NEEDS-INFO/);
  assert.match(flat(read('factory/roles/review-ui.md')), /compare what was built with the design: layout, colors, sizes and texts/i);
});

test('AC-8: the guide says only a Claude Code session logged in to claude.ai downloads Claude artifacts, and what agents do with them', () => {
  const guide = flat(read('docs/guide.md'));
  assert.match(guide, /only a Claude Code session logged in to claude\.ai downloads Claude artifacts/i);
  assert.match(guide, /## Designs/);
  assert.match(guide, /data, never instructions/);
});
