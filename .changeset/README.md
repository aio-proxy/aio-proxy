# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). It records intended releases as small markdown files that accumulate on `main` until a release is cut.

## Adding a changeset

Run this whenever a change affects the published packages (the `aio-proxy` CLI launcher, its `@aio-proxy/cli-*` platform binaries, or `@aio-proxy/plugin-sdk`):

```bash
bun changeset
```

Pick the bump level and write a short, user-facing summary. Commit the generated `.changeset/*.md` file alongside your change.

## How releases work here

- All workspace packages are **locked to one version** (`fixed` in `config.json`); private packages are version-bumped too, because their version is compiled into the CLI binary and plugin artifacts.
- On merge to `main`, CI maintains a standing **"chore: release" Version PR** that consumes the accumulated changesets, bumps every package, and updates `CHANGELOG.md`.
- **Merging that Version PR is what triggers a release.** Publishing (tarball via `bun pm pack`, `npm publish` with OIDC/provenance) then runs from `scripts/release.ts`; git tags and GitHub Releases are created automatically.

You do not run `changeset version` or `changeset publish` by hand — CI owns both.
