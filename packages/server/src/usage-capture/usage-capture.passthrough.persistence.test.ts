import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRequestLogStore, openDb, requestLog, usage } from '@aio-proxy/core/db';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createRequestRecorder } from '../request-recorder';
import { createUsageCapture } from './index';
import { settle } from './test-support';

const homes: string[] = [];
const fixedNow = new Date('2026-07-11T08:00:00.000Z');

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-usage-capture-'));
  homes.push(home);
  return home;
}

describe('usage capture passthrough persistence', () => {
  test('empty or unparseable passthrough usage does not create a usage row', async () => {
    for (const body of [JSON.stringify({ usage: {} }), 'data: {not-json}\n\n']) {
      const handle = openDb({ home: tempHome() });
      const recorder = createRequestRecorder({ store: createRequestLogStore(handle.db), now: () => fixedNow });
      const session = recorder.begin({ inboundProtocol: 'openai-compatible', requestedModelId: 'mini' });
      const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
        response: new Response(body),
        protocol: ProviderProtocol.OpenAICompatible,
        providerId: 'provider',
        modelId: 'model',
      });
      session.finishFrom(
        {
          providerId: 'provider',
          modelId: 'model',
          providerKind: ProviderKind.Api,
          protocol: ProviderProtocol.OpenAICompatible,
          durationMs: 1,
        },
        captured.completion,
      );

      await captured.value.text();
      await captured.completion;
      await settle();

      expect(handle.db.select().from(requestLog).all()).toHaveLength(1);
      expect(handle.db.select().from(usage).all()).toEqual([]);
      handle.close();
    }
  });
});
