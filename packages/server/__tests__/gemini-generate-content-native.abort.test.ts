import { afterEach, describe, expect, test } from 'bun:test';

import { AiSdkProviderError } from '@aio-proxy/core';
import type { TextStreamPart, ToolSet } from 'ai';

import {
  AbortStreamError,
  aiSdkProvider,
  appWith,
  createTempHomes,
  generateRequest,
  jsonHeaders,
  postGenerate,
  recorded,
} from './gemini-generate-content.test-support';

const homes = createTempHomes('aio-proxy-gemini-usage-');
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe('POST /v1beta/models/:model::generateContent', () => {
  test.each([false, true])(
    'Given an aborted inbound signal and wrapped AbortError When Gemini stream is %s Then request is cancelled',
    async (stream) => {
      const provider = aiSdkProvider(() => {
        let sent = false;
        return new ReadableStream<TextStreamPart<ToolSet>>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'partial' });
            } else {
              controller.error(new AiSdkProviderError('mock-ai', new AbortStreamError('client closed request')));
            }
          },
        });
      });
      const dbHome = tempHome();
      const app = await appWith(provider, dbHome);
      const abort = new AbortController();
      abort.abort();

      const response = stream
        ? await app.request('/v1beta/models/gemini-2.5-flash:streamGenerateContent', {
            body: JSON.stringify(generateRequest),
            headers: jsonHeaders,
            method: 'POST',
            signal: abort.signal,
          })
        : await app.request('/v1beta/models/gemini-2.5-flash:generateContent', {
            body: JSON.stringify(generateRequest),
            headers: jsonHeaders,
            method: 'POST',
            signal: abort.signal,
          });
      await response.text().catch(() => undefined);

      expect(response.status).toBe(stream ? 200 : 499);
      expect(await recorded(dbHome)).toEqual({
        requests: [
          expect.objectContaining({
            outcome: 'cancelled',
            attempts: [expect.objectContaining({ outcome: 'cancelled' })],
          }),
        ],
        usages: [],
      });
    },
  );

  test.each(['provider rejected', null, { message: 'provider rejected' }])(
    'Given final provider rejects %p When generateContent is posted Then one failed request is recorded',
    async (reason) => {
      const provider = aiSdkProvider(() => new ReadableStream({ pull: (controller) => controller.error(reason) }));
      const dbHome = tempHome();
      const app = await appWith(provider, dbHome);

      const response = await postGenerate(app);

      expect(response.status).toBe(500);
      expect(await recorded(dbHome)).toEqual({
        requests: [
          expect.objectContaining({
            finalProviderId: 'mock-ai',
            outcome: 'failure',
            attempts: [expect.objectContaining({ index: 0, providerId: 'mock-ai', outcome: 'failure' })],
          }),
        ],
        usages: [],
      });
    },
  );
});
