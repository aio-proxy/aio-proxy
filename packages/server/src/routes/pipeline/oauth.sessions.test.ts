import { describe, expect, test } from 'bun:test';

import { openAIResponsesAdapter } from '@aio-proxy/core';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';
import { ProviderProtocol } from '@aio-proxy/types';

import {
  defineProviderRouteSource,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
  settleRecording,
  textStream,
} from '../../../__tests__/pipeline-helpers';
import { PluginRawResolverError, PluginRawTransportError } from '../../plugin-runtime';
import { handleProtocolRequest } from './index';
import { attemptsOf, pipeline } from './oauth.test-support';

describe('OAuth plugin raw pipeline sessions and capabilities', () => {
  test('completed OpenAI Responses commits its response ID to the logical session', async () => {
    let logicalRequest: LogicalRequestContext | undefined;
    const provider = modelProvider({
      id: 'responses',
      invoke(request) {
        logicalRequest = request.context;
        return textStream('ok');
      },
    });
    const route = defineProviderRouteSource([provider]);

    const response = await handleProtocolRequest({
      adapter: openAIResponsesAdapter,
      context: {},
      rawRequest: jsonRequest({ input: 'ping', metadata: { session_id: 'review-session' }, model: REQUESTED_MODEL }),
      source: route.source,
    });
    const body = (await response.json()) as { readonly id: string };
    const resumed = route.source.logicalSessionStore.begin({
      headers: new Headers(),
      hints: { candidates: [], previousResponseId: body.id, transcript: 'different request' },
    });

    expect(response.status).toBe(200);
    expect(body.id).toMatch(/^resp_/u);
    expect(logicalRequest?.session.key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(resumed.session.source).toBe('previous-response');
    expect(resumed.session.key).toBe(logicalRequest?.session.key);
  });

  test.each(['resolver', 'response'] as const)('falls back after a malformed plugin raw %s failure', async (stage) => {
    const base = rawProvider({
      id: 'primary',
      invoke: async () => {
        throw new PluginRawTransportError();
      },
    });
    const primary =
      stage === 'resolver'
        ? {
            ...base,
            provider: {
              ...base.provider,
              raw: {
                resolve() {
                  throw new PluginRawResolverError();
                },
              },
            },
          }
        : base;
    const backup = rawProvider({ id: 'backup' });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ provider: 'backup' });
    expect(backup.calls.raw).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: 'failure', providerId: 'primary', statusCode: 502 },
      { outcome: 'success', providerId: 'backup', statusCode: 200 },
    ]);
  });

  test('skips a higher-weight model candidate without the requested provider tool capability', async () => {
    const primary = modelProvider({ id: 'primary', invoke: () => textStream('wrong') });
    const backup = modelProvider({ id: 'antigravity', invoke: () => textStream('searched') });
    Object.assign(backup.provider.model, {
      supportsProviderTool: (type: string) => type === 'web-search',
    });
    const baseAdapter = pipeline([]).adapter;
    const adapter = {
      ...baseAdapter,
      protocol: ProviderProtocol.Anthropic,
      modelInvocation(
        request: Parameters<typeof baseAdapter.modelInvocation>[0],
        context: Parameters<typeof baseAdapter.modelInvocation>[1],
      ) {
        return {
          ...baseAdapter.modelInvocation(request, context),
          providerTools: [{ type: 'web-search', name: 'web_search' }],
        };
      },
    } as typeof baseAdapter;
    const harness = pipeline([primary, backup], { adapter });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));

    expect(await response.json()).toEqual({ output: 'searched' });
    expect(primary.calls.model).toHaveLength(0);
    expect(backup.calls.model).toHaveLength(1);
    expect(backup.calls.model[0]?.providerTools).toEqual([{ type: 'web-search', name: 'web_search' }]);
  });
});
