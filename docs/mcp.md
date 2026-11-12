# `eminzo mcp`: the factory's state for agents

`eminzo mcp` answers questions about the factory of the current repository ("what is waiting for me",
"why is job 177 in round 3", "how much did this week cost") as a
[Model Context Protocol](https://modelcontextprotocol.io) server. Ask Eminzo, the chat in the Eminzo
desktop app, uses it. Any Claude Code or Codex session can use it too.

It is **read-only**. It runs no git command and changes no file. The one GitHub call it makes is
`gh issue list`.

## How it runs

There is no server to deploy and no port to open. The agent starts `eminzo mcp` as a child process with
the session, talks to it over stdin/stdout (newline-delimited JSON-RPC 2.0), and stops it by closing stdin.
It reads the repository of the directory it starts in; a worktree resolves to its main checkout, and
`FACTORY_ROOT` wins as in every engine command. Logs go to stderr only.

Register it once per machine:

```sh
# Claude Code
claude mcp add --scope user eminzo -- eminzo mcp
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.eminzo]
command = "eminzo"
args = ["mcp"]
```

Or hand it to one Claude Code session with `claude --mcp-config <file>`:

```json
{ "mcpServers": { "eminzo": { "command": "eminzo", "args": ["mcp"] } } }
```

`eminzo install` does not register it: that would mean editing `~/.claude.json` and `~/.codex/config.toml`,
which `install` does not own. A repository that commits its own engine (the desktop's vendored copy)
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
| `factory_config` | base, concurrency, rounds, auto-merge, spec review, providers, lanes, reviewers, local overrides (never prices) | none |
| `factory_queue` | open `factory` issues no local job has taken, oldest first (GitHub, through `gh`) | none |

Every result has the same envelope, so an answer can say where its data came from and when:

```json
{ "source": "local", "read_at": "2026-11-12T15:00:00.000Z", "repo": "https://github.com/acme/shop",
  "summary": "2 jobs running, 4 jobs waiting for a person, 3 jobs finished (9 jobs on this machine).", "...": "..." }
```

- `source` is `local` (`factory/jobs` on this machine) or `github`.
- Costs are `null` when unknown, never `0`.
- Times are ISO 8601. Durations are in minutes, rounded to 0.1.

A tool that cannot answer returns a result with `isError: true` and a sentence a person can act on.
For example: "no job on this machine matches 999; jobs live only on the machine that ran them".

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
| `factory/lib/state/github.js` | the queue, through `gh` |

Tests: `test/mcp-protocol.test.js`, `test/mcp-schema.test.js`, `test/factory-state.test.js`, `test/factory-diagnosis.test.js` and
`test/mcp-golden.test.js`. The golden test asks known-answer questions through the real process. Add a
row there whenever Ask Eminzo learns a new kind of question.
