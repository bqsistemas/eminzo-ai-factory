# Releasing

This repository publishes two products from one GitHub Releases page: the CLI (`@eminzo/factory`) and the Eminzo desktop app. Only the desktop app's built binaries are published here.

## The rules

| | CLI | Desktop app |
|---|---|---|
| Tag | `vX.Y.Z` | `desktop-vX.Y.Z` |
| Published by | `npm run release:cli` (GitHub Release) and `npm publish` (npm) | the desktop build (electron-builder), as a **draft** |
| "Latest" | **Never.** Always `--latest=false` | **Always.** Mark it when you publish the draft |

**Why.** The desktop app updates itself with electron-updater, which asks `https://github.com/bqsistemas/eminzo-ai-factory/releases/latest` and reads `latest-mac.yml`, `latest.yml` or `latest-linux.yml` from that release. If a CLI release becomes "Latest", installed apps stop seeing updates.

The workflow `.github/workflows/keep-desktop-latest.yml` is the safety net: when any non-desktop release is published or edited, it restores "Latest" to the newest published desktop release. Do not rely on it; follow the rules. Releases are cut from `main`, and the safety net only runs for tags whose commit already contains this workflow (GitHub runs the workflow as it exists at the tagged commit), so a release tagged before it landed is not covered.

## Asset names (contract)

The desktop build publishes exactly these names, so the download links stay stable:

| Platform | Assets |
|---|---|
| macOS | `Eminzo-mac-arm64.dmg`, `Eminzo-mac-x64.dmg`, `Eminzo-mac-arm64.zip`, `Eminzo-mac-x64.zip` |
| Windows | `Eminzo-win-x64.exe` |
| Linux | `Eminzo-linux-x64.AppImage`, `Eminzo-linux-x64.deb` |

Auto-update also needs these files on the same release, uploaded by the desktop build: `latest-mac.yml`, `latest.yml`, `latest-linux.yml`, and the `*.blockmap` files next to the installers. Without them installed apps cannot update.

Link form: `https://github.com/bqsistemas/eminzo-ai-factory/releases/latest/download/<name>`. Changing a name breaks the README links.

## Flow 1: CLI only

1. Bump `version` in `cli/package.json` and commit it: `chore(release): eminzo X.Y.Z`. Merge to `main` and pull.
2. Tag the release commit and push the tag:

   ```sh
   git tag -a vX.Y.Z -m "eminzo X.Y.Z"
   git push origin vX.Y.Z
   ```

3. Check the plan, then create the GitHub Release:

   ```sh
   npm run release:cli -- --dry-run   # prints the gh command
   npm run release:cli
   ```

   The script requires `main`, a clean tree, and `vX.Y.Z` on HEAD both locally and on origin. It refuses `desktop-` versions and always passes `--latest=false`. Use `--notes-file <path>` instead of generated notes if you wrote some.
4. Publish to npm yourself (the script never does): `cd cli && npm publish`. `prepack` builds and `prepublishOnly` runs the tests.
5. Verify (see below): the CLI release must not be Latest.

## Flow 2: desktop only

1. Run the desktop build's release step for each platform (macOS, Windows, Linux). It uploads the assets to a **draft** release tagged `desktop-vX.Y.Z` in this repository.
2. Check the draft: the seven asset names above, the `latest-mac.yml`, `latest.yml` and `latest-linux.yml` files and the `*.blockmap` files are present.
3. Publish it and mark it Latest in one step:

   ```sh
   gh release edit desktop-vX.Y.Z --draft=false --latest
   ```

4. Verify (see below).

## Flow 3: both

Do the CLI first, then the desktop app, so the desktop release is the last one published and ends as Latest.

1. Flow 1 completely (tag, `release:cli`, `npm publish`).
2. Flow 2 completely.

If you must do the desktop first, the workflow will restore Latest when the CLI release is created, but check anyway.

## Fixing a wrong "Latest"

The workflow does it: a CLI release that took "Latest" triggers it on publish or edit, and it PATCHes the newest desktop release with `make_latest=true`. To do the same by hand:

```sh
gh release edit desktop-vX.Y.Z --latest
```

Or run it locally with `GH_TOKEN` set and `GITHUB_REPOSITORY=bqsistemas/eminzo-ai-factory`: `node scripts/keep-desktop-latest.mjs`.

## Verification

```sh
# The desktop release is Latest, the CLI release is not
gh release view desktop-vX.Y.Z --repo bqsistemas/eminzo-ai-factory --json isLatest,isDraft
gh release view vX.Y.Z --repo bqsistemas/eminzo-ai-factory --json isLatest

# What /releases/latest resolves to
gh api repos/bqsistemas/eminzo-ai-factory/releases/latest --jq .tag_name

# A download link answers (302 then 200)
curl -sIL -o /dev/null -w '%{http_code}\n' \
  https://github.com/bqsistemas/eminzo-ai-factory/releases/latest/download/Eminzo-mac-arm64.dmg
```

`isLatest` must be `true` for the desktop release and `false` for the CLI release, and `/releases/latest` must name a `desktop-v` tag.
