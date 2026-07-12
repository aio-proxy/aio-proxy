# Protocol Egress Metadata and Official SDK Types Design

## Goal

Make cross-protocol responses preserve upstream response metadata when it is available, generate unique fallback identifiers when it is not, and validate every emitted protocol object against the official provider SDK types.

## Current Problem

The Anthropic and OpenAI Responses writers use module-level placeholder identifiers. Anthropic also reports `aio-proxy` as the model. OpenAI Chat Completions already generates a unique identifier but omits required official response fields. Gemini omits `responseId` and `modelVersion` entirely.

The AI SDK transport already emits a `finish-step` part containing `response.id`, `response.modelId`, and `response.timestamp`. The current egress writers ignore that event. Streaming writers must emit their first protocol event before `finish-step` arrives, so they cannot generally reuse that late upstream identifier.

## Metadata Rules

Follow the same policy used by CLIProxyAPI and the other reference proxies:

1. Reuse upstream response metadata when it is available before the response object is finalized.
2. Otherwise generate one unique identifier per response.
3. Keep a generated identifier stable across every event and nested reference within one streamed response.
4. Never expose a fixed proxy-wide identifier or the placeholder model name `aio-proxy`.

For non-streaming AI SDK conversion, the writer consumes the complete stream and prefers `finish-step.response.id`, `modelId`, and `timestamp`. If `finish-step` is absent, it uses a locally generated identifier and the resolved candidate model.

For streaming AI SDK conversion, the writer generates the protocol identifiers before emitting the first event. It uses the resolved candidate model supplied by the routing pipeline. A late `finish-step` may supply usage and other terminal metadata, but it must not change identifiers already sent to the client.

## Interface Design

Add a small `ModelEgressContext` at the existing protocol adapter seam. It contains the resolved model identifier for the selected candidate. `ProtocolAdapter.modelJson` and `ProtocolAdapter.modelSse` receive this context together with the model event stream.

The pipeline constructs the context only after selecting a model-capable candidate. Provider invocation remains unchanged and continues returning the native AI SDK `TextStreamPart` stream. This keeps metadata interpretation inside protocol egress, where protocol-specific identifier formats and required fields belong.

No private stream event or new provider result wrapper will be introduced.

## Official SDK Types

`@aio-proxy/core` will depend on the official protocol SDKs:

- `@anthropic-ai/sdk` for `Message`, `Usage`, content blocks, and `RawMessageStreamEvent`.
- `openai` for `ChatCompletion`, `ChatCompletionChunk`, `Response`, and `ResponseStreamEvent`.
- `@google/genai` for `GenerateContentResponse`, `Candidate`, `Content`, `Part`, and usage metadata.

Writers will return complete official response types and construct streaming events through typed helpers using the official event unions. The implementation will add all required fields rather than weakening the SDK types with `Partial` or broad local DTOs.

For Gemini, `GenerateContentResponse` is a class with convenience getters. The wire response will use its serializable official fields and official nested types; it will not attempt to instantiate the SDK client response class or serialize its getters.

## Protocol Behavior

### Anthropic Messages

- Non-streaming response ID: upstream `finish-step.response.id`, otherwise `msg_<unique>`.
- Streaming message ID: `msg_<unique>` generated once before `message_start`.
- Model: upstream `finish-step.response.modelId` for non-streaming, resolved candidate model for streaming/fallback.
- Emit complete official `Message` and `RawMessageStreamEvent` shapes, including required usage and terminal fields.

### OpenAI Chat Completions

- Preserve the current unique `chatcmpl-<uuid>` fallback behavior for streaming.
- Prefer upstream finish-step metadata for non-streaming.
- Add required `created`, `model`, choice, message, and chunk fields from the official SDK types.

### OpenAI Responses

- Non-streaming response ID: upstream `finish-step.response.id`, otherwise `resp_<unique>`.
- Streaming response ID: `resp_<unique>` generated once.
- Generate unique message and reasoning item IDs derived for the response lifetime.
- Emit complete official `Response` and `ResponseStreamEvent` structures, including sequence numbers and cross-event item identifiers.

### Gemini GenerateContent

- Non-streaming `responseId` and `modelVersion`: prefer finish-step response metadata, with a unique local response ID and resolved model fallback.
- Streaming: generate one response ID and use the resolved model in every chunk.
- Use official candidate, content, part, finish reason, and usage metadata types.

## Error and Compatibility Behavior

Existing provider fallback, cancellation, and error mapping remain unchanged. Identifier generation uses `crypto.randomUUID()` and requires no new runtime helper. The SDK dependencies are type sources; all imports from them in egress code are type-only.

Because exported core functions expose official response types in generated declarations, the SDK packages are regular core dependencies rather than undeclared or development-only dependencies.

## Testing

Tests will be changed before production code and observed failing for the missing behavior. Coverage will verify:

- two independent responses never share fallback IDs;
- every event within one stream uses consistent IDs;
- non-streaming writers reuse `finish-step.response.id/modelId/timestamp`;
- streaming writers use the resolved model and never expose `aio-proxy`;
- OpenAI Responses item IDs and event references match;
- Gemini includes `responseId` and `modelVersion`;
- emitted JSON and event payloads satisfy the official SDK response/event types at compile time;
- existing fallback, usage, tool-call, and cancellation tests remain green.

