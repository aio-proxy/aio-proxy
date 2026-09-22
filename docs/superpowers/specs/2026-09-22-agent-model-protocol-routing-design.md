# Agent model protocol routing

## Goal

Make the model-family to inbound-protocol decision a single, host-neutral runtime rule. Pi and OMP consume that rule immediately; OpenCode and Grok remain outside this implementation until their hosts have a verified per-model protocol mechanism.

## Decision

`@aio-proxy/agent-provider-runtime` owns a pure resolver from a catalog model ID to one of the proxy's ingress protocol identifiers:

- `gpt-*` → `openai-responses`
- `claude-*` → `anthropic-messages`
- `gemini-*` → `google-generative-ai`
- every other ID → `openai-completions`

The resolver is not added to `AgentCatalogV1`. The catalog remains transport-neutral metadata, so existing catalog producers, persisted LKG state, and adapters remain wire-compatible.

Pi and OMP use the resolver while projecting catalog entries to their host `ProviderModelConfig`. The Gemini `/v1beta` base URL stays in the Pi-family adapter because it is a Pi host detail, not a protocol-classification rule.

## Explicit non-goals

- Do not add #398's `--protocol`, preferences sidecar, installation state, or list output.
- Do not add a no-op field to OpenCode models or Grok TOML.
- Do not change the catalog endpoint or its schema version.

## Follow-up gates

OpenCode currently configures one `@ai-sdk/openai-compatible` provider and one OAuth provider ID, so it cannot select a different AI SDK protocol per model while retaining the same authenticated provider identity. Grok currently owns only global endpoint edits; its `api_backend` must be materialized per model, but the current managed flow intentionally has no authenticated catalog materialization endpoint. Each needs a host-specific design and compatibility proof before consuming the runtime resolver.
