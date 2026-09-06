# P4 OpenAI Audio Inbound Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inbound `POST /v1/audio/speech`, `POST /v1/audio/transcriptions`, and `POST /v1/audio/translations` as their own protocol with two new inbound capabilities (`speech`, `transcription`), so OpenAI audio clients can TTS/STT through aio-proxy without sharing the Images adapter.

**Architecture:** One new `ProviderProtocol.OpenAIAudio` wire family plus one `defineAudioProtocolAdapter` factory that produces two frozen adapters (`openAISpeechAdapter` with `capability: 'speech'`, `openAITranscriptionAdapter` with `capability: 'transcription'`) sharing one ingress module. The image multipart reader is first generalized into `packages/core/src/ingress/multipart/` so transcriptions stream multipart to disk exactly like Images edits do, never through `readJsonRequest`. `attemptCandidates` stays the only candidate loop and gains one `audio` dispatch arm: same-protocol raw passthrough wins, otherwise the request converts into an AI SDK `generateSpeech` / `transcribe` call. Egress returns a `Response` directly (binary audio for speech; JSON or `text`/`srt`/`vtt` for transcription), which is why audio needs its own `audioResponse` contract instead of the JSON-only `imageJson` / `embeddingJson` ones.

**Tech Stack:** TypeScript, Bun test runner, Zod 4 (`z.compile`), Hono, AI SDK `generateSpeech` / `transcribe` (`ai`), `@ai-sdk/openai` (the only AI SDK package implementing both `speechModel` and `transcriptionModel`), `es-toolkit`.

**Issue:** [aio-proxy/aio-proxy#209](https://github.com/aio-proxy/aio-proxy/issues/209) (parent [#204](https://github.com/aio-proxy/aio-proxy/issues/204)). No design spec exists for P4; this plan is the specification.

## Global Constraints

- Work only inside the existing worktree `/Volumes/ExternalSSD/workspace/aio-proxy/.claude/worktrees/kind-hypatia-4718c2`; do not create or switch worktrees, and never `cd` to the original repository root.
- Never use bare `git stash` / `git stash pop`: the stash stack is shared across worktrees. Use a temporary WIP commit to set work aside.
- Ports are exactly `POST /v1/audio/speech`, `POST /v1/audio/transcriptions`, `POST /v1/audio/translations`. No other audio path is added.
- Out of scope, and no `/v1/realtime`, voice-consent, or vendor music route may be added: Realtime WebSocket audio, voice consents, vendor music APIs.
- Also out of scope because no reference project implements them: transcription `chunking_strategy`, transcription `stream: true` / `stream_format`, and `include[]`. Requests carrying them are passed through unchanged on the raw path and rejected with a protocol-shaped 501 `unsupported_feature` on the convert path.
- Transcriptions and translations MUST read the body as streaming multipart spooled to disk, never through `readJsonRequest`.
- On the raw path, rebuild multipart by copying **every** client form field verbatim and replacing only `model` (new-api's behavior, `relay/channel/openai/adaptor.go:435-470`), so fields like `timestamp_granularities[]` survive. Never whitelist fields on the raw path.
- Streaming (`stream: true`) is never used to detect audio streaming: OpenAI signals transcription streaming with `stream_format == 'sse'` (new-api `relaykit/dto/audio.go:43-45`). `wantsStream` returns `false` for both audio adapters.
- Model defaults follow new-api `middleware/distributor.go:536-557`: `tts-1` for `/v1/audio/speech`, `whisper-1` for `/v1/audio/transcriptions` and `/v1/audio/translations`.
- `/v1/audio/translations` has no AI SDK equivalent (`transcribe` cannot translate), so its convert path always reports skip reason `translations`; it is same-protocol raw only. It is still a first-class port and must never be dropped — it is the port every reference project except new-api and OmniRoute misses.
- Never fabricate token counts. Speech and transcription convert results carry no usage, so usage comes from (a) upstream raw JSON `usage` objects and (b) `finalizeUsage`'s `cost.request` seed. `packages/types/src/usage.ts` is NOT modified.
- New inbound capability values are exactly `'speech'` and `'transcription'`, added to both `InboundCapability` declarations: `packages/core/src/protocol/adapter.ts:12` and `packages/server/src/runtime.ts:71`.
- New protocol value is exactly `ProviderProtocol.OpenAIAudio = 'openai-audio'`; the plugin-SDK `ProtocolId` string is exactly `'openai-audio'`.
- Attempt transport tag for the audio convert path is exactly `'audio'`, added to `packages/server/src/routes/pipeline/attempt-base/attempt-base.ts:22` and `packages/server/__tests__/pipeline-helpers/types.ts:52`.
- `packages/server/src/routes/pipeline/attempt/attempt.ts` stays the only candidate loop. `packages/server/src/routes/openai-audio.ts` must contain nothing but three `handleProtocolRequest` calls.
- Handwritten non-test implementation files stay under 500 lines and are split by responsibility at 400. Tests are colocated in same-name directories (`foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`).
- Prefer narrow `es-toolkit` imports; use `isPlainObject` from `es-toolkit/predicate` for parsed wire payloads and `isRecord` from `@aio-proxy/shared` for structural contracts.
- Run `bun run preflight` before the final task's commit; each task runs at minimum the test files it touches, from the worktree root as `bun test <path>`.
- One changeset, `minor`, targeting `aio-proxy` plus every internal package that actually changes (`@aio-proxy/core`, `@aio-proxy/types`, `server`, `@aio-proxy/plugin-sdk`, `@aio-proxy/dashboard`) at the same bump level. Never a changeset that targets only internal packages.

---

## Reference behavior survey

Read before Tasks 3, 5, and 9; these are the decisions the reference projects already litigated.

| Project | `/audio/speech` | `/audio/transcriptions` | `/audio/translations` | How |
| --- | --- | --- | --- | --- |
| new-api (Go) | yes | yes | yes | `router/relay-router.go:128-137` — three routes, one `RelayFormatOpenAIAudio`, path decides relay mode |
| OmniRoute (TS) | yes | yes | yes | three separate route handlers, 20+ vendor adapters |
| 9router (JS) | yes | yes | **no** | two routes plus a non-OpenAI `/v1/audio/voices` |
| claude-code-hub (TS) | catch-all | catch-all | catch-all | byte passthrough only; classifies audio with `accountingTier: "none"` |
| CLIProxyAPI (Go) | **no** | **no** | **no** | only `/v1/realtime/*` |
| oh-my-pi (TS) | **no** | **no** | **no** | TTS/STT client, not a server port |

Decisions adopted here, with the reference that settled them:

- **STT request body:** rebuild multipart copying all fields, replacing only `model` (new-api). OmniRoute and 9router whitelist fields and silently drop `timestamp_granularities[]`; do not copy that.
- **STT response:** pass bytes/text through unchanged so `srt` and `vtt` work (new-api, claude-code-hub). On the convert path, `text`/`srt`/`vtt` are rendered locally from segments.
- **TTS response:** stream `res.body` through rather than buffering (OmniRoute). new-api buffers only to compute duration for billing; 9router base64 round-trips. Neither is worth copying.
- **Billing:** new-api decodes audio duration locally (`common/audio.go:20-49`, PCM branch hardcodes `24000 Hz × 2 bytes × 1 ch`) and bills `1 min = 1000 tokens`; OmniRoute bills TTS by `input.length` characters and gave up on STT. Both fabricate a token count. This plan does neither: it reads OpenAI's real `usage` object when present and otherwise relies on `cost.request`.
- **Do not repeat claude-code-hub's bug** of omitting `/audio/speech` from URL handling (`url.ts:7-17`), nor OmniRoute's body-limit oversight where only `transcriptions` gets the large cap.

---

## File map

Core — protocol and ingress:

- `packages/core/src/ingress/multipart/index.ts` — barrel for the protocol-agnostic multipart reader.
- `packages/core/src/ingress/multipart/multipart-stream.ts` — `ByteWindow` + boundary state machine, parameterized by a `MultipartStreamSpec` (file field names, counters, error factory). Moved out of `ingress/openai-image/multipart-stream.ts`.
- `packages/core/src/ingress/multipart/multipart-spool.ts` — disk spool, 2-slot semaphore, replay request builder, parameterized by a spool filename prefix. Moved out of `ingress/openai-image/multipart-spool.ts`.
- `packages/core/src/ingress/multipart/multipart-stream.test.ts` — generic reader tests (field-only parts, per-file limits, boundary split across chunks).
- `packages/core/src/ingress/openai-audio/index.ts` — audio ingress barrel.
- `packages/core/src/ingress/openai-audio/openai-audio.ts` — Zod schemas + `parseOpenAISpeech`, `parseOpenAITranscription`, model defaults.
- `packages/core/src/ingress/openai-audio/multipart.ts` — transcription multipart entry point over the generic reader.
- `packages/core/src/ingress/openai-audio/openai-audio.test.ts` — schema/default/validation tests.
- `packages/core/src/ingress/openai-audio/multipart.test.ts` — multipart transcription parse tests.
- `packages/core/src/protocol/audio-adapter/index.ts` — barrel.
- `packages/core/src/protocol/audio-adapter/audio-adapter.ts` — audio invocation/result/egress types, `AudioProtocolAdapter`, `defineAudioProtocolAdapter`, `isAudioProtocolAdapter`.
- `packages/core/src/protocol/audio-adapter/audio-adapter.test.ts` — factory freeze/default tests.
- `packages/core/src/protocol/openai-audio/index.ts` — barrel.
- `packages/core/src/protocol/openai-audio/openai-audio.ts` — `openAISpeechAdapter`, `openAITranscriptionAdapter`, raw rewrite, invocation conversion, egress.
- `packages/core/src/protocol/openai-audio/transcription-egress.ts` — private collaborator rendering `json` / `verbose_json` / `text` / `srt` / `vtt`.
- `packages/core/src/protocol/openai-audio/transcription-egress.test.ts` — rendering tests.
- `packages/core/src/protocol/openai-audio/openai-audio.test.ts` — adapter behavior tests.
- `packages/core/src/protocol/adapter.ts` — `InboundCapability` gains `'speech' | 'transcription'`.
- `packages/core/src/protocol/request.ts` — `stripHopHeaders` becomes exported and shared.
- `packages/core/src/protocol/errors.ts` — `openAIAudioErrors`.
- `packages/core/src/error.ts` — `OpenAIAudioUnsupportedFeatureError`, `OpenAIAudioInvalidRequestError`.
- `packages/core/src/provider/provider-v4-audio/index.ts` — barrel.
- `packages/core/src/provider/provider-v4-audio/provider-v4-audio.ts` — `createProviderV4SpeechInvoke`, `createProviderV4TranscribeInvoke`.
- `packages/core/src/provider/provider-v4-audio/provider-v4-audio.test.ts` — transport tests with injected AI SDK functions.
- `packages/core/src/ai-sdk-bridge/index.ts` — re-export `generateSpeech`, `transcribe`.

Types and plugin SDK:

- `packages/types/src/provider-endpoints/provider-endpoints.ts` — `ProviderProtocol.OpenAIAudio`.
- `packages/plugin-sdk/src/runtime.ts` — `ProtocolId` gains `'openai-audio'`; `RawResolver` capability gains `'speech' | 'transcription'`.

Server — runtime and dispatch:

- `packages/server/src/runtime.ts` — `InboundCapability`, `SpeechTransport`, `TranscriptionTransport`, `RawResolveInput.capability`, two new `RuntimeProviderInstance` arms.
- `packages/server/src/provider-runtime/capability-index/capability-index.ts` — `speech`/`transcription` catalogs, `supportsSpeech`, `supportsTranscription`.
- `packages/server/src/provider-runtime/materialize-audio/index.ts` — barrel.
- `packages/server/src/provider-runtime/materialize-audio/materialize-audio.ts` — `attachAudioTransports`.
- `packages/server/src/provider-runtime/materialize-audio/materialize-audio.test.ts` — bridge-selection tests.
- `packages/server/src/provider-runtime/materialize.ts` — audio capability in the materialized-instance guard and the attach chain.
- `packages/server/src/plugin-runtime/capabilities.ts` — `pluginProtocol`, `catalogModelIds`, audio arms in `createRuntimeProvider`.
- `packages/server/src/routes/pipeline/attempt/audio.ts` — `dispatchAudioCandidate`, `attemptAudioCandidate`.
- `packages/server/src/routes/pipeline/attempt/audio.test.ts` — dispatch tests.
- `packages/server/src/routes/pipeline/attempt/context.ts` — `PipelineAdapter` widening, `AudioAttemptLoopContext`.
- `packages/server/src/routes/pipeline/attempt/attempt.ts` — fourth dispatch arm.
- `packages/server/src/routes/pipeline/attempt/capability-filter/capability-filter.ts` — audio branches.
- `packages/server/src/routes/pipeline/index.ts` — adapter union widening, audio `unsupported` feature name.
- `packages/server/src/usage-capture/audio-capture/{index.ts,audio-capture.ts,audio-capture.test.ts}` — `captureAudioUsage`.
- `packages/server/src/passthrough-usage/usage.ts` — `openAIAudioUsage`.
- `packages/server/src/routes/openai-audio.ts` — three thin routes.
- `packages/server/src/server/server.ts` — route registration.
- `packages/server/__tests__/audio-routing.test.ts` — dispatch matrix.

Docs and release:

- `npm/aio-proxy/README.md` — inbound API table + Audio notes (root `README.md` is a symlink to this file).
- `README.zh-Hans.md` — mirrored table + notes.
- `.changeset/<name>.md` — one `minor` changeset.

---

## Task 1: Add the `openai-audio` wire protocol

Introduces the enum member and satisfies every exhaustive switch and total record it forces, with no audio behavior yet. Landing this alone keeps the type errors of later tasks scoped to audio logic.

**Files:**
- Modify: `packages/types/src/provider-endpoints/provider-endpoints.ts:4-11`
- Modify: `packages/plugin-sdk/src/runtime.ts:7-13`
- Modify: `packages/core/src/provider/api/api.ts:63-70`
- Modify: `packages/core/src/provider/openai-stream-fetch.ts:12-16`
- Modify: `packages/core/src/provider/api-bridge/api-bridge.ts:29,51-53,80-81`
- Modify: `packages/core/src/usage-pricing/usage-pricing.ts:182`
- Modify: `packages/server/src/provider-runtime/probe/probe.ts:79-83`
- Modify: `packages/server/src/plugin-runtime/capabilities.ts:35-42`
- Modify: `packages/server/src/plugin-runtime/catalog.ts:138-152`
- Modify: `packages/server/src/passthrough-usage/usage.ts:15-31`
- Modify: `packages/server/src/passthrough-usage/passthrough-usage.ts` (`isSuccessTerminal`)
- Modify: `packages/server/src/passthrough-usage/content.ts` (`hasContentDelta`)
- Modify: `packages/server/src/routes/pipeline/attempt/event-counts/event-counts.ts`
- Modify: `packages/dashboard/src/components/protocol-label/protocol-label.tsx:13-48`
- Test: `packages/types/src/provider-endpoints/provider-endpoints.test.ts`
- Include in first commit: `docs/superpowers/plans/2026-09-06-p4-openai-audio-inbound-protocol.md`

**Interfaces:**
- Consumes: existing `ProviderProtocol` enum, `apiProviderEndpoints`, `validateApiEndpoints`.
- Produces: `ProviderProtocol.OpenAIAudio === 'openai-audio'`, usable as an `ApiEndpointEntry.protocol` and as `pluginProtocol[ProviderProtocol.OpenAIAudio] === 'openai-audio'`.

- [ ] **Step 1: Write the failing protocol test**

Append to `packages/types/src/provider-endpoints/provider-endpoints.test.ts`:

```ts
test('openai-audio is a configurable api endpoint protocol', () => {
  const parsed = ApiEndpointEntrySchema.parse({
    protocol: 'openai-audio',
    baseURL: 'https://api.openai.com',
  });
  expect(parsed.protocol).toBe(ProviderProtocol.OpenAIAudio);
});
```

Make sure `ApiEndpointEntrySchema`, `ProviderProtocol` are in that file's import list.

- [ ] **Step 2: Run the test and confirm the protocol is missing**

Run: `bun test packages/types/src/provider-endpoints/provider-endpoints.test.ts`

Expected: FAIL — `ProviderProtocol.OpenAIAudio` is `undefined` and the schema rejects `'openai-audio'`.

- [ ] **Step 3: Add the enum member**

In `packages/types/src/provider-endpoints/provider-endpoints.ts`, inside `export enum ProviderProtocol`, after `OpenAIImage = 'openai-image',`:

```ts
  OpenAIAudio = 'openai-audio',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/types/src/provider-endpoints/provider-endpoints.test.ts`

Expected: PASS.

- [ ] **Step 5: Satisfy the core total records and switches**

`packages/core/src/provider/api/api.ts`, in `SDK_VERSION_PREFIXES`, after the `OpenAIImage` entry:

```ts
  [ProviderProtocol.OpenAIAudio]: '/v1',
```

`packages/core/src/provider/openai-stream-fetch.ts`, add to the pass-through case group:

```ts
    case ProviderProtocol.Anthropic:
    case ProviderProtocol.Gemini:
    case ProviderProtocol.GeminiInteractions:
    case ProviderProtocol.OpenAIImage:
    case ProviderProtocol.OpenAIAudio:
      return fetcher as OpenAIStreamFetch;
```

`packages/core/src/provider/api-bridge/api-bridge.ts` — audio endpoints are not language-bridgeable, exactly like image ones. Replace the three `OpenAIImage` sites:

```ts
const NON_LANGUAGE_PROTOCOLS: ReadonlySet<ProviderProtocol> = new Set([
  ProviderProtocol.OpenAIImage,
  ProviderProtocol.OpenAIAudio,
]);
```

then in `bridgeApiProviderToAiSdk`:

```ts
  const language = languageBridgeEndpoint(apiProviderEndpoints(provider));
  if (language === undefined) {
    throw new Error(`Unsupported provider protocol: ${ProviderProtocol.OpenAIImage}`);
  }
```

becomes

```ts
  const language = languageBridgeEndpoint(apiProviderEndpoints(provider));
  if (language === undefined) {
    throw new Error('Unsupported provider protocol: no language endpoint');
  }
```

and

```ts
function languageBridgeEndpoint(endpoints: readonly NormalizedApiEndpoint[]): NormalizedApiEndpoint | undefined {
  return endpoints.find((endpoint) => !NON_LANGUAGE_PROTOCOLS.has(endpoint.protocol));
}
```

and in `bridgeMapping`:

```ts
    case ProviderProtocol.OpenAIImage:
    case ProviderProtocol.OpenAIAudio:
      throw new Error(`Unsupported provider protocol: ${primary.protocol}`);
```

`packages/core/src/usage-pricing/usage-pricing.ts` — audio raw passthrough reports OpenAI-shaped token counts that are already inclusive subsets, so it joins the `inclusiveBillableUsage` group:

```ts
    case ProviderProtocol.OpenAICompatible:
    case ProviderProtocol.OpenAIResponse:
    case ProviderProtocol.OpenAIAudio:
      return inclusiveBillableUsage(usage, price);
```

- [ ] **Step 6: Satisfy the server switches and total records**

`packages/server/src/provider-runtime/probe/probe.ts`, before `default:`:

```ts
    case ProviderProtocol.OpenAIAudio:
      return {
        body: { model, input: 'ping', voice: 'alloy' },
        path: '/v1/audio/speech',
      };
```

`packages/server/src/plugin-runtime/capabilities.ts`, in `pluginProtocol`, after the `'openai-image'` entry:

```ts
  'openai-audio': 'openai-audio',
```

`packages/server/src/plugin-runtime/catalog.ts`, in `metadataProtocol`'s switch, alongside `OpenAIImage`:

```ts
    case ProviderProtocol.OpenAIAudio:
      return protocol;
```

`packages/server/src/passthrough-usage/usage.ts`, in `usageFromJson`, before `default:`:

```ts
    case ProviderProtocol.OpenAIAudio:
      return { kind: 'absent' };
```

(Task 9 replaces this stub with real extraction via `openAIAudioUsage`.)

`packages/server/src/passthrough-usage/passthrough-usage.ts`, in `isSuccessTerminal`, alongside `OpenAIImage`:

```ts
    case ProviderProtocol.OpenAIImage:
    case ProviderProtocol.OpenAIAudio:
      return false;
```

`packages/server/src/passthrough-usage/content.ts`, in `hasContentDelta`, the same pairing:

```ts
    case ProviderProtocol.OpenAIImage:
    case ProviderProtocol.OpenAIAudio:
      return false;
```

`packages/server/src/routes/pipeline/attempt/event-counts/event-counts.ts` needs no new branch: `images` stays `protocol === ProviderProtocol.OpenAIImage`, and audio counts no response items. Read the file and confirm no exhaustive switch over `ProviderProtocol` remains; if the compiler flags one, add `case ProviderProtocol.OpenAIAudio:` to the same group as `OpenAIImage`.

- [ ] **Step 7: Satisfy the dashboard total record**

`packages/dashboard/src/components/protocol-label/protocol-label.tsx`, in `PROTOCOL_LABELS`, after the `OpenAIImage` entry:

```tsx
  [ProviderProtocol.OpenAIAudio]: {
    label: 'OpenAI Audio',
    icon: withLobeIcon('openai'),
  },
```

Leave `PROTOCOL_ORDER` unchanged and extend its doc comment so it reads:

```tsx
// `openai-image` and `openai-audio` render but are not offered.
```

- [ ] **Step 8: Run the affected suites**

Run: `bun run check`

Expected: PASS — no type errors, no lint errors.

Run: `bun test packages/types packages/core/src/provider packages/core/src/usage-pricing`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers/plans/2026-09-06-p4-openai-audio-inbound-protocol.md packages/types packages/plugin-sdk packages/core packages/server packages/dashboard
git commit -m "feat(types): add the openai-audio wire protocol"
```

---

## Task 2: Generalize the multipart reader out of the Images ingress

Transcriptions need the same disk-spooled streaming multipart reader Images edits use, but that reader hardcodes `image`/`mask` field names, Images' counters, and Images' error message. Extract the protocol-agnostic parts; the existing Images multipart tests are the regression gate.

**Files:**
- Create: `packages/core/src/ingress/multipart/index.ts`
- Create: `packages/core/src/ingress/multipart/multipart-stream.ts`
- Create: `packages/core/src/ingress/multipart/multipart-spool.ts`
- Create: `packages/core/src/ingress/multipart/multipart-stream.test.ts`
- Modify: `packages/core/src/ingress/openai-image/multipart-stream.ts`
- Modify: `packages/core/src/ingress/openai-image/multipart-spool.ts`
- Modify: `packages/core/src/ingress/openai-image/multipart.ts`
- Modify: `packages/core/src/ingress/openai-image/index.ts`
- Test: `packages/core/src/ingress/openai-image/multipart.test.ts` (unchanged, must keep passing)

**Interfaces:**
- Consumes: `withAbortAndIdle`, `RequestBodyTooLargeError` from `packages/core/src/protocol/request.ts`.
- Produces:
  - `type MultipartUpload = { readonly data: Uint8Array; readonly byteLength: number; readonly fieldName?: string; readonly filename?: string; readonly mediaType?: string }`
  - `type ParsedMultipart = { readonly fields: Record<string, string>; readonly uploads: readonly MultipartUpload[]; readonly namedUploads: Readonly<Record<string, MultipartUpload>> }`
  - `type MultipartStreamSpec = { readonly fileFields: ReadonlySet<string>; readonly singletonFileFields?: ReadonlySet<string>; readonly limits: MultipartLimits; readonly syntaxError: () => Error }`
  - `type MultipartLimits = { readonly perFile: number; readonly aggregate: number; readonly nonFile: number; readonly maxFiles: number }`
  - `parseMultipartStream(body: ReadableStream<Uint8Array>, boundary: string, spec: MultipartStreamSpec, signal?: AbortSignal, idleTimeoutMs?: number): Promise<ParsedMultipart>`
  - `multipartBoundary(contentType: string): string | undefined`
  - `type MultipartSpool = { readonly path: string; readonly unlink: () => Promise<void> }`
  - `spoolMultipartBody(raw: Request, idleTimeoutMs: number, filePrefix: string): Promise<MultipartSpool>`
  - `acquireMultipartSlot(signal?: AbortSignal): Promise<void>`, `releaseMultipartSlot(): void`
  - `retainMultipartSpool(raw: Request, spool: MultipartSpool): void`, `releaseMultipartSpool(raw: Request): Promise<void>`, `replaySpooledMultipartRaw(raw: Request): Request`, `multipartSpoolPath(raw: Request): string | undefined`

- [ ] **Step 1: Write the failing generic reader test**

Create `packages/core/src/ingress/multipart/multipart-stream.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { multipartBoundary, type MultipartStreamSpec, parseMultipartStream } from './multipart-stream';

const SPEC: MultipartStreamSpec = {
  fileFields: new Set(['file']),
  limits: { perFile: 1_000, aggregate: 2_000, nonFile: 1_000, maxFiles: 2 },
  syntaxError: () => new SyntaxError('Invalid multipart request'),
};

function body(boundary: string, parts: readonly string[]): ReadableStream<Uint8Array> {
  const text = `${parts.map((part) => `--${boundary}\r\n${part}\r\n`).join('')}--${boundary}--\r\n`;
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.subarray(offset, Math.min(offset + 7, bytes.length)));
      }
      controller.close();
    },
  });
}

