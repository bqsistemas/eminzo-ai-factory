# @eminzo/factory

The Eminzo software factory engine as a command, `eminzo`. A GitHub issue labelled `factory`
becomes a reviewed, gated pull request through Claude Code or Codex. The engine lives in this
package; a repository that uses it keeps only its own files.

Requires Node.js 20 or newer, `git`, the GitHub CLI (`gh`, signed in) and a GitHub repository.

## Install (once per machine)

```sh
npm i -g @eminzo/factory      # or a local package: npm i -g ./eminzo-factory-<version>.tgz
eminzo install                # Claude Code and Codex skill and agents in your home folder
eminzo doctor                 # checks node, git, gh, PATH and the installed files
```

`eminzo install` writes `~/.claude/skills/eminzo-factory/`, `~/.claude/agents/eminzo-*.md`,
`~/.agents/skills/eminzo-factory/` and `~/.codex/agents/eminzo-*.toml`, and records them in
`~/.eminzo/install.json`. It never overwrites a file it did not write or that you changed
(`--force` does); `--dry-run` only lists. `eminzo uninstall` removes what it wrote.
After updating the package (`npm update -g @eminzo/factory`), run `eminzo install` again: the
engine refuses to run with skill and agents from another version.

## Enable a repository (once per repository)

In Claude Code, on the default branch with a clean tree: `/eminzo-factory enable`
(Codex: `$eminzo-factory enable`; or `eminzo enable` in a terminal). It opens a pull request on
`chore/enable-factory` with:

```
factory/config.json      "engine" (this engine's minor, e.g. "0.1.x"), repo, base and the defaults
factory/checks.sh        the checks the gate runs, detected from the stack (review it)
factory/project.md       a first draft; /eminzo-factory setup completes it
.gitignore               factory/jobs/, factory/board.json, .worktrees/, factory/config.local.json
.claude/settings.json    allows Bash(eminzo:*)
```

Merge it, pull, then run `/eminzo-factory setup`: it creates the labels and completes
`factory/project.md`, which every agent reads.

## Day to day

The commands are the factory's usual ones: `/eminzo-factory run | issue <n> | rework <n> |
xs <request> | <feature> | approve-spec <n> | revise-spec <n> <notes>` (Codex: `$eminzo-factory ...`).
The skill and agents call the engine as `eminzo job`, `eminzo gate`, `eminzo approve` and so on;
it always works on the repository of the current directory (a job worktree resolves to its main
checkout), so one installed engine serves every repository.

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
lines) live in `cli/src/installer/`. The package is
`private` until its name and license are settled, so `npm publish` refuses it.
