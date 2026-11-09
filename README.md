# eminzo-ai-factory

The Eminzo AI software factory: one Claude Code skill (and its Codex adapter), eight
role-based subagents, a few dependency-free Node scripts, and markdown files. Any team
puts it in its own GitHub repository: label an issue `factory`, start it with
`/eminzo-factory issue <n>`, and it goes through intake, spec, build, a deterministic
gate, routed reviews and approval; `/eminzo-factory run` continues your jobs. It ends as a
merged PR, a PR waiting for you, a question on the issue, or a rejection.

Two ways to use it in a repository:

- **The `eminzo` CLI** (recommended): the engine is an npm package, and the repository keeps
  only its own `factory/config.json`, `checks.sh` and `project.md`. See
  "Getting started" below.
- **A committed engine**: the repository carries `factory/` and the adapters, as this
  repository does to build itself (the Eminzo desktop app installs it this way too).

```
issue (label: factory)
  → intake (fable)       ACCEPT | NEEDS-INFO | REJECT, risk + surfaces, posted on the issue
  → route (script)       reviewers + models from config.json
  → spec-writer (opus)   spec.md
  → builder              commits, pushes factory/<id>, opens a draft PR "Closes #<n>"
  → gate (script)        checks.sh + protected tests; FAIL → back to the builder
  → reviewers (routed)   code always; ui for ui (it covers UX); ux for a new interactive flow; security for security; WAIT FOR ALL
  → approver (opus)      APPROVE → sync, re-gate, gh pr merge | ESCALATE → you merge the PR
```

## Getting started: the factory in your repository

These steps take you from nothing to a first job running in your own repository. Steps 1 to 4 are
once per machine (every developer does them); steps 5 to 8 are once per repository (one person does
them); step 9 onwards is day to day. Your repository receives only its own factory files, never the
engine code.

### 1. Check the prerequisites

| You need | Check it with | Why |
|---|---|---|
| Node.js 20 or newer | `node -v` | the engine and the CLI run on Node |
| git | `git --version` | worktrees, branches and commits for every job |
| GitHub CLI, signed in | `gh auth status` (sign in with `gh auth login`) | issues, labels, pull requests and merges |
| Claude Code or Codex | `claude --version` or `codex --version` | the session that runs the factory |
| A GitHub repository you can push to, cloned on your machine | `git remote get-url origin` shows `github.com` | the factory works on GitHub issues and pull requests |

### 2. Install the CLI (once per machine)

When the package is on npm:

```sh
npm i -g @eminzo/factory
```

Until then, build it from this repository:

```sh
git clone https://github.com/bqsistemas/eminzo-ai-factory.git
cd eminzo-ai-factory
node cli/build.mjs                       # builds cli/dist/: the engine and the adapters
cd cli && npm pack                       # writes eminzo-factory-<version>.tgz
npm i -g ./eminzo-factory-<version>.tgz
```

Check it: `eminzo --version` prints the version. If the shell answers `eminzo: command not found`,
the folder where npm puts global commands is not on your PATH: `npm prefix -g` shows it, and its
`bin` folder must be on the PATH of the terminal where you start Claude Code or Codex (with nvm,
install it under the Node version that terminal uses).

### 3. Install the skill and agents (once per machine)

```sh
eminzo install --dry-run   # optional: lists what it would write
eminzo install
```

It writes the `eminzo-factory` skill and the eight factory agents for both tools:
`~/.claude/skills/eminzo-factory/`, `~/.claude/agents/eminzo-*.md`, `~/.agents/skills/eminzo-factory/`
and `~/.codex/agents/eminzo-*.toml`, and records them in `~/.eminzo/install.json`. It never
overwrites a file it did not write or that you changed (it names each one; `--force` overwrites).

Then close and reopen Claude Code (or Codex): a session loads its skills when it starts.

### 4. Check the machine

```sh
eminzo doctor
```

Every line should start with `ok`: `node`, `git`, `gh` (signed in), `eminzo on PATH` and `adapters`.
Each `FAIL` line says what to run. Inside a repository it also checks the repository (steps 6 to 8).

### 5. Prepare your repository

```sh
cd ~/code/your-repo
git switch main            # your default branch, whatever its name
git pull
git status                 # must print nothing to commit
```

Make sure your tests pass on the default branch: the factory runs them on every job.

