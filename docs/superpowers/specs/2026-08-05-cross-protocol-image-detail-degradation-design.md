# Cross-Protocol Image Detail Degradation

## Goal

Allow OpenAI Responses requests containing `input_image.detail` to fall back to non-OpenAI model providers without rejecting an otherwise representable image. Preserve `detail` for same-protocol OpenAI Responses dispatch.

## Behavior

- Raw OpenAI Responses passthrough remains byte-preserving, including `detail`.
- The canonical model invocation continues to retain OpenAI image detail metadata.
- When materializing an invocation for a target other than `openai-response`, remove only the OpenAI `imageDetail` provider option from image file parts.
- Apply the degradation to images in ordinary message content and tool-result content.
- Keep existing failures for image forms that cannot be represented by the target, including incompatible provider references and unsupported assistant/tool image shapes.
- Reuse `warnOpenAIResponsesDegradation('image_detail', path, 'dropped')` when image detail is removed. The path identifies only the canonical message field; do not log image contents or URLs.

## Architecture

Target-specific degradation belongs in the OpenAI Responses adapter's `modelInvocationForTarget` materialization path. This keeps the shared canonical invocation unchanged across candidates: an OpenAI Responses candidate can preserve `detail`, while a later Anthropic or Gemini fallback receives a cloned invocation without that provider-specific option.

The image preflight remains the final compatibility guard. After target materialization removes `imageDetail`, preflight accepts representable user and tool-result images and continues rejecting genuinely incompatible image forms.

## Error Handling

Dropping `detail` is an intentional lossy conversion, matching CLIProxyAPI's behavior. It must not produce a 501. Other `ImageInputUnsupportedError` reasons retain their current protocol-shaped errors and fallback behavior.

## Tests

- A regression test first demonstrates that an OpenAI Responses request containing a base64 `input_image` with `detail: "high"` fails when materialized for Anthropic.
- The fixed assertion verifies that Anthropic materialization keeps the image but removes only `providerOptions.openai.imageDetail`.
- Cover both ordinary message content and tool-result content.
- Verify OpenAI Responses target materialization still preserves `detail`.
- Verify another OpenAI provider option, if present, is not accidentally removed.
- Run the affected core tests, then `bun run preflight` before completion.

## Release Note

This is a user-visible `@aio-proxy/core` fix surfaced through the `aio-proxy` product package, so the changeset targets both packages with patch bumps.
