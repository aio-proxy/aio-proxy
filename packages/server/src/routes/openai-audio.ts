import { openAISpeechAdapter, openAITranscriptionAdapter } from '@aio-proxy/core';
import { Hono } from 'hono';

import type { ProviderRouteSource } from '../runtime';
import { handleProtocolRequest } from './pipeline';

// Transcriptions and translations share one adapter: the two ports differ only in
// the operation, which is what makes translations refuse the convert path.
export function createOpenAIAudioRoutes(source: ProviderRouteSource) {
  return new Hono()
    .post('/v1/audio/speech', (context) =>
      handleProtocolRequest({
        adapter: openAISpeechAdapter,
        context: { operation: 'speech' },
        rawRequest: context.req.raw,
        source,
      }),
    )
    .post('/v1/audio/transcriptions', (context) =>
      handleProtocolRequest({
        adapter: openAITranscriptionAdapter,
        context: { operation: 'transcriptions' },
        rawRequest: context.req.raw,
        source,
      }),
    )
    .post('/v1/audio/translations', (context) =>
      handleProtocolRequest({
        adapter: openAITranscriptionAdapter,
        context: { operation: 'translations' },
        rawRequest: context.req.raw,
        source,
      }),
    );
}
