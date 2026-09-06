---
'@aio-proxy/core': patch
'@aio-proxy/server': patch
'aio-proxy': patch
---

Recover from tool-pairing 400s on the raw passthrough path

When the inbound protocol matches the provider's, an OpenAI Responses request is
forwarded byte-for-byte and the model path's conversion never runs. A transcript
whose `function_call` lost its output — or whose output lost its call — was
therefore still rejected upstream with a terminal 400, with no fallback to any
remaining candidate.

Such a rejection is now recovered the same way `invalid_encrypted_content`
already was: the request is sent unchanged, and only after the upstream names
the pairing failure is it replayed once with the unpaired items narrated as
plain messages — an assistant note for a call nobody answered, a user note for
an output with no call, never a fabricated tool result. Well-formed requests are
byte-identical to before, so upstream prefix caching is untouched.

The replay is limited to the two rejections a pairing repair can actually fix.
`No tool output found for tool call …`, which a strict gateway emits when an
assistant message sits inside a call/output batch, is forwarded unretried.

A narration note is never inserted into a tool batch that is still open — on
either path. Substituting one between a paired call and its output would create
exactly that interleaving, so the note waits until the batch's last result
lands. On the model path the same rule keeps an orphan note from splitting an
assistant tool-call turn from its tool results, which OpenAI-compatible and
Anthropic providers reject. Items the caller sent keep their positions; only the
synthesized notes move.

Adapters that implement `rawRetry` now receive the frame that classified as
`retry` as a fourth argument to `rewrite`, so a hook handling several rejections
repairs only what the upstream objected to.
