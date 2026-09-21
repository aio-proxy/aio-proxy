# TypeSafe System One Evaluation Inbound Protocol

Date: 2026-09-19
Status: awaiting user review

## Goal

A TypeSafe System One client can evaluate through aio-proxy.

Evaluation is not chat. One shared `state` plus a map of typed questions goes in; a map of typed
answers comes out. This spec adds that surface as a standalone inbound protocol with its own
`ProviderProtocol` value and a new `evaluation` inbound capability. It reuses the existing
pipeline's model-first routing, same-protocol raw, fallback, usage, and protocol-shaped errors.
It does not route evaluation through `languageModel` or `ModelInvocation`.

## Current repo state

Live checkout `53b68fa2` on branch `claude/recursing-swartz-3e1975`:

- `InboundCapability` is `'language' | 'image' | 'embedding' | 'speech' | 'transcription' | 'video'`
  (`packages/core/src/protocol/adapter.ts:12`). There is no evaluation capability.
- `ProviderProtocol` (`packages/types/src/provider-endpoints/provider-endpoints.ts:4-13`) has eight
  values: `openai-response`, `openai-compatible`, `anthropic`, `gemini`, `gemini-interactions`,
  `openai-image`, `openai-audio`, `openai-video`.
- There is no `/v1/systemone` route. Nothing in the repo references typesafe, systemone, or jev.
- `attemptDispatch` (`packages/server/src/routes/pipeline/attempt/attempt.ts:156-165`) discriminates
  on `adapter.capability`: positive tests for embedding / image / video / language, audio is the
  fallthrough. `dispatchCandidate` (`:137-154`) switches over that union.
- `ai` is pinned at `7.0.8` and `@ai-sdk/provider` at `4.0.1` in the root catalog. Neither
  `experimental_evaluate` nor `Experimental_EvaluationModelV4` exists at those versions.
- `ai-sdk` provider loading is generic: `loadCachedProvider` picks the first `create*` function
  export from the named package, so `createTypeSafeAi` already works with no allowlist change.
- `createAiSdkProvider` derives its primary protocol from the AI SDK package classifier. At the time
  this spec was written that was `imageTargetProtocolForPackage`
  (`packages/core/src/image-input/image-input.ts:112-125`), a closed switch over four packages
  returning `undefined` by default. **As of commit `f99c3237` it is `aiSdkPackagePrimaryProtocol` in
  `packages/core/src/ai-sdk-package-protocol/`**, renamed and relocated because the name no longer
  described what it decides. Behavior for the original four packages is unchanged.
- `UsageCapture` (`packages/server/src/usage-capture/shared.ts:77-83`) has `stream`, `passthrough`,
  and `embedding`. Image usage bypasses it via the free function `captureImageUsage`.
- 17 non-test files hold exhaustive `ProviderProtocol` switches or `Record<ProviderProtocol, ...>`.
- `filterCandidatesByCapability` in `routes/pipeline/attempt/capability-filter/capability-filter.ts` tests each
  capability and falls through to `supportsLanguage` for anything unrecognized.
- `withoutCallerCredentialsOnRequest` exists at `server/api-key-auth/api-key-auth.ts:104` but
  `routes/pipeline/attempt/raw.ts:40` applies it only when `capability === 'video'`.
- `ProtocolId` (`plugin-sdk/src/runtime.ts:7-15`) is a separate eight-value union, not derived from
  `ProviderProtocol`.

Provenance for claims that cannot be read out of this repo: package versions and exports were checked
by inspecting the published tarballs (`@ai-sdk/typesafe-ai@3.0.4` `dist/index.d.ts` and `dist/index.js`
for the wire schemas and the `boolean` -> `noul` rewrite; `ai@7.0.107` `dist/index.d.ts` and CHANGELOG
for the `experimental_evaluate` introduction in `7.0.103`; `@ai-sdk/provider@4.0.1` for the absence of
`Experimental_EvaluationModelV4`; `@ai-sdk/gateway@4.0.87` for `evaluationModel`). The Gateway model
catalog was read from its published `capabilities=evaluation` listing. Re-verify before implementing
if these have moved.

## Scope

In:

- `POST /v1/systemone`
- `ProviderProtocol.TypeSafeSystemOne = 'typesafe-systemone'`, and the same value on the plugin SDK's
  separate `ProtocolId` union
- `InboundCapability` gains `'evaluation'`; `ModelCapabilityIndex`, `PROTOCOL_CAPABILITIES`, and the
  pipeline capability filter gain the matching arm plus `supportsEvaluation`
- `defineEvaluationProtocolAdapter` plus the adapter for this wire shape
- An `evaluation` runtime capability: raw for a protocol-matching `api` endpoint (primary or extra),
  and convert for any `api` or `ai-sdk` provider whose AI SDK package exposes `evaluationModel`
- Same-protocol raw, convert via `experimental_evaluate`, fallback, usage, protocol-shaped errors
- Caller-credential stripping on the evaluation raw path
- A `/v1/systemone` branch in `authenticationError()` so proxy 401s are TypeSafe-shaped
- Renaming and relocating the AI SDK package-to-primary-protocol classifier out of the image module
- Dependency bumps: `ai`, `@ai-sdk/provider`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`
- Adapter tests, an evaluation dispatch matrix, a config-level routing test, README rows, regenerated
  config JSON schema, dashboard protocol selector and i18n labels, a changeset

Out:

- Emulating evaluation on language models by hand. The AI SDK's own adapters already do this for
  OpenAI / Anthropic / Google; aio-proxy adds no structured-output emulation of its own.
- Built-in `jev-latest` to `typesafe-ai/jev` aliasing. Per-provider `alias` already covers it.
- Streaming. System One returns one complete result; there is no partial-answer stream.
- A `@aio-proxy/plugin-typesafe` package. TypeSafe is a bearer-key API, not an OAuth vendor.
- An `evaluation` bucket on the plugin SDK `ModelCatalog`. No plugin implements evaluation.
- Hardcoding model IDs anywhere.
- Fixing the multi-capability-package language leak. It is asserted by test, not repaired.
- Capability filtering on `GET /v1/models`.
- Reopening the language `ProtocolAdapter` / `ModelInvocation` contract.

## Wire contract

TypeSafe's published prose disagrees with the zod schemas its own provider package parses. For the
**response and error** shapes the schemas in `@ai-sdk/typesafe-ai@3.0.4` are authoritative and this
spec follows them:

| Field | Docs prose | Actual schema |
| --- | --- | --- |
| response `model` | required | nullish |
| `confidence` on choice / score | required | nullish |
| `legend` on a score answer | present | does not exist; never parsed |
| `probabilities` on choice / score | required | required |

The **request** side has no such authority. That package only ever builds outbound requests, and its
sole request-side validation is two hard limits: `choice.criteria` at most 255 options and
`score.criteria` at most 10 levels. There is no inbound zod request schema to copy.

So the request contract below is **aio-proxy's chosen inbound contract**, derived from TypeSafe's
documented request fields plus those two enforced limits. It is deliberately strict: rejecting a
malformed body at the edge beats forwarding it and mapping an upstream 422 back through the error
mapper. Parser tests assert this contract as aio-proxy's own, not as "TypeSafe's schema says so".

### Request

`POST /v1/systemone`, `Authorization: Bearer <key>`, `Content-Type: application/json`.

- `state` (required): a string, JSON object, or JSON array. An array is one state, not a batch.
  Top-level `null`, numbers, and booleans are rejected.

  This matches TypeSafe's documented field **and** `ai@7.0.107`'s `isInput()`, which
  `validateEvaluationInput()` enforces before `model.doEvaluate()` is ever called. An earlier revision
  widened this to "any JSON value including `null`" to resolve a different contradiction; that was the
  wrong direction, because raw would accept bodies convert could never evaluate, making the endpoint's
  contract depend on which transport happened to win. Narrow here so both transports agree.
- `model` (required): non-empty string.
- `questions` (required): non-empty map of caller-chosen ID to question. Each question has `type` and a
  required `instructions` that is itself a string, object, or array (the same `isInput` rule; not
  `null`, a number, or a boolean).
  - `noul`: optional `criteria` object with `true` / `false` string descriptions.
  - `choice`: required `criteria` map of option name to description or `null`. At most 255 options.
  - `score`: required `criteria` array of ordered level descriptions. At least 2, at most 10.

Rejected at parse (400, TypeSafe error shape): a body that is not valid JSON; a `state` that is
`null`, a number, or a boolean; missing or empty `model`; missing, non-object, or empty `questions`;
an absent `state` key; a question whose `instructions` is missing, `null`, a number, or a boolean;
unknown question `type`; a `choice` with empty or >255 criteria; a `score` with <2 or >10 levels; a
criteria value that is neither `null` nor a string/object/array.

Also rejected: any number anywhere in the body that parses to a non-finite value. This is reachable
over the wire despite `Infinity` and `NaN` not being JSON literals — `JSON.parse('1e400')` yields
`Infinity`, including nested inside `state`. An earlier revision claimed non-finite values were
impossible over HTTP; that was wrong. They must be rejected explicitly, because `isJSON()` in the SDK
rejects them on convert and `JSON.stringify` would silently turn them into `null`.

The AI SDK's genuinely unreachable in-process cases — functions, class instances, cyclic references,
and `undefined` — cannot survive JSON transport and are not part of the parse contract.

#### Unknown fields

Unknown fields are **preserved through parse and raw**, at every level: top-level, inside a question
object, and inside `noul.criteria` beyond `true` / `false`. Parse validates the fields it knows and
leaves the rest untouched.

This serves raw passthrough. Raw forwards the original body with only `model` rewritten, so a strict
schema would reject bodies the upstream itself accepts, making aio-proxy the reason a caller cannot use
a field TypeSafe shipped yesterday.

**Convert projects rather than forwards.** It is not enough to say convert "ignores" unknown fields,
because the SDK actively rejects some of them:

```js
// ai@7.0.107 validateEvaluationInput
case "boolean":
  if (!isRecord(criteria) || Object.keys(criteria).some((key) => key !== "true" && key !== "false"))
    invalidInput(parameter, question, "boolean criteria may only describe true and false");
