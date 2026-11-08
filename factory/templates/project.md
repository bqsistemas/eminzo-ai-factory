# Project context

Every factory agent reads this before working. Keep it short and current: agents use
it as a map instead of searching the repo. The builder updates it in the same branch
when a change alters the stack, the commands or the modules; the gate flags a
`Module map` that misses added or moved files.

## Snapshot

- Date and last job that updated this file: <YYYY-MM-DD, after job NNN>
- What the project is, in one or two lines.

## Product and functional context

- Problem solved, intended users/actors, and the product's core value.
- Core capabilities and domain concepts; distinguish confirmed behavior from unknowns.
- Important end-to-end workflows, business rules/permissions, and external integrations.
- Trace representative flows from UI/API/entrypoints through services to persistence; cite
  relevant modules and corroborate behavior with tests or documentation.

## Stack

- Language and runtime, with versions.
- Runtime and dev dependencies that matter, and how they are pinned.

## Commands

- Run: `<command>`
- Test: `<command>`
- Build: `<command>`

## Module map

One line per module or folder: its path in backticks, then what it does. Use a folder
(`src/`) or a glob (`lib/*`, `office*.js`) to cover a group. Keep it complete: the gate
flags files a job adds or moves that no line mentions.

- `<path>`: <what it does>

## UI contract (optional: only when the project has a UI)

- Design tokens: where they live and what they are named.
- Breakpoints and viewports the UI must work at.
- i18n: the languages, and which ones run longer.
- Stable ids and selectors later jobs build on.
- Security headers or CSP the pages must keep.

## Conventions

- Commit style, branch naming, test layout, shell preferences.
- Rules a change must not break.
