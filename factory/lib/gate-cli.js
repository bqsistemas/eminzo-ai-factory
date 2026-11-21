// factory/bin/gate <job-id> [--out <file>]: the command line of the gate (see gate.js). It lives apart from gate.js
// because it needs job.js (the job's note says when the gate waits for the checks lock) and job.js imports gate.js:
// a module graph that enters gate.js and reaches job.js again fails at load time.
import { join, resolve } from 'node:path';

import { gate } from './gate.js';
import { gateWaitHooks } from './job.js';
import { Usage, factoryRoot, isMain, jobDir, readText, runCli } from './util.js';

export function main(args) {
  const [id, ...rest] = args;
  let out = null;
  if (rest.length === 2 && rest[0] === '--out') out = resolve(rest[1]);
  else if (rest.length) throw new Usage('gate <job-id> [--out <file>]');
  if (!id) throw new Usage('gate <job-id> [--out <file>]');
  const root = factoryRoot();
  const dir = jobDir(root, id);
  const text = readText(join(dir, 'job.json'));
  if (text === null) throw new Error(`no job ${id}`);
  const job = JSON.parse(text);
  if (!out) {
    if (!(job.round >= 1)) throw new Usage(`${id} has no build round yet`);
    out = join(dir, `round-${job.round}`, 'checks.md');
  }
  const pass = gate(root, job, out, gateWaitHooks(root, id));
  process.stdout.write(`${id} GATE: ${pass ? 'PASS' : 'FAIL'}\n`);
  return pass ? 0 : 1;
}

if (isMain(import.meta.url)) runCli(main);
