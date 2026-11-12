# How a round runs

What a builder, its reviewers and the approver do in one round, and what each leaves behind. Back to the [README](../README.md).

### Checks: focused and full

The engine runs your `factory/checks.sh` with two variables:

| Variable | Value |
|---|---|
| `FACTORY_CHECK_MODE` | `focused` for the builder's own `nudge <id>`; `full` for `nudge <id> --full`, the Claude Stop hook, the gate and the merge |
| `FACTORY_CHANGED_FILES` | in focused mode, a file with one changed path per line (against the merge-base with the job's base) |

- **Ignoring the variables is safe.** A `checks.sh` that ignores them runs everything, as before.
- **The template.** `setup` writes one per stack (`factory/templates/checks/<stack>.sh`: Node, Go, Python, Rust, Ruby, Maven, Gradle) that narrows only when that is reliable and otherwise runs everything.
- **The safety net.** A focused pass is never reused by a full caller, so the gate always runs everything.
- **Cap.** At most `checks.max_runs_per_round` check runs per round (default 6). Past it the nudge exits 2 with `cap reached: write build.md with what is still failing`.
- **Flaky checks.** A check that fails and then passes with no code change goes to `build.md` `## Flaky` (`command | error`) instead of being fixed in the job.

### The builder's plan and self-check

- **Plan.** Before its first code edit, the builder writes `factory/jobs/<id>/plan.md` (at most 30 lines) with four sections:
  - `## Files that change`
  - `## Order of work`
  - `## Risks`
  - `## Proof`: the test for each AC
- **Self-check.** Before `STATUS: READY` it runs `selfcheck` (see the command reference).
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
  lane, size, risk, surfaces, round, start time, time it entered approve and known cost. It carries no
  free text. `factory/jobs` stays on the machine that ran the job; this line is how the rest of the team,
  and Ask Eminzo's estimates, can learn from finished jobs (`factory/lib/record-facts.js` parses it).

  The engine updates only that section, and only when the PR is open.
- **The engine version.** `job.json` records `engine_version` when the job starts and at every round.
- **Lessons.** `decision.md` ends with `## Lessons`; `eminzo job lessons` turns repeated ones into a pull request for `factory/project.md`.
