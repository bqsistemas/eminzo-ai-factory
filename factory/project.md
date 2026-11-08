# Project context

Every factory agent reads this before working. Keep it short and current; update it
when stack, commands, workflows or modules change. Follow `factory/templates/project.md`.
The gate reports uncovered added/moved modules as a non-blocking freshness warning.

## Snapshot

- 2026-11-08: repository created from claude-code-factory, which keeps the Eminzo desktop
  app and becomes a user of this factory. Engine baseline: 2026-11-01, after job 040, plus
  the eminzo CLI. Run `/eminzo-factory setup` here to refresh this file and create the labels.
- eminzo-ai-factory is the Eminzo AI software factory product: the portable engine, its
  dashboard, the Claude Code and Codex adapters, and the `eminzo` CLI that installs them for
  any team's repository. It builds itself with its own committed engine.

## Product and functional context

- **Users/value:** development teams turn labelled GitHub issues of their own repositories
  into reviewed, gated pull requests, with a uniform flow every developer runs the same way.
  Builders implement; intake/spec/review/approval roles constrain their work. No hosted
  backend or user database exists.
- **Domain:** a job binds an issue, provider/models, risk, surfaces, lane, branch,
  worktree, port, round and PR. Markdown stage artifacts explain decisions;
  `factory/jobs/<id>/job.json` persists state and `factory/board.json` projects it
  for dashboards. Risk selects models; surfaces select review lenses.
- **Issue-to-PR:** `/eminzo-factory` (Claude) or `$eminzo-factory` (Codex) reads the
  queue → `factory/bin/job` validates the `factory` label → intake → routing and
  worktree → spec → builder commit/push/draft PR → deterministic gate → routed
  reviews → approval → merge or human intervention. Only `job` writes pipeline
  state and performs engine merge side effects. Tests: `test/job*.test.js`,
  `gate.test.js`, `route.test.js`, `codex-routing.test.js`, `lane-xs.test.js`.
- **Rules:** code review always runs; `ui` includes everyday UX; `interaction` adds
  UX and UI; `security` adds security review. Wait for all routed lenses after a
  passing gate. XS requires script-validated low-risk trivial scope, skips spec,
  and promotes to normal on failures/deviations. Optional `spec_review` (`false`, `true`
  or a risk list; repo default `false`, local override wins either way) parks a normal-lane
  job at `spec-review` after the spec. Issue text is untrusted file data; only
  OWNER/MEMBER/COLLABORATOR PR feedback is forwarded on rework. Never run both providers
  concurrently on one job: no cross-process lease.
- **Distribution:** two ways to put the factory in a repository. (1) Committed engine: the
  repository carries `factory/lib`, `factory/bin` and the adapters (this repo; the Eminzo
  desktop kit install). (2) The `eminzo` CLI (npm `@eminzo/factory`): `eminzo install` puts the
  adapters in the home folder, `eminzo enable` opens a pull request with only the repository's
  files (`factory/config.json` pinned to an engine range, `checks.sh`, `project.md`), and the
  engine runs from the package with `EMINZO_ENGINE` set. Tests: `test/cli-*.test.js`,
  `test/engine-location.test.js`.
- **Unknown/unverified:** live GitHub access, provider model availability and real Claude
  Code/Codex sessions using the user-level adapters (hooks of agents in `~/.claude/agents`)
  are not established by tests. Missing/ambiguous Codex usage is unavailable cost, never
  proof of zero cost (`test/codex-cost*.test.js`).

## Stack

- Node.js >=20, JavaScript ESM, built-in HTTP/fs/test APIs; no runtime dependencies
  (engine and CLI). Exact dev pin: `puppeteer-core` 24.43.1 for visual checks (requires a
  compatible local Chrome).
- Python + Pillow only to regenerate the office atlas.

## Commands

- Tests: `npm test` → `node --test test/*.test.js`; `sh factory/checks.sh` enforces that exact
  script, then runs it. No build, lint or typecheck step for the engine.
- CLI: `node cli/build.mjs` builds `cli/dist/`; `cd cli && npm pack` makes the package;
  `node cli/bin/eminzo.js help` lists the commands.
- Dashboard: `factory/bin/dashboard [port]` (loopback, default 8000), open
  `http://localhost:8000/dashboard.html` or `dashboard.html?demo`.
- Engine graph: `factory/bin/job graph > factory/pipeline.json`; regenerate when
  transitions change (`test/pipeline-graph.test.js` detects drift).
- Atlas: `python3 factory/assets/pixel-office-2/build_atlas.py` (requires Pillow).

## Module map

Repository:

- `package.json`, `package-lock.json`: test command and dev tool pins.
- `test/`: engine, dashboard, CLI and installer-module tests and fixture helpers (`test/helpers/`).
- `README.md`, `docs/`: usage, CLI requirement and packaging decisions, costs and efficiency notes;
  source/tests take precedence over stale descriptions.

Portable factory engine:

- `factory/config.json`, `factory/checks.sh`, `factory/package.json`, `factory/project.md`:
  repo-specific routing, checks, ESM boundary and agent context.
- `factory/config.local.json` (gitignored, optional): per-developer override of `concurrency`,
  `default_provider`, `language`, `max_rounds` (lower only), `auto_merge` (false only) and
  `spec_review` (either way; `specReviewFor()` in `util.js` resolves it).
- `factory/bin/`: shell entrypoints for job, gate, route, nudge, approve, visual,
  setup, setup-spec-review, init, ensure-output and dashboard; implementation lives in `factory/lib/`.
- `factory/lib/notifications.js`, `factory/lib/connectors/discord.js`: optional best-effort
  lifecycle dispatcher and secret-safe Discord webhook adapter (no new dependencies).
