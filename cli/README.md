# @eminzo/factory

The Eminzo AI software factory as a command, `eminzo`. A GitHub issue labelled `factory` becomes a
reviewed, gated pull request through Claude Code or Codex: intake, spec, build, a deterministic gate,
routed reviews and approval. The engine lives in this package; a repository that uses it keeps only
its own files. Source: https://github.com/bqsistemas/eminzo-ai-factory

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
  - `concurrency` (3 jobs at a time), `max_rounds` (3 build rounds per job), `spec_review` (off) and the
    models per risk level can stay as they are to start.

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

## How it works

The skill and agents call the engine as `eminzo job`, `eminzo gate`, `eminzo approve` and so on. It
always works on the repository of the current directory (a job worktree resolves to its main
checkout), so one installed engine serves every repository. Jobs, the board, the configuration and
the worktrees stay in each repository.

## Version pin

`factory/config.json` `"engine"` is a range (`1.2.3`, `1.2.x`, `1.x`, `^1.2.3`, `~1.2.3`,
`>=1.2.3 <2.0.0`). An engine outside it refuses to run, so every developer of the repository judges
jobs with the same rules. A repository that commits its own engine (a desktop install, or the
engine's source repository) keeps running that engine; `eminzo` hands the command to it.

## Other commands

```
eminzo show roles/<role>.md | templates/<file>   print a role or template of the engine
eminzo dashboard [port]                          the dashboard for the current repository
eminzo --version | help
```

## Building the package (this repository)

```sh
node cli/build.mjs          # writes cli/dist/ (gitignored); npm pack runs it through prepack
cd cli && npm pack
```

`cli/dist/` holds the engine (this repo's `factory/` without its data or config) and the
generated adapters. The install modules `enable` uses (preflight, stack detection, `.gitignore`
lines) live in `cli/src/installer/`.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Jhon Barrantes.
