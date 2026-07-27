import { expect, test } from 'bun:test';

import { openAIResponsesAdapter } from '@aio-proxy/core';

import {
  defineProviderRouteSource,
  modelProvider,
  REQUESTED_MODEL,
  textStream,
} from '../../../__tests__/pipeline-helpers';
import { LogicalSessionStore } from '../../logical-session-store';
import { handleProtocolRequest } from './index';

test('prioritizes the response-producing Provider ahead of ordinary session affinity', async () => {
  const weighted = modelProvider({ id: 'weighted', invoke: () => textStream('weighted') });
  const affinity = modelProvider({ id: 'affinity', invoke: () => textStream('affinity') });
  const owner = modelProvider({ id: 'owner', invoke: () => textStream('owner') });
  const route = defineProviderRouteSource([weighted, affinity, owner]);
  const source = {
    ...route.source,
    logicalSessionStore: new LogicalSessionStore({
      repository: {
        resolveResponse: () => ({
          status: 'owned',
          owner: { identity: { source: 'body-session', id: 'session-1' }, providerId: 'owner' },
        }),
        findAffinity: () => ({ providerId: 'affinity', revision: 1, active: true }),
      },
    }),
  };

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: REQUESTED_MODEL, input: 'next', previous_response_id: 'resp-1' }),
    }),
    source,
  });

  expect(await response.json()).toMatchObject({ output_text: 'owner' });
  expect(owner.calls.model).toHaveLength(1);
  expect(affinity.calls.model).toHaveLength(0);
  expect(weighted.calls.model).toHaveLength(0);
});

test('rejects an ambiguous persisted response id before provider invocation', async () => {
  const provider = modelProvider({ id: 'provider-a', invoke: () => textStream('unsafe') });
  const route = defineProviderRouteSource([provider]);
  const response = await request({
    ...route.source,
    logicalSessionStore: new LogicalSessionStore({
      repository: {
        resolveResponse: () => ({ status: 'ambiguous' }),
        findAffinity: () => undefined,
      },
    }),
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'previous_response_conflict' } });
  expect(provider.calls.model).toHaveLength(0);
});

test('rejects an ambiguous in-memory response id before provider invocation', async () => {
  const provider = modelProvider({ id: 'provider-a', invoke: () => textStream('unsafe') });
  const route = defineProviderRouteSource([provider]);
  const logicalSessionStore = new LogicalSessionStore();
  logicalSessionStore.commitResponse(
    'resp-1',
    'sha256:session-a',
    { source: 'body-session', id: 'session-a' },
    'provider-a',
  );
  logicalSessionStore.commitResponse(
    'resp-1',
    'sha256:session-b',
    { source: 'body-session', id: 'session-b' },
    'provider-b',
  );

  const response = await request({ ...route.source, logicalSessionStore });

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'previous_response_conflict' } });
  expect(provider.calls.model).toHaveLength(0);
});

function request(source: Parameters<typeof handleProtocolRequest>[0]['source']): Promise<Response> {
  return handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: REQUESTED_MODEL, input: 'next', previous_response_id: 'resp-1' }),
    }),
    source,
  });
}
