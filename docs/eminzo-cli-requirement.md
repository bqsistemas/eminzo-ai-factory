# Requirement: ship the Eminzo factory engine as a CLI (`eminzo`)

* **Author:** Jhon Barrantes
* **Date:** 2026-11-08
* **Status:** slices 1, 2, 3 (pin, no artifact recording), 5 and 6 implemented on branch `feat/eminzo-cli-engine-paths` (see "Implementation status"); 4, 7, 8 (publish) and 9 pending
* **Background:** `docs/factory-plugin-packaging.md` (section "Decisión actual")

## Epic

### User story

As a **developer who wants to use the Eminzo factory in my own repos**,
I want to **install the factory once on my machine with `npm i -g @eminzo/factory` and `eminzo install`, and enable it in a repo with `/eminzo-factory enable`**,
so that **my repo only holds my own config, checks and project context (no factory engine code), and I keep using the same `/eminzo-factory ...` commands in Claude Code and `$eminzo-factory ...` in Codex**.

As a **team using the factory on a shared repo**,
I want **the repo to pin the engine version it runs with**,
so that **every developer's jobs are judged by the same rules, as they are today when the engine is committed in the repo**.

### Why

- Today the engine (`factory/lib`, `factory/bin`, `factory/roles`, skills, 16 agent wrappers) is copied into every repo, and the only good installer is the Eminzo desktop app (the kit).
- The engine has no version of its own; uniformity across a team comes only from it being committed.
- `docs/factory-efficiency-plan.md:872-873` already lists "separate the engine from this app", "versions" and "`factory init`" as pending.

## Approach: a packaging folder, not a move

The CLI is a **product built from this repo**, the same way `desktop/scripts/build-kit.mjs` builds the desktop kit today.

```
factory/            source of the engine; this repo keeps running its factory from here, as today
cli/                NEW: the npm package
  package.json      @eminzo/factory, "bin": { "eminzo": "bin/eminzo.js" }
  build.mjs         copies the engine (same file list as the kit: listBundleFiles) into cli/dist/
                    and generates the Claude and Codex adapters from the repo's skills, agents and roles
  bin/eminzo.js     entry point: dispatches to dist/lib/<command>.js
  src/              commands that exist only in the CLI: install, uninstall, doctor, enable, upgrade, config show
  dist/             generated, gitignored, published to npm
```

Rules:

- **This repo is never migrated to the CLI.** It stays the engine's source, with `factory/bin/*` and the in-repo skills and agents. The CLI is tested by installing it in a temporary repo.
- `factory/lib` changes only where the engine builds paths to **its own files** from the repo root (listed in slice 1). Each of those changes keeps the in-repo behaviour identical; the existing tests prove it.
- The prompt rewrite (`factory/bin/job` to `eminzo job`, "Read `factory/roles/x.md`" to the embedded role) happens in `cli/build.mjs` on the copies, never in the source files.

### How a session finds the repo

The engine is installed once; the data is per repo. `factoryRoot()` (`factory/lib/util.js:35`) resolves the repo from the current directory with `git rev-parse --git-common-dir`, so `eminzo` always works on the repo where the Claude Code or Codex session is open, and resolves the main checkout when it runs inside a job worktree (`.worktrees/<id>`). Jobs, board, config, checks and worktrees stay in that repo. Two sessions on two repos run two independent factories with the same installed engine.

### Target result

Once per machine:

```sh
npm i -g @eminzo/factory
eminzo install
```

Once per repo, in Claude Code: `/eminzo-factory enable`, merge the PR, then `/eminzo-factory setup`.

Day to day: `/eminzo-factory run | issue <n> | add <feature> | xs <request> | rework <n> | approve-spec <n> | revise-spec <n> <notes>` (Codex: `$eminzo-factory ...`), unchanged.

Client repo footprint after `enable`:

```
factory/config.json      only "engine", repo, base and values that differ from engine defaults
factory/checks.sh
factory/project.md       (first draft by the existing init logic, completed by setup)
.claude/settings.json    merged: allow Bash(eminzo:*)
.gitignore               merged: factory/jobs/, factory/board.json, factory/config.local.json, .worktrees/
```

The command is `enable`, not `init`, because `factory/bin/init` already exists and drafts `factory/project.md`; `enable` calls that logic.

