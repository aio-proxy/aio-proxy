# Published Provider Schemas Dependency Implementation Plan

> **For agentic workers:** Execute inline. This is a dependency/configuration migration, so preserve behavior with the existing server route tests rather than adding duplicate test-only configuration assertions.

**Goal:** Remove the local provider-schemas workspace and consume `@aio-proxy/provider-schemas@0.1.1` from the public npm registry.

**Architecture:** The server keeps the existing package API imports but resolves them from npm. Local schema generation, Rslib integration, tarball caching, and their build orchestration are deleted.

**Tech Stack:** Bun 1.3.14, Turbo, TypeScript, Bun test.

## Global Constraints

- Use exact version `0.1.1`.
- Install only from `https://registry.npmjs.org/`.
- Do not keep a workspace compatibility package.
- Delete the eight superseded provider-schema specs and plans.
- Do not commit or push.

---

### Task 1: Switch dependency resolution

**Files:**
- Modify: `packages/server/package.json`
- Modify: `bun.lock`

- [ ] Run the existing server provider-options schema test as a baseline.
- [ ] Replace `workspace:*` with exact version `0.1.1`.
- [ ] Run `bun install --registry=https://registry.npmjs.org/` and verify the lockfile resolves the registry package.
- [ ] Re-run the server provider-options schema test against the installed package.

### Task 2: Delete local generation and orchestration

**Files:**
- Delete: `packages/provider-schemas/`
- Modify: `packages/cli/package.json`
- Modify: `turbo.json`
- Delete: the four superseded provider-schema specs and their four matching plans.

- [ ] Delete the workspace package and old documents.
- [ ] Change CLI `build:binary` to `bun scripts/build-binary.ts`.
- [ ] Remove the `@aio-proxy/provider-schemas#build` Turbo override.
- [ ] Search active files and the lockfile for stale workspace/build references.

### Task 3: Verify the migration

**Files:**
- Verify: `packages/server/_test/dashboard-provider-options-schema.test.ts`
- Verify: repository configuration and package graph.

- [ ] Run `bun run check`.
- [ ] Run `bun run --filter @aio-proxy/server test:unit`.
- [ ] Run `bun run preflight`.
- [ ] Run `bun run --filter @aio-proxy/cli build:binary`.
- [ ] Inspect `git diff` and confirm no unrelated files changed.
