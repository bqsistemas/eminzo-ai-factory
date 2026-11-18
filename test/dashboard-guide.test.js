import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dashboardSource } from './helpers/dashboard-source.js';

const html = dashboardSource();
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const header = html.match(/<header class="top">([\s\S]*?)<\/header>/)[1];

test('guide is reachable from an accessible header action', () => {
  assert.match(header, /<button[^>]+id="guide-toggle"[^>]+aria-label="[^"]+"[\s\S]*?<svg[\s\S]*?<\/svg>[\s\S]*?<\/button>/);
  assert.match(html, /<aside class="guide" id="guide"[^>]*aria-hidden="true"/);
  assert.match(html, /id="guide-title"/);
  assert.match(html, /id="guide-content"/);
});

test('guide explains pipeline, agent roles, commands and waiting states', () => {
  for (const text of ['guide-pipeline', 'guide-agents', 'guide-commands', 'guide-states']) {
    assert.match(html, new RegExp(`id="${text}"`), text);
  }
  for (const text of ['Intake', 'Spec', 'Build', 'Gate', 'Review', 'Approve', 'Merge', '$eminzo-factory run', '/eminzo-factory run']) {
    assert.match(html, new RegExp(text.replace(/[/$]/g, '\\$&')), text);
  }
});

test('guide uses the dashboard theme and opens through the existing drawer controls', () => {
  assert.match(css, /\.guide\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.guide\.open\s*\{[^}]*transform:\s*none/);
  assert.match(script, /function openGuide\(/);
  assert.match(script, /function closeGuide\(/);
  assert.match(script, /\$\('guide-toggle'\)\.addEventListener\('click'/);
  assert.match(script, /document\.addEventListener\('keydown',[\s\S]*e\.key !== 'Escape'/);
});

test('guide creates visual hierarchy instead of a single flat surface', () => {
  assert.match(css, /\.guide-content\s*\{[^}]*background:\s*var\(--bg\)/);
  assert.match(css, /\.guide-section\s*\{[^}]*background:\s*var\(--panel\)/);
  assert.match(css, /\.guide-section p\s*\{[^}]*line-height:\s*1\.5/);
  assert.match(css, /\.guide-step span\s*\{[^}]*color:\s*color-mix/);
  assert.match(css, /\.guide-agent\s*\{[^}]*border-left:\s*3px/);
});

test('guide keeps one restrained accent so colors do not compete with the text', () => {
  assert.doesNotMatch(css, /--step-accent|--agent-accent/);
  assert.match(css, /\.guide-step b\s*\{[^}]*color:\s*var\(--ink\)/);
  assert.match(css, /\.guide-agent b\s*\{[^}]*color:\s*var\(--ink\)/);
});

test('AC-2: the commands section explains setup, issue/feature and run_mode instead of the old intro', () => {
  const section = html.match(/<section[^>]*id="guide-commands"[^>]*>([\s\S]*?)<\/section>/)[1];
  assert.doesNotMatch(section, /Primero crea o etiqueta un issue/);
  assert.match(section, /setup/);
  assert.match(section, /run_mode/);
  assert.match(section, /queue/);
  assert.match(section, /issue &lt;n&gt;|issue 37/);
});

test('AC-1: the commands block keeps long commands inside the narrow guide column', () => {
  assert.match(css, /\.guide-cmds code\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test('pending chips breathe a dashed ring, never the chip itself, so text contrast does not depend on the phase', () => {
  const chip = css.match(/\.chip\.pending\s*\{([^}]*)\}/)[1];
  assert.match(chip, /border-color:\s*transparent/, 'the ring replaces the chip border');
  assert.doesNotMatch(chip, /animation|opacity/, 'the chip and its text stay still');
  assert.match(css, /\.chip\.pending::after\s*\{[^}]*border:\s*1px dashed var\(--pending\)[^}]*animation:\s*breathe\b/);
  const frames = css.match(/@keyframes breathe\s*\{([\s\S]*?\})\s*\}/)[1];
  // opacity on the ring's own box stays on the compositor; border-color repainted the chip every frame.
  assert.match(frames, /opacity/);
  assert.doesNotMatch(frames, /border-color/);
});