### 6. Enable the factory (once per repository)

In Claude Code, inside the repository:

```
/eminzo-factory enable
```

(Codex: `$eminzo-factory enable`. In a plain terminal: `eminzo enable`, and `eminzo enable --dry-run`
lists the files first.) It checks the repository (clean tree, default branch, GitHub origin, gh signed
in, Node 20+) and opens a pull request from the branch `chore/enable-factory` with:

```
factory/config.json      "engine" (the engine version every developer runs, e.g. "0.1.x"), repo, base and settings
factory/checks.sh        the commands the gate runs on every job, detected from your stack
factory/project.md       a first draft; step 8 completes it
.gitignore               factory/jobs/, factory/board.json, .worktrees/, factory/config.local.json
.claude/settings.json    allows Bash(eminzo:*), so the factory's commands do not ask for permission
```

If a check fails it prints `FAIL <reason>` for each one and writes nothing. A `checks.sh` or
`project.md` your default branch already has is kept as it is.

### 7. Review and merge the enable pull request

Before merging, check two files:

- `factory/checks.sh`: the gate runs it inside every job's worktree, and only exit code 0 passes.
  It is detected from your stack (`npm`/`pnpm`/`yarn test`, `go test ./...`, `cargo test`,
  `python -m pytest`, `mvn test`, `./gradlew test`). When nothing was detected it is a placeholder that
  checks nothing: replace it with your test, lint and typecheck commands.
- `factory/config.json`:
  - `language` is `"es"` by default: the agents write their issue comments, specs and reviews in it.
    Use `"en"` (or `"pt"`) if your team works in another language.
  - `auto_merge` is `true` by default: the factory merges a pull request it approved. Set it to
    `false` to merge every pull request yourself.
  - `lessons.required` (`false`): when `true`, moving a job to `merging` is refused unless its `decision.md` has a `## Lessons` section (lines, or `None`). The default is `false` on purpose and is a pending human decision: turning it on by default means updating the protected job test fixtures, which write a `decision.md` without `## Lessons`.
  - `concurrency` (3 jobs at a time), `max_rounds` (3 build rounds per job), `checks.max_runs_per_round` (6 check runs per round; an invalid value falls back to 6), `selfcheck.ac_pattern` (regex that finds an `AC-n` in the test lines a branch adds; default `AC-\d+`, Python `(?:AC-|test_ac_)\d+`; `job <id> selfcheck` uses it), `spec_review` (off) and the
    models per risk level can stay as they are to start.
  - Before `STATUS: READY` the builder runs `selfcheck`: it fails when an `AC-n` has no test, a protected test changed or something is uncommitted (a Module map that misses new modules is only a warning, as in the gate). The Claude builder also has a `PreToolUse` hook (`protect-tests`) that denies Edit/Write/MultiEdit/NotebookEdit on protected tests and on the main checkout (except the job's `build.md`/`plan.md`). Bash is out of scope and the gate is the backstop. With the installed CLI, a stale or partial install makes `eminzo` exit 1, which Claude treats as non-blocking: that protection is off until you run `eminzo install`.

Merge the pull request, then `git pull` on your default branch.

### 8. Run setup (once per repository)

In Claude Code, inside the repository:

```
/eminzo-factory setup
```

It creates the five GitHub labels (`factory`, `factory:needs-info`, `factory:needs-human`,
`factory:xs`, `factory:spec-review`) and analyzes the repository to complete `factory/project.md`:
what the product does, stack, commands, module map and conventions. Every agent reads this file
before working, and every other factory command refuses until setup has run. Setup starts no job.

Read `factory/project.md`, fix anything wrong, and commit it so the whole team shares it:

```sh
git add factory/project.md
git commit -m "docs(factory): project context from setup"
git push                   # or open a pull request if your default branch is protected
```

`eminzo doctor` now shows `ok  setup` and `ok  engine range`.

### 9. Run your first job

1. Start it, in one of the ways in "Start an issue" below. The simplest: describe the change and
   let the factory open the issue and run it, `/eminzo-factory add a CSV export to the reports page`.
   Or open the issue yourself with the label `factory` and run `/eminzo-factory issue <n>`.
2. The factory posts its intake decision on the issue (accept, ask for information, or reject),
   writes a spec, and the builder implements it in `.worktrees/<id>` on the branch `factory/<id>`,
   opening a draft pull request that closes the issue. The gate runs `factory/checks.sh`, the routed
   reviewers review, and the approver decides: the pull request is merged (with `auto_merge`) or left
   for you with its reasoning as a comment.
3. Follow it with `eminzo dashboard` and open http://localhost:8000/dashboard.html (or in the Eminzo
   desktop app).
