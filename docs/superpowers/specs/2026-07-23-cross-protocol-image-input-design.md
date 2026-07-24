# Cross-Protocol Image Input Design

## Goal

Make image inputs remain real visual inputs across OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, and Gemini generateContent routing. This includes images in ordinary user content and images returned by tools.

The change must preserve same-protocol raw passthrough, use the existing AI SDK `ModelMessage` bridge for cross-protocol calls, and never silently drop an image or flatten image bytes into text.

## Original Failure

Request `0bb9a062-ab05-4181-a3d9-1d3df75f52d4` was an OpenAI Responses request containing data-URL `input_image` parts inside `custom_tool_call_output.output`. aio-proxy returned a local `501 unsupported_feature` at `input.79.output.2.type` before contacting the provider.

Two defects contributed:

1. The Responses model conversion accepts image-shaped input at ingress but rejects it while building model messages.
2. The ChatGPT plugin source imports `./runtime` after its runtime moved to `runtime/runtime.ts`. An incremental `--no-clean` build retained an obsolete root `dist/runtime.js` without raw capability, so a same-protocol Responses call incorrectly entered model conversion instead of raw passthrough.

Other ingress paths have the same product-level gap: OpenAI Chat silently removes non-text parts, Anthropic ingress rejects image blocks, and Gemini preserves ordinary `inlineData` but flattens multimodal function responses to JSON text.

## Confirmed Provider Behavior

The pinned AI SDK versions already accept canonical file parts and provide most required egress behavior:

- `@ai-sdk/openai` Responses maps tool-result file parts to `function_call_output` or `custom_tool_call_output` `input_image` parts.
- `@ai-sdk/anthropic` maps them to images inside the matching `tool_result`.
- `@ai-sdk/google` maps them to `functionResponse.parts[].inlineData` for Gemini 3 models. Its legacy path emits adjacent top-level `inlineData`, which remains a visual input.
- `@ai-sdk/openai-compatible` supports file parts in user messages but JSON-stringifies tool-result content.

OpenAI Chat Completions officially permits only strings or text parts in `role: "tool"` content. Following the selected CPA-compatible policy, aio-proxy will nevertheless emit `image_url` parts in the tool message for compatible endpoints that accept this extension. If an endpoint rejects the extension, the candidate fails and routing tries the next provider. aio-proxy will not retry the same candidate after changing the image to a user message.

CLIProxyAPI is used only as wire-format evidence. Its pairwise translators preserve some tool images but JSON-flatten or drop others, so aio-proxy will not copy its pairwise translation architecture.

## Architecture

Same-protocol dispatch remains unchanged:

```text
matching raw capability -> rewrite model/path as today -> raw upstream request
```

Cross-protocol dispatch uses one canonical representation:

```text
Responses / Chat / Anthropic / Gemini ingress
                    |
                    v
          AI SDK ModelMessage file parts
                    |
        +-----------+-----------+-------------+
        |                       |             |
   OpenAI Responses        Anthropic       Gemini
   native SDK mapping   native SDK mapping native SDK mapping
        |
        +-- OpenAI-compatible model fetch -> narrow CPA wire rewrite
```

Each protocol adapter remains responsible for parsing its own wire syntax. Shared validated image constructors handle data URLs, remote URLs, MIME types, and provider references; they do not introduce a generic media framework.

The candidate loop remains the only fallback loop. Candidate-specific image incompatibility is represented by one typed unsupported-input error that the loop maps through the inbound adapter and treats like other fallback-eligible candidate failures.

## Canonical Image Representation

Inline image data becomes an AI SDK file part:

```ts
{
  type: "file",
  mediaType: "image/jpeg",
  data: { type: "data", data: base64 },
}
```

Remote images remain references and are never downloaded by aio-proxy:

```ts
{
  type: "file",
  mediaType: "image/jpeg",
  data: { type: "url", url: new URL(imageUrl) },
}
```

Provider file IDs become tagged provider references. They are usable only by a compatible target provider. A candidate that cannot resolve the reference is skipped rather than receiving the ID as text.

OpenAI image detail is retained in `providerOptions.openai.imageDetail`. Existing tool-call metadata continues to distinguish function and custom tool calls and retain their call IDs.

Tool output containing text and images uses AI SDK content output:

```ts
{
  type: "tool-result",
  toolCallId,
  output: {
    type: "content",
    value: [textPart, imageFilePart],
  },
}
```

Text/image order and multiple images are preserved.

## Ingress Mapping

### OpenAI Responses

- Map message `input_image` parts to canonical file parts.
- Apply the same mapper to `function_call_output.output` and `custom_tool_call_output.output` arrays.
- Preserve data URLs, HTTP(S) URLs, OpenAI file IDs, `detail`, call IDs, and custom/function tool identity.
- Replace the current unsupported-feature rejection for these image parts.

