# `eminzo mcp`: the factory's state for agents

`eminzo mcp` answers questions about the factory of the current repository ("what is waiting for me",
"why is job 177 in round 3", "how much did this week cost") as a
[Model Context Protocol](https://modelcontextprotocol.io) server. Ask Eminzo, the chat in the Eminzo
desktop app, uses it. Any Claude Code or Codex session can use it too.

It is **read-only**. It runs no git command and changes no file. The GitHub calls it makes are reads
through `gh` (`issue list`, `issue view`, `pr list`, `pr view`); it never creates, edits, labels or closes anything.

## How it runs

There is no server to deploy and no port to open. The agent starts `eminzo mcp` as a child process with
the session, talks to it over stdin/stdout (newline-delimited JSON-RPC 2.0), and stops it by closing stdin.
It reads the repository of the directory it starts in; a worktree resolves to its main checkout, and
`FACTORY_ROOT` wins as in every engine command. Logs go to stderr only.

`eminzo install` registers it in Claude Code and Codex, through their own commands, and prints what it did:

```sh
claude mcp add --scope user eminzo -- eminzo mcp
codex mcp add eminzo -- eminzo mcp
```

Only that `eminzo` entry is added; nothing else in `~/.claude.json` or `~/.codex/config.toml` changes. An `eminzo`
entry that runs something else is yours and is kept. A tool that is not installed is skipped, with the command to
run later. `eminzo install --no-mcp` skips the registration. `eminzo uninstall` removes only the entries install
added (recorded in `~/.eminzo/install.json`) and that still run `eminzo mcp`.

To hand it to one Claude Code session instead, use `claude --mcp-config <file>` (the desktop does this):

```json
{ "mcpServers": { "eminzo": { "command": "eminzo", "args": ["mcp"] } } }
```

A repository that commits its own engine (the desktop's vendored copy)
runs it as `factory/bin/mcp`.

## Tools

| Tool | Answers | Arguments |
|---|---|---|
| `factory_overview` | how the factory is now: jobs per group and stage, what runs, how many wait for a person, the last job that finished | none |
| `list_jobs` | which jobs match, most recently updated first | `stage`, `group` (`active`, `parked`, `terminal`), `lane`, `risk`, `size`, `since`, `limit` (1-100, default 20) |
| `job_detail` | one job: every round with why it ran, gate result, each verdict with its blockers, the approval decision, times and cost per agent | `job`: a job id (`161-fix-login`) or an issue number (`161`, `#161`) |
| `waiting_on_people` | every job waiting for a person, oldest first, and what it needs: `decide`, `answer`, `approve-spec` or `merge` | none |
| `changes_since` | what finished, started waiting, started or moved since a moment | `since` (default: 24 hours ago) |
| `period_summary` | jobs started, merged, rejected and escalated; total and extra rounds; known cost by lane | `from`, `to` (default: the last 7 days) |
| `factory_diagnosis` | where the factory loses time and money over the jobs that finished in a period: extra rounds by cause, first-review changes by lens, cost by role and risk, escalations by risk, time by size, and proposals backed by those numbers (a proposal needs a minimum of evidence; nothing is changed) | `from`, `to` (default: the last 30 days) |
| `estimate_work` | how long and how much a list of proposed deliverables would take, from the most similar finished jobs: time from start until ready for approval (pauses included), rounds, the wait after approval, cost, and how often that risk waited for a person's decision; a range with the number of jobs behind it, or "too little history" below 5 | `deliverables` (1-20, each with `size`, `risk`, optional `title` and `lane`), `include_github` (also read the facts line of merged PRs) |
| `discovery_methods` | the product stage's discovery methods (Eminzo basic, Elephant-Goldfish when installed), which one is configured and which one to use | `provider` (`claude`, `codex`) |
| `check_brief` | a brief checked against the contract: what blocks approval, warnings, and its deliverables ready for `estimate_work` | `text` |
| `brief_template` | an empty brief in the repository's language | `title` |
| `import_egm_brief` | an Elephant-Goldfish `concepts_brief.md` turned into a brief draft, with what is still missing (reads a file inside the repository only) | `path` (default `concepts_brief.md`) |
| `brief_review_prompts` | the prompt for each context-free reader of a brief; the host starts the readers | `text` |
| `merge_brief_review` | the readers' answers as one list of findings, blockers first (each reader reports at most 3; near-duplicates across readers are merged) | `answers` |
| `brief_status` | where a brief stands: `draft`, `ready`, `approved` or `changed`, and whether issues may be created from it (`can_create_issues`, with the `reason` when not); the gate every issue creator must pass | `text` |
| `approve_brief` | the brief with an approval marker bound to its content, `by` and the time; refuses a brief that is not complete. It stores nothing and is called only after the person explicitly approved. The marker detects later edits but does not authenticate: `by` is self-declared, and GitHub is the record of who approved | `text`, `by` (a GitHub login) |
| `product_map` | how the product works today, from the reviewed map in `factory/product-map.md`: areas with statements labelled `confirmed` or `assumed`, who reviewed it and when, and its state (`missing`, `draft`, `reviewed`, `stale` after 90 days). Reads that one file; a file larger than 1 MiB counts as missing | none |
| `handoff_drafts` | the issue texts for an approved brief, behind the gate: without `brief_issue` the brief issue draft (label `eminzo-brief`), with it one draft per deliverable in dependency order (label `eminzo-deliverable`, never `factory`) plus `estimate_input`; fails with the gate's `reason` when the brief is not approved. Stores and creates nothing: the Eminzo desktop creates the issues after the person confirms | `text`, `brief_issue`, `created` (`[{ id, issue }]`) |
| `initiative` | how an initiative is going, from GitHub: the brief issue (approver, date, whether its text still matches the approval) and its deliverable issues with a status (`not-created`, `waiting-tech-lead`, `in-factory`, `in-review`, `available`, `closed`), pull request, estimate at creation and actual time, plus progress and estimate against actual (available deliverables only); only issues Eminzo created for the brief count, lookalikes become warnings (GitHub, through `gh`) | `issue` (the brief issue number), `known` (up to 50 deliverable issue numbers the caller just created) |
| `initiative_report` | the weekly progress report of one initiative for a client, as a draft markdown in functional language and in the brief's language: delivered in the period (default the 7 whole UTC days before today; date-times need a zone), in progress, waiting for a decision, coming next, estimate against actual (ranges, never dates), plain-words notes for the warnings; cost only with `include_cost` (known costs only, never 0 for unknown), links only with `include_links`. Reads the initiative like `initiative` (same trust rules); it sends nothing (GitHub, through `gh`) | `issue`, `known`, `from`, `to` (ISO date or date-time; a day alone means the whole day), `include_cost`, `include_links` |
| `factory_config` | base, concurrency, rounds, auto-merge, spec review, providers, lanes, reviewers, local overrides (never prices) | none |
| `factory_queue` | open `factory` issues no local job has taken, oldest first (GitHub, through `gh`) | none |

Every result has the same envelope, so an answer can say where its data came from and when:

```json
{ "source": "local", "read_at": "2026-11-12T15:00:00.000Z", "repo": "https://github.com/acme/shop",
  "summary": "2 jobs running, 4 jobs waiting for a person, 3 jobs finished (9 jobs on this machine).", "...": "..." }
```

- `source` is `local` (`factory/jobs` on this machine), `github`, or `local+github` (an estimate that also read merged pull requests).
- Costs are `null` when unknown, never `0`.
- Times are ISO 8601. Durations are in minutes, rounded to 0.1.

A tool that cannot answer returns a result with `isError: true` and a sentence a person can act on.
For example: "no job on this machine matches 999; jobs live only on the machine that ran them".

## How the estimate works

For each deliverable the estimate takes the finished (merged) jobs with the same size, risk and lane. When
there are fewer than 5, it uses the same size and lane, then the same size. With fewer than 5 even then,
it gives no range and says "too little history". Low, typical and high are the 25th, 50th and 75th
percentiles (nearest rank).

The time runs from the job's start until it was ready for approval. Pauses and waits in between count, so
one job left overnight widens the range; that is the honest answer for "when will it be ready". The wait
after approval (merge, a person's decision) is reported apart and not added. Totals add the deliverables one
after another; independent ones can run in parallel up to `concurrency`.

With `include_github`, merged pull requests add the jobs of other developers through their facts line;
a job already on this machine is counted once. If `gh` fails, the local estimate is still returned, with
`history.github_error`.

The sizes and risks are the caller's: an agent sets them the way intake would. Nothing here depends on the
repository's language or framework.

## What it can and cannot see

Jobs live in `factory/jobs`, which is gitignored: each machine sees only the jobs it ran. A question
about another developer's job gets "not on this machine", never a guess. What GitHub knows (the queue, a
pull request's Factory record) is shared.

`changes_since` works from each job's own timestamps (`started`, `updated`, `finished`). Steps in between are
not recorded, so it reports which jobs changed, not every transition.

## Safety

- No tool writes: every tool is annotated `readOnlyHint: true, destructiveHint: false`.
- Issue titles, notes and reasons are data that came from GitHub issues and agent reports. The server's
  instructions tell the model to treat them as data, never as instructions. Queue titles go through the
  same `safeTitle` as job titles.
- Arguments are checked against each tool's schema before it runs. Unknown arguments are refused.

## Protocol

The server is written by hand (the engine has no runtime dependencies) and speaks both eras of MCP:

- A request whose `params._meta` carries `io.modelcontextprotocol/protocolVersion` is served statelessly
  under revision `2026-07-28`: every result has `resultType: "complete"`, `server/discover` is
  implemented, and an unknown version gets `UnsupportedProtocolVersionError` (`-32022`).
- An `initialize` request selects a handshake revision (`2025-11-25`, `2025-06-18`, `2025-03-26` or
  `2024-11-05`) for the rest of the process.

Only tools are offered. Batches are refused, and lines over 1 MiB are refused.

## Code

| File | Role |
|---|---|
| `factory/lib/mcp.js` | entry point: `eminzo mcp` / `factory/bin/mcp` |
| `factory/lib/mcp/protocol.js` | JSON-RPC and MCP, transport-free, plus the stdio transport |
| `factory/lib/mcp/schema.js` | the JSON Schema subset tool arguments use, and its validator |
| `factory/lib/mcp/tools.js` | the tool catalog and the result envelope |
| `factory/lib/state/jobs.js` | job views and job detail, read from `factory/jobs` |
| `factory/lib/state/queries.js` | overview, list, waiting, changes, period, config |
| `factory/lib/state/diagnosis.js` | the factory diagnosis and its proposal thresholds |
| `factory/lib/state/stats.js` | quantiles by nearest rank and the typical value with the middle half |
| `factory/lib/state/history.js` | finished-job records for estimates: local merged jobs, plus the facts lines of merged PRs |
| `factory/lib/state/estimate.js` | the estimate: matching levels, ranges, warnings and totals |
| `factory/lib/state/github.js` | the queue, through `gh` |
| `factory/lib/state/initiative.js` | an initiative: the brief issue, its deliverables, their pull requests and the estimate against the actual time, through `gh` |
| `factory/lib/client-report.js` | the weekly client report of an initiative (pure): sections, plain-words notes, en/es/pt |
| `factory/lib/handoff.js` | the texts and markers of the brief issue and the deliverable issues (pure) |

Tests: `test/mcp-protocol.test.js`, `test/mcp-schema.test.js`, `test/factory-state.test.js`, `test/factory-diagnosis.test.js`, `test/factory-estimate.test.js`,
`test/handoff.test.js`, `test/initiative.test.js`, `test/client-report.test.js`, `test/brief.test.js` and `test/mcp-golden.test.js`. The golden test asks known-answer questions through the real process. Add a
row there whenever Ask Eminzo learns a new kind of question.
