// The ONE list of GitHub labels this repository uses: the factory's and Ask Eminzo's.
// `factory/bin/setup` creates every one of them (`gh label create --force`, so it also updates); the desktop's Install
// runs that same script. To add or change a label, edit this list and nothing else.
// GitHub answers HTTP 422 for a description over 100 characters; test/labels.test.js enforces the limit.
import { fileURLToPath } from 'node:url';

export const BRIEF_ISSUE_LABEL = 'eminzo-brief';
export const DELIVERABLE_LABEL = 'eminzo-deliverable';

/** @type {ReadonlyArray<{ name: string, color: string, description: string }>} */
export const LABELS = [
  { name: 'factory', color: '1d76db', description: 'Build this issue with the software factory' },
  { name: 'factory:needs-info', color: 'fbca04', description: 'Factory intake is waiting for the issue author' },
  { name: 'factory:needs-human', color: 'd93f0b', description: 'Factory escalated this job to a human' },
  { name: 'factory:xs', color: '0e8a16', description: 'Ask for the XS lane: the factory still checks the criteria and promotes on the first failure' },
  { name: 'factory:spec-review', color: '5319e7', description: "Factory spec is waiting for the developer's review (approve-spec or revise-spec)" },
  { name: BRIEF_ISSUE_LABEL, color: '5319e7', description: 'Approved brief created by Eminzo: the record of an initiative. Not edited afterwards.' },
  { name: DELIVERABLE_LABEL, color: '0e8a16', description: 'Deliverable of an approved Eminzo brief. Enters the factory when the tech lead adds factory.' },
];

// CLI for factory/bin/setup (POSIX sh): `node labels.js [name...]` prints one `name<TAB>color<TAB>description` line per
// label (all of them, or only the names given), in list order. An unknown name is an error.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((n) => !LABELS.some((l) => l.name === n));
  if (unknown.length) { process.stderr.write(`unknown label: ${unknown.join(', ')}\n`); process.exit(2); }
  for (const l of LABELS) if (!wanted.length || wanted.includes(l.name)) process.stdout.write(`${l.name}\t${l.color}\t${l.description}\n`);
}