### OpenAI Chat Completions

- Recognize conventional user `image_url` parts instead of filtering all non-text content.
- Recognize `image_url` parts in array-valued `role: "tool"` content and produce a content tool result.
- Preserve string and text-only tool output behavior.

### Anthropic Messages

- Admit user `image` blocks with base64, URL, and supported provider-reference sources.
- Admit the same image blocks inside `tool_result.content`.
- Preserve the existing split between user content and tool-result model messages.

### Gemini generateContent

- Keep the existing `inlineData` conversion and add `fileData` URL conversion.
- Convert `functionResponse.parts` image data into canonical tool-result file parts instead of JSON text.
- Preserve function IDs/names and response text alongside images.

## Target Encoding

OpenAI Responses, Anthropic, and Gemini use their installed AI SDK encoders without project-owned pairwise converters.

OpenAI-compatible tool images require one model-path-only fetch wrapper. The SDK serializes content output as JSON in `role: "tool".content`; the wrapper restores marked image file parts to CPA-style `image_url` content parts immediately before the HTTP request.

Canonical tool image parts carry an internal `providerOptions.aioProxy` marker. The wrapper rewrites only arrays containing this marker, then removes the internal representation from the outgoing body. It must not reinterpret arbitrary JSON tool results that happen to contain objects named `file`.

The wrapper is applied to configured `@ai-sdk/openai-compatible` providers, API providers bridged through that package, and the built-in GitHub Copilot and Kimi Code compatible delegates. Raw API passthrough does not use the wrapper.

## Compatibility Preflight and Fallback

Before starting an AI SDK request, the model transport checks only image representations known to lose visual semantics:

- A remote tool-result URL targeting Gemini is unsupported because Gemini function response parts require inline data.
- A provider reference targeting a different provider/protocol is unsupported.
- A model route whose target protocol cannot be resolved is unsupported only when the input contains a target-dependent image representation, such as a tool-result URL or provider reference, rather than risking silent loss.

Configured providers derive the target from their protocol or AI SDK package. OAuth providers use the existing per-model protocol metadata in their catalog.

The preflight does not maintain a model vision-capability database. A model or endpoint may still reject an otherwise valid image request; that remains a normal provider failure and uses the existing candidate fallback behavior.

## Validation and Security

- Accept inline base64/data URLs and HTTP(S) remote URLs only.
- Reject malformed data URLs, invalid base64, missing image MIME types, and unsupported URL schemes through the inbound protocol's `400` error shape.
- Keep existing request-body limits and Gemini's existing inline-data limit; do not enlarge limits as part of this change.
- Never fetch remote image URLs, avoiding a new SSRF and credential-forwarding surface.
- Diagnostics may record the protocol part type, input path, and reason, but never base64 data, a complete URL, or a provider file ID.
- Never silently drop an image, stringify its bytes as tool text, or report success after sending a nonvisual substitute.

## ChatGPT Plugin Artifact Fix

Change the plugin source import to the explicit runtime entry point so emitted `plugin.js` resolves the current runtime directory entry after both clean and incremental builds. Add one clean-build artifact check that loads the built plugin and verifies the runtime exposes raw capability. This prevents stale root artifacts from changing dispatch semantics.

## Testing

Use one minimal image fixture and behavior-level checks rather than a pairwise protocol matrix:

1. One conversion test per inbound protocol proves ordinary and tool-result images produce canonical file parts while preserving ordering and metadata.
2. Replace the Responses image-returns-501 regression and the OpenAI Chat image-loss expectation with preservation assertions.
3. Capture one outgoing tool-image request per target SDK and assert the native Responses, Anthropic, Gemini, or CPA-compatible wire shape.
4. Add one server cross-protocol integration case proving a mismatched provider receives the canonical image-bearing model message.
5. Add one candidate fallback case for a remote Gemini tool-result URL.
6. Add one OpenAI-compatible rejection/fallback case proving the selected CPA extension does not stop candidate routing.
7. Add the ChatGPT clean-build/runtime-capability artifact check.

OpenAI Chat transform tests currently live in a legacy `_test` directory. Because that module will be materially changed, move its tests next to the source according to repository policy and ensure the package test script discovers them.

Run affected package tests during implementation, followed by `bun run check` and `bun run preflight` before completion.

## Scope

This design covers image inputs only. It does not add generic document, audio, or video conversion; remote media downloading; a model capability registry; same-provider semantic retries; or pairwise protocol translators.

## Acceptance Criteria

- The original Responses custom-tool image shape no longer fails locally with `501`.
- Images in user content and tool results remain visual inputs on every supported target encoding.
- The selected CPA-compatible Chat extension is emitted only on the AI SDK model path, and rejection falls back to another provider.
- Unsupported target/source combinations fail explicitly before silent image loss.
- Same-protocol raw requests remain raw, including the ChatGPT OAuth Responses path.
