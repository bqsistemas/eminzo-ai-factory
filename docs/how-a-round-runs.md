# How a round runs

What a builder, its reviewers and the approver do in one round, and what each leaves behind. Back to the [README](../README.md).

### Checks: focused and full

The full checks run only in the gate, once per gate attempt (a failed gate is retried within the job's total budget, see below). The builder runs only the test files it wrote or changed and never `factory/checks.sh`, the nudge or the whole suite; when the gate fails, the builder is resumed with its log. `nudge` stays as a manual command a person can run.

On Claude this is enforced: the builder has a `PreToolUse` hook on `Bash` (`guard-tests`) that refuses `factory/checks.sh`, the nudge and the commands listed in `checks.suite_commands` in `factory/config.json` (nothing is guessed from `checks.sh`, so `npm run lint` or `go vet ./...` stay allowed; with no list only `checks.sh` and the nudge are refused, silently). A listed command followed by a non-option argument (a path, a package, a test name) or by a test-selection option (`-k`, `--tests`, `-Dtest`, `-run`, `-t`, `--grep`, ...) is targeted and passes; followed only by other flags (`go test -race ./...`, `npm test -- --coverage`) it is still the full suite. Cheap wrappers (`time`, `nohup`, `command`, `exec`, `env`, `timeout`, a trailing `&`, `bash -lc "..."`) do not hide it. Heredoc bodies (`git commit -F - <<EOF ... EOF`) are data, not commands, and flag order does not matter for a command with several plain words (`mvn test` matches a listed `mvn -B -q test`). Grouping (`(cd x; npm test)`, `{ npm test; }`) is looked through.

Known limits, because the hook is best effort and fails open: backquotes and command substitution inside an argument are not inspected, and an option that takes a value (`--reporter dot`, `-p no:cacheprovider`) counts as a flag followed by a plain word, so the command reads as targeted. The gate still runs the full checks either way.

`eminzo setup` (`factory/bin/init`) and `eminzo enable` write `checks.suite_commands` with the `checks.sh` they generate, from the same stack table as the script (for example `npm test`, `go test ./...`, `python -m pytest`, `cargo test`, `mvn -B -q test`, `./gradlew test`, `bundle exec rspec` and `bundle exec rake test`, or the `run-many` / `turbo run` command of an Nx or Turborepo workspace). They never overwrite an existing value and never touch a hand-written `checks.sh`. A repository installed before this change adds the line by hand, for example `"checks": { "suite_commands": ["npm test"] }`,. Setup only fills the key when it generates `checks.sh`. For a `checks.sh` that already exists, `factory/bin/init checks` (and setup) prints a `suggestion: add "suite_commands": ["npm test"] to "checks" in factory/config.json ...` when the file contains a known full-run test command and the key is missing; it writes neither file, and the team adds the line. This repository already has it. The hook fails open (it prints `guard-tests: not enforced: <why>` and allows) when it cannot decide. Codex has no hooks, so the role text is its only guard.

The engine runs your `factory/checks.sh` with these variables:

| Variable | Value |
|---|---|
| `FACTORY_CHECK_MODE` | `focused` for a manual `nudge <id>`; `full` for `nudge <id> --full`, the gate and the merge |
| `FACTORY_CHANGED_FILES` | in focused mode, a file with one changed path per line (against the merge-base with the job's base) |
| `FACTORY_BASE` | the commit the job's branch left the base at (the merge-base). Set for the gate, the merge and a focused manual `nudge <id>` (not for `--full`, which runs everything), so a `checks.sh` can check only the projects the job touched. Not set for a job that fixes the base (`factory:base-fix`) or when you run `checks.sh` by hand: then everything runs |
| `FACTORY_HEAD` | the commit under test: the tested head for the gate, the merge commit for the merge. Not set for the nudge, which also sees uncommitted files |

The gate report names the first one as `Checks base: <sha>|none`. Values already in the environment are dropped, and each variable is set only from a full commit sha.

- **Ignoring the variables is safe.** A `checks.sh` that ignores them runs everything, as before.
- **The template.** `setup` writes one per stack (`factory/templates/checks/<stack>.sh`: Node, Go, Python, Rust, Ruby, Maven, Gradle) that narrows only when that is reliable and otherwise runs everything. For an Nx or Turborepo workspace it writes `factory/templates/checks/node-affected.sh` instead: `nx affected` or `turbo run --filter=...[base]` over the `lint`, `typecheck` and `test` targets the repo has, using `FACTORY_BASE` and `FACTORY_HEAD`. `factory/bin/init checks` proposes it for an existing `checks.sh` and never overwrites it.
- **The safety net.** A focused pass is never reused by a full caller, and a focused nudge pass is reused only for the same merge-base (a full pass ran everything, so it needs no scope). The gate and the merge run the job's scope: everything for a `checks.sh` that ignores `FACTORY_BASE`, the affected projects for one that reads it.
- **One full run at a time per repository.** A full `checks.sh` already uses most of the cores, so the engine takes a lock (`factory/jobs/.checks.lock`, runtime state that git ignores) around every full run of the same repository: the gate, the merge gate, the base check (`eminzo base`) and a `nudge --full`. A job that reaches the gate while another full run is going waits its turn, says so on stderr (`the checks of this repository are running for gate <id> (since <time>); waiting for them to finish`) and then runs; that is not a hang. For a gate (`gate <id>` and the merge gate) the job's `note` says it too, so the dashboard and the desktop app show it: `waiting for the checks of this repository: gate <id> runs them since <hh:mm>`. The note is set when the wait starts and put back to what it was as soon as the lock is taken (or the wait runs out), before `checks.sh` starts; a gate that was killed while it waited leaves the note behind, and the next gate of that job clears it when it starts (no other note is touched); `eminzo base` and the nudge only write to stderr. `round-N/checks.md` gets a line `Waited for the checks lock: <time> (<holder>)`, and the time of the `Checks (full mode)` step does not include the wait. Focused runs never wait, and other repositories do not wait for this one. The lock only delays: a holder that is dead (or older than three hours) is taken over, a checks run started from inside the checks never waits for itself, and after 30 minutes of waiting (`FACTORY_CHECKS_LOCK_WAIT_MS`) the checks run anyway. `checks.lock` in `factory/config.json` is `"repo"` (default) or `"off"`; it is a team key, not a `config.local.json` key.
- **Cap.** At most `checks.max_runs_per_round` manual nudge runs per round (default 6). Past it the nudge exits 2 with `cap reached: write build.md with what is still failing`.
- **Flaky checks.** A check that fails and then passes with no code change goes to `build.md` `## Flaky` (`command | error`) instead of being fixed in the job.

### A failed gate does not burn a round

When the gate fails (and the base is not the cause, see below), `job <id> to build` keeps the round: `job.round` does not change and `max_rounds` is not used. The engine counts the retry in `job.gate_retries` and archives the failed run in the same round folder: `round-<n>/checks.md` becomes `gate-fail-<k>.md`, `checks.log` becomes `gate-fail-<k>.log`, `visual.md` becomes `gate-fail-<k>.visual.md`, and `build.md` becomes `build-gate-fail-<k>.md`, so the next `to gate` needs a fresh `build.md` and the next gate writes a fresh `checks.md`. `job <id> prompt` then has a `Gate failed: read round-<n>/gate-fail-<k>.md` line for the builder. `checks.max_gate_retries` (default 3) bounds the retries per job in total, across all its rounds; when they are used up `to build` is refused, naming the key and `to needs-human --note "gate failed <n> times"`. A human rework (`to build` from `needs-human` with a PR) starts a fresh budget. `max_rounds` counts only review rounds. Lane xs retries the gate the same way, inside the lane and within the same budget: a failed gate is not a promotion trigger (a review with `CHANGES`, a blocked builder, unsettled deviations and an inconclusive approver script still are), and when the retries are used up the xs job goes to `needs-human` like any job.

### When the base is red

A gate failure is the job's own unless the base branch fails the same checks. After a real `GATE: FAIL` the orchestrator runs `job <id> base`, which checks the tip of the base for the job's own scope (the files it changed, for a `checks.sh` that reads `FACTORY_BASE`) in `.worktrees/.base` and answers:

| Answer | Meaning | What happens |
|---|---|---|
| `own: <reason>` | the failure is the job's: the checks passed and something else failed, the base passes the same checks, the base could not be checked (`UNKNOWN`), or the job fixes the base | the job goes back to the builder, as always |
| `wait: main is broken (#n)` | the base fails the same checks | the job is **held**: it stays at `gate` with `base_wait` in `job.json` and the note `main is broken: waiting for #n`. No builder runs, no round is spent and no `concurrency` slot is used |

- **Only a real FAIL holds a job.** `UNKNOWN` (the install failed, git failed, exit 126 or 127, a signal, a busy lock) never does.
- **A failure is confirmed.** The first FAIL of a tip is run once more, fresh, before it holds a job or opens an issue: a flaky or one-off failure does neither. A FAIL that was confirmed is marked in the state and the next job that meets it does not run it again. A FAIL is also good for an hour at most (in the cache and for a held job, which is then checked again even if the tip did not move).
- **One fix issue per breakage.** The first hold finds the one open `factory:base-fix` issue or creates it (`eminzo base fix-issue` does the same by hand). If `gh` fails, the job still waits and the note says how to create the issue.
- **The fix job is exempt.** A job whose issue carries `factory:base-fix` (`job.json` `base_fix`) is checked on everything, never narrowed to its files, and never held.
- **No shortcut.** `job <id> to build` and `job <id> promote` refuse a real gate failure that `job <id> base` has not answered, and refuse a held job.
- **A held job in its last round waits** instead of escalating; when its PR is merged by hand, `to merged` ends the wait. Every wait is kept in `base_waits`.
- **Never a deadlock.** A job held at the gate is not "ahead" for `job <id> overlap`, so the job that fixes the base never waits for the job that waits for it.
- **Resume.** On every `run`, `job <id> base` is called again for each held job. A tip it already checked prints `wait:` at once; a new commit on the base is checked again (`--fresh` forces it).
  - Still red: the job keeps waiting (`wait: main is broken (#n)`), and its recorded commit moves to the new tip; no second issue is created. A check that could not run (`UNKNOWN`, or the tip cannot be read) does not release the job either: it stays held and is tried again on the next run.
  - Green, for a job that was held: the engine merges the base into the job's branch **in the job's own worktree** (the one `job.json` names, which must be `.worktrees/<id>` on `factory/<id>`), pushes the branch (never a force push, and never the base branch) and runs the gate again. `resumed: GATE: PASS` goes on to review. `resumed: GATE: FAIL` is the job's own failure now: it goes back to the builder through the normal path. A job that was never held is never merged or pushed by `base`: a green base only means the failure is its own (`own:`), and it goes back to the builder as before.
  - A merge that conflicts is not resolved by itself: the job goes to `needs-human` with the note `merge stopped at sync with <base>`, as the merge stage does. A failed push does the same.
  - The merge stage looks at it too: when its post-sync checks fail and the base fails them as well, the job still ends in `needs-human` (nothing waits during a merge), but the note says `main is broken (#n)` and a fix issue exists.
- **Where to look.** `job summary` shows `gate (waits for main, #n)`; Ask Eminzo lists the job as waiting with kind `fix-base`; the dashboard shows the note.

### The builder's plan and self-check

- **Plan.** Before its first code edit, the builder writes `factory/jobs/<id>/plan.md` (at most 30 lines) with four sections:
  - `## Files that change`
  - `## Order of work`
  - `## Risks`
  - `## Proof`: the test for each AC
- **Self-check.** Before `STATUS: READY` it runs `selfcheck` (see the command reference).
- **build.md across rounds.** `build.md` lives in the job folder while its round runs. When the job goes back to build for a review with `CHANGES` or a rework, the engine moves it to `round-<n>/build.md`, so the next builder reads its handoff (`## Notes for the next round`) there and the job never loses it. The dashboard lists it as `round-<n>/build.md`. After a failed gate the round does not change (see below): the file moves to `round-<n>/build-gate-fail-<k>.md`.
- **What review-code checks.** That the diff matches the plan, or that `build.md` explains why it does not.

### Review policy (optional)

- **The template.** `factory/bin/init review` (run by setup) writes a fully commented `factory/review.md`; it has no effect until a team edits it.
- **What it can set.** A cap on `[minor]` findings per lens, paths and kinds of findings not to report, and the repository's own checks. The four review lenses read the main checkout's copy.
- **What it can never hide.** A `[blocker]`, a security finding or a failed acceptance criterion.
- **Branch edits.** A branch that changes `factory/review.md` makes the script approver inconclusive, as a change to `checks.sh` or `config.json` does.
- **Proof for blockers.** Every `[blocker]` carries an indented `Proof:` line: the `path:line`, why it is wrong and how to reproduce it.
  - The approver lists each open blocker as proven or not proven for the human.
  - A lens with `CHANGES` is always an escalation.

### What you can read afterwards

- **One summary sentence.** Every artifact starts with its machine line (`ACCEPT`, `STATUS: READY`, `GATE: PASS`, `VERDICT: PASS`, `APPROVE`…), then one plain sentence, then short sections and tables.
- **checks.md.** It also has an `ENGINE: x.y.z` line, a table of steps and the last 60 lines of the log. The full log is `checks.log`, capped, in the job folder: it is never served by the dashboard or attached to a PR.
- **The Factory record.** The pull request description carries a section between `factory:record` markers with:
  - intake decision and risk;
  - the number of ACs;
  - the plan;
  - the gate result;
  - each lens's verdict;
  - the decision;
  - the engine version.

  The section ends with one hidden line, `<!-- factory:facts {...} -->`, holding the job's facts as JSON:
  lane, size, risk, surfaces, round, start time, time it entered approve, known cost and the approval decision. It carries no
  free text. `factory/jobs` stays on the machine that ran the job; this line is how the rest of the team,
  and Ask Eminzo's estimates, can learn from finished jobs (`factory/lib/record-facts.js` parses it).

  The engine updates only that section, and only when the PR is open.
- **The engine version.** `job.json` records `engine_version` when the job starts, at every round and when a failed gate goes back to build.
- **Lessons.** `decision.md` ends with `## Lessons`; `eminzo job lessons` turns repeated ones into a pull request for `factory/project.md`.