4. When a job needs you: merge its pull request to approve it, or leave review comments and run
   `/eminzo-factory rework <n>`. When the issue asks for information, answer on the issue and run
   `/eminzo-factory run`.

### 10. Day to day

Every command is listed in "Command reference" below. Personal settings that do not affect the team
(`concurrency`, `language`, `max_rounds` lower, `auto_merge` off, `spec_review`, `default_provider`)
go in `factory/config.local.json`, which is gitignored.

### Other developers of the same repository

Each one does steps 1 to 4 on their machine, pulls the default branch, and starts with step 9. The
repository is already enabled and set up. The `"engine"` range in `factory/config.json` makes every
developer run the same engine version, so every job is judged by the same rules.

### Updating eminzo

```sh
npm update -g @eminzo/factory      # or install the newer .tgz
eminzo install                      # the skill and agents of the new version
eminzo doctor
```

A new patch version inside the pinned range works right away. For a new minor version (for
example `0.2.x`), change `"engine"` in `factory/config.json` in a pull request; until then the
engine refuses with `engine 0.2.0 does not satisfy "0.1.x" in factory/config.json`.

### Removing it

`eminzo uninstall` removes only the files `eminzo install` wrote (files you changed are kept), and
`npm rm -g @eminzo/factory` removes the command. To remove the factory from a repository, delete
`factory/config.json`, `factory/checks.sh` and `factory/project.md`, the factory lines in
`.gitignore` and `Bash(eminzo:*)` in `.claude/settings.json`.

### Troubleshooting

| You see | Do this |
|---|---|
| `eminzo: command not found` | put npm's global `bin` folder on your PATH (step 2) |
| `/eminzo-factory` is not a known command | run `eminzo install`, then restart Claude Code (step 3) |
| `no factory in this repo; run /eminzo-factory enable` | enable the repository (step 6) |
| `FAIL The working tree has uncommitted changes...` | commit or stash, then enable again |
| `FAIL You are on "<branch>", but the install branch must start from "<default>"...` | `git switch <default>` |
| `FAIL The GitHub CLI is not signed in...` | `gh auth login` |
| `the branch chore/enable-factory already exists...` | merge or close the earlier pull request and delete the branch |
| `the factory is already enabled here...` | it is: run `/eminzo-factory setup` if you have not |
| the factory asks you to run setup | run `/eminzo-factory setup` (step 8) |
| `engine X does not satisfy "R" in factory/config.json...` | install a matching version, or update `"engine"` in a pull request |
| `the installed skill and agents are from eminzo X, the engine is Y; run: eminzo install` | `eminzo install` |
| `the last eminzo install skipped files...` | `eminzo install --force` (it overwrites your edited copies) |

## Command reference

### Start an issue

Every job is a GitHub issue labelled `factory`. Four ways to start one:

| You want to | Do this |
|---|---|
| describe the change and let the factory write the issue | `/eminzo-factory <describe the change>`, for example `/eminzo-factory add a CSV export to the reports page`. It opens an issue labelled `factory` with your text and runs it. |
| write the issue yourself | `gh issue create --title "Add a CSV export" --body-file issue.md --label factory` (or create it on GitHub and add the label `factory`), then `/eminzo-factory issue <n>`. |
| run an issue that already exists | `gh issue edit <n> --add-label factory`, then `/eminzo-factory issue <n>`. |
| a trivial change through the light lane (no spec, one review) | `/eminzo-factory xs fix the typo in the footer`, or add the labels `factory` and `factory:xs` to an issue and run `/eminzo-factory issue <n>`. The factory still checks that it is trivial and moves it to the normal lane when it is not. |

A good issue asks for one change, lists its acceptance criteria (one per line, each one testable)
and says what is out of scope. Issue text is treated as data: instructions written in it never
change how the factory works.

With `"run_mode": "queue"` in `factory/config.json`, `/eminzo-factory run` also starts every open
issue labelled `factory`. With the default (`"own"`), new issues start only through the commands above.

