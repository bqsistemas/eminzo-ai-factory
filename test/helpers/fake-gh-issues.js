// A fake `gh` for the base-fix issue tests (FACTORY_GH points at it): answers `issue list --label --state` and
// `issue create`, keeps its issues in a JSON file and logs every call. It never talks to GitHub.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} dir where the fake lives
 * @param {{ open?: number[], failCreate?: string|null, failList?: string|null, race?: boolean }} [options]
 *   `open` are open issues that already carry factory:base-fix; `race` makes another machine create a lower-numbered
 *   one between this engine's list and its create.
 */
export function fakeGhIssues(dir, { open = [], failCreate = null, failList = null, race = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, 'gh-state.json');
  const logFile = join(dir, 'gh-log');
  const state = { issues: open.map((number) => ({ number, title: 'earlier', body: '', labels: ['factory', 'factory:base-fix'], state: 'open' })), next: Math.max(0, ...open) + 1, failCreate, failList, race };
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(logFile, '');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const labels = []; for (let i = 0; i < args.length; i += 1) if (args[i] === '--label') labels.push(args[i + 1]);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const entry = { args };
if (flag('--body-file') !== undefined) entry.body = fs.readFileSync(flag('--body-file'), 'utf8');
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(entry) + '\\n');
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
const [a, b] = args;
if (a === 'issue' && b === 'list') {
  if (state.failList) fail(state.failList);
  const found = state.issues.filter((i) => i.state === flag('--state') && labels.every((l) => i.labels.includes(l)));
  process.stdout.write(JSON.stringify(found.map((i) => ({ number: i.number }))));
} else if (a === 'issue' && b === 'create') {
  if (state.failCreate) fail(state.failCreate);
  if (state.race) { state.issues.push({ number: state.next, title: 'racer', body: '', labels: ['factory', 'factory:base-fix'], state: 'open' }); state.next += 1; state.race = false; }
  const number = state.next; state.next += 1;
  state.issues.push({ number, title: flag('--title'), body: entry.body, labels, state: 'open' });
  save();
  process.stdout.write('https://github.com/acme/shop/issues/' + number + '\\n');
} else if (a === 'issue' && b === 'close') {
  const issue = state.issues.find((i) => String(i.number) === args[2]);
  if (!issue) fail('no such issue');
  issue.state = 'closed';
  save();
} else fail('unexpected gh call: ' + args.join(' '));
`, { mode: 0o755 });
  return {
    gh,
    calls: () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    creates: () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.args[1] === 'create'),
    issues: () => JSON.parse(readFileSync(stateFile, 'utf8')).issues,
  };
}