### Constraints

- Node 20 or later, zero runtime dependencies (as today).
- Requires `git`, `gh` and POSIX `sh` (as today).
- This repo's factory keeps working after every slice; no slice removes `factory/bin`, the in-repo skills or agents.
- Generated adapters call the engine only through `eminzo <command>`.

### Prerequisite checks (manual, before slice 5)

Verify and record the answer in `docs/factory-plugin-packaging.md`:

1. Agents in `~/.claude/agents/` run their frontmatter `hooks: Stop:` (as repo agents do today).
2. A skill in `~/.claude/skills/` can spawn agents from `~/.claude/agents/` by name.
3. When a repo has `.claude/skills/eminzo-factory/` and the user has `~/.claude/skills/eminzo-factory/`, which one Claude Code uses (this repo has both once the CLI is installed on the same machine).
4. Codex: skills in `~/.agents/skills/` and agents in `~/.codex/agents/` are picked up in any repo, and user-level hooks work.
5. A command installed with `npm i -g` is on the PATH of the Bash tool in Claude Code and Codex, including inside a git worktree.

## Implementation status (2026-11-08)

Built and tested (`test/engine-location.test.js`, `test/cli-*.test.js`), and checked end to end with
`npm pack` + `npm i -g` into a temporary prefix: install, enable (pull request), engine commands,
setup labels, show, doctor.

| Slice | State |
|---|---|
| 1 engine finds its own files | done: `EMINZO_ENGINE`, `engineDir()`, `engineCommand()` |
| 2 `cli/` package and entry point | done: `cli/package.json`, `cli/build.mjs`, `cli/bin/eminzo.js`, `cli/src/main.js`, `engine.js`. A repo that commits its own engine runs it (no `EMINZO_ENGINE`) |
| 3 version pin | pin done (`cli/src/semver.js`, checked by `engine.js` and `doctor`); recording the version in `job.json` and artifacts is pending. The checks fingerprint already changes with any engine file |
| 4 defaults in the engine | pending: `enable` writes the full template config, plus `engine` |
| 5 adapters, install, doctor | done: `cli/src/adapters.js` (roles embedded, hooks call `eminzo`), `install.js` (`~/.eminzo/install.json`), `doctor.js`; prerequisite checks 1-5 still to confirm by hand in a real Claude Code and Codex session |
| 6 `enable` | done: `cli/src/enable.js` reuses the desktop preflight, stack detection and `.gitignore` lines; command named `enable` because `init` already drafts `project.md` |
| 7 `upgrade` | pending |
| 8 publish | pending: package is `private` until name and license are decided |
| 9 desktop on top of the CLI | pending; also: `repo.js` shows "setup required" only with a kit manifest, and `board.json` carries no engine version for the dashboard |

## Slices

Each slice is one factory issue, in this order.

### Slice 1: engine finds its own files from its location

Today these places build an engine path from the repo root, which fails once the engine is installed elsewhere:

| Place | Today | Change |
|---|---|---|
| `factory/lib/gate.js:44` | runs `<repo>/factory/bin/visual` | run the visual script next to the engine |
| `factory/lib/check-stamp.js:35` | hashes `<repo>/factory/lib` and `<repo>/factory/bin` | hash the engine files where the engine runs from |
| `factory/lib/dashboard.js:90` | serves `<repo>/factory/` (assets and `board.json` together) | serve `dashboard.html`/`dashboard.js` from the engine and `board.json`, jobs from the repo |
| refusal hints in `job.js` (e.g. `:568`, `:722`, `:1124`), `approve.js:123` | text says `factory/bin/job ...` | one function returns the command prefix (`factory/bin/job` in-repo, `eminzo job` from the CLI) |

- The mode is explicit: the CLI entry point sets `EMINZO_ENGINE` to its engine folder. Without it (this repo, kit installs, every test fixture) every path and message is exactly as before. A file-based guess ("the repo has `factory/lib`") was rejected: test fixtures write a fake `factory/bin/visual` without `lib/`.
- `util.js`: `installedEngine()`, `engineDir(root)` (installed engine or `<root>/factory`) and `engineCommand(name)` (`eminzo <name>` or `factory/bin/<name>`). Repo data keeps using `factoryRoot()`.
- Status: implemented on branch `feat/eminzo-cli-engine-paths` (`test/engine-location.test.js`).

