// Job 066: the coverage line of setup (`eminzo:setup-related`) and the setup status, pure and through the MCP tool.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETUP_COMPLETE_MARKER, parseSetupRelated, setupStatus } from '../factory/lib/setup-status.js';
import { factoryTools } from '../factory/lib/mcp/tools.js';

const entry = (repo) => ({ repo, description: 'A related service.' });
const team = { repo: 'acme/main', related_repos: [entry('acme/payments-api'), entry('acme/platform-infra'), entry('acme/design-tokens')] };
const ALL = ['acme/payments-api', 'acme/platform-infra', 'acme/design-tokens'];

describe('setupStatus', () => {
  test('AC-5: no text or no marker is missing and covers nothing', () => {
    for (const text of [null, '', '# Project\n<!-- eminzo:setup-related: acme/payments-api -->\n']) {
      assert.deepEqual(setupStatus(text, team), { state: 'missing', related: { covered: [], not_covered: ALL } });
    }
  });

  test('AC-5: the marker without a coverage line is complete and covers nothing', () => {
    assert.deepEqual(setupStatus(`# P\n${SETUP_COMPLETE_MARKER}\n`, team), { state: 'complete', related: { covered: [], not_covered: ALL } });
  });

  test('AC-5: the coverage line is tolerant, case-insensitive, ignores unknown slugs and keeps the config writing and order', () => {
    const text = `x\n<!--   eminzo:setup-related:   ACME/Payments-API   acme/platform-infra  other/gone -->\n${SETUP_COMPLETE_MARKER}\n`;
    assert.deepEqual(parseSetupRelated(text), ['acme/payments-api', 'acme/platform-infra', 'other/gone']);
    assert.deepEqual(setupStatus(text, team), { state: 'complete', related: { covered: ['acme/payments-api', 'acme/platform-infra'], not_covered: ['acme/design-tokens'] } });
  });

  test('the coverage line also accepts slugs separated by commas, as an agent may write it', () => {
    const text = `x\n<!-- eminzo:setup-related: acme/payments-api, acme/platform-infra,acme/design-tokens -->\n${SETUP_COMPLETE_MARKER}\n`;
    assert.deepEqual(parseSetupRelated(text), ['acme/payments-api', 'acme/platform-infra', 'acme/design-tokens']);
    assert.deepEqual(setupStatus(text, team), { state: 'complete', related: { covered: ALL, not_covered: [] } });
    assert.deepEqual(parseSetupRelated('<!-- eminzo:setup-related: , acme/x ,, -->'), ['acme/x']);
  });

  test('AC-5: parseSetupRelated drops invalid tokens and duplicates, takes the last line, and is empty without one', () => {
    assert.deepEqual(parseSetupRelated('nothing'), []);
    assert.deepEqual(parseSetupRelated('<!-- eminzo:setup-related: bad token a/b/c acme/x ACME/X -->'), ['acme/x']);
    assert.deepEqual(parseSetupRelated('<!-- eminzo:setup-related: acme/a -->\n<!-- eminzo:setup-related: acme/b -->'), ['acme/b']);
  });

  test('AC-5: invalid entries of the team config are left out, and a list-wide problem gives no entries', () => {
    const t = { repo: 'acme/main', related_repos: [entry('acme/ok'), entry('ACME/OK'), entry('acme/main'), { repo: 'bad' }] };
    assert.deepEqual(setupStatus(`${SETUP_COMPLETE_MARKER}\n`, t).related.not_covered, ['acme/ok']);
    assert.deepEqual(setupStatus(`${SETUP_COMPLETE_MARKER}\n`, { related_repos: 'x' }).related, { covered: [], not_covered: [] });
  });
});

function repoWith(project) {
  const root = mkdtempSync(join(tmpdir(), 'setup-status-'));
  mkdirSync(join(root, 'factory'), { recursive: true });
  writeFileSync(join(root, 'factory/config.json'), JSON.stringify(team));
  if (project !== undefined) writeFileSync(join(root, 'factory/project.md'), project);
  return root;
}

describe('setup_status tool', () => {
  const call = (root) => {
    const tool = factoryTools({ root }).find((t) => t.name === 'setup_status');
    assert.ok(tool, 'setup_status is offered');
    return tool.run({});
  };

  test('AC-6: the four cases return source, read_at, repo, state, lists and a summary', async () => {
    const cases = [
      [undefined, 'missing', [], ALL],
      ['# P\n', 'missing', [], ALL],
      [`# P\n${SETUP_COMPLETE_MARKER}\n`, 'complete', [], ALL],
      [`# P\n<!-- eminzo:setup-related: acme/payments-api -->\n${SETUP_COMPLETE_MARKER}\n`, 'complete', ['acme/payments-api'], ['acme/platform-infra', 'acme/design-tokens']],
    ];
    for (const [project, state, covered, notCovered] of cases) {
      const data = call(repoWith(project));
      assert.equal(data.source, 'local');
      assert.ok(data.read_at);
      assert.ok('repo' in data);
      assert.equal(data.state, state);
      assert.deepEqual(data.related, { covered, not_covered: notCovered });
      assert.ok(typeof data.summary === 'string' && data.summary.length > 0);
    }
  });
});