describe('parseMultipartStream', () => {
  test('separates declared file fields from plain fields across chunk boundaries', async () => {
    const parsed = await parseMultipartStream(
      body('BOUNDARY', [
        'Content-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\nAUDIOBYTES',
        'Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1',
        'Content-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nword',
      ]),
      'BOUNDARY',
      SPEC,
    );
    expect(parsed.fields).toEqual({ model: 'whisper-1', 'timestamp_granularities': 'word' });
    expect(parsed.uploads).toHaveLength(1);
    expect(parsed.uploads[0]?.filename).toBe('a.mp3');
    expect(parsed.uploads[0]?.mediaType).toBe('audio/mpeg');
    expect(new TextDecoder().decode(parsed.uploads[0]?.data)).toBe('AUDIOBYTES');
    expect(parsed.namedUploads['file']?.filename).toBe('a.mp3');
  });

  test('rejects a file part over the per-file limit', async () => {
    const spec: MultipartStreamSpec = { ...SPEC, limits: { ...SPEC.limits, perFile: 4 } };
    await expect(
      parseMultipartStream(
        body('B', ['Content-Disposition: form-data; name="file"; filename="a.mp3"\r\n\r\nTOOLONG']),
        'B',
        spec,
      ),
    ).rejects.toThrow('Request body too large');
  });

  test('reads the boundary out of a quoted content-type', () => {
    expect(multipartBoundary('multipart/form-data; boundary="a-b-c"')).toBe('a-b-c');
  });
});
```

- [ ] **Step 2: Run it and confirm the module is missing**

Run: `bun test packages/core/src/ingress/multipart/multipart-stream.test.ts`

Expected: FAIL — cannot resolve `./multipart-stream`.

- [ ] **Step 3: Move and parameterize the stream reader**

`git mv packages/core/src/ingress/openai-image/multipart-stream.ts packages/core/src/ingress/multipart/multipart-stream.ts`, then make exactly these changes in the moved file:

Replace the head imports

```ts
import { withAbortAndIdle } from '../../protocol/request';
import { EDITS_MULTIPART_ENCODED_LIMIT, assertEditsMultipartCounters, tooLarge } from './multipart-counters';
import { type OpenAIImageUpload } from './openai-image';
```

with

```ts
import { RequestBodyTooLargeError, withAbortAndIdle } from '../../protocol/request';

export type MultipartUpload = {
  readonly data: Uint8Array;
  readonly byteLength: number;
  readonly fieldName?: string;
  readonly filename?: string;
  readonly mediaType?: string;
};

export type MultipartLimits = {
  readonly perFile: number;
  readonly aggregate: number;
  readonly nonFile: number;
  readonly maxFiles: number;
};

export type MultipartStreamSpec = {
  /** Form field names whose parts are read as files rather than decoded as text. */
  readonly fileFields: ReadonlySet<string>;
  /** File fields that may appear at most once (OpenAI `mask`, audio `file`). */
  readonly singletonFileFields?: ReadonlySet<string>;
  readonly limits: MultipartLimits;
  readonly syntaxError: () => Error;
};

export type ParsedMultipart = {
  readonly fields: Record<string, string>;
  readonly uploads: readonly MultipartUpload[];
  readonly namedUploads: Readonly<Record<string, MultipartUpload>>;
};

