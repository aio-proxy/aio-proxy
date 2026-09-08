# P5: Realtime and Videos protocol surfaces

Date: 2026-09-08
Status: approved for implementation (issue #210; prior evaluation already recorded the Codex slice)
Issue: [#210](https://github.com/aio-proxy/aio-proxy/issues/210)
Parent: [#204](https://github.com/aio-proxy/aio-proxy/issues/204)

## Goal

Close #210 with an explicit ship / no-ship list, and give every shipped port a real adapter rather than a catch-all.

Realtime already has that adapter: Codex Live / Realtime signaling from [#298](https://github.com/aio-proxy/aio-proxy/pull/298). This spec does not rebuild it. It records the decision and requires the README inbound table to name the shipped ports.

Videos does not exist yet. This spec adds the official OpenAI Videos **job** surface as a first-class inbound protocol: same-protocol raw passthrough, a pin store so poll / content / delete / remix hit the creating provider, and protocol-shaped errors. It does not invent a `videoModel` convert path.

## Live baseline

- Inbound generation protocols: language family, `openai-image`, embeddings, Gemini Interactions, `openai-audio`.
- `InboundCapability` is `'language' | 'image' | 'embedding' | 'speech' | 'transcription'`.
- `handleProtocolRequest` / `attemptCandidates` is the only generation candidate loop. `attemptDispatch` currently falls through to audio; a new capability **must** add its own arm or every video candidate is mis-dispatched as audio.
- Realtime is a documented exception: `packages/server/src/routes/realtime/` owns signaling, sideband, hangup, and its own selection loop. Only `openai-chatgpt` materializes `realtime`. Official `sessions` / `client_secrets` / translations / SIP answer `501`.
- README API tables list Images and Audio. They do not list `/v1/realtime`, `/v1/live`, or any Videos path.
- Provider V4 as locked by this repo does **not** include `videoModel`. Plugin `ModelCatalog` has no `video` bucket.
- `ModalitySchema` already allows `video`.
- Official OpenAI Videos is a job API: create returns `{ id, object: "video", status, ... }`; clients poll retrieve, then fetch content. Official delete replaces cancel. Official remix / edits / extensions create a follow-up job from a source video id.
- Official Sora / Videos API is deprecated and scheduled to shut down on **2026-09-24**. Compatible gateways that keep the `/v1/videos` wire remain the reason to ship the adapter.

## Ship / no-ship

This table is the issue's written decision.

### Realtime

| Port | Decision | Notes |
| --- | --- | --- |
| `POST /v1/live` | **Ship** | Already in #298. Codex SDP create. |
| `POST /v1/realtime` | **Ship** | Already in #298. Same create, `Location` rewritten to `/v1/realtime/calls/<id>`. |
| `POST /v1/realtime/calls` | **Ship** | Already in #298. |
| `GET /v1/live/:call_id` | **Ship** | Sideband WebSocket. |
| `GET /v1/realtime/calls/:call_id` | **Ship** | Sideband WebSocket. |
| `GET /v1/realtime` | **Ship** | Sideband when `call_id` is present; otherwise direct WS. This is the port #210 named. |
| `POST /v1/realtime/calls/:call_id/hangup` | **Ship** | Pinned-account hangup. |
| `POST /v1/realtime/sessions` | **No-ship** | Already `501`. ChatGPT upstream has no equivalent. |
| `POST /v1/realtime/client_secrets` | **No-ship** | Already `501`. |
| `POST /v1/realtime/transcription_sessions` | **No-ship** | Already `501`. |
| `GET\|POST /v1/realtime/translations` and `.../client_secrets` | **No-ship** | Already `501`. |
| `POST /v1/realtime/calls/:call_id/{accept,reject,refer}` | **No-ship** | Already `501`. SIP dialog. |
| WebRTC media relay | **No-ship** | Media stays client-to-upstream. |
| Official API-key OpenAI Realtime as `defineProtocolAdapter` | **No-ship** | SDP + long-lived WS has no conversion hooks. #298's route module is the adapter. |
| Usage / pricing for realtime | **No-ship** | Unchanged. |
| Folding realtime into the generation router | **No-ship** | Follow-up recorded in the Codex spec, not this issue. |

### Videos

| Port | Decision | Notes |
| --- | --- | --- |
| `POST /v1/videos` | **Ship** | Official create. Model-first. Raw only. |
| `GET /v1/videos/:video_id` | **Ship** | Official retrieve / status poll. Pinned raw. |
| `GET /v1/videos/:video_id/content` | **Ship** | Official bytes (`variant` query forwarded). Pinned raw. |
| `DELETE /v1/videos/:video_id` | **Ship** | Official delete (the API has no cancel). Pinned raw. |
| `POST /v1/videos/:video_id/remix` | **Ship** | Official follow-up create. Prefer source pin. |
| `POST /v1/videos/edits` | **Ship** | Official OpenAI path (not xAI). Prefer source pin from `video.id`. |
| `POST /v1/videos/extensions` | **Ship** | Official OpenAI path (not xAI). Prefer source pin from `video.id`. |
| `GET /v1/videos` | **No-ship** | Project listing. Register `501`, not 404. |
| `POST /v1/videos/characters` | **No-ship** | Cameo product. Register `501`. |
| `GET /v1/videos/characters/:character_id` | **No-ship** | Cameo product. Register `501`. |
| `POST /v1/videos/generations` | **No-ship** | xAI vendor path. **Do not register** (404). |
| Kling / Midjourney video / Suno | **No-ship** | Already out of #210. |

` /v1/videos/edits` and `/v1/videos/extensions` are official OpenAI job creates as of the current Videos reference. They are **not** the xAI trio `#210` asked about. The xAI-only member is `/v1/videos/generations`, which stays vendor-specific.

## Approaches considered

### A. `openai-video` protocol + raw-only video capability + job pin store (recommended)

Add `ProviderProtocol.OpenAIVideo = 'openai-video'` and `InboundCapability` `'video'`. Create / edits / extensions that need model-first routing go through `handleProtocolRequest`. Retrieve / content / delete (and remix / edits / extensions when a source pin exists) are pinned raw, not a second generation loop. Convert is always `501 unsupported_feature`.

- Pros: matches #204 (real adapter, no catch-all); retrieve cannot invent a model; convert cannot pretend Provider V4 has `videoModel`; xAI `/generations` stays unregistered.
- Cons: in-process pin store is lost on restart (same class of limitation as realtime calls).

### B. Reuse `openai-compatible` and special-case `/v1/videos*`

Rejected: catch-all, wrong raw origin, job poll mixed into the chat adapter.

### C. Full `videoModel` convert through the AI SDK

Rejected: `videoModel` is not in the locked Provider V4 contract. There is no egress to invent.

### D. Decision-only close (document Codex, no-ship all Videos)

Rejected: #210's deliverable is a real adapter for any shipped video port, and official `/v1/videos` is still the wire compatible gateways speak after Sora's shutdown.

Recommendation: **A**.

## Architecture

```text
Create / model-first edits+extensions
  POST /v1/videos
  POST /v1/videos/edits      (no pin)
  POST /v1/videos/extensions (no pin)
        |
        v
  handleProtocolRequest (capability: video)
        |
        +-- same-protocol raw  -->  pin video id to (provider, account, owner)
        +-- else 501 convert

Pinned follow-up (not a generation loop)
  GET    /v1/videos/:id
  GET    /v1/videos/:id/content
  DELETE /v1/videos/:id
  POST   /v1/videos/:id/remix
  POST   /v1/videos/edits      (pin hit)
  POST   /v1/videos/extensions (pin hit)
        |
        v
  owner check --> raw.resolve({ protocol: openai-video }) on the pinned provider
        |
        +-- remix/edits/extensions 2xx --> pin the new video id
```

### Units

1. **Video adapter** (`packages/core/src/protocol/video-adapter/`, `openai-video/`) — `defineVideoProtocolAdapter` with `capability: 'video'`. Shared parse / model / raw rewrite / OpenAI-shaped errors. **No** `videoInvocation` and no convert egress. `convertSkipReason` is always `'video_convert'` so the pipeline's existing unsupported path can name the feature.
2. **Thin generation routes** — `POST /v1/videos`, and the no-pin branch of edits / extensions, call `handleProtocolRequest` only.
3. **Pinned follow-up module** — `packages/server/src/routes/videos/` owns the job store, owner check, and pinned raw. It must not grow provider-kind branching, usage estimation, or a candidate loop.
4. **Success hook** — `handleProtocolRequest` gains an optional `onSuccessfulAttempt({ provider, modelId, response })`. Videos create uses it to insert a pin. The hook clones the body; it must not consume the returned `Response`. The attempt loop stays one loop.
5. **Capability index** — `PROTOCOL_CAPABILITIES[OpenAIVideo] = ['video']`. An absent protocol still grants nothing.

Realtime code is not redesigned. README + this ship table are the remaining Realtime deliverable.

## Protocol and authoring

```ts
enum ProviderProtocol {
  // existing...
  OpenAIVideo = 'openai-video',
}
```

Update plugin-sdk `ProtocolId` in lockstep. Do **not** add `catalog.video` to `ModelCatalog` in this issue: no plugin ships a video bucket, and adding an empty required field churns every catalog.

A provider becomes Videos-raw the same way Images-raw works: inbound protocol must match a declared endpoint, and a **finite** id set must include the omitted-model default `sora-2`.

```jsonc
{
  "id": "openai",
  "kind": "api",
  "protocol": "openai-response",
  "baseURL": "https://api.openai.com/v1",
  "models": ["sora-2", "sora-2-pro"],
  "metadata": {
    "sora-2": { "capabilities": { "modalities": { "output": ["video"] } } },
    "sora-2-pro": { "capabilities": { "modalities": { "output": ["video"] } } }
  },
  "endpoints": { "baseURL": "https://api.openai.com/v1", "protocol": ["openai-video"] }
}
```

An extra `openai-video` endpoint grants `'video'` to the finite non-catalog id set (`models`, preserved alias targets, metadata keys), matching how `openai-audio` grants speech/transcription: the endpoint does not say which listed id runs video, and withholding the grant would leave a video-only provider unroutable. `metadata.capabilities.modalities.output` including `video` also grants `'video'` for that id.

Primary `openai-video` synthesizes **no** language transport (`PROTOCOL_CAPABILITIES` lists only `video`). `bridgeApiProviderToAiSdk` must not invent a language package mapping; `assertNever` sites must gain an `openai-video` arm.

`auth` remains Anthropic-only.

Non-catalog providers still need a finite id set. There is no wildcard. Omitted `model` looks up `sora-2` (official default). If `sora-2` is not routable, the existing `404 model_not_found` applies.

## Request contract

### Create (`POST /v1/videos`)

Accepted content types: `application/json` and `multipart/form-data`. Anything else is `415`.

`model` default (lookup id, official): field omitted, JSON `null`, `""`, or whitespace-only → `sora-2`. Multipart missing / empty / whitespace-only → `sora-2`. Literal form `null` is the id `"null"` and is not defaulted (same split as Images).

`prompt` is required on JSON and multipart. Missing / blank prompt is `400 invalid_request`.

Other official fields (`seconds`, `size`, `input_reference`, plus unknown future keys) are forwarded on the raw path. Raw rewrite injects the **candidate resolved** model id when the client omitted/blanked `model` or routing changed it. A no-op explicit model keeps bytes. Strip hop headers on rewrite. Multipart replay copies every client field and replaces only `model` when a rewrite is required.

Body limits: default `REQUEST_BODY_LIMITS` (64 MiB). Create carries at most one optional image reference, not a 16-file edits envelope.

`wantsStream` is always `false`.

### Edits / extensions (model-first when unpinned)

JSON body only (`415` on multipart, including the official SDK form). `prompt` required. Source video id is `video.id` (official) and must match `[A-Za-z0-9_-]{1,128}`; anything else is `400` and does not enter the pipeline. Optional `model` uses the same default as create. Optional `seconds` on extensions is forwarded, not validated against the official enum (upstream rejects an illegal value). The pin peek uses the same `REQUEST_BODY_LIMITS` reader as create; an oversized body is `413` before store lookup. A pinned follow-up still runs the operation parse (prompt / content type / id) before the pinned raw invoke.

If a pin exists for that source id and the caller owns it, do **not** enter the generation loop: pinned raw to that provider, then pin the new job on 2xx.

If no pin: `handleProtocolRequest` with lookup model `sora-2` (or the explicit model), then pin the new job on 2xx. A source video that does not exist on the chosen upstream is an upstream 404; failover may try the next video-capable candidate.

### Remix

`POST /v1/videos/:video_id/remix` with JSON `{ prompt }`. No model on the official wire. Always pin-first: missing pin is `404` with a video-shaped not-found (do not invent a model-first remix). Parse the JSON body with the same body limit and required prompt as edits before the pinned invoke. 2xx pins the new job.

### Retrieve / content / delete

No model. Pin-first. Missing / expired pin is `404`. Stolen `video_id` (caller principal does not match) is `403` and must not touch upstream. Content forwards the inbound query string (`variant=video|thumbnail|spritesheet`). Delete on 2xx removes the pin.

Video ids accepted by the pin store: `[A-Za-z0-9_-]{1,128}`, same bound as realtime call ids. Anything else is `400 invalid_request` before a store lookup.

## Job store

`packages/server/src/routes/videos/job-store.ts`, mounted on `ServerState` like `realtimeCalls`.

```ts
type VideoJobRecord = {
  readonly videoId: string;
  readonly providerId: string;
  readonly accountId?: string;
  readonly runtimeRevision?: number;
  readonly model: string;
  readonly owner: { readonly kind: string; readonly id?: string };
  readonly createdAt: number;
  readonly expiresAt: number;
};
```

- Capacity `1024`. `reserveCapacity` before a create attempt, matching realtime: a predicate cannot hold the bound across the upstream yield.
- Default TTL `24h` from insert. If the create JSON carries a numeric `expires_at` (unix seconds), use `min(expires_at * 1000, createdAt + 24h)` so a shorter official expiry wins and a missing/invalid one does not live forever.
- `insert` never replaces. A colliding id is a failed pin; the create response is still returned (upstream already accepted the job) and a later retrieve without a pin is `404`. Log `video.job_pin_failed` at error. Do not put the video id, body, or credentials in the log.
- Restart drops the store. Follow-up routes then `404`. Document this next to the realtime restart limitation.
- `close()` on server shutdown.
- Owner check uses the same caller-principal equality as realtime (`kind` + `id`).

Pinned raw resolves the live provider by `providerId` (and `withAccountPin` when `accountId` is present). If the provider is gone, disabled, or has no `openai-video` raw transport: `503` with `code: "video_upstream_unavailable"`. Do not walk other candidates.

## Pipeline changes

`InboundCapability` gains `'video'` in both `packages/core/src/protocol/adapter.ts` and `packages/server/src/runtime.ts`.

`filterCandidatesByCapability` keeps `supportsVideo` for inbound `'video'`. `supportsVideo` is index membership, never `videoModel` method presence.

`attemptDispatch` gains a `video` arm **before** the audio fallthrough. Video dispatch is: same-protocol raw, else `unsupportedDispatch` (501). It must not call `attemptAudioCandidate`, `attemptModelCandidate`, or any image/embedding transport.

`handleProtocolRequest` / `attemptCandidates` accept optional

```ts
onSuccessfulAttempt?: (info: {
  readonly provider: RuntimeProviderInstance;
  readonly modelId: string;
  readonly response: Response;
}) => void | Promise<void>;
```

Called once on the winning `return` step, after the response is known and before it is handed to the client. Videos is the only caller in this issue. The hook must be exception-safe: a throw becomes `video.job_pin_failed` and must not replace a 2xx with a 500.

`noCandidateFeature('video')` is a capability-miss 501: no configured provider can generate videos for this model.

## Errors

OpenAI-shaped `{ error: { message, type, code } }` like Images / Audio (not the realtime `{ param: null }` envelope).

| Situation | Status | `code` |
| --- | --- | --- |
| Bad JSON / missing prompt / illegal video id | 400 | `invalid_request` |
| Stolen pin | 403 | `video_forbidden` |
| Unknown model | 404 | `model_not_found` |
| Unknown / expired / unpinned video id | 404 | `video_not_found` |
| Body too large | 413 | `request_too_large` |
| Wrong content type | 415 | `unsupported_content_encoding` or `invalid_request` matching existing Images split |
| No video-capable candidate | 501 | `not_implemented` |
| Convert path (no raw) | 501 | `unsupported_feature` (`video_convert`) |
| Registered no-ship Videos ports | 501 | `video_capability_not_supported` |
| Pinned provider missing / raw gone | 503 | `video_upstream_unavailable` |
| In-process job store at capacity | 503 | `video_store_full` |

Do not log SDP-equivalent secrets: no video bytes, no `input_reference` data URLs, no `Authorization`.

## Probe, usage, dashboard

- Probe an `openai-video` primary with `GET /v1/models`, same reason as Audio: a create request bills a real job and is the wrong health check. Green means reachable + accepted key, not that `sora-2` still exists upstream.
- Usage: record only when a JSON create/remix/edits/extensions body reports it. Never estimate from `seconds` or file size. Content bytes carry no usage. Add `OpenAIVideo` to the passthrough-usage switches next to Image/Audio (empty observation is fine).
- Dashboard `PROTOCOL_LABELS` must include `openai-video` (exhaustive render). `PROTOCOL_ORDER` does **not** offer it, matching Image/Audio.

## README

Both `README.md` and `README.zh-Hans.md` (and the npm copy if it is still hand-maintained in this checkout) gain:

Realtime rows: `POST /v1/live`, `POST /v1/realtime`, `POST /v1/realtime/calls`, the three GET sideband/direct paths, `POST /v1/realtime/calls/:call_id/hangup`. Note: Codex ChatGPT OAuth only; media is not relayed; listed extras are 501.

Videos rows: the seven shipped ports. Notes:

- Raw Videos needs an `openai-video` endpoint (or primary protocol) and a finite id set including `sora-2`.
- Omitted `model` defaults to `sora-2`.
- Convert is not implemented.
- Retrieve / content / delete / remix require the creating process's pin; restart forgets pins.
- `GET /v1/videos` and character ports are 501.
- `/v1/videos/generations` is not a proxy port.
- Official Sora / Videos API shutdown on 2026-09-24; the wire remains for compatible gateways.

## Testing

Behavior, not literal restatement:

- Adapter: omitted model looks up `sora-2` and raw injects the resolved id; explicit model that routing does not change keeps bytes; missing prompt is 400; convert-less provider is 501 `video_convert`.
- Job store: insert / lookup / owner mismatch / expiry / capacity / no replace.
- Create 2xx pins; retrieve hits the pinned provider only; stolen id is 403 without upstream fetch; missing pin is 404; remix 2xx pins the new id.
- Edits with a pin skip the generation loop; edits without a pin use the pipeline.
- `GET /v1/videos` and character ports are 501; `/v1/videos/generations` is 404.
- Capability filter: language-only catalog cannot serve Videos; `openai-video` finite ids can; dummy V4 methods never grant video.
- `attemptDispatch` video arm is not audio (a raw-less video provider must 501 `video_convert`, not invoke speech).
- Dispatch-matrix / exhaustiveness: every `ProviderProtocol` switch compiles with `openai-video`.
- README table includes the shipped Realtime and Videos ports.

## Out of scope

- `catalog.video` on `ModelCatalog`
- AI SDK `videoModel` / `generateVideo`
- Persisted job store (disk / sqlite)
- Proxying or storing video bytes
- xAI `/v1/videos/generations`
- Official Realtime sessions / client secrets / media relay
- Changing Codex realtime behavior
- Vendor job APIs named in #210's out-of-scope list
