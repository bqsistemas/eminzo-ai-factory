// P1-3: a common project.md template, a deterministic first draft, a non-blocking
// freshness check, and this repo's own project.md written against the template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_SECTIONS, sectionText, uncoveredPaths } from '../factory/lib/project-map.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(repo, path), 'utf8');
const headings = (text) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].replace(/\s*\(.*$/, '').trim());
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('the template has every required section', () => {
  const template = read('factory/templates/project.md');
  assert.deepEqual(REQUIRED_SECTIONS, ['Snapshot', 'Stack', 'Commands', 'Module map', 'UI contract', 'Conventions']);
  for (const name of REQUIRED_SECTIONS) assert.ok(headings(template).includes(name), `template lacks ## ${name}`);
  assert.match(template, /## UI contract[^\n]*optional/i, 'UI contract is marked optional');
});

test('this repo project.md follows the template, with the module map and UI contract', () => {
  const text = read('factory/project.md');
  for (const name of REQUIRED_SECTIONS) assert.ok(headings(text).includes(name), `project.md lacks ## ${name}`);
  assert.match(sectionText(text, 'Snapshot'), /2026-11-01/);
  assert.match(sectionText(text, 'Snapshot'), /job 040/);
  const map = sectionText(text, 'Module map');
  for (const file of readdirSync(join(repo, 'factory')).filter((f) => /\.(js|html)$/.test(f))) {
    assert.ok(map.includes(file) || uncoveredPaths([`factory/${file}`], text).length === 0, `Module map does not cover factory/${file}`);
  }
  for (const dir of ['lib', 'bin', 'roles', 'templates']) {
    for (const file of readdirSync(join(repo, 'factory', dir))) {
      assert.deepEqual(uncoveredPaths([`factory/${dir}/${file}`], text), [], `Module map does not cover factory/${dir}/${file}`);
    }
  }
  const ui = sectionText(text, 'UI contract');
  for (const word of ['tokens', 'breakpoint', 'en', 'es', 'pt', 'longer', 'ids', 'CSP']) {
    assert.ok(new RegExp(word, 'i').test(ui), `UI contract does not mention ${word}`);
  }
  assert.ok(!text.includes('origin/main'), 'project.md keeps no hardcoded base');
});

test('uncoveredPaths: globs, basenames, folders and ignored paths', () => {
  const md = '## Module map\n- `src/app.js`: app\n- `lib/*`: helpers\n- `factory/office*.js`: office\n- `public/`: assets\n\n## Conventions\n- `other.js`\n';
  assert.deepEqual(uncoveredPaths(['src/app.js', 'factory/lib/new.js', 'factory/office-x.js', 'public/a/b.png'], md), []);
  assert.deepEqual(uncoveredPaths(['src/extra.js', 'brand.js'], md), ['src/extra.js', 'brand.js']);
  assert.deepEqual(uncoveredPaths(['other.js'], md), ['other.js'], 'only the Module map counts');
  assert.deepEqual(uncoveredPaths(['test/x.test.js', 'docs/a.md', 'README.md', 'package-lock.json', '.github/w.yml'], md), []);
  assert.deepEqual(uncoveredPaths(['a.js'], '# no map here\n'), ['a.js']);
});

function initSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'factory-init-'));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'factory'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', engines: { node: '>=20' }, scripts: { start: 'node src/x.js', test: 'node --test test/', build: 'esbuild' } }));
  writeFileSync(join(root, 'src/x.js'), '//\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}
const init = (root, ...args) => spawnSync(join(repo, 'factory/bin/init'), args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, FACTORY_ROOT: root, FACTORY_TODAY: '2026-11-01' } });

