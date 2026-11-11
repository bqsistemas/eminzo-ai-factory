# Eminzo AI Factory

Conventions for AI assistants working in this repository.

## Commits

- Conventional commits (`feat:`, `fix:`, `docs:`, `chore(release):` ...).
- No `Co-Authored-By` lines and no AI attribution in commits, PRs or docs.
- Keep tests and docs in the same commit as the change they cover.

## Tests

- `npm test` runs `node --test test/*.test.js`. Write the failing test first.

## Releases

Follow [docs/releasing.md](docs/releasing.md). Do not improvise.

- CLI releases use tags `vX.Y.Z`. Never create a CLI GitHub Release without `--latest=false`; use `npm run release:cli`.
- Desktop releases use tags `desktop-vX.Y.Z`, are published as drafts by the desktop build, and must be marked Latest when published (`gh release edit desktop-vX.Y.Z --draft=false --latest`).
- Why: the desktop app auto-updates from `releases/latest`; a CLI release holding "Latest" breaks updates.
- Never run `npm publish` or push tags on your own; those are human steps.
- Never change the desktop asset names listed in the runbook: the README download links depend on them.