```

So a preserved extra key in `noul.criteria` would make convert throw on a request parse accepted.
Convert therefore builds the SDK question from known fields only: for `noul` it projects exactly
`true` and `false` out of `criteria`; for `choice` and `score` it passes `criteria` unchanged, since the
SDK imposes no key restriction there beyond each value being `null` or `isInput`. Unknown fields at the
top level and on the question object are dropped from the SDK call.

`state` and `instructions` are **never** projected. They are evaluation data, and their interior object
keys are content the model is meant to see.

Implementation consequence, stated because it is easy to get wrong by reflex: these are **not**
`z.strictObject()`. The repo's habit of strict config objects exists so a typo in user-authored config
fails loudly, which is the opposite of a third-party wire body.

#### Content-Type

`application/json` is required, and the check is on the media type only:

- `application/json` and `application/json; charset=utf-8` are accepted; parameters are ignored.
- A missing `Content-Type` is accepted when the body parses as JSON, matching how the existing
  protocol routes behave rather than inventing a stricter rule for this one endpoint.
- Any other media type is 415 in the TypeSafe error shape, even when the body happens to be valid JSON.

415 therefore covers both an unsupported media type and an unsupported content-encoding.

### Inbound authentication errors

`authenticationError()` (`api-key-auth.ts:157-165`) special-cases only `/v1/messages` and `/v1beta/`;
everything else receives the OpenAI-shaped `{ error: { message, type } }`. A proxy-level 401 on
`/v1/systemone` would therefore not be TypeSafe-shaped, contradicting the guarantee below.

Add a `/v1/systemone` branch returning the TypeSafe error shape, and test it. This is inbound
authentication by aio-proxy against its own caller keys, and is unrelated to upstream 401s.

### Response

```json
{
  "model": "jev-latest",
  "answers": {
    "is_urgent": { "type": "noul", "noul": 0.999 },
    "department": { "type": "choice", "choice": "billing",
                    "probabilities": { "billing": 0.84, "support": 0.16 }, "confidence": 0.9 },
    "severity": { "type": "score", "score": 1.0,
                  "probabilities": { "0": 0.1, "1": 0.8, "2": 0.1 }, "confidence": 0.7 }
  },
  "usage": { "input_tokens": 312, "output_tokens": 48 }
}
```

The score and its distribution agree on purpose: `0(0.1) + 1(0.8) + 2(0.1) = 1.0`. TypeSafe's own docs
sample pairs this distribution with `1.035`, which the **wire schema accepts** — it never checks the
weighted mean — but which `experimental_evaluate` **rejects**, because it validates the score against
the probability-weighted mean within the provider's declared rounding allowance (two decimals here,
roughly ±0.02, against a 0.035 discrepancy). Using the docs figure here would make this example a
body convert could never produce. It is not grounds for validating or repairing raw responses.

`probabilities` is required on choice and score. `confidence` is optional. A score answer carries no
`legend`.

Response `model` differs by transport, and the difference is deliberate rather than papered over:

- **Convert** writes the **public slug the client requested**. A client asking for `public-jev` gets
  `"model": "public-jev"` even when the upstream ID was `typesafe-ai/jev`. Echoing the upstream ID
  would leak routing topology and break clients comparing the field against what they sent.
- **Raw passthrough** returns the upstream body byte-for-byte, so `model` is whatever the upstream
  chose to write. Under an alias (`public-jev` -> `jev-latest`) that is normally the resolved upstream
  ID, because that is what the rewritten request asked for — but nothing guarantees equality, and the
  field may be `null` or absent, since the real schema marks it nullish. Raw preserves the upstream's
  value; it neither asserts nor repairs it.

There is no guarantee that both transports echo the public slug, and this spec does not promise one.
Normalizing `model` on the raw path would mean parsing and re-serializing the upstream JSON, which
forfeits the pure-passthrough property the whole raw architecture depends on and that every other
capability preserves. The asymmetry is the lesser cost, and it is asserted by test so nobody
"fixes" it by accident.

Because of this, `evaluationJson`'s egress context field is named `responseModelId`, **not** `modelId`.
The embedding egress it is modelled on passes `candidate.modelId`, which is the resolved upstream ID;
copying that pattern here would silently produce the wrong value. The pipeline passes the requested
public slug explicitly:

```ts
adapter.evaluationJson(result, { responseModelId: ctx.requestedModelId })
```

### Errors

TypeSafe's error body, per the schema its provider package parses:

```
{ message?, detail?, error?: string | { message? }, error_type? }
```

aio-proxy emits `{ message, error_type }` for its own protocol-shaped errors.

The guarantee is scoped, and the scope is load-bearing: **every error aio-proxy generates, and every
convert-path error, uses the TypeSafe shape. Raw upstream error responses are forwarded unchanged.**
A promise that *all* failures are TypeSafe-shaped would be unkeepable — an upstream, a CDN, or a
misconfigured base URL can return HTML, plain text, or some other JSON shape, and normalizing it would
forfeit the same pure-passthrough property the success path preserves. This is the same asymmetry
accepted for response `model`, for the same reason.

| Case | Status |
| --- | --- |
| Proxy-level authentication failure | 401, via a new `/v1/systemone` branch in `authenticationError()` |
| Invalid JSON / invalid body / unsupported question shape | 400 |
| Unknown model (router miss) | 404 |
| Body too large / bad content-encoding | 413 / 415 (existing helpers), in TypeSafe error shape |
| Convert produced a choice or score answer without `probabilities` | 501 unsupported, then fallback if `hasNext` |
| Candidate has neither raw nor evaluation convert | 501 unsupported, then fallback if `hasNext` |
| Upstream / plugin throw | existing provider mapping, then fallback if eligible |

Upstream 401, 422, 429, and 529 need no new handling: 422, 429, and >=500 are already the
fallback-eligible statuses, so 529 Overloaded falls back and 401 does not.

## Approaches

### A. New `ProviderProtocol` value + `evaluation` capability (recommended)

One stateless adapter, one route, one new enum value, one new runtime capability.

The P2 embeddings spec rejected new `ProviderProtocol` values, on the grounds that embeddings is an
inbound surface over an upstream origin the user already configured as `openai-compatible` or
`gemini`. That reasoning does not transfer. `api.typesafe.ai` is a genuinely new upstream origin
speaking a wire family no existing value describes, and the enum already carries capability-specific
families (`openai-image`, `openai-audio`, `openai-video`, `gemini-interactions`). Embeddings was the
exception; a new origin with a new wire shape is the rule.

The vendor prefix is deliberate. Every existing value is vendor-prefixed, and the System One wire
format is TypeSafe's own: `noul` is TypeSafe's wire vocabulary, which `@ai-sdk/typesafe-ai` translates
to and from the SDK's neutral `boolean`. On Vercel AI Gateway, TypeSafe's model is the only one typed
`evaluation`. Other providers participate at the SDK's `evaluationModel` abstraction, never at this
HTTP format. So the capability is vendor-neutral (`evaluation`) and the protocol is vendor-specific
(`typesafe-systemone`). If another vendor later adopts the format, a vendor-derived name remains
consistent with how `openai-compatible` already names a widely-implemented format after its origin.

Accepting A means accepting a public-surface change: the config enum, the plugin SDK `ProtocolId`,
the capability index, the generated JSON schema, the dashboard selector, i18n, passthrough usage
extraction, and model listing all move together. It is not a local edit, and the Implementation
boundaries section enumerates the whole radius.

### B. Reuse `openai-compatible` and distinguish by route

Keeps the enum at eight values. But raw matching is protocol-exact, so every existing
`openai-compatible` provider would falsely match `/v1/systemone` and forward System One bodies to
chat upstreams. Rejected.

### C. A capability-aware raw identity outside `ProviderProtocol`

The honest alternative to A, and not a straw man: give raw resolution a `(capability, wireFormat)`
key so an evaluation upstream can be addressed without widening a public config enum. This keeps
`ProviderProtocol` as the user-facing set of chat-ish wire families and confines the new format to
runtime identity.

Rejected for this change, not on principle. Raw matching, the plugin SDK `ProtocolId`, passthrough
usage extraction, and the probe all key off a single protocol value today; introducing a parallel
identity axis is a larger refactor than the feature justifies, and it would leave users unable to
declare a TypeSafe endpoint in config at all. If a third or fourth non-chat wire family arrives, this
becomes the better design and A's enum growth is the signal to revisit.

### D. Model evaluation as a language call with structured output

Fights the adapter, usage, SSE, and tool contracts, and duplicates work the AI SDK already does
inside its own OpenAI / Anthropic / Google evaluation adapters. Rejected.

This spec implements A.

## Architecture

```text
TypeSafe SDK / cURL
POST /v1/systemone
        |
        v
  typeSafeSystemOneAdapter
  protocol: typesafe-systemone
  capability: evaluation
        |
        v
  attemptCandidates (still the only candidate loop)
        |
   +----+--------------------------+
   |                               |
   v                               v
 same-protocol raw            evaluation convert
 raw.resolve(protocol)        provider.evaluation.evaluate
 rewritten Request            experimental_evaluate
   |                               |
   +----+--------------------------+
        v
  fallback / usage / TypeSafe-shaped errors