Acceptance criteria:

1. In this repo every command, message and artifact is unchanged; the existing test suite passes.
2. With the engine files copied to a directory outside a test repo and run from there, `gate` finds the visual script, `check-stamp` hashes the copied files, and the dashboard serves its assets from the copy and `board.json` from the repo.
3. A test fails if a `factory/lib` file joins the repo root with `factory/bin`, `factory/lib`, `factory/roles` or `factory/templates`.
4. Refusal hints name `eminzo job` when the engine runs from outside the repo.

### Slice 2: `cli/` package and `eminzo` entry point

- `cli/package.json` (`@eminzo/factory`, `bin`, `engines.node >= 20`, version).
- `cli/build.mjs` copies the engine into `cli/dist/` using the kit's file list (`desktop/src/main/features/install/kit.js` `listBundleFiles`), so the kit and the CLI ship the same engine.
- `eminzo <command>` dispatches to `job`, `gate`, `approve`, `route`, `visual`, `nudge`, `ensure-output`, `dashboard`, `setup`, `setup-spec-review`, `init`; `eminzo --version` prints the package version. `setup`, `setup-spec-review` and `init` are required: `/eminzo-factory setup` creates the labels and drafts `factory/project.md`, which every agent reads.
- The entry point sets `EMINZO_ENGINE` to `dist/factory` before running a command.
- `cli/dist/` is gitignored.

Acceptance criteria:

1. `node cli/build.mjs` then `node cli/bin/eminzo.js --version` prints the version.
2. In a temporary repo with a full `factory/config.json` and `checks.sh`, `eminzo job new ...` and `eminzo job <id> status` give the same result as `factory/bin/job` in this repo.
3. `eminzo job ...` in a repo without `factory/config.json` exits non-zero with: `no factory in this repo; run /eminzo-factory enable`.
4. Run from a job worktree, `eminzo` resolves the repo's main checkout.
5. The files the build copies match the kit's list (a test compares them).

### Slice 3: engine version pin and recording

- New key `engine` in `factory/config.json`: a semver range, e.g. `"0.4.x"`.
- When run from the CLI, every command except `--version`, `doctor`, `install`, `enable` checks the running version against it. The in-repo engine reports version `source` and skips the check.
- The engine version (or `source`) is written to `job.json`, `round-N/checks.md`, `decision.md` and `merge-checks.md`; `check-stamp` includes it.

Acceptance criteria:

1. With `"engine": "0.4.x"` and CLI `0.5.0`, `eminzo job ...` is refused with `engine 0.5.0 does not satisfy "0.4.x" in factory/config.json`.
2. With a matching range, commands run as before; a missing key is accepted with a warning naming the running version.
3. `job.json` and each artifact above show the version that produced it; in this repo they show `source`.
4. A gate result produced by another engine version is not reused at merge.
5. The range parser supports `x.y.z`, `x.y.x`, `^x.y.z` and `>=x.y.z <a.b.c`; anything else is refused naming the key. No npm dependency.

### Slice 4: defaults in the engine, minimal `config.json`, `eminzo config show`