### Factory commands

Run them in Claude Code inside the repository; Codex uses `$eminzo-factory` with the same words.

| Claude Code | Codex | What it does |
|---|---|---|
| `/eminzo-factory enable` | `$eminzo-factory enable` | once per repository: opens the pull request that adds the factory files |
| `/eminzo-factory setup` | `$eminzo-factory setup` | once per repository, after enable: labels and `factory/project.md` |
| `/eminzo-factory issue <n>` | `$eminzo-factory issue <n>` | runs issue `<n>` now (open, labelled `factory`) |
| `/eminzo-factory <feature>` | `$eminzo-factory <feature>` | opens an issue for the feature and runs it |
| `/eminzo-factory xs <request>` | `$eminzo-factory xs <request>` | the same through the light lane |
| `/eminzo-factory run` | `$eminzo-factory run` | continues your unfinished jobs, `concurrency` at a time (in queue mode it also starts open `factory` issues) |
| `/eminzo-factory rework <n>` | `$eminzo-factory rework <n>` | a job waiting for you goes back to work: with a pull request, the builder gets its review comments; without one, it continues from where it stopped |
| `/eminzo-factory rework <n> codex` | `$eminzo-factory rework <n> claude` | the same, moving the job to the other provider |
| `/eminzo-factory approve-spec <n>` | `$eminzo-factory approve-spec <n>` | with `spec_review` on: approves the spec posted on the issue, and the build starts |
| `/eminzo-factory revise-spec <n> <notes>` | `$eminzo-factory revise-spec <n> <notes>` | with `spec_review` on: the spec writer rewrites the spec from your notes |

There is no command to approve a pull request: merge it on GitHub. To give feedback, leave review
comments and run `rework`. Only comments from the repository's owner, members and collaborators
reach the builder.

### Terminal commands

| Command | What it does |
|---|---|
| `eminzo install [--dry-run] [--force]` | installs the skill and agents for Claude Code and Codex in your home folder |
| `eminzo uninstall [--dry-run]` | removes what `install` wrote (files you changed are kept) |
| `eminzo doctor` | checks Node, git, gh, the PATH, the installed files and, inside a repository, its engine range and setup |
| `eminzo enable [--dry-run]` | the same as `/eminzo-factory enable`, from a terminal |
| `eminzo dashboard [port]` | serves the dashboard of the current repository (default port 8000) |
| `eminzo job summary` | one line per job (issue, stage, cost, time) and the total |
| `eminzo job lessons [--last N]` | collects the `## Lessons` of the last N job decisions (default 20), drops duplicates (case and punctuation ignored), writes the 15 most repeated into `## Things the builder gets wrong` of `factory/project.md` on a branch and opens a PR for a human to merge; the PR touches only `project.md` |
| `eminzo job config [<key>]` | the effective configuration, and whether each key comes from `config.json` or `config.local.json` |
| `eminzo show roles/<role>.md` | prints a role the agents follow (`intake`, `spec-writer`, `builder`, `review-code`, `review-ui`, `review-ux`, `review-security`, `approver`) |
| `eminzo --version`, `eminzo help` | the version, and every command |

The skill and the agents also call `eminzo job`, `eminzo gate`, `eminzo approve`, `eminzo route` and
the rest while a job runs; you do not need to run those yourself.

### Labels

| Label | Meaning |
|---|---|
| `factory` | the issue is work for the factory |
| `factory:xs` | asks for the light lane |
| `factory:needs-info` | the factory asked the issue author a question; answer on the issue, then `/eminzo-factory run` |
| `factory:needs-human` | the job needs you: merge its pull request, or comment and run `/eminzo-factory rework <n>` |
| `factory:spec-review` | the spec is posted on the issue and waits for `approve-spec` or `revise-spec` |

## Use it with a committed engine (this repository)

One-time setup, from the main checkout on `main`:

```sh
gh auth login                    # gh must be logged in
sh factory/checks.sh             # the repo's checks must pass on main
```

Then, in Claude Code (`$eminzo-factory ...` in Codex):