function tooLarge(): RequestBodyTooLargeError {
  return new RequestBodyTooLargeError('Request body too large');
}
```

Replace `type PartKind = 'image' | 'mask' | 'field';` with `type PartKind = 'file' | 'field';` and make `OpenPart` carry the normalized name:

```ts
type OpenPart = {
  readonly kind: PartKind;
  readonly name: string;
  readonly fieldName?: string;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly chunks: Uint8Array[];
  length: number;
};
```

Replace `startPart(headers, onImage, onMask)` with a spec-driven version:

```ts
function startPart(headers: string, spec: MultipartStreamSpec, counts: Map<string, number>): OpenPart {
  const rawName = dispositionToken(headers, 'name');
  const filename = dispositionToken(headers, 'filename');
  const mediaType = contentType(headers);
  const name = normalizeFieldName(rawName);
  const base = { name, fieldName: rawName, filename, mediaType, chunks: [], length: 0 };
  if (!spec.fileFields.has(name)) return { ...base, kind: 'field' };
  const seen = (counts.get(name) ?? 0) + 1;
  counts.set(name, seen);
  if (spec.singletonFileFields?.has(name) === true && seen > 1) throw tooLarge();
  if ([...counts.values()].reduce((total, value) => total + value, 0) > spec.limits.maxFiles) throw tooLarge();
  return { ...base, kind: 'file' };
}
```

Change `parseMultipartStream`'s signature and internals: it takes `spec` in place of the image callbacks, returns `ParsedMultipart`, and replaces the `assertEditsMultipartCounters` calls with direct limit checks.

```ts
export async function parseMultipartStream(
  body: ReadableStream<Uint8Array>,
  boundary: string,
  spec: MultipartStreamSpec,
  signal?: AbortSignal,
  idleTimeoutMs = 600_000,
): Promise<ParsedMultipart> {
```

Inside it, replace the image-specific accumulators with:

```ts
  const fields: Record<string, string> = {};
  const uploads: MultipartUpload[] = [];
  const namedUploads: Record<string, MultipartUpload> = {};
  const fileCounts = new Map<string, number>();
  let aggregateDecoded = 0;
  let nonFileFormBytes = 0;
```

`appendPartBytes` becomes:

```ts
  const appendPartBytes = (part: OpenPart, bytes: Uint8Array): void => {
    part.chunks.push(bytes);
    part.length += bytes.byteLength;
    if (part.kind === 'file') {
      if (part.length > spec.limits.perFile) throw tooLarge();
      return;
    }
    nonFileFormBytes += bytes.byteLength;
    if (nonFileFormBytes > spec.limits.nonFile) throw tooLarge();
  };
```

`addFraming` keeps counting framing bytes into `nonFileFormBytes` with the same limit check. `finishPart` becomes:

```ts
  const finishPart = (part: OpenPart): void => {
    if (part.kind === 'file') {
      aggregateDecoded += part.length;
      if (aggregateDecoded > spec.limits.aggregate) throw tooLarge();
      const upload = toUpload(part);
      uploads.push(upload);
      namedUploads[part.name] = upload;
      return;
    }
    fields[part.name] = TEXT_DECODER.decode(concatChunks(part.chunks, part.length));
  };
```

and the function returns `{ fields, uploads, namedUploads }`. Replace every `syntax()` call with `spec.syntaxError()` and delete the local `syntax` helper. Replace the `EDITS_MULTIPART_ENCODED_LIMIT` guard in `readEncodedChunk` / `drainEncodedRemainder` with a `spec.limits` sum computed once:

```ts
  const encodedLimit = spec.limits.aggregate + spec.limits.nonFile;
```

and compare the running encoded total against `encodedLimit`, throwing `tooLarge()`. Leave `ByteWindow`, `scanPreamble`, `toUpload`, `concatChunks`, `normalizeFieldName`, `contentType`, `dispositionToken`, `isLineStart`, and `isBoundarySuffix` otherwise untouched, and add `multipartBoundary` (moved verbatim from `openai-image/multipart.ts`):

```ts
export function multipartBoundary(contentType: string): string | undefined {
  const match = /(?:^|;\s*)boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const value = (match?.[1] ?? match?.[2])?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
```

- [ ] **Step 4: Move and parameterize the spool**

`git mv packages/core/src/ingress/openai-image/multipart-spool.ts packages/core/src/ingress/multipart/multipart-spool.ts`. Change only the temp-file name so callers pick the prefix:

```ts
export async function spoolMultipartBody(
  raw: Request,
  idleTimeoutMs: number,
  filePrefix = 'aio-proxy-multipart',
): Promise<MultipartSpool> {
```

and inside it:

```ts
  const path = join(tmpdir(), `${filePrefix}-${crypto.randomUUID()}`);
```

Everything else — the `WeakMap`, `FinalizationRegistry`, semaphore, `retainMultipartSpool`, `releaseMultipartSpool`, `replaySpooledMultipartRaw`, `multipartSpoolPath` — moves unchanged.

- [ ] **Step 5: Create the barrel**

`packages/core/src/ingress/multipart/index.ts`:

```ts
export {
  acquireMultipartSlot,
  type MultipartSpool,
  multipartSpoolPath,
  releaseMultipartSlot,
  releaseMultipartSpool,
  replaySpooledMultipartRaw,
  retainMultipartSpool,
  spoolMultipartBody,
} from './multipart-spool';
export {
  multipartBoundary,
  type MultipartLimits,
  type MultipartStreamSpec,
  type MultipartUpload,
  type ParsedMultipart,
  parseMultipartStream,
} from './multipart-stream';
```

- [ ] **Step 6: Point the Images ingress at the generic reader**

`packages/core/src/ingress/openai-image/multipart.ts` — replace its `./multipart-stream` and `./multipart-spool` imports with `../multipart`, add the Images spec, and adapt the call site:

```ts
import {
  acquireMultipartSlot,
  multipartBoundary,
  type MultipartSpool,
  type MultipartStreamSpec,
  parseMultipartStream,
  releaseMultipartSlot,
  releaseMultipartSpool,
  replaySpooledMultipartRaw,
  retainMultipartSpool,
  spoolMultipartBody,
} from '../multipart';
import {
  EDITS_MULTIPART_AGGREGATE_LIMIT,
  EDITS_MULTIPART_ENCODED_LIMIT,
  EDITS_MULTIPART_MAX_IMAGES,
  EDITS_MULTIPART_NON_FILE_LIMIT,
  EDITS_MULTIPART_PER_FILE_LIMIT,
} from './multipart-counters';

const EDITS_MULTIPART_SPEC: MultipartStreamSpec = {
  fileFields: new Set(['image', 'mask']),
  singletonFileFields: new Set(['mask']),
  limits: {
    perFile: EDITS_MULTIPART_PER_FILE_LIMIT,
    aggregate: EDITS_MULTIPART_AGGREGATE_LIMIT,
    nonFile: EDITS_MULTIPART_NON_FILE_LIMIT,
    maxFiles: EDITS_MULTIPART_MAX_IMAGES + 1,
  },
  syntaxError: () => new SyntaxError('Invalid OpenAI Images multipart request'),
};
```

In `parseOpenAIImageEditsMultipart`, replace the parse and destructure:

```ts
      spool = await spoolMultipartBody(raw, idleTimeoutMs, 'aio-proxy-images');
      const replay = new Request(raw.url, {
        method: raw.method,
        headers: raw.headers,
        body: Bun.file(spool.path),
        signal: raw.signal,
      });
      const body = await decodedRequestStream(replay, MULTIPART_DECODE_LIMITS, { signal: raw.signal, idleTimeoutMs });
      const { fields, uploads, namedUploads } = await parseMultipartStream(
        body,
        boundary,
        EDITS_MULTIPART_SPEC,
        raw.signal,
        idleTimeoutMs,
      );
      const imageUploads = uploads.filter((upload) => upload !== namedUploads['mask']);
      if (imageUploads.length === 0) throw new SyntaxError('Invalid OpenAI Images multipart request');
      const maskUpload = namedUploads['mask'];
      retainMultipartSpool(raw, spool);
      return {
        ...parseOpenAIImageGenerations(generationsInputFromFields(fields)),
        uploads: imageUploads,
        ...(maskUpload === undefined ? {} : { maskUpload }),
        formFields: fields,
      };
```

Delete the now-duplicated local `multipartBoundary` from this file and keep re-exporting the spool helpers from `./multipart` so `openai-image/index.ts` keeps its current public surface. `packages/core/src/ingress/openai-image/multipart-counters.ts` stays as-is; only `assertEditsMultipartCounters` loses its callers, so delete that function and its `tooLarge` helper, keeping the exported limit constants.

- [ ] **Step 7: Run both suites**

Run: `bun test packages/core/src/ingress`

Expected: PASS — the new generic tests and every existing `openai-image` multipart test.

Run: `bun run check`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/ingress
git commit -m "refactor(core): extract a protocol-agnostic multipart reader"
```

---

## Task 3: Parse audio requests (ingress)

Speech is JSON; transcriptions and translations are multipart. This task produces the parsed request shapes and the model defaults, with no routing yet.

**Files:**
- Create: `packages/core/src/ingress/openai-audio/openai-audio.ts`
- Create: `packages/core/src/ingress/openai-audio/multipart.ts`
- Create: `packages/core/src/ingress/openai-audio/index.ts`
- Create: `packages/core/src/ingress/openai-audio/openai-audio.test.ts`
- Create: `packages/core/src/ingress/openai-audio/multipart.test.ts`

**Interfaces:**
- Consumes: `parseMultipartStream`, `multipartBoundary`, `spoolMultipartBody`, `acquireMultipartSlot`, `releaseMultipartSlot`, `retainMultipartSpool`, `type MultipartStreamSpec`, `type MultipartUpload` from `../multipart`; `decodedRequestStream`, `type RequestBodyLimits` from `../../protocol/request`.
- Produces:
  - `CPA_DEFAULT_SPEECH_MODEL = 'tts-1'`, `CPA_DEFAULT_TRANSCRIPTION_MODEL = 'whisper-1'`
  - `AUDIO_MULTIPART_ENCODED_LIMIT = 104_857_600`
  - `type OpenAISpeechRequest = { readonly model: string; readonly modelDefaulted: boolean; readonly clientModel?: string; readonly input: string; readonly voice: string; readonly response_format?: string | null; readonly speed?: number | null; readonly instructions?: string | null; readonly stream_format?: string | null }`
  - `type OpenAITranscriptionRequest = { readonly model: string; readonly modelDefaulted: boolean; readonly clientModel?: string; readonly upload: MultipartUpload; readonly response_format?: string | null; readonly language?: string | null; readonly prompt?: string | null; readonly temperature?: number | null; readonly stream_format?: string | null; readonly chunking_strategy?: string | null; readonly timestamp_granularities?: readonly string[]; readonly formFields: Readonly<Record<string, string>> }`
  - `parseOpenAISpeech(body: unknown): OpenAISpeechRequest`
  - `parseOpenAITranscriptionMultipart(raw: Request, options?: { readonly idleTimeoutMs?: number }): Promise<OpenAITranscriptionRequest>`

- [ ] **Step 1: Write the failing speech-parse test**

Create `packages/core/src/ingress/openai-audio/openai-audio.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { CPA_DEFAULT_SPEECH_MODEL, parseOpenAISpeech } from './openai-audio';

describe('parseOpenAISpeech', () => {
  test('keeps the client model and records it verbatim', () => {
    const request = parseOpenAISpeech({ model: 'gpt-4o-mini-tts', input: 'hello', voice: 'alloy' });
    expect(request.model).toBe('gpt-4o-mini-tts');
    expect(request.modelDefaulted).toBe(false);
    expect(request.clientModel).toBe('gpt-4o-mini-tts');
  });

  test('defaults a missing model to tts-1', () => {
    const request = parseOpenAISpeech({ input: 'hello', voice: 'alloy' });
    expect(request.model).toBe(CPA_DEFAULT_SPEECH_MODEL);
    expect(request.modelDefaulted).toBe(true);
    expect(request.clientModel).toBeUndefined();
  });

  test('carries response_format and speed through', () => {
    const request = parseOpenAISpeech({ input: 'hi', voice: 'nova', response_format: 'opus', speed: 1.25 });
    expect(request.response_format).toBe('opus');
    expect(request.speed).toBe(1.25);
  });

  test('rejects a request without input', () => {
    expect(() => parseOpenAISpeech({ voice: 'alloy' })).toThrow();
  });

  test('rejects a request without voice', () => {
    expect(() => parseOpenAISpeech({ input: 'hi' })).toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm the module is missing**

Run: `bun test packages/core/src/ingress/openai-audio/openai-audio.test.ts`

Expected: FAIL — cannot resolve `./openai-audio`.

- [ ] **Step 3: Write the speech and transcription schemas**

Create `packages/core/src/ingress/openai-audio/openai-audio.ts`:

```ts
import { z } from 'zod';

/** OpenAI's own default for `POST /v1/audio/speech` when the client omits `model`. */
export const CPA_DEFAULT_SPEECH_MODEL = 'tts-1';
/** OpenAI's own default for the transcriptions and translations ports. */
export const CPA_DEFAULT_TRANSCRIPTION_MODEL = 'whisper-1';

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();

const OpenAISpeechInputSchema = z.compile(
  z.object({
    model: z.union([z.string(), z.null()]).optional(),
    input: z.string(),
    voice: z.string(),
    response_format: nullableString,
    speed: nullableNumber,
    instructions: nullableString,
    stream_format: nullableString,
  }),
);

const OpenAITranscriptionFieldsSchema = z.compile(
  z.object({
    model: z.union([z.string(), z.null()]).optional(),
    response_format: nullableString,
    language: nullableString,
    prompt: nullableString,
    temperature: nullableNumber,
    stream_format: nullableString,
    chunking_strategy: nullableString,
    timestamp_granularities: z.array(z.string()).optional(),
  }),
);

export type OpenAISpeechRequest = {
  readonly model: string;
  readonly modelDefaulted: boolean;
  readonly clientModel?: string;
  readonly input: string;
  readonly voice: string;
  readonly response_format?: string | null;
  readonly speed?: number | null;
  readonly instructions?: string | null;
  readonly stream_format?: string | null;
};

export function parseOpenAISpeech(body: unknown): OpenAISpeechRequest {
  const parsed = OpenAISpeechInputSchema.parse(body);
  const { model, ...rest } = parsed;
  return { ...rest, ...resolveModel(model, CPA_DEFAULT_SPEECH_MODEL) };
}

export type TranscriptionFields = z.output<typeof OpenAITranscriptionFieldsSchema>;

export function parseOpenAITranscriptionFields(fields: Readonly<Record<string, string>>): {
  readonly model: string;
  readonly modelDefaulted: boolean;
  readonly clientModel?: string;
} & Omit<TranscriptionFields, 'model'> {
  const input = {
    ...(fields['model'] === undefined ? {} : { model: fields['model'] }),
    ...(fields['response_format'] === undefined ? {} : { response_format: fields['response_format'] }),
    ...(fields['language'] === undefined ? {} : { language: fields['language'] }),
    ...(fields['prompt'] === undefined ? {} : { prompt: fields['prompt'] }),
    ...(fields['temperature'] === undefined ? {} : { temperature: Number(fields['temperature']) }),
    ...(fields['stream_format'] === undefined ? {} : { stream_format: fields['stream_format'] }),
    ...(fields['chunking_strategy'] === undefined ? {} : { chunking_strategy: fields['chunking_strategy'] }),
    ...(fields['timestamp_granularities'] === undefined
      ? {}
      : { timestamp_granularities: [fields['timestamp_granularities']] }),
  };
  const parsed = OpenAITranscriptionFieldsSchema.parse(input);
  const { model, ...rest } = parsed;
  return { ...rest, ...resolveModel(model, CPA_DEFAULT_TRANSCRIPTION_MODEL) };
}

// A blank or absent model is the documented default, not an error: OpenAI's own
// clients omit it. `clientModel` records what the client actually sent so the raw
// path can skip rewriting when nothing changed.
function resolveModel(
  model: string | null | undefined,
  fallback: string,
): { readonly model: string; readonly modelDefaulted: boolean; readonly clientModel?: string } {
  const trimmed = model?.trim();
  if (trimmed === undefined || trimmed.length === 0) return { model: fallback, modelDefaulted: true };
  return { model: trimmed, modelDefaulted: false, clientModel: trimmed };
}
```

- [ ] **Step 4: Run the speech tests to verify they pass**

Run: `bun test packages/core/src/ingress/openai-audio/openai-audio.test.ts`

Expected: PASS — 5 tests.

- [ ] **Step 5: Write the failing multipart transcription test**

Create `packages/core/src/ingress/openai-audio/multipart.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { releaseMultipartSpool } from '../multipart';
import { parseOpenAITranscriptionMultipart } from './multipart';

function multipartRequest(parts: readonly string[], boundary = 'AUDIOBOUNDARY'): Request {
  const text = `${parts.map((part) => `--${boundary}\r\n${part}\r\n`).join('')}--${boundary}--\r\n`;
  return new Request('https://proxy.test/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: new TextEncoder().encode(text),
  });
}

const FILE_PART =
  'Content-Disposition: form-data; name="file"; filename="clip.mp3"\r\nContent-Type: audio/mpeg\r\n\r\nID3AUDIO';

describe('parseOpenAITranscriptionMultipart', () => {
  test('reads the upload, the model, and every raw form field', async () => {
    const raw = multipartRequest([
      FILE_PART,
      'Content-Disposition: form-data; name="model"\r\n\r\nwhisper-large',
      'Content-Disposition: form-data; name="response_format"\r\n\r\nsrt',
      'Content-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nword',
    ]);
    const request = await parseOpenAITranscriptionMultipart(raw);
    expect(request.model).toBe('whisper-large');
    expect(request.modelDefaulted).toBe(false);
    expect(request.response_format).toBe('srt');
    expect(request.timestamp_granularities).toEqual(['word']);
    expect(request.upload.filename).toBe('clip.mp3');
    expect(request.upload.mediaType).toBe('audio/mpeg');
    // Raw replay must be able to reproduce every field the client sent.
    expect(request.formFields['timestamp_granularities']).toBe('word');
    await releaseMultipartSpool(raw);
  });

  test('defaults a missing model to whisper-1', async () => {
    const raw = multipartRequest([FILE_PART]);
    const request = await parseOpenAITranscriptionMultipart(raw);
    expect(request.model).toBe('whisper-1');
    expect(request.modelDefaulted).toBe(true);
    await releaseMultipartSpool(raw);
  });

  test('rejects a body with no file part', async () => {
    const raw = multipartRequest(['Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1']);
    await expect(parseOpenAITranscriptionMultipart(raw)).rejects.toThrow('Invalid OpenAI Audio multipart request');
  });

  test('rejects a request that is not multipart', async () => {
    const raw = new Request('https://proxy.test/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await expect(parseOpenAITranscriptionMultipart(raw)).rejects.toThrow('Invalid OpenAI Audio multipart request');
  });
});
```

- [ ] **Step 6: Run it and confirm the module is missing**

Run: `bun test packages/core/src/ingress/openai-audio/multipart.test.ts`

Expected: FAIL — cannot resolve `./multipart`.

- [ ] **Step 7: Write the multipart transcription reader**

Create `packages/core/src/ingress/openai-audio/multipart.ts`:

```ts
import { decodedRequestStream, type RequestBodyLimits } from '../../protocol/request';
import {
  acquireMultipartSlot,
  multipartBoundary,
  type MultipartSpool,
  type MultipartStreamSpec,
  type MultipartUpload,
  parseMultipartStream,
  releaseMultipartSlot,
  retainMultipartSpool,
  spoolMultipartBody,
} from '../multipart';
import { parseOpenAITranscriptionFields, type TranscriptionFields } from './openai-audio';

/**
 * 100 MiB, OpenAI's documented upload ceiling for the transcription ports.
 * Applied to speech, transcriptions, AND translations alike — OmniRoute caps
 * only transcriptions and silently 413s large translations.
 */
export const AUDIO_MULTIPART_ENCODED_LIMIT = 104_857_600;
const AUDIO_MULTIPART_NON_FILE_LIMIT = 1_048_576;
const AUDIO_MULTIPART_IDLE_TIMEOUT_MS = 600_000;

const MULTIPART_DECODE_LIMITS = Object.freeze({
  encoded: AUDIO_MULTIPART_ENCODED_LIMIT,
  decoded: AUDIO_MULTIPART_ENCODED_LIMIT,
}) satisfies RequestBodyLimits;

const AUDIO_MULTIPART_SPEC: MultipartStreamSpec = {
  fileFields: new Set(['file']),
  singletonFileFields: new Set(['file']),
  limits: {
    perFile: AUDIO_MULTIPART_ENCODED_LIMIT,
    aggregate: AUDIO_MULTIPART_ENCODED_LIMIT,
    nonFile: AUDIO_MULTIPART_NON_FILE_LIMIT,
    maxFiles: 1,
  },
  syntaxError: () => new SyntaxError('Invalid OpenAI Audio multipart request'),
};

export type OpenAITranscriptionRequest = {
  readonly model: string;
  readonly modelDefaulted: boolean;
  readonly clientModel?: string;
  readonly upload: MultipartUpload;
  /** Every field the client sent, verbatim, so the raw path can replay them. */
  readonly formFields: Readonly<Record<string, string>>;
} & Omit<TranscriptionFields, 'model'>;

export async function parseOpenAITranscriptionMultipart(
  raw: Request,
  options?: { readonly idleTimeoutMs?: number },
): Promise<OpenAITranscriptionRequest> {
  const boundary = multipartBoundary(raw.headers.get('content-type') ?? '');
  if (boundary === undefined) throw new SyntaxError('Invalid OpenAI Audio multipart request');
  const idleTimeoutMs = options?.idleTimeoutMs ?? AUDIO_MULTIPART_IDLE_TIMEOUT_MS;
  await acquireMultipartSlot(raw.signal);
  let spool: MultipartSpool | undefined;
  try {
    spool = await spoolMultipartBody(raw, idleTimeoutMs, 'aio-proxy-audio');
    const replay = new Request(raw.url, {
      method: raw.method,
      headers: raw.headers,
      body: Bun.file(spool.path),
      signal: raw.signal,
    });
    const body = await decodedRequestStream(replay, MULTIPART_DECODE_LIMITS, { signal: raw.signal, idleTimeoutMs });
    const { fields, namedUploads } = await parseMultipartStream(
      body,
      boundary,
      AUDIO_MULTIPART_SPEC,
      raw.signal,
      idleTimeoutMs,
    );
    const upload = namedUploads['file'];
    if (upload === undefined) throw new SyntaxError('Invalid OpenAI Audio multipart request');
    retainMultipartSpool(raw, spool);
    return { ...parseOpenAITranscriptionFields(fields), upload, formFields: fields };
  } catch (error) {
    await spool?.unlink();
    void raw.body?.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    releaseMultipartSlot();
  }
}
```

- [ ] **Step 8: Create the ingress barrel**

`packages/core/src/ingress/openai-audio/index.ts`:

```ts
export {
  AUDIO_MULTIPART_ENCODED_LIMIT,
  type OpenAITranscriptionRequest,
  parseOpenAITranscriptionMultipart,
} from './multipart';
export {
  CPA_DEFAULT_SPEECH_MODEL,
  CPA_DEFAULT_TRANSCRIPTION_MODEL,
  type OpenAISpeechRequest,
  parseOpenAISpeech,
  parseOpenAITranscriptionFields,
  type TranscriptionFields,
} from './openai-audio';
```

- [ ] **Step 9: Run both suites**

Run: `bun test packages/core/src/ingress/openai-audio`

Expected: PASS — 5 speech tests plus 4 multipart tests.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/ingress/openai-audio
git commit -m "feat(core): parse OpenAI audio speech and transcription requests"
```

---

## Task 4: Add the audio adapter contract

Audio's egress returns a `Response`, not a JSON value, so it needs its own adapter shape rather than a reuse of `imageJson` / `embeddingJson`. One factory serves both capabilities.

**Files:**
- Create: `packages/core/src/protocol/audio-adapter/audio-adapter.ts`
- Create: `packages/core/src/protocol/audio-adapter/index.ts`
- Create: `packages/core/src/protocol/audio-adapter/audio-adapter.test.ts`
- Modify: `packages/core/src/protocol/adapter.ts:12`
- Modify: `packages/core/src/protocol/request.ts` (export `stripHopHeaders`)
- Modify: `packages/core/src/protocol/openai-image/openai-image.ts` (use the shared `stripHopHeaders`)
- Modify: `packages/core/src/protocol/index.ts`

**Interfaces:**
- Consumes: `SharedProtocolAdapter`, `ProtocolErrorMapper`, `REQUEST_BODY_LIMITS`, `type RequestBodyLimits`, `type AliasDimensions`, `type ProtocolRequestDiagnostic` from `../adapter` and `../request`.
- Produces:
  - `type AudioCapability = 'speech' | 'transcription'`
  - `type SpeechInvocation = { readonly text: string; readonly voice?: string; readonly outputFormat?: string; readonly instructions?: string; readonly speed?: number; readonly language?: string; readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>> }`
  - `type TranscriptionInvocation = { readonly audio: Uint8Array; readonly mediaType?: string; readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>> }`
  - `type AudioInvocation = { readonly kind: 'speech'; readonly speech: SpeechInvocation } | { readonly kind: 'transcription'; readonly transcription: TranscriptionInvocation }`
  - `type SpeechResultData = { readonly audio: Uint8Array; readonly mediaType: string }`
  - `type TranscriptionSegment = { readonly text: string; readonly startSecond: number; readonly endSecond: number }`
  - `type TranscriptionResultData = { readonly text: string; readonly segments: readonly TranscriptionSegment[]; readonly language?: string; readonly durationInSeconds?: number }`
  - `type AudioResult = { readonly kind: 'speech'; readonly speech: SpeechResultData } | { readonly kind: 'transcription'; readonly transcription: TranscriptionResultData }`
  - `type AudioEgressContext = { readonly modelId: string }`
  - `type AudioProtocolAdapter<TRequest, TContext>` with `capability: AudioCapability`, `audioInvocation`, `audioResponse`, `convertSkipReason?`
  - `defineAudioProtocolAdapter<TRequest, TContext>(definition): AudioProtocolAdapter<TRequest, TContext>`
  - `isAudioProtocolAdapter(adapter): adapter is AudioProtocolAdapter<unknown, unknown>`
  - `type AnyInboundProtocolAdapter<TRequest, TContext>` = language | image | audio
  - `stripHopHeaders(source: Headers): Headers` exported from `../request`

- [ ] **Step 1: Write the failing factory test**

Create `packages/core/src/protocol/audio-adapter/audio-adapter.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { ProviderProtocol } from '@aio-proxy/types';

import { REQUEST_BODY_LIMITS } from '../request';
import { type AudioCapability, defineAudioProtocolAdapter, isAudioProtocolAdapter } from './audio-adapter';

const errors = {
  requestError: () => undefined,
  modelNotFound: () => new Response(null, { status: 404 }),
  previousResponseConflict: () => new Response(null, { status: 409 }),
  tooLarge: () => new Response(null, { status: 413 }),
  unsupportedContentEncoding: () => new Response(null, { status: 415 }),
  unsupported: () => new Response(null, { status: 501 }),
  provider: () => undefined,
  rateLimited: () => new Response(null, { status: 429 }),
};

function adapter(capability: AudioCapability) {
  return defineAudioProtocolAdapter<{ model: string }, Record<never, never>>({
    capability,
    protocol: ProviderProtocol.OpenAIAudio,
    parse: async () => ({ model: 'tts-1' }),
    model: (request) => request.model,
    rawRequest: async (raw) => raw,
    audioInvocation: () => ({ kind: 'speech', speech: { text: 'hi' } }),
    audioResponse: async () => new Response(null, { status: 200 }),
    errors,
  });
}

describe('defineAudioProtocolAdapter', () => {
  test('freezes the adapter and keeps the declared capability', () => {
    const speech = adapter('speech');
    expect(Object.isFrozen(speech)).toBe(true);
    expect(speech.capability).toBe('speech');
    expect(adapter('transcription').capability).toBe('transcription');
  });

  test('fills the shared defaults and exposes no language or image surface', () => {
    const speech = adapter('speech');
    expect(speech.bodyLimits(new Request('https://proxy.test'), {})).toEqual(REQUEST_BODY_LIMITS);
    expect(speech.dimensions({ model: 'tts-1' }, {})).toEqual({});
    expect(speech.requestDiagnostics({ model: 'tts-1' }, {})).toEqual([]);
    expect(speech.wantsStream({ model: 'tts-1' }, {})).toBe(false);
    expect('modelInvocation' in speech).toBe(false);
    expect('imageJson' in speech).toBe(false);
  });

  test('recognizes both audio capabilities and rejects other ones', () => {
    expect(isAudioProtocolAdapter(adapter('speech'))).toBe(true);
    expect(isAudioProtocolAdapter(adapter('transcription'))).toBe(true);
    expect(isAudioProtocolAdapter({ capability: 'image' })).toBe(false);
    expect(isAudioProtocolAdapter({ capability: 'embedding' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm the factory is missing**

Run: `bun test packages/core/src/protocol/audio-adapter/audio-adapter.test.ts`

Expected: FAIL — cannot resolve `./audio-adapter`.

- [ ] **Step 3: Widen `InboundCapability` and export the hop-header helper**

`packages/core/src/protocol/adapter.ts`, replace line 12:

```ts
export type InboundCapability = 'language' | 'image' | 'embedding' | 'speech' | 'transcription';
```

`packages/core/src/protocol/request.ts`, append:

```ts
// Headers that describe the ORIGINAL body encoding must not survive onto a
// rewritten upstream request: the rewrite re-encodes the body, so a stale
// content-length or content-encoding makes the upstream reject or truncate it.
export function stripHopHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('content-md5');
  headers.delete('digest');
  headers.delete('content-digest');
  return headers;
}
```

In `packages/core/src/protocol/openai-image/openai-image.ts`, delete the module-private `stripHopHeaders` function and import the shared one, adding it to the existing `../request` import list.

- [ ] **Step 4: Write the adapter contract**

Create `packages/core/src/protocol/audio-adapter/audio-adapter.ts`:

```ts
import type { AliasDimensions } from '@aio-proxy/types';

import type { ProtocolRequestDiagnostic, SharedProtocolAdapter } from '../adapter';
import { REQUEST_BODY_LIMITS, type RequestBodyLimits } from '../request';

export type AudioCapability = 'speech' | 'transcription';

export type AudioProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export type SpeechInvocation = {
  readonly text: string;
  readonly voice?: string;
  readonly outputFormat?: string;
  readonly instructions?: string;
  readonly speed?: number;
  readonly language?: string;
  readonly providerOptions?: AudioProviderOptions;
};

export type TranscriptionInvocation = {
  readonly audio: Uint8Array;
  readonly mediaType?: string;
  readonly providerOptions?: AudioProviderOptions;
};

export type AudioInvocation =
  | { readonly kind: 'speech'; readonly speech: SpeechInvocation }
  | { readonly kind: 'transcription'; readonly transcription: TranscriptionInvocation };

export type SpeechResultData = {
  readonly audio: Uint8Array;
  readonly mediaType: string;
};

export type TranscriptionSegment = {
  readonly text: string;
  readonly startSecond: number;
  readonly endSecond: number;
};

export type TranscriptionResultData = {
  readonly text: string;
  readonly segments: readonly TranscriptionSegment[];
  readonly language?: string;
  readonly durationInSeconds?: number;
};

export type AudioResult =
  | { readonly kind: 'speech'; readonly speech: SpeechResultData }
  | { readonly kind: 'transcription'; readonly transcription: TranscriptionResultData };

export type AudioEgressContext = {
  readonly modelId: string;
};

/**
 * Audio egress returns a Response, not a JSON value: speech answers with audio
 * bytes and a media type, and transcription answers with JSON *or* bare
 * `text` / `srt` / `vtt`. Neither fits the JSON-only image and embedding egress
 * contracts, so audio owns its own.
 */
export type AudioProtocolAdapter<TRequest, TContext> = SharedProtocolAdapter<TRequest, TContext> &
  Readonly<{
    capability: AudioCapability;
    audioInvocation: (request: TRequest, context: TContext) => AudioInvocation;
    audioResponse: (result: AudioResult, request: TRequest, context: AudioEgressContext) => Promise<Response>;
    convertSkipReason?: (request: TRequest, resolvedModelId: string) => string | undefined;
  }>;

export type AudioProtocolAdapterDefinition<TRequest, TContext> = Omit<
  AudioProtocolAdapter<TRequest, TContext>,
  'bodyLimits' | 'dimensions' | 'requestDiagnostics' | 'wantsStream'
> & {
  readonly bodyLimits?: AudioProtocolAdapter<TRequest, TContext>['bodyLimits'];
  readonly dimensions?: AudioProtocolAdapter<TRequest, TContext>['dimensions'];
  readonly requestDiagnostics?: AudioProtocolAdapter<TRequest, TContext>['requestDiagnostics'];
  readonly wantsStream?: AudioProtocolAdapter<TRequest, TContext>['wantsStream'];
};

const noDimensions = (): AliasDimensions => ({});
const noRequestDiagnostics = (): readonly ProtocolRequestDiagnostic[] => [];
const defaultBodyLimits = (): RequestBodyLimits => REQUEST_BODY_LIMITS;

export function defineAudioProtocolAdapter<TRequest, TContext>(
  definition: AudioProtocolAdapterDefinition<TRequest, TContext>,
): AudioProtocolAdapter<TRequest, TContext> {
  return Object.freeze({
    ...definition,
    bodyLimits: definition.bodyLimits ?? defaultBodyLimits,
    dimensions: definition.dimensions ?? noDimensions,
    requestDiagnostics: definition.requestDiagnostics ?? noRequestDiagnostics,
    // Transcription streaming is signalled by `stream_format`, never by a
    // `stream` boolean, and no reference implementation supports it. Audio never
    // opts into the streaming pipeline on the convert path.
    wantsStream: definition.wantsStream ?? (() => false),
  });
}

export function isAudioProtocolAdapter(adapter: {
  readonly capability?: string;
}): adapter is AudioProtocolAdapter<never, never> {
  return adapter.capability === 'speech' || adapter.capability === 'transcription';
}
```

- [ ] **Step 5: Create the barrel and register it**

`packages/core/src/protocol/audio-adapter/index.ts`:

```ts
export {
  type AudioCapability,
  type AudioEgressContext,
  type AudioInvocation,
  type AudioProtocolAdapter,
  type AudioProtocolAdapterDefinition,
  type AudioProviderOptions,
  type AudioResult,
  defineAudioProtocolAdapter,
  isAudioProtocolAdapter,
  type SpeechInvocation,
  type SpeechResultData,
  type TranscriptionInvocation,
  type TranscriptionResultData,
  type TranscriptionSegment,
} from './audio-adapter';
```

`packages/core/src/protocol/index.ts`, add after the `'./anthropic-thinking'` line:

```ts
export * from './audio-adapter';
```

- [ ] **Step 6: Widen the inbound adapter union**

`packages/core/src/protocol/image-adapter/image-adapter.ts` — leave `InboundProtocolAdapter` alone (Images-era callers still use it) and add the widened union in the audio adapter module instead. Append to `packages/core/src/protocol/audio-adapter/audio-adapter.ts`:

```ts
import type { ImageProtocolAdapter } from '../image-adapter/image-adapter';
import type { LanguageProtocolAdapter } from '../adapter';

/** Every non-embedding inbound adapter the pipeline can dispatch. */
export type AnyInboundProtocolAdapter<TRequest, TContext> =
  | LanguageProtocolAdapter<TRequest, TContext>
  | ImageProtocolAdapter<TRequest, TContext>
  | AudioProtocolAdapter<TRequest, TContext>;
```

Move both imports to the top of the file with the others, and add `type AnyInboundProtocolAdapter,` to the barrel's export list.

- [ ] **Step 7: Run the factory tests and the type check**

Run: `bun test packages/core/src/protocol/audio-adapter/audio-adapter.test.ts`

Expected: PASS — 3 tests.

Run: `bun test packages/core/src/protocol packages/core/src/ingress`

Expected: PASS — the shared `stripHopHeaders` change keeps every Images adapter test green.

Run: `bun run check`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/protocol
git commit -m "feat(core): add the audio inbound adapter contract"
```

---

## Task 5: Build the two OpenAI audio adapters

**Files:**
- Create: `packages/core/src/protocol/openai-audio/openai-audio.ts`
- Create: `packages/core/src/protocol/openai-audio/transcription-egress.ts`
- Create: `packages/core/src/protocol/openai-audio/index.ts`
- Create: `packages/core/src/protocol/openai-audio/openai-audio.test.ts`
- Create: `packages/core/src/protocol/openai-audio/transcription-egress.test.ts`
- Modify: `packages/core/src/error.ts`
- Modify: `packages/core/src/protocol/errors.ts`
- Modify: `packages/core/src/protocol/index.ts`

**Interfaces:**
- Consumes: `defineAudioProtocolAdapter`, `type AudioInvocation`, `type AudioResult`, `type AudioEgressContext` (Task 4); `parseOpenAISpeech`, `parseOpenAITranscriptionMultipart`, `type OpenAISpeechRequest`, `type OpenAITranscriptionRequest`, `AUDIO_MULTIPART_ENCODED_LIMIT` (Task 3); `readJsonRequest`, `readRequestText`, `stripHopHeaders`, `rewriteJsonRequestModel`; `replaySpooledMultipartRaw` from `../../ingress/multipart`.
- Produces:
  - `type OpenAIAudioOperation = 'speech' | 'transcriptions' | 'translations'`
  - `type OpenAIAudioContext = { readonly operation: OpenAIAudioOperation }`
  - `openAISpeechAdapter: AudioProtocolAdapter<OpenAISpeechRequest, OpenAIAudioContext>`
  - `openAITranscriptionAdapter: AudioProtocolAdapter<OpenAITranscriptionRequest, OpenAIAudioContext>`
  - `openAIAudioErrors: ProtocolErrorMapper`
  - `OpenAIAudioUnsupportedFeatureError` (`code = 'UNSUPPORTED_OPENAI_AUDIO_FEATURE'`, `status = 501`, `constructor(readonly feature: 'stream_format' | 'chunking_strategy' | 'translations' | 'response_format')`)
  - `OpenAIAudioInvalidRequestError` (`code = 'INVALID_OPENAI_AUDIO_REQUEST'`, `status = 400`, `constructor(readonly param: 'file' | 'input' | 'voice' | 'speed')`)
  - `renderTranscription(result: TranscriptionResultData, responseFormat: string | null | undefined): Response`

- [ ] **Step 1: Write the failing transcription-egress test**

Create `packages/core/src/protocol/openai-audio/transcription-egress.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { renderTranscription } from './transcription-egress';

const RESULT = {
  text: 'hello world',
  segments: [
    { text: 'hello', startSecond: 0, endSecond: 0.5 },
    { text: 'world', startSecond: 0.5, endSecond: 1.25 },
  ],
  language: 'en',
  durationInSeconds: 1.25,
};

describe('renderTranscription', () => {
  test('defaults to the json envelope', async () => {
    const response = renderTranscription(RESULT, undefined);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ text: 'hello world' });
  });

  test('adds segments and duration for verbose_json', async () => {
    const response = renderTranscription(RESULT, 'verbose_json');
    expect(await response.json()).toEqual({
      task: 'transcribe',
      language: 'en',
      duration: 1.25,
      text: 'hello world',
      segments: [
        { id: 0, start: 0, end: 0.5, text: 'hello' },
        { id: 1, start: 0.5, end: 1.25, text: 'world' },
      ],
    });
  });

  test('writes bare text for the text format', async () => {
    const response = renderTranscription(RESULT, 'text');
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('hello world');
  });

  test('writes 1-based cues with comma decimals for srt', async () => {
    const response = renderTranscription(RESULT, 'srt');
    expect(response.headers.get('content-type')).toBe('application/x-subrip; charset=utf-8');
    expect(await response.text()).toBe(
      '1\n00:00:00,000 --> 00:00:00,500\nhello\n\n2\n00:00:00,500 --> 00:00:01,250\nworld\n',
    );
  });

  test('writes a WEBVTT header with dot decimals for vtt', async () => {
    const response = renderTranscription(RESULT, 'vtt');
    expect(response.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
    expect(await response.text()).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nhello\n\n00:00:00.500 --> 00:00:01.250\nworld\n',
    );
  });
});
```

- [ ] **Step 2: Run it and confirm the module is missing**

Run: `bun test packages/core/src/protocol/openai-audio/transcription-egress.test.ts`

Expected: FAIL — cannot resolve `./transcription-egress`.

- [ ] **Step 3: Write the transcription renderer**

Create `packages/core/src/protocol/openai-audio/transcription-egress.ts`:

```ts
import type { TranscriptionResultData, TranscriptionSegment } from '../audio-adapter';

// OpenAI's four documented transcription response formats plus the default.
// `srt` and `vtt` are why audio egress must be able to answer with a non-JSON
// body: every reference project that supports them passes bytes through rather
// than re-encoding, and the convert path has to render them locally.
export function renderTranscription(
  result: TranscriptionResultData,
  responseFormat: string | null | undefined,
): Response {
  switch (responseFormat) {
    case 'text':
      return new Response(result.text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    case 'srt':
      return new Response(srt(result.segments), {
        headers: { 'content-type': 'application/x-subrip; charset=utf-8' },
      });
    case 'vtt':
      return new Response(vtt(result.segments), { headers: { 'content-type': 'text/vtt; charset=utf-8' } });
    case 'verbose_json':
      return Response.json({
        task: 'transcribe',
        ...(result.language === undefined ? {} : { language: result.language }),
        ...(result.durationInSeconds === undefined ? {} : { duration: result.durationInSeconds }),
        text: result.text,
        segments: result.segments.map((segment, index) => ({
          id: index,
          start: segment.startSecond,
          end: segment.endSecond,
          text: segment.text,
        })),
      });
    default:
      return Response.json({ text: result.text });
  }
}

function srt(segments: readonly TranscriptionSegment[]): string {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${timestamp(segment.startSecond, ',')} --> ${timestamp(segment.endSecond, ',')}\n${segment.text}\n`,
    )
    .join('\n');
}

