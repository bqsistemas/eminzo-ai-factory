// Claude <-> Codex parity net. Every orchestration rule and config key exists for both
// providers, so no improvement can quietly land for only one of them.
//
// RULE MARKER CONVENTION (read this before adding a rule to a skill)
//   Each orchestration rule that applies to both providers carries a stable marker,
//   one per rule, on its own line next to the rule text, in BOTH skills:
//     .claude/skills/eminzo-factory/SKILL.md   (Claude, /eminzo-factory)
//     .agents/skills/eminzo-factory/SKILL.md   (Codex, $eminzo-factory)
//   Marker syntax: <!-- rule: kebab-case-name -->   (for example <!-- rule: output-contract -->)
//   The test below fails when the two marker sets differ, so a rule written in one
//   skill and not the other is a bug. Later plan steps add their markers here too:
//   incremental-re-review, lane-xs, spec-amendment, and so on. Rename a marker only
//   in both skills at once. The wording of the rule may differ per provider; the
//   marker may not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(repo, path), 'utf8');
const config = JSON.parse(read('factory/config.json'));
const claude = config.providers.claude;
const codex = config.providers.codex;
const sorted = (value) => Object.keys(value ?? {}).sort();

test('providers.claude and providers.codex declare the same models', () => {
  assert.deepEqual(sorted(claude.models), sorted(codex.models));
});

test('providers.claude and providers.codex route the same builder levels and reviewer lenses', () => {
  assert.deepEqual(sorted(claude.routing?.builder), sorted(codex.routing?.builder));
  assert.deepEqual(sorted(claude.routing?.reviewers), sorted(codex.routing?.reviewers));
  for (const lens of sorted(claude.routing?.reviewers)) {
    const [a, b] = [claude, codex].map((p) => p.routing.reviewers[lens]);
    assert.deepEqual(sorted(a), sorted(b), `reviewer ${lens} has different fields per provider`);
  }
});

test('providers.claude and providers.codex declare the same lanes, when lanes exist', () => {
  assert.deepEqual(sorted(claude.lanes), sorted(codex.lanes));
  for (const lane of sorted(claude.lanes)) {
    assert.deepEqual(sorted(claude.lanes[lane]), sorted(codex.lanes[lane]), `lane ${lane} differs per provider`);
  }
});