```sh
/eminzo-factory setup                   # required first: GitHub labels + LLM-analyzed factory/project.md
/eminzo-factory run                     # continues your local jobs, 3 at a time (drains the queue only with run_mode "queue")
/eminzo-factory issue 12                # one issue now
/eminzo-factory add a slugify utility   # opens a labeled issue, then runs it
/eminzo-factory xs fix the header typo   # asks for the light lane (the factory still checks the criteria)
/eminzo-factory rework 12               # a needs-human job goes back to the builder with the PR's review comments
/eminzo-factory approve-spec 12         # spec_review on: approve the spec posted on the issue, then build
/eminzo-factory revise-spec 12 split AC-2 in two   # spec_review on: the spec writer revises the spec from your notes
```

Every factory command except `setup` stops until `/eminzo-factory setup` (Claude Code) or `$eminzo-factory setup` (Codex) analyzes the repo and marks `factory/project.md` complete. In the Eminzo desktop app, the repository sections stay locked until then and the integrated terminal stays available for this step.

There is no PR approve command (`approve-spec` approves a spec before the build, not a PR). When a job needs you, its PR is ready for review with
the approver's reasoning as a comment: merge the PR to approve it, or leave review
comments and run `/eminzo-factory rework <issue>`. Only comments from the repo owner, members
and collaborators reach the builder. A job that stopped before it had a PR (for
example, a blocked spec) is resumed the same way, from the stage where it stopped. A
NEEDS-INFO issue waits for its author to reply on the issue; the next `/eminzo-factory run`
picks the reply up. A rejected issue should be closed.

### Optional spec review

`spec_review` in `factory/config.json` decides whether a job stops after its spec so you can
read it before a build is spent. The repo ships it off:

- `false` (the default, also when the key is missing) or `[]`: `spec → build` as before.
- `true`: every job stops at the `spec-review` stage.
- a list of risks, for example `["high"]` or `["medium", "high"]` (`low`, `medium`, `high`):
  only jobs of those risks stop.

Each developer can turn it on or off for themselves in the gitignored
`factory/config.local.json` (for example `{ "spec_review": ["high"] }`); the local value wins in
both directions, and `factory/bin/job config spec_review` prints the value and where it came from.
Lane xs jobs never stop.

When a job stops, the factory adds the `factory:spec-review` label to the issue and comments the
whole `spec.md` with its SHA-256. Then:

- `/eminzo-factory approve-spec <n>` (`$eminzo-factory approve-spec <n>` in Codex) records your `gh`
  user and the hash, and continues with the build. It is refused when `spec.md` no longer matches
  the posted hash.
- `/eminzo-factory revise-spec <n> <notes>` (`$eminzo-factory revise-spec <n> <notes>`) sends the
  job back to the spec writer with your notes; the revised spec is posted again with its new hash.

`run` never approves a spec: it reports `spec-review` jobs as waiting for you. A repo set up before
this feature needs `/eminzo-factory setup` (or `factory/bin/setup-spec-review`) once to create the
`factory:spec-review` label.

### Run mode and issue claims

Several developers can run the factory on one shared repo; each one processes only the
issues they chose. `run_mode` in `factory/config.json` decides what `run` does:

- `own` (the default when `run_mode` is missing): `run` takes no new issue. It runs the PR
  checks and advances the jobs already in your `factory/jobs/`. A new issue enters only through
  `issue <n>`, `add <feature>` (Claude: `<feature>`) or `xs <request>`.
- `queue`: `run` also lists every open `factory` issue and starts a job for each, as before.

Any other value is refused (`factory/bin/job run-mode` prints the resolved mode). When upgrading,
set `"run_mode": "queue"` if you relied on `run` picking up new issues.

`factory/bin/job new <n>` claims the issue when it creates the job (never for an existing
local job): it assigns the issue to the authenticated `gh` user with
`gh issue edit <n> --add-assignee @me`, and refuses with `#<n> is assigned to <login>` when
someone else is assigned, or `#<n> already has branch factory/<id> on <remote>` when that
branch exists on the remote of `base`. If a check or the assignment fails (for example, no
permission to assign), no job is created. This narrows, but does not remove, the race between
clones: there is no cross-clone lock. The same rules apply to Claude and Codex.

`/eminzo-factory run` ends with `factory/bin/job summary`: each job's issue, stage, cost and
time, and a total.

In Codex, invoke the repository skill with `$eminzo-factory`:

