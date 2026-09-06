---
'@aio-proxy/core': patch
'aio-proxy': patch
---

Accept OpenAI Responses requests whose tool calls and outputs lost their pairing

Context compaction can truncate a conversation between a `function_call` and its
`function_call_output`, leaving one side without the other. Codex produces this
legitimately, but the model path rejected an unmatched output with a terminal 400
that also skipped every remaining provider candidate, and emitted an unmatched
call in a shape upstreams refuse.

Both sides are now carried through instead of failing. An output with no call
becomes a user note that preserves its text and images; a call with no output
becomes an assistant note naming the tool and its arguments verbatim. Neither
fabricates a tool result the caller did not send, and the notes are byte-stable
across turns so upstream prefix caching still hits. A `request.feature_downgraded`
entry records each conversion.