function vtt(segments: readonly TranscriptionSegment[]): string {
  const cues = segments
    .map(
      (segment) =>
        `${timestamp(segment.startSecond, '.')} --> ${timestamp(segment.endSecond, '.')}\n${segment.text}\n`,
    )
    .join('\n');
  return `WEBVTT\n\n${cues}`;
}

function timestamp(seconds: number, decimalSeparator: ',' | '.'): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const secs = totalSeconds % 60;
  const totalMinutes = (totalSeconds - secs) / 60;
  const minutes = totalMinutes % 60;
  const hours = (totalMinutes - minutes) / 60;
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}${decimalSeparator}${pad(ms, 3)}`;
}
```

- [ ] **Step 4: Run the renderer tests to verify they pass**

Run: `bun test packages/core/src/protocol/openai-audio/transcription-egress.test.ts`

Expected: PASS — 5 tests.

- [ ] **Step 5: Add the audio error classes**

`packages/core/src/error.ts`, after the `OpenAIImagesInvalidRequestError` class:

```ts
export class OpenAIAudioUnsupportedFeatureError extends AioProxyError {
  readonly code = 'UNSUPPORTED_OPENAI_AUDIO_FEATURE';
  readonly status = 501;

  constructor(readonly feature: 'stream_format' | 'chunking_strategy' | 'translations' | 'response_format') {
    super(`OpenAI Audio feature is not supported: ${feature}`);
  }
}

export class OpenAIAudioInvalidRequestError extends AioProxyError {
  readonly code = 'INVALID_OPENAI_AUDIO_REQUEST';
  readonly status = 400;

  constructor(readonly param: 'file' | 'input' | 'voice' | 'speed') {
    super(`Invalid OpenAI Audio request parameter: ${param}`);
  }
}
```

Match the base class and member style of the neighbouring `OpenAIImagesInvalidRequestError` exactly — read lines 145-175 first and mirror them.

- [ ] **Step 6: Add the audio error mapper**

`packages/core/src/protocol/errors.ts`, add both new classes to the `../error` import list, then after `openAIImagesUnsupported`:

```ts
const AUDIO_NOT_IMPLEMENTED_MESSAGE = 'No configured provider can serve OpenAI Audio for this model';
const AUDIO_UNSUPPORTED_FEATURES = new Set([
  'stream_format',
  'chunking_strategy',
  'translations',
  'response_format',
]);

export const openAIAudioErrors: ProtocolErrorMapper = {
  requestError: (error) => {
    if (error instanceof OpenAIAudioUnsupportedFeatureError) return openAIAudioUnsupported(error.feature);
    if (error instanceof OpenAIAudioInvalidRequestError) return openAIInvalid(400, 'invalid_request', error.message);
    if (error instanceof RequestBodyIdleTimeoutError) return openAIInvalid(408, 'request_timeout', error.message);
    if (error instanceof Error && error.name === 'AbortError') return openAIInvalid(499, 'aborted', error.message);
    return error instanceof SyntaxError ||
      error instanceof ZodError ||
      error instanceof InvalidCompressedRequestBodyError
      ? openAIInvalid(400, 'invalid_request', withZodDetail('Invalid OpenAI Audio request', error))
      : undefined;
  },
  modelNotFound: (message) => openAIInvalid(404, 'model_not_found', message),
  previousResponseConflict: () => openAIInvalid(409, 'previous_response_conflict', PREVIOUS_RESPONSE_CONFLICT_MESSAGE),
  tooLarge: () => openAIInvalid(413, 'request_too_large', 'Request body too large'),
  unsupportedContentEncoding: () => openAIInvalid(415, 'unsupported_content_encoding', 'Unsupported Content-Encoding'),
  unsupported: openAIAudioUnsupported,
  provider: openAIProviderError,
  rateLimited: openAIRateLimited,
};

function openAIAudioUnsupported(feature: string): Response {
  if (feature === 'audio') return openAIInvalid(501, 'not_implemented', AUDIO_NOT_IMPLEMENTED_MESSAGE);
  return AUDIO_UNSUPPORTED_FEATURES.has(feature)
    ? openAIInvalid(501, 'unsupported_feature', `OpenAI Audio feature is not supported: ${feature}`)
    : openAIInvalid(501, 'not_implemented', 'Provider does not support OpenAI Audio transform dispatch');
}
```

- [ ] **Step 7: Write the failing adapter test**

