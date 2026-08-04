# OpenAI Responses CPA Compatibility Design

## Goal

Make the OpenAI Responses model path accept Codex's top-level `instructions`
and hosted `web_search` tool in the same practical way as CLIProxyAPI's
Responses-to-Chat conversion.

## Decision

- Same-protocol OpenAI Responses candidates continue to use raw passthrough.
  Their request body, including `instructions` and `web_search`, is unchanged.
- Cross-protocol model candidates convert a string `instructions` field into a
  leading system message.
- Cross-protocol model candidates recognize the built-in `web_search` tool and
  omit it from the generic model ToolSet. It is not recast as a function tool
  and no proxy-side search is executed.
- Other unsupported hosted tools remain unsupported. This change is narrowly
  scoped to the Codex request shape captured in trace
  `ae7dcdc76ef2c05f9b384c397ceb97f4`.

This matches CLIProxyAPI's generic Responses-to-Chat behavior: it maps
`instructions` to a system message and only converts function/custom/namespace
tools; built-in hosted tools are not turned into Chat functions.

## Data Flow

1. Parse OpenAI Responses request while preserving raw passthrough behavior.
2. For a model invocation, prepend `instructions` as a system message.
3. Exclude the recognized hosted `web_search` declaration from the generated
   model ToolSet.
4. Invoke the selected cross-protocol model with the remaining messages and
   tools.

## Non-goals

- Do not disable Codex web search globally or change the `/v1/models` response.
- Do not claim that Kimi executed a web search.
- Do not add a proxy-owned search backend, a Kimi-specific search adapter, or
  conversion for other hosted tools.
- Do not alter raw same-protocol forwarding or Responses state semantics.

## Error Handling

- `instructions` remains invalid when it is not a string.
- Unknown hosted tools continue to produce the existing unsupported-feature
  behavior on the model path.
- A raw OpenAI Responses candidate still receives the original request and can
  execute any hosted tool it natively supports.

## Verification

- A model-path transform with `instructions` produces a leading system message.
- A model-path transform with `tools: [{ type: "web_search" }]` succeeds and
  exposes no normal function tool.
- An unknown hosted tool continues to fail as unsupported.
- Existing raw Responses behavior remains covered by its integration tests.