```text
$eminzo-factory run
$eminzo-factory issue 12
$eminzo-factory add a slugify utility
$eminzo-factory rework 12
$eminzo-factory approve-spec 12
$eminzo-factory revise-spec 12 split AC-2 in two
```

## Compatibilidad con Codex

La factory conserva una **spine portable** y ahora incluye un adaptador nativo
para Codex. Claude Code sigue usando `/eminzo-factory`; Codex usa `$eminzo-factory`. Ambos
leen y actualizan los mismos archivos de trabajo y ejecutan los mismos scripts
de transición.

La identidad instalada es `eminzo-factory`: los agentes viven bajo nombres
`eminzo-*` y las skills canónicas están en `.claude/skills/eminzo-factory` y
`.agents/skills/eminzo-factory`. El instalador empaqueta únicamente esas skills
canónicas; las skills `factory` heredadas que quedan en este repositorio no se copian
a los repos nuevos.

### Qué ya es portable

- `factory/lib/job.js`: estados, worktrees, transiciones, PRs y merge.
- `factory/lib/route.js`: reviewers por riesgo y superficie.
- `factory/lib/gate.js`: gate determinista y tests protegidos.
- `factory/bin/job`, `gate`, `route` y `setup`.
- GitHub como cola y frontera de confianza.
- `factory/jobs/<id>/job.json` y `factory/board.json` como estado compartido.

### Qué está acoplado a Claude Code

- `.claude/skills/eminzo-factory/SKILL.md` define `/eminzo-factory run`, `/eminzo-factory issue` y
  `/eminzo-factory rework`, además de la orquestación en background.
- `.claude/agents/eminzo-*.md` son envoltorios finos: frontmatter, herramientas, hooks y
  aliases de modelos de Claude (`opus`, `sonnet`, `haiku`, `fable`). El cuerpo de
  cada rol vive en `factory/roles/<rol>.md`, compartido con Codex.
- El builder usa un hook `Stop` de Claude.
- `factory/lib/util.js` busca transcripts en `~/.claude/projects`.
- `factory/lib/cost.js` interpreta JSONL de transcripts Claude.
- `factory/lib/nudge.js` interpreta el payload del hook de Claude.

### Implementación actual

- `.agents/skills/eminzo-factory/SKILL.md` implementa `$eminzo-factory run`, `$eminzo-factory issue`,
  `$eminzo-factory add` y `$eminzo-factory rework` reutilizando `factory/bin/job`, `gate` y
  `route`. No duplica la máquina de estados.
- `factory/config.json` conserva el routing Claude y agrega `providers.codex`.
  Un job Codex se crea con `factory/bin/job new <issue> --provider codex`; al
  pasar intake, el proveedor y los modelos resueltos quedan persistidos en
  `job.json`.
- `.codex/agents/*.toml` registra los ocho roles de la factory como subagentes
  Codex. Cada perfil referencia el cuerpo del rol en `factory/roles/` y
  conserva sus límites de lectura/escritura y protocolos de primera línea.
- Los reviewers se lanzan en paralelo y el adaptador espera todos los archivos
  antes de avanzar. El gate sigue siendo la autoridad determinista y los merges
  siguen pasando por `factory/bin/job`.
- Claude y Codex pueden reanudar el mismo `job.json`; no deben ejecutar el mismo
  job simultáneamente porque todavía no existe un lease entre procesos.

### Limitaciones conocidas y siguiente fase

- `factory/lib/cost.js` solo interpreta transcripts JSONL de Claude. Un job
  ejecutado desde Codex puede mostrar `$0.00` aunque su uso no haya sido medido;
  ese valor **no** debe interpretarse como costo verificado. La siguiente fase
  debe agregar un adaptador de usage por proveedor y mostrar `unknown` cuando no
  exista una fuente confiable.
- El routing Claude conserva aliases (`opus`, `sonnet`, `haiku`, `fable`). Codex
  usa los IDs configurados en `providers.codex` (`gpt-6-luna` y
  `gpt-6.1-sol`); su disponibilidad depende de la cuenta, plan y cliente, por
  lo que deben validarse antes de ejecutar una cola real.
- El hook `Stop` de `.claude/agents/eminzo-builder.md` sigue siendo específico de Claude.
  En Codex, el builder corre `factory/bin/nudge <id>` antes de escribir `STATUS: READY`,
  la skill corre `factory/bin/nudge <id>` antes de `job <id> to gate` y el gate
  explícito (`factory/bin/gate`) es la barrera obligatoria.
