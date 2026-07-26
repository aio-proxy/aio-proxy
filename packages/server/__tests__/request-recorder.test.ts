import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRequestLogStore, openDb, requestLog, usage } from '@aio-proxy/core/db';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createRequestRecorder } from '../src/request-recorder';

const homes: string[] = [];
const fixedNow = new Date('2026-07-11T08:00:00.000Z');

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-request-recorder-'));
  homes.push(home);
  return home;
}

describe('request recorder', () => {
  test('records one request with failed fallback and one successful final usage row', () => {
    const handle = openDb({ home: tempHome() });
    const recorder = createRequestRecorder({
      store: createRequestLogStore(handle.db),
      now: () => fixedNow,
    });
    const request = recorder.begin({
      inboundProtocol: 'openai-compatible',
      requestedModelId: 'mini',
    });

    request.attempt({
      providerId: 'primary',
      modelId: 'gpt-5',
      providerKind: ProviderKind.Api,
      protocol: ProviderProtocol.OpenAICompatible,
      outcome: 'failure',
      statusCode: 429,
      durationMs: 10,
    });
    request.finish({
      outcome: 'success',
      finalProviderId: 'backup',
      finalModelId: 'openai/gpt-5',
      finalStatusCode: 200,
      attempt: {
        providerId: 'backup',
        modelId: 'openai/gpt-5',
        providerKind: ProviderKind.Api,
        protocol: ProviderProtocol.OpenAICompatible,
        outcome: 'success',
        statusCode: 200,
        durationMs: 20,
      },
      usage: {
        providerId: 'backup',
        modelId: 'openai/gpt-5',
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
      },
    });

    expect(handle.db.select().from(requestLog).all()).toEqual([
      expect.objectContaining({
        requestId: request.requestId,
        outcome: 'success',
        finalProviderId: 'backup',
        finalModelId: 'openai/gpt-5',
        attempts: [
          expect.objectContaining({ providerId: 'primary', index: 0, outcome: 'failure' }),
          expect.objectContaining({ providerId: 'backup', index: 1, outcome: 'success' }),
        ],
      }),
    ]);
    expect(handle.db.select().from(usage).all()).toEqual([
      expect.objectContaining({ requestId: request.requestId, inputTokens: 4, outputTokens: 6 }),
    ]);
    handle.close();
  });

  test.each(['failure', 'cancelled'] as const)('a %s request inserts no usage', (outcome) => {
    const handle = openDb({ home: tempHome() });
    const request = createRequestRecorder({
      store: createRequestLogStore(handle.db),
      now: () => fixedNow,
    }).begin({ inboundProtocol: 'anthropic', requestedModelId: 'mini' });

    request.finish({ outcome });

    expect(handle.db.select().from(requestLog).all()).toEqual([expect.objectContaining({ outcome })]);
    expect(handle.db.select().from(usage).all()).toEqual([]);
    handle.close();
  });

  test('calling finish twice inserts once', () => {
    const handle = openDb({ home: tempHome() });
    const request = createRequestRecorder({
      store: createRequestLogStore(handle.db),
      now: () => fixedNow,
    }).begin({ inboundProtocol: 'gemini', requestedModelId: 'mini' });

    request.finish({ outcome: 'failure', errorCode: 'first' });
    request.finish({ outcome: 'success', finalProviderId: 'late', finalModelId: 'late' });

    expect(handle.db.select().from(requestLog).all()).toEqual([
      expect.objectContaining({ outcome: 'failure', errorCode: 'first' }),
    ]);
    handle.close();
  });
});