```

### Units

1. **Evaluation adapter** - parse, model ID, raw rewrite, `EvaluationInvocation`, JSON egress,
   errors. No stream, no session, no tools, no effort clamp.
2. **Thin route** - one `POST /v1/systemone` registration. No protocol branching in the route.
3. **Shared pipeline** - one new `attemptEvaluationCandidate`, shaped like
   `attemptEmbeddingCandidate`: raw first, then convert, else unsupported.
4. **Evaluation transport** - a new optional runtime capability, parallel to `embedding`.

## Adapter contract

A parallel factory, not an extension of the language or embedding adapter:

```ts
type EvaluationQuestion =
  | { readonly type: 'noul'; readonly instructions: unknown;
      readonly criteria?: { readonly true?: string; readonly false?: string } }
  | { readonly type: 'choice'; readonly instructions: unknown;
      readonly criteria: Readonly<Record<string, string | null>> }
  | { readonly type: 'score'; readonly instructions: unknown;
      readonly criteria: readonly string[] };

type EvaluationInvocation = {
  readonly state: unknown;
  readonly questions: Readonly<Record<string, EvaluationQuestion>>;
};

type EvaluationAnswer =
  | { readonly type: 'noul'; readonly noul: number }
  | { readonly type: 'choice'; readonly choice: string;
      readonly probabilities?: Readonly<Record<string, number>>; readonly confidence?: number }
  | { readonly type: 'score'; readonly score: number;
      readonly probabilities?: Readonly<Record<string, number>>; readonly confidence?: number };

type EvaluationResult = {
  readonly answers: Readonly<Record<string, EvaluationAnswer>>;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
};

