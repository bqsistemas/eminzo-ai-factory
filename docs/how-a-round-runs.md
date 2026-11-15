# How a round runs

What a builder, its reviewers and the approver do in one round, and what each leaves behind. Back to the [README](../README.md).

### Checks: focused and full

The engine runs your `factory/checks.sh` with these variables:

| Variable | Value |
|---|---|
| `FACTORY_CHECK_MODE` | `focused` for the builder's own `nudge <id>`; `full` for `nudge <id> --full`, the Claude Stop hook, the gate and the merge |
| `FACTORY_CHANGED_FILES` | in focused mode, a file with one changed path per line (against the merge-base with the job's base) |
| `FACTORY_BASE` | the commit the job's branch left the base at (the merge-base). Set for the gate, the merge and the nudge, so a `checks.sh` can check only the projects the job touched. Not set for a job that fixes the base (`factory:base-fix`) or when you run `checks.sh` by hand: then everything runs |
| `FACTORY_HEAD` | the commit under test: the tested head for the gate, the merge commit for the merge. Not set for the nudge, which also sees uncommitted files |

The gate report names the first one as `Checks base: <sha>|none`. Values already in the environment are dropped, and each variable is set only from a full commit sha.

- **Ignoring the variables is safe.** A `checks.sh` that ignores them runs everything, as before.
- **The template.** `setup` writes one per stack (`factory/templates/checks/<stack>.sh`: Node, Go, Python, Rust, Ruby, Maven, Gradle) that narrows only when that is reliable and otherwise runs everything. For an Nx or Turborepo workspace it writes `factory/templates/checks/node-affected.sh` instead: `nx affected` or `turbo run --filter=...[base]` over the `lint`, `typecheck` and `test` targets the repo has, using `FACTORY_BASE` and `FACTORY_HEAD`. `factory/bin/init checks` proposes it for an existing `checks.sh` and never overwrites it.
- **The safety net.** A focused pass is never reused by a full caller, and a nudge pass is reused only for the same merge-base. The gate and the merge run the job's scope: everything for a `checks.sh` that ignores `FACTORY_BASE`, the affected projects for one that reads it.
- **Cap.** At most `checks.max_runs_per_round` check runs per round (default 6). Past it the nudge exits 2 with `cap reached: write build.md with what is still failing`.
- **Flaky checks.** A check that fails and then passes with no code change goes to `build.md` `## Flaky` (`command | error`) instead of being fixed in the job.

### When the base is red

A gate failure is the job's own unless the base branch fails the same checks. After a real `GATE: FAIL` the orchestrator runs `job <id> base`, which checks the tip of the base for the job's own scope (the files it changed, for a `checks.sh` that reads `FACTORY_BASE`) in `.worktrees/.base` and answers:

| Answer | Meaning | What happens |
|---|---|---|
| `own: <reason>` | the failure is the job's: the checks passed and something else failed, the base passes the same checks, the base could not be checked (`UNKNOWN`), or the job fixes the base | the job goes back to the builder, as always |
| `wait: main is broken (#n)` | the base fails the same checks | the job is **held**: it stays at `gate` with `base_wait` in `job.json` and the note `main is broken: waiting for #n`. No builder runs, no round is spent and no `concurrency` slot is used |

- **Only a real FAIL holds a job.** `UNKNOWN` (the install failed, git failed, exit 126 or 127, a signal, a busy lock) never does.
- **One fix issue per breakage.** The first hold finds the one open `factory:base-fix` issue or creates it (`eminzo base fix-issue` does the same by hand). If `gh` fails, the job still waits and the note says how to create the issue.
- **The fix job is exempt.** A job whose issue carries `factory:base-fix` (`job.json` `base_fix`) is checked on everything, never narrowed to its files, and never held.
- **No shortcut.** `job <id> to build` and `job <id> promote` refuse a real gate failure that `job <id> base` has not answered, and refuse a held job.
- **A held job in its last round waits** instead of escalating; when its PR is merged by hand, `to merged` ends the wait. Every wait is kept in `base_waits`.
- **Where to look.** `job summary` shows `gate (waits for main, #n)`; Ask Eminzo lists the job as waiting with kind `fix-base`; the dashboard shows the note.

### The builder's plan and self-check

- **Plan.** Before its first code edit, the builder writes `factory/jobs/<id>/plan.md` (at most 30 lines) with four sections:
  - `## Files that change`
  - `## Order of work`
  - `## Risks`
  - `## Proof`: the test for each AC
- **Self-check.** Before `STATUS: READY` it runs `selfcheck` (see the command reference).
- **build.md across rounds.** `build.md` lives in the job folder while its round runs. When the job goes back to build (a failed gate, a review with `CHANGES`, a rework), the engine moves it to `round-<n>/build.md`, so the next builder reads its handoff (`## Notes for the next round`) there and the job never loses it. The dashboard lists it as `round-<n>/build.md`.
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
- **The engine version.** `job.json` records `engine_version` when the job starts and at every round.
- **Lessons.** `decision.md` ends with `## Lessons`; `eminzo job lessons` turns repeated ones into a pull request for `factory/project.md`.
