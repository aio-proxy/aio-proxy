# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). It records intended releases as small markdown files that accumulate on `main` until a release is cut.

## Adding a changeset

Run this whenever a change affects users, then commit the generated `.changeset/*.md` file alongside your change:

```bash
bun changeset
```

Pick the bump level and write a short, user-facing summary.

**Always target a product package** so the note lands in a published Release:

- `aio-proxy` — the CLI launcher / proxy (its `@aio-proxy/cli-*` platform binaries ride along automatically).
- `@aio-proxy/plugin-sdk` — the plugin SDK.

When the change actually lives in an internal package (`@aio-proxy/core`, `server`, `cli`, the plugins), list that package **and** the product package, at the same bump level, and prefix the summary with the area:

```
---
'@aio-proxy/core': minor
'aio-proxy': minor
---

core: fix provider fallback ordering under session affinity
```

Do **not** target only an internal package: the `fixed` group would still bump `aio-proxy`, but its Release notes would be empty. See the Changesets section in the repo `AGENTS.md` for the full rule.

## How releases work here

- All workspace packages are **locked to one version** (`fixed` in `config.json`); private packages are version-bumped too, because their version is compiled into the CLI binary and plugin artifacts.
- On merge to `main`, CI maintains a standing **"chore: release" Version PR** that consumes the accumulated changesets, bumps every package, and updates `CHANGELOG.md`.
- **Merging that Version PR is what triggers a release.** Publishing (tarball via `bun pm pack`, `npm publish` with OIDC/provenance) then runs from `scripts/release.ts`; git tags and GitHub Releases are created automatically.

You do not run `changeset version` or `changeset publish` by hand — CI owns both.
