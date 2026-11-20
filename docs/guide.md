# Eminzo user guide

Everything about installing Eminzo, enabling a repository, running jobs and every command, in detail. For the short version, see the [README](../README.md).

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
eminzo install --dry-run   # optional: lists what it would write and register
eminzo install
```

It writes the `eminzo-factory` skill, the `eminzo-product` skill (the product stage, see
[The product stage](product-stage.md)) and the eight
factory agents for both tools: `~/.claude/skills/eminzo-factory/`, `~/.claude/skills/eminzo-product/`,
`~/.claude/agents/eminzo-*.md`, `~/.agents/skills/eminzo-factory/`, `~/.agents/skills/eminzo-product/`
and `~/.codex/agents/eminzo-*.toml`, and records them in `~/.eminzo/install.json`. It never
overwrites a file it did not write or that you changed (it names each one; `--force` overwrites).

It also registers the `eminzo` MCP server (the factory's read-only tools, see
[eminzo mcp](mcp.md)) in both tools, with their own
commands: `claude mcp add --scope user eminzo -- eminzo mcp` and `codex mcp add eminzo -- eminzo mcp`. Only that
entry is added; the rest of `~/.claude.json` and `~/.codex/config.toml` is left as it was. An `eminzo` entry you set
up yourself is kept, a tool that is not installed is skipped with the command to run later, and `--no-mcp` skips
the registration. Before it changes anything, `install` lists what it puts on the machine, and every file and
entry it adds is printed.

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
  In an Nx or Turborepo workspace it checks only the projects a job changed and the ones that depend
  on them (it reads `FACTORY_BASE` and `FACTORY_HEAD`, see How a round runs). A repository that
  already has a `checks.sh` keeps it: `eminzo init checks` prints the affected-only script as a
  suggestion and never overwrites the file.
- `factory/config.json`:
  - `language` is `"es"` by default: the agents write their issue comments, specs and reviews in it.
    Use `"en"` (or `"pt"`) if your team works in another language.
  - `auto_merge` is `true` by default: the factory merges a pull request it approved. Set it to
    `false` to merge every pull request yourself.
  - `lessons.required` (`false`): when `true`, moving a job to `merging` is refused unless its `decision.md` has a `## Lessons` section (lines, or `None`). The default is `false` on purpose and is a pending human decision: turning it on by default means updating the protected job test fixtures, which write a `decision.md` without `## Lessons`.
  - `concurrency` (3 jobs at a time), `max_rounds` (3 build rounds per job), `checks.max_runs_per_round` (6 manual nudge runs per round; an invalid value falls back to 6), `checks.suite_commands` (a list of full-suite command strings, for example `"node --test test/*.test.js"`: the builder's Bash hook `guard-tests` refuses them, with every plain command line of `factory/checks.sh`, `factory/checks.sh` itself and the nudge, because the full suite runs only in the gate; the same command followed by a file or directory is targeted and allowed; Claude only, Codex has no hooks; not a `config.local.json` key), `checks.prepare` (the command `eminzo base` runs in `.worktrees/.base` to install the dependencies before the checks; by default the one the lockfile names, `""` turns it off), `checks.base_timeout_minutes` (how long `eminzo base` lets `factory/checks.sh` run before it kills it and answers UNKNOWN; 30), `selfcheck.ac_pattern` (regex that finds an `AC-n` in the test lines a branch adds; default `AC-\d+`, Python `(?:AC-|test_ac_)\d+`; `job <id> selfcheck` uses it), `spec_review` (off) and the
    models per risk level can stay as they are to start.
  - Before `STATUS: READY` the builder runs `selfcheck`: it fails when an `AC-n` has no test, a protected test changed or something is uncommitted (a Module map that misses new modules is only a warning, as in the gate). The Claude builder also has a `PreToolUse` hook (`protect-tests`) that denies Edit/Write/MultiEdit/NotebookEdit on protected tests and on the main checkout (except the job's `build.md`/`plan.md`). Bash is out of scope and the gate is the backstop. With the installed CLI, a stale or partial install makes `eminzo` exit 1, which Claude treats as non-blocking: that protection is off until you run `eminzo install`.

Merge the pull request, then `git pull` on your default branch.

### 8. Run setup (once per repository)

In Claude Code, inside the repository:

```
/eminzo-factory setup
```

It creates the GitHub labels (`factory`, `factory:needs-info`, `factory:needs-human`,
`factory:xs`, `factory:spec-review`, `factory:base-fix`) and analyzes the repository to complete `factory/project.md`:
what the product does, stack, commands, module map and conventions. Every agent reads this file
before working, and every other factory command refuses until setup has run. Setup starts no job.

Setup also checks the base branch once (`eminzo base`: it installs the dependencies in `.worktrees/.base` and runs `factory/checks.sh` there, so it can take as long as a gate). On `PASS` it says so. On `FAIL` it names the failing command and the report, and asks you whether to create the issue that fixes it (`eminzo base fix-issue`, labels `factory` and `factory:base-fix`); it creates nothing until you say yes. On `UNKNOWN` (the checks could not run) it says why and goes on: a check that could not run never blocks setup and never holds a job.

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
(`concurrency`, `language`, `max_rounds` lower, `auto_merge` off, `run_mode` own, `spec_review`, `default_provider`, `discovery`)
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

`eminzo uninstall` removes only the files `eminzo install` wrote (files you changed are kept) and the `eminzo` MCP entries it registered (one you added yourself is kept), and
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
| `eminzo base` | does the repo's `factory/checks.sh` pass on the tip of the base branch? Runs in the reused worktree `.worktrees/.base`: fetches, checks out the tip, runs the prepare step (installs the dependencies; `checks.prepare` in `config.json` overrides it, `""` turns it off) and the checks. Prints `base: PASS <sha>`, `base: FAIL <sha>: <command>` or `base: UNKNOWN <sha>: <reason>` and `report: factory/jobs/.base/<key>/checks.md`; exit 0, 1 or 3. UNKNOWN means it could not run (install failed, git error, exit 126 or 127, a signal, a busy lock): it is never a failure and nothing waits for it. The last answer is in `factory/jobs/.base/state.json`. The check runs without the machine's `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or the factory's own variables (registry tokens such as `NPM_TOKEN` stay), stops `checks.sh` after `checks.base_timeout_minutes` (30) with SIGKILL (only the direct process: a grandchild that ignores it can outlive it), and reuses a FAIL for an hour at most. A lock is taken over when its process is gone, when it is older than the prepare and checks timeouts plus ten minutes (a reused pid), or, if it is empty, after a minute. `eminzo base fix-issue` (only after a FAIL of the current tip) finds the one open `factory:base-fix` issue or creates it with the labels `factory` and `factory:base-fix`, in the repository's language: `fix: #<n> created` or `fix: #<n> open`. The issue holds the base sha, the failing command and its exit code, and how to reproduce it, never log lines. The public command comes from an allowlist and shows only what can be checked: a known check tool (`pnpm`, `go`, `cargo`...), known verbs (`run`, `test`, `lint`...), after `run` of npm, pnpm, yarn or bun a script name only when the base's `package.json` defines it, after `exec` or `npx` only one of nx, turbo, tsc, eslint, jest, vitest, prettier or biome, and after `run` of any other tool no free word; at most three words, `…` for the rest (`pnpm run lint`, `pnpm exec nx …`). A command whose program is not on the list is not shown and the issue says `factory/checks.sh exited <code>`, because a trace shows the command after the shell expanded it, so no filter can promise to catch every secret; this one shows only known words. The full command stays in the local report. A second issue created by a racing machine is closed as `Duplicate of #n` |
| `eminzo init checks` | writes `factory/checks.sh` when it is missing; when it exists in an Nx or Turborepo repo that checks every project, prints the affected-only script as a `suggestion:` and leaves the file byte-identical |
| `eminzo dashboard [port]` | serves the dashboard of the current repository (default port 8000) |
| `eminzo job summary` | one line per job (issue, stage, cost, time) and the total |
| `eminzo job lessons [--last N]` | collects the `## Lessons` of the last N job decisions (default 20), drops duplicates (case and punctuation ignored), writes the 15 most repeated into `## Things the builder gets wrong` of `factory/project.md` on a branch and opens a PR for a human to merge; the PR touches only `project.md` |
| `eminzo job metrics [--last N] [--json]` | over the last N jobs (default 20): the `GATE: PASS` rate in round 1 and rounds per job (median), both over finished jobs only (`merged` or `rejected`), the `CHANGES` rate per lens, minutes per kind of work (from `time_by_kind` when a job has it) and repeated lessons; `--json` prints the same as JSON. The dashboard shows it as a collapsible table (`board.json` carries it as `metrics`) |
| `eminzo job metrics delivery [--days <n> \| --from <date>] [--to <date>] [--weeks <n>] [--json]` | the delivery metrics (DORA), cost and work in progress of a period, from the jobs on this machine only (never GitHub): deployments per week, change lead time, failures caused by a broken base branch and their recovery, change fail rate, rework rate, first-pass rate, cost (jobs without cost data are counted apart, never as 0) and the jobs in progress now. The period is the last 30 days by default (`--days` 1 to 365, or `--from` and `--to`, a date alone meaning the whole local day), with the period before it and `--weeks` weekly blocks (default 4, 0 to 12). `--json` prints one line of JSON (schema 1); without it, a short summary. Invalid arguments exit 2. Ask Eminzo reads the same numbers with the `delivery_metrics` tool |
| `eminzo job <id> base [--fresh]` | after a failed gate: does the base fail the same checks (for the job's own scope)? Prints `own: <reason>` (the job's failure: back to the builder) or `wait: main is broken (#n)` (the job is held at `gate`, with the fix issue; no builder, no round); exit 0. `to build` and `promote` refuse a real gate failure it has not answered. A `factory:base-fix` job is never held. When the base passes again, for a job that was held, it merges the base into the job's branch (in its own worktree), pushes the branch and re-runs the gate: `resumed: GATE: PASS` (go to review), `resumed: GATE: FAIL` (the job's own failure) or `needs-human: <note>` (conflict or failed push) |
| `eminzo job config [<key>]` | the effective configuration, and whether each key comes from `config.json` or `config.local.json` |
| `eminzo profile <job-id>` | where the builder's time went in a job (checks, waits, git, other) from its Claude transcripts; stored in `job.json` and shown on the dashboard's build stage. A repository adds its own check commands in `config.json` `profile.patterns` (`{ "check": ["run e2e"] }`) |
| `eminzo selfcheck <job-id>` | what the builder runs before `STATUS: READY`: every `AC-n` has a test in the diff, `plan.md` exists with its four sections, no protected test changed and nothing is uncommitted (a stale Module map is only a warning); exits 1 and names each problem, or prints `selfcheck: ok` |
| `eminzo nudge <job-id> [--full]` | a manual command (no agent runs it; the full checks run only in the gate): runs the repository's `factory/checks.sh` for a job: focused by default (only what the change touches, when `checks.sh` reads `FACTORY_CHECK_MODE`; see How a round runs), `--full` runs everything; the gate and the merge run the job's scope (`FACTORY_BASE`, `FACTORY_HEAD`), which is everything for a `checks.sh` that ignores them |
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
| `factory:base-fix` | the issue that fixes the failing checks of the base branch; `eminzo base fix-issue` creates it (with `factory`) or reuses the open one, and its text never holds log lines |

## Use it with a committed engine (this repository)

One-time setup, from the main checkout on `main`:

```sh
gh auth login                    # gh must be logged in
sh factory/checks.sh             # the repo's checks should pass on main (setup checks it too: eminzo base)
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
this feature has no `factory:spec-review` label yet. Setup creates or updates every label (the
factory's and Ask Eminzo's): run it again after an update, or let the desktop do it. The old
`factory/bin/setup-spec-review` still works and creates only that label.

### Run mode and issue claims

Several developers can run the factory on one shared repo; each one processes only the
issues they chose. `run_mode` in `factory/config.json` decides what `run` does:

- `own` (the default when `run_mode` is missing): `run` takes no new issue. It runs the PR
  checks and advances the jobs already in your `factory/jobs/`. A new issue enters only through
  `issue <n>`, `add <feature>` (Claude: `<feature>`) or `xs <request>`.
- `queue`: `run` also lists every open `factory` issue and starts a job for each, as before.

Any other value is refused (`factory/bin/job run-mode` prints the resolved mode). When upgrading,
set `"run_mode": "queue"` if you relied on `run` picking up new issues.

`factory/config.local.json` may set `"run_mode": "own"`. With team `queue`, that stops `run` from
taking the queue on your machine only. A local `"queue"` is refused: it would make your `run` claim
every open `factory` issue and take work from teammates who pick issues by hand. `job run-mode`
reads the team and local files together.

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
