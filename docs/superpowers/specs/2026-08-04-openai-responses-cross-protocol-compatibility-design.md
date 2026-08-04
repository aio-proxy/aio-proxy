# OpenAI Responses Cross-Protocol Compatibility Design

## Goal

Make the OpenAI Responses model path accept a top-level `instructions` field
and hosted `web_search` tool when routing across protocols.

## Decision

- Same-protocol OpenAI Responses candidates continue to use raw passthrough.
  Their request body, including `instructions` and `web_search`, is unchanged.
- Cross-protocol model candidates convert a string `instructions` field into a
  leading system message.
- Cross-protocol model candidates recognize the built-in `web_search` tool and
  omit it from the generic model ToolSet. It is not recast as a function tool
  and no proxy-side search is executed.
- Other unsupported hosted tools remain unsupported. This change is narrowly
  scoped to the request shape captured in trace
  `ae7dcdc76ef2c05f9b384c397ceb97f4`.

## Data Flow

1. Parse OpenAI Responses request while preserving raw passthrough behavior.
2. For a model invocation, prepend `instructions` as a system message.
3. Exclude the recognized hosted `web_search` declaration from the generated
   model ToolSet.
4. Invoke the selected cross-protocol model with the remaining messages and
   tools.

## Non-goals

- Do not disable hosted web search globally or change the `/v1/models` response.
- Do not represent an omitted hosted tool as a successful proxy-side search.
- Do not add a proxy-owned search backend, a provider-specific search adapter, or
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
