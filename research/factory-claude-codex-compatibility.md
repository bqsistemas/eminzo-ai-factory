# Factory compatibility: Claude Code and Codex

Status: **Codex adapter and provider-aware model routing implemented; usage/leases remain future work** — 2026-10-30.

## Executive recommendation

Keep the working Claude Code path intact. Make the existing Node/Git/GitHub pipeline the shared contract, then add a **Codex host adapter**: a repository skill for orchestration, Codex role definitions, and provider-specific model/usage handling. Do not copy the state machine or treat a Codex session transcript as a job database.

The user-facing invocation cannot be assumed identical: Claude currently exposes `/factory run`; Codex documents explicit skill invocation as **`$factory run`** (or selection through `/skills`), not a project-defined `/factory` slash command. If a literal common command is required, expose a small terminal launcher such as `factory run` that chooses a host; do not advertise `/factory` in Codex until that exact surface is proven. [Codex skills](https://learn.chatgpt.com/docs/build-skills), [Codex command reference](https://learn.chatgpt.com/docs/developer-commands).

## Current implementation, verified in this repository

| Responsibility | Existing source | Portability |
| --- | --- | --- |
| Queue, trust boundary, preflight, dispatch, wait/resume rules | `.claude/skills/factory/SKILL.md`, `README.md` | Claude-host orchestration today; policy can be shared. |
| Intake, spec, builder, four reviewer lenses, approver | `.claude/agents/eminzo-*.md` | Role instructions are reusable; frontmatter/tools/models are Claude-specific. |
| Legal stages, file validation, worktrees, PR effects, board output | `factory/lib/job.js`, `factory/bin/job` | Shared spine. `job` is the only writer of `job.json` and `board.json`. |
| Risk/surface reviewer selection and model aliases | `factory/lib/route.js`, `factory/config.json` | Reviewer *selection* is portable; model names and prices are not. |
| Deterministic checks and protected-test guard | `factory/lib/gate.js`, `factory/checks.sh` | Shared, authoritative gate. |
| Builder pre-finish nudge | `.claude/agents/eminzo-builder.md`, `factory/lib/nudge.js` | Claude hook/payload/transcript coupling. Advisory, not the gate. |
| Usage and USD reporting | `factory/lib/cost.js`, `factory/lib/util.js`, `factory/lib/job.js` | Claude transcript location/format and price table. |

The actual flow is: labeled GitHub issue → intake → route/worktree → spec → build/draft PR → gate → routed reviews → approve → merge or human wait. Gate failure returns to build. `CHANGES` returns to build while rounds remain. `needs-info`, `needs-human`, `awaiting-merge`, `merged`, and `rejected` have distinct, already implemented transitions. `factory/config.json` allows three active jobs; all routed reviewers of a review round must finish before that round advances. See `.claude/skills/factory/SKILL.md` and `factory/lib/job.js` (`TRANSITIONS`, `verdicts`, `refreshFromFiles`, `transition`).

### Existing commands are not shell commands

| Intent | Claude Code today | Codex target | Shared deterministic operation |
| --- | --- | --- | --- |
| Drain and resume queue | `/factory run` | `$factory run` | `factory/bin/job new`, `sync`, `to ...`, `summary` |
| Start one issue | `/factory issue 12` | `$factory issue 12` | `factory/bin/job new 12` |
| Create issue and run | `/factory <feature>` / README example `/factory add ...` | `$factory add ...` or equivalent skill input | `gh issue create --body-file`, then `job new` |
| Rework a parked job | `/factory rework 12` | `$factory rework 12` | `factory/bin/job <id> to build` or `to <parked_from>` |

The skill orchestrates these operations; `factory/bin/job` does not itself run an entire issue end to end. There is intentionally no `/factory approve`: the existing human action is a GitHub PR merge/review, observed by a later run.

### Where the host boundary currently leaks

1. Claude dispatch uses `run_in_background: true`, named `builder-<id>` agents, notifications, and `SendMessage` for another round. These are host actions, not commands supplied by `factory/bin/job`.
2. `.claude/agents/eminzo-*.md` declares Claude tools and `fable`/`opus`/`sonnet`/`haiku`. `factory/lib/route.js` stores selected aliases in `job.agents`; sending those aliases to Codex would be invalid.
3. `factory/bin/nudge` reads Claude's hook payload and searches the transcript for `factory/jobs/<id>/`. `factory/lib/cost.js` reads Claude JSONL under `~/.claude/projects/.../subagents/`. Neither is a Codex usage contract.
4. A new job starts at `cost_usd: 0`; `job sync` always replaces cost from Claude transcripts and `summary` formats absent/non-finite cost as `$0.00`. Merely starting a Codex job without adapting this path would report misleading zero spend.
5. `writeAtomic()` prevents torn JSON, **not** two orchestrators racing on the same job/branch/PR. There is no cross-process job lease. Initially, run only one active host orchestrator per job.

## Codex capabilities checked against current official documentation

- Repo skills are discovered from `.agents/skills` and may be invoked with `$factory` or `/skills`; a `SKILL.md` needs `name` and `description`. [Build skills](https://learn.chatgpt.com/docs/build-skills).
- Codex supports parallel subagents and project-scoped custom profiles in `.codex/agents/*.toml`, with per-role instructions and model settings. Those agents inherit the parent permission mode, sandbox, provider, and MCP servers; **a custom-agent prompt is not a separate security sandbox**. [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).
- Codex has `SubagentStop` and `Stop` hooks, including a `SubagentStop` matcher on `agent_type`. A continuation can be requested by JSON `decision: "block"` or exit code 2. Project hooks require trust. This makes a Codex nudge feasible, but **the existing Claude nudge is not automatically compatible** with Codex's transcript and role identification. [Hooks](https://learn.chatgpt.com/docs/hooks).
- `codex exec` supports non-interactive runs, `--json` JSONL events with `turn.completed.usage`, `--output-schema`, `--model`, `--sandbox`, and session resume. The local CLI inspected for this research is `codex-cli 0.155.1`. A CLI event's token usage is evidence of usage, not automatically a trustworthy USD cost for every authentication/billing mode. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [CLI reference](https://learn.chatgpt.com/docs/developer-commands).
- The hosted Agents API is a distinct deployment architecture. It is not needed to add a local Codex host for this repository. [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview).

## Proposed design

### 1. Preserve one shared workflow contract

Extract the host-neutral rules from `.claude/skills/factory/SKILL.md` into one reference such as `factory/workflow.md`: preflight, queue ordering, stage matrix, file protocols, retries, waiting for all routed reviewers, human review, security boundaries, and resume. Both host skills reference it. Keep the existing Claude skill invocation and role files as a compatibility baseline; avoid a wholesale rewrite before equivalence tests exist.

The shared contract should say *what* each role produces and *when* `factory/bin/job` is called. The Claude and Codex adapters should say *how* to spawn a role, constrain tools, wait, and collect completion. Job state continues to come from `job.json`/stage files and GitHub, never from a model's remembered conversation.

### 2. Add a Codex-facing skill and role profiles

Implemented files: `.agents/skills/factory/SKILL.md` and
`.codex/agents/eminzo-{intake,spec-writer,builder,review-security,review-ux,review-ui,review-code,approver}.toml`.
They reference the same role instructions/protocol without passing Claude YAML
frontmatter or its `tools:` list to Codex. The adapter is intentionally
instruction-driven; profile instructions cannot provide a separate sandbox from
the parent Codex session.

Codex's skill should accept `run`, `issue <n>`, `add <feature>`, and `rework <n>`; perform the same preflight; dispatch only selected roles; read only each artifact's first line as the orchestration signal; and re-check PR terminal state before resuming a job. For rework, a **new** Codex builder subagent can reconstruct context from the job and round files. Claude may keep its named-builder `SendMessage` optimization. The durable state must not depend on either thread surviving.

Where intake/spec/reviewer must be truly restricted, test the available Codex profile controls and parent sandbox. Profile instructions alone cannot promise the same per-role tool boundary as Claude's `tools:` frontmatter. Keep GitHub writes and state transitions behind the trusted scripts; a role agent should not update `job.json` or merge independently.

### 3. Separate role routing from model resolution

Implemented: `factory/config.json` keeps the legacy Claude `models`/`routing`
fields and adds `default_provider` plus `providers.claude` and `providers.codex`.
`factory/bin/job new <issue> --provider codex` persists the provider; at
intake→spec, `factory/lib/route.js` resolves provider-specific builder/reviewer
models and `factory/lib/job.js` persists the complete `models` map in `job.json`.
Legacy jobs without a provider remain Claude. The configured Codex IDs are
`gpt-6-luna` for routine work and `gpt-6.1-sol` for high-risk/approval work;
availability must still be validated against the authenticated Codex client.

For a mid-job switch, require an explicit rebind at a safe stage boundary, with no agents still running. Do not silently reinterpret `opus` or `haiku` as a Codex model. One host owns a job at a time; cross-host concurrent operation would require a local job claim/lock and race tests before release.

### 4. Make usage and hooks provider-specific, while keeping the gate shared

Keep Claude cost parsing unchanged. For Codex, record a job-scoped usage event only from a verified source (for example a dedicated `codex exec --json` role run identified by job and role). Deduplicate retries and resumed turns; use an explicit `unknown`/`unavailable` display until USD billing semantics and model rates are verified. Update `summary` and dashboard together; `null` must not render as `$0.00`.

Start Codex without a nudge. `factory/bin/gate` still makes the decision. A later Codex `SubagentStop` adapter could check the builder worktree, but must identify the correct job without relying on a Claude transcript, handle `stop_hook_active`, respect hook trust, and avoid running for non-builders. It should only advise/continue the builder; it must never bypass or replace the gate.

### 5. Keep automation optional, not the first migration step

The first working slice should be interactive `$factory issue <n>` in Codex, then queue draining and bounded parallelism. A `codex exec`-based runner is an alternative if unattended execution or a literal shell command is required. It gives deterministic process boundaries and JSONL usage, but adds process management, permission/authentication handling, cancellation, and more code. Do not use `danger-full-access` as a shortcut for GitHub/worktree writes. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

## Delivery sequence and validation

1. **Baseline Claude**: run existing tests and record one known Claude flow/fixtures before refactoring. Preserve `/factory` and legacy `job.json` behavior.
2. **Shared contract + Codex skill**: ✅ add the skill/role adapter and static contract tests in `test/codex-factory.test.js`. A supervised disposable `run`/`issue` pilot with a fake `gh` is still required before unattended use; no real PR merge is covered by the test suite.
3. **Provider-aware routing/state**: ✅ add provider selection, model resolution, persistence and regression tests while preserving legacy Claude jobs. A supervised disposable `run`/`issue` pilot with a fake `gh` is still required before unattended use.
4. **Gate/review concurrency**: simulate up to three jobs, several reviewers per job, staggered completions, `CHANGES`, gate failure, max rounds, and no reviewer before a passing gate. Assert only one writer for job state.
5. **Human/terminal paths**: test needs-info reply, needs-human rework with and without PR, awaiting-merge, merged/rejected PRs, and an interrupted merge.
6. **Usage/nudge**: verify attribution and unknown-cost presentation; only then consider an optional Codex hook.
7. **End-to-end pilot**: one disposable labeled issue/worktree/PR under explicit human supervision, then a 3-job concurrency run. Verify the existing Claude workflow again afterward.

**Acceptance:** Both hosts reach identical legal stages and artifacts; Claude remains unchanged for existing jobs; Codex never receives Claude model aliases; gate/merge authorization remains in the scripts; all routed reviewers complete before a decision; no duplicate job/PR or simultaneous host ownership; unknown Codex cost is not `$0.00`.

## Decision to make before implementation

Use **Codex's native `$factory` skill** first. It is the smallest compatible addition and preserves the already working Claude path. Choose a separate CLI runner only if exact literal command syntax or unattended execution is a hard requirement. The latter is more predictable operationally, but significantly larger and more security-sensitive.