test('init writes the skeleton from the repo, deterministically, and never overwrites', () => {
  const root = initSandbox();
  const first = init(root);
  assert.equal(first.status, 0, first.stderr);
  const text = readFileSync(join(root, 'factory/project.md'), 'utf8');
  for (const name of REQUIRED_SECTIONS.filter((n) => n !== 'UI contract')) assert.ok(headings(text).includes(name), `skeleton lacks ## ${name}`);
  assert.match(sectionText(text, 'Snapshot'), /2026-11-01/);
  assert.match(sectionText(text, 'Stack'), /Node\.js/);
  assert.match(sectionText(text, 'Commands'), /npm test/);
  assert.match(sectionText(text, 'Commands'), /npm start/);
  assert.match(sectionText(text, 'Module map'), /`src\/`/);
  assert.ok(!headings(text).includes('UI contract'), 'no UI contract without a UI');
  writeFileSync(join(root, 'factory/project.md'), '# hand written\n');
  const second = init(root);
  assert.equal(second.status, 0);
  assert.equal(readFileSync(join(root, 'factory/project.md'), 'utf8'), '# hand written\n');
  assert.match(second.stdout, /already exists/);
  rmSync(join(root, 'factory/project.md'));
  init(root);
  assert.equal(readFileSync(join(root, 'factory/project.md'), 'utf8'), text, 'same repo, same draft');
});

// The gate writes a Project map line into checks.md; it never changes the verdict.
function gateSandbox(projectMd) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-map-'));
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'root');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(join(root, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'factory/jobs/\nfactory/board.json\n.worktrees/\n');
  writeFileSync(join(root, 'factory/config.json'), read('factory/config.json'));
  writeFileSync(join(root, 'factory/checks.sh'), '#!/bin/sh\nexit 0\n');
  if (projectMd !== null) writeFileSync(join(root, 'factory/project.md'), projectMd);
  writeFileSync(join(root, 'app.js'), '//\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin');
  const id = '001-map';
  const worktree = join(root, '.worktrees', id);
  git(root, 'worktree', 'add', '-q', worktree, '-b', `factory/${id}`, 'origin/main');
  const jobDir = join(root, 'factory/jobs', id);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ id, issue: 1, branch: `factory/${id}`, worktree, stage: 'gate', round: 1, max_rounds: 3 }));
  return {
    worktree,
    commit(files) {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(worktree, path, '..'), { recursive: true });
        writeFileSync(join(worktree, path), text);
      }
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '-q', '-m', 'change');
    },
    gate() {
      const res = spawnSync(join(repo, 'factory/bin/gate'), [id], { cwd: root, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, FACTORY_ROOT: root } });
      return { res, report: readFileSync(join(jobDir, 'round-1/checks.md'), 'utf8') };
    },
  };
}
const MAP = '## Module map\n- `app.js`: entry\n- `lib/*`: helpers\n';

test('gate: a new module missing from the Module map is flagged and the gate still passes', () => {
  const s = gateSandbox(MAP);
  s.commit({ 'newmod.js': '//\n', 'lib/ok.js': '//\n', 'test/n.test.js': '//\n' });
  const { res, report } = s.gate();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(report.split('\n')[0], 'GATE: PASS');
  assert.match(report, /^Project map: stale/m);
  assert.match(report, /- newmod\.js/);
  assert.ok(!/- lib\/ok\.js/.test(report));
  assert.match(report, /Module map/);
});

test('gate: the Module map the branch updates counts, and covered or absent maps stay quiet', () => {
  const s = gateSandbox(MAP);
  s.commit({ 'newmod.js': '//\n', 'factory/project.md': `${MAP}- \`newmod.js\`: new\n` });
  assert.match(s.gate().report, /^Project map: ok/m);
  const none = gateSandbox(null);
  none.commit({ 'newmod.js': '//\n' });
  const { res, report } = none.gate();
  assert.equal(res.status, 0);
  assert.match(report, /^Project map: not checked/m);
  const quiet = gateSandbox(MAP);
  quiet.commit({ 'app.js': '// edit only\n' });
  assert.match(quiet.gate().report, /^Project map: ok/m);
});

test('the builder role tells the builder to keep the Module map current', () => {
  const builder = read('factory/roles/builder.md');
  assert.match(builder, /Module map/);
  assert.match(builder, /adds? or moves?/i);
  assert.ok(existsSync(join(repo, 'factory/bin/init')));
});
