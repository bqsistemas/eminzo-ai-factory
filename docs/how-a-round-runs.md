# How a round runs

What a builder, its reviewers and the approver do in one round, and what each leaves behind. Back to the [README](../README.md).

### Checks: focused and full

The engine runs your `factory/checks.sh` with these variables:

| Variable | Value |
|---|---|
| `FACTORY_CHECK_MODE` | `focused` for the builder's own `nudge <id>`; `full` for `nudge <id> --full`, the Claude Stop hook, the gate and the merge |
| `FACTORY_CHANGED_FILES` | in focused mode, a file with one changed path per line (against the merge-base with the job's base) |
| `FACTORY_BASE` | the commit the job's branch left the base at (the merge-base). Set for the gate, the merge and the builder's focused `nudge <id>` (not for `--full` or the Stop hook, which run everything), so a `checks.sh` can check only the projects the job touched. Not set for a job that fixes the base (`factory:base-fix`) or when you run `checks.sh` by hand: then everything runs |
| `FACTORY_HEAD` | the commit under test: the tested head for the gate, the merge commit for the merge. Not set for the nudge, which also sees uncommitted files |

The gate report names the first one as `Checks base: <sha>|none`. Values already in the environment are dropped, and each variable is set only from a full commit sha.

- **Ignoring the variables is safe.** A `checks.sh` that ignores them runs everything, as before.
- **The template.** `setup` writes one per stack (`factory/templates/checks/<stack>.sh`: Node, Go, Python, Rust, Ruby, Maven, Gradle) that narrows only when that is reliable and otherwise runs everything. For an Nx or Turborepo workspace it writes `factory/templates/checks/node-affected.sh` instead: `nx affected` or `turbo run --filter=...[base]` over the `lint`, `typecheck` and `test` targets the repo has, using `FACTORY_BASE` and `FACTORY_HEAD`. `factory/bin/init checks` proposes it for an existing `checks.sh` and never overwrites it.
- **The safety net.** A focused pass is never reused by a full caller, and a focused nudge pass is reused only for the same merge-base (a full pass ran everything, so it needs no scope). The gate and the merge run the job's scope: everything for a `checks.sh` that ignores `FACTORY_BASE`, the affected projects for one that reads it.
- **Cap.** At most `checks.max_runs_per_round` check runs per round (default 6). Past it the nudge exits 2 with `cap reached: write build.md with what is still failing`.
- **The contract: a full run covers a scoped run.** A full run of `checks.sh` (no `FACTORY_BASE` or `FACTORY_HEAD`, as the Stop hook and `nudge <id> --full` run it) must run everything a scoped run would, never less. The round gate may reuse a passing full run (the Stop-hook stamp below) instead of running its own scoped run, and the merge still runs the full checks. A `checks.sh` that checks something only when `FACTORY_BASE` is set breaks the contract: the stamp would vouch for a check that never ran. The shipped templates keep it (without `FACTORY_BASE` every project is checked).
- **The Stop-hook stamp.** When a full run (the Claude Stop hook or `nudge <id> --full`) really runs `checks.sh` and it passes, the nudge writes `factory/jobs/.stamps/<job-id>.json` in the main checkout (job, round, tree, checks inputs, base, head, time, engine); a full failure deletes it, and a focused pass or a pass reused from `nudge.json` writes none. The nudge takes the tree and the head before `checks.sh` runs and again after it, and writes the stamp only when both are unchanged (a `checks.sh` that rewrites files or moves the head leaves none). The round gate then skips `checks.sh`, and writes `Reused the Stop-hook pass` in `checks.md` (the summary sentence says the pass was reused too), only when the worktree is clean, the stamp's job, round, head, tree, checks inputs and base all match what the gate measures at that moment, the stamp is at most an hour old (a stamp dated more than a minute ahead of the clock does not count), neither the stamp file nor `factory/jobs/.stamps` is a symlink, and the job is not a base fix. Anything else is ignored (an expired one is deleted) and the gate runs the checks as usual. The stamp is used once, and every other gate step (protected tests, uncommitted changes, the visual check, `context.md`) still runs. The gate also fails a branch that touches `factory/jobs/` (in any letter case; `factory/demo/jobs/` is allowed). A builder with Bash can forge the file (the same residual risk as `job.json`), so the merge never reuses a gate that rested on a stamp: it runs `checks.sh` into `merge-checks.md`, and `protect-tests` denies the file tools on the stamp folder.
- **Flaky checks.** A check that fails and then passes with no code change goes to `build.md` `## Flaky` (`command | error`) instead of being fixed in the job.

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
