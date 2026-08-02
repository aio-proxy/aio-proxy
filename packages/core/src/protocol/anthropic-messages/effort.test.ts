import { expect, test } from 'bun:test';

import { rewriteAnthropicRawEffort } from './effort';

function anthropicRequest(body: unknown): Request {
  return new Request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('forwards the original body bytes verbatim when neither model nor effort changes', async () => {
  // A value beyond Number.MAX_SAFE_INTEGER would lose precision through a
  // JSON.parse -> JSON.stringify round-trip; the no-op path must not touch it.
  const bigInt = '9007199254740993';
  const bodyText = `{"model":"same","max_tokens":${bigInt},"messages":[{"role":"user","content":"hi"}]}`;
  const raw = new Request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyText,
  });
  const forwarded = await rewriteAnthropicRawEffort(raw, 'same', new Set(['low', 'medium', 'high']));
  expect(await forwarded.text()).toBe(bodyText);
});

test('rewrites the model on the body', async () => {
  const raw = anthropicRequest({ model: 'src', messages: [{ role: 'user', content: 'hi' }] });
  const forwarded = await rewriteAnthropicRawEffort(raw, 'upstream', new Set());
  expect(await forwarded.json()).toMatchObject({ model: 'upstream' });
});

test('clamps output_config.effort against the supported set', async () => {
  const raw = anthropicRequest({
    model: 'src',
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: 'xhigh' },
  });
  const forwarded = await rewriteAnthropicRawEffort(raw, 'upstream', new Set(['low', 'medium', 'high']));
  expect(await forwarded.json()).toMatchObject({ model: 'upstream', output_config: { effort: 'high' } });
});

test('accepts an unsupported effort by forwarding it verbatim when no capability info', async () => {
  const raw = anthropicRequest({
    model: 'src',
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: 'xhigh' },
  });
  const forwarded = await rewriteAnthropicRawEffort(raw, 'upstream', new Set());
  expect(await forwarded.json()).toMatchObject({ model: 'upstream', output_config: { effort: 'xhigh' } });
});
