# Website Isolation Design

## Goal

Move the Rspress documentation site from `packages/website` to top-level
`website`, while keeping it out of the repository's normal development,
build, and preflight workflows.

## Chosen boundary

`website` remains a Bun workspace package so it can reuse the local
`@aio-proxy/ui` package and root dependency catalog. It is independent in
operation: contributors run its own `dev` and `build` scripts explicitly, and
root application commands do not schedule or check it.

## Changes

- Move `packages/website/` to `website/` without changing its Rspress content
  or shared UI imports.
- Add `website` explicitly to the root workspace package paths, preserving
  `workspace:*` and `catalog:` dependency resolution.
- Exclude `@aio-proxy/website` from root Turbo `dev` and `build` commands.
- Exclude `website/**` from root lint and format commands used by `preflight`.
- Regenerate `bun.lock` so its workspace path matches the moved package.

## Non-goals

- Do not duplicate or publish the shared UI package.
- Do not change the documentation site's content, Rspress configuration, or
  release/changeset membership.
- Do not add a second lockfile or dependency catalog.

## Verification

- Turbo dry-run output for root `dev` and `build` excludes
  `@aio-proxy/website`.
- `bun --filter @aio-proxy/website run build` succeeds.
- Root `bun run preflight` succeeds without checking the documentation site.
