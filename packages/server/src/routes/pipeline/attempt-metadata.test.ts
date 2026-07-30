import { expect, test } from 'bun:test';

import { openAIResponsesAdapter } from '@aio-proxy/core';
import { ConfigSchema, type Config, ProviderProtocol } from '@aio-proxy/types';

import {
  defineProviderRouteSource,
  modelProvider,
  rawProvider,
  REQUESTED_MODEL,
  settleRecording,
  textStream,
  withSnapshotConfigs,
} from '../../../__tests__/pipeline-helpers';
import { LogicalSessionStore } from '../../logical-session-store';
import type { ProviderRouteSource } from '../../runtime';
import { handleProtocolRequest } from './index';

test('records raw attempt metadata from the acquired snapshot config', async () => {
  const raw = rawProvider({ id: 'raw', protocol: ProviderProtocol.OpenAIResponse });
  const route = defineProviderRouteSource([raw]);
  const source = withSnapshotConfigs(route.source, apiConfig(17), apiConfig(99));

  const response = await request(source, { model: REQUESTED_MODEL, input: 'ping' });
  await response.json();
  await settleRecording(route.recording);

  expect(route.recording.attempts[0]).toEqual(
    expect.objectContaining({
      providerId: 'raw',
      providerWeight: 17,
      selectionReason: 'weight',
      sourceProtocol: ProviderProtocol.OpenAIResponse,
      targetProtocol: ProviderProtocol.OpenAIResponse,
      transport: 'raw',
    }),
  );
});

test('records active affinity metadata for a model attempt including implicit zero weight', async () => {
  const weighted = modelProvider({
    id: 'weighted',
    targetProtocol: ProviderProtocol.OpenAIResponse,
    invoke: () => textStream('weighted'),
  });
  const affinity = modelProvider({
    id: 'affinity',
    targetProtocol: ProviderProtocol.Anthropic,
    invoke: () => textStream('affinity'),
  });
  const route = defineProviderRouteSource([weighted, affinity]);
  const source = {
    ...withSnapshotConfigs(route.source, modelConfig('affinity')),
    logicalSessionStore: new LogicalSessionStore({
      repository: {
        resolveResponse: () => undefined,
        findAffinity: () => ({ providerId: 'affinity', revision: 1, active: true }),
      },
    }),
  };

  const response = await request(source, { model: REQUESTED_MODEL, input: 'ping', prompt_cache_key: 'session-1' });
  await response.json();
  await settleRecording(route.recording);

  expect(route.recording.attempts[0]).toEqual(
    expect.objectContaining({
      providerId: 'affinity',
      providerWeight: 0,
      selectionReason: 'affinity',
      sourceProtocol: ProviderProtocol.OpenAIResponse,
      targetProtocol: ProviderProtocol.Anthropic,
      transport: 'ai_sdk',
    }),
  );
});

test('records response owner when response ownership and affinity select the same Provider', async () => {
  const weighted = modelProvider({ id: 'weighted', invoke: () => textStream('weighted') });
  const owner = modelProvider({
    id: 'owner',
    targetProtocol: ProviderProtocol.Anthropic,
    invoke: () => textStream('owner'),
  });
  const route = defineProviderRouteSource([weighted, owner]);
  const source = {
    ...withSnapshotConfigs(route.source, modelConfig('owner')),
    logicalSessionStore: new LogicalSessionStore({
      repository: {
        resolveResponse: () => ({
          status: 'owned',
          owner: { identity: { source: 'body-session', id: 'session-1' }, providerId: 'owner' },
        }),
        findAffinity: () => ({ providerId: 'owner', revision: 1, active: true }),
      },
    }),
  };

  const response = await request(source, {
    model: REQUESTED_MODEL,
    input: 'ping',
    previous_response_id: 'resp-1',
  });
  await response.json();
  await settleRecording(route.recording);

  expect(route.recording.attempts[0]).toEqual(
    expect.objectContaining({ providerId: 'owner', selectionReason: 'response_owner' }),
  );
});

function request(source: ProviderRouteSource, body: Record<string, unknown>): Promise<Response> {
  return handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    source,
  });
}

function apiConfig(weight: number): Config {
  return ConfigSchema.parse({
    providers: {
      raw: {
        kind: 'api',
        protocol: ProviderProtocol.OpenAIResponse,
        baseURL: 'https://raw.example.test/v1',
        weight,
      },
    },
  });
}

function modelConfig(selected: 'affinity' | 'owner'): Config {
  return ConfigSchema.parse({
    providers: {
      weighted: { kind: 'ai-sdk', packageName: '@ai-sdk/openai-compatible', weight: 20 },
      [selected]: {
        kind: 'ai-sdk',
        packageName: '@ai-sdk/anthropic',
        ...(selected === 'owner' ? { weight: 10 } : {}),
      },
    },
  });
}
