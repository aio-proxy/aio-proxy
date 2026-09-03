import { describe, expect, test } from 'bun:test';

import { createGeminiRawResolver } from './raw';
import { credentialSource, geminiRequest, logicalContext, resolve, sseResponse } from './raw.test-support';
import { AntigravityTransport } from './transport';

describe('Gemini raw resolver', () => {
  test('returns a transport only for Gemini', () => {
    const resolver = createGeminiRawResolver({ execute: async () => Response.json({ response: {} }) });

    expect(resolve(resolver, 'gemini')).toBeDefined();
    expect(resolve(resolver, 'anthropic')).toBeUndefined();
    expect(resolve(resolver, 'openai-compatible')).toBeUndefined();
    expect(resolve(resolver, 'openai-response')).toBeUndefined();
  });

  test('declines embeddings so convert can run on the same candidate', () => {
    const resolver = createGeminiRawResolver({ execute: async () => Response.json({ response: {} }) });

    expect(resolver({ protocol: 'gemini', modelId: 'gemini-3-flash-agent', capability: 'embedding' })).toBeUndefined();
    expect(resolver({ protocol: 'gemini', modelId: 'gemini-3-flash-agent', capability: 'language' })).toBeDefined();
  });

  test('wraps the rewritten Gemini request and unwraps CCA JSON', async () => {
    let upstream: Request | undefined;
    const resolver = createGeminiRawResolver(
      new AntigravityTransport({
        credentials: credentialSource(),
        fetch: async (input, init) => {
          upstream = new Request(input, init);
          return Response.json({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } });
        },
      }),
      {
        language: [
          {
            id: 'gemini-3-flash-agent',
            extra: { antigravity: { apiProvider: 'gemini', thinkingBudget: 10_000 } },
          },
        ],
        image: [],
        embedding: [],
        speech: [],
        transcription: [],
        reranking: [],
      },
    );
    const transport = resolve(resolver, 'gemini');
    const image = { inlineData: { mimeType: 'image/png', data: 'image-base64-marker' } };
    const request = geminiRequest('generateContent', {
      contents: [{ role: 'user', parts: [image] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH', vendorMarker: true } },
      safetySettings: [{ category: 'unsafe-marker' }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    });

    const response = await transport?.invoke(request, logicalContext());
    const body = (await upstream?.clone().json()) as Record<string, unknown>;

    expect(await response?.json()).toEqual({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    expect(body).toMatchObject({
      model: 'gemini-3-flash-agent',
      request: {
        contents: [{ role: 'user', parts: [image] }],
        generationConfig: {
          thinkingConfig: { vendorMarker: true, thinkingBudget: 10000, includeThoughts: true },
        },
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      },
    });
    expect(JSON.stringify(body)).not.toContain('unsafe-marker');
    expect(upstream?.url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent');
  });

  test('unwraps CCA SSE frames and falls back before the first model frame', async () => {
    const origins: string[] = [];
    const resolver = createGeminiRawResolver(
      new AntigravityTransport({
        credentials: credentialSource(),
        fetch: async (input) => {
          const origin = new URL(String(input)).origin;
          origins.push(origin);
          if (origins.length === 1) {
            return sseResponse(['data: {"error":{"code":503,"message":"no capacity","status":"UNAVAILABLE"}}\n\n']);
          }
          return sseResponse(['data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n']);
        },
      }),
    );

    const response = await resolve(resolver, 'gemini')?.invoke(
      geminiRequest('streamGenerateContent', {}),
      logicalContext(),
    );

    expect(await response?.text()).toBe('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n');
    expect(origins).toEqual([
      'https://daily-cloudcode-pa.googleapis.com',
      'https://daily-cloudcode-pa.sandbox.googleapis.com',
    ]);
  });

  test('never replays after a model stream frame is committed', async () => {
    const origins: string[] = [];
    const resolver = createGeminiRawResolver(
      new AntigravityTransport({
        credentials: credentialSource(),
        fetch: async (input) => {
          origins.push(new URL(String(input)).origin);
          return sseResponse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
            'data: {"error":{"code":503,"message":"late failure","status":"UNAVAILABLE"}}\n\n',
          ]);
        },
      }),
    );

    const response = await resolve(resolver, 'gemini')?.invoke(
      geminiRequest('streamGenerateContent', {}),
      logicalContext(),
    );
    const frames = await response?.text();

    expect(frames).toContain('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}');
    expect(frames).toContain('data: {"error":{"code":503,"message":"late failure","status":"UNAVAILABLE"}}');
    expect(origins).toEqual(['https://daily-cloudcode-pa.googleapis.com']);
  });
});