Create `packages/core/src/protocol/openai-audio/openai-audio.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { ProviderProtocol } from '@aio-proxy/types';

import { releaseMultipartSpool } from '../../ingress/multipart';
import { openAISpeechAdapter, openAITranscriptionAdapter } from './openai-audio';

function speechRequest(body: Record<string, unknown>): Request {
  return new Request('https://proxy.test/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function transcriptionRequest(model?: string): Request {
  const boundary = 'AUDIOB';
  const parts = [
    'Content-Disposition: form-data; name="file"; filename="clip.mp3"\r\nContent-Type: audio/mpeg\r\n\r\nID3AUDIO',
    ...(model === undefined ? [] : [`Content-Disposition: form-data; name="model"\r\n\r\n${model}`]),
    'Content-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nword',
  ];
  const text = `${parts.map((part) => `--${boundary}\r\n${part}\r\n`).join('')}--${boundary}--\r\n`;
  return new Request('https://proxy.test/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: new TextEncoder().encode(text),
  });
}

describe('openAISpeechAdapter', () => {
  test('declares the audio protocol and the speech capability', () => {
    expect(openAISpeechAdapter.protocol).toBe(ProviderProtocol.OpenAIAudio);
    expect(openAISpeechAdapter.capability).toBe('speech');
    expect(openAITranscriptionAdapter.capability).toBe('transcription');
  });

  test('parses a speech body and resolves the model', async () => {
    const request = await openAISpeechAdapter.parse(speechRequest({ input: 'hi', voice: 'alloy' }), {
      operation: 'speech',
    });
    expect(openAISpeechAdapter.model(request, { operation: 'speech' })).toBe('tts-1');
  });

  test('rewrites the raw body only when the resolved model differs', async () => {
    const context = { operation: 'speech' } as const;
    const unchanged = speechRequest({ model: 'tts-1', input: 'hi', voice: 'alloy' });
    const parsedUnchanged = await openAISpeechAdapter.parse(unchanged.clone(), context);
    const same = await openAISpeechAdapter.rawRequest(unchanged, parsedUnchanged, 'tts-1', new Set(), context);
    expect(await same.json()).toEqual({ model: 'tts-1', input: 'hi', voice: 'alloy' });

    const changed = speechRequest({ model: 'tts-1', input: 'hi', voice: 'alloy' });
    const parsedChanged = await openAISpeechAdapter.parse(changed.clone(), context);
    const rewritten = await openAISpeechAdapter.rawRequest(changed, parsedChanged, 'tts-1-hd', new Set(), context);
    expect(await rewritten.json()).toEqual({ model: 'tts-1-hd', input: 'hi', voice: 'alloy' });
  });

  test('converts a speech request into a speech invocation', async () => {
    const context = { operation: 'speech' } as const;
    const request = await openAISpeechAdapter.parse(
      speechRequest({ input: 'hi', voice: 'nova', response_format: 'opus', speed: 1.5, instructions: 'slow' }),
      context,
    );
    const invocation = openAISpeechAdapter.audioInvocation(request, context);
    expect(invocation).toEqual({
      kind: 'speech',
      speech: { text: 'hi', voice: 'nova', outputFormat: 'opus', speed: 1.5, instructions: 'slow' },
    });
  });

  test('rejects stream_format on the convert path', async () => {
    const context = { operation: 'speech' } as const;
    const request = await openAISpeechAdapter.parse(
      speechRequest({ input: 'hi', voice: 'alloy', stream_format: 'sse' }),
      context,
    );
    expect(() => openAISpeechAdapter.audioInvocation(request, context)).toThrow(
      'OpenAI Audio feature is not supported: stream_format',
    );
  });

  test('answers with the generated audio bytes and media type', async () => {
    const context = { operation: 'speech' } as const;
    const request = await openAISpeechAdapter.parse(speechRequest({ input: 'hi', voice: 'alloy' }), context);
    const response = await openAISpeechAdapter.audioResponse(
      { kind: 'speech', speech: { audio: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg' } },
      request,
      { modelId: 'tts-1' },
    );
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('openAITranscriptionAdapter', () => {
  test('parses multipart without touching readJsonRequest', async () => {
    const raw = transcriptionRequest('whisper-large');
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    expect(openAITranscriptionAdapter.model(request, { operation: 'transcriptions' })).toBe('whisper-large');
    expect(request.upload.filename).toBe('clip.mp3');
    await releaseMultipartSpool(raw);
  });

  test('replays the spooled body verbatim when the model is unchanged', async () => {
    const raw = transcriptionRequest('whisper-1');
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    const upstream = await openAITranscriptionAdapter.rawRequest(raw, request, 'whisper-1', new Set(), {
      operation: 'transcriptions',
    });
    expect(upstream.headers.get('content-type')).toContain('multipart/form-data; boundary=AUDIOB');
    expect(await upstream.text()).toContain('timestamp_granularities[]');
    await releaseMultipartSpool(raw);
  });

  test('rebuilds multipart keeping every client field when the model changes', async () => {
    const raw = transcriptionRequest('whisper-1');
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    const upstream = await openAITranscriptionAdapter.rawRequest(raw, request, 'whisper-large', new Set(), {
      operation: 'transcriptions',
    });
    const form = await upstream.formData();
    expect(form.get('model')).toBe('whisper-large');
    expect(form.get('timestamp_granularities[]')).toBe('word');
    expect(form.get('file')).toBeInstanceOf(File);
    await releaseMultipartSpool(raw);
  });

  test('skips the convert path for translations', async () => {
    const raw = transcriptionRequest('whisper-1');
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'translations' });
    expect(openAITranscriptionAdapter.convertSkipReason?.(request, 'whisper-1')).toBe('translations');
    await releaseMultipartSpool(raw);
  });

  test('has no convert skip reason for transcriptions', async () => {
    const raw = transcriptionRequest('whisper-1');
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    expect(openAITranscriptionAdapter.convertSkipReason?.(request, 'whisper-1')).toBeUndefined();
    await releaseMultipartSpool(raw);
  });

  test('renders the requested response format on egress', async () => {
    const raw = transcriptionRequest('whisper-1');
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    const response = await openAITranscriptionAdapter.audioResponse(
      { kind: 'transcription', transcription: { text: 'hello', segments: [] } },
      request,
      { modelId: 'whisper-1' },
    );
    expect(await response.json()).toEqual({ text: 'hello' });
    await releaseMultipartSpool(raw);
  });
});
```

- [ ] **Step 8: Run it and confirm the adapters are missing**

Run: `bun test packages/core/src/protocol/openai-audio/openai-audio.test.ts`

Expected: FAIL — cannot resolve `./openai-audio`.

- [ ] **Step 9: Write the adapters**

Create `packages/core/src/protocol/openai-audio/openai-audio.ts`:

```ts
import { ProviderProtocol } from '@aio-proxy/types';

import { OpenAIAudioUnsupportedFeatureError } from '../../error';
import { replaySpooledMultipartRaw } from '../../ingress/multipart';
import {
  AUDIO_MULTIPART_ENCODED_LIMIT,
  type OpenAISpeechRequest,
  type OpenAITranscriptionRequest,
  parseOpenAISpeech,
  parseOpenAITranscriptionMultipart,
} from '../../ingress/openai-audio';
import type { AudioEgressContext, AudioInvocation, AudioResult } from '../audio-adapter';
import { defineAudioProtocolAdapter } from '../audio-adapter';
import { openAIAudioErrors } from '../errors';
import { readJsonRequest, readRequestText, type RequestBodyLimits, stripHopHeaders } from '../request';

export type OpenAIAudioOperation = 'speech' | 'transcriptions' | 'translations';

export type OpenAIAudioContext = {
  readonly operation: OpenAIAudioOperation;
};

const AUDIO_BODY_LIMITS = Object.freeze({
  encoded: AUDIO_MULTIPART_ENCODED_LIMIT,
  decoded: AUDIO_MULTIPART_ENCODED_LIMIT,
}) satisfies RequestBodyLimits;

const audioBodyLimits = (): RequestBodyLimits => AUDIO_BODY_LIMITS;

export const openAISpeechAdapter = defineAudioProtocolAdapter<OpenAISpeechRequest, OpenAIAudioContext>({
  capability: 'speech',
  protocol: ProviderProtocol.OpenAIAudio,
  bodyLimits: audioBodyLimits,
  async parse(raw) {
    return parseOpenAISpeech(await readJsonRequest(raw, AUDIO_BODY_LIMITS));
  },
  model: (request) => request.model,
  async rawRequest(raw, request, resolvedModel) {
    if (!request.modelDefaulted && request.clientModel === resolvedModel) return raw.clone();
    const bodyText = await readRequestText(raw, AUDIO_BODY_LIMITS);
    return new Request(raw, {
      method: raw.method,
      body: JSON.stringify({ ...(JSON.parse(bodyText) as Record<string, unknown>), model: resolvedModel }),
      headers: stripHopHeaders(raw.headers),
    });
  },
  audioInvocation(request): AudioInvocation {
    if (request.stream_format !== undefined && request.stream_format !== null) {
      throw new OpenAIAudioUnsupportedFeatureError('stream_format');
    }
    return {
      kind: 'speech',
      speech: {
        text: request.input,
        voice: request.voice,
        ...(request.response_format === undefined || request.response_format === null
          ? {}
          : { outputFormat: request.response_format }),
        ...(request.speed === undefined || request.speed === null ? {} : { speed: request.speed }),
        ...(request.instructions === undefined || request.instructions === null
          ? {}
          : { instructions: request.instructions }),
      },
    };
  },
  audioResponse: async (result) => speechResponse(result),
  errors: openAIAudioErrors,
});

export const openAITranscriptionAdapter = defineAudioProtocolAdapter<
  OpenAITranscriptionRequest,
  OpenAIAudioContext
>({
  capability: 'transcription',
  protocol: ProviderProtocol.OpenAIAudio,
  bodyLimits: audioBodyLimits,
  parse: (raw) => parseOpenAITranscriptionMultipart(raw),
  model: (request) => request.model,
  async rawRequest(raw, request, resolvedModel) {
    // Nothing to change: replay the spooled bytes so the client's own boundary,
    // field order, and repeated fields reach upstream untouched.
    if (!request.modelDefaulted && request.clientModel === resolvedModel) return replaySpooledMultipartRaw(raw);
    const form = new FormData();
    // Copy EVERY client field verbatim and replace only `model`, so fields the
    // parser does not model — `timestamp_granularities[]`, `include[]` — survive.
    for (const [name, value] of Object.entries(request.formFields)) {
      if (name === 'model') continue;
      form.append(name, value);
    }
    form.append('model', resolvedModel);
    const upload = request.upload;
    form.append(
      upload.fieldName ?? 'file',
      new File([upload.data as BlobPart], upload.filename ?? 'audio', {
        ...(upload.mediaType === undefined ? {} : { type: upload.mediaType }),
      }),
    );
    const headers = stripHopHeaders(raw.headers);
    // FormData must set a fresh boundary; the client's content-type names the old one.
    headers.delete('content-type');
    return new Request(raw.url, { method: raw.method, body: form, headers, signal: raw.signal });
  },
  audioInvocation(request): AudioInvocation {
    if (request.stream_format !== undefined && request.stream_format !== null) {
      throw new OpenAIAudioUnsupportedFeatureError('stream_format');
    }
    if (request.chunking_strategy !== undefined && request.chunking_strategy !== null) {
      throw new OpenAIAudioUnsupportedFeatureError('chunking_strategy');
    }
    return {
      kind: 'transcription',
      transcription: {
        audio: request.upload.data,
        ...(request.upload.mediaType === undefined ? {} : { mediaType: request.upload.mediaType }),
      },
    };
  },
  audioResponse: async (result, request) => transcriptionResponse(result, request),
  // `transcribe` cannot translate, so translations are same-protocol raw only.
  convertSkipReason: (_request, _resolvedModelId) => undefined,
  errors: openAIAudioErrors,
});
```

The `convertSkipReason` above needs the operation, which lives on the context rather than the request, so replace it with a context-aware form. Change the adapter contract call to keep `convertSkipReason` off the transcription adapter and instead let `dispatchAudioCandidate` (Task 8) consult the operation. Concretely: delete the `convertSkipReason` line above and add an exported predicate at the bottom of the module:

```ts
/** `transcribe` has no translation mode, so translations never take the convert path. */
export function audioConvertSkipReason(context: OpenAIAudioContext): string | undefined {
  return context.operation === 'translations' ? 'translations' : undefined;
}
```

Then declare `convertSkipReason` on the audio adapter contract as taking the context. In `packages/core/src/protocol/audio-adapter/audio-adapter.ts`, change that member to:

```ts
    convertSkipReason?: (request: TRequest, resolvedModelId: string, context: TContext) => string | undefined;
```

and give the transcription adapter:

```ts
  convertSkipReason: (_request, _resolvedModelId, context) => audioConvertSkipReason(context),
```

Append the two egress helpers:

```ts
function speechResponse(result: AudioResult): Response {
  if (result.kind !== 'speech') throw new TypeError('OpenAI Audio speech egress requires a speech result');
  return new Response(result.speech.audio as BodyInit, {
    headers: { 'content-type': result.speech.mediaType },
  });
}

function transcriptionResponse(result: AudioResult, request: OpenAITranscriptionRequest): Response {
  if (result.kind !== 'transcription') {
    throw new TypeError('OpenAI Audio transcription egress requires a transcription result');
  }
  return renderTranscription(result.transcription, request.response_format);
}
```

adding `import { renderTranscription } from './transcription-egress';` and dropping the now-unused `AudioEgressContext` import if the compiler flags it.

- [ ] **Step 10: Create the barrel and register it**

`packages/core/src/protocol/openai-audio/index.ts`:

```ts
export {
  audioConvertSkipReason,
  type OpenAIAudioContext,
  type OpenAIAudioOperation,
  openAISpeechAdapter,
  openAITranscriptionAdapter,
} from './openai-audio';
export { renderTranscription } from './transcription-egress';
```

`packages/core/src/protocol/index.ts`, add after the `'./gemini-interactions'` line:

```ts
export * from './openai-audio';
```

Also export the audio ingress from the core index so the server can read `AUDIO_MULTIPART_ENCODED_LIMIT` and the parsed request types: check whether `packages/core/src/index.ts` already re-exports `./ingress/openai-image`; mirror whatever it does for `./ingress/openai-audio`.

- [ ] **Step 11: Run the adapter tests**

Run: `bun test packages/core/src/protocol/openai-audio`

Expected: PASS — 5 renderer tests plus 13 adapter tests.

Run: `bun run check`

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): add the OpenAI audio speech and transcription adapters"
```

---

## Task 6: Invoke audio models through the AI SDK

**Files:**
- Create: `packages/core/src/provider/provider-v4-audio/provider-v4-audio.ts`
- Create: `packages/core/src/provider/provider-v4-audio/index.ts`
- Create: `packages/core/src/provider/provider-v4-audio/provider-v4-audio.test.ts`
- Modify: `packages/core/src/ai-sdk-bridge/index.ts:21` and `:46`
- Modify: `packages/core/src/provider/index.ts`

**Interfaces:**
- Consumes: `type SpeechInvocation`, `type TranscriptionInvocation`, `type SpeechResultData`, `type TranscriptionResultData` from `../../protocol/audio-adapter`; `generateSpeech`, `transcribe` from `../../ai-sdk-bridge`.
- Produces:
  - `createProviderV4SpeechInvoke(providerId: string, provider: ProviderV4): (invocation: SpeechInvocation, options: { readonly modelId: string; readonly signal?: AbortSignal }) => Promise<SpeechResultData>`
  - `createProviderV4TranscribeInvoke(providerId: string, provider: ProviderV4): (invocation: TranscriptionInvocation, options: { readonly modelId: string; readonly signal?: AbortSignal }) => Promise<TranscriptionResultData>`
  - `providerV4SupportsSpeech(provider: ProviderV4): boolean`
  - `providerV4SupportsTranscription(provider: ProviderV4): boolean`

- [ ] **Step 1: Re-export the two AI SDK audio entry points**

`packages/core/src/ai-sdk-bridge/index.ts` — add `generateSpeech,` and `transcribe,` to the alphabetically sorted `from 'ai'` import at line 21 and to the matching export list at line 46. Read both lists first and keep their existing sort order.

- [ ] **Step 2: Write the failing invoke test**

Create `packages/core/src/provider/provider-v4-audio/provider-v4-audio.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import {
  createProviderV4SpeechInvoke,
  createProviderV4TranscribeInvoke,
  providerV4SupportsSpeech,
  providerV4SupportsTranscription,
} from './provider-v4-audio';

const SPEECH_MODEL = {
  specificationVersion: 'v3',
  provider: 'stub',
  modelId: 'tts-1',
  doGenerate: async (options: { text: string }) => ({
    audio: new Uint8Array([9, 9]),
    warnings: [],
    request: {},
    response: { timestamp: new Date(0), modelId: 'tts-1', headers: {}, body: options.text },
  }),
};

const TRANSCRIPTION_MODEL = {
  specificationVersion: 'v3',
  provider: 'stub',
  modelId: 'whisper-1',
  doGenerate: async () => ({
    text: 'hello',
    segments: [{ text: 'hello', startSecond: 0, endSecond: 1 }],
    language: 'en',
    durationInSeconds: 1,
    warnings: [],
    response: { timestamp: new Date(0), modelId: 'whisper-1', headers: {}, body: undefined },
  }),
};

describe('createProviderV4SpeechInvoke', () => {
  test('returns the generated bytes and a media type', async () => {
    const invoke = createProviderV4SpeechInvoke('stub', {
      speechModel: () => SPEECH_MODEL,
    } as never);
    const result = await invoke({ text: 'hi', voice: 'alloy' }, { modelId: 'tts-1' });
    expect(result.audio).toEqual(new Uint8Array([9, 9]));
    expect(result.mediaType).toBe('audio/mpeg');
  });

  test('fails with a clear provider error when speech is unsupported', async () => {
    const invoke = createProviderV4SpeechInvoke('stub', {} as never);
    await expect(invoke({ text: 'hi' }, { modelId: 'tts-1' })).rejects.toThrow(
      "Provider 'stub' does not support speech generation",
    );
  });
});

describe('createProviderV4TranscribeInvoke', () => {
  test('returns text, segments, language, and duration', async () => {
    const invoke = createProviderV4TranscribeInvoke('stub', {
      transcriptionModel: () => TRANSCRIPTION_MODEL,
    } as never);
    const result = await invoke(
      { audio: new Uint8Array([1]), mediaType: 'audio/mpeg' },
      { modelId: 'whisper-1' },
    );
    expect(result.text).toBe('hello');
    expect(result.segments).toEqual([{ text: 'hello', startSecond: 0, endSecond: 1 }]);
    expect(result.language).toBe('en');
    expect(result.durationInSeconds).toBe(1);
  });

  test('fails with a clear provider error when transcription is unsupported', async () => {
    const invoke = createProviderV4TranscribeInvoke('stub', {} as never);
    await expect(invoke({ audio: new Uint8Array([1]) }, { modelId: 'whisper-1' })).rejects.toThrow(
      "Provider 'stub' does not support transcription",
    );
  });
});

