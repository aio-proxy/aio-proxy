import { expect, test } from 'bun:test';

import { geminiInteractionsAdapter } from '@aio-proxy/core';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';
import { ProviderProtocol } from '@aio-proxy/types';

import { handleProtocolRequest } from '.';
import {
  defineProviderRouteSource,
  jsonRequest,
  rawProvider,
  REQUESTED_MODEL,
  settleRecording,
} from '../../../__tests__/pipeline-helpers';
import { createUsageCapture } from '../../usage-capture';

test('reuses a completed native Gemini Interaction through the full raw pipeline', async () => {
  const contexts: LogicalRequestContext[] = [];
  let responseIndex = 0;
  const provider = rawProvider({
    id: 'gemini-interactions',
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.GeminiInteractions,
    invoke: async (_request, context) => {
      contexts.push(context);
      responseIndex += 1;
      return Response.json({ id: `intr_${responseIndex}`, status: 'completed' });
    },
  });
  const route = defineProviderRouteSource([provider]);
  const source = { ...route.source, usageCapture: createUsageCapture() };

  const first = await handleProtocolRequest({
    adapter: geminiInteractionsAdapter,
    context: {},
    rawRequest: jsonRequest({ model: REQUESTED_MODEL, input: 'first' }),
    source,
  });
  expect(await first.json()).toEqual({ id: 'intr_1', status: 'completed' });
  await settleRecording(route.recording);

  const second = await handleProtocolRequest({
    adapter: geminiInteractionsAdapter,
    context: {},
    rawRequest: jsonRequest({
      model: REQUESTED_MODEL,
      input: 'second',
      previous_interaction_id: 'intr_1',
    }),
    source,
  });
  expect(await second.json()).toEqual({ id: 'intr_2', status: 'completed' });
  await settleRecording(route.recording);

  expect(contexts).toHaveLength(2);
  expect(contexts[0]?.session.source).toBe('generated');
  expect(contexts[1]?.session).toEqual(contexts[0]?.session);
  expect(route.recording.finals.map((final) => final.responseId)).toEqual(['intr_1', 'intr_2']);
});
