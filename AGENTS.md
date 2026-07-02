# aio-proxy Agent Notes

## Cross-Protocol Routing

Provider selection is model-first:

1. Parse the inbound request enough to get the requested model.
2. Resolve every provider that exposes that model alias, preserving config order.
3. Try candidates in order until one succeeds. Later this can become weighted
   routing; until weights exist, config order is the weight.

For each candidate:

- If the inbound protocol matches an API provider protocol, use raw API
  passthrough.
- Otherwise use an AI SDK invocation path. Convert the inbound protocol request
  into model messages and call the upstream through the AI SDK abstraction. For
  API providers, this means building the matching AI SDK provider from the API
  provider's protocol/base URL/API key metadata for that attempt; for `ai-sdk`
  providers, use the configured package/options directly.
- Raw API providers are never used for cross-protocol transforms directly.
- On provider failure, try the next candidate for the same model. Preserve the
  final failure when no candidate succeeds.

Example for an inbound OpenAI Responses request whose model matches three
providers:

1. `A`: `api` + `openai-compatible` -> protocol mismatch, call through AI SDK
   semantics using an OpenAI-compatible AI SDK adapter; do not raw-passthrough.
2. `B`: `api` + `openai-response` -> protocol match, raw API passthrough.
3. `C`: `ai-sdk` + `@ai-sdk/openai-compatible` -> protocol mismatch handled by
   model-message conversion and AI SDK invocation.

The implementation should therefore keep same-protocol passthrough simple while
moving fallback selection and cross-protocol conversion into shared routing
logic, not duplicating ad hoc conversions in individual route files.