- No se agregó persistencia ni una migración a Agents API: GitHub, worktrees,
  scripts y artefactos de etapa siguen siendo la frontera compartida.

La compatibilidad está cubierta por `test/codex-factory.test.js` y
`test/codex-routing.test.js`, que verifican el skill, los ocho perfiles, el
routing por proveedor, la persistencia del modelo y la permanencia del
adaptador Claude.

Referencias oficiales: [skills de Codex](https://learn.chatgpt.com/docs/build-skills),
[subagentes y agentes personalizados](https://learn.chatgpt.com/docs/agent-configuration/subagents)
y [modo no interactivo](https://learn.chatgpt.com/docs/non-interactive-mode).

Watch it on the dashboard:

```sh
factory/bin/dashboard 8000
open http://localhost:8000/dashboard.html         # live board
open http://localhost:8000/dashboard.html?demo    # sample data
```

## Where things live

| Path | What it is |
|------|------------|
| `.claude/skills/eminzo-factory/SKILL.md` | The orchestrator: the pipeline, commands and stage steps. Edit this to change the factory. |
| `factory/roles/*.md` | The role bodies, shared by Claude and Codex: `intake`, `spec-writer`, `builder`, `review-{security,ux,ui,code}`, `approver`. |
| `.claude/agents/eminzo-*.md` | Thin Claude wrappers: frontmatter (tools, model, hooks) plus a pointer to `factory/roles/`. |
| `.agents/skills/eminzo-factory/SKILL.md` | Codex adapter for `$eminzo-factory`; reuses the Claude pipeline contract and shared scripts. |
| `.codex/agents/*.toml` | Codex profiles that map one-to-one to the eight existing factory roles. |
| `factory/config.json` | Concurrency, max rounds, the routing table, models, prices, protected tests, the repo URL. |
| `factory/checks.sh` | The repo's checks (here: `npm test`). The gate runs the main checkout's copy. |
| `factory/bin/job` | The only writer of `job.json` and `board.json`. Refuses illegal transitions and does the GitHub side effects. `job graph` prints the pipeline as JSON (read-only). |
| `factory/pipeline.json` | The pipeline graph (stages and transitions) for tools that draw it, generated by `factory/bin/job graph > factory/pipeline.json`. Regenerate it when transitions change; `test/pipeline-graph.test.js` fails when it drifts. |
| `factory/bin/gate` | Runs `checks.sh` in the job's worktree, fails on edits to protected tests, writes `round-N/checks.md`. |
| `factory/bin/route` | Prints the builder and reviewer models for a job's `intake.md`. |
| `factory/bin/approve` | The deterministic approver: `approve`, `escalate: <reason>` or `inconclusive: <reasons>` (then the LLM approver runs). |
| `factory/bin/nudge` | The builder's checks and Stop hook: runs `checks.sh` in the worktree and remembers a pass for the same files (`nudge.json`), so it never runs twice on one tree. Advisory; the gate always runs the checks itself. |
| `factory/bin/setup` | Creates the four GitHub labels; `/eminzo-factory setup` and `$eminzo-factory setup` run it. |
| `factory/bin/init` | Writes a first `factory/project.md` from the repo when it is missing; never overwrites. |
| `factory/bin/dashboard` | Serves the dashboard with Node (no dependencies), on loopback. |
| `factory/templates/project.md` | The `project.md` template: Snapshot, Stack, Commands, Module map, UI contract, Conventions. |
| `factory/lib/*.js` | The scripts' code (Node 20 ESM, no dependencies), imported by the tests. |
| `factory/project.md` | Language, test command, and conventions. Every agent reads it. |
| `factory/board.json` | Every `job.json`; the dashboard polls it. |
| `factory/jobs/<id>/` | `job.json`, `issue.md`, `intake.md`, `spec.md`, `build.md`, `round-N/checks.md`, `round-N/review-*.md`, `decision.md`, `merge-checks.md`. |
| `.worktrees/<id>/` | The job's git worktree on branch `factory/<id>`, from `origin/main`. Job IDs use the GitHub issue number; ports are allocated locally from the next available job sequence. |

`board.json`, `jobs/`, and `.worktrees/` are local runtime state and are gitignored.

## Rules the loop keeps

- GitHub issues are the queue. The `factory` label is the trust boundary: only
  people with triage or write access can add it, and `job new` re-checks it.
- Issue text reaches agents only as quoted data in `issue.md`, never as a prompt.
- Agents get context from files, not the conversation; each writes only its own file
  and replies with that file's first line.
- No reviewer runs before the gate passes. A round ends only when every routed review
  file exists (WAIT FOR ALL). The same named builder (`builder-<id>`) is resumed for
  each round, up to `max_rounds` (a gate failure uses a round).
- Push only `factory/*` branches, merge only with `gh pr merge` after syncing with
  `origin/main` and gating again, never deploy. One PR per issue.
- The approver escalates anything that needs human judgment: auth, payments, data
  migrations, secrets, new dependencies, or breaking changes.

## Discord pipeline notifications

Notifications are optional and disabled by default. In `factory/config.json`, select
only the events you want:

```json
"notifications": {
  "enabled": true,
  "events": ["job.started", "job.needs_human", "job.failed", "job.merged"]
}
```

Supply `FACTORY_DISCORD_WEBHOOK_URL` in the environment of the factory process,
using your local secret manager. Never put this bearer credential in configuration,
Git, issue text, job artifacts, or command-line arguments. The only accepted format is
`https://discord.com/api/webhooks/<numeric-id>/<token>` (also `discordapp.com`, the
`ptb.`/`canary.` hosts and an `/api/v<N>/` prefix; no query, fragment, credentials,
other host, or port). Missing/invalid URLs or unsupported event ids
skip delivery with a static `notifications: invalid_config` diagnostic, not the URL.
The default configuration is `{"enabled": false, "events": []}`; absent/disabled
configuration does not make requests. There is no interactive setup or Discord bot.

| Event | Meaning |
|---|---|
| `job.started` | A new job has been persisted (not an idempotent `new` call). |
| `stage.changed` | Any effective persisted stage change, including promotions and intermediate merging. |
| `job.needs_human` | The job enters `needs-human`. |
| `job.failed` | The job ends at `rejected`; gate/review retries are stage changes, not terminal failures. |
| `job.succeeded` | Successful terminal stage `merged`; alias of `job.merged`. |
| `job.merged` | The job reaches `merged`. |

Exactly one selected event is sent per change: a selected specific event takes
precedence over `stage.changed`; `job.merged` takes precedence over `job.succeeded`.
Messages contain the job id, issue number, job title, event, from/to stages, the
generated result (`succeeded` on `merged`, `failed` on `rejected`), the transition note,
GitHub issue/PR links when available, and the timestamp. Title and note are untrusted
free text: they are cut to one line of 200/300 characters, common credential shapes
(webhook and credential-bearing URLs, GitHub/OpenAI/Slack/AWS tokens, JWTs, private
keys, `Bearer ...`, `password=`/`token:`-style pairs, long opaque strings) are replaced
by `[redacted]`, and Markdown, masked links, autolinks and mentions are shown literally;
`allowed_mentions` is empty, so nobody is pinged. Redaction is best-effort: do not put
secrets in issue titles or `--note` text. Issue bodies, environment values, worktree
paths, costs and other job artifacts are never sent.
[Discord's webhook reference](https://github.com/discord/discord-api-docs/blob/main/developers/resources/webhook.mdx)
describes the JSON format used by this connector.

Delivery is **best-effort**, after persistence, independent of pipeline success.
Requests use a 1.5-second timeout and reject redirects. Static delivery diagnostics
(`sent`, `failed`, `timeout`, `rate_limited`) go to stderr, never response bodies or
exception details. No immediate automatic retry is attempted (including HTTP 429),
to avoid rate-limit storms and ambiguous timeout duplicates. Failed events may be
resubmitted to the dispatcher; successful deliveries and in-flight requests are
deduplicated per adapter and deterministic job/event/from/to/round id. The most
recent 512 successful ids are retained in memory only: separate CLI processes or
restarts may duplicate events, crashes can lose them, and there is no outbox or
guaranteed delivery. No new job/board fields or persistent delivery state are used.

Run focused tests without network access:
`node --test test/notifications.test.js test/discord-notifications.test.js`.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Jhon Barrantes.