// Role bodies are neutral (factory/roles/); `.claude/agents/` holds thin wrappers with the frontmatter.
const roles = readdirSync(join(repo, 'factory/roles')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();

test('every role has one Claude wrapper and one Codex profile pointing at that same role body, and no profile is orphaned', () => {
  assert.ok(roles.length > 0);
  const profiles = readdirSync(join(repo, '.codex/agents')).filter((f) => f.endsWith('.toml')).sort();
  assert.deepEqual(profiles, roles.map((role) => `eminzo-${role}.toml`));
  for (const role of roles) {
    const profile = read(`.codex/agents/eminzo-${role}.toml`);
    assert.ok(profile.includes(`factory/roles/${role}.md`), `eminzo-${role}.toml must point to factory/roles/${role}.md`);
    assert.ok(read(`.claude/agents/eminzo-${role}.md`).includes(`factory/roles/${role}.md`), `the eminzo-${role} wrapper must point to factory/roles/${role}.md`);
  }
});

const markers = (path) => [...read(path).matchAll(/<!--\s*rule:\s*([a-z0-9-]+)\s*-->/g)].map((m) => m[1]);

test('both orchestrator skills carry the same set of rule markers', () => {
  const a = markers('.claude/skills/eminzo-factory/SKILL.md');
  const b = markers('.agents/skills/eminzo-factory/SKILL.md');
  assert.ok(a.length > 0, 'the Claude skill has no rule markers');
  assert.equal(new Set(a).size, a.length, 'duplicate marker in the Claude skill');
  assert.equal(new Set(b).size, b.length, 'duplicate marker in the Codex skill');
  assert.deepEqual([...new Set(a)].sort(), [...new Set(b)].sort());
});

// P0-2: the output contract. file = what the role owns; token = its first-line protocol.
const OUTPUT = {
  intake: { file: '{job}/intake.md', token: /^(ACCEPT|NEEDS-INFO|REJECT)\b/, samples: ['ACCEPT', 'NEEDS-INFO', 'REJECT'] },
  'spec-writer': { file: '{job}/spec.md', token: /^# Spec: /, samples: ['# Spec: Dark mode'] },
  builder: { file: '{job}/build.md', token: /^STATUS: (READY|BLOCKED)\b/, samples: ['STATUS: READY', 'STATUS: BLOCKED'] },
  'review-code': { file: '{round}/review-code.md', token: /^VERDICT: (PASS|CHANGES)\b/, samples: ['VERDICT: PASS', 'VERDICT: CHANGES'] },
  'review-security': { file: '{round}/review-security.md', token: /^VERDICT: (PASS|CHANGES)\b/, samples: ['VERDICT: PASS', 'VERDICT: CHANGES'] },
  'review-ui': { file: '{round}/review-ui.md', token: /^VERDICT: (PASS|CHANGES)\b/, samples: ['VERDICT: PASS', 'VERDICT: CHANGES'] },
  'review-ux': { file: '{round}/review-ux.md', token: /^VERDICT: (PASS|CHANGES)\b/, samples: ['VERDICT: PASS', 'VERDICT: CHANGES'] },
  approver: { file: '{job}/decision.md', token: /^(APPROVE|ESCALATE)\b/, samples: ['APPROVE', 'ESCALATE'] },
};

const frontmatter = (text) => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
// Hook commands are YAML scalars, single or double quoted; unwrap them to the shell line.
const stopCommands = (text) => [...frontmatter(text).matchAll(/command:\s*(.+)$/gm)]
  .map((m) => m[1].trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1').replaceAll('\\"', '"'));

test('the output table covers exactly the roles that exist', () => {
  assert.deepEqual(Object.keys(OUTPUT).sort(), roles);
});

test('every Claude role wires a Stop hook to ensure-output for the file it owns', () => {
  for (const role of roles) {
    const text = read(`.claude/agents/eminzo-${role}.md`);
    const roleBody = read(`factory/roles/${role}.md`);
    const { file, token, samples } = OUTPUT[role];
    assert.match(frontmatter(text), /^hooks:\n {2}Stop:/m, `${role} has no Stop hook`);
    const hook = stopCommands(text).find((c) => c.includes('factory/bin/ensure-output'));
    assert.ok(hook, `${role} does not call factory/bin/ensure-output`);
    assert.ok(hook.includes(`'${file}'`), `${role} hook must check ${file}`);
    const pattern = /ensure-output '[^']+' '([^']+)'/.exec(hook)?.[1];
    assert.ok(pattern, `${role} hook has no first-line regex`);
    const regex = new RegExp(pattern);
    for (const sample of samples) assert.ok(regex.test(sample), `${role} hook rejects ${sample}`);
    assert.ok(!regex.test('# Notes'), `${role} hook accepts a non-token first line`);
    assert.ok(token.test(samples[0]));
    assert.ok(roleBody.includes(file.replace('{job}', '<job folder>').replace('{round}', '<round folder>')),
      `${role} body does not name ${file}`);
  }
});

test('hook regexes reject near-miss first lines', () => {
  const nearMiss = {
    intake: ['ACCEPTED', 'REJECTED', 'NEEDS-INFOS'],
    'spec-writer': ['# Spec:', '#Spec: x'],
    builder: ['STATUS: READYX', 'STATUS: BLOCKEDX', 'STATUS: DONE'],
    approver: ['APPROVED', 'ESCALATED'],
  };
  for (const role of roles) {
    const misses = nearMiss[role] ?? ['VERDICT: PASSED', 'VERDICT: CHANGESX', 'VERDICT:PASS', 'verdict: PASS'];
    const hook = stopCommands(read(`.claude/agents/eminzo-${role}.md`)).find((c) => c.includes('ensure-output'));
    const regex = new RegExp(/ensure-output '[^']+' '([^']+)'/.exec(hook)[1]);
    for (const miss of misses) assert.ok(!regex.test(miss), `${role} hook accepts ${miss}`);
  }
});

test('the builder keeps nudge next to ensure-output', () => {
  const commands = stopCommands(read('.claude/agents/eminzo-builder.md'));
  assert.ok(commands.some((c) => c.endsWith('factory/bin/nudge')));
  assert.ok(commands.some((c) => c.includes('factory/bin/ensure-output')));
});

test('every Claude wrapper has the Before you finish section (generated from the template)', () => {
  for (const role of roles) {
    const body = read(`.claude/agents/eminzo-${role}.md`);
    const section = /\*\*Before you finish\*\*([\s\S]*)$/.exec(body)?.[1];
    assert.ok(section, `${role} has no "Before you finish" section`);
    assert.match(section, /Write tool/, `${role}: step 1 must call the Write tool`);
    assert.match(section, /head -1/, `${role}: step 2 must run head -1`);
    assert.match(section, /Reply to the orchestrator with exactly one line/, `${role}: step 3 must reply with one line`);
  }
});

// What each Codex profile must show: the full path of its own file and its own tokens.
const TOKENS = {
  intake: ['ACCEPT', 'NEEDS-INFO', 'REJECT'], 'spec-writer': ['# Spec: '],
  builder: ['STATUS: READY', 'STATUS: BLOCKED'], approver: ['APPROVE', 'ESCALATE'],
};

test('every Codex profile names its own output file and tokens', () => {
  for (const role of roles) {
    const profile = read(`.codex/agents/eminzo-${role}.toml`);
    const path = OUTPUT[role].file.replace('{job}', 'factory/jobs/<id>').replace('{round}', 'factory/jobs/<id>/round-N');
    assert.ok(profile.includes(`head -1 ${path}`), `eminzo-${role}.toml must run head -1 ${path}`);
    for (const token of TOKENS[role] ?? ['VERDICT: PASS', 'VERDICT: CHANGES']) {
      assert.ok(profile.includes(`\`${token}\``), `eminzo-${role}.toml must name the token ${token}`);
    }
  }
});

test('every Codex profile carries the same before-replying instruction', () => {
  for (const role of roles) {
    const profile = read(`.codex/agents/eminzo-${role}.toml`);
    assert.match(profile, /head -1/, `eminzo-${role}.toml lacks the head -1 check`);
    assert.match(profile, /rewrite the file/i, `eminzo-${role}.toml lacks the rewrite instruction`);
  }
});
