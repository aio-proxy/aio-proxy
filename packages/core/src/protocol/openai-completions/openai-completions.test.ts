import { expect, test } from 'bun:test';

import { parseOpenAICompletions } from '../../ingress/openai-completions';
import { rewriteOpenAICompletionsRaw } from './completions-raw';
import { openAICompletionsAdapter } from './openai-completions';

test('maps service_tier onto the speed axis', async () => {
  await expect(dimensions({ service_tier: 'priority' })).resolves.toEqual({ speed: 'fast' });
  await expect(dimensions({ service_tier: 'fast' })).resolves.toEqual({ speed: 'fast' });
  await expect(dimensions({ service_tier: 'flex' })).resolves.toEqual({ speed: 'flex' });
});

test('keeps service_tier off the speed axis when it is not a speed tier', async () => {
  await expect(dimensions({ service_tier: 'auto' })).resolves.toEqual({});
  await expect(dimensions({ service_tier: 'default' })).resolves.toEqual({});
  await expect(dimensions({ speed: 'fast' })).resolves.toEqual({});
});

test('maps service_tier alongside reasoning_effort', async () => {
  await expect(dimensions({ reasoning_effort: 'high', service_tier: 'priority' })).resolves.toEqual({
    effort: 'high',
    speed: 'fast',
  });
});

async function dimensions(extra: Record<string, unknown>) {
  const raw = new Request('https://x/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'alias',
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    }),
  });
  return openAICompletionsAdapter.dimensions(await openAICompletionsAdapter.parse(raw, {}), {});
}

test('clamps reasoning_effort in the raw body against the supported set', async () => {
  const body = { model: 'src', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'xhigh' };
  const raw = new Request('https://x/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  const parsed = parseOpenAICompletions(structuredClone(body));
  const forwarded = await openAICompletionsAdapter.rawRequest(
    raw,
    parsed,
    'upstream',
    new Set(['low', 'medium', 'high']),
    {},
  );
  expect(await forwarded.json()).toMatchObject({ model: 'upstream', reasoning_effort: 'high' });
});

test('rewrites the model on the raw body when no reasoning_effort is present', async () => {
  const body = { model: 'src', messages: [{ role: 'user', content: 'hi' }] };
  const raw = new Request('https://x/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  const parsed = parseOpenAICompletions(structuredClone(body));
  const forwarded = await openAICompletionsAdapter.rawRequest(
    raw,
    parsed,
    'upstream',
    new Set(['low', 'medium', 'high']),
    {},
  );
  const json = (await forwarded.json()) as Record<string, unknown>;
  expect(json).toMatchObject({ model: 'upstream' });
  expect('reasoning_effort' in json).toBe(false);
});

test('accepts non-enum reasoning_effort values (e.g. max) and clamps them', async () => {
  // The completions ingress must not gate reasoning_effort to a fixed enum:
  // `max` and future/alias levels have to reach normalization rather than be
  // rejected at parse time.
  const body = { model: 'src', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'max' };
  const raw = new Request('https://x/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  const parsed = parseOpenAICompletions(structuredClone(body));
  expect(parsed.reasoning_effort).toBe('max');
  const forwarded = await openAICompletionsAdapter.rawRequest(
    raw,
    parsed,
    'upstream',
    new Set(['low', 'medium', 'high']),
    {},
  );
  expect(await forwarded.json()).toMatchObject({ model: 'upstream', reasoning_effort: 'high' });
});

test('clamps settings.reasoning through modelInvocationForTarget', () => {
  const body = { model: 'src', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'xhigh' };
  const parsed = parseOpenAICompletions(structuredClone(body));
  const invocation = openAICompletionsAdapter.modelInvocation(parsed, {});
  const clamped = openAICompletionsAdapter.modelInvocationForTarget(
    invocation,
    undefined,
    new Set(['low', 'medium', 'high']),
  );
  expect(clamped.settings?.reasoning).toBe('high');
});

test('forwards the original body bytes verbatim when model and effort are unchanged', async () => {
  // A same-model request whose effort is absent (or already supported) must not
  // be round-tripped through JSON, which would truncate integers beyond
  // Number.MAX_SAFE_INTEGER and drop the client's exact byte representation.
  const bodyText = '{"model":"upstream","seed":9007199254740993,"messages":[{"role":"user","content":"hi"}]}';
  const raw = new Request('https://x/v1/chat/completions', { method: 'POST', body: bodyText });
  const parsed = parseOpenAICompletions(JSON.parse(bodyText));
  const forwarded = await openAICompletionsAdapter.rawRequest(
    raw,
    parsed,
    'upstream',
    new Set(['low', 'medium', 'high']),
    {},
  );
  expect(await forwarded.text()).toBe(bodyText);
});

test('legacy Completions raw keeps omitted and null prompt bytes', async () => {
  const omitted = '{"model":"upstream","seed":9007199254740993}';
  const forwarded = await rewriteOpenAICompletionsRaw(
    new Request('https://x/v1/completions', { method: 'POST', body: omitted }),
    'upstream',
    new Set(['low', 'medium', 'high']),
  );
  expect(await forwarded.text()).toBe(omitted);
  expect(forwarded.url).toContain('/v1/completions');

  const nullable = '{"model":"src","prompt":null}';
  const rewritten = await rewriteOpenAICompletionsRaw(
    new Request('https://x/v1/completions', { method: 'POST', body: nullable }),
    'davinci',
    new Set(),
  );
  expect(await rewritten.json()).toEqual({ model: 'davinci', prompt: null });
});
