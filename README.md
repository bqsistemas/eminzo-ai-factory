# eminzo-ai-factory

The Eminzo AI software factory: one Claude Code skill (and its Codex adapter), eight
role-based subagents, a few dependency-free Node scripts, and markdown files. Any team
puts it in its own GitHub repository: label an issue `factory`, start it with
`/eminzo-factory issue <n>`, and it goes through intake, spec, build, a deterministic
gate, routed reviews and approval; `/eminzo-factory run` continues your jobs. It ends as a
merged PR, a PR waiting for you, a question on the issue, or a rejection.

Two ways to use it in a repository:

- **The `eminzo` CLI** (recommended): the engine is an npm package, and the repository keeps
  only its own `factory/config.json`, `checks.sh` and `project.md`. See
  "Use it as a CLI in another repository" below and `cli/README.md`.
- **A committed engine**: the repository carries `factory/` and the adapters, as this
  repository does to build itself (the Eminzo desktop app installs it this way too).

```
issue (label: factory)
  → intake (fable)       ACCEPT | NEEDS-INFO | REJECT, risk + surfaces, posted on the issue
  → route (script)       reviewers + models from config.json
  → spec-writer (opus)   spec.md
  → builder              commits, pushes factory/<id>, opens a draft PR "Closes #<n>"
  → gate (script)        checks.sh + protected tests; FAIL → back to the builder
  → reviewers (routed)   code always; ui for ui (it covers UX); ux for a new interactive flow; security for security; WAIT FOR ALL
  → approver (opus)      APPROVE → sync, re-gate, gh pr merge | ESCALATE → you merge the PR
```

## Use it

One-time setup, from the main checkout on `main`:

