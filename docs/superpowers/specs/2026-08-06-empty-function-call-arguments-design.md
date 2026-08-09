# Empty Function Call Arguments Compatibility

## Goal

Allow cross-protocol OpenAI Responses history from Codex to replay a no-argument `function_call` when it encodes `arguments` as an empty string.

## Behavior

During OpenAI Responses-to-model-message conversion, an exact empty `arguments` string becomes an empty object (`{}`). All non-empty values continue to require valid JSON and retain the existing 400 error on invalid input.

## Scope

Change only the shared function-call argument conversion and add one colocated regression test. Do not change request schemas, provider routing, or raw OpenAI Responses passthrough.

## Verification

The regression test must show that an empty argument string produces an AI SDK tool-call with `{}` input, while the existing malformed-JSON test continues to reject `"{"`.