describe('capability probes', () => {
  test('detect the optional ProviderV4 audio methods', () => {
    expect(providerV4SupportsSpeech({ speechModel: () => SPEECH_MODEL } as never)).toBe(true);
    expect(providerV4SupportsSpeech({} as never)).toBe(false);
    expect(providerV4SupportsTranscription({ transcriptionModel: () => TRANSCRIPTION_MODEL } as never)).toBe(true);
    expect(providerV4SupportsTranscription({} as never)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and confirm the module is missing**

Run: `bun test packages/core/src/provider/provider-v4-audio/provider-v4-audio.test.ts`

Expected: FAIL — cannot resolve `./provider-v4-audio`.

- [ ] **Step 4: Write the invokers**

Create `packages/core/src/provider/provider-v4-audio/provider-v4-audio.ts`. Read `packages/core/src/provider/provider-v4-image/provider-v4-image.ts` first and mirror its error style and its `ProviderV4` import path exactly.

```ts
import { generateSpeech, transcribe } from '../../ai-sdk-bridge';
import type {
  SpeechInvocation,
  SpeechResultData,
  TranscriptionInvocation,
  TranscriptionResultData,
} from '../../protocol/audio-adapter';
import type { ProviderV4 } from '../provider-v4-image/provider-v4-image';

export type AudioInvokeOptions = {
  readonly modelId: string;
  readonly signal?: AbortSignal;
};

// `speechModel` and `transcriptionModel` are OPTIONAL ProviderV4 members:
// @ai-sdk/openai implements both, @ai-sdk/openai-compatible implements neither.
// Probe before dispatch so an unsupported provider fails the candidate instead
// of throwing an opaque TypeError from inside the AI SDK.
export function providerV4SupportsSpeech(provider: ProviderV4): boolean {
  return typeof provider.speechModel === 'function';
}

export function providerV4SupportsTranscription(provider: ProviderV4): boolean {
  return typeof provider.transcriptionModel === 'function';
}

export function createProviderV4SpeechInvoke(
  providerId: string,
  provider: ProviderV4,
): (invocation: SpeechInvocation, options: AudioInvokeOptions) => Promise<SpeechResultData> {
  return async (invocation, options) => {
    if (!providerV4SupportsSpeech(provider)) {
      throw new TypeError(`Provider '${providerId}' does not support speech generation`);
    }
    const result = await generateSpeech({
      model: provider.speechModel(options.modelId),
      text: invocation.text,
      ...(invocation.voice === undefined ? {} : { voice: invocation.voice }),
      ...(invocation.outputFormat === undefined ? {} : { outputFormat: invocation.outputFormat }),
      ...(invocation.instructions === undefined ? {} : { instructions: invocation.instructions }),
      ...(invocation.speed === undefined ? {} : { speed: invocation.speed }),
      ...(invocation.language === undefined ? {} : { language: invocation.language }),
      ...(invocation.providerOptions === undefined ? {} : { providerOptions: invocation.providerOptions }),
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    });
    return { audio: result.audio.uint8Array, mediaType: result.audio.mediaType };
  };
}

export function createProviderV4TranscribeInvoke(
  providerId: string,
  provider: ProviderV4,
): (invocation: TranscriptionInvocation, options: AudioInvokeOptions) => Promise<TranscriptionResultData> {
  return async (invocation, options) => {
    if (!providerV4SupportsTranscription(provider)) {
      throw new TypeError(`Provider '${providerId}' does not support transcription`);
    }
    const result = await transcribe({
      model: provider.transcriptionModel(options.modelId),
      audio: invocation.audio,
      ...(invocation.mediaType === undefined ? {} : { mediaType: invocation.mediaType }),
      ...(invocation.providerOptions === undefined ? {} : { providerOptions: invocation.providerOptions }),
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    });
    return {
      text: result.text,
      segments: result.segments,
      ...(result.language === undefined ? {} : { language: result.language }),
      ...(result.durationInSeconds === undefined ? {} : { durationInSeconds: result.durationInSeconds }),
    };
  };
}
```

If `ProviderV4` is not exported from `provider-v4-image/provider-v4-image.ts`, import it from wherever `provider-v4-image.ts` gets it and widen that type with the two optional members:

```ts
speechModel?: (modelId: string) => Parameters<typeof generateSpeech>[0]['model'];
transcriptionModel?: (modelId: string) => Parameters<typeof transcribe>[0]['model'];
```

- [ ] **Step 5: Create the barrel and register it**

`packages/core/src/provider/provider-v4-audio/index.ts`:

```ts
export {
  type AudioInvokeOptions,
  createProviderV4SpeechInvoke,
  createProviderV4TranscribeInvoke,
  providerV4SupportsSpeech,
  providerV4SupportsTranscription,
} from './provider-v4-audio';
```

`packages/core/src/provider/index.ts`, add next to the `provider-v4-image` export:

```ts
export * from './provider-v4-audio';
```

- [ ] **Step 6: Run the tests**

Run: `bun test packages/core/src/provider/provider-v4-audio`

Expected: PASS — 5 tests.

Run: `bun run check`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/ai-sdk-bridge packages/core/src/provider
git commit -m "feat(core): invoke speech and transcription models through the AI SDK"
```

---

## Task 7: Add the audio runtime transports

**Files:**
- Modify: `packages/server/src/runtime.ts` (`InboundCapability` at line 71, `RawResolveInput.capability` at line 44, `RuntimeProviderInstance`)
- Modify: `packages/server/src/provider-runtime/materialize.ts:130-165` (`isMaterializedRuntimeProvider`, the capability `TypeError`)
- Modify: `packages/plugin-sdk/src/runtime.ts` (`ProtocolId`, `RawResolver` input capability)
- Modify: `packages/server/src/provider-runtime/materialize/materialize.test.ts` (or the colocated equivalent — locate it with `bun test packages/server/src/provider-runtime` first)

**Interfaces:**
- Consumes: `type SpeechInvocation`, `type TranscriptionInvocation`, `type SpeechResultData`, `type TranscriptionResultData` from `@aio-proxy/core`.
- Produces:
  - `type SpeechTransport = { readonly ensureAvailable?: (modelId: string) => Promise<void>; readonly invoke: (invocation: SpeechInvocation, options: { readonly modelId: string; readonly signal?: AbortSignal; readonly logicalRequest: LogicalRequestContext }) => Promise<SpeechResultData> }`
  - `type TranscriptionTransport = { readonly ensureAvailable?: (modelId: string) => Promise<void>; readonly invoke: (invocation: TranscriptionInvocation, options: { readonly modelId: string; readonly signal?: AbortSignal; readonly logicalRequest: LogicalRequestContext }) => Promise<TranscriptionResultData> }`
  - `RuntimeProviderInstance` gains `{ readonly speech: SpeechTransport }` and `{ readonly transcription: TranscriptionTransport }` arms
  - `InboundCapability` = `'language' | 'image' | 'embedding' | 'speech' | 'transcription'`

- [ ] **Step 1: Write the failing materialize-guard test**

Add to the existing materialize test file:

```ts
test('accepts a provider that exposes only a speech transport', () => {
  const provider = {
    id: 'tts',
    speech: { invoke: async () => ({ audio: new Uint8Array(), mediaType: 'audio/mpeg' }) },
  };
  expect(isMaterializedRuntimeProvider(provider)).toBe(true);
});

test('accepts a provider that exposes only a transcription transport', () => {
  const provider = {
    id: 'stt',
    transcription: { invoke: async () => ({ text: '', segments: [] }) },
  };
  expect(isMaterializedRuntimeProvider(provider)).toBe(true);
});

test('rejects a provider with no capability at all', () => {
  expect(isMaterializedRuntimeProvider({ id: 'empty' })).toBe(false);
});
```

Match the file's existing import list and helper style; if `isMaterializedRuntimeProvider` is module-private, assert the same behavior through `materializeRuntimeProvider` instead of exporting it.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/server/src/provider-runtime`

Expected: FAIL — the speech/transcription providers are rejected.

- [ ] **Step 3: Widen the runtime capability surface**

`packages/server/src/runtime.ts`:

Line 44 — widen the raw-resolve capability:

```ts
  readonly capability?: 'language' | 'embedding' | 'speech' | 'transcription';
```

Line 71:

```ts
export type InboundCapability = 'language' | 'image' | 'embedding' | 'speech' | 'transcription';
```

After `ImageTransport`, add both audio transports:

```ts
export type SpeechTransport = {
  readonly ensureAvailable?: (modelId: string) => Promise<void>;
  readonly invoke: (
    invocation: SpeechInvocation,
    options: {
      readonly modelId: string;
      readonly signal?: AbortSignal;
      readonly logicalRequest: LogicalRequestContext;
    },
  ) => Promise<SpeechResultData>;
};

export type TranscriptionTransport = {
  readonly ensureAvailable?: (modelId: string) => Promise<void>;
  readonly invoke: (
    invocation: TranscriptionInvocation,
    options: {
      readonly modelId: string;
      readonly signal?: AbortSignal;
      readonly logicalRequest: LogicalRequestContext;
    },
  ) => Promise<TranscriptionResultData>;
};
```

Add `SpeechInvocation`, `SpeechResultData`, `TranscriptionInvocation`, `TranscriptionResultData` to the existing `@aio-proxy/core` type import.

Then extend `RuntimeProviderInstance` from four arms to six, following the exact shape of the existing arms — each new arm requires its own transport and marks all five others `never`-optional the same way the current arms do. Read lines 95-135 and copy the pattern rather than inventing a new one.

- [ ] **Step 4: Widen the materialize guard**

`packages/server/src/provider-runtime/materialize.ts` — add `speech` and `transcription` to `isMaterializedRuntimeProvider`'s capability check, and update the thrown message:

```ts
    throw new TypeError(
      'Runtime provider must expose a raw, model, image, embedding, speech, or transcription capability',
    );
```

Search the repo for that old message string and update every test asserting it:

```bash
rg -n 'image, or embedding capability' packages
```

- [ ] **Step 5: Widen the plugin SDK**

`packages/plugin-sdk/src/runtime.ts` — add `| 'openai-audio'` to `ProtocolId` (lines 7-13) and widen the `RawResolver` input's `capability` union to match `runtime.ts`. `ModelCatalog` already declares `speech` and `transcription`, so it needs no change.

- [ ] **Step 6: Run the tests**

Run: `bun test packages/server/src/provider-runtime`

Expected: PASS — including the three new guard tests.

Run: `bun run check`

Expected: PASS. If the compiler flags plugin raw resolvers that switch exhaustively over `capability`, note the files — Task 8 fixes them.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/runtime.ts packages/server/src/provider-runtime packages/plugin-sdk/src/runtime.ts
git commit -m "feat(server): add speech and transcription runtime transports"
```

---

## Task 8: Route audio candidates to providers that can serve them

**Files:**
- Create: `packages/server/src/provider-runtime/materialize-audio/materialize-audio.ts`
- Create: `packages/server/src/provider-runtime/materialize-audio/index.ts`
- Create: `packages/server/src/provider-runtime/materialize-audio/materialize-audio.test.ts`
- Modify: `packages/server/src/provider-runtime/capability-index/capability-index.ts`
- Modify: `packages/server/src/provider-runtime/capability-index/capability-index.test.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/capability-filter/capability-filter.ts` and its `index.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/capability-filter/capability-filter.test.ts`
- Modify: `packages/server/src/provider-runtime/materialize.ts`
- Modify: `packages/server/src/plugin-runtime/capabilities.ts` (`catalogModelIds`, `createRuntimeProvider`)
- Modify: the four plugin raw resolvers that decline embeddings, plus their tests

**Interfaces:**
- Consumes: `createProviderV4SpeechInvoke`, `createProviderV4TranscribeInvoke`, `providerV4SupportsSpeech`, `providerV4SupportsTranscription` (Task 6); `type SpeechTransport`, `type TranscriptionTransport` (Task 7).
- Produces:
  - `AUDIO_BRIDGE_PACKAGES: ReadonlySet<string>` — exactly `new Set(['@ai-sdk/openai'])`
  - `attachAudioTransports(input: { readonly providerId: string; readonly provider: ProviderV4 }): { readonly speech?: SpeechTransport; readonly transcription?: TranscriptionTransport }`
  - `supportsSpeech(index: ModelCapabilityIndex, modelId: string): boolean`
  - `supportsTranscription(index: ModelCapabilityIndex, modelId: string): boolean`
  - `candidateSupportsAudio(candidate: Candidate, capability: 'speech' | 'transcription', index: ModelCapabilityIndex): boolean`
  - `filterCandidatesByCapability` accepts `'speech'` and `'transcription'`

- [ ] **Step 1: Write the failing capability-index test**

Append to `packages/server/src/provider-runtime/capability-index/capability-index.test.ts`, mirroring the existing image/embedding cases:

```ts
test('indexes speech and transcription catalog entries', () => {
  const index = buildModelCapabilityIndex([
    { id: 'openai', catalog: { speech: ['tts-1'], transcription: ['whisper-1'] } },
  ]);
  expect(supportsSpeech(index, 'tts-1')).toBe(true);
  expect(supportsTranscription(index, 'whisper-1')).toBe(true);
  expect(supportsSpeech(index, 'whisper-1')).toBe(false);
  expect(supportsTranscription(index, 'tts-1')).toBe(false);
});
```

Add `supportsSpeech, supportsTranscription` to the file's import.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/server/src/provider-runtime/capability-index`

Expected: FAIL — `supportsSpeech` is not exported.

- [ ] **Step 3: Extend the capability index**

`packages/server/src/provider-runtime/capability-index/capability-index.ts` — add `speech?: readonly string[]` and `transcription?: readonly string[]` to `CapabilityIndexInput.catalog`, record both in `buildModelCapabilityIndex` alongside the existing three, and add:

```ts
export function supportsSpeech(index: ModelCapabilityIndex, modelId: string): boolean {
  return index[modelId]?.has('speech') === true;
}

export function supportsTranscription(index: ModelCapabilityIndex, modelId: string): boolean {
  return index[modelId]?.has('transcription') === true;
}
```

Export both from the directory barrel.

- [ ] **Step 4: Write the failing capability-filter test**

Append to `packages/server/src/routes/pipeline/attempt/capability-filter/capability-filter.test.ts`:

```ts
test('keeps only candidates whose model can serve the audio capability', () => {
  const index = { 'tts-1': new Set(['speech']), 'whisper-1': new Set(['transcription']) };
  const candidates = [
    { providerId: 'a', modelId: 'tts-1' },
    { providerId: 'b', modelId: 'whisper-1' },
  ];
  expect(filterCandidatesByCapability(candidates, 'speech', index).map((c) => c.providerId)).toEqual(['a']);
  expect(filterCandidatesByCapability(candidates, 'transcription', index).map((c) => c.providerId)).toEqual(['b']);
});
```

Shape the candidate literals to match whatever the neighbouring tests in that file build — read them first.

- [ ] **Step 5: Extend the capability filter**

`capability-filter.ts` — add the audio branches beside the image branch:

```ts
export function candidateSupportsAudio(
  candidate: Candidate,
  capability: 'speech' | 'transcription',
  index: ModelCapabilityIndex,
): boolean {
  // API providers reach audio through same-protocol raw passthrough, so they are
  // eligible regardless of what the model catalog knows about them.
  if (candidate.kind === 'api') return true;
  return capability === 'speech'
    ? supportsSpeech(index, candidate.modelId)
    : supportsTranscription(index, candidate.modelId);
}
```

and add the `'speech'` / `'transcription'` cases to `filterCandidatesByCapability`'s dispatch, using the exact structure the image case uses. Export `candidateSupportsAudio` from the barrel.

- [ ] **Step 6: Write the failing materialize-audio test**

Create `packages/server/src/provider-runtime/materialize-audio/materialize-audio.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { attachAudioTransports, AUDIO_BRIDGE_PACKAGES } from './materialize-audio';

describe('AUDIO_BRIDGE_PACKAGES', () => {
  test('lists only the AI SDK packages that actually implement audio models', () => {
    // @ai-sdk/openai-compatible implements neither speechModel nor
    // transcriptionModel, so an openai-compatible provider can never serve audio
    // on the convert path.
    expect([...AUDIO_BRIDGE_PACKAGES]).toEqual(['@ai-sdk/openai']);
  });
});

describe('attachAudioTransports', () => {
  test('attaches only the transports the provider implements', () => {
    const speechOnly = attachAudioTransports({
      providerId: 'p',
      provider: { speechModel: () => ({}) } as never,
    });
    expect(speechOnly.speech).toBeDefined();
    expect(speechOnly.transcription).toBeUndefined();

    const both = attachAudioTransports({
      providerId: 'p',
      provider: { speechModel: () => ({}), transcriptionModel: () => ({}) } as never,
    });
    expect(both.speech).toBeDefined();
    expect(both.transcription).toBeDefined();

    expect(attachAudioTransports({ providerId: 'p', provider: {} as never })).toEqual({});
  });
});
```

- [ ] **Step 7: Run it and confirm the module is missing**

Run: `bun test packages/server/src/provider-runtime/materialize-audio`

Expected: FAIL — cannot resolve `./materialize-audio`.

- [ ] **Step 8: Write the audio materializer**

Create `packages/server/src/provider-runtime/materialize-audio/materialize-audio.ts`, mirroring `materialize-image/materialize-image.ts`:

```ts
import {
  createProviderV4SpeechInvoke,
  createProviderV4TranscribeInvoke,
  providerV4SupportsSpeech,
  providerV4SupportsTranscription,
  type ProviderV4,
} from '@aio-proxy/core';

import type { SpeechTransport, TranscriptionTransport } from '../../runtime';

/**
 * Only @ai-sdk/openai implements the optional `speechModel` and
 * `transcriptionModel` ProviderV4 members. @ai-sdk/openai-compatible does not,
 * so an openai-compatible API provider can only serve audio through
 * same-protocol raw passthrough.
 */
export const AUDIO_BRIDGE_PACKAGES: ReadonlySet<string> = new Set(['@ai-sdk/openai']);

export function attachAudioTransports(input: {
  readonly providerId: string;
  readonly provider: ProviderV4;
}): { readonly speech?: SpeechTransport; readonly transcription?: TranscriptionTransport } {
  const speechInvoke = createProviderV4SpeechInvoke(input.providerId, input.provider);
  const transcribeInvoke = createProviderV4TranscribeInvoke(input.providerId, input.provider);
  return {
    ...(providerV4SupportsSpeech(input.provider)
      ? { speech: { invoke: (invocation, options) => speechInvoke(invocation, options) } }
      : {}),
    ...(providerV4SupportsTranscription(input.provider)
      ? { transcription: { invoke: (invocation, options) => transcribeInvoke(invocation, options) } }
      : {}),
  };
}
```

Barrel `index.ts`:

```ts
export { attachAudioTransports, AUDIO_BRIDGE_PACKAGES } from './materialize-audio';
```

- [ ] **Step 9: Wire the materializer into provider materialization**

`packages/server/src/provider-runtime/materialize.ts` — in the `ai-sdk` branch, where `IMAGE_BRIDGE_PACKAGES` gates the image transport, add the parallel audio gate using `AUDIO_BRIDGE_PACKAGES` and `attachAudioTransports`, and spread the returned transports onto the runtime provider. Read the existing image gate and mirror it exactly; do not restructure the branch.

In the `api` branch, no change is needed: `raw.resolve` destructures only `{ protocol }`, so an API provider whose protocol is `openai-audio` already raw-passthroughs.

- [ ] **Step 10: Wire the plugin runtime**

`packages/server/src/plugin-runtime/capabilities.ts`:

- `catalogModelIds` — widen its parameter to `Pick<ModelCatalog, 'language' | 'image' | 'embedding' | 'speech' | 'transcription'>` and include both new arrays.
- `createRuntimeProvider` — after the `embedding` const, add:

```ts
  const speech =
    catalog.speech.length > 0
      ? { invoke: createProviderV4SpeechInvoke(config.id, result.provider) }
      : undefined;
  const transcription =
    catalog.transcription.length > 0
      ? { invoke: createProviderV4TranscribeInvoke(config.id, result.provider) }
      : undefined;
```

and add two returns to the existing gate chain, in the order `language` → `image` → `embedding` → `speech` → `transcription` → `raw`, matching the shape of the neighbouring returns.

- [ ] **Step 11: Make the plugin raw resolvers decline audio**

Find every raw resolver that declines embeddings:

```bash
rg -n "capability === 'embedding'" packages/plugins
```

For each hit, decline audio the same way — an OAuth plugin's chat endpoint cannot serve `/v1/audio/*`:

```ts
    if (input.capability === 'embedding' || input.capability === 'speech' || input.capability === 'transcription') {
      return undefined;
    }
```

Update each plugin's colocated test with the matching assertion, copying the existing embedding assertion and substituting the capability.

- [ ] **Step 12: Run every touched suite**

Run: `bun test packages/server/src/provider-runtime packages/server/src/plugin-runtime packages/server/src/routes/pipeline/attempt/capability-filter packages/plugins`

Expected: PASS.

Run: `bun run check`

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add packages/server/src packages/plugins
git commit -m "feat(server): materialize and filter audio-capable candidates"
```

---

## Task 9: Record audio usage without fabricating tokens

Neither `SpeechResult` nor `TranscriptionResult` carries usage. Raw passthrough may report real usage in its JSON body; a binary TTS response reports none. Nothing is ever estimated from audio duration or PCM byte counts.

**Files:**
- Create: `packages/server/src/usage-capture/audio-capture/audio-capture.ts`
- Create: `packages/server/src/usage-capture/audio-capture/index.ts`
- Create: `packages/server/src/usage-capture/audio-capture/audio-capture.test.ts`
- Modify: `packages/server/src/usage-capture/index.ts`
- Modify: `packages/server/src/passthrough-usage/usage.ts`
- Create: `packages/server/src/passthrough-usage/openai-audio/openai-audio.ts`
- Create: `packages/server/src/passthrough-usage/openai-audio/index.ts`
- Create: `packages/server/src/passthrough-usage/openai-audio/openai-audio.test.ts`

**Interfaces:**
- Consumes: `finalizeUsage` from `../usage-validation`; `type UsageField` and the shared field readers from `../shared`.
- Produces:
  - `captureAudioUsage(input: { readonly providerId: string; readonly modelId: string; readonly priceModelId?: string; readonly configPrice?: ConfigPrice; readonly logicalRequest: LogicalRequestContext }): Promise<void>`
  - `openAIAudioUsage(value: unknown): PassthroughUsage`

- [ ] **Step 1: Write the failing passthrough-usage test**

Create `packages/server/src/passthrough-usage/openai-audio/openai-audio.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { openAIAudioUsage } from './openai-audio';

describe('openAIAudioUsage', () => {
  test('reads the usage block a transcription response reports', () => {
    expect(
      openAIAudioUsage({
        text: 'hi',
        usage: { type: 'tokens', input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      }),
    ).toEqual({
      kind: 'present',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });
  });

  test('reads audio input token details when the provider reports them', () => {
    expect(
      openAIAudioUsage({
        usage: {
          type: 'tokens',
          input_tokens: 20,
          input_token_details: { text_tokens: 5, audio_tokens: 15 },
          output_tokens: 4,
        },
      }),
    ).toEqual({
      kind: 'present',
      usage: { inputTokens: 20, inputAudioTokens: 15, outputTokens: 4 },
    });
  });

  test('reports absent rather than zero when the response carries no usage', () => {
    expect(openAIAudioUsage({ text: 'hi' })).toEqual({ kind: 'absent' });
    // A duration-only response must NOT become a token estimate: new-api's
    // `1 min = 1000 tokens` rule is deliberately not adopted.
    expect(openAIAudioUsage({ text: 'hi', duration: 61 })).toEqual({ kind: 'absent' });
  });

  test('reports absent for a non-object body such as raw audio bytes', () => {
    expect(openAIAudioUsage(undefined)).toEqual({ kind: 'absent' });
    expect(openAIAudioUsage('binary')).toEqual({ kind: 'absent' });
  });
});
```

- [ ] **Step 2: Run it and confirm the module is missing**

Run: `bun test packages/server/src/passthrough-usage/openai-audio`

Expected: FAIL — cannot resolve `./openai-audio`.

- [ ] **Step 3: Write the passthrough usage reader**

Create `packages/server/src/passthrough-usage/openai-audio/openai-audio.ts`. Read `packages/server/src/passthrough-usage/shared.ts` first and reuse its `UsageField` reader helpers rather than hand-rolling number coercion.

```ts
import { isPlainObject } from 'es-toolkit/predicate';

import { readUsageField, type PassthroughUsage } from '../shared';

/**
 * Audio usage is whatever upstream reports and nothing more. Duration is NOT
 * converted to tokens: new-api's `common/audio.go` estimates PCM duration at
 * 24000 Hz x 2 bytes x 1 channel and bills 1000 tokens per minute, which
 * invents numbers the provider never charged. aio-proxy reports `absent` and
 * lets the configured per-request fee, if any, be the only charge.
 */
export function openAIAudioUsage(value: unknown): PassthroughUsage {
  if (!isPlainObject(value)) return { kind: 'absent' };
  const usage = value['usage'];
  if (!isPlainObject(usage)) return { kind: 'absent' };
  const inputDetails = isPlainObject(usage['input_token_details']) ? usage['input_token_details'] : undefined;
  const fields = {
    inputTokens: readUsageField(usage['input_tokens']),
    outputTokens: readUsageField(usage['output_tokens']),
    totalTokens: readUsageField(usage['total_tokens']),
    inputAudioTokens: readUsageField(inputDetails?.['audio_tokens']),
  };
  const present = Object.entries(fields).filter(([, count]) => count !== undefined);
  return present.length === 0 ? { kind: 'absent' } : { kind: 'present', usage: Object.fromEntries(present) };
}
```

Adjust the helper name and the `PassthroughUsage` shape to match `shared.ts` exactly — the reader helper there may be named differently; use whatever `openAICompatibleUsage` uses.

Barrel `index.ts`:

```ts
export { openAIAudioUsage } from './openai-audio';
```

- [ ] **Step 4: Replace the Task 1 stub in the protocol switch**

`packages/server/src/passthrough-usage/usage.ts` — replace the temporary `case ProviderProtocol.OpenAIAudio: return { kind: 'absent' };` with:

```ts
    case ProviderProtocol.OpenAIAudio:
      return openAIAudioUsage(value);
```

and add the import.

- [ ] **Step 5: Run it and verify it passes**

Run: `bun test packages/server/src/passthrough-usage`

Expected: PASS — 4 new tests plus the existing suite.

- [ ] **Step 6: Write the failing capture test**

Create `packages/server/src/usage-capture/audio-capture/audio-capture.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { captureAudioUsage } from './audio-capture';

describe('captureAudioUsage', () => {
  test('records nothing when there is no usage and no per-request fee', async () => {
    const rows: unknown[] = [];
    await captureAudioUsage({
      providerId: 'openai',
      modelId: 'tts-1',
      logicalRequest: { recordUsage: (row: unknown) => rows.push(row) } as never,
    });
    expect(rows).toEqual([]);
  });

  test('records a row so a configured per-request fee still bills a binary response', async () => {
    const rows: unknown[] = [];
    await captureAudioUsage({
      providerId: 'openai',
      modelId: 'tts-1',
      configPrice: { request: 0.015 },
      logicalRequest: { recordUsage: (row: unknown) => rows.push(row) } as never,
    });
    expect(rows).toHaveLength(1);
  });
});
```

Shape the `logicalRequest` stub and the `configPrice` literal to match `packages/server/src/usage-capture/image-capture`'s existing test — read it and copy its fixtures.

- [ ] **Step 7: Run it and confirm the module is missing**

Run: `bun test packages/server/src/usage-capture/audio-capture`

Expected: FAIL — cannot resolve `./audio-capture`.

- [ ] **Step 8: Write the capture function**

Create `packages/server/src/usage-capture/audio-capture/audio-capture.ts`, mirroring `captureImageUsage`:

```ts
import { finalizeUsage } from '../usage-validation';

/**
 * Audio convert results carry no usage at all, so this exists only so a
 * configured per-request fee reaches accounting: `finalizeUsage`'s
 * `seedForRequestFee` emits a `{providerId, modelId}` row when `usage` is
 * undefined and `configPrice.request > 0`. Passing `usage: undefined` is
 * deliberate — audio token counts are never estimated.
 */
export async function captureAudioUsage(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly priceModelId?: string;
  readonly configPrice?: Parameters<typeof finalizeUsage>[0]['configPrice'];
  readonly logicalRequest: Parameters<typeof finalizeUsage>[0]['logicalRequest'];
}): Promise<void> {
  await finalizeUsage({
    usage: undefined,
    providerId: input.providerId,
    modelId: input.modelId,
    ...(input.priceModelId === undefined ? {} : { priceModelId: input.priceModelId }),
    ...(input.configPrice === undefined ? {} : { configPrice: input.configPrice }),
    logicalRequest: input.logicalRequest,
    accounting: { source: 'ai-sdk' },
  });
}
```

Read `finalizeUsage`'s real signature at `packages/server/src/usage-capture/usage-validation.ts:1-40` and pass exactly the members it declares — replace the `Parameters<>` shortcuts with the concrete types it exports if they are exported.

Barrel `index.ts`:

```ts
export { captureAudioUsage } from './audio-capture';
```

Add to `packages/server/src/usage-capture/index.ts`, next to the image-capture export:

```ts
export * from './audio-capture';
```

- [ ] **Step 9: Run both suites**

Run: `bun test packages/server/src/usage-capture packages/server/src/passthrough-usage`

Expected: PASS.

Run: `bun run check`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/usage-capture packages/server/src/passthrough-usage
git commit -m "feat(server): record OpenAI audio usage without estimating tokens"
```

---

## Task 10: Dispatch audio candidates in the pipeline

`attempt.ts` stays the only candidate loop. This task adds its fourth arm: same-protocol raw first, then convert through the audio transport, with fallback and usage.

**Files:**
- Create: `packages/server/src/routes/pipeline/attempt/audio.ts`
- Create: `packages/server/src/routes/pipeline/attempt/audio.test.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/attempt.ts:32`, `:95-125`, `:210-225`
- Modify: `packages/server/src/routes/pipeline/context.ts:44-46`, `:86-96`
- Modify: `packages/server/src/routes/pipeline/index.ts` (four adapter-union sites, plus line 262)
- Modify: `packages/server/src/routes/pipeline/attempt-base/attempt-base.ts:22`
- Modify: `packages/server/__tests__/pipeline-helpers/types.ts:52`
- Modify: `packages/server/src/routes/pipeline/test-support.ts`

**Interfaces:**
- Consumes: `attemptRawCandidate`, `startRawAttempt`, `completeRawAttempt` from `./raw`; `assertConvertSupported`, `emitReject`, `handleAttemptError` from the embedding/image attempt modules; `captureAudioUsage` (Task 9); `type AudioProtocolAdapter`, `type AudioResult` (Task 4).
- Produces:
  - `type AudioAttemptLoopContext` — same shape as `EmbeddingAttemptLoopContext` but with an `AudioProtocolAdapter`
  - `attemptAudioCandidate(ctx: AudioAttemptLoopContext, slot: CandidateSlot, raw: Request): Promise<AttemptOutcome>`
  - `AttemptDispatch` gains a `{ readonly kind: 'audio'; readonly ctx: AudioAttemptLoopContext }` arm
  - transport tag `'audio'` added to both transport unions

- [ ] **Step 1: Write the failing dispatch test**

Create `packages/server/src/routes/pipeline/attempt/audio.test.ts`. Read `packages/server/src/routes/pipeline/attempt/embedding.test.ts` first and reuse its harness verbatim — the same fake candidate slots, the same `ctx` builder, the same observation spy. Then add these cases:

```ts
import { describe, expect, test } from 'bun:test';

import { attemptAudioCandidate } from './audio';
// plus the harness imports embedding.test.ts uses

describe('attemptAudioCandidate', () => {
  test('takes raw passthrough when the candidate protocol matches openai-audio', async () => {
    const { ctx, slot, calls } = audioHarness({
      candidate: { kind: 'api', protocol: 'openai-audio' },
      rawResponse: new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } }),
    });
    const outcome = await attemptAudioCandidate(ctx, slot, speechRaw());
    expect(outcome.kind).toBe('response');
    expect(calls.transport).toBe(0);
    expect(outcome.observation?.transport).toBe('raw');
  });

  test('converts through the speech transport when the protocol differs', async () => {
    const { ctx, slot, calls } = audioHarness({
      candidate: { kind: 'ai-sdk' },
      speechResult: { audio: new Uint8Array([7]), mediaType: 'audio/mpeg' },
    });
    const outcome = await attemptAudioCandidate(ctx, slot, speechRaw());
    expect(outcome.kind).toBe('response');
    expect(calls.transport).toBe(1);
    expect(outcome.observation?.transport).toBe('audio');
    expect(new Uint8Array(await outcome.response.arrayBuffer())).toEqual(new Uint8Array([7]));
  });

  test('rejects with 501 unsupported_feature when the adapter declines the convert path', async () => {
    const { ctx, slot } = audioHarness({
      candidate: { kind: 'ai-sdk' },
      convertSkipReason: 'translations',
    });
    const outcome = await attemptAudioCandidate(ctx, slot, translationsRaw());
    expect(outcome.kind).toBe('reject');
    expect(outcome.response.status).toBe(501);
    expect(outcome.observation?.skipReason).toBe('translations');
  });

  test('marks the transport unavailable so the next candidate is tried', async () => {
    const { ctx, slot } = audioHarness({ candidate: { kind: 'ai-sdk' }, transport: undefined });
    const outcome = await attemptAudioCandidate(ctx, slot, speechRaw());
    expect(outcome.kind).toBe('skip');
    expect(ctx.observation.markTransportUnavailable).toHaveBeenCalled();
  });

  test('records usage on the convert path so a per-request fee still bills', async () => {
    const { ctx, slot, calls } = audioHarness({
      candidate: { kind: 'ai-sdk' },
      speechResult: { audio: new Uint8Array([7]), mediaType: 'audio/mpeg' },
    });
    await attemptAudioCandidate(ctx, slot, speechRaw());
    expect(calls.usage).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and confirm the module is missing**

Run: `bun test packages/server/src/routes/pipeline/attempt/audio.test.ts`

Expected: FAIL — cannot resolve `./audio`.

- [ ] **Step 3: Add the audio transport tag**

`packages/server/src/routes/pipeline/attempt-base/attempt-base.ts`, line 22:

```ts
  readonly transport?: 'raw' | 'ai_sdk' | 'image' | 'audio' | undefined;
```

`packages/server/__tests__/pipeline-helpers/types.ts`, line 52:

```ts
  readonly transport?: 'raw' | 'ai_sdk' | 'image' | 'audio';
```

- [ ] **Step 4: Add the loop context**

`packages/server/src/routes/pipeline/context.ts`:

At lines 44-46, widen `PipelineAdapter` to include the audio adapter:

```ts
export type PipelineAdapter =
  | AnyProtocolAdapter
  | ImageProtocolAdapter<never, never>
  | EmbeddingProtocolAdapter<never, never>
  | AudioProtocolAdapter<never, never>;
```

Keep the exact generic arguments the neighbouring arms use — read the current declaration and match it rather than the sketch above.

After `EmbeddingAttemptLoopContext` (around line 96), add:

```ts
export type AudioAttemptLoopContext<TRequest = never, TContext = never> = Omit<
  EmbeddingAttemptLoopContext<TRequest, TContext>,
  'adapter'
> & {
  readonly adapter: AudioProtocolAdapter<TRequest, TContext>;
};
```

Read `EmbeddingAttemptLoopContext` first; if it is not generic, write `AudioAttemptLoopContext` with the same non-generic shape and an `AudioProtocolAdapter<never, never>` adapter.

- [ ] **Step 5: Write the audio attempt module**

Create `packages/server/src/routes/pipeline/attempt/audio.ts`. Read `embedding.ts` in full first — this module is its audio twin, and every helper it calls (`assertConvertSupported`, `emitReject`, `handleAttemptError`, `startRawAttempt`, `completeRawAttempt`) must be called with the same arguments in the same order.

```ts
import { captureAudioUsage } from '../../../usage-capture';
import type { AudioAttemptLoopContext } from '../context';
import type { AttemptOutcome, CandidateSlot } from './types';
import { completeRawAttempt, startRawAttempt } from './raw';

export async function attemptAudioCandidate(
  ctx: AudioAttemptLoopContext,
  slot: CandidateSlot,
  raw: Request,
): Promise<AttemptOutcome> {
  const { adapter, request, context, provider } = ctx;
  const capability = adapter.capability;
  const resolved = await provider.raw?.resolve({
    protocol: adapter.protocol,
    modelId: slot.candidate.modelId,
    capability,
  });
  // Same-protocol raw passthrough wins: the client's own multipart body, boundary,
  // repeated fields, and response_format reach upstream untouched, and a `srt` or
  // `vtt` body flows back as bytes.
  if (resolved !== undefined) {
    const upstreamRequest = await adapter.rawRequest(
      raw,
      request,
      slot.candidate.modelId,
      new Set(),
      context,
    );
    const started = await startRawAttempt(ctx, slot, resolved, upstreamRequest);
    return completeRawAttempt(ctx, slot, resolved, started.upstream, started.attemptSpan, {});
  }

  const skipReason = adapter.convertSkipReason?.(request, slot.candidate.modelId, context);
  if (skipReason !== undefined) {
    return emitReject(ctx, slot, adapter.errors.unsupported(skipReason), skipReason);
  }

  const transport = capability === 'speech' ? provider.speech : provider.transcription;
  if (transport === undefined) {
    ctx.observation.markTransportUnavailable();
    return { kind: 'skip' };
  }

  try {
    await transport.ensureAvailable?.(slot.candidate.modelId);
    const invocation = adapter.audioInvocation(request, context);
    const result =
      invocation.kind === 'speech'
        ? { kind: 'speech' as const, speech: await transport.invoke(invocation.speech, invokeOptions(ctx, slot)) }
        : {
            kind: 'transcription' as const,
            transcription: await transport.invoke(invocation.transcription, invokeOptions(ctx, slot)),
          };
    // No audio result carries usage, so this row exists only to let a configured
    // per-request fee bill. Token counts are never estimated from duration.
    await captureAudioUsage({
      providerId: slot.candidate.providerId,
      modelId: slot.candidate.modelId,
      logicalRequest: ctx.logicalRequest,
      ...(slot.configPrice === undefined ? {} : { configPrice: slot.configPrice }),
    });
    const response = await adapter.audioResponse(result, request, { modelId: slot.candidate.modelId });
    return { kind: 'response', response, observation: { transport: 'audio' } };
  } catch (error) {
    return handleAttemptError(ctx, slot, error);
  }
}

function invokeOptions(ctx: AudioAttemptLoopContext, slot: CandidateSlot) {
  return {
    modelId: slot.candidate.modelId,
    logicalRequest: ctx.logicalRequest,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  };
}
```

The `transport.invoke` union above will not type-check as written because `speech` and `transcription` take different invocation types. Split it into two narrow branches instead:

```ts
    if (invocation.kind === 'speech') {
      const speech = provider.speech;
      if (speech === undefined) {
        ctx.observation.markTransportUnavailable();
        return { kind: 'skip' };
      }
      await speech.ensureAvailable?.(slot.candidate.modelId);
      const data = await speech.invoke(invocation.speech, invokeOptions(ctx, slot));
      await recordAudioUsage(ctx, slot);
      return respond(ctx, { kind: 'speech', speech: data }, slot);
    }
    const transcription = provider.transcription;
    if (transcription === undefined) {
      ctx.observation.markTransportUnavailable();
      return { kind: 'skip' };
    }
    await transcription.ensureAvailable?.(slot.candidate.modelId);
    const data = await transcription.invoke(invocation.transcription, invokeOptions(ctx, slot));
    await recordAudioUsage(ctx, slot);
    return respond(ctx, { kind: 'transcription', transcription: data }, slot);
```

with the two helpers:

```ts
async function recordAudioUsage(ctx: AudioAttemptLoopContext, slot: CandidateSlot): Promise<void> {
  await captureAudioUsage({
    providerId: slot.candidate.providerId,
    modelId: slot.candidate.modelId,
    logicalRequest: ctx.logicalRequest,
    ...(slot.configPrice === undefined ? {} : { configPrice: slot.configPrice }),
  });
}

async function respond(
  ctx: AudioAttemptLoopContext,
  result: AudioResult,
  slot: CandidateSlot,
): Promise<AttemptOutcome> {
  const response = await ctx.adapter.audioResponse(result, ctx.request, { modelId: slot.candidate.modelId });
  return { kind: 'response', response, observation: { transport: 'audio' } };
}
```

Delete the earlier combined `transport`/`result` block and the now-unused `capability === 'speech' ? provider.speech : provider.transcription` line. Import `emitReject` and `handleAttemptError` from wherever `embedding.ts` imports them, and `type AudioResult` from `@aio-proxy/core`. If `slot.configPrice` does not exist under that name, read `embedding.ts`'s usage-capture call and use the same accessor.

- [ ] **Step 6: Add the fourth dispatch arm**

`packages/server/src/routes/pipeline/attempt/attempt.ts`:

Line 32 — add the audio adapter to the union that types the incoming adapter.

Lines 95-125 — add the arm to `AttemptDispatch`:

```ts
  | { readonly kind: 'audio'; readonly ctx: AudioAttemptLoopContext };
```

and to `attemptDispatch`'s narrowing switch, following the comment already there about why `isEmbeddingProtocolAdapter` cannot narrow generics — use the same cast-through-`kind` shape:

```ts
  if (adapter.capability === 'speech' || adapter.capability === 'transcription') {
    return { kind: 'audio', ctx: ctx as unknown as AudioAttemptLoopContext };
  }
```

Lines 210-225 — extend the dispatch ternary into the fourth branch:

```ts
      : dispatch.kind === 'audio'
        ? attemptAudioCandidate(dispatch.ctx, slot, raw)
        : ...
```

Keep the existing branch order and formatting; oxfmt will normalize it.

- [ ] **Step 7: Widen the remaining adapter unions**

`packages/server/src/routes/pipeline/index.ts` — find every `AnyProtocolAdapter | ImageProtocolAdapter` site:

```bash
rg -n 'ImageProtocolAdapter' packages/server/src/routes/pipeline
```

Add `| AudioProtocolAdapter<never, never>` to each (four sites), and at line 262 extend the unsupported-feature reason:

```ts
        response: adapter.errors.unsupported(
          adapter.capability === 'image'
            ? 'images'
            : adapter.capability === 'speech' || adapter.capability === 'transcription'
              ? 'audio'
              : 'transform_dispatch',
        ),
```

`'audio'` is the sentinel `openAIAudioUnsupported` maps to the "no configured provider can serve OpenAI Audio" 501.

`packages/server/src/routes/pipeline/test-support.ts` — widen its `InboundProtocolAdapter` alias the same way.

- [ ] **Step 8: Run the pipeline suites**

Run: `bun test packages/server/src/routes/pipeline`

Expected: PASS — 5 new audio tests plus the existing pipeline suite.

Run: `bun run check`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/routes/pipeline packages/server/__tests__/pipeline-helpers
git commit -m "feat(server): dispatch OpenAI audio candidates in the pipeline"
```

---

## Task 11: Serve the three audio ports

**Files:**
- Create: `packages/server/src/routes/openai-audio.ts`
- Create: `packages/server/__tests__/audio-routing.test.ts`
- Modify: `packages/server/src/server/server.ts`

**Interfaces:**
- Consumes: `handleProtocolRequest` from `./pipeline`; `openAISpeechAdapter`, `openAITranscriptionAdapter`, `type OpenAIAudioContext` from `@aio-proxy/core`.
- Produces:
  - `registerOpenAIAudioRoutes(app: Hono<ServerEnv>, deps: RouteDeps): void` — or whatever the exact signature of `registerOpenAIImagesRoutes` is; match it.

- [ ] **Step 1: Write the failing dispatch-matrix test**

Create `packages/server/__tests__/audio-routing.test.ts`. Read `packages/server/__tests__/embeddings-routing.test.ts` (or whichever routing test exists for embeddings — find it with `rg -l 'embeddings' packages/server/__tests__`) and reuse its app-building harness verbatim. Then cover the matrix:

```ts
import { describe, expect, test } from 'bun:test';

// plus the harness imports the embeddings routing test uses

function speechBody(): BodyInit {
  return JSON.stringify({ model: 'tts-1', input: 'hello', voice: 'alloy' });
}

function transcriptionBody(model = 'whisper-1'): FormData {
  const form = new FormData();
  form.append('file', new File([new Uint8Array([1, 2, 3])], 'clip.mp3', { type: 'audio/mpeg' }));
  form.append('model', model);
  return form;
}

describe('OpenAI audio routing', () => {
  test('POST /v1/audio/speech raw-passthroughs to an openai-audio API provider', async () => {
    const app = audioApp({ providers: [{ id: 'openai', kind: 'api', protocol: 'openai-audio' }] });
    const response = await app.request('/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: speechBody(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
  });

  test('POST /v1/audio/speech converts through an ai-sdk provider', async () => {
    const app = audioApp({ providers: [{ id: 'sdk', kind: 'ai-sdk', speech: true }] });
    const response = await app.request('/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: speechBody(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
  });

  test('POST /v1/audio/transcriptions reads multipart and answers with json', async () => {
    const app = audioApp({ providers: [{ id: 'sdk', kind: 'ai-sdk', transcription: true }] });
    const response = await app.request('/v1/audio/transcriptions', {
      method: 'POST',
      body: transcriptionBody(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'hello' });
  });

  test('POST /v1/audio/translations raw-passthroughs but never converts', async () => {
    const raw = audioApp({ providers: [{ id: 'openai', kind: 'api', protocol: 'openai-audio' }] });
    expect((await raw.request('/v1/audio/translations', { method: 'POST', body: transcriptionBody() })).status).toBe(
      200,
    );

    const convert = audioApp({ providers: [{ id: 'sdk', kind: 'ai-sdk', transcription: true }] });
    const response = await convert.request('/v1/audio/translations', {
      method: 'POST',
      body: transcriptionBody(),
    });
    expect(response.status).toBe(501);
    expect((await response.json()).error.code).toBe('unsupported_feature');
  });

  test('falls back to the next candidate when the first provider fails', async () => {
    const app = audioApp({
      providers: [
        { id: 'broken', kind: 'api', protocol: 'openai-audio', status: 500 },
        { id: 'openai', kind: 'api', protocol: 'openai-audio' },
      ],
    });
    const response = await app.request('/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: speechBody(),
    });
    expect(response.status).toBe(200);
  });

  test('answers 501 when no configured provider can serve audio', async () => {
    const app = audioApp({ providers: [{ id: 'sdk', kind: 'ai-sdk' }] });
    const response = await app.request('/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: speechBody(),
    });
    expect(response.status).toBe(501);
    expect((await response.json()).error.code).toBe('not_implemented');
  });

  test('answers 400 for a transcription request with no file part', async () => {
    const app = audioApp({ providers: [{ id: 'sdk', kind: 'ai-sdk', transcription: true }] });
    const form = new FormData();
    form.append('model', 'whisper-1');
    const response = await app.request('/v1/audio/transcriptions', { method: 'POST', body: form });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_request');
  });

  test('defaults the model when the client omits it', async () => {
    const app = audioApp({ providers: [{ id: 'sdk', kind: 'ai-sdk', speech: true, models: ['tts-1'] }] });
    const response = await app.request('/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello', voice: 'alloy' }),
    });
    expect(response.status).toBe(200);
  });
});
```

Build `audioApp` on top of the harness the embeddings routing test already provides — do not write a second server-building helper if one exists.

- [ ] **Step 2: Run it and confirm the routes 404**

Run: `bun test packages/server/__tests__/audio-routing.test.ts`

Expected: FAIL — every request returns 404 because no audio routes are registered.

- [ ] **Step 3: Write the thin route module**

Create `packages/server/src/routes/openai-audio.ts`, mirroring `packages/server/src/routes/openai-images.ts` exactly — three `handleProtocolRequest` calls and nothing else. No provider-kind branching, no fallback, no usage capture:

```ts
import { openAISpeechAdapter, openAITranscriptionAdapter } from '@aio-proxy/core';
import type { Hono } from 'hono';

import { handleProtocolRequest } from './pipeline';
import type { RouteDeps, ServerEnv } from './types';

export function registerOpenAIAudioRoutes(app: Hono<ServerEnv>, deps: RouteDeps): void {
  app.post('/v1/audio/speech', (c) =>
    handleProtocolRequest(c, deps, openAISpeechAdapter, { operation: 'speech' }),
  );
  app.post('/v1/audio/transcriptions', (c) =>
    handleProtocolRequest(c, deps, openAITranscriptionAdapter, { operation: 'transcriptions' }),
  );
  app.post('/v1/audio/translations', (c) =>
    handleProtocolRequest(c, deps, openAITranscriptionAdapter, { operation: 'translations' }),
  );
}
```

Match `openai-images.ts`'s exact import names, parameter list, and `handleProtocolRequest` argument order — read it and copy the call shape rather than the sketch above.

- [ ] **Step 4: Register the routes**

`packages/server/src/server/server.ts` — add the import and the registration call next to the images registration, keeping the existing order of registrations.

- [ ] **Step 5: Run the matrix and verify it passes**

Run: `bun test packages/server/__tests__/audio-routing.test.ts`

Expected: PASS — 8 tests.

Run: `bun test packages/server`

Expected: PASS.

Run: `bun run check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes packages/server/src/server packages/server/__tests__/audio-routing.test.ts
git commit -m "feat(server): serve the three OpenAI audio ports"
```

---

## Task 12: Document and release

**Files:**
- Modify: `npm/aio-proxy/README.md` (the inbound protocol table)
- Modify: `README.zh-Hans.md` (the same table)
- Create: `.changeset/openai-audio-inbound-protocol.md`

Root `README.md` is a symlink to `npm/aio-proxy/README.md` — do not edit it separately.

- [ ] **Step 1: Add the inbound protocol table row**

`npm/aio-proxy/README.md` — read the inbound protocol table and add the audio row in the same column order the existing rows use, listing all three paths:

```markdown
| OpenAI Audio | `POST /v1/audio/speech`, `POST /v1/audio/transcriptions`, `POST /v1/audio/translations` | `openai-audio` |
```

Match the existing rows' exact columns and wording. If the table has a "notes" or "capability" column, note there that `/v1/audio/translations` is same-protocol raw passthrough only.

- [ ] **Step 2: Mirror the row in the Chinese README**

`README.zh-Hans.md` — add the same row to its inbound table, translating only the note text and keeping the paths and the protocol id identical.

- [ ] **Step 3: Verify no other doc lists inbound protocols**

```bash
rg -n 'openai-image' --glob '*.md' .
```

Add the audio entry to every doc that hit — a doc that lists `openai-image` as an inbound protocol is now incomplete without `openai-audio`.

- [ ] **Step 4: Write the changeset**

Create `.changeset/openai-audio-inbound-protocol.md`:

```markdown
---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/plugin-sdk': minor
---

Add the OpenAI Audio inbound protocol. `POST /v1/audio/speech`, `POST /v1/audio/transcriptions`, and `POST /v1/audio/translations` now route through aio-proxy with the same candidate ordering, failover, and usage recording as every other inbound protocol. Providers whose protocol is `openai-audio` serve these ports by raw passthrough, preserving the client's multipart body and `response_format`; other providers are reached by converting the request into a speech or transcription model call. `/v1/audio/translations` is raw passthrough only, because the AI SDK's transcription interface has no translation mode. Audio usage is recorded only when upstream reports it — token counts are never estimated from audio duration.
```

Every listed package is verified to change: `@aio-proxy/types` gets the enum member, `@aio-proxy/dashboard` gets the protocol label, `@aio-proxy/plugin-sdk` gets `ProtocolId` plus the capability union. Drop any package that turned out not to change, but keep `aio-proxy` unconditionally — it is the package whose GitHub Release carries these notes.

- [ ] **Step 5: Check for stale unreleased notes**

```bash
rg -n 'audio' .changeset
```

If an earlier unreleased note claims audio is unsupported or lists the inbound protocols without audio, correct it in this commit.

- [ ] **Step 6: Run the full preflight**

Run: `bun run preflight`

Expected: PASS — oxlint, oxfmt check, and every unit test.

- [ ] **Step 7: Commit**

```bash
git add npm/aio-proxy/README.md README.zh-Hans.md .changeset
git commit -m "docs: document the OpenAI Audio inbound protocol"
```

---

## Self-Review

**Spec coverage against [issue #209](https://github.com/aio-proxy/aio-proxy/issues/209):**

| Requirement | Tasks |
| --- | --- |
| `POST /v1/audio/speech` | 3, 5, 10, 11 |
| `POST /v1/audio/transcriptions` | 3, 5, 10, 11 |
| `POST /v1/audio/translations` | 5 (`audioConvertSkipReason`), 10, 11 |
| New inbound protocol | 1 (`ProviderProtocol.OpenAIAudio`), 4 (capability seam), 5 (adapters) |
| Multipart / binary reading that does not go through `readJsonRequest` | 2 (generalized reader), 3 (`parseOpenAITranscriptionMultipart`) |
| Same-protocol raw | 5 (`rawRequest` replay + rebuild), 10 (raw arm first) |
| Convert | 4 (`audioInvocation`/`audioResponse`), 6 (AI SDK invokers), 7–8 (transports + filtering), 10 (convert arm) |
| Fallback | 10 (`markTransportUnavailable` → skip; raw failure path via `completeRawAttempt`), 11 (fallback test) |
| Usage | 9 (`captureAudioUsage`, `openAIAudioUsage`), 10 (convert-path capture) |
| Adapter tests | 4, 5 |
| Dispatch matrix | 11 (`__tests__/audio-routing.test.ts`, 8 cases) |
| README inbound table | 12 |
| Not sharing the Images adapter | 2 keeps the Images ingress intact while extracting only the reader; 4/5 give audio its own adapter and egress contract |
| Out of scope: Realtime WS, voice consents, music APIs | Global Constraints; no task touches them |

**Placeholder scan:** every code step carries complete code. Four steps deliberately say "read X first and match it" — Task 4 Step 5 (error class style), Task 6 Step 4 (`ProviderV4` import path), Task 10 Step 4 (`EmbeddingAttemptLoopContext` genericity), Task 11 Step 3 (`handleProtocolRequest` argument order). Those are instructions to copy an existing shape that the plan cannot restate without risking drift from the current source, not deferred decisions; each names the exact file to read and the exact property to match.

**Type consistency:** the names introduced in Tasks 1–5 are used unchanged downstream — `ProviderProtocol.OpenAIAudio`, capabilities `'speech'`/`'transcription'`, `MultipartStreamSpec`/`ParsedMultipart {fields, uploads, namedUploads}`, `parseOpenAISpeech`/`parseOpenAITranscriptionMultipart`, `defineAudioProtocolAdapter`/`isAudioProtocolAdapter`/`AnyInboundProtocolAdapter`, `audioInvocation`/`audioResponse`/`convertSkipReason(request, resolvedModelId, context)`, `SpeechInvocation`/`TranscriptionInvocation`/`SpeechResultData`/`TranscriptionResultData`, `renderTranscription`, `openAIAudioErrors`, `createProviderV4SpeechInvoke`/`createProviderV4TranscribeInvoke`, `SpeechTransport`/`TranscriptionTransport`, `supportsSpeech`/`supportsTranscription`/`candidateSupportsAudio`, `AUDIO_BRIDGE_PACKAGES`/`attachAudioTransports`, `captureAudioUsage`/`openAIAudioUsage`, `AudioAttemptLoopContext`/`attemptAudioCandidate`, transport tag `'audio'`. Two corrections were folded in while writing: `convertSkipReason` gained its third `context` parameter in Task 5 (declared in Task 4's contract, consumed in Task 10), and Task 10's combined-transport sketch was replaced by the two narrow branches so the invocation types check.
