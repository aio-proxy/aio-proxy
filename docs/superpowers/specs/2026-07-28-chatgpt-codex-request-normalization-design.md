# ChatGPT Codex Request Normalization

## Goal

Keep the client-facing OpenAI Responses contract while satisfying the stricter ChatGPT Codex subscription endpoint.

## Design

Normalize only requests rewritten by `@aio-proxy/plugin-openai-chatgpt` to the internal Codex `/responses` endpoint:

- Always send `store: false`.
- Convert string `input` to `[{ role: "user", content: input }]`.
- Preserve array `input` and every unrelated request field.
- Leave GET, HEAD, and non-Responses requests unchanged.

The shared OpenAI Responses adapter remains unchanged because public Responses providers may accept string input and have different storage behavior.

## Data Flow

1. aio-proxy selects the ChatGPT OAuth Provider's same-protocol raw capability.
2. The plugin rewrites the URL to `https://chatgpt.com/backend-api/codex/responses`.
3. Before the host fetch, the plugin parses the JSON body and applies the two Codex-specific normalizations.
4. The existing credential and streaming wrappers send the normalized request.

## Error Handling

Only valid JSON request bodies reaching the Responses endpoint are normalized. Parsing failures propagate through the existing request failure path; no fallback or new error format is introduced.

## Test

Update the existing runtime request-capture test to prove the upstream body contains `store: false` and array input when the client sends `store: true` and string input. Existing tests continue to cover URL, headers, signals, and streaming behavior.