```sh
gh auth login                    # gh must be logged in
sh factory/checks.sh             # the repo's checks must pass on main
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
this feature needs `/eminzo-factory setup` (or `factory/bin/setup-spec-review`) once to create the
`factory:spec-review` label.

### Run mode and issue claims

Several developers can run the factory on one shared repo; each one processes only the
issues they chose. `run_mode` in `factory/config.json` decides what `run` does:

- `own` (the default when `run_mode` is missing): `run` takes no new issue. It runs the PR
  checks and advances the jobs already in your `factory/jobs/`. A new issue enters only through
  `issue <n>`, `add <feature>` (Claude: `<feature>`) or `xs <request>`.
- `queue`: `run` also lists every open `factory` issue and starts a job for each, as before.

Any other value is refused (`factory/bin/job run-mode` prints the resolved mode). When upgrading,
set `"run_mode": "queue"` if you relied on `run` picking up new issues.

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

## Compatibilidad con Codex

La factory conserva una **spine portable** y ahora incluye un adaptador nativo
para Codex. Claude Code sigue usando `/eminzo-factory`; Codex usa `$eminzo-factory`. Ambos
leen y actualizan los mismos archivos de trabajo y ejecutan los mismos scripts
de transición.

La identidad instalada es `eminzo-factory`: los agentes viven bajo nombres
`eminzo-*` y las skills canónicas están en `.claude/skills/eminzo-factory` y
`.agents/skills/eminzo-factory`. El instalador empaqueta únicamente esas skills
canónicas; las skills `factory` heredadas que quedan en este repositorio no se copian
a los repos nuevos.

### Qué ya es portable

- `factory/lib/job.js`: estados, worktrees, transiciones, PRs y merge.
- `factory/lib/route.js`: reviewers por riesgo y superficie.
- `factory/lib/gate.js`: gate determinista y tests protegidos.
- `factory/bin/job`, `gate`, `route` y `setup`.
- GitHub como cola y frontera de confianza.
- `factory/jobs/<id>/job.json` y `factory/board.json` como estado compartido.

### Qué está acoplado a Claude Code

- `.claude/skills/eminzo-factory/SKILL.md` define `/eminzo-factory run`, `/eminzo-factory issue` y
  `/eminzo-factory rework`, además de la orquestación en background.
- `.claude/agents/eminzo-*.md` son envoltorios finos: frontmatter, herramientas, hooks y
  aliases de modelos de Claude (`opus`, `sonnet`, `haiku`, `fable`). El cuerpo de
  cada rol vive en `factory/roles/<rol>.md`, compartido con Codex.
- El builder usa un hook `Stop` de Claude.
- `factory/lib/util.js` busca transcripts en `~/.claude/projects`.
- `factory/lib/cost.js` interpreta JSONL de transcripts Claude.
- `factory/lib/nudge.js` interpreta el payload del hook de Claude.

### Implementación actual

- `.agents/skills/eminzo-factory/SKILL.md` implementa `$eminzo-factory run`, `$eminzo-factory issue`,
  `$eminzo-factory add` y `$eminzo-factory rework` reutilizando `factory/bin/job`, `gate` y
  `route`. No duplica la máquina de estados.
- `factory/config.json` conserva el routing Claude y agrega `providers.codex`.
  Un job Codex se crea con `factory/bin/job new <issue> --provider codex`; al
  pasar intake, el proveedor y los modelos resueltos quedan persistidos en
  `job.json`.
- `.codex/agents/*.toml` registra los ocho roles de la factory como subagentes
  Codex. Cada perfil referencia el cuerpo del rol en `factory/roles/` y
  conserva sus límites de lectura/escritura y protocolos de primera línea.
- Los reviewers se lanzan en paralelo y el adaptador espera todos los archivos
  antes de avanzar. El gate sigue siendo la autoridad determinista y los merges
  siguen pasando por `factory/bin/job`.
- Claude y Codex pueden reanudar el mismo `job.json`; no deben ejecutar el mismo
  job simultáneamente porque todavía no existe un lease entre procesos.

### Limitaciones conocidas y siguiente fase

- `factory/lib/cost.js` solo interpreta transcripts JSONL de Claude. Un job
  ejecutado desde Codex puede mostrar `$0.00` aunque su uso no haya sido medido;
  ese valor **no** debe interpretarse como costo verificado. La siguiente fase
  debe agregar un adaptador de usage por proveedor y mostrar `unknown` cuando no
  exista una fuente confiable.
- El routing Claude conserva aliases (`opus`, `sonnet`, `haiku`, `fable`). Codex
  usa los IDs configurados en `providers.codex` (`gpt-6-luna` y
  `gpt-6.1-sol`); su disponibilidad depende de la cuenta, plan y cliente, por
  lo que deben validarse antes de ejecutar una cola real.
- El hook `Stop` de `.claude/agents/eminzo-builder.md` sigue siendo específico de Claude.
  En Codex, el builder corre `factory/bin/nudge <id>` antes de escribir `STATUS: READY`,
  la skill corre `factory/bin/nudge <id>` antes de `job <id> to gate` y el gate
  explícito (`factory/bin/gate`) es la barrera obligatoria.
- No se agregó persistencia ni una migración a Agents API: GitHub, worktrees,
  scripts y artefactos de etapa siguen siendo la frontera compartida.

La compatibilidad está cubierta por `test/codex-factory.test.js` y
`test/codex-routing.test.js`, que verifican el skill, los ocho perfiles, el
routing por proveedor, la persistencia del modelo y la permanencia del
adaptador Claude.

Referencias oficiales: [skills de Codex](https://learn.chatgpt.com/docs/build-skills),
[subagentes y agentes personalizados](https://learn.chatgpt.com/docs/agent-configuration/subagents)
y [modo no interactivo](https://learn.chatgpt.com/docs/non-interactive-mode).

Watch it on the dashboard:

```sh
factory/bin/dashboard 8000
open http://localhost:8000/dashboard.html         # live board
open http://localhost:8000/dashboard.html?demo    # sample data
```

## Use it as a CLI in another repository (eminzo)

The engine also ships as the `eminzo` command, so another repository holds only its own files
(`factory/config.json`, `factory/checks.sh`, `factory/project.md`) and no engine code.

```sh
# once per machine
node cli/build.mjs && (cd cli && npm pack)       # until the package is published
npm i -g ./cli/eminzo-factory-<version>.tgz
eminzo install                                    # skill and agents in ~/.claude, ~/.agents, ~/.codex
eminzo doctor
```

Then, in the other repository, in Claude Code: `/eminzo-factory enable` (it runs `eminzo enable`,
which opens a pull request with the repository's factory files), merge it and pull, then
`/eminzo-factory setup`. Every other command is the same: `run`, `issue <n>`, `rework <n>`,
`xs <request>`, `<feature>`, `approve-spec <n>`, `revise-spec <n> <notes>` (Codex: `$eminzo-factory ...`).
`factory/config.json` pins the engine (`"engine": "0.1.x"`), so every developer runs the same rules.
See `cli/README.md`.

## Where things live

| Path | What it is |
|------|------------|
| `.claude/skills/eminzo-factory/SKILL.md` | The orchestrator: the pipeline, commands and stage steps. Edit this to change the factory. |
| `factory/roles/*.md` | The role bodies, shared by Claude and Codex: `intake`, `spec-writer`, `builder`, `review-{security,ux,ui,code}`, `approver`. |
| `.claude/agents/eminzo-*.md` | Thin Claude wrappers: frontmatter (tools, model, hooks) plus a pointer to `factory/roles/`. |
| `.agents/skills/eminzo-factory/SKILL.md` | Codex adapter for `$eminzo-factory`; reuses the Claude pipeline contract and shared scripts. |
| `.codex/agents/*.toml` | Codex profiles that map one-to-one to the eight existing factory roles. |
| `factory/config.json` | Concurrency, max rounds, the routing table, models, prices, protected tests, the repo URL. |
| `factory/checks.sh` | The repo's checks (here: `npm test`). The gate runs the main checkout's copy. |
| `factory/bin/job` | The only writer of `job.json` and `board.json`. Refuses illegal transitions and does the GitHub side effects. `job graph` prints the pipeline as JSON (read-only). |
| `factory/pipeline.json` | The pipeline graph (stages and transitions) for tools that draw it, generated by `factory/bin/job graph > factory/pipeline.json`. Regenerate it when transitions change; `test/pipeline-graph.test.js` fails when it drifts. |
| `factory/bin/gate` | Runs `checks.sh` in the job's worktree, fails on edits to protected tests, writes `round-N/checks.md`. |
| `factory/bin/route` | Prints the builder and reviewer models for a job's `intake.md`. |
| `factory/bin/approve` | The deterministic approver: `approve`, `escalate: <reason>` or `inconclusive: <reasons>` (then the LLM approver runs). |
| `factory/bin/nudge` | The builder's checks and Stop hook: runs `checks.sh` in the worktree and remembers a pass for the same files (`nudge.json`), so it never runs twice on one tree. Advisory; the gate always runs the checks itself. |
| `factory/bin/setup` | Creates the four GitHub labels; `/eminzo-factory setup` and `$eminzo-factory setup` run it. |
| `factory/bin/init` | Writes a first `factory/project.md` from the repo when it is missing; never overwrites. |
| `factory/bin/dashboard` | Serves the dashboard with Node (no dependencies), on loopback. |
| `factory/templates/project.md` | The `project.md` template: Snapshot, Stack, Commands, Module map, UI contract, Conventions. |
| `factory/lib/*.js` | The scripts' code (Node 20 ESM, no dependencies), imported by the tests. |
| `factory/project.md` | Language, test command, and conventions. Every agent reads it. |
| `factory/board.json` | Every `job.json`; the dashboard polls it. |
| `factory/jobs/<id>/` | `job.json`, `issue.md`, `intake.md`, `spec.md`, `build.md`, `round-N/checks.md`, `round-N/review-*.md`, `decision.md`, `merge-checks.md`. |
| `.worktrees/<id>/` | The job's git worktree on branch `factory/<id>`, from `origin/main`. Job IDs use the GitHub issue number; ports are allocated locally from the next available job sequence. |

`board.json`, `jobs/`, and `.worktrees/` are local runtime state and are gitignored.

## Rules the loop keeps

- GitHub issues are the queue. The `factory` label is the trust boundary: only
  people with triage or write access can add it, and `job new` re-checks it.
- Issue text reaches agents only as quoted data in `issue.md`, never as a prompt.
- Agents get context from files, not the conversation; each writes only its own file
  and replies with that file's first line.
- No reviewer runs before the gate passes. A round ends only when every routed review
  file exists (WAIT FOR ALL). The same named builder (`builder-<id>`) is resumed for
  each round, up to `max_rounds` (a gate failure uses a round).
- Push only `factory/*` branches, merge only with `gh pr merge` after syncing with
  `origin/main` and gating again, never deploy. One PR per issue.
- The approver escalates anything that needs human judgment: auth, payments, data
  migrations, secrets, new dependencies, or breaking changes.

## Discord pipeline notifications

Notifications are optional and disabled by default. In `factory/config.json`, select
only the events you want:

```json
"notifications": {
  "enabled": true,
  "events": ["job.started", "job.needs_human", "job.failed", "job.merged"]
}
```

Supply `FACTORY_DISCORD_WEBHOOK_URL` in the environment of the factory process,
using your local secret manager. Never put this bearer credential in configuration,
Git, issue text, job artifacts, or command-line arguments. The only accepted format is
`https://discord.com/api/webhooks/<numeric-id>/<token>` (also `discordapp.com`, the
`ptb.`/`canary.` hosts and an `/api/v<N>/` prefix; no query, fragment, credentials,
other host, or port). Missing/invalid URLs or unsupported event ids
skip delivery with a static `notifications: invalid_config` diagnostic, not the URL.
The default configuration is `{"enabled": false, "events": []}`; absent/disabled
configuration does not make requests. There is no interactive setup or Discord bot.

| Event | Meaning |
|---|---|
| `job.started` | A new job has been persisted (not an idempotent `new` call). |
| `stage.changed` | Any effective persisted stage change, including promotions and intermediate merging. |
| `job.needs_human` | The job enters `needs-human`. |
| `job.failed` | The job ends at `rejected`; gate/review retries are stage changes, not terminal failures. |
| `job.succeeded` | Successful terminal stage `merged`; alias of `job.merged`. |
| `job.merged` | The job reaches `merged`. |

Exactly one selected event is sent per change: a selected specific event takes
precedence over `stage.changed`; `job.merged` takes precedence over `job.succeeded`.
Messages contain the job id, issue number, job title, event, from/to stages, the
generated result (`succeeded` on `merged`, `failed` on `rejected`), the transition note,
GitHub issue/PR links when available, and the timestamp. Title and note are untrusted
free text: they are cut to one line of 200/300 characters, common credential shapes
(webhook and credential-bearing URLs, GitHub/OpenAI/Slack/AWS tokens, JWTs, private
keys, `Bearer ...`, `password=`/`token:`-style pairs, long opaque strings) are replaced
by `[redacted]`, and Markdown, masked links, autolinks and mentions are shown literally;
`allowed_mentions` is empty, so nobody is pinged. Redaction is best-effort: do not put
secrets in issue titles or `--note` text. Issue bodies, environment values, worktree
paths, costs and other job artifacts are never sent.
[Discord's webhook reference](https://github.com/discord/discord-api-docs/blob/main/developers/resources/webhook.mdx)
describes the JSON format used by this connector.

Delivery is **best-effort**, after persistence, independent of pipeline success.
Requests use a 1.5-second timeout and reject redirects. Static delivery diagnostics
(`sent`, `failed`, `timeout`, `rate_limited`) go to stderr, never response bodies or
exception details. No immediate automatic retry is attempted (including HTTP 429),
to avoid rate-limit storms and ambiguous timeout duplicates. Failed events may be
resubmitted to the dispatcher; successful deliveries and in-flight requests are
deduplicated per adapter and deterministic job/event/from/to/round id. The most
recent 512 successful ids are retained in memory only: separate CLI processes or
restarts may duplicate events, crashes can lose them, and there is no outbox or
guaranteed delivery. No new job/board fields or persistent delivery state are used.

Run focused tests without network access:
`node --test test/notifications.test.js test/discord-notifications.test.js`.
