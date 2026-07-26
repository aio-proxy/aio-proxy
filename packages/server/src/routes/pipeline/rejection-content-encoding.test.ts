import { describe, expect, spyOn, test } from 'bun:test';

import { openAICompletionsAdapter } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';

import { defineProviderRouteSource, REQUESTED_MODEL, rawProvider } from '../../../__tests__/pipeline-helpers';
import { handleProtocolRequest } from './index';

describe('shared protocol pipeline rejection lifecycle content encoding', () => {
  test('finishes a request session when content encoding is unsupported', async () => {
    const sensitiveMarker = 'secret-marker-must-not-be-logged';
    const provider = rawProvider({ id: 'raw' });
    const route = defineProviderRouteSource([provider]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const response = await handleProtocolRequest({
        adapter: openAICompletionsAdapter,
        context: {},
        rawRequest: new Request(`http://localhost/v1/chat/completions?token=${sensitiveMarker}`, {
          method: 'POST',
          headers: { 'content-encoding': 'compress', 'content-type': 'application/json' },
          body: JSON.stringify({ model: REQUESTED_MODEL, messages: [{ role: 'user', content: sensitiveMarker }] }),
        }),
        source: route.source,
      });

      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({
        error: {
          code: 'unsupported_content_encoding',
          message: 'Unsupported Content-Encoding',
          type: 'invalid_request_error',
        },
      });
      expect(route.recording.finals).toEqual([
        { outcome: 'failure', finalStatusCode: 415, errorCode: 'unsupported_content_encoding' },
      ]);
      expect(route.logs).toEqual([
        {
          event: 'request.rejected',
          requestId: 'request-1',
          inboundProtocol: ProviderProtocol.OpenAICompatible,
          path: '/v1/chat/completions',
          statusCode: 415,
          errorCode: 'unsupported_content_encoding',
          errorType: 'UnsupportedContentEncodingError',
        },
      ]);
      expect(JSON.stringify(route.logs)).not.toContain(sensitiveMarker);
      expect(provider.calls.raw).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
