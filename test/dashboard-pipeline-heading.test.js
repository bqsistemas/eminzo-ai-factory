import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dashboardSource } from './helpers/dashboard-source.js';

const html = dashboardSource();
const section = html.match(/<section[^>]*id="pipeline"[^>]*>\s*<h2>([^<]*)<\/h2>/);
const tag = html.match(/<section[^>]*id="pipeline"[^>]*>/)?.[0] ?? '';

test('AC-1: the #pipeline section aria-label is "Pipeline for task"', () => {
  assert.equal(tag.match(/aria-label="([^"]*)"/)?.[1], 'Pipeline for task');
});

test('AC-2: the #pipeline h2 reads exactly "Pipeline for task"', () => {
  assert.ok(section, 'h2 inside #pipeline');
  assert.equal(section[1], 'Pipeline for task');
});

test('AC-3: the #pipeline section keeps its id and class', () => {
  assert.match(tag, /class="panel pipeline"/);
  assert.match(tag, /id="pipeline"/);
});

test('AC-4: pipeline labels are localized and en/es/pt dictionaries stay aligned', () => {
  const json = JSON.parse(html.match(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/)[1]);
  const en = Object.keys(json.en).sort();
  for (const lang of ['en', 'es', 'pt']) {
    assert.deepEqual(Object.keys(json[lang]).sort(), en);
    for (const key of ['pipelineJob', 'pipelineStage', 'pipelineActive', 'pipelinePending', 'pipelineComplete', 'pipelineBlocked', 'pipelineArtifacts', 'pipelineNotWritten']) {
      assert.ok(json[lang][key], `${lang}.${key}`);
    }
  }
});
