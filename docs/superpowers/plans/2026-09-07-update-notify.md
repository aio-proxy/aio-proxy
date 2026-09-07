# Notify-and-confirm updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist npm `latest` checks and prompt on Dashboard, CLI, and OS notification; never install on a tick.

**Architecture:** Core owns `update-check.json`. The server controller checks (start / 24h / `GET /latest`), persists, and notifies once per new `latest`. CLI injects `notifyAvailable` and prints a stderr banner from the file. Dashboard shell and Settings share `src/lib/release/`.

**Tech Stack:** TypeScript, Zod 4, Hono, Bun test, rstest, TanStack Query, Paraglide, Changesets.

**Spec:** `docs/superpowers/specs/2026-09-07-update-notify-design.md`

## Global Constraints

- `@aio-proxy/server` must not import `@aio-proxy/cli`.
- Tick never calls `applyUpdate`. Checks never take the apply lock.
- Leftover `server.autoUpdate` still parses; Settings does not rewrite the file solely to delete it.
- User-facing copy through i18n in all five locales, then `bun run i18n:compile`.
- Dashboard modules must not import each other; shared release code lives in `packages/dashboard/src/lib/release/`.
- Colocated tests in same-name directories. Changesets target `aio-proxy` plus touched internals at the same bump.

## File Structure

- `packages/core/src/paths/paths.ts` — `updateCheckPath()`
- `packages/core/src/update-check/` — parse / atomic write
- `packages/server/src/auto-update/` — persist, `check()`, `notifyAvailable`, snapshot `latest`/`outdated`
- `packages/types` + `packages/server/.../release/` — GET `/release` + `/latest`
- `packages/cli` — OS notify hook + stderr banner
- `packages/dashboard/src/lib/release/` + sidebar card
- `packages/i18n/messages/*.json` — `dashboard.update.available`, `cli.update.*`
- `.changeset/every-numbers-flow.md`

## Tasks

1. Core path + `update-check.json` round-trip (invalid file is no check).
2. Controller: tick persists, never applies; notify once per new `latest`; failed fetch keeps previous file.
3. Release HTTP + Zod view (`latest?`, `outdated`).
4. CLI `notifyAvailable` + banner (skip upgrade/`-v`/missing file).
5. Lift dashboard release lib; sidebar card; mount-time `GET /latest`.
6. i18n + changeset + `bun run check` + affected tests.
