# Agent Provider Package Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the three Agent integration packages under `packages/agent-provider/{runtime,opencode,pi}` without changing their package names, exports, artifacts, or runtime behavior.

**Architecture:** This is a physical workspace-layout migration only. Bun discovers the nested packages through an explicit `packages/agent-provider/*` workspace glob; all JavaScript/TypeScript imports continue to use the existing `@aio-proxy/*` package identities.

**Tech Stack:** Bun workspaces, Turborepo, TypeScript, Rslib.

**Spec:** `docs/superpowers/specs/2026-08-18-agent-provider-integrations-design.md`

## Global Constraints

- The final physical paths are exactly `packages/agent-provider/runtime`, `packages/agent-provider/opencode`, and `packages/agent-provider/pi`.
- Keep package names `@aio-proxy/agent-provider-runtime`, `@aio-proxy/opencode-provider`, and `@aio-proxy/pi-provider` unchanged.
- Do not change provider behavior, public exports, build artifacts, host compatibility scope, or plugin API versions.
- OpenCode remains V1-only; V2 `effect` support stays deferred.
- Regenerate `bun.lock` from the moved workspace manifests instead of hand-editing workspace paths.

---

### Task 1: Move the workspace packages

**Files:**
- Move: `packages/agent-provider-runtime` to `packages/agent-provider/runtime`
- Move: `packages/opencode-provider` to `packages/agent-provider/opencode`
- Move: `packages/pi-provider` to `packages/agent-provider/pi`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: the three existing package manifests and package identities.
- Produces: the same three Bun workspace packages at the nested physical paths.

- [ ] **Step 1: Move all three directories with Git-aware renames**

Run:

```bash
mkdir -p packages/agent-provider
git mv packages/agent-provider-runtime packages/agent-provider/runtime
git mv packages/opencode-provider packages/agent-provider/opencode
git mv packages/pi-provider packages/agent-provider/pi
```

- [ ] **Step 2: Add nested workspace discovery**

Add `"packages/agent-provider/*"` to `workspaces.packages` in the root `package.json`; keep the existing workspace globs unchanged.

- [ ] **Step 3: Regenerate and verify the lockfile**

Run:

```bash
bun install
bun run --filter @aio-proxy/agent-provider-runtime test:unit
bun run --filter @aio-proxy/opencode-provider test:unit
bun run --filter @aio-proxy/pi-provider test:unit
```

Expected: Bun resolves each package from its new `packages/agent-provider/*` path and every unit suite passes.

### Task 2: Align documentation and verify the full product

**Files:**
- Modify: `docs/superpowers/specs/2026-08-18-agent-provider-integrations-design.md`
- Modify: `docs/superpowers/plans/2026-08-18-agent-control-plane.md`
- Modify: `docs/superpowers/plans/2026-08-18-opencode-provider.md`
- Modify: `docs/superpowers/plans/2026-08-18-pi-family-provider.md`
- Modify: `docs/superpowers/plans/2026-08-18-agent-cli-lifecycle.md`

**Interfaces:**
- Consumes: the final paths from Task 1.
- Produces: plans/specs whose physical paths match the implemented layout.

- [ ] **Step 1: Replace stale physical paths**

Replace only physical repository paths:

```text
packages/agent-provider-runtime -> packages/agent-provider/runtime
packages/opencode-provider -> packages/agent-provider/opencode
packages/pi-provider -> packages/agent-provider/pi
```

Keep all `@aio-proxy/*` package names unchanged. Remove the Pi plan constraint that forbids the nested layout.

- [ ] **Step 2: Prove no stale physical paths remain**

Run:

```bash
rg -n "packages/(agent-provider-runtime|opencode-provider|pi-provider)" package.json bun.lock packages docs/superpowers --glob '!**/2026-08-20-agent-provider-package-layout.md'
```

Expected: no matches outside this plan's source-to-destination migration map.

- [ ] **Step 3: Run release-grade verification**

Run:

```bash
bun run preflight
bun run --filter @aio-proxy/opencode-provider test:compat
bun run --filter @aio-proxy/pi-provider test:compat
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit the focused layout migration**

Stage only the three renames, root workspace/lock changes, and aligned documentation. Commit with:

```text
refactor: group Agent provider packages

Co-authored-by: Codex <noreply@openai.com>
```