type EvaluationProtocolAdapter<TRequest, TContext> = Readonly<{
  capability: 'evaluation';
  protocol: ProviderProtocol;
  bodyLimits: (raw: Request, context: TContext) => RequestBodyLimits;
  parse: (raw: Request, context: TContext) => Promise<TRequest>;
  model: (request: TRequest, context: TContext) => string;
  dimensions: (request: TRequest, context: TContext) => AliasDimensions;
  requestDiagnostics: (request: TRequest, context: TContext) => readonly ProtocolRequestDiagnostic[];
  // Evaluation never resolves a logical session. Declared so the shared pipeline
  // can read `session` off any adapter, exactly as the embedding adapter does.
  session?: undefined;
  wantsStream: (request: TRequest, context: TContext) => boolean;
  rawRequest: (raw: Request, request: TRequest, resolvedModel: string, context: TContext)
    => Promise<Request>;
  evaluationInvocation: (request: TRequest, context: TContext) => EvaluationInvocation;
  evaluationJson: (result: EvaluationResult, context: { readonly responseModelId: string }) => unknown;
  errors: ProtocolErrorMapper;
}>;
```

The concrete type carries every field the pipeline reads, matching `EmbeddingProtocolAdapter`.
`defineEvaluationProtocolAdapter` takes an `Omit<..., 'bodyLimits' | 'dimensions' |
'requestDiagnostics' | 'session' | 'wantsStream'>` plus optional overrides and fills the defaults:
`wantsStream` always false, `session` omitted, `dimensions` empty, `requestDiagnostics` empty,
`bodyLimits` the shared `REQUEST_BODY_LIMITS`. Promising defaults only in prose would either fail to
compile against the shared loop or force the pipeline to special-case evaluation.

### Session, ownership, and affinity

Stated as explicit constraints, matching what the embeddings spec had to spell out:

- Evaluation always uses a generated logical session. It never hashes `state` or `questions` into a
  transcript key.
- It never reads or commits response ownership, and never establishes session affinity. Candidate
  order is therefore priority and weight only.
- `usageCapture.passthrough` is called without `onResponseId` / `onCommit`, which follows
  automatically from `adapter.session` being undefined.

### Body limits

Evaluation uses the shared `REQUEST_BODY_LIMITS`, the same ceiling as language. It is not raised:
`state` accepting objects and arrays makes large bodies easy to send, which is a reason to keep the
existing limit rather than relax it. The body is read and parsed before candidate selection, as with
every other buffered capability, so an oversized or badly-encoded body is rejected once, up front,
and never per candidate. 413 and 415 come from the existing helpers and are rendered in the TypeSafe
error shape by this adapter's `errors` mapper.

## Convert mapping

Convert never speaks another vendor HTTP API. It folds the inbound body into `EvaluationInvocation`,
calls `experimental_evaluate`, and the inbound adapter writes the TypeSafe envelope.

| Inbound wire | AI SDK evaluate |
| --- | --- |
| question `type: 'noul'` | `type: 'boolean'` |
| question `type: 'choice'` / `'score'` | unchanged |
| `instructions`, `state` | passed through as-is; never projected |
| `choice` / `score` `criteria` | passed through as-is |
| `noul` `criteria` | projected to exactly `true` / `false`; extra keys dropped |
| answer `{ probability }` | `{ type: 'noul', noul: probability }` |
| answer `{ choice, probabilities }` | `{ type: 'choice', choice, probabilities }` |
| answer `{ score, probabilities }` | `{ type: 'score', score, probabilities }` |
| `providerMetadata.typesafe.confidence[id]` | `confidence` on that answer, when present |
| `usage.inputTokens` / `outputTokens` | `usage.input_tokens` / `output_tokens` |

`probabilities` is required on choice and score. If a **convert** result yields a choice or score
answer without a distribution, the adapter does not emit a body missing the field and does not
fabricate one: the candidate fails with `errors.unsupported('evaluation_distribution')` and falls back
if `hasNext`. This follows the embeddings precedent, where unknown usage on OpenAI egress fails the
candidate rather than emitting a non-conformant envelope.

This invariant is scoped to convert, for the same reason the error-shape guarantee is. Raw forwards the
upstream body byte-for-byte and does not validate it, so a raw 200 carrying a distribution-less choice
answer is passed to the client unchanged. `completeRawAttempt` hands the response to usage capture and
returns it; it does not apply the response schema. A global "no such body is ever emitted" invariant
would contradict raw passthrough, and validating raw success bodies would be a different contract than
the one this spec describes.

The consequence is worth stating plainly, because it bounds the failover story. The System One wire
format is TypeSafe's own, and the AI SDK's OpenAI / Anthropic / Google evaluation adapters never
return choice or score distributions. So:

- A request whose questions are all `noul` can be served by any candidate whose evaluation model lists
  `boolean` in its `supportedQuestionTypes`. The discovery probe only establishes that
  `evaluationModel` exists; per-question-type support is a separate SDK check, and
  `experimental_evaluate` raises `Experimental_EvaluationUnsupportedQuestionTypeError` before calling
  the model when it is missing. Do not bypass that check or treat the probe as a promise about
  question types.
- A request containing any `choice` or `score` question is effectively TypeSafe-only: it succeeds
  against `typesafe-systemone` raw, `@ai-sdk/typesafe-ai`, or a Gateway route to TypeSafe's own
  evaluation model, and 501s on the others.

`confidence` is optional in the real schema, so it is written when the provider supplies it and
omitted otherwise. That omission is schema-legal; a missing `probabilities` is not.

**Corroborated, still needs a fixture.** That the OpenAI / Anthropic / Google evaluation adapters never
return choice or score distributions was checked in the tagged provider sources: all three share one
evaluation adapter whose choice and score branches return the scalar answer with no `probabilities`
field, while its boolean branch returns a numeric probability. That is source inspection, not an
executed tarball or an installed lockfile, and this repo's own pins do not yet contain those versions.

Freeze it as a version-locked behavioral fixture before relying on it. The fixture must drive the real
provider adapter against a deterministic fake upstream response. Configuring a mock evaluation model to
omit distributions would only assert the fixture author's belief, not the dependency's behavior, which
is the failure mode this note exists to prevent.

Score answers carry no `legend`, matching the real schema.

`maxRetries` is set to 0. The pipeline owns retry and fallback; letting the SDK retry underneath
would hide attempts from traces and double the candidate's time budget.

## Dispatch

`attemptDispatch` gains one positive arm before the audio fallthrough, and `dispatchCandidate` one
case. Audio must stay the fallthrough: its `capability` is a union, so it cannot be narrowed away.

```ts
if (adapter.capability === 'evaluation') return { kind: 'evaluation', ctx: { ...ctx, adapter } };
```

`attemptEvaluationCandidate` follows `attemptEmbeddingCandidate`:

1. **Raw** if this resolves to a transport:

   ```ts
   provider.raw?.resolve({
     protocol: 'typesafe-systemone',
     modelId,
     capability: 'evaluation',
     ...requestPathProperty(ctx.rawRequest),
   })
   ```

   The `capability` field is required, not optional: a language-only resolver must be able to decline.
   `rawRequest` has already rewritten the body `model` to the resolved upstream ID. Existing fallback
   statuses apply. A raw throw or non-fallback status does not retry this candidate's convert.
2. **Evaluation convert** if the candidate exposes `evaluation`. Call
   `evaluation.evaluate(invocation, { modelId, signal, logicalRequest })`. Never call
   `provider.model.invoke`.
3. **Unsupported** otherwise: `adapter.errors.unsupported('evaluation_convert')`, then fallback if
   `hasNext`.

Language, embedding, image, audio, and video requests never see this branch.

### Runtime shape

`RuntimeProviderInstance` gains an optional `evaluation` capability alongside `raw`, `model`,
`embedding`, and `image`. A provider may expose any combination.

Materialization:

- **API** - raw stays protocol-exact: an endpoint declaring `protocol: typesafe-systemone` gets a raw
  transport. Convert is **also** materialized, through the existing primary-endpoint package map,
  whenever that package exposes `evaluationModel`: `openai-response` -> `@ai-sdk/openai`,
  `openai-compatible` -> `@ai-sdk/openai-compatible`, `anthropic` -> `@ai-sdk/anthropic`, `gemini` ->
  `@ai-sdk/google`. A package without `evaluationModel` omits the capability.
- **AI SDK** - if the loaded package exposes `evaluationModel`, expose the capability. Otherwise
  omit it. Checked lazily and per-capability, matching how `embeddingModel` is checked.
- **OAuth** - no evaluation transport. No plugin implements one.

The `evaluation` runtime capability is **server-internal**. It lives on `RuntimeProviderInstance` in
the server, derived from the AI SDK provider object's `evaluationModel`. It is not a new public plugin
SDK capability: plugins do not declare or implement evaluation, `ModelCatalog` gains no `evaluation`
bucket, and `OAuthRuntimeResult` is unchanged. The only plugin SDK edits are the two type widenings
below (`ProtocolId` and the `RawResolver` capability union), both of which are needed so plugin raw
resolvers can *decline* evaluation coherently.

Materializing convert for non-TypeSafe `api` providers is required by CLAUDE.md's Cross-Protocol
Routing rule: raw passthrough only when the inbound protocol matches, otherwise build the matching AI
SDK provider for that attempt and convert. It also matches the embeddings runtime shape. An earlier
draft of this spec disabled `api` convert; that was wrong, and it would have made evaluation narrower
than the architecture the repo already commits to. Note this does not contradict the previous section:
those candidates still 501 on `choice` / `score` for want of a distribution, but they legitimately
serve all-`noul` requests, and the decision belongs to egress validation rather than to
materialization.

`RawResolver` (`packages/plugin-sdk/src/runtime.ts:84-92`) already takes an optional `capability`, but
its union is `'language' | 'embedding' | 'speech' | 'transcription'` and must gain `'evaluation'`.
Evaluation inbound always passes it. A language-only resolver returns `undefined` for `'evaluation'`,
so the convert branch runs instead of a raw path that would throw on an unrecognized request path.

`ProtocolId` (`packages/plugin-sdk/src/runtime.ts:7-15`) is a **separate** eight-value string union,
not derived from `ProviderProtocol`, and it is the type of `RawResolver`'s `protocol` field. It must
gain `'typesafe-systemone'` too. Changing only the `ProviderProtocol` enum leaves plugin raw
resolvers, runtime raw capability, and the SDK's exported types inconsistent.

### Candidate capability filtering

`filterCandidatesByCapability` in `packages/server/src/routes/pipeline/attempt/capability-filter/capability-filter.ts`
tests each inbound capability and **falls through to `supportsLanguage` for anything it does not
recognize**. Adding `'evaluation'` without an explicit arm there would compile and then silently
filter evaluation candidates by *language* support, which is the wrong predicate and would drop
correct candidates. The filter needs an `evaluation` arm calling a new `supportsEvaluation`.

### Credentials on raw passthrough

The inbound contract and the upstream both use `Authorization: Bearer`, so this needs stating
precisely rather than leaving to the implementer. It is the easiest part of this spec to implement
incorrectly.

`withoutCallerCredentialsOnRequest` exists (`packages/server/src/server/api-key-auth/api-key-auth.ts:104`)
but `raw.ts:40` applies it only when `adapter.capability === 'video'`, **inside `attemptRawCandidate`**.
Evaluation does not go through that function. Like `attemptEmbeddingCandidate`
(`attempt/embedding.ts:38-41`), it calls `startRawAttempt`, then `adapter.rawRequest`, then
`completeRawAttempt`. So widening the `capability === 'video'` test in `attemptRawCandidate` would have
**no effect whatsoever** on evaluation raw, while looking like it fixed the problem.

Required implementation path, stated explicitly:

- `attemptEvaluationCandidate` applies `withoutCallerCredentialsOnRequest` to the rewritten request
  returned by `adapter.rawRequest`, before passing it to `completeRawAttempt`.
- Preferably the stripping moves into the shared `completeRawAttempt` (or a helper both call) keyed on
  capability, so the embedding-shaped and `attemptRawCandidate`-shaped paths cannot drift apart again.
  If it stays duplicated, the duplication is deliberate and commented.
- Upstream auth comes from the provider's configured `apiKey`, with configured `headers` winning over
  anything derived from the inbound request.
- A test asserts the forwarded upstream request carries the provider key and not the caller's, and
  that a caller-supplied `Authorization` cannot override it. The test exercises the real evaluation raw
  path, not `attemptRawCandidate`.

## Capability index

This is the one place where the new protocol must be taught, or evaluation models leak into chat.

`synthesizesLanguage` (`packages/server/src/provider-runtime/capability-index/capability-index.ts:152-158`)
returns `true` when `primaryProtocol` is `undefined` and the provider has no catalog. An `ai-sdk`
provider pointed at `@ai-sdk/typesafe-ai` hits exactly that case today, because
`imageTargetProtocolForPackage` is a closed switch over four packages returning `undefined` by
default. The result is that `jev-latest` would be synthesized as a routable **language** ID, and a
chat request naming it would select the candidate and fail at invoke.

Four changes, all using mechanisms that already exist:

1. `PROTOCOL_CAPABILITIES` is a total `Record<ProviderProtocol, readonly InboundCapability[]>`, so the
   new enum value needs a row and TypeScript enforces it. The rows change as follows:

   | Protocol | Capabilities | Note |
   | --- | --- | --- |
   | `typesafe-systemone` | `['evaluation']` | new row; serves nothing else |
   | `openai-response` | `['language', 'embedding', 'evaluation']` | `@ai-sdk/openai` has `evaluationModel` |
   | `anthropic` | `['language', 'embedding', 'evaluation']` | `@ai-sdk/anthropic` has `evaluationModel` |
   | `gemini` | `['language', 'embedding', 'evaluation']` | `@ai-sdk/google` has `evaluationModel` |
   | `openai-compatible` | unchanged | `@ai-sdk/openai-compatible` has **no** `evaluationModel` |
   | `gemini-interactions` | unchanged | not an evaluation origin |

   These entries answer "could this wire family serve evaluation at all", which raw resolution and the
   `typesafe-systemone` clause consult. They are **not** what makes `api` convert reachable — the
   transport predicate below is. Do not restore a causal claim here; reasoning from the protocol table
   to the grant is exactly the defect the predicate replaced.

   Granting at protocol level and letting materialization decide is exactly how embedding already
   works: the grant says "this origin can plausibly serve the capability", and a package lacking the
   method fails at invoke and falls back.

2. `servesLanguage('typesafe-systemone')` is false. It appears in no other capability's grant.
3. Add `synthesizesEvaluation`. It does **not** mirror `synthesizesEmbedding`, which tests only the
   primary protocol and would suppress evaluation for a provider whose System One origin is an
   additional endpoint. The rule is:

   ```text
   evaluation is granted to a finite id when
     the provider has a materialized evaluation transport
     OR the provider has a typesafe-systemone endpoint, primary or extra
   ```

   This keys on **transports that actually exist**, not on protocol metadata alone. Deriving it from
   the protocol union instead is wrong in both directions, and both cases are reachable from
   documented configuration:

   | Provider | Real transport | Protocol-union rule | Transport rule |
   | --- | --- | --- | --- |
   | `@ai-sdk/gateway` (`primaryProtocol` undefined, no extras) | convert | **denied** | granted |
   | `openai-compatible` primary + `openai-response` extra | none | **granted** | denied |
   | `openai-compatible` primary + `typesafe-systemone` extra | raw | granted | granted |

   The first row is the fatal one: `@ai-sdk/gateway` is deliberately left unmapped by the package
   classifier below, so it has no primary protocol and no extra endpoints. Under a protocol-union rule
   the documented direct-primary / Gateway-backup configuration would be filtered out before dispatch
   and could never fail over, while the spec lists that exact scenario as an acceptance criterion.
   Language avoids this trap only because `synthesizesLanguage` has a permissive
   `primaryProtocol === undefined` fallback; evaluation has no equivalent and must not invent one,
   because that would re-admit every unclassified package.

   Implementation: `CapabilityIndexInput` gains `hasEvaluationTransport?: boolean`, set from a probe of
   the loaded package.

   ```ts
   synthesizesEvaluation = (input) =>
     input.hasEvaluationTransport === true || hasProtocol(input, ProviderProtocol.TypeSafeSystemOne);
   ```

   The second clause is what keeps raw eligibility independent of the convert probe: a provider with a
   `typesafe-systemone` endpoint is evaluation-capable no matter what its primary package contains. The
   boolean carries the convert answer only, and deliberately cannot express "preparation failed" — see
   the composed admission table below, which is the normative rule.

   `CapabilityIndexInput` already declares `hasImageModel?: boolean`, so the **shape** has precedent.
   Be aware it is currently dead: nothing in the repo reads it. Treat it as a naming convention to
   follow, not as a working mechanism to copy.

#### Discovery lifecycle

The probe cannot run where the index is built today. `createAiSdkProvider()` is synchronous and returns
a wrapper; the real SDK provider arrives through an asynchronous memoized `providerTask()`, and the
embedding wrapper only checks for its method after awaiting that task. `materializeProviders()` and
`materializeRuntimeProvider()` are synchronous too, and the latter builds the capability index while
constructing the runtime provider. At that moment the package object to probe does not exist.

Resolution: **lazy, memoized probe at an asynchronous preparation boundary before evaluation capability
filtering**, not a synchronous answer at materialization. On the first evaluation request touching a
provider, await its `providerTask()`, probe `typeof evaluationModel === 'function'`, and memoize the
verdict for that provider instance. Materialization does not become async, and no other capability's
construction order changes.

The probe has three distinct states, but a probe result is a fact about the **convert transport only**.
It is never a verdict on the whole candidate, because a matching System One raw endpoint establishes
eligibility on its own. The admission decision is therefore a composition of two independent inputs:

| Matching System One raw transport | Convert preparation | Behavior |
| --- | --- | --- |
| present | any state, including unprobed | admit; raw wins. Convert discovery cannot veto raw, and is not awaited |
| absent | not yet probed | await the memoized preparation, then decide |
| absent | resolver present | admit for convert |
| absent | resolver absent | exclude as unsupported |
| absent | load or install failure | admit a prepared candidate failure; surface it when the attempt loop reaches this candidate, with normal fallback |

Two rows encode the mistakes that are easy to make and silent when made:

- **Row 1** is why a negative probe must not exclude the candidate. An `openai-compatible` primary
  provider with an extra `typesafe-systemone` endpoint has no `evaluationModel` in its primary package
  and must still be selected and served by raw. An unconditional "no resolver, not selected" rule
  contradicts the additional-endpoint contract for exactly this provider.
- **Row 5** is why a failed load cannot be squeezed into the boolean. Mapping it to
  `hasEvaluationTransport: false` discards the required candidate failure and the provider silently
  vanishes; mapping it to `true` claims a transport discovery never established. Throwing out of
  request preparation is worse still: it bypasses the candidate loop entirely and can take down a
  request whose *other* candidate was healthy.

How a prepared failure is represented is implementation freedom. Two things are not: it must survive
capability filtering, and it must occupy its normal position in candidate order. A failing backup that
preparation happened to probe first must never pre-empt a healthy primary.

Also treat "not yet probed" as unknown, never as false — that would filter out a cold Gateway candidate
on the first evaluation request of the process — and never treat the presence of a lazy wrapper as
proof of support, which would admit packages whose real provider has no evaluation resolver.
4. Add `'evaluation'` to `ModelCapabilityIndex` and export `supportsEvaluation`, alongside the existing
   `supportsLanguage` / `supportsImage` / `supportsEmbedding` / `supportsSpeech` /
   `supportsTranscription` / `supportsVideo`. The pipeline capability filter calls it.

`PROTOCOL_CAPABILITIES` still gains its `evaluation` entries as above. That table answers "could this
wire family serve evaluation at all", which raw resolution and the `typesafe-systemone` clause need.
It is no longer the sole input to the grant.

### Additional endpoints

`typesafe-systemone` is legal as an `endpoints` entry, not only as the primary protocol. An extra
`typesafe-systemone` endpoint grants `evaluation` to the provider's finite IDs so raw passthrough
works, without disturbing the primary protocol's language or embedding synthesis. A provider can
therefore serve chat on its primary origin and System One on an additional origin.

An extra `openai-response`, `anthropic`, or `gemini` endpoint grants **nothing** for evaluation. API
convert materializes from the primary endpoint package map only, so such a provider has no evaluation
transport, and inbound `typesafe-systemone` cannot raw-match a non-System-One endpoint. Granting it
would produce a candidate that is selected and then always 501s. Extending convert to pick a
capable extra endpoint is a coherent alternative, but it is out of scope here and is not what this
spec specifies.

This is why the `openai-compatible` exclusion must be stated carefully. The precise rule is:

- An `openai-compatible` **primary** protocol grants no evaluation, because
  `@ai-sdk/openai-compatible` has no `evaluationModel` and so convert is impossible.
- An `openai-compatible` primary provider that also declares an extra `typesafe-systemone` endpoint
  **is** evaluation-capable, and serves it by raw passthrough to that endpoint.

"An `openai-compatible` provider is never selected for evaluation" would be too broad and is not what
this spec says.

### AI SDK package classification

An `ai-sdk` provider has no configured protocol, so its primary protocol is derived from its package
name. Extend that classifier with `@ai-sdk/typesafe-ai` -> `typesafe-systemone`, which makes
`primaryProtocol` defined and lets `synthesizesLanguage` return false by its existing second clause.
Without this, an `@ai-sdk/typesafe-ai` provider has `primaryProtocol: undefined` and no catalog, which
synthesizes language IDs and puts its evaluation models in the chat pool.

Map only single-capability packages this way. `@ai-sdk/typesafe-ai` exposes evaluation and nothing
else, so pinning it to `typesafe-systemone` is correct. `@ai-sdk/gateway` must **not** be mapped: it
serves language, image, embedding, and evaluation, and pinning it would suppress language synthesis
and break chat through the Gateway.

That function is currently named `imageTargetProtocolForPackage` and lives in
`packages/core/src/image-input/`. It has already outgrown its name: it is in practice an AI SDK
package-to-primary-protocol classifier. Adding a non-image protocol to it under the image name is the
wrong end state, so this change renames and relocates it to a neutral home rather than piling on.
That rename is in scope precisely because leaving it would entrench the confusion.

`ModelCatalog` in the plugin SDK has no `evaluation` bucket and does not get one: no plugin implements
evaluation, and OAuth exposes no evaluation transport. Routable evaluation IDs come from an `api` or
`ai-sdk` provider's `models` / `alias` configuration.

### The Gateway language-leak, stated honestly

A multi-capability package cannot be pinned, so a Gateway provider that aliases an evaluation model
also synthesizes it as a **language** ID. A chat request naming that slug selects the candidate and
fails at invoke, then falls back.

This spec does not claim to fix that, and it must not claim otherwise:

- It is pre-existing behavior for any unknown or multi-capability AI SDK package, not something
  introduced here.
- Fixing it properly needs per-capability catalogs that the Gateway does not publish.
- Therefore the acceptance criteria are scoped to the `@ai-sdk/typesafe-ai` path, and the Gateway wart
  is covered by a test that **asserts the current behavior**, so a future change to it is a deliberate
  decision rather than an accident.

`/v1/models` continues to list by capability index as it does today. An evaluation-only provider
contributes evaluation IDs and no language IDs; a Gateway provider contributes both, consistent with
the leak above. This spec does not add capability filtering to the listing endpoint.

## Dependencies

`experimental_evaluate` was added in `ai@7.0.103`. `Experimental_EvaluationModelV4` is absent from
`@ai-sdk/provider@4.0.1`. The provider packages gained `evaluationModel` in later 4.0.x releases than
this repo pins, so `api` convert does not work without bumping them too.

| Package | From | To | Why |
| --- | --- | --- | --- |
| `ai` | 7.0.8 | 7.0.107 | `experimental_evaluate` |
| `@ai-sdk/provider` | 4.0.1 | 4.0.17 | `Experimental_EvaluationModelV4` |
| `@ai-sdk/openai` | 4.0.4 | 4.0.71 | `evaluationModel` for `openai-response` convert |
| `@ai-sdk/anthropic` | 4.0.3 | 4.0.58 | `evaluationModel` for `anthropic` convert |
| `@ai-sdk/google` | 4.0.3 | 4.0.76 | `evaluationModel` for `gemini` convert |

`@ai-sdk/openai-compatible` is deliberately absent. As of 3.0.53 it exposes no `evaluationModel` at
all, so an `openai-compatible` primary endpoint has no evaluation convert. It can still serve evaluation
by raw when the same provider declares an extra `typesafe-systemone` endpoint. That is a capability fact
about the package, not a decision by this spec, and it matters because `openai-compatible` is the most
commonly configured protocol in aio-proxy.

`@ai-sdk/typesafe-ai` and `@ai-sdk/gateway` are **not** added to the repo: user-configured `ai-sdk`
packages are resolved from aio-proxy's own npm cache directory and installed on demand by `npmAdd`,
never bundled, so they are unaffected by these pins. Unit tests use
`Experimental_EvaluationMockModelV4` from `ai/test` rather than a real provider package.

This is now a broad AI SDK upgrade across every provider path, not a two-package bump. It ships in the
same change as the feature, so `bun run preflight` must pass in full before the change is considered
complete, and any unrelated failure it surfaces is part of this work.

At `ai@7.0.107`, a string evaluation model ID resolves through the configured default provider, or
through **Gateway when no default provider is configured** — `globalThis.AI_SDK_DEFAULT_PROVIDER ??
gateway`. A configured default lacking `evaluationModel` still throws; Gateway is the default, not a
fallback after that check.

The 7.0.104 changelog said the opposite ("evaluation never implicitly falls back to Gateway"), and
7.0.105 reversed it. Do not reason from that older note.

aio-proxy always passes an explicitly resolved evaluation model instance belonging to the selected
candidate and never relies on string resolution. This is worth stating precisely because the failure
mode is silent: passing a bare string by accident would not error locally, it would quietly route to
Gateway instead of the candidate the pipeline chose, producing a request that succeeds against the
wrong provider and bills the wrong account.

## Routing and configuration

Routing stays model-first and ID-based. No new alias dimension.

There are three usable legs, and the capability treats them uniformly:

1. `api` + `protocol: typesafe-systemone` - raw passthrough to `api.typesafe.ai`
2. `ai-sdk` + `@ai-sdk/typesafe-ai` - convert, still direct to `api.typesafe.ai`
3. `ai-sdk` + `@ai-sdk/gateway` - convert, through Vercel AI Gateway

Leg 3 names the model `typesafe-ai/jev` while legs 1 and 2 call it `jev-latest`. Normalization uses the
existing per-provider `alias`, which maps a public slug to an upstream model ID. Nothing is mapped in
code.

A provider only contributes routable IDs through its `models`, `alias`, or catalog. An `api` provider
with neither declares nothing and never enters the candidate set, so the direct leg must list
`models` explicitly. Omitting it is the most likely way to get a configuration that silently never
fails over.

```yaml
providers:
  typesafe-direct:
    kind: api
    protocol: typesafe-systemone
    baseURL: https://api.typesafe.ai/v1
    apiKey: '{{env.TYPESAFE_AI_API_KEY}}'
    models:
      - jev-latest
    priority: 10
  vercel-gateway:
    kind: ai-sdk
    packageName: '@ai-sdk/gateway'
    options:
      apiKey: '{{env.AI_GATEWAY_API_KEY}}'
    alias:
      jev-latest: typesafe-ai/jev
    priority: 0
