import { expect, test } from 'bun:test';

import { OpenAIResponsesUnsupportedFeatureError } from '../error';
import { openAIResponsesErrors } from './errors';
import { openAIResponsesAdapter } from './openai-responses';

const compactCtx = { operation: 'compact' } as const;

function compactRequest(body: Record<string, unknown>) {
  return openAIResponsesAdapter.parse(
    new Request('https://proxy.test/v1/responses/compact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    compactCtx,
  );
}

test('compact wantsStream is always false and stream true 400s before model()', async () => {
  await expect(compactRequest({ model: 'gpt-5.1-codex-max', stream: true })).rejects.toBeDefined();
  const parsed = await compactRequest({ model: 'gpt-5.1-codex-max', stream: false });
  expect(openAIResponsesAdapter.wantsStream(parsed, compactCtx)).toBe(false);
  expect(openAIResponsesAdapter.model(parsed, compactCtx)).toBe('gpt-5.1-codex-max');
});

test('compact optional nulls do not enter session or dimensions', async () => {
  const parsed = await compactRequest({
    model: 'gpt-5.1-codex-max',
    previous_response_id: null,
    prompt_cache_key: null,
    service_tier: null,
    background: true,
  });
  expect(openAIResponsesAdapter.session?.(parsed, compactCtx)).toMatchObject({
    candidates: [],
  });
  expect(openAIResponsesAdapter.session?.(parsed, compactCtx)?.previousResponseId).toBeUndefined();
  expect(openAIResponsesAdapter.dimensions(parsed, compactCtx)).toEqual({});
  expect(openAIResponsesAdapter.requestDiagnostics(parsed, compactCtx)).toEqual([]);
});

test('compact modelInvocation is 501 responses_compact', async () => {
  const parsed = await compactRequest({ model: 'gpt-5.1-codex-max' });
  expect(() => openAIResponsesAdapter.modelInvocation(parsed, compactCtx)).toThrow(
    new OpenAIResponsesUnsupportedFeatureError('responses_compact', 'POST /v1/responses/compact'),
  );
  try {
    openAIResponsesAdapter.modelInvocation(parsed, compactCtx);
  } catch (error) {
    expect(openAIResponsesErrors.modelUnsupported?.(error)?.status).toBe(501);
  }
});

test('compact raw no-op forwards original decoded bytes including a large integer', async () => {
  const bodyText =
    '{"model":"gpt-5.1-codex-max","seed":9007199254740993,"previous_response_id":null,"background":true,"reasoning":{"effort":"xhigh"}}';
  const raw = new Request('https://proxy.test/v1/responses/compact', { method: 'POST', body: bodyText });
  const parsed = await openAIResponsesAdapter.parse(raw, compactCtx);
  const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, 'gpt-5.1-codex-max', new Set(), compactCtx);
  expect(await forwarded.text()).toBe(bodyText);
  expect(new URL(forwarded.url).pathname).toBe('/v1/responses/compact');
});

test('compact raw strips leftover stream and rewrites model only then', async () => {
  const raw = new Request('https://proxy.test/v1/responses/compact', {
    method: 'POST',
    body: JSON.stringify({
      model: 'src',
      stream: false,
      input: null,
      background: true,
      reasoning: { effort: 'xhigh' },
    }),
  });
  const parsed = await openAIResponsesAdapter.parse(raw, compactCtx);
  const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, 'upstream', new Set(['low']), compactCtx);
  expect(await forwarded.json()).toEqual({
    model: 'upstream',
    input: null,
    background: true,
    reasoning: { effort: 'xhigh' },
  });
});
