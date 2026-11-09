// How long a generated Claude wrapper body may be: the template's body lines, with {{rules}} and {{finish}} expanded.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sharedFragments } from '../../cli/src/adapters.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel) => readFileSync(`${repo}${rel}`, 'utf8');

export function wrapperLineCap(role) {
  const rules = JSON.parse(read('factory/templates/agents.json'))[role].rules.length;
  const finish = sharedFragments(read('factory/templates/agent-shared.md')).finish.split('\n').length;
  const body = read('factory/templates/agent-claude.md').replace(/^---\n[\s\S]*?\n---\n/, '').trim().split('\n');
  return body.reduce((n, line) => n + (line === '{{rules}}' ? rules : line === '{{finish}}' ? finish : 1), 0);
}