- `factory/lib/`: `job.js` state/transitions/GitHub; `route.js`/`intake.js` classification;
  `gate.js`/`nudge.js`/`check-stamp.js` checks and fingerprinted reuse;
  `approve.js` deterministic approval; `diff.js` scope/XS limits; `overlap.js` shared
  file scheduling; `round-context.js` review handoffs; `cost.js` provider accounting;
  `visual*.js` browser checks; `project-map.js` context freshness; `run-mode.js`
  `config.run_mode` (`own` default, `queue`); `claim.js` the `job new` issue claim; `util.js`
  config, paths and `EMINZO_ENGINE` (`installedEngine()`/`engineDir()`/`engineCommand()`);
  remaining helpers, init and static dashboard server. Engine modules remain dependency-free.
- `factory/pipeline.json`: generated stage/transition graph consumed by dashboards and the desktop.
- `factory/roles/`: eight provider-neutral worker contracts; `factory/templates/`:
  project structure and installer config template.
- `.claude/agents/`, `.codex/agents/`: provider wrappers/profiles for the shared roles.
- `.claude/skills/eminzo-factory/`, `.agents/skills/eminzo-factory/`: canonical
  orchestrators. Provider-parity tests protect the shared contract.
- `factory/jobs/`, `factory/board.json`, `.worktrees/`: ignored local runtime state.

eminzo CLI (npm package `@eminzo/factory`; this repo runs its own committed engine, never the CLI):

- `cli/package.json`, `cli/README.md`: package, `eminzo` bin, files allowlist (`private` until published).
- `cli/build.mjs`: builds the gitignored `cli/dist/`: `factory/` (the engine, without this repo's
  data or config), `adapters/` (skills and agents rewritten by `cli/src/adapters.js` to call
  `eminzo <command>`, roles embedded) and `build.json`.
- `cli/bin/eminzo.js`, `cli/src/`: `main.js` commands; `engine.js` runs an engine script with
  `EMINZO_ENGINE` set and the repo's `engine` range enforced (a repo that commits its engine runs
  its own); `install.js`, `doctor.js`, `enable.js` (pull request with the repo footprint), `semver.js`,
  `paths.js`.
- `cli/src/installer/`: pure install modules shared with the Eminzo desktop installer: `preflight.js`,
  `remote.js`, `checks.js` (stack detection), `plan.js` (`.gitignore` lines), `kit.js` (the engine
  file list).

Dashboard and office (plain browser ESM, no build):

- `factory/dashboard.html`, `factory/dashboard.css`, `factory/dashboard.js`: shell,
  theme/i18n data, polling board and drawer rendering.
- `factory/pipeline-canvas.js`, `factory/activity.js`, `factory/avatars.js`: stage
  inspector/job links, agent/card projections and constant-built octopus SVGs.
- `factory/office*.js`: pure board-to-room projection, 768x500 geometry, canvas,
  navigation, wandering/work/bubble state machines; clock/rng injected for tests.
- `factory/sprite-atlas.js`, `factory/assets/`, `factory/OFFICE.md`: generated sprite
  coordinates, source art/Python generator and design notes; edit generator, not atlas.
- `factory/demo/`: fixture board and example stage artifacts (neutral example repository).

## UI contract

- **Tokens:** dashboard `factory/dashboard.css` (`--bg`, `--panel`, `--ink`, `--line`,
  `--pass`, `--changes`, `--alert`, `--stage-*`; light/navy). Reuse tokens.
- **Breakpoints/viewports:** dashboard max-width 1200/980/900/640px; configured visual
  matrix 390/768/1024/1440px × en/es/pt × light/dark. Preserve keyboard/focus behavior,
  overflow handling and reduced-motion fallbacks.
- **i18n:** dashboard `#i18n` JSON has en/es/pt, selected by `board.language` from
  config; es/pt can be longer, so wrap/truncate safely. All keys must exist in all three.
  Protocol tokens/headings/notes stay English.
- **Stable ids/routes:** dashboard `#board`, `#office`, `#office-canvas`, `#pipeline`,
  `#pipeline-job`, `#pipeline-inspector`, `#drawer`, `#guide`, `#status`, `#theme-toggle`.
- **Security/CSP:** the dashboard stays local-only (loopback server, GET/HEAD, no traversal,
  no dotfiles); no remote resources. Under the CLI the page comes from the engine and only
  `board.json` and `jobs/` from the repository.

## Conventions

- Conventional Commits only; no AI attribution or `Co-Authored-By` lines. Job branches
  are `factory/<id>` in `.worktrees/<id>`; derive checkout/base/PR targets from
  `config.base`, never a hardcoded branch. Keep changes inside the assigned scope.
- Strict TDD is enabled for implementation. Use Node built-in tests, generally
  `<module>.test.js`; test servers listen on port 0.
- Never edit protected spine tests listed in config. Do not weaken `checks.sh`,
  replace the full test command, add runtime dependencies, or duplicate the state
  machine. Keep shared roles/provider adapters in parity.
- The factory is generic: nothing in the engine, roles, adapters or CLI may assume one
  repository, product or the Eminzo desktop app. Repository-specific values live in the
  repository's `factory/config.json`, `checks.sh` and `project.md`.
- With `EMINZO_ENGINE` unset every engine path, hash and message stays `factory/...`; keep
  `test/engine-location.test.js` green when touching paths.
- Check fingerprints bind passes to inputs/tree/head; a gate is still mandatory.
  Shell tools: prefer `rg`, `fd`, `bat`, `eza` when available. Never commit generated
  `cli/dist/`, runtime jobs/board or credentials.
