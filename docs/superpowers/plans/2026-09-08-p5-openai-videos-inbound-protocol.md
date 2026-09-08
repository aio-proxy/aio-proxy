# P5 OpenAI Videos Inbound Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #210 by documenting the already-shipped Codex Realtime ports and adding a raw-only official OpenAI Videos job protocol with a pin store.

**Architecture:** New `ProviderProtocol.OpenAIVideo` plus `defineVideoProtocolAdapter` (`capability: 'video'`). Create and unpinned edits/extensions go through `handleProtocolRequest` (same-protocol raw, else 501). Retrieve/content/delete/remix and pinned edits/extensions use an in-process job store and pinned raw — not a second generation loop. Codex realtime is README-only.

**Tech Stack:** TypeScript, Bun test runner, Zod 4 (`z.compile`), Hono, `es-toolkit`.

**Issue:** [aio-proxy/aio-proxy#210](https://github.com/aio-proxy/aio-proxy/issues/210) (parent [#204](https://github.com/aio-proxy/aio-proxy/issues/204)). Spec: `docs/superpowers/specs/2026-09-08-p5-realtime-videos-design.md`.

## Global Constraints

- Ports: shipped Videos paths and registered 501s from the spec ship table. Do not register `/v1/videos/generations`.
- Convert is never implemented. `videoModel` is not added to Provider V4 or `ModelCatalog`.
- `attemptDispatch` must gain a `video` arm before the audio fallthrough.
- Job store capacity `1024`, default TTL 24h, video id `[A-Za-z0-9_-]{1,128}`.
- Omitted create `model` looks up `sora-2`. Prompt is required.
- Stolen pin is 403 without upstream fetch. Missing pin is 404.
- Handwritten non-test files stay under 500 lines; split by responsibility at 400.
- Colocated tests in same-name directories.
- One changeset, `minor`, targeting `aio-proxy` plus every internal package that changes, same bump level.
- Prefer narrow `es-toolkit` imports; `isPlainObject` for parsed payloads, `isRecord` from `@aio-proxy/shared` for structural contracts.
- Do not change Codex realtime behavior.

## File map

**New**

- `packages/core/src/protocol/video-adapter/` — factory
- `packages/core/src/ingress/openai-video/` — parse + omitted-model default
- `packages/core/src/protocol/openai-video/` — create/edits/extensions adapter
- `packages/server/src/routes/videos/` — job store, pinned raw, 501 table, route registration
- `packages/server/src/routes/openai-videos.ts` — thin create + unpinned edits/extensions
- `packages/server/__tests__/video-routing.test.ts` — behavior-level routing
- `.changeset/<id>.md`

**Modified (exhaustiveness / wiring)**

- `packages/types/src/provider-endpoints/provider-endpoints.ts` — enum
- `packages/plugin-sdk/src/runtime.ts` — `ProtocolId`
- `packages/core/src/protocol/adapter.ts` — `InboundCapability`
- `packages/core/src/protocol/errors.ts` — Videos error mapper
- `packages/core/src/protocol/index.ts` — exports
- `packages/core/src/provider/api/api.ts` and `openai-stream-fetch.ts`
- `packages/server/src/runtime.ts` — `InboundCapability`
- `packages/server/src/provider-runtime/capability-index/`
- `packages/server/src/routes/pipeline/` — dispatch, filter, success hook
- `packages/server/src/server/server.ts`, `server-state/*`
- Probe, passthrough-usage, catalog protocol switches, dashboard `protocol-label`
- `README.md`, `README.zh-Hans.md`, `npm/aio-proxy/README.md` if still a hand copy

---

## Task 1: Protocol id and capability enum

**Files:** types provider-endpoints (+ test), plugin-sdk `ProtocolId`, both `InboundCapability` declarations, `PROTOCOL_CAPABILITIES` + `supportsVideo`.

- [ ] Add `OpenAIVideo = 'openai-video'` to the enum and schema test (mirror the audio test).
- [ ] Add `'openai-video'` to `ProtocolId`.
- [ ] Add `'video'` to both `InboundCapability` unions.
- [ ] `PROTOCOL_CAPABILITIES[OpenAIVideo] = ['video']`; extra/primary `openai-video` grants `video` to finite ids; `modalities.output` including `video` grants per id.
- [ ] Export `supportsVideo`.
- [ ] Commit.

## Task 2: Video adapter factory + ingress + create adapter

**Files:** `video-adapter/`, `ingress/openai-video/`, `openai-video/`, `errors.ts`.

- [ ] `defineVideoProtocolAdapter`: `capability: 'video'`, shared parse/model/raw/errors, optional `convertSkipReason` defaulting to `'video_convert'`. No invocation/egress hooks.
- [ ] Parse JSON + multipart. Default model `sora-2`. Required prompt. `modelDefaulted` / `clientModel` like Images.
- [ ] `openAIVideosAdapter` for create (and edits/extensions via context `{ operation }`).
- [ ] `openAIVideosErrors` per the spec table. `unsupported('video')` → 501 no-candidate message. `unsupported('video_convert')` → 501 `unsupported_feature`.
- [ ] Adapter tests: default, inject resolved model, no-op bytes, missing prompt 400.
- [ ] Commit.

## Task 3: Pipeline video arm + success hook

**Files:** `attempt.ts`, `capability-filter`, `pipeline/index.ts`, `noCandidateFeature`.

- [ ] Filter inbound `video` with `supportsVideo`.
- [ ] `attemptDispatch` `video` arm: raw or `unsupportedDispatch`. Must not fall through to audio.
- [ ] `onSuccessfulAttempt` on handle/attempt options; called once on winning return; hook throw must not replace 2xx.
- [ ] Test: raw-less video provider is 501 `video_convert`, not a speech invoke.
- [ ] Commit.

## Task 4: Job store + pinned routes

**Files:** `packages/server/src/routes/videos/`, `openai-videos.ts`, server mount, `ServerState`.

- [ ] Job store: insert (no replace), lookup, remove, capacity, expiry, owner equality, close.
- [ ] `POST /v1/videos` via pipeline + pin on 2xx.
- [ ] Pinned GET/DELETE/content/remix; edits/extensions pin-first then pipeline.
- [ ] 501 table for list + characters. Do not register `/v1/videos/generations`.
- [ ] Caller principal + account pin like realtime hangup.
- [ ] Tests: pin retrieve, 403 stolen, 404 missing, remix pins new id, list 501, generations 404.
- [ ] Commit.

## Task 5: Exhaustiveness, probe, usage, dashboard, README

- [ ] Every `ProviderProtocol` switch: `openai-video` arm. Probe is `GET /v1/models`.
- [ ] Dashboard `PROTOCOL_LABELS` exhaustive; not in `PROTOCOL_ORDER`.
- [ ] README (en + zh, npm copy if hand-maintained): Realtime + Videos rows and notes from the spec.
- [ ] Changeset `minor` for `aio-proxy` plus changed internals.
- [ ] `bun run check` and affected package tests.
- [ ] Commit.

## Task 6: Preflight

- [ ] `bun run preflight` (or `bun run check` + affected tests if preflight is blocked by a pre-existing error).
- [ ] Fix regressions.
- [ ] Commit if needed.
