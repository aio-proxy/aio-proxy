import { describe, expect, test } from 'bun:test';

import { parseGeminiGenerateContent } from '../ingress/gemini-generate-content/index';
import { geminiGenerateContentAdapter } from './gemini-generate-content';

function geminiRequest(body: unknown): Request {
  return new Request('https://x/v1beta/models/src:generateContent', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('geminiGenerateContentAdapter.rawRequest', () => {
  test('clamps thinkingLevel in the raw body against the supported set', async () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'xhigh' } },
    };
    const raw = geminiRequest(body);
    const parsed = parseGeminiGenerateContent(structuredClone({ ...body, model: 'src' }));
    const forwarded = await geminiGenerateContentAdapter.rawRequest(
      raw,
      parsed,
      'upstream',
      new Set(['low', 'medium', 'high']),
      { model: 'src', stream: false },
    );
    expect(await forwarded.json()).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
    });
    expect(new URL(forwarded.url).pathname).toContain('upstream');
  });

  test('rewrites the URL to the resolved model for non-streaming requests', async () => {
    const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    const raw = geminiRequest(body);
    const parsed = parseGeminiGenerateContent(structuredClone({ ...body, model: 'src' }));
    const forwarded = await geminiGenerateContentAdapter.rawRequest(raw, parsed, 'upstream', new Set(), {
      model: 'src',
      stream: false,
    });
    expect(new URL(forwarded.url).pathname).toBe('/v1beta/models/upstream:generateContent');
  });

  test('rewrites the URL for streaming requests using the context stream flag', async () => {
    const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    const raw = geminiRequest(body);
    const parsed = parseGeminiGenerateContent(structuredClone({ ...body, model: 'src' }));
    const forwarded = await geminiGenerateContentAdapter.rawRequest(raw, parsed, 'upstream', new Set(), {
      model: 'src',
      stream: true,
    });
    expect(new URL(forwarded.url).pathname).toBe('/v1beta/models/upstream:streamGenerateContent');
  });

  test('passes thinkingLevel through unchanged when the level is already supported', async () => {
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
    };
    const raw = geminiRequest(body);
    const parsed = parseGeminiGenerateContent(structuredClone({ ...body, model: 'src' }));
    const forwarded = await geminiGenerateContentAdapter.rawRequest(
      raw,
      parsed,
      'upstream',
      new Set(['low', 'medium', 'high']),
      { model: 'src', stream: false },
    );
    expect(await forwarded.json()).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
    });
  });
});

describe('geminiGenerateContentAdapter.modelInvocationForTarget', () => {
  test('clamps settings.reasoning against the supported set', () => {
    const invocation = { messages: [], settings: { reasoning: 'xhigh' as const } };
    const result = geminiGenerateContentAdapter.modelInvocationForTarget(
      invocation,
      undefined,
      new Set(['low', 'medium', 'high']),
    );
    expect(result.settings?.reasoning).toBe('high');
  });

  test('is identity when reasoning is already supported', () => {
    const invocation = { messages: [], settings: { reasoning: 'medium' as const } };
    const result = geminiGenerateContentAdapter.modelInvocationForTarget(
      invocation,
      undefined,
      new Set(['low', 'medium', 'high']),
    );
    expect(result).toBe(invocation);
  });
});