- `factory/lib/defaults.json` holds the defaults (models, routing, lanes, prices, visual, notifications, `spec_review: false`, `protected_tests: []`...), so the in-repo engine and the CLI share them.
- Effective config = defaults, then `factory/config.json`, then `factory/config.local.json` (today's `LOCAL_KEYS` rules).
- `config show` prints each effective key and its source.

Acceptance criteria:

1. A `factory/config.json` with only `engine`, `repo` and `base` runs a full job from the CLI.
2. `config.json` overrides a default; `config.local.json` overrides both, only for the allowed keys.
3. `eminzo config show` (and `factory/bin/job config` in this repo) lists every key with its source (`default`, `config.json`, `config.local.json`).
4. This repo's full `factory/config.json` works unchanged.

### Slice 5: generated adapters, `eminzo install`, `doctor`, `uninstall`

- `cli/build.mjs` generates, from this repo's skill, agents and `factory/roles/*.md`: the Claude skill and agents (`.md`) and the Codex skill and agents (`.toml`). Generated files call `eminzo <command>`, embed the role text, and carry the engine version.
- The generated skill, in a repo without `factory/config.json`, only answers that the factory is not enabled and suggests `/eminzo-factory enable`.
- `eminzo install` writes them to `~/.claude/skills/eminzo-factory/`, `~/.claude/agents/`, `~/.agents/skills/eminzo-factory/`, `~/.codex/agents/`.
- `eminzo doctor` checks Node, `git`, `gh` login, installed adapters and their version, and (inside a repo) the `engine` range.

Acceptance criteria:

1. `eminzo install` creates the four locations; a second run changes nothing; `--dry-run` lists files without writing.
2. A file there that `install` did not write, or that the user changed, is kept unless `--force`; each skipped file is named.
3. `eminzo job ...` is refused when the installed adapters' version differs from the engine's, with a message to run `eminzo install`.
4. Generated skills contain no `factory/bin/` or `factory/roles/` path; the parity tests run on generated output too.
5. `doctor` exits 0 when everything matches and lists each failing check otherwise; `uninstall` removes only files `install` wrote.
6. The in-repo skill and agents of this repo are not changed by the build.

### Slice 6: `eminzo enable` and `/eminzo-factory enable`

- Preflight (as `desktop/src/main/features/install/*` today): clean tree, default branch, GitHub origin, `gh` logged in, Node 20+.
- Writes the footprint; `checks.sh` generated per stack (port `plan.js`); `config.json` with `engine` = current minor (`"<major>.<minor>.x"`), `repo`, `base`, `language`; drafts `project.md` with the `init` logic.
- Merges `.gitignore` and `.claude/settings.json` without removing entries; commits on `chore/enable-factory`, pushes, opens a PR.

Acceptance criteria:

1. In a fresh repo, `eminzo enable` creates exactly the footprint and opens one PR; no engine file is written to the repo.
2. Existing `.gitignore` and `.claude/settings.json` keep all entries; factory entries are added once.
3. A repo with `factory/config.json` is refused: `factory already enabled; use eminzo upgrade`.
4. A failed preflight check stops before writing, naming the check.
5. `enable` is documented in both skills, the README and the desktop command tips.

### Slice 7: `eminzo upgrade`

- CLI-enabled repo: raises the `engine` range, runs config migrations (port `config-merge.js`, `migrations.js`), lists engine defaults that changed between the two versions.
- Kit-installed repo (desktop): removes the engine files listed in `factory/.manifest.json` that are unchanged, adds `engine`, opens a PR. Never runs on a repo that is the engine's source (has `cli/package.json`).

Acceptance criteria:

1. A kit-installed test repo ends with only the footprint plus its jobs; modified engine files are kept and named in the PR body.
2. `upgrade` refuses while any job is active (as `active-jobs.js`).
3. Changed defaults are listed with old and new values; `--keep-defaults` writes the old values into `factory/config.json`.
4. Run in this repo, `upgrade` refuses: `this is the engine source repo`.

### Slice 8: publish

- `files` allowlist: `bin/`, `dist/`, README, license. The build and the engine tests run before publish.

Acceptance criteria:

1. `npm pack` contains no repo-specific files (`src/`, `desktop/`, `docs/`, `factory/jobs/`, this repo's `config.json`).
2. `npm i -g ./eminzo-factory-<version>.tgz`, `eminzo install` and `eminzo enable` work in an empty test repo, and a job runs there end to end.

### Slice 9 (later): Eminzo desktop on top of the CLI

- Install and update call `eminzo enable` and `eminzo upgrade` (CLI bundled in the app) instead of copying the kit.
- Repo detection uses `factory/config.json` and its `engine` key.

## Out of scope

- A Claude Code plugin (optional channel later, on top of the same CLI).
- Migrating this repo to the CLI.
- Hiding or obfuscating engine code.
- Corporate policy from the SaaS.
- Hosts other than GitHub.

## Open questions

- Package name and npm scope availability (`@eminzo/factory`).
- License for the published package.
- Whether the factory's own `DEFAULT_DENY` (`factory/lib/diff.js:14`) should, in CLI-enabled repos, also protect `factory/config.json` and `checks.sh` from the builder (today they are protected through the paths of the in-repo engine).
