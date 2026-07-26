import { describe, expect, test } from 'bun:test';

import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import {
  defineProtocolAdapter,
  errorStream,
  type FakeProvider,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
  textStream,
  textThenErrorStream,
} from '../../../__tests__/pipeline-helpers';
import { attemptsOf, pipeline } from './oauth.test-support';

describe('OAuth plugin raw pipeline Antigravity fallback', () => {
  test('fallback between Antigravity accounts reuses one logical request context', async () => {
    const seen: LogicalRequestContext[] = [];
    const primary = antigravityAccount(
      rawProvider({
        id: 'primary',
        protocol: ProviderProtocol.Gemini,
        invoke: async (_request, context) => {
          seen.push(context as LogicalRequestContext);
          return Response.json({ error: 'retry' }, { status: 503 });
        },
      }),
    );
    const backup = antigravityAccount(
      modelProvider({
        id: 'backup',
        invoke(request) {
          seen.push(request.context);
          expect(request.settings?.providerOptions?.aioProxy).toBeUndefined();
          return textStream('ok');
        },
      }),
    );

    const response = await pipeline([primary, backup], {
      adapter: defineProtocolAdapter(ProviderProtocol.Gemini),
    }).run(jsonRequest({ model: REQUESTED_MODEL }));

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(seen[0]?.session.key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(seen[0]?.session.key).toBe(seen[1]?.session.key);
  });

  test('falls back between Antigravity accounts when stream preflight fails before commit', async () => {
    const primary = antigravityAccount(
      modelProvider({ id: 'primary', invoke: () => errorStream(new Error('preflight failed')) }),
    );
    const backup = antigravityAccount(modelProvider({ id: 'backup', invoke: () => textStream('fallback') }));
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
    expect(await response.text()).toContain('fallback');
    expect(primary.calls.model).toHaveLength(1);
    expect(backup.calls.model).toHaveLength(1);
  });

  test('does not replay an Antigravity stream after its first event commits the response', async () => {
    const primary = antigravityAccount(
      modelProvider({
        id: 'primary',
        invoke: () => textThenErrorStream('partial', new Error('after commit')),
      }),
    );
    const backup = antigravityAccount(modelProvider({ id: 'backup', invoke: () => textStream('wrong') }));
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
    await expect(response.text()).rejects.toThrow('after commit');
    expect(primary.calls.model).toHaveLength(1);
    expect(backup.calls.model).toHaveLength(0);
  });

  test('preserves the final Antigravity account failure', async () => {
    const primary = antigravityAccount(
      rawProvider({
        id: 'primary',
        protocol: ProviderProtocol.Gemini,
        invoke: async () => Response.json({ account: 'primary' }, { status: 503 }),
      }),
    );
    const final = antigravityAccount(
      rawProvider({
        id: 'final',
        protocol: ProviderProtocol.Gemini,
        invoke: async () => Response.json({ account: 'final' }, { status: 429 }),
      }),
    );
    const harness = pipeline([primary, final], { adapter: defineProtocolAdapter(ProviderProtocol.Gemini) });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ account: 'final' });
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: 'failure', providerId: 'primary', statusCode: 503 },
      { outcome: 'failure', providerId: 'final', statusCode: 429 },
    ]);
  });
});

function antigravityAccount(fixture: FakeProvider): FakeProvider {
  return {
    ...fixture,
    provider: {
      ...fixture.provider,
      capability: 'default',
      kind: ProviderKind.OAuth,
      plugin: '@aio-proxy/plugin-google-antigravity',
    },
  };
}