```

A client then asks for `jev-latest`. `typesafe-direct` is tried first on priority 10 via raw; on a 429
or 529 the request falls back to `vercel-gateway`, which converts through `experimental_evaluate`
against the upstream ID `typesafe-ai/jev`. Because `vercel-gateway` uses a multi-capability package,
`jev-latest` is also synthesized as a language ID on that provider; see the Gateway language-leak note.

A test must exercise this exact YAML end to end, not a hand-built candidate array, or it will not
catch the missing-`models` failure it exists to prevent.

Evaluation IDs are not hidden from chat clients beyond the capability-index fix. A chat model posted
to `/v1/systemone` is a candidate that fails and may fall back, matching how embeddings behaves.

## Usage

Raw: the existing `usageCapture.passthrough`, which is already keyed by `adapter.protocol` and shared
by every capability. It needs a `typesafe-systemone` arm in the `passthrough-usage` extractors to map
`usage.input_tokens` / `output_tokens` onto `inputTokens` / `outputTokens`. The `assertNever` switches
there make this a compile error until it is written, which is the desired failure mode.

Convert: add `usageCapture.evaluation`, mirroring `usageCapture.embedding`, funnelling into the shared
`finalizeUsage`. Record `inputTokens` and `outputTokens` from `EvaluationResult.usage`, and
`totalTokens` only when both are present and their sum is a safe integer.

`UsageRow` token fields are finite non-negative safe integers. Omit any field whose value is missing,
`NaN`, non-finite, or out of range rather than recording a zero. Unknown usage is not an error: unlike
OpenAI embeddings, the System One response schema marks `usage` and both token fields nullish, so
egress may omit `usage` entirely.

No TTFT, no image counts. Pricing uses the existing input and output token prices when configured.
Note that jev prices input tokens only, which the existing pricing path already handles by leaving an
unconfigured output price at zero.

## Tests

Protect user-visible behavior, not factory literals. Every case below is reachable over HTTP.

Tests live next to the source that owns the behavior, per CLAUDE.md. That means this feature's tests
are spread across five homes, not filed under the core adapter for convenience:

| Home | Covers |
| --- | --- |
| `packages/core/src/protocol/typesafe-systemone/` | parse, model extraction, raw body rewrite, invocation mapping, egress mapping, the error mapper |
| `packages/core/src/provider/` next to `createProviderV4Evaluate` | the SDK boundary: `noul` ↔ `boolean`, `criteria` projection, confidence extraction from `providerMetadata`, `maxRetries: 0`, signal propagation |
| `packages/server/src/server/api-key-auth/` | unauthenticated `/v1/systemone` returns the TypeSafe shape |
| `packages/server/src/routes/pipeline/attempt/` | raw precedence, convert, candidate fallback, credential stripping, traces |
| the config/capability tests | Gateway selection, extra endpoints, cold-start probe, language exclusion |
| `packages/server/src/usage-capture/` + `passthrough-usage/` | evaluation capture and the extractor arm |

Two allocations are easy to get wrong. **Candidate fallback** is not an adapter concern: the adapter can
only test that egress *refuses* a distribution-less result; whether that refusal becomes a fallback is
the attempt layer's behavior, exactly as embedding splits it. And **`providerMetadata` confidence
extraction** cannot be tested through `evaluationJson` at all, because `EvaluationResult` already carries
normalized answers with inline `confidence` — by then the metadata is gone. That belongs next to the
provider wrapper that reads it.

Putting the auth, dispatch, or transport cases in the core adapter file would either invert the
dependency direction or force stubs so local they stop exercising the paths this spec is worried about.

Adapter tests, colocated in `packages/core/src/protocol/typesafe-systemone/`:

- Parse accepts a string, object, and array `state`; all three question types; `criteria` as
  map, as array, and omitted for `noul`.
- Parse rejects: a body that is not valid JSON; a JSON primitive as the whole body; missing or empty
  `model`; missing `questions`; `questions` as an array, string, or `null`; empty `questions`; an
  absent `state` key; a question with missing or `null` `instructions`; `instructions` as a number or
  boolean; unknown `type`; `choice.criteria` missing, an array, or holding a non-string non-null
  value; `score.criteria` missing, not an array, or holding a non-string element; `choice` with 0 and
  with 256 options (255 passes); `score` with 1 and with 11 levels (2 and 10 pass).
- Unknown fields are preserved at every level: a top-level unknown key, an unknown key inside a
  question, and a `noul.criteria` key other than `true` / `false` all parse, survive raw forwarding
  unchanged, and are ignored by convert.
- Content-Type: `application/json` and `application/json; charset=utf-8` are accepted; a missing
  header with a valid JSON body is accepted; `text/plain` with a valid JSON body is 415 in the
  TypeSafe shape.
- Raw rewrite replaces body `model` with the resolved upstream ID and forwards everything else
  unchanged, including an alias and a provider-qualified route.
- Convert egress writes `probabilities` when present, writes `confidence` when present and omits it
  when absent, and never writes `legend`.
- Convert egress **refuses** a choice or score answer lacking `probabilities` rather than emitting an
  envelope missing the field. The adapter owns the refusal only; that the refusal becomes a fallback
  is asserted in the attempt tests, not here.
- Egress omits `usage` when the provider reported none, and writes `input_tokens` / `output_tokens`
  when it did.
- Error bodies use the TypeSafe shape for 400, 404, 413, 415, and 501.

Evaluation attempt tests, in `packages/server/src/routes/pipeline/attempt/`:

- Raw strips caller credentials. The request **must be an anonymously admitted one that still carries
  its credentials** — for example with no caller keys configured. This is not a detail: when a caller
  key matches, the auth middleware already strips both headers and query before the route runs, so an
  end-to-end test using a valid configured key passes every assertion below even if evaluation's own
  stripping were deleted. The unmatched-but-admitted branch is the only one that proves anything.
- Assert provider-key precedence, that a caller `Authorization` cannot override it, that configured
  `headers` win, and that a **query** credential is removed — `withoutCallerCredentialsOnRequest` also
  deletes `x-api-key`, `x-goog-api-key`, `key`, and `auth_token`, so a header-only assertion passes
  against a shortcut that never calls the real helper.
- Exercised through the real evaluation raw path, not `attemptRawCandidate`.
- A distribution-less convert result becomes a fallback to the next candidate, and exhausting
  candidates surfaces the 501.
- A raw 200 whose body carries a distribution-less choice answer is forwarded to the client unchanged,
  proving the success invariant is scoped to convert.
- A raw upstream error returning plain text or HTML is forwarded unchanged, proving the error-shape
  guarantee is likewise scoped.

Dispatch matrix, a new evaluation-specific file next to the embeddings matrix so the language matrix
stays language-only:

| Inbound | Candidate | Expected |
| --- | --- | --- |
| System One | API `typesafe-systemone` raw | raw, not convert |
| System One | AI SDK provider with `evaluationModel` | convert, not raw |
| System One, all `noul` | API `openai-response` (`@ai-sdk/openai`) | convert succeeds |
| System One, contains `choice` | same candidate | 501 + fallback, no distribution |
| System One | API `openai-compatible`, no extra endpoint | not selected: no evaluation transport, no matching raw |
| System One | API `openai-compatible` primary + extra `typesafe-systemone` | raw via the extra endpoint |
| System One | raw 529, second candidate healthy | falls back and succeeds |
| System One | raw 401 | no fallback, error surfaces |
| Chat inbound | evaluation-only candidate | not selected |

Routing test: the exact YAML from Routing and configuration, loaded as config, routes `jev-latest` to
`typesafe-direct` first and falls back to `vercel-gateway` on 529. Building the candidate array by
hand would not catch a missing `models` list, which is the failure this test exists for.

Config-level test for non-TypeSafe convert: an `api` provider with `protocol: openai-response` and a
model listed in `models` is **selected** for an all-`noul` `/v1/systemone` request and converts. This
is the test that proves the discovered evaluation transport reaches the capability filter; without it
the convert path can be materialized and still be unreachable.

Config-level test for the Gateway leg: the documented `vercel-gateway` provider, whose package is
deliberately unclassified and which declares no endpoints, **is selected** for `/v1/systemone` and
converts. This is the regression guard for the capability grant keying on real transports rather than
on the protocol union; under a protocol-union rule this candidate is filtered out and the documented
fallback silently never happens.

Discovery-lifecycle tests, which a preconstructed `hasEvaluationTransport: true` provider would not
exercise:

- A **cold** first evaluation request against a not-yet-loaded package selects the candidate: "not yet
  probed" must not read as unsupported.
- A package that genuinely lacks `evaluationModel`, **and has no matching raw transport**, is not
  selected.
- A package that fails to load or install, **and has no matching raw transport**, produces a candidate
  failure with fallback — not a router miss reporting an unknown model, and not a startup failure.
  With a matching raw endpoint the outcome is raw admission instead.

Composition and ordering tests. These protect the two guarantees the admission table adds, and neither
is implied by the tests above:

| Case | Assertion |
| --- | --- |
| matching raw, convert preparation still pending or already failed | raw succeeds **without waiting** for preparation to settle, and convert is never invoked. Gate the pending case on a controlled deferred promise, never on a latency threshold |
| healthy higher-priority primary, lower-priority backup whose preparation fails first | the primary serves the request and the attempt sequence contains **only** the primary; the backup's prepared failure neither appears as an earlier attempt nor replaces the response |
| higher-priority candidate with a prepared failure, healthy lower-priority backup | the failure is surfaced in the primary's **normal** attempt position, then the backup succeeds |

The third case can sharpen the existing load-failure test rather than duplicate it. The additional-
endpoint test already covers raw eligibility despite a missing resolver, but says nothing about
behavior while preparation is pending or after it fails.

SDK-boundary tests, next to `createProviderV4Evaluate`, driving the real `experimental_evaluate` into a
mock model's `doEvaluate` rather than a stubbed transport:

- A `noul` question reaches the SDK as `boolean`, and a `boolean` answer comes back as
  `{ type: 'noul', noul }`.
- `confidence` is read from `providerMetadata.typesafe.confidence`, keyed by question ID. This cannot
  be tested through `evaluationJson`: by then `EvaluationResult` already carries inline `confidence`
  and the metadata is gone.
- A `noul` question whose `criteria` carries an extra key converts successfully, because convert
  projected it down to `true` / `false`.
- Projection **preserves absence**: an omitted `criteria` stays omitted and a one-sided `{ true: ... }`
  keeps only that key. Materializing both properties with explicit `undefined` values would fail the
  SDK's `isJSON(criteria)` check on input the validator otherwise accepts.
- Valid string, object, and array `state` and `instructions` reach `doEvaluate` with their contents
  intact, proving projection never touches evaluation data.
- No hidden retry: a **retryable non-abort provider failure** produces exactly one `doEvaluate` call
  for that candidate. An abort test cannot establish this — the SDK's retry path checks the abort
  signal before each call, so a missing `maxRetries: 0` would still yield one invocation under abort.
- Signal propagation is asserted separately, as its own case.

Parser and route tests, not SDK-boundary tests: a `state` of `null`, a number, or a boolean returns
400 and **never invokes the transport**; likewise a number that parses to a non-finite value anywhere
in the body, including nested inside `state` (send the literal `1e400`, since `Infinity` is not a JSON
token). These are valuable, but they prove parse rejection, not SDK compatibility — when parsing works
correctly the SDK boundary is never reached.

Config-level negative test: `openai-compatible` primary with an extra `openai-response` endpoint is
**not** selected, because it has no evaluation transport and cannot raw-match. This pins the rule that
a non-System-One extra endpoint grants nothing.

Config-level test for additional endpoints: a provider with `protocol: openai-compatible` **plus** an
`endpoints` entry for `typesafe-systemone` is selected for `/v1/systemone` and served by raw through
that endpoint, while still serving chat on its primary origin. A sibling case asserts the same provider
**without** the extra endpoint is not selected.

Response-model test, asserting the deliberate asymmetry rather than a single rule: with an alias
`public-jev -> jev-latest`, a **convert** response echoes `public-jev`, while a **raw** response is
returned unchanged.

The raw half must actually lock byte-for-byte passthrough, which a field-level assertion does not: an
implementation could parse the upstream JSON, leave `model` alone, re-serialize, and still pass. The
fixture therefore uses deliberately non-canonical upstream text — unusual indentation, non-alphabetical
key order, and an unknown sentinel field — and the test asserts

```ts
expect(await response.text()).toBe(exactUpstreamText);
```

A second fixture omits `model` entirely, proving the proxy does not synthesize the field to satisfy
the convert-path rule.

Inbound auth test: an unauthenticated `POST /v1/systemone` returns 401 in the TypeSafe error shape,
not the default OpenAI shape.

Session test: an evaluation request carrying session-like or previous-response-like headers still
routes by priority and weight only, and commits no response ownership.

Capability tests, written at the behavior level rather than against the package switch:

- A `/v1/systemone` request for a slug served by an `@ai-sdk/typesafe-ai` provider selects it.
- A chat request for that same slug does **not** select it.
- A Gateway provider aliasing that slug **does** also expose it as a language ID, and a chat request
  selecting it fails at invoke and falls back. This asserts the known leak so a future change to it is
  deliberate.
- `supportsEvaluation` gates the pipeline capability filter, so an evaluation request is not filtered
  by language support.

Cancellation tests:

- An aborted inbound request propagates its signal into the evaluation transport.
- A raw passthrough request preserves the inbound signal.
- With `maxRetries: 0`, an abort is not masked by an SDK-internal retry.

Trace tests:

- Raw path records `transport=raw`, `targetProtocol=typesafe-systemone`.
- Convert path records `transport=ai_sdk`, `targetProtocol=undefined`.
- An unsupported candidate records skip reason `evaluation_convert`.
- A raw 529 followed by a successful convert records two attempts, and no hidden third.

Usage tests: valid `input_tokens` / `output_tokens` land on the usage row; a missing `usage` records a
row without token fields rather than zeros; a non-integer or negative count is dropped.

## README

Add one row to the inbound tables in both `README.md` and `README.zh-Hans.md`:

| Protocol or purpose | Method and path |
| --- | --- |
| TypeSafe System One | `POST /v1/systemone` |

## Implementation boundaries

Adding a `ProviderProtocol` value is a public-surface change, not a local one. The full blast radius:

- `packages/types/src/provider-endpoints/provider-endpoints.ts` - the new enum value
- `packages/plugin-sdk/src/runtime.ts` - `'typesafe-systemone'` on the separate `ProtocolId` union and
  `'evaluation'` on the `RawResolver` capability union. No new plugin SDK capability, no
  `ModelCatalog` bucket.
- `packages/server/src/runtime.ts` - the server-internal optional `evaluation` runtime capability
- `packages/core/src/protocol/adapter.ts` - `'evaluation'` on `InboundCapability`, the evaluation
  adapter types, `defineEvaluationProtocolAdapter`, `isEvaluationProtocolAdapter`
- `packages/core/src/protocol/typesafe-systemone/` - adapter, parse, egress, errors, tests
- `packages/core/src/provider/provider-v4.ts` - `createProviderV4Evaluate`; language invoke untouched
- The package-to-primary-protocol classifier currently at `packages/core/src/image-input/` - new arm,
  plus the rename and relocation out of the image module
- `packages/server/src/routes/systemone.ts` - the thin route, and its registration
- `packages/server/src/routes/pipeline/attempt/attempt.ts` - dispatch arm and case
- `packages/server/src/routes/pipeline/attempt/evaluation.ts` - the new attempt function
- `packages/server/src/routes/pipeline/attempt/capability-filter/` - the `evaluation` arm
- `packages/server/src/routes/pipeline/attempt/raw.ts` - caller-credential stripping for evaluation
- `packages/server/src/server/api-key-auth/api-key-auth.ts` - the `/v1/systemone` branch in
  `authenticationError()`
- `packages/server/src/provider-runtime/materialize/` - evaluation transport for `api` and `ai-sdk`
- `packages/server/src/provider-runtime/capability-index/capability-index.ts` - the four changes above
- `packages/server/src/usage-capture/` - `evaluation` capture
- `packages/server/src/passthrough-usage/` - `typesafe-systemone` extractor arms
- The remaining exhaustive `ProviderProtocol` switches: `core/src/provider/api-bridge`,
  `core/src/provider/api`, `server/src/provider-runtime/probe`, `server/src/plugin-runtime`,
  `cli/src/plugin-commands/form/render.ts`
- Generated config JSON schema, regenerated so `protocol: typesafe-systemone` validates for users
- `packages/dashboard` protocol selector and `packages/i18n` labels, per `packages/dashboard/AGENTS.md`
- Root `package.json` catalog: all five bumps (`ai`, `@ai-sdk/provider`, `@ai-sdk/openai`,
  `@ai-sdk/anthropic`, `@ai-sdk/google`), plus each package declaring them `"catalog:"`
- `README.md`, `README.zh-Hans.md`
- A changeset targeting **both** product packages plus every changed internal package, at matching
  bump levels. `aio-proxy` alone is not sufficient: this change edits the plugin SDK's public
  `ProtocolId` and `RawResolver` types, and CLAUDE.md requires `@aio-proxy/plugin-sdk` to be named as
  a product package for SDK-affecting changes, because the `fixed` group's version bump alone produces
  an empty CHANGELOG entry and `scripts/release.ts` then skips its GitHub Release, silently dropping
  the note.

Do not grow the language adapters. Do not teach the language dispatch matrix about `/v1/systemone`.

## Done when

- `POST /v1/systemone` evaluates through an `api` provider declaring `typesafe-systemone`, via raw
- The same works when `typesafe-systemone` is an additional endpoint rather than the primary protocol
- The same request converts through an `ai-sdk` provider exposing `evaluationModel`
- An all-`noul` request is **selected and converts** through an `api` `openai-response` provider,
  proving the capability grant and the capability filter agree; the same request containing a `choice`
  question 501s and falls back
- An `openai-compatible` provider with no extra endpoint is never selected for evaluation; the same
  provider with an extra `typesafe-systemone` endpoint IS selected and serves it by raw
- No convert-generated response body is ever emitted with a choice or score answer missing
  `probabilities`; raw upstream success bodies are forwarded unchanged and are not validated
- Convert responses echo the requested public slug in `model`; raw responses return the upstream body
  unchanged, including its upstream `model`
- The documented direct-primary, Gateway-backup YAML fails over on 429 and 529, and not on 401
- Raw passthrough never forwards caller credentials upstream, exercised through the real evaluation
  raw path rather than `attemptRawCandidate`
- A proxy-level 401 on `/v1/systemone` is TypeSafe-shaped
- A slug served only by `@ai-sdk/typesafe-ai` is not routable as a language model
- Evaluation routing ignores session affinity and response ownership
- Every aio-proxy-generated error and every convert-path error uses the TypeSafe error shape; raw
  upstream error bodies are forwarded unchanged
- Usage records input and output tokens when the upstream or SDK reports valid counts, and records a
  row without token fields when it does not
- Every other inbound protocol behaves as it does today
- `bun run preflight` passes, including everything the five-package AI SDK bump touches
