import { describe, expect, test } from 'bun:test';

import { geminiModelsRouteTarget } from './gemini-generate-content';

describe('geminiModelsRouteTarget', () => {
  test('Given embedContent suffix When pathname is parsed Then returns embed target', () => {
    expect(geminiModelsRouteTarget('/v1beta/models/m:embedContent')).toEqual({
      kind: 'embed',
      model: 'm',
      action: 'embedContent',
    });
  });

  test('Given batchEmbedContents suffix When pathname is parsed Then returns batch action', () => {
    expect(geminiModelsRouteTarget('/v1beta/models/m:batchEmbedContents')?.action).toBe('batchEmbedContents');
  });

  test('Given unknown action When pathname is parsed Then returns undefined', () => {
    expect(geminiModelsRouteTarget('/v1beta/models/m:unknownAction')).toBeUndefined();
  });

  test('Given generateContent suffix When pathname is parsed Then returns generate target', () => {
    expect(geminiModelsRouteTarget('/v1beta/models/m:generateContent')).toMatchObject({
      kind: 'generate',
      stream: false,
    });
  });

  test('Given empty model after decode When pathname is parsed Then returns undefined', () => {
    expect(geminiModelsRouteTarget('/v1beta/models/:embedContent')).toBeUndefined();
    expect(geminiModelsRouteTarget('/v1beta/models/:batchEmbedContents')).toBeUndefined();
    expect(geminiModelsRouteTarget('/v1beta/models/:generateContent')).toBeUndefined();
    expect(geminiModelsRouteTarget('/v1beta/models/:countTokens')).toBeUndefined();
  });
});
