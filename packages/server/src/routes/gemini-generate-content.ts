import { geminiEmbeddingsAdapter, geminiGenerateContentAdapter } from '@aio-proxy/core';
import { Hono } from 'hono';

import type { ProviderRouteSource } from '../runtime';
import { handleProtocolRequest } from './pipeline';
import { handleTokenCount } from './token-count';

const routePrefix = '/v1beta/models/';
const generateSuffix = ':generateContent';
const streamSuffix = ':streamGenerateContent';
const countSuffix = ':countTokens';
const embedContentSuffix = ':embedContent';
const batchEmbedContentsSuffix = ':batchEmbedContents';

export type GeminiModelsRouteTarget =
  | { readonly kind: 'generate'; readonly model: string; readonly stream: boolean }
  | { readonly kind: 'count'; readonly model: string }
  | { readonly kind: 'embed'; readonly model: string; readonly action: 'embedContent' | 'batchEmbedContents' };

export function createGeminiGenerateContentRoutes(source: ProviderRouteSource) {
  return new Hono().post('/v1beta/models/*', async (context) => {
    const target = geminiModelsRouteTarget(new URL(context.req.url).pathname);
    if (target === undefined) {
      return context.text('404 Not Found', 404);
    }
    if (target.kind === 'count') {
      return handleTokenCount({
        adapter: geminiGenerateContentAdapter,
        context: { model: target.model, stream: false },
        format: (inputTokens) => ({ totalTokens: inputTokens }),
        rawRequest: context.req.raw,
        source,
      });
    }
    if (target.kind === 'embed') {
      return handleProtocolRequest({
        adapter: geminiEmbeddingsAdapter,
        context: { model: target.model, action: target.action },
        rawRequest: context.req.raw,
        source,
      });
    }
    return handleProtocolRequest({
      adapter: geminiGenerateContentAdapter,
      context: { model: target.model, stream: target.stream },
      rawRequest: context.req.raw,
      source,
    });
  });
}

export function geminiModelsRouteTarget(pathname: string): GeminiModelsRouteTarget | undefined {
  if (!pathname.startsWith(routePrefix)) {
    return undefined;
  }

  const value = pathname.slice(routePrefix.length);
  if (value.endsWith(streamSuffix)) {
    const model = decodeURIComponent(value.slice(0, -streamSuffix.length));
    return model === '' ? undefined : { kind: 'generate', model, stream: true };
  }

  if (value.endsWith(generateSuffix)) {
    const model = decodeURIComponent(value.slice(0, -generateSuffix.length));
    return model === '' ? undefined : { kind: 'generate', model, stream: false };
  }

  if (value.endsWith(countSuffix)) {
    const model = decodeURIComponent(value.slice(0, -countSuffix.length));
    return model === '' ? undefined : { kind: 'count', model };
  }

  if (value.endsWith(embedContentSuffix)) {
    const model = decodeURIComponent(value.slice(0, -embedContentSuffix.length));
    return model === '' ? undefined : { kind: 'embed', model, action: 'embedContent' };
  }

  if (value.endsWith(batchEmbedContentsSuffix)) {
    const model = decodeURIComponent(value.slice(0, -batchEmbedContentsSuffix.length));
    return model === '' ? undefined : { kind: 'embed', model, action: 'batchEmbedContents' };
  }

  return undefined;
}
