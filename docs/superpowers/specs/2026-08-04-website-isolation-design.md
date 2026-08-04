# Website Isolation Design

## Goal

Move the Rspress documentation site from `packages/website` to top-level
`website`, while keeping it out of the repository's Turbo development, build,
test, and e2e workflows.

## Chosen boundary

`website` remains a Bun workspace package so it can reuse the local
`@aio-proxy/ui` package and root dependency catalog. It is independent in
operation: contributors run its own `dev` and `build` scripts explicitly, and
root Turbo workflows do not schedule it. Root lint and format checks continue
to cover the documentation site.

## Changes

- Move `packages/website/` to `website/` without changing its Rspress content
  or shared UI imports.
- Add `website` explicitly to the root workspace package paths, preserving
  `workspace:*` and `catalog:` dependency resolution.
- Exclude `@aio-proxy/website` from root Turbo `dev`, `build`, test, and e2e
  commands.
- Keep root lint and format commands unchanged so `preflight` checks the
  documentation site.
- Regenerate `bun.lock` so its workspace path matches the moved package.

## Non-goals

- Do not duplicate or publish the shared UI package.
- Do not change the documentation site's content, Rspress configuration, or
  release/changeset membership.
- Do not add a second lockfile or dependency catalog.

## Verification

- Turbo dry-run output for root `dev`, `build`, test, and e2e excludes
  `@aio-proxy/website`.
- `bun run --filter @aio-proxy/website build` succeeds.
- Root `bun run preflight` succeeds while lint and format checks include the
  documentation site.
